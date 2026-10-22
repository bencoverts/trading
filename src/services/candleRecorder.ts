import type { Db } from '../db/types.js';
import type { Candle } from '../domain/candles.js';
import type { Logger } from '../lib/logger.js';
import type { Config } from '../config.js';
import type { PriceEngine } from '../price/engine.js';

export interface CandleRecorderOptions {
  db: Db;
  engine: PriceEngine;
  logger: Logger;
  config: Config;
  /** how often the still-forming candle is upserted */
  flushIntervalMs?: number;
}

/**
 * Persists candles so chart history survives restarts.
 *
 * Closed candles are written immediately (they never change again). The still
 * forming candle is upserted at most every `flushIntervalMs` to keep write load
 * low, and `candle_closed` events are never missed because they bypass the timer.
 */
export class CandleRecorder {
  private unsubscribers: Array<() => void> = [];
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private readonly opts: CandleRecorderOptions) {}

  async loadHistory(perTimeframe = 1_000): Promise<Record<string, Candle[]>> {
    const out: Record<string, Candle[]> = {};
    for (const tf of this.opts.engine.timeframes) {
      const rows = await this.opts.db.all<Candle>(
        `SELECT t, o, h, l, c FROM candles WHERE symbol = ? AND tf = ? ORDER BY t DESC LIMIT ?`,
        [this.opts.engine.symbol, tf, perTimeframe],
      );
      out[tf] = rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) })).reverse();
      this.opts.engine.seedHistory(tf, out[tf]);
    }
    return out;
  }

  async hasAnyCandles(): Promise<boolean> {
    const row = await this.opts.db.get<{ t: number }>(`SELECT t FROM candles WHERE symbol = ? LIMIT 1`, [
      this.opts.engine.symbol,
    ]);
    return Boolean(row);
  }

  async saveCandles(tf: string, candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;
    await this.opts.db.tx(async (t) => {
      for (const c of candles) {
        await t.run(
          `INSERT INTO candles (symbol, tf, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (symbol, tf, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c`,
          [this.opts.engine.symbol, tf, c.t, c.o, c.h, c.l, c.c],
        );
      }
    });
  }

  start(): void {
    const offClosed = this.opts.engine.events.on('candle_closed', ({ tf, candle }) => {
      this.enqueue(() => this.saveCandles(tf, [candle]));
    });
    this.unsubscribers.push(offClosed);

    const interval = this.opts.flushIntervalMs ?? 2_000;
    this.timer = setInterval(() => {
      void this.flushRunning().catch((err) => this.opts.logger.warn({ err }, 'candle flush failed'));
    }, interval);
    this.timer.unref?.();
  }

  /** Upserts the forming candle of every timeframe. */
  async flushRunning(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const tf of this.opts.engine.timeframes) {
        const cur = this.opts.engine.getCurrentCandle(tf);
        if (cur) await this.saveCandles(tf, [cur]);
      }
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    this.unsubscribers.forEach((off) => off());
    this.unsubscribers = [];
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.queue.catch(() => undefined);
    try {
      await this.flushRunning();
    } catch (err) {
      this.opts.logger.warn({ err }, 'final candle flush failed');
    }
  }

  /** Deletes candles and audit rows outside the retention window. */
  async prune(now = Date.now()): Promise<{ candles: number; audit: number }> {
    const candleCutoff = now - this.opts.config.CANDLE_RETENTION_SEC * 1000;
    const auditCutoff = now - this.opts.config.AUDIT_RETENTION_SEC * 1000;
    const c = await this.opts.db.run(`DELETE FROM candles WHERE t < ?`, [candleCutoff]);
    const a = await this.opts.db.run(`DELETE FROM audit_log WHERE created_at < ?`, [auditCutoff]);
    this.opts.engine.pruneHistory(candleCutoff);
    return { candles: c.changes, audit: a.changes };
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue
      .then(fn)
      .catch((err) => this.opts.logger.warn({ err }, 'candle persistence failed'));
  }
}
