import { CandleAggregator, type Candle } from '../domain/candles.js';
import { SimulatedPriceFeed } from './simulated.js';

export interface BackfillOptions {
  symbol: string;
  timeframes: Record<string, number>;
  /** how far back to synthesise history */
  minutes: number;
  /** sampling step of the synthetic random walk */
  stepMs?: number;
  /** price the synthetic path must end at (continuity with the live feed) */
  endPrice: number;
  tickSize?: number;
  seed?: number;
  now?: () => number;
}

export interface BackfillResult {
  byTimeframe: Record<string, Candle[]>;
  tickCount: number;
  endPrice: number;
}

/** Deterministic small PRNG so backfill is reproducible in tests. */
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

/**
 * Synthesises chart history on a fresh database so the front-end is not empty.
 * The path is generated with the same engine used live and then shifted so its
 * last sample equals `endPrice` — the live feed continues seamlessly from there.
 */
export function generateBackfill(opts: BackfillOptions): BackfillResult {
  const stepMs = opts.stepMs ?? 1000;
  const total = Math.max(10, Math.floor((opts.minutes * 60_000) / stepMs));
  const rng = mulberry32(opts.seed ?? 1337);
  const feed = new SimulatedPriceFeed({
    initialPrice: opts.endPrice,
    tickSize: opts.tickSize ?? 0.1,
    rng,
    autoMood: true,
    mood: 'normal',
  });

  const now = opts.now ?? Date.now;
  const endTime = Math.floor(now() / stepMs) * stepMs;
  const startTime = endTime - total * stepMs;

  const points: Array<{ price: number; time: number }> = [];
  for (let i = 0; i < total; i++) {
    points.push({ price: feed.next(startTime + i * stepMs), time: startTime + i * stepMs });
  }
  const offset = opts.endPrice - points[points.length - 1].price;
  for (const p of points) p.price += offset;

  const agg = new CandleAggregator(opts.timeframes, { maxHistory: 5_000 });
  for (const p of points) agg.apply(Number(p.price.toFixed(4)), p.time);

  const byTimeframe: Record<string, Candle[]> = {};
  for (const tf of Object.keys(opts.timeframes)) {
    // the forming candle of each timeframe is intentionally dropped
    byTimeframe[tf] = agg.getHistory(tf, 5_000);
  }

  return { byTimeframe, tickCount: points.length, endPrice: points[points.length - 1].price };
}
