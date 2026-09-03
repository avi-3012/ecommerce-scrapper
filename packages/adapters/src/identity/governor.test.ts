import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCRAPING_CONFIG } from './config.js';
import {
  BACKOFF_LADDER_MIN,
  DEGRADE_MS,
  IpGovernor,
  diurnalFactor,
  isNightIst,
  istMinutes,
} from './governor.js';
import { IdentityStore } from './store.js';
import type { ScrapingConfig } from './types.js';

/** Instants pinned by their IST wall-clock, which is what the caps switch on. */
const NOON_IST = Date.UTC(2026, 7, 21, 6, 30, 0); // 12:00 IST
const THREE_AM_IST = Date.UTC(2026, 7, 20, 21, 30, 0); // 03:00 IST next day

function rig(overrides: Partial<ScrapingConfig> = {}): { governor: IpGovernor; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pricepulse-governor-'));
  const config: ScrapingConfig = { ...DEFAULT_SCRAPING_CONFIG, ...overrides };
  return { governor: new IpGovernor(config, new IdentityStore(dir)), dir };
}

/** The defaults with a different IP budget, for one test at a time. */
function withCap(overrides: Partial<ScrapingConfig['ipCap']>): Partial<ScrapingConfig> {
  return { ipCap: { ...DEFAULT_SCRAPING_CONFIG.ipCap, ...overrides } };
}

afterEach(() => {
  delete process.env.PAUSE;
});

describe('IST day/night', () => {
  it('reads the wall clock in Asia/Kolkata, not the host timezone', () => {
    expect(istMinutes(NOON_IST)).toBe(12 * 60);
    expect(istMinutes(THREE_AM_IST)).toBe(3 * 60);
  });

  it('places 00:00–07:00 IST in the night window', () => {
    const night = { startIST: '00:00', endIST: '07:00' };
    expect(isNightIst(THREE_AM_IST, night)).toBe(true);
    expect(isNightIst(NOON_IST, night)).toBe(false);
  });

  it('handles a night window that crosses midnight', () => {
    const night = { startIST: '22:00', endIST: '06:00' };
    expect(isNightIst(Date.UTC(2026, 7, 21, 17, 0, 0), night)).toBe(true); // 22:30 IST
    expect(isNightIst(THREE_AM_IST, night)).toBe(true);
    expect(isNightIst(NOON_IST, night)).toBe(false);
  });
});

describe('IP caps', () => {
  it('applies the day cap by day and the night cap by night', () => {
    const { governor } = rig();
    expect(governor.capPerMin(NOON_IST)).toBe(6);
    expect(governor.capPerMin(THREE_AM_IST)).toBe(2);
  });

  it('is a hard limit: the Nth+1 request in any 60 s window is refused', () => {
    const { governor } = rig(withCap({ dayPerMin: 3, nightPerMin: 1 }));
    for (let i = 0; i < 3; i++) {
      expect(governor.canRequest(NOON_IST + i * 1_000).allowed).toBe(true);
      governor.recordRequest(NOON_IST + i * 1_000);
    }
    const refused = governor.canRequest(NOON_IST + 3_000);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('cap');
    // It tells the caller exactly how long to wait, so the scheduler stretches
    // rather than spinning.
    expect(refused.retryAfterMs).toBeGreaterThan(56_000);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
    // Once the window rolls past the first request, one slot opens.
    expect(governor.canRequest(NOON_IST + 60_001).allowed).toBe(true);
  });
});

describe('kill switch', () => {
  it('stops everything on PAUSE=1', () => {
    const { governor } = rig();
    process.env.PAUSE = '1';
    const decision = governor.canRequest(NOON_IST);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('kill_switch');
    // Re-checked every call, so releasing it takes effect immediately.
    delete process.env.PAUSE;
    expect(governor.canRequest(NOON_IST).allowed).toBe(true);
  });

  it('stops everything on a PAUSE file in the store directory', () => {
    const { governor, dir } = rig();
    writeFileSync(join(dir, 'PAUSE'), '');
    expect(governor.canRequest(NOON_IST).reason).toBe('kill_switch');
    rmSync(join(dir, 'PAUSE'));
    expect(governor.canRequest(NOON_IST).allowed).toBe(true);
  });
});

