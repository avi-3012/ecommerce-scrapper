import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { JOB_QUEUES } from '@pricepulse/core';
import type { CheckProductJob } from '@pricepulse/core';
import { API_CONFIG } from './config.js';
import type { ApiConfig } from './config.js';

/** Send-only pg-boss client: the API enqueues, the worker executes (plan §2). */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private boss: PgBoss | null = null;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async onModuleInit(): Promise<void> {
    this.boss = new PgBoss({ connectionString: this.config.DATABASE_URL });
    this.boss.on('error', (err: Error) => console.error('pg-boss error:', err.message));
    await this.boss.start();
    for (const queue of Object.values(JOB_QUEUES)) {
      await this.boss.createQueue(queue).catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: false });
  }

  async enqueueCheckProduct(productId: string): Promise<void> {
    const payload: CheckProductJob = { productId };
    await this.boss?.send(JOB_QUEUES.checkProduct, { ...payload });
  }

  async enqueueCheckAll(): Promise<void> {
    await this.boss?.send(JOB_QUEUES.checkAll, {});
  }

  async enqueueTestNotification(): Promise<void> {
    await this.boss?.send(JOB_QUEUES.testNotification, {});
  }
}
