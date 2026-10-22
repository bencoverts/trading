import { describe, expect, it } from 'vitest';
import { PriceEngine, type MarketConfig } from '../../src/price/engine.js';
import { SimulatedPriceFeed, MOOD_PRESETS } from '../../src/price/simulated.js';

const market = (over: Partial<MarketConfig> = {}): MarketConfig => ({
  symbol: 'DOGE',
  name: 'Dogecoin (simulated)',
  priceDecimals: 5,
  basePrice: 0.4,
  tickSize: 0.0001,
  tickIntervalMs: 100,
  mood: 'normal',
  trend: 'neutral',
  volatility: 1,
  paused: false,
  ...over,
});

/** deterministic RNG so every run is identical */
function seeded(seed = 42): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('simulated feed', () => {
  it('keeps prices positive and finite for every mood, even on cheap instruments', () => {
    for (const mood of Object.keys(MOOD_PRESETS) as Array<keyof typeof MOOD_PRESETS>) {
      const feed = new SimulatedPriceFeed({ initialPrice: 0.0002, tickSize: 0.0001, mood, rng: seeded(7) });
      let t = 0;
      for (let i = 0; i < 3_000; i++) {
        t += 100;
        const p = feed.next(t);
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic for the same seed', () => {
    const a = new SimulatedPriceFeed({ initialPrice: 100, rng: seeded(11) });
    const b = new SimulatedPriceFeed({ initialPrice: 100, rng: seeded(11) });
    const seriesA = Array.from({ length: 50 }, (_, i) => a.next(i * 100));
    const seriesB = Array.from({ length: 50 }, (_, i) => b.next(i * 100));
    expect(seriesA).toEqual(seriesB);
  });

  it('drifts up when the trend is up and down when it is down', () => {
    const up = new SimulatedPriceFeed({ initialPrice: 100, trend: 'up', rng: seeded(3), mood: 'cepat' });
    const down = new SimulatedPriceFeed({ initialPrice: 100, trend: 'down', rng: seeded(3), mood: 'cepat' });
    let t = 0;
    for (let i = 0; i < 2_000; i++) {
      t += 100;
      up.next(t);
      down.next(t);
    }
    expect(up.getPrice()).toBeGreaterThan(100);
    expect(down.getPrice()).toBeLessThan(100);
  });

  it('moves more in the "liar" mood than in "sepi"', () => {
    const range = (mood: 'sepi' | 'liar') => {
      const feed = new SimulatedPriceFeed({ initialPrice: 500, tickSize: 1, mood, rng: seeded(9) });
      let t = 0;
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 0; i < 1_500; i++) {
        t += 100;
        const p = feed.next(t);
        hi = Math.max(hi, p);
        lo = Math.min(lo, p);
      }
      return hi - lo;
    };
    expect(range('liar')).toBeGreaterThan(range('sepi'));
  });
});

describe('price engine', () => {
  const engine = () =>
    new PriceEngine({
      markets: [market(), market({ symbol: 'ASIA_COMPOSITE', priceDecimals: 2, basePrice: 6_000, tickSize: 1 })],
      now: () => 0,
      jitter: false,
      rngFactory: () => seeded(5),
    });

  it('quantises every tick to the market decimals', () => {
    const e = engine();
    const tick = e.ingest('DOGE', 0.412349123);
    expect(tick.price).toBe(0.41235);
    expect(tick.market).toBe('DOGE');
    expect(tick.seq).toBe(1);
    expect(e.ingest('ASIA_COMPOSITE', 6000.987).price).toBe(6000.99);
  });

  it('rejects invalid prices and unknown markets', () => {
    const e = engine();
    expect(() => e.ingest('DOGE', 0)).toThrow();
    expect(() => e.ingest('DOGE', Number.NaN)).toThrow();
    expect(() => e.ingest('NOPE', 1)).toThrow(/Unknown market/);
  });

  it('increases sequence numbers per market independently', () => {
    const e = engine();
    e.ingest('DOGE', 1, 1_000);
    e.ingest('DOGE', 2, 1_100);
    e.ingest('ASIA_COMPOSITE', 6_000, 1_100);
    expect(e.lastSeq('DOGE')).toBe(2);
    expect(e.lastSeq('ASIA_COMPOSITE')).toBe(1);
  });

  it('emits tick, candle and candle_closed events with server timestamps', () => {
    const e = engine();
    const ticks: number[] = [];
    const closed: Array<{ tf: string; t: number }> = [];
    e.events.on('tick', (t) => ticks.push(t.time));
    e.events.on('candle_closed', (c) => closed.push({ tf: c.tf, t: c.candle.t }));

    e.ingest('DOGE', 0.4, 1_000);
    e.ingest('DOGE', 0.401, 5_000); // crosses the 5s boundary
    expect(ticks).toEqual([1_000, 5_000]);
    expect(closed).toContainEqual({ tf: '5s', t: 0 });
    expect(e.currentCandle('DOGE', '5s')).toEqual({ t: 5_000, o: 0.401, h: 0.401, l: 0.401, c: 0.401 });
  });

  it('resolves priceAt() to the last tick at or before a timestamp', () => {
    const e = engine();
    e.ingest('DOGE', 0.4, 1_000);
    e.ingest('DOGE', 0.45, 2_000);
    e.ingest('DOGE', 0.5, 3_000);
    expect(e.priceAt('DOGE', 1_500)).toBe(0.4);
    expect(e.priceAt('DOGE', 2_000)).toBe(0.45);
    expect(e.priceAt('DOGE', 9_999)).toBe(0.5);
    expect(e.priceAt('DOGE', 500)).toBeNull();
  });

  it('supports resume only while the buffer still covers the sequence', () => {
    const e = engine();
    for (let i = 1; i <= 10; i++) e.ingest('DOGE', 0.4, i * 100);
    expect(e.canResume('DOGE', 8)).toBe(true);
    expect(e.canResume('DOGE', 10)).toBe(true);
    expect(e.ticksSince('DOGE', 7).map((t) => t.seq)).toEqual([8, 9, 10]);
    // resuming from 0 is possible while the whole history is buffered
    expect(e.canResume('DOGE', 0)).toBe(true);
  });

  it('applies admin controls to the live feed', () => {
    const e = engine();
    e.configure('DOGE', { mood: 'liar', trend: 'down', volatility: 2, paused: true });
    expect(e.getConfig('DOGE')).toMatchObject({ mood: 'liar', trend: 'down', volatility: 2, paused: true });
    expect(e.isPaused('DOGE')).toBe(true);
    expect(e.describe('DOGE')).toMatchObject({ mood: 'liar', paused: true });
  });

  it('keeps a bounded in-memory buffer and refuses resumes older than it', () => {
    const e = new PriceEngine({ markets: [market()], now: () => 0, jitter: false });
    for (let i = 1; i <= 6_000; i++) e.ingest('DOGE', 0.4, i);
    expect(e.recentTicks('DOGE', 10_000).length).toBeLessThanOrEqual(5_000);
    expect(e.canResume('DOGE', 1)).toBe(false);
    expect(e.canResume('DOGE', 5_999)).toBe(true);
  });
});
