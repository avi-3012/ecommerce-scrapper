#!/bin/bash
# EC2 user-data for PricePulse (Ubuntu 24.04 LTS).
#
# Paste into "Advanced details → User data" when launching the instance. It
# installs Docker, adds swap, and clones the repo. It deliberately does NOT
# start the stack: deploy/.env.aws holds secrets and must be created by hand
# on the box first.
#
# Progress:  sudo tail -f /var/log/cloud-init-output.log
set -euxo pipefail

apt-get update
apt-get install -y ca-certificates curl git

# Docker Engine + compose plugin from Docker's own repo (Ubuntu's is older).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

usermod -aG docker ubuntu
systemctl enable --now docker

# The image build runs vite + tsc, which will OOM on a 2 GB instance without
# swap. Cheap insurance; harmless on a larger box.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Unattended security updates — this box has port 443 open to the world.
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

sudo -u ubuntu git clone https://github.com/avi-3012/ecommerce-scrapper.git /home/ubuntu/pricepulse

echo "user-data finished. Next: create /home/ubuntu/pricepulse/deploy/.env.aws, then bring the stack up."
