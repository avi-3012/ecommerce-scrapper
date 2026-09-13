# Running PricePulse behind several source IPs

## Why

The block decision is made per IP address, not per identity. On 6 Sep 2026,
twelve *distinct* identities — different user agents, different operating
systems, separate cookie jars — were refused within 69 seconds, and 47 of 48
identities were blocked over that day. No amount of persona variety changes an
outcome that is decided on the address.

What each address will carry has been measured on this connection:

| Rate from one AWS address | Result |
|---|---|
| 2.75 req/min | 0.57% block rate, 98.7% success |
| 4.4 req/min | 97.7% success, 3 isolated blocks in 6h |
| 12 req/min | 28 blocks in one hour |

So the per-address budget is roughly **3 req/min**. Fifty products at a
five-minute interval needs `50 ÷ 5 × 1.1 ≈ 11 req/min`, which is **four to five
addresses**.

## What the code does

- `egress` in the scraping config lists source IPs. Empty means the host's
  default route, which is the single-address behaviour and the default.
- Each identity is pinned to one address **for life** at creation, balanced
  across the list. A persona that appears on two addresses is a signal no real
  browser produces.
- Each address gets its **own** `IpGovernor`: its own request budget, block
  history, adaptive controller and backoff. One address backing off leaves the
  others working — with five addresses, an incident costs a fifth of capacity
  rather than all of it.
- The cycle planner budgets against the **sum** of the addresses, and only skips
  a cycle when *every* address is stopped.
- Governor state is one file per address under the identity directory
  (`governor-<address>.json`), so the controllers cannot overwrite each other.

**The browser tier is the exception.** Chromium cannot bind a source address the
way a socket can, so tier-2 escalations still leave from the default route. They
are rare (only `parse_failed` escalates) but they are not spread across the
addresses.

## Step by step, on the EC2 instance

Nothing here needs a new instance. You are adding addresses to the one you have.

### 1. Allocate the Elastic IPs

Five addresses, in the same region as the instance:

The AWS CLI is not installed on the instance by default, and installing it
there would mean putting credentials on the scraper host. For a one-time setup
the **Console** is simpler and leaves no credentials behind — steps 1 to 3 are
all point-and-click. Use the CLI only if you already run it somewhere with
credentials (your laptop), or attach an IAM role to the instance first.

**Console:** EC2 → *Elastic IPs* → **Allocate Elastic IP address** → Allocate.
Repeat five times, tagging each `Name=pricepulse-egress` so they are
identifiable later.

**CLI**, from a machine that already has credentials:

```bash
for i in 1 2 3 4 5; do
  aws ec2 allocate-address --domain vpc \
    --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=pricepulse-egress}]'
done
```

The default EIP quota per region is 5 — request an increase first if you need
more. **AWS charges for every public IPv4 address**, roughly $3.60/month each,
whether attached or not.

### 2. Give the instance secondary private IPs

Each Elastic IP has to associate with a private IP on the instance's network
interface. Find the interface, then add four more private addresses (you already
have one):

**Console:** EC2 → *Instances* → your instance → *Networking* tab → click the
network interface → **Actions → Manage IP addresses** → expand the interface →
**Assign new IP address** ×4 → Save.

**CLI:**

```bash
ENI=$(aws ec2 describe-instances --instance-ids <instance-id> \
  --query 'Reservations[0].Instances[0].NetworkInterfaces[0].NetworkInterfaceId' --output text)

aws ec2 assign-private-ip-addresses --network-interface-id "$ENI" --secondary-private-ip-address-count 4
```

Instance-type limits apply, and **the primary address counts against them**.
Check yours before allocating anything — this is the one step that cannot be
worked around later without a stop/start:

| Instance type | IPv4 per interface | Egress addresses beside the primary |
|---|---|---|
| `t3.medium` | 6  | 5  |
| `t3.large`  | 12 | 11 |
| `t3.xlarge` | 15 | 14 |

```bash
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-type
```

To go past your type's limit, **resize rather than attach a second interface**.
A second ENI in the same subnet needs source-based policy routing on the host,
or replies leave through the primary interface and connections from the second
one fail asymmetrically — silently, and only under load. A resize is a stop,
a type change and a start: the secondary private IPs and their Elastic IP
associations live on the interface and survive it, and so does the netplan
file. Budget two to three minutes of downtime.

**Scale the identity pool with the addresses, in the same change.** When you
list new addresses in `egress`, raise `identities.count` by the pool's current
density for each one added — at 12 per address, adding 3 addresses means
+36. New identities are created on the least-loaded address, so they fill the
new ones first, and while the pool is below its target the rebalancer retires
nobody. Matching the existing density exactly means no aged persona is retired
at all. Do **not** raise the count first and list the addresses later: the new
identities would land on the existing addresses, and listing new ones afterward
would force the rebalancer to retire them again.
Adding addresses to a fixed pool instead forces the rebalancer to retire
established identities to make room — on 13 Sep 2026 moving from two addresses
to four retired 23 of them, and the fresh replacements drew a wave of blocks
while they warmed up.

**Stage the addresses.** Do all the AWS and host work at once — an address the
host holds but `egress` does not list is simply unused — but add them to
`egress` a few at a time, a day apart. Fresh addresses and fresh identities both
take hours to settle, and several arriving together is indistinguishable from
the far end pushing back.

### 3. Associate each Elastic IP with one private IP

**Console:** EC2 → *Elastic IPs* → select one → **Actions → Associate Elastic
IP address** → Resource type *Network interface* → pick the interface → choose a
**private IP** → Associate. Repeat for each, pairing one EIP to one private IP.

