import { describe, expect, it } from 'vitest';
import { MOOD_PRESETS, SimulatedPriceFeed } from '../../src/price/simulated.js';
import { mulberry32 } from '../../src/price/backfill.js';

function stddev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

describe('SimulatedPriceFeed', () => {
  it('is deterministic for a seeded RNG', () => {
    const run = () => {
      const feed = new SimulatedPriceFeed({ initialPrice: 6200, rng: mulberry32(42), autoMood: false });
      const out: number[] = [];
      for (let i = 1; i <= 50; i++) out.push(feed.next(i * 100));
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('always produces a positive price', () => {
    const feed = new SimulatedPriceFeed({ initialPrice: 2, tickSize: 5, rng: mulberry32(7), mood: 'liar', autoMood: false });
    for (let i = 1; i < 5_000; i++) {
      const p = feed.next(i * 100);
      expect(p).toBeGreaterThan(0);
      expect(Number.isFinite(p)).toBe(true);
    }
  });

  it('makes wilder moods more volatile than quiet ones', () => {
    const deltas = (mood: 'sepi' | 'liar') => {
      const feed = new SimulatedPriceFeed({ initialPrice: 100, rng: mulberry32(9), mood, autoMood: false, tickSize: 0.1 });
      let prev = feed.next(0);
      const out: number[] = [];
      for (let i = 1; i <= 4_000; i++) {
        const p = feed.next(i * 100);
        out.push(p - prev);
        prev = p;
      }
      return stddev(out);
    };

    const quiet = deltas('sepi');
    const wild = deltas('liar');
    expect(quiet).toBeGreaterThan(0);
    expect(wild).toBeGreaterThan(quiet * 3);
  });

  it('scales with the volatility multiplier', () => {
    const feed = new SimulatedPriceFeed({ initialPrice: 100, rng: mulberry32(3), autoMood: false, volatility: 1 });
    const calm: number[] = [];
    for (let i = 1; i <= 2_000; i++) calm.push(feed.next(i * 100));
    feed.setVolatility(4);
    const stormy: number[] = [];
    for (let i = 2_001; i <= 4_000; i++) stormy.push(feed.next(i * 100));

    const toDeltas = (xs: number[]) => xs.slice(1).map((v, i) => v - xs[i]);
    expect(stddev(toDeltas(stormy))).toBeGreaterThan(stddev(toDeltas(calm)) * 2);
    expect(feed.getVolatility()).toBe(4);
  });

  it('respects a manually selected mood and exposes it', () => {
    const feed = new SimulatedPriceFeed({ initialPrice: 100, rng: mulberry32(1), autoMood: true });
    feed.next(0);
    feed.setMood('liar');
    expect(feed.getMood()).toBe('liar');
    expect(feed.describe()).toMatchObject({ source: 'simulated', mood: 'liar' });
  });

  it('rotates moods automatically over time', () => {
    const feed = new SimulatedPriceFeed({ initialPrice: 100, rng: mulberry32(11), autoMood: true });
    feed.next(0);
    const seen = new Set<string>();
    for (let t = 100; t < 200_000; t += 100) {
      feed.next(t);
      seen.add(feed.getMood());
    }
    expect(seen.size).toBeGreaterThan(1);
    for (const mood of seen) expect(Object.keys(MOOD_PRESETS)).toContain(mood);
  });

  it('can be resumed at an arbitrary price', () => {
    const feed = new SimulatedPriceFeed({ initialPrice: 6_000, rng: mulberry32(5) });
    feed.next(0);
    feed.setPrice(7_777);
    expect(feed.next(100)).toBeCloseTo(7_777, 0);
  });
});
