import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImportService } from './import.service.js';
import type { ImportReview } from './import.service.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Bulk import (FR-1.7, WP-2.9): validate (nothing saved) → user reviews the
 * per-row dispositions → execute. The result report is persisted as an
 * import batch.
 */
@Controller('import')
export class ImportController {
  constructor(@Inject(ImportService) private readonly importService: ImportService) {}

  @Post('validate')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  async validate(@UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    if (!file) throw new BadRequestException('Upload a .csv or .xlsx file in the "file" field');
    return this.importService.validate(file.originalname, file.buffer);
  }

  @Post('execute')
  async execute(@Body() body: ImportReview & { priority?: unknown }) {
    if (!body || !Array.isArray(body.valid)) {
      throw new BadRequestException('Body must be the review returned by /import/validate');
    }
    // One priority for every product this file brings in, typed on the review
    // screen. Absent, they take the default like any new product.
    const { priority, ...review } = body;
    if (
      priority !== undefined &&
      !(
        Number.isInteger(priority) &&
        (priority as number) >= 1 &&
        (priority as number) <= 1_000_000
      )
    ) {
      throw new BadRequestException('Priority must be a whole number from 1 to 1,000,000');
    }
    return this.importService.execute(review, priority as number | undefined);
  }

  @Get()
  async batches() {
    return this.importService.listBatches();
  }
}
