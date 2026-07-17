import { Body, Controller, Get, HttpCode, Inject, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ALERT_TYPES } from '@pricepulse/shared';
import {
  ALERT_TYPE_LABELS,
  DEFAULT_TEMPLATES,
  getUserWithSettings,
  renderAlertMessage,
  sampleAlertInput,
  templateVariablesFor,
} from '@pricepulse/core';
import { PrismaService } from './prisma.service.js';
import { parseBody } from './validation.js';

const saveSchema = z.object({
  type: z.enum(ALERT_TYPES),
  /** Empty/null resets the type to its built-in default. */
  template: z.string().max(4000).nullable(),
});

const previewSchema = z.object({
  type: z.enum(ALERT_TYPES),
  template: z.string().max(4000).optional(),
});

/**
 * Notification template editor (per alert type). Templates live in
 * Settings.notificationTemplates; a missing entry means "use the default".
 */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('templates')
  async templates() {
    const { settings } = await getUserWithSettings(this.prisma);
    const custom = (settings.notificationTemplates ?? {}) as Record<string, string>;
    return ALERT_TYPES.map((type) => ({
      type,
      label: ALERT_TYPE_LABELS[type],
      template: custom[type] ?? '', // '' ⇒ using the default
      default: DEFAULT_TEMPLATES[type],
      variables: templateVariablesFor(type),
    }));
  }

  @Put('templates')
  async save(@Body() body: unknown) {
    const { type, template } = parseBody(saveSchema, body);
    const { user, settings } = await getUserWithSettings(this.prisma);
    const map = { ...((settings.notificationTemplates ?? {}) as Record<string, string>) };
    if (template && template.trim()) map[type] = template;
    else delete map[type]; // reset to default
    await this.prisma.settings.update({
      where: { userId: user.id },
      data: { notificationTemplates: map },
    });
    return { type, template: map[type] ?? '', default: DEFAULT_TEMPLATES[type] };
  }

  @Post('preview')
  @HttpCode(200)
  async preview(@Body() body: unknown) {
    const { type, template } = parseBody(previewSchema, body);
    const { settings } = await getUserWithSettings(this.prisma);
    const message = renderAlertMessage(sampleAlertInput(type), {
      template: template && template.trim() ? template : DEFAULT_TEMPLATES[type],
      timezone: settings.timezone,
    });
    return { message };
  }
}
