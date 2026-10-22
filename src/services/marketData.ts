import type { Database } from '../db/sqlite.js';
import type { PriceEngine, Tick } from '../price/engine.js';
import type { Logger } from '../lib/logger.js';
import type { Config } from '../config.js';
import type { Clock } from '../lib/clock.js';
import { CandleAggregator, type Candle } from '../domain/candles.js';
import { TIME_FRAMES, TIMEFRAME_LIST } from '../domain/constants.js';
import { quantizePrice } from '../domain/payout.js';

export interface CandleRow {
  market: string;
  tf: string;
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface TickPoint {
  price: number;
  time: number;
  seq?: number;
}

/** Deterministic PRNG for reproducible synthetic history. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simple bounded random walk used only to fill an empty database on first boot. */
export function synthPath(opts: {
  endPrice: number;
  points: number;
  stepMs: number;
  endTime: number;
  volatility?: number;
  tickSize: number;
  decimals: number;
  seed: number;
}): TickPoint[] {
  const rng = mulberry32(opts.seed);
  const vol = (opts.volatility ?? 1) * opts.tickSize;
  let price = opts.endPrice;
  const backwards: number[] = [];
  for (let i = 0; i < opts.points; i++) {
    backwards.push(price);
    const shock = (rng() * 2 - 1) * vol * 1.6;
    price = Math.max(opts.tickSize * 10, price - shock);
  }
  backwards.reverse();
  const start = opts.endTime - (opts.points - 1) * opts.stepMs;
  return backwards.map((p, i) => ({
    price: quantizePrice(p, opts.decimals),
    time: start + i * opts.stepMs,
  }));
}

export interface MarketDataDeps {
  db: Database;
  engine: PriceEngine;
  logger: Logger;
  config: Config;
  clock: Clock;
}

/**
 * Persistence for market data:
 *  - closed candles are written immediately, the forming candle every 2 s
 *  - ticks are batched (default 1 s) and pruned after TICK_RETENTION_DAYS
 *  - on an empty database, 24 h of synthetic history is generated so charts
 *    and the 24 h change are meaningful from the first page load
 */
export class MarketDataService {
  private pendingTicks: Tick[] = [];
  private unsubscribers: Array<() => void> = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private candleTimer: ReturnType<typeof setInterval> | null = null;
  private housekeepingTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private tickerCache = new Map<string, { at: number; price: number | null }>();
  private rangeCache = new Map<string, { at: number; high: number | null; low: number | null }>();

  constructor(private readonly deps: MarketDataDeps) {
    // Tick/candle capture is set up at construction so data is never lost, even
    // when the periodic flush timers are not running (tests, short-lived jobs).
    this.unsubscribers.push(
      this.deps.engine.events.on('tick', (tick) => {
        this.pendingTicks.push(tick);
        if (this.pendingTicks.length > 20_000) this.flushTicks();
      }),
      this.deps.engine.events.on('candle_closed', ({ market, tf, candle }) => {
        this.saveCandles(market, tf, [candle]);
      }),
    );
  }

  private get db(): Database {
    return this.deps.db;
  }

  // ------------------------------------------------------------- bootstrap

  /** Fills an empty database with 24 h of synthetic candles + ticks. */
  bootstrapHistory(
    markets: Array<{ symbol: string; basePrice: number; tickSize: number; priceDecimals: number }>,
    opts: { hours?: number; force?: boolean } = {},
  ): void {
    const now = this.deps.clock.now();
    const endTime = Math.floor(now / 5_000) * 5_000;
    const stepMs = 5_000;
    const hours = opts.hours ?? 24;
    const points = Math.max(120, Math.round((hours * 3600_000) / stepMs));

    for (const [index, market] of markets.entries()) {
      const hasCandles = this.db.get<{ t: number }>('SELECT t FROM candles WHERE market = ? LIMIT 1', market.symbol);
      if (hasCandles && !opts.force) continue;

      const path = synthPath({
        endPrice: market.basePrice,
        points,
        stepMs,
        endTime,
        tickSize: market.tickSize,
        decimals: market.priceDecimals,
        seed: 1337 + index * 101,
      });

      const aggregator = new CandleAggregator(TIME_FRAMES, { maxHistory: 20_000 });
      for (const p of path) aggregator.apply(p.price, p.time);

      this.db.transaction(() => {
        const insertCandle = this.db.prepare(
          `INSERT INTO candles (market, tf, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (market, tf, t) DO NOTHING`,
        );
        for (const tf of TIMEFRAME_LIST) {
          for (const c of aggregator.getHistory(tf, 20_000)) {
            insertCandle.run(market.symbol, tf, c.t, c.o, c.h, c.l, c.c);
          }
        }
        const insertTick = this.db.prepare('INSERT INTO ticks (market, t, price) VALUES (?, ?, ?)');
        for (const p of path) insertTick.run(market.symbol, p.time, p.price);
      });

      const last = path[path.length - 1];
      this.deps.engine.setPrice(market.symbol, last.price);
      // make the new market tradeable immediately (entry price must exist even
      // when the tick loop is not running yet, e.g. in tests)
      this.deps.engine.ingest(market.symbol, last.price, last.time + 1);
      this.deps.logger.info({ market: market.symbol, ticks: path.length }, 'synthetic 24h history created');
    }
  }

