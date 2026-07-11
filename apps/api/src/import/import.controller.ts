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
  async execute(@Body() review: ImportReview) {
    if (!review || !Array.isArray(review.valid)) {
      throw new BadRequestException('Body must be the review returned by /import/validate');
    }
    return this.importService.execute(review);
  }

  @Get()
  async batches() {
    return this.importService.listBatches();
  }
}