describe('adaptive rate control', () => {
  const adaptive = (over: Record<string, unknown> = {}): Partial<ScrapingConfig> =>
    withCap({
      mode: 'adaptive',
      dayPerMin: 30,
      nightPerMin: 10,
      adaptive: {
        startPerMin: 30,
        maxPerMin: 120,
        minPerMin: 4,
        increaseEverySec: 60,
        decreaseFactor: 0.5,
        // These tests drive the rate deliberately, so every block should count.
        // The ratio threshold has its own tests below.
        tolerateBlockRatio: 0,
        ...over,
      },
    });

  it('starts at the configured starting rate', () => {
    const { governor } = rig(adaptive());
    expect(governor.learnedPerMin(NOON_IST)).toBe(30);
  });

  it('climbs while responses stay clean', () => {
    const { governor } = rig(adaptive());
    expect(governor.learnedPerMin(NOON_IST)).toBe(30);
    // Five clean minutes at one per-minute step each. The climb has to be
    // earned by traffic that actually went out, so the interval carries a
    // request.
    governor.recordRequest(NOON_IST + 60_000);
    expect(governor.learnedPerMin(NOON_IST + 5 * 60_000)).toBe(35);
  });

  it('never climbs past maxPerMin', () => {
    const { governor } = rig(adaptive({ maxPerMin: 33 }));
    governor.learnedPerMin(NOON_IST); // starts the clock
    governor.recordRequest(NOON_IST + 1_000);
    expect(governor.learnedPerMin(NOON_IST + 24 * 3600_000)).toBe(33);
  });

  // The 3 Sep 2026 incident: the controller recovered 8 → 16/min DURING a
  // three-hour pause, learning nothing, and would have resumed at full rate
  // into the wall that caused the pause.
  it('does NOT climb while the global backoff is running', () => {
    const { governor } = rig(adaptive({ minPerMin: 4 }));
    let now = NOON_IST;
    for (let i = 0; i < 8; i++) governor.recordHardBlock((now += 1_000));
    const floored = governor.learnedPerMin(now);
    expect(governor.canRequest(now).reason).toBe('backoff');
    // An hour of a three-hour pause goes by. Nothing was sent, so nothing was
    // learned, and the rate must be exactly where the incident left it.
    expect(governor.learnedPerMin(now + 3600_000)).toBe(floored);
  });

  it('does NOT climb through an idle stretch, and does not bank it as credit', () => {
    const { governor } = rig(adaptive());
    expect(governor.learnedPerMin(NOON_IST)).toBe(30);
    // An hour with no requests at all — a paused catalogue, an empty queue.
    expect(governor.learnedPerMin(NOON_IST + 3600_000)).toBe(30);
    // Traffic resumes: the climb restarts from here rather than cashing in the
    // idle hour as sixty clean intervals.
    governor.recordRequest(NOON_IST + 3600_000 + 1_000);
    expect(governor.learnedPerMin(NOON_IST + 3600_000 + 120_000)).toBe(32);
  });

  it('halves on a hard block, immediately — not at a threshold', () => {
    const { governor } = rig(adaptive());
    expect(governor.learnedPerMin(NOON_IST)).toBe(30);
    // ONE block is enough. Waiting for a second would mean spending the interval
    // between them at a rate we already know is too high.
    governor.recordHardBlock(NOON_IST + 1_000);
    expect(governor.learnedPerMin(NOON_IST + 2_000)).toBe(15);
    governor.recordHardBlock(NOON_IST + 3_000);
    expect(governor.learnedPerMin(NOON_IST + 4_000)).toBe(7.5);
  });

  it('never falls below minPerMin', () => {
    const { governor } = rig(adaptive({ minPerMin: 5 }));
    let now = NOON_IST;
    for (let i = 0; i < 12; i++) governor.recordHardBlock((now += 1_000));
    expect(governor.learnedPerMin(now + 1_000)).toBe(5);
  });

  it('does NOT pause globally while cutting the rate is still working', () => {
    const { governor } = rig(adaptive());
    // Two blocks in 15 minutes would pause a fixed-mode governor outright. Here
    // the rate cut IS the response, and throwing away throughput on top of it
    // would waste what the controller just paid for.
    governor.recordHardBlock(NOON_IST);
    governor.recordHardBlock(NOON_IST + 60_000);
    const decision = governor.canRequest(NOON_IST + 61_000);
    expect(decision.allowed).toBe(true);
    expect(governor.learnedPerMin(NOON_IST + 61_000)).toBe(7.5);
  });

  it('DOES pause once it is at the floor and still being blocked', () => {
    const { governor } = rig(adaptive({ minPerMin: 4 }));
    let now = NOON_IST;
    // Drive the rate down to the floor…
    for (let i = 0; i < 8; i++) governor.recordHardBlock((now += 1_000));
    expect(governor.learnedPerMin(now)).toBe(4);
    // …at which point slowing down has stopped working, and stopping is all
    // that is left.
    governor.recordHardBlock((now += 1_000));
    governor.recordHardBlock((now += 1_000));
    expect(governor.canRequest(now + 1_000).reason).toBe('backoff');
  });

  it('ignores a lone block among many good responses', () => {
    const { governor } = rig(adaptive({ tolerateBlockRatio: 0.02 }));
    expect(governor.learnedPerMin(NOON_IST)).toBe(30);
    // 300 clean requests, then one refusal. That is 0.3% — background noise,
    // not congestion, and cutting 40% of the rate for it is how an adaptive
    // controller ratchets itself down to nothing.
    for (let i = 0; i < 300; i++) governor.recordRequest(NOON_IST + i * 10);
    governor.recordHardBlock(NOON_IST + 3_100);
    expect(governor.learnedPerMin(NOON_IST + 3_200)).toBe(30);
  });

  it('cuts once blocks become a proportion of the traffic', () => {
    const { governor } = rig(adaptive({ tolerateBlockRatio: 0.02 }));
    expect(governor.learnedPerMin(NOON_IST)).toBe(30);
    for (let i = 0; i < 100; i++) governor.recordRequest(NOON_IST + i * 10);
    // Five blocks in a hundred requests is 5% — well past tolerance.
    for (let i = 0; i < 5; i++) governor.recordHardBlock(NOON_IST + 1_100 + i * 10);
    expect(governor.learnedPerMin(NOON_IST + 1_200)).toBeLessThan(30);
  });

  it('treats blocks with no successful traffic behind them as congestion', () => {
    const { governor } = rig(adaptive({ tolerateBlockRatio: 0.02 }));
    expect(governor.learnedPerMin(NOON_IST)).toBe(30);
    // Nothing has succeeded, so there is no denominator to be small against.
    governor.recordHardBlock(NOON_IST + 1_000);
    expect(governor.learnedPerMin(NOON_IST + 2_000)).toBe(15);
  });

  it('remembers the learned rate across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricepulse-governor-'));
    const config = { ...DEFAULT_SCRAPING_CONFIG, ...adaptive() } as ScrapingConfig;
    const first = new IpGovernor(config, new IdentityStore(dir));
    first.recordHardBlock(NOON_IST);
    expect(first.learnedPerMin(NOON_IST + 1_000)).toBe(15);

    // What the connection tolerates is learned over hours; a restart must not
    // throw that away and go back to probing from the top.
    const second = new IpGovernor(config, new IdentityStore(dir));
    expect(second.learnedPerMin(NOON_IST + 1_000)).toBe(15);
  });

  it('scales the SPENDABLE rate down at night, leaving the learned ceiling alone', () => {
    const { governor } = rig(adaptive());
    governor.learnedPerMin(NOON_IST);
    // What the connection tolerates does not change with the clock; how much of
    // it we choose to spend at 3 a.m. does.
    expect(governor.capPerMin(THREE_AM_IST)).toBeLessThan(governor.capPerMin(NOON_IST));
  });

  it('enforces the learned rate as a real limit', () => {
    // minPerMin below the start rate, or the floor would be the thing under test.
    const { governor } = rig(adaptive({ startPerMin: 3, minPerMin: 1, increaseEverySec: 100_000 }));
    for (let i = 0; i < 3; i++) governor.recordRequest(NOON_IST + i);
    expect(governor.canRequest(NOON_IST + 4).allowed).toBe(false);
    expect(governor.canRequest(NOON_IST + 4).reason).toBe('cap');
  });
});

