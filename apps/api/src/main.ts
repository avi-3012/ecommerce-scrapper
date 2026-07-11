import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Single root .env for all apps (WP-0.5); real environments set real env vars.
loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

async function bootstrap(): Promise<void> {
  // Validate before Nest starts so a config error is the first and only output.
  const config = loadConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  // Security headers on every response (WP-2.1 rule 4)
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'",
    );
    next();
  });

  // Cross-site request protection: mutating requests must be same-origin
  // (SameSite=lax cookie + Origin check; WP-2.1 rule 4).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) {
        res.status(403).json({ message: 'Cross-origin request rejected' });
        return;
      }
    }
    next();
  });

  // Serve the built SPA when present (staging/production topology, plan §2).
  const webDist = join(import.meta.dirname, '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(join(webDist, 'index.html'));
        return;
      }
      next();
    });
  }

  await app.listen(config.PORT);
  console.log(`PricePulse API listening on port ${config.PORT} (${config.NODE_ENV})`);
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
