import { CandleAggregator, type Candle } from '../domain/candles.js';
import { quantizePrice } from '../domain/payout.js';
import { Emitter } from '../lib/emitter.js';
import type { Mood, PriceSource, Tick } from './types.js';

export interface PriceEngineOptions {
  symbol: string;
  source: PriceSource;
  timeframes: Record<string, number>;
  /** price decimals; every price is quantised before it leaves the engine */
  decimals: number;
  /** poll interval for pull-mode sources */
  intervalMs: number;
  jitter?: boolean;
  bufferSize?: number;
  now?: () => number;
}

export interface PriceEngineEvents {
  tick: [Tick];
  candle: [{ tf: string; candle: Candle }];
  candle_closed: [{ tf: string; candle: Candle }];
}

/**
 * Single source of truth for price in the whole application.
 *
 * The engine owns the clock: a tick's `time` is the server wall clock and is
 * never derived from a client. Every tick is written to a bounded ring buffer
 * (for seq-based resume) and folded into OHLC candles for all timeframes.
 */
export class PriceEngine {
  readonly events = new Emitter<PriceEngineEvents>();
  readonly symbol: string;
  private readonly source: PriceSource;
  private readonly aggregator: CandleAggregator;
  private readonly decimals: number;
  private readonly intervalMs: number;
  private readonly jitter: boolean;
  private readonly bufferSize: number;
  private readonly now: () => number;
  private readonly buffer: Tick[] = [];
  private seq = 0;
  private lastTick: Tick | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private startedAt: number | null = null;

  constructor(opts: PriceEngineOptions) {
    this.symbol = opts.symbol;
    this.source = opts.source;
    this.decimals = opts.decimals;
    this.intervalMs = opts.intervalMs;
    this.jitter = opts.jitter ?? true;
    this.bufferSize = opts.bufferSize ?? 20_000;
    this.now = opts.now ?? Date.now;
    this.aggregator = new CandleAggregator(opts.timeframes);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();

    if (this.source.start) {
      // push-mode adapter (e.g. a real broker websocket)
      await this.source.start({
        emit: (price, time) => this.ingest(price, time),
        now: this.now,
      });
      return;
    }
    if (!this.source.next) {
      throw new Error(`Price source "${this.source.name}" implements neither next() nor start()`);
    }
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.source.stop?.();
  }

  /**
   * Records one price observation. Used by push-mode adapters and by tests.
   * `time` defaults to the server clock and is ignored if a client ever sends it.
   */
  ingest(rawPrice: number, time?: number): Tick {
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
      throw new Error(`Invalid price from source "${this.source.name}": ${rawPrice}`);
    }
    const t = typeof time === 'number' && Number.isFinite(time) ? time : this.now();
    const price = quantizePrice(rawPrice, this.decimals);
    const tick: Tick = { seq: ++this.seq, symbol: this.symbol, price, time: t };

    this.buffer.push(tick);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    this.lastTick = tick;

    const { updated, closed } = this.aggregator.apply(price, t);
    this.events.emit('tick', tick);
    for (const u of updated) this.events.emit('candle', u);
    for (const c of closed) this.events.emit('candle_closed', c);

    return tick;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const base = this.intervalMs;
    const delay = this.jitter ? Math.max(10, Math.round(base * (0.75 + Math.random() * 0.5))) : base;
    this.timer = setTimeout(() => {
      try {
        this.ingest((this.source.next as (now: number) => number)(this.now()));
      } catch {
        /* source failure must not kill the loop; next tick retries */
      }
      this.scheduleNext();
    }, delay);
    // do not keep the process alive only for the price loop
    this.timer.unref?.();
  }

  /** Latest price (server-authoritative entry/close price for trades). */
  getLastPrice(): number | null {
    return this.lastTick ? this.lastTick.price : null;
  }

  getLastTick(): Tick | null {
    return this.lastTick ? { ...this.lastTick } : null;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get startedAtMs(): number | null {
    return this.startedAt;
  }

  /** Ticks after `seq` (for WS resume). */
  getTicksSinceSeq(seq: number, limit = 5_000): Tick[] {
    const out: Tick[] = [];
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].seq <= seq) break;
      out.push({ ...this.buffer[i] });
      if (out.length >= limit) break;
    }
    return out.reverse();
  }

  /** Can a client resume from `seq`? (only if the gap is still buffered) */
  canResumeFrom(seq: number): boolean {
    if (seq >= this.seq) return true;
    return this.buffer.length > 0 && this.buffer[0].seq <= seq + 1;
  }

  /**
   * Price of the last tick at or before `time` (server clock). Used to settle a
   * trade at its exact expiry moment instead of "whenever the loop noticed".
   */
  getPriceAt(time: number): number | null {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].time <= time) return this.buffer[i].price;
    }
    return null;
  }

  getRecentTicks(limit = 500, sinceMs?: number): Tick[] {
    const filtered = sinceMs === undefined ? this.buffer : this.buffer.filter((t) => t.time >= sinceMs);
    return filtered.slice(-limit).map((t) => ({ ...t }));
  }

  getCurrentCandle(tf: string): Candle | undefined {
    return this.aggregator.getCurrent(tf);
  }

  getCandles(tf: string, limit = 200, before?: number): Candle[] {
    return this.aggregator.getHistory(tf, limit, before);
  }

  getAllCurrentCandles(): Record<string, Candle | undefined> {
    const out: Record<string, Candle | undefined> = {};
    for (const tf of this.aggregator.timeframesList) out[tf] = this.aggregator.getCurrent(tf);
    return out;
  }

  get timeframes(): string[] {
    return this.aggregator.timeframesList;
  }

  seedHistory(tf: string, candles: Candle[]): void {
    this.aggregator.seed(tf, candles);
  }

  pruneHistory(cutoff: number): number {
    return this.aggregator.prune(cutoff);
  }

  setMood(mood: Mood): void {
    this.source.setMood?.(mood);
  }

  setVolatility(multiplier: number): void {
    this.source.setVolatility?.(multiplier);
  }

  describeSource(): Record<string, unknown> {
    return this.source.describe?.() ?? { source: this.source.name };
  }
}