describe('congestion vs unreadable', () => {
  const adaptive = (over: Record<string, unknown> = {}): Partial<ScrapingConfig> =>
    withCap({
      mode: 'adaptive',
      dayPerMin: 30,
      nightPerMin: 10,
      adaptive: {
        startPerMin: 30,
        maxPerMin: 120,
        minPerMin: 4,
        increaseEverySec: 60,
        decreaseFactor: 0.5,
        tolerateBlockRatio: 0.02,
        ...over,
      },
    });

  it('slows down when the far end stops serving us', () => {
    const { governor } = rig(adaptive());
    expect(governor.capPerMin(NOON_IST)).toBeGreaterThan(0);
    const before = governor.capPerMin(NOON_IST);
    for (let i = 0; i < 20; i++) governor.recordRequest(NOON_IST + i * 10);
    // A fifth of recent requests timing out is congestion, not bad luck.
    for (let i = 0; i < 5; i++) governor.recordSoftSignal('congestion', NOON_IST + 300 + i);
    expect(governor.capPerMin(NOON_IST + 400)).toBeLessThan(before);
  });

  it('ignores a couple of timeouts among many good requests', () => {
    const { governor } = rig(adaptive());
    const before = governor.capPerMin(NOON_IST);
    for (let i = 0; i < 300; i++) governor.recordRequest(NOON_IST + i * 10);
    governor.recordSoftSignal('congestion', NOON_IST + 3_100);
    expect(governor.capPerMin(NOON_IST + 3_200)).toBe(before);
  });

  it('NEVER throttles for pages it merely could not read', () => {
    const { governor } = rig(adaptive());
    const before = governor.capPerMin(NOON_IST);
    for (let i = 0; i < 20; i++) governor.recordRequest(NOON_IST + i * 10);
    // A parse failure may well be OUR bug. A mobile-layout persona once caused a
    // third of all Amazon failures; had that fed the rate controller it would
    // have throttled a healthy connection to nothing and hidden the real defect.
    for (let i = 0; i < 20; i++) governor.recordSoftSignal('unreadable', NOON_IST + 300 + i);
    expect(governor.capPerMin(NOON_IST + 400)).toBe(before);
    expect(governor.snapshot(NOON_IST + 400).unreadable).toBe(20);
  });
});

