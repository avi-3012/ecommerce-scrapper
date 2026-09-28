import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { allowLargeImportReviews } from './body-limits.js';

@Controller()
class EchoController {
  @Post('import/execute')
  @HttpCode(200)
  execute(@Body() body: { valid?: unknown[] }) {
    return { rows: body?.valid?.length ?? null };
  }

  @Post('settings')
  @HttpCode(200)
  settings(@Body() body: { valid?: unknown[] }) {
    return { rows: body?.valid?.length ?? null };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

/**
 * Over real HTTP, because the failure this guards against lives in the order
 * Express and Nest install their parsers — not in anything a unit could see.
 */
describe('request body limits', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(EchoModule, { logger: false });
    app.setGlobalPrefix('api');
    allowLargeImportReviews(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** A review shaped like /import/validate's, with Flipkart-length URLs (~450 chars). */
  const review = (rows: number) => ({
    filename: 'FK laptops link.xlsx',
    totalRows: rows,
    valid: Array.from({ length: rows }, (_, i) => ({
      rowNumber: i + 2,
      url: `https://www.flipkart.com/laptop/p/itm51b9615f85177?pid=COMHG6XZUYV${String(i).padStart(5, '0')}&${'x'.repeat(380)}`,
      canonicalUrl: 'https://www.flipkart.com/product/p/itm51b9615f85177?pid=COMHG6XZUYVABCDE',
      marketplace: 'flipkart',
      marketplaceProductId: 'COMHG6XZUYVABCDE',
    })),
    duplicates: [],
    invalid: [],
  });

  it('accepts confirming a 1,000-row import', async () => {
    const res = await post('/api/import/execute', review(1000));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: 1000 });
  });

  it('still parses JSON on every other route', async () => {
    const res = await post('/api/settings', review(3));
    expect(await res.json()).toEqual({ rows: 3 });
  });

  it('keeps the 100 KB default everywhere else', async () => {
    const res = await post('/api/settings', review(400));
    expect(res.status).toBe(413);
  });
});
