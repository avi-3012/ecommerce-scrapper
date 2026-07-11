import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { loadConfig } from './config.js';

/**
 * The worker is a NestJS standalone application context: no HTTP listener.
 * It shares domain modules with the API and talks to it only through the
 * database (architecture §2).
 */
async function bootstrap(): Promise<void> {
  loadConfig(); // fail fast before Nest starts

  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  console.log('PricePulse worker running (heartbeat active)');

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