describe('diurnal pacing', () => {
  it('never runs flat out at 4 a.m., and peaks in the evening', () => {
    const at = (h: number): number => Date.UTC(2026, 7, 21, (h - 5 + 24) % 24, 30, 0);
    const smallHours = diurnalFactor(at(4));
    const evening = diurnalFactor(at(19));
    expect(smallHours).toBeLessThan(0.2);
    expect(evening).toBeGreaterThan(0.9);
    expect(evening).toBeGreaterThan(smallHours * 4);
  });

  it('glides between hours instead of stepping', () => {
    // A step function has cliffs a real household's traffic does not.
    const base = Date.UTC(2026, 7, 21, 1, 30, 0); // 07:00 IST
    const samples = Array.from({ length: 8 }, (_, i) => diurnalFactor(base + i * 15 * 60_000));
    for (let i = 1; i < samples.length; i++) {
      expect(Math.abs(samples[i]! - samples[i - 1]!)).toBeLessThan(0.1);
    }
  });

  it('scales the learned rate rather than replacing it', () => {
    const { governor } = rig({
      ipCap: {
        ...DEFAULT_SCRAPING_CONFIG.ipCap,
        mode: 'adaptive',
        adaptive: { ...DEFAULT_SCRAPING_CONFIG.ipCap.adaptive, startPerMin: 100, minPerMin: 1 },
      },
    });
    const noon = Date.UTC(2026, 7, 21, 6, 30, 0);
    governor.capPerMin(noon);
    const night = Date.UTC(2026, 7, 20, 22, 30, 0); // 04:00 IST
    expect(governor.capPerMin(night)).toBeLessThan(governor.capPerMin(noon));
  });
});

describe('usage accounting', () => {
  it('reports an hour of usage without storing an hour of timestamps', () => {
    const { governor } = rig(withCap({ dayPerMin: 1000 }));
    for (let i = 0; i < 500; i++) governor.recordRequest(NOON_IST + i * 1_000);
    const snapshot = governor.snapshot(NOON_IST + 500_000);
    expect(snapshot.usedLastHour).toBe(500);
    // The rolling array holds only the 60 s the cap is computed over; at high
    // rates an hour of timestamps would be rewritten on every single request.
    expect(snapshot.requests.length).toBeLessThanOrEqual(61);
    expect(snapshot.usageBuckets.length).toBeLessThanOrEqual(12);
  });

  it('drops usage buckets older than an hour', () => {
    const { governor } = rig(withCap({ dayPerMin: 1000 }));
    governor.recordRequest(NOON_IST);
    expect(governor.snapshot(NOON_IST + 1_000).usedLastHour).toBe(1);
    expect(governor.snapshot(NOON_IST + 3_700_000).usedLastHour).toBe(0);
  });
});

