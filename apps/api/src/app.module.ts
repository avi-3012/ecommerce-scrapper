import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { API_CONFIG, loadConfig } from './config.js';
import { PrismaService } from './prisma.service.js';
import { HealthController } from './health.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard, AuthService } from './auth/auth.js';
import { JobsService } from './jobs.service.js';
import { ProductsController } from './products/products.controller.js';
import { CategoriesController } from './categories.controller.js';
import { AlertsController } from './alerts.controller.js';
import { SettingsController } from './settings.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { StatusController } from './status.controller.js';
import { ImportController } from './import/import.controller.js';
import { ImportService } from './import/import.service.js';
import { ExportController } from './export.controller.js';
import { EventsController, EventsService } from './events.js';
import { BrowserService } from './browser.service.js';

@Module({
  controllers: [
    HealthController,
    AuthController,
    ProductsController,
    CategoriesController,
    AlertsController,
    SettingsController,
    NotificationsController,
    StatusController,
    ImportController,
    ExportController,
    EventsController,
  ],
  providers: [
    { provide: API_CONFIG, useFactory: loadConfig },
    PrismaService,
    AuthService,
    JobsService,
    ImportService,
    EventsService,
    BrowserService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PrismaService],
})
export class AppModule {}
