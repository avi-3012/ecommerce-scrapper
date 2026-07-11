import { Module } from '@nestjs/common';
import { WORKER_CONFIG, loadConfig } from './config.js';
import { PrismaService } from './prisma.service.js';
import { HeartbeatService } from './heartbeat.service.js';
import { CheckRunnerService } from './check-runner.service.js';
import { SchedulerService } from './scheduler.service.js';
import { TelegramService } from './telegram/telegram.service.js';
import { BotService } from './telegram/bot.service.js';
import { JobsService } from './jobs.service.js';

@Module({
  providers: [
    { provide: WORKER_CONFIG, useFactory: loadConfig },
    PrismaService,
    HeartbeatService,
    CheckRunnerService,
    SchedulerService,
    TelegramService,
    BotService,
    JobsService,
  ],
})
export class WorkerModule {}
