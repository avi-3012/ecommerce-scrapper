import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from './prisma.service.js';
import type { WorkerConfig } from './config.js';

/**
 * The guarantee the whole split rests on: a worker never sends a request for a
 * marketplace it does not own. Enforced at the one place every request starts —
 * acquiring an identity — so the scheduler, on-demand checks, previews, the
 * Telegram bot and noise browsing are all covered by the same line.
 */
describe('IdentityService marketplace gate', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pp-scope-'));
    vi.stubEnv('IDENTITY_DIR', dir);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const service = async (marketplaces: string[], withPool = false) => {
    const { IdentityService } = await import('./identity.service.js');
    const config = { WORKER_MARKETPLACES: marketplaces } as unknown as WorkerConfig;
    const identities = new IdentityService({} as PrismaService, config);
    // Generating a full pool of personas takes a few seconds; the refusal
    // happens before the pool is ever consulted, so only the serving case
    // needs one.
    if (withPool) identities.pool.ensureSize();
    return identities;
  };

  it(
    'hands out no identity for a marketplace this worker does not scrape',
    { timeout: 30_000 },
    async () => {
      const amazonOnly = await service(['amazon_in']);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(amazonOnly.scrapes('flipkart')).toBe(false);
      expect(amazonOnly.acquire('flipkart')).toBeNull();
      expect(amazonOnly.acquire('flipkart')).toBeNull();
      // Said once, not on every refused request.
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    },
  );

  it('still serves its own marketplace', { timeout: 60_000 }, async () => {
    const amazonOnly = await service(['amazon_in'], true);
    const session = amazonOnly.acquire('amazon_in');
    expect(session).not.toBeNull();
    amazonOnly.release(session!);
  });
});
