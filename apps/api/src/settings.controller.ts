import { Body, Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { encryptSecret, getUserWithSettings } from '@pricepulse/core';
import { PrismaService } from './prisma.service.js';
import { JobsService } from './jobs.service.js';
import { API_CONFIG } from './config.js';
import type { ApiConfig } from './config.js';
import { parseBody } from './validation.js';

const patchSchema = z.object({
  checkIntervalMinutes: z
    .number()
    .int()
    .min(10)
    .max(24 * 60)
    .optional(),
  globalDropThresholdPct: z.number().min(0.1).max(99).optional(),
  consecutiveFailureLimit: z.number().int().min(2).max(50).optional(),
  monitoringPaused: z.boolean().optional(),
  alertTargetPrice: z.boolean().optional(),
  alertThresholdDrop: z.boolean().optional(),
  alertAnyChange: z.boolean().optional(),
  alertOfferChange: z.boolean().optional(),
  alertBackInStock: z.boolean().optional(),
  timezone: z.string().optional(),
  /** Plaintext in, encrypted at rest; null clears it. */
  telegramBotToken: z.string().min(10).nullable().optional(),
  telegramChatId: z.string().min(1).nullable().optional(),
  // Milestone 3 hygiene (WP-3.1)
  cooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .optional(),
  quietHoursStart: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable()
    .optional(),
  quietHoursEnd: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable()
    .optional(),
  quietHoursHoldHealth: z.boolean().optional(),
  digestFrequency: z.enum(['off', 'daily', 'weekly']).optional(),
  digestTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable()
    .optional(),
  /** Daily full-sweep time (HH:MM); null disables it. */
  dailyCheckTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable()
    .optional(),
  nearLowThresholdPct: z.number().min(0).max(50).optional(),
  /** 6-digit India delivery pincode for location-aware scraping; null clears it. */
  pincode: z
    .string()
    .regex(/^\d{6}$/, 'Enter a valid 6-digit pincode')
    .nullable()
    .optional(),
});

/**
 * FR-6.1/6.2: all settings live in the database and take effect immediately —
 * the worker reads them each cycle. The interval floor (10 min) is a
 * politeness guardrail (FR-2.5).
 */
@Controller('settings')
export class SettingsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async get() {
    const { user, settings } = await getUserWithSettings(this.prisma);
    const { telegramBotTokenEnc, ...rest } = settings;
    return {
      ...rest,
      telegramBotTokenSet: telegramBotTokenEnc !== null,
      telegramChatId: user.telegramChatId,
    };
  }

  @Patch()
  async patch(@Body() body: unknown) {
    const changes = parseBody(patchSchema, body);
    const { user } = await getUserWithSettings(this.prisma);
    const { telegramBotToken, telegramChatId, ...plain } = changes;

    if (telegramChatId !== undefined) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId },
      });
    }

    await this.prisma.settings.update({
      where: { userId: user.id },
      data: {
        ...plain,
        ...(telegramBotToken !== undefined
          ? {
              telegramBotTokenEnc:
                telegramBotToken === null
                  ? null
                  : encryptSecret(telegramBotToken, this.config.SETTINGS_ENC_KEY),
            }
          : {}),
      },
    });
    return this.get();
  }

  /** FR-4.3: executed by the worker so it exercises the real delivery path. */
  @Post('test-notification')
  @HttpCode(202)
  async testNotification() {
    await this.jobs.enqueueTestNotification();
    return { queued: true };
  }
}
