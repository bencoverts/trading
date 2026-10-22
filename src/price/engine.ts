import { CandleAggregator, type Candle } from '../domain/candles.js';
import { quantizePrice } from '../domain/payout.js';
import { TIME_FRAMES, type Mood, type TrendDirection } from '../domain/constants.js';
import { Emitter } from '../lib/emitter.js';
import { SimulatedPriceFeed } from './simulated.js';

export interface MarketConfig {
  symbol: string;
  name: string;
  priceDecimals: number;
  basePrice: number;
  tickSize: number;
  tickIntervalMs: number;
  mood: Mood;
  trend: TrendDirection;
  volatility: number;
  paused: boolean;
}

export interface Tick {
  market: string;
  seq: number;
  price: number;
  time: number;
}

export interface EngineEvents {
  tick: [Tick];
  candle: [{ market: string; tf: string; candle: Candle; seq: number }];
  candle_closed: [{ market: string; tf: string; candle: Candle; seq: number }];
}

interface MarketRuntime {
  config: MarketConfig;
  feed: SimulatedPriceFeed;
  candles: CandleAggregator;
  buffer: Tick[];
  seq: number;
  lastTick: Tick | null;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number | null;
}

export interface PriceEngineOptions {
  markets: MarketConfig[];
  bufferSize?: number;
  now?: () => number;
  jitter?: boolean;
  /** injectable RNG factory (tests) */
  rngFactory?: (symbol: string) => () => number;
}

const MAX_BUFFER = 5_000;

/**
 * One price engine for the whole process, one independent simulated source per
 * market. Timestamps always come from the injected server clock.
 */
export class PriceEngine {
  readonly events = new Emitter<EngineEvents>();
  private readonly markets = new Map<string, MarketRuntime>();
  private readonly now: () => number;
  private readonly jitter: boolean;
  private running = false;

  constructor(private readonly opts: PriceEngineOptions) {
    this.now = opts.now ?? Date.now;
    this.jitter = opts.jitter ?? true;
    for (const config of opts.markets) {
      const feed = new SimulatedPriceFeed({
        initialPrice: config.basePrice,
        tickSize: config.tickSize,
        mood: config.mood,
        trend: config.trend,
        volatility: config.volatility,
        rng: opts.rngFactory?.(config.symbol),
      });
      this.markets.set(config.symbol, {
        config: { ...config },
        feed,
        candles: new CandleAggregator(TIME_FRAMES),
        buffer: [],
        seq: 0,
        lastTick: null,
        timer: null,
        startedAt: null,
      });
    }
  }

  /** Registers a market at runtime (admin creates one); no-op when it exists. */
  addMarket(config: MarketConfig): void {
    if (this.markets.has(config.symbol)) return;
    const feed = new SimulatedPriceFeed({
      initialPrice: config.basePrice,
      tickSize: config.tickSize,
      mood: config.mood,
      trend: config.trend,
      volatility: config.volatility,
      rng: this.opts.rngFactory?.(config.symbol),
    });
    this.markets.set(config.symbol, {
      config: { ...config },
      feed,
      candles: new CandleAggregator(TIME_FRAMES),
      buffer: [],
      seq: 0,
      lastTick: null,
      timer: null,
      startedAt: null,
    });
    if (this.running) this.schedule(config.symbol);
  }

  /** Stops and forgets a market (soft-deleted by an admin). */
  removeMarket(symbol: string): void {
    const rt = this.markets.get(symbol);
    if (!rt) return;
    if (rt.timer) clearTimeout(rt.timer);
    this.markets.delete(symbol);
  }

  get symbols(): string[] {
    return [...this.markets.keys()];
  }

  has(symbol: string): boolean {
    return this.markets.has(symbol);
  }

  getConfig(symbol: string): MarketConfig | undefined {
    const rt = this.markets.get(symbol);
    return rt ? { ...rt.config } : undefined;
  }

