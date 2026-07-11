import { Controller, Inject, Injectable, Sse } from '@nestjs/common';
import type { MessageEvent, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Observable } from 'rxjs';
import pg from 'pg';
import { API_CONFIG } from './config.js';
import type { ApiConfig } from './config.js';

/**
 * Live dashboard updates (FR-5.8, WP-3.6): the worker emits pg_notify events;
 * this service LISTENs and fans them out over SSE. Correctness never depends
 * on the stream — the SPA refetches on reconnect and keeps polling as a
 * fallback.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private client: pg.Client | null = null;
  private readonly subject = new Subject<MessageEvent>();
  private stopping = false;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.config.DATABASE_URL });
    client.on('notification', (msg) => {
      this.subject.next({ data: msg.payload ?? '{}' });
    });
    client.on('error', (err) => {
      console.error('Events listener error:', err.message);
    });
    client.on('end', () => {
      if (!this.stopping) setTimeout(() => void this.connect().catch(() => undefined), 5_000);
    });
    await client.connect();
    await client.query('LISTEN pricepulse_events');
    this.client = client;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.client?.end().catch(() => undefined);
    this.subject.complete();
  }

  get stream(): Observable<MessageEvent> {
    return this.subject.asObservable();
  }
}

@Controller()
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}

  @Sse('events')
  events$(): Observable<MessageEvent> {
    return this.events.stream;
  }
}
