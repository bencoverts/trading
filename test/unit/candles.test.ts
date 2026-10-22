import { describe, expect, it } from 'vitest';
import { bucketStart, CandleAggregator } from '../../src/domain/candles.js';

const TFS = { '5s': 5_000, '15s': 15_000, '1m': 60_000 };
// divisible by every timeframe (LCM = 300_000 ms) so boundaries are unambiguous
const T0 = 1_699_999_800_000;

describe('bucketStart', () => {
  it('aligns timestamps down to the timeframe boundary', () => {
    expect(bucketStart(T0 + 3_456, 5_000)).toBe(T0);
    expect(bucketStart(T0 + 7_999, 15_000)).toBe(T0);
    expect(bucketStart(T0 + 16_000, 15_000)).toBe(T0 + 15_000);
    expect(bucketStart(T0 + 299_999, 300_000)).toBe(T0);
  });
});

describe('CandleAggregator', () => {
  it('builds OHLC per timeframe from a single tick stream', () => {
    const agg = new CandleAggregator(TFS);
    const t0 = T0;
    agg.apply(100, t0);
    agg.apply(104, t0 + 1_000);
    agg.apply(98, t0 + 2_000);

    expect(agg.getCurrent('5s')).toEqual({ t: t0, o: 100, h: 104, l: 98, c: 98 });
    expect(agg.getCurrent('15s')).toEqual({ t: t0, o: 100, h: 104, l: 98, c: 98 });
    expect(agg.getCurrent('1m')?.t).toBe(t0);
  });

  it('closes a candle per timeframe at its own boundary', () => {
    const agg = new CandleAggregator(TFS);
    const t0 = T0;
    agg.apply(100, t0);
    const r1 = agg.apply(101, t0 + 5_000);
    expect(r1.closed.map((c) => c.tf)).toEqual(['5s']);

    const r2 = agg.apply(102, t0 + 15_000);
    expect(r2.closed.map((c) => c.tf).sort()).toEqual(['15s', '5s']);

    const r3 = agg.apply(103, t0 + 60_000);
    expect(r3.closed.map((c) => c.tf).sort()).toEqual(['15s', '1m', '5s']);
  });

  it('keeps closed history in chronological order with a bounded size', () => {
    const agg = new CandleAggregator({ '5s': 5_000 }, { maxHistory: 3 });
    const t0 = T0;
    for (let i = 0; i < 10; i++) agg.apply(100 + i, t0 + i * 5_000);

    const history = agg.getHistory('5s', 100);
    expect(history).toHaveLength(3);
    expect(history.map((c) => c.t)).toEqual([t0 + 30_000, t0 + 35_000, t0 + 40_000]);
    expect(agg.getCurrent('5s')?.c).toBe(109);
  });

  it('respects limit and before filters', () => {
    const agg = new CandleAggregator({ '5s': 5_000 });
    const t0 = T0;
    for (let i = 0; i < 8; i++) agg.apply(100 + i, t0 + i * 5_000);

    // bucket 7 is still forming, so the last two closed candles are 105 and 106
    expect(agg.getHistory('5s', 2).map((c) => c.c)).toEqual([105, 106]);
    expect(agg.getHistory('5s', 100, t0 + 20_000).map((c) => c.t)).toEqual([
      t0,
      t0 + 5_000,
      t0 + 10_000,
      t0 + 15_000,
    ]);
  });

  it('seeds history without duplicating candles', () => {
    const agg = new CandleAggregator({ '5s': 5_000 });
    agg.seed('5s', [
      { t: 1_000, o: 1, h: 2, l: 1, c: 2 },
      { t: 6_000, o: 2, h: 3, l: 2, c: 3 },
    ]);
    agg.seed('5s', [
      { t: 6_000, o: 0, h: 0, l: 0, c: 0 },
      { t: 11_000, o: 3, h: 4, l: 3, c: 4 },
    ]);

    expect(agg.getHistory('5s', 10).map((c) => c.t)).toEqual([1_000, 6_000, 11_000]);
    expect(agg.getHistory('5s', 10)[1].c).toBe(0);
  });

  it('prunes history older than a cutoff', () => {
    const agg = new CandleAggregator({ '5s': 5_000 });
    for (let i = 0; i < 5; i++) agg.apply(100 + i, i * 5_000 + 100);
    const removed = agg.prune(10_000);
    expect(removed).toBe(2);
    expect(agg.getHistory('5s', 10).map((c) => c.t)).toEqual([10_000, 15_000]);
  });

  it('returns copies so callers cannot mutate internal state', () => {
    const agg = new CandleAggregator({ '5s': 5_000 });
    agg.apply(100, 0);
    const current = agg.getCurrent('5s');
    if (current) current.c = 999;
    expect(agg.getCurrent('5s')?.c).toBe(100);
  });
});