describe('block backoff', () => {
  it('tolerates a single isolated block', () => {
    const { governor } = rig();
    expect(governor.recordHardBlock(NOON_IST)).toBeNull();
    expect(governor.canRequest(NOON_IST).allowed).toBe(true);
  });

  it('pauses globally after 2 hard blocks in 15 minutes', () => {
    const { governor } = rig();
    governor.recordHardBlock(NOON_IST);
    const until = governor.recordHardBlock(NOON_IST + 5 * 60_000);
    expect(until).toBe(NOON_IST + 5 * 60_000 + BACKOFF_LADDER_MIN[0]! * 60_000);
    const decision = governor.canRequest(NOON_IST + 6 * 60_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('backoff');
  });

  it('pauses after 3 hard blocks in an hour even when none are close together', () => {
    const { governor } = rig();
    governor.recordHardBlock(NOON_IST);
    governor.recordHardBlock(NOON_IST + 20 * 60_000);
    expect(governor.recordHardBlock(NOON_IST + 40 * 60_000)).not.toBeNull();
  });

  it('climbs 10 → 20 → 40 → 80 minutes and caps at three hours', () => {
    const { governor } = rig();
    let now = NOON_IST;
    const durations: number[] = [];
    for (let round = 0; round < 6; round++) {
      governor.recordHardBlock(now);
      const until = governor.recordHardBlock(now + 60_000)!;
      durations.push(Math.round((until - (now + 60_000)) / 60_000));
      // Move past the pause but stay inside the decay window, so the level holds.
      now = until + 60_000;
    }
    expect(durations).toEqual([10, 20, 40, 80, 160, 180]);
    expect(Math.max(...durations)).toBeLessThanOrEqual(180);
  });

  it('halves the daytime cap for six hours after a pause, then restores it', () => {
    const { governor } = rig();
    governor.recordHardBlock(NOON_IST);
    governor.recordHardBlock(NOON_IST + 60_000);
    expect(governor.capPerMin(NOON_IST + 2 * 60_000)).toBe(3);
    expect(governor.capPerMin(NOON_IST + DEGRADE_MS + 60_000)).toBe(6);
  });

  it('forgets the escalation after a long clean stretch', () => {
    const { governor } = rig();
    governor.recordHardBlock(NOON_IST);
    governor.recordHardBlock(NOON_IST + 60_000);
    // Six hours later with nothing wrong, an unrelated incident starts at 10 min.
    const clean = NOON_IST + 7 * 3600_000;
    governor.canRequest(clean); // prune runs here
    governor.recordHardBlock(clean);
    const until = governor.recordHardBlock(clean + 60_000)!;
    expect(Math.round((until - (clean + 60_000)) / 60_000)).toBe(10);
  });

  it('raises an alert carrying the pause end time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricepulse-governor-'));
    const alerts: Array<{ message: string; pausedUntilIso: string }> = [];
    const governor = new IpGovernor(DEFAULT_SCRAPING_CONFIG, new IdentityStore(dir), (a) =>
      alerts.push(a),
    );
    governor.recordHardBlock(NOON_IST);
    governor.recordHardBlock(NOON_IST + 60_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toMatch(/Pausing all fetching for 10 min/);
    expect(alerts[0]!.message).toMatch(/Anyone else on this connection/);
  });

  it('survives a restart with its backoff intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricepulse-governor-'));
    const first = new IpGovernor(DEFAULT_SCRAPING_CONFIG, new IdentityStore(dir));
    first.recordHardBlock(Date.now());
    first.recordHardBlock(Date.now() + 1_000);

    // A restart must not hand a flagged IP a clean slate.
    const second = new IpGovernor(DEFAULT_SCRAPING_CONFIG, new IdentityStore(dir));
    expect(second.canRequest().reason).toBe('backoff');
  });
});
