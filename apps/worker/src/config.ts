/** Fail-fast environment validation for the worker (WP-0.5). */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url({ message: 'must be a postgres:// connection URL' }),
  WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  SETTINGS_ENC_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 32 bytes hex-encoded (64 hex characters)'),
  /** Scheduler tick period; checks are spread by per-product next-check times. */
  SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
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

export const WORKER_CONFIG = 'WORKER_CONFIG';
