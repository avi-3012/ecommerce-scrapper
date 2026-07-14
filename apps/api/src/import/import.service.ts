import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { createDefaultRegistry, resolveListingUrl } from '@pricepulse/adapters';
import type { UrlRecognition } from '@pricepulse/adapters';
import { getUserWithSettings } from '@pricepulse/core';
import type { Marketplace } from '@pricepulse/shared';
import { PrismaService } from '../prisma.service.js';

/** How many short links to resolve in parallel during a bulk import (WP-2.9). */
const RESOLVE_CONCURRENCY = 6;

/** Run an async mapper over items with a bounded number of concurrent workers. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ImportRow {
  rowNumber: number;
  url: string;
  name?: string;
  targetPrice?: number;
  dropThresholdPct?: number;
  notes?: string;
  tags?: string[];
}

export interface ValidatedRow extends ImportRow {
  canonicalUrl: string;
  marketplace: Marketplace;
  marketplaceProductId: string;
}

export interface ImportReview {
  filename: string;
  totalRows: number;
  valid: ValidatedRow[];
  duplicates: Array<{ rowNumber: number; url: string; reason: string }>;
  invalid: Array<{ rowNumber: number; url: string; reason: string }>;
}

/** Header aliases accepted by the column mapper (WP-2.9 rule 2). */
const HEADER_MAP: Record<string, keyof Omit<ImportRow, 'rowNumber'>> = {
  url: 'url',
  link: 'url',
  'product url': 'url',
  name: 'name',
  title: 'name',
  'target price': 'targetPrice',
  target_price: 'targetPrice',
  target: 'targetPrice',
  threshold: 'dropThresholdPct',
  'threshold %': 'dropThresholdPct',
  drop_threshold_pct: 'dropThresholdPct',
  notes: 'notes',
  tags: 'tags',
};

const MAX_ROWS = 1000;
/** Stagger initial checks so imports never stampede the marketplaces (FR-2.5). */
const STAGGER_SECONDS = 15;

@Injectable()
export class ImportService {
  private readonly registry = createDefaultRegistry();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Validation pass — persists nothing (WP-2.9 rule 3). */
  async validate(filename: string, buffer: Buffer): Promise<ImportReview> {
    const rows = await this.parseFile(filename, buffer);
    if (rows.length === 0) throw new BadRequestException('The file contains no data rows');
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(`Too many rows (${rows.length}); the limit is ${MAX_ROWS}`);
    }

    const { user } = await getUserWithSettings(this.prisma);
    const review: ImportReview = {
      filename,
      totalRows: rows.length,
      valid: [],
      duplicates: [],
      invalid: [],
    };
    const seenCanonical = new Set<string>();

    // Resolve short/affiliate links (fkrt.co, amzn.in, amzn.to, pwap.in, …) to
    // real marketplace URLs before recognizing them (network step, parallel).
    const isListing = (u: string): boolean => this.registry.recognize(u).kind === 'listing';
    const resolved = await mapWithConcurrency(rows, RESOLVE_CONCURRENCY, async (row) => {
      if (!row.url)
        return { effectiveUrl: '', recognition: undefined as UrlRecognition | undefined };
      let effectiveUrl = row.url;
      let recognition = this.registry.recognize(row.url);
      if (recognition.kind !== 'listing') {
        try {
          const final = await resolveListingUrl(row.url, isListing);
          if (final && final !== row.url) {
            effectiveUrl = final;
            recognition = this.registry.recognize(final);
          }
        } catch {
          // resolution failed (blocked/unreachable) — keep the original recognition
        }
      }
      return { effectiveUrl, recognition };
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const { recognition, effectiveUrl } = resolved[i]!;
      if (!row.url || !recognition) {
        review.invalid.push({ rowNumber: row.rowNumber, url: '', reason: 'Missing URL' });
        continue;
      }
      if (recognition.kind === 'unsupported') {
        review.invalid.push({
          rowNumber: row.rowNumber,
          url: row.url,
          reason: `Unsupported site${recognition.detectedSite ? ` (${recognition.detectedSite})` : ''} — only Amazon India and Flipkart are supported`,
        });
        continue;
      }
      if (recognition.kind === 'not_a_listing') {
        review.invalid.push({
          rowNumber: row.rowNumber,
          url: row.url,
          reason:
            'Could not resolve to a product listing (short link may be blocked, expired, or point to a search/category page)',
        });
        continue;
      }
      if (row.targetPrice !== undefined && !(row.targetPrice > 0)) {
        review.invalid.push({
          rowNumber: row.rowNumber,
          url: row.url,
          reason: 'Target price must be a positive number',
        });
        continue;
      }
      if (seenCanonical.has(recognition.canonicalUrl)) {
        review.duplicates.push({
          rowNumber: row.rowNumber,
          url: row.url,
          reason: 'Duplicate of an earlier row in this file (first occurrence wins)',
        });
        continue;
      }
      const existing = await this.prisma.product.findUnique({
        where: {
          userId_canonicalUrl: { userId: user.id, canonicalUrl: recognition.canonicalUrl },
        },
        select: { displayName: true },
      });
      if (existing) {
        review.duplicates.push({
          rowNumber: row.rowNumber,
          url: row.url,
          reason: `Already tracked as “${existing.displayName}”`,
        });
        continue;
      }
      seenCanonical.add(recognition.canonicalUrl);
      // Store the resolved full URL so the product's "open listing" link is direct.
      review.valid.push({
        ...row,
        url: effectiveUrl,
        canonicalUrl: recognition.canonicalUrl,
        marketplace: recognition.marketplace,
        marketplaceProductId: recognition.productId,
      });
    }
    return review;
  }

