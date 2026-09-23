/** Fail-fast environment validation for the worker (WP-0.5). */
import { z } from 'zod';
import { MARKETPLACES } from '@pricepulse/shared';
import type { Marketplace } from '@pricepulse/shared';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url({ message: 'must be a postgres:// connection URL' }),
    WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    SETTINGS_ENC_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'must be 32 bytes hex-encoded (64 hex characters)'),
    /** Scheduler tick period; checks are spread by per-product next-check times. */
    SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
    /**
     * Which marketplaces this worker scrapes, comma-separated
     * (`amazon_in`, `flipkart`). Unset = every marketplace, which is exactly
     * how a single worker has always behaved.
     *
     * Each marketplace is served from whichever connection it accepts, so each
     * gets a worker of its own with its own identities, budget and backoff —
     * and a refusal from one can never be counted against another's budget.
     */
    WORKER_MARKETPLACES: z
      .string()
      .optional()
      .transform((value, ctx): Marketplace[] => {
        const list = (value ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        if (list.length === 0) return [...MARKETPLACES];
        const unknown = list.filter((m) => !(MARKETPLACES as readonly string[]).includes(m));
        if (unknown.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown marketplace ${unknown.join(', ')} — expected ${MARKETPLACES.join(', ')}`,
          });
          return z.NEVER;
        }
        return [...new Set(list)] as Marketplace[];
      }),
    /**
     * `primary` runs the duties that must happen exactly once however many
     * workers there are: Telegram polling, alert delivery and digests, and
     * database housekeeping. `secondary` only scrapes. Two Telegram pollers on
     * one bot token make Telegram refuse both, and two alert dispatchers would
     * send every alert twice.
     */
    WORKER_ROLE: z.enum(['primary', 'secondary']).default('primary'),
    /**
     * The system_status row this worker reports into. Row 1 is the primary's;
     * every other worker needs its own, or two workers overwrite each other's
     * heartbeat and one of them looks dead while the other looks like both.
     */
    WORKER_STATUS_ID: z.coerce.number().int().min(1).max(99).default(1),
  })
  .superRefine((env, ctx) => {
    if (env.WORKER_ROLE === 'secondary' && env.WORKER_STATUS_ID === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WORKER_STATUS_ID'],
        message:
          'a secondary worker needs its own status row — set WORKER_STATUS_ID=2 (1 is the primary)',
      });
    }
  });

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

/** Whether this worker scrapes every marketplace (the single-worker case). */
export function scrapesEverything(config: Pick<WorkerConfig, 'WORKER_MARKETPLACES'>): boolean {
  return MARKETPLACES.every((m) => config.WORKER_MARKETPLACES.includes(m));
}

export const WORKER_CONFIG = 'WORKER_CONFIG';