**CLI:**

```bash
aws ec2 associate-address --allocation-id <eipalloc-…> \
  --network-interface-id "$ENI" --private-ip-address <private-ip>
```

Repeat for each pair.

### 4. Make the OS aware of the secondary addresses

Amazon Linux and Ubuntu do not configure secondary private IPs automatically.
Confirm what the host actually holds:

```bash
ip addr show
```

Ubuntu's cloud images do **not** pick up secondary private IPs — cloud-init
configures only the primary from DHCP, so EC2 knows about the other four and the
kernel does not. Find your interface name and prefix length first; they vary by
instance type and are not always `ens5`:

```bash
ip -4 addr show          # e.g. "inet 172.31.0.210/20 ... enp39s0"
```

Add the rest immediately, so you can test now:

```bash
sudo ip addr add 172.31.0.211/20 dev enp39s0
sudo ip addr add 172.31.0.212/20 dev enp39s0   # …and so on
```

Then make it survive a reboot. On Ubuntu 24.04 that means netplan — create
`/etc/netplan/60-egress.yaml` (a separate file, so cloud-init's own
`50-cloud-init.yaml` is left alone and regenerating it cannot wipe this):

```yaml
network:
  version: 2
  ethernets:
    enp39s0:
      addresses:
        - 172.31.0.211/20
        - 172.31.0.212/20
        - 172.31.0.213/20
        - 172.31.0.214/20
```

```bash
sudo chmod 600 /etc/netplan/60-egress.yaml   # netplan warns loudly otherwise
sudo netplan apply
```

**This step is the one people skip.** `localAddress` binds to an address the
host owns; if the OS does not have it, every request from that egress fails at
connect time with an error that says nothing about the cause.

### 5. Verify each address egresses as the Elastic IP you expect

```bash
for ip in <private-ip-1> <private-ip-2> …; do
  echo -n "$ip -> "; curl -s --interface "$ip" https://checkip.amazonaws.com
done
```

Each line must print the matching Elastic IP. If two print the same public
address, the association is wrong and the whole exercise is pointless — fix it
before going further.

### 6. Configure PricePulse

Put the **private** addresses in the config — those are what the host holds and
what `localAddress` binds to. The Elastic IP is what Amazon sees.

These addresses exist only on this machine, so keep them out of the tracked
config or every `git pull` will conflict with the running deployment:

```bash
cp config/scraping.aws.json config/scraping.local.json     # gitignored
```

Edit `config/scraping.local.json`:

```json
"egress": ["172.31.0.211", "172.31.0.212", "172.31.0.213", "172.31.0.214"]
```

and point the worker at it in `deploy/.env.aws`:

```
SCRAPING_CONFIG=/repo/config/scraping.local.json
```

Leave the instance's PRIMARY private address out of the list. It carries the
inbound dashboard traffic and whatever block history the connection has already
accumulated, and keeping it separate means a burnt egress address can be
replaced without changing the address you reach the app on.

The worker mounts `config/` read-only, so this needs only a restart:

```bash
docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml restart worker
```

### 6b. Put the worker on the host network

This step is **required**, not optional. On Docker's default bridge network the
worker's container holds only its own address (`172.17.x.x`); binding to
`172.31.x.x` fails because the container does not have it. The worker has to
share the host's network namespace to bind the host's addresses.

That is what `deploy/docker-compose.egress.yml` does. Layer it on with a second
`-f` — there is nothing to edit:

```bash
docker compose --env-file deploy/.env.aws \
  -f deploy/docker-compose.aws.yml \
  -f deploy/docker-compose.egress.yml up -d --build
```

It sets `network_mode: host` and, because host networking removes the compose
network and with it the `db` hostname, points the worker at Postgres over
loopback:

```yaml
services:
  worker:
    network_mode: host
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}
```

Those are the same three variables the `db` service already interpolates from
`--env-file`, so there is no second copy of the password to keep in step and no
secret in a tracked file. `environment` takes precedence over `env_file`, so
only `DATABASE_URL` is overridden.

Drop the second `-f` to go back to a single address.

Host networking also means the worker no longer needs `depends_on` health
gating through the compose network; leave the `depends_on` entries as they are,
they still order startup correctly.

### 7. Confirm it took

The startup banner reports the addresses and the total budget. Then watch:

```bash
docker compose … exec worker node apps/worker/dist/cli.js status
ls /repo/data/identities/governor-*.json
```

There should be one governor file per address, and identities spread evenly
across them.

## Prove the premise before paying for five

**Five AWS addresses are all in AWS address space.** Amazon publishes its own
ranges and may well count per subnet or per ASN rather than per address — in
which case five Elastic IPs share one budget and buy nothing.

Test it with **two** addresses first, for about $7:

1. Set `egress` to two addresses and raise the interval so each carries roughly
   the 3/min the single address handled.
2. Run 24 hours.
3. Compare per-address block counts against the single-address baseline.

- **Block rate per address roughly halves** → Amazon counts per address. Scale
  to five and take the five-minute interval.
- **Block rate per address is unchanged** → Amazon aggregates. AWS addresses
  will not scale this, and the answer is static residential ISP proxies from
  different ASNs. The per-egress code above is unchanged either way; only where
  the addresses come from differs.

## Sizing

```
req/min ≈ 1.1 × products ÷ interval_minutes
addresses needed ≈ req/min ÷ 3
```

Fifty products at five minutes → 11 req/min → 4 addresses, 5 with margin.