  /** Loads recent candles into the engine (used for WS replay/resume). */
  seedEngineFromDb(perTimeframe = 500): void {
    for (const market of this.deps.engine.listConfigs()) {
      for (const tf of TIMEFRAME_LIST) {
        const rows = this.db.all<CandleRow>(
          `SELECT t, o, h, l, c FROM candles WHERE market = ? AND tf = ? ORDER BY t DESC LIMIT ?`,
          market.symbol,
          tf,
          perTimeframe,
        );
        if (rows.length) {
          this.deps.engine.seedCandles(
            market.symbol,
            tf,
            rows.map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c })).reverse(),
          );
        }
      }
    }
  }

  start(): void {
    this.flushTimer = setInterval(() => void this.flushTicks(), this.deps.config.TICKS_FLUSH_MS);
    this.flushTimer.unref?.();
    this.candleTimer = setInterval(() => this.flushRunningCandles(), 2_000);
    this.candleTimer.unref?.();
    this.housekeepingTimer = setInterval(() => this.prune(), this.deps.config.HOUSEKEEPING_INTERVAL_MS);
    this.housekeepingTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.unsubscribers.forEach((off) => off());
    this.unsubscribers = [];
    for (const timer of [this.flushTimer, this.candleTimer, this.housekeepingTimer]) {
      if (timer) clearInterval(timer);
    }
    this.flushTimer = null;
    this.candleTimer = null;
    this.housekeepingTimer = null;
    this.flushTicks();
    this.flushRunningCandles();
  }

  // ---------------------------------------------------------------- ticks

  /** Persists buffered ticks. Synchronous on purpose (shutdown-safe). */
  flushTicks(): number {
    if (this.flushing || this.pendingTicks.length === 0) return 0;
    this.flushing = true;
    const batch = this.pendingTicks.splice(0, this.pendingTicks.length);
    try {
      this.db.transaction(() => {
        const stmt = this.db.prepare('INSERT INTO ticks (market, t, price) VALUES (?, ?, ?)');
        for (const tick of batch) stmt.run(tick.market, tick.time, tick.price);
      });
      return batch.length;
    } catch (err) {
      this.deps.logger.warn({ err }, 'tick flush failed');
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  /** Newest persisted ticks (oldest → newest) plus not-yet-flushed ones. */
  recentTicks(market: string, opts: { since?: number; limit?: number } = {}): TickPoint[] {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5_000);
    const rows =
      opts.since !== undefined
        ? this.db.all<{ t: number; price: number }>(
            'SELECT t, price FROM ticks WHERE market = ? AND t >= ? ORDER BY t DESC LIMIT ?',
            market,
            opts.since,
            limit,
          )
        : this.db.all<{ t: number; price: number }>(
            'SELECT t, price FROM ticks WHERE market = ? ORDER BY t DESC LIMIT ?',
            market,
            limit,
          );
    const persisted = rows.map((r) => ({ time: Number(r.t), price: Number(r.price) })).reverse();
    const lastTime = persisted.length ? persisted[persisted.length - 1].time : -Infinity;
    const pending = this.pendingTicks
      .filter((t) => t.market === market && t.time > lastTime && (opts.since === undefined || t.time >= opts.since))
      .map((t) => ({ time: t.time, price: t.price }));
    return [...persisted, ...pending].slice(-limit);
  }

  /** Price ~24 h ago (for ticker change). Cached for 5 s per market. */
  price24hAgo(market: string, now = this.deps.clock.now()): number | null {
    const cached = this.tickerCache.get(market);
    if (cached && now - cached.at < 5_000) return cached.price;
    const target = now - 24 * 3600_000;
    const row =
      this.db.get<{ price: number }>(
        'SELECT price FROM ticks WHERE market = ? AND t <= ? ORDER BY t DESC LIMIT 1',
        market,
        target,
      ) ?? this.db.get<{ price: number }>('SELECT price FROM ticks WHERE market = ? ORDER BY t ASC LIMIT 1', market);
    const buffered = this.deps.engine.recentTicks(market, 5_000, now - 24 * 3600_000);
    const price = row ? Number(row.price) : (buffered[0]?.price ?? null);
    this.tickerCache.set(market, { at: now, price });
    return price;
  }

  /** 24 h high/low from persisted ticks (cached 5 s). */
  range24h(market: string, now = this.deps.clock.now()): { high: number | null; low: number | null } {
    const cached = this.rangeCache.get(market);
    if (cached && now - cached.at < 5_000) return { high: cached.high, low: cached.low };
    const row = this.db.get<{ hi: number | null; lo: number | null }>(
      'SELECT MAX(price) AS hi, MIN(price) AS lo FROM ticks WHERE market = ? AND t >= ?',
      market,
      now - 24 * 3600_000,
    );
    let high = row?.hi === null || row?.hi === undefined ? null : Number(row.hi);
    let low = row?.lo === null || row?.lo === undefined ? null : Number(row.lo);
    // fall back to the in-memory buffer when ticks have not been flushed yet
    const buffered = this.deps.engine.recentTicks(market, 5_000, now - 24 * 3600_000);
    for (const tick of buffered) {
      high = high === null ? tick.price : Math.max(high, tick.price);
      low = low === null ? tick.price : Math.min(low, tick.price);
    }
    this.rangeCache.set(market, { at: now, high, low });
    return { high, low };
  }

  // -------------------------------------------------------------- candles

  saveCandles(market: string, tf: string, candles: Candle[]): void {
    if (!candles.length) return;
    try {
      this.db.transaction(() => {
        const stmt = this.db.prepare(
          `INSERT INTO candles (market, tf, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (market, tf, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c`,
        );
        for (const c of candles) stmt.run(market, tf, c.t, c.o, c.h, c.l, c.c);
      });
    } catch (err) {
      this.deps.logger.warn({ err, market, tf }, 'candle persist failed');
    }
  }

  flushRunningCandles(): void {
    for (const market of this.deps.engine.symbols) {
      for (const tf of TIMEFRAME_LIST) {
        const cur = this.deps.engine.currentCandle(market, tf);
        if (cur) this.saveCandles(market, tf, [cur]);
      }
    }
  }

  /** Candle history for the API: persisted closed candles + forming candle. */
  candles(
    market: string,
    tf: string,
    opts: { limit: number; before?: number; includeCurrent: boolean },
  ): {
    candles: Candle[];
    current: Candle | null;
  } {
    const rows =
      opts.before === undefined
        ? this.db.all<CandleRow>(
            `SELECT t, o, h, l, c FROM candles WHERE market = ? AND tf = ? ORDER BY t DESC LIMIT ?`,
            market,
            tf,
            opts.limit,
          )
        : this.db.all<CandleRow>(
            `SELECT t, o, h, l, c FROM candles WHERE market = ? AND tf = ? AND t < ? ORDER BY t DESC LIMIT ?`,
            market,
            tf,
            opts.before,
            opts.limit,
          );
    const candles = rows.map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c })).reverse();
    // Paging backwards must return only closed candles: the forming candle has a
    // timestamp newer than `before` and would otherwise break pagination.
    const current =
      opts.includeCurrent && opts.before === undefined ? (this.deps.engine.currentCandle(market, tf) ?? null) : null;
    if (current && candles.length && candles[candles.length - 1].t === current.t) {
      // the flush of the forming candle is not the final word - prefer the engine
      candles[candles.length - 1] = current;
    } else if (current && (!candles.length || candles[candles.length - 1].t < current.t)) {
      candles.push(current);
    }
    return { candles: candles.slice(-opts.limit), current };
  }

  // ---------------------------------------------------------- housekeeping

  prune(now = this.deps.clock.now()): { ticks: number; candles: number; audit: number; tokens: number } {
    const { config } = this.deps;
    const ticks = this.db.run('DELETE FROM ticks WHERE t < ?', now - config.TICK_RETENTION_DAYS * 86_400_000);
    const candles = this.db.run('DELETE FROM candles WHERE t < ?', now - config.CANDLE_RETENTION_DAYS * 86_400_000);
    const audit = this.db.run(
      'DELETE FROM audit_log WHERE created_at < ?',
      now - config.AUDIT_RETENTION_DAYS * 86_400_000,
    );
    const tokens = this.db.run('DELETE FROM email_tokens WHERE expires_at < ?', now - 7 * 86_400_000);
    this.tickerCache.clear();
    this.rangeCache.clear();
    const removed = { ticks: ticks.changes, candles: candles.changes, audit: audit.changes, tokens: tokens.changes };
    if (removed.ticks || removed.candles) this.deps.logger.debug(removed, 'retention prune');
    return removed;
  }
}