  /**
   * Execute a confirmed review: rows register WITHOUT a live fetch — they
   * enter the schedule staggered and the scheduler's politeness pacing does
   * the first checks (WP-2.9 rules 4–5). Import success = registration
   * success; fetch health is monitoring's ongoing job.
   */
  async execute(review: ImportReview): Promise<{ batchId: string; imported: number }> {
    const { user } = await getUserWithSettings(this.prisma);
    let imported = 0;
    const now = Date.now();

    for (const [i, row] of review.valid.entries()) {
      try {
        await this.prisma.product.create({
          data: {
            userId: user.id,
            marketplace: row.marketplace,
            url: row.url,
            canonicalUrl: row.canonicalUrl,
            marketplaceProductId: row.marketplaceProductId,
            displayName: row.name?.trim() || `Awaiting first check — ${row.marketplaceProductId}`,
            targetPrice: row.targetPrice ?? null,
            dropThresholdPct: row.dropThresholdPct ?? null,
            notes: row.notes ?? '',
            tags: row.tags ?? [],
            status: 'active',
            nextCheckAt: new Date(now + i * STAGGER_SECONDS * 1000),
          },
        });
        imported++;
      } catch {
        review.duplicates.push({
          rowNumber: row.rowNumber,
          url: row.url,
          reason: 'Became a duplicate during import',
        });
      }
    }

    const batch = await this.prisma.importBatch.create({
      data: {
        userId: user.id,
        filename: review.filename,
        totalRows: review.totalRows,
        imported,
        duplicates: review.duplicates.length,
        invalid: review.invalid.length,
        rowErrors: [...review.invalid, ...review.duplicates] as object[],
      },
    });
    return { batchId: batch.id, imported };
  }

  async listBatches() {
    return this.prisma.importBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  private async parseFile(filename: string, buffer: Buffer): Promise<ImportRow[]> {
    if (/\.csv$/i.test(filename)) return this.parseCsvFile(buffer);
    if (/\.xlsx$/i.test(filename)) return this.parseXlsxFile(buffer);
    throw new BadRequestException('Unsupported file type — upload .csv or .xlsx');
  }

  private parseCsvFile(buffer: Buffer): ImportRow[] {
    let records: Record<string, string>[];
    try {
      records = parseCsv(buffer, { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      throw new BadRequestException(
        `Could not parse CSV: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
    return records.map((record, i) => this.mapRow(record, i + 2)); // +2: 1-based + header row
  }

  private async parseXlsxFile(buffer: Buffer): Promise<ImportRow[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException('Could not parse the Excel file');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('The workbook has no sheets');
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, col) => {
      headers[col] = String(cell.value ?? '').trim();
    });
    const rows: ImportRow[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: Record<string, string> = {};
      row.eachCell((cell, col) => {
        const header = headers[col];
        if (header) record[header] = String(cell.value ?? '').trim();
      });
      rows.push(this.mapRow(record, rowNumber));
    });
    return rows;
  }

  private mapRow(record: Record<string, string>, rowNumber: number): ImportRow {
    const row: ImportRow = { rowNumber, url: '' };
    for (const [header, value] of Object.entries(record)) {
      const field = HEADER_MAP[header.toLowerCase().trim()];
      if (!field || !value) continue;
      if (field === 'url') row.url = value;
      else if (field === 'name') row.name = value;
      else if (field === 'notes') row.notes = value;
      else if (field === 'tags')
        row.tags = value
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean);
      else if (field === 'targetPrice' || field === 'dropThresholdPct') {
        const num = Number(value.replace(/[₹,\s]/g, ''));
        if (Number.isFinite(num)) row[field] = num;
        else row[field] = -1; // fails positive-number validation with a clear reason
      }
    }
    return row;
  }
}