  listConfigs(): MarketConfig[] {
    return [...this.markets.values()].map((m) => ({ ...m.config }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const symbol of this.markets.keys()) this.schedule(symbol);
  }

  stop(): void {
    this.running = false;
    for (const rt of this.markets.values()) {
      if (rt.timer) clearTimeout(rt.timer);
      rt.timer = null;
    }
  }

  private schedule(symbol: string): void {
    const rt = this.markets.get(symbol);
    if (!rt || !this.running) return;
    const base = rt.config.tickIntervalMs;
    const delay = this.jitter ? Math.max(10, Math.round(base * (0.75 + Math.random() * 0.5))) : base;
    rt.timer = setTimeout(() => {
      try {
        if (!rt.config.paused) this.ingest(symbol, rt.feed.next(this.now()));
      } catch {
        /* a feed failure must not kill the loop */
      }
      this.schedule(symbol);
    }, delay);
    rt.timer.unref?.();
  }

  /** Records one price observation (also used by tests and push adapters). */
  ingest(symbol: string, rawPrice: number, time?: number): Tick {
    const rt = this.markets.get(symbol);
    if (!rt) throw new Error(`Unknown market: ${symbol}`);
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
      throw new Error(`Invalid price for ${symbol}: ${rawPrice}`);
    }
    const t = typeof time === 'number' && Number.isFinite(time) ? time : this.now();
    const price = quantizePrice(rawPrice, rt.config.priceDecimals);
    const tick: Tick = { market: symbol, seq: ++rt.seq, price, time: t };

    rt.buffer.push(tick);
    if (rt.buffer.length > MAX_BUFFER) rt.buffer.splice(0, rt.buffer.length - MAX_BUFFER);
    rt.lastTick = tick;

    const { updated, closed } = rt.candles.apply(price, t);
    this.events.emit('tick', tick);
    for (const u of updated) this.events.emit('candle', { market: symbol, tf: u.tf, candle: u.candle, seq: rt.seq });
    for (const c of closed)
      this.events.emit('candle_closed', { market: symbol, tf: c.tf, candle: c.candle, seq: rt.seq });
    return tick;
  }

  lastPrice(symbol: string): number | null {
    const rt = this.markets.get(symbol);
    return rt?.lastTick ? rt.lastTick.price : null;
  }

  lastTick(symbol: string): Tick | null {
    const rt = this.markets.get(symbol);
    return rt?.lastTick ? { ...rt.lastTick } : null;
  }

  lastSeq(symbol: string): number {
    return this.markets.get(symbol)?.seq ?? 0;
  }

  /**
   * Price of the last tick at or before `time`. Returns null when the market has
   * no data for that instant (the caller must then treat the outcome as unknown).
   */
  priceAt(symbol: string, time: number): number | null {
    const rt = this.markets.get(symbol);
    if (!rt) return null;
    for (let i = rt.buffer.length - 1; i >= 0; i--) {
      if (rt.buffer[i].time <= time) return rt.buffer[i].price;
    }
    return null;
  }

  ticksSince(symbol: string, seq: number, limit = 1_000): Tick[] {
    const rt = this.markets.get(symbol);
    if (!rt) return [];
    const out: Tick[] = [];
    for (let i = rt.buffer.length - 1; i >= 0; i--) {
      if (rt.buffer[i].seq <= seq) break;
      out.push({ ...rt.buffer[i] });
      if (out.length >= limit) break;
    }
    return out.reverse();
  }

  canResume(symbol: string, seq: number): boolean {
    const rt = this.markets.get(symbol);
    if (!rt) return false;
    if (seq >= rt.seq) return true;
    return rt.buffer.length > 0 && rt.buffer[0].seq <= seq + 1;
  }

  recentTicks(symbol: string, limit = 500, since?: number): Tick[] {
    const rt = this.markets.get(symbol);
    if (!rt) return [];
    const filtered = since === undefined ? rt.buffer : rt.buffer.filter((t) => t.time >= since);
    return filtered.slice(-limit).map((t) => ({ ...t }));
  }

  currentCandle(symbol: string, tf: string): Candle | undefined {
    return this.markets.get(symbol)?.candles.getCurrent(tf);
  }

  candles(symbol: string, tf: string, limit = 300, before?: number): Candle[] {
    return this.markets.get(symbol)?.candles.getHistory(tf, limit, before) ?? [];
  }

  seedCandles(symbol: string, tf: string, candles: Candle[]): void {
    this.markets.get(symbol)?.candles.seed(tf, candles);
  }

  /** Applies admin configuration to the live feed (trend, mood, volatility, pause). */
  configure(symbol: string, patch: Partial<Pick<MarketConfig, 'mood' | 'trend' | 'volatility' | 'paused'>>): void {
    const rt = this.markets.get(symbol);
    if (!rt) return;
    if (patch.mood !== undefined) {
      rt.config.mood = patch.mood;
      rt.feed.setMood(patch.mood);
    }
    if (patch.trend !== undefined) {
      rt.config.trend = patch.trend;
      rt.feed.setTrend(patch.trend);
    }
    if (patch.volatility !== undefined) {
      rt.config.volatility = patch.volatility;
      rt.feed.setVolatility(patch.volatility);
    }
    if (patch.paused !== undefined) rt.config.paused = patch.paused;
  }

  setPrice(symbol: string, price: number): void {
    this.markets.get(symbol)?.feed.setPrice(price);
  }

  isPaused(symbol: string): boolean {
    return this.markets.get(symbol)?.config.paused ?? true;
  }

  describe(symbol: string): Record<string, unknown> {
    const rt = this.markets.get(symbol);
    if (!rt) return {};
    return { ...rt.feed.describe(), paused: rt.config.paused, seq: rt.seq, lastPrice: rt.lastTick?.price ?? null };
  }
}
