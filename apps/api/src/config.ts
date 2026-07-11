/**
 * Fail-fast environment validation (WP-0.5): the API refuses to boot with a
 * precise message naming any missing or invalid variable. User-facing
 * settings (interval, thresholds, Telegram credentials) are NOT here —
 * they live in the database per the configuration taxonomy.
 */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url({ message: 'must be a postgres:// connection URL' }),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SETTINGS_ENC_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 32 bytes hex-encoded (64 hex characters)'),
});

export type ApiConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const API_CONFIG = 'API_CONFIG';
