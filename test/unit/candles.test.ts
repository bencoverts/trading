import { describe, expect, it } from 'vitest';
import { CandleAggregator, bucketStart } from '../../src/domain/candles.js';
import { TIME_FRAMES } from '../../src/domain/constants.js';

const TFS = { '5s': 5_000, '1m': 60_000 };

describe('candle aggregation', () => {
  it('aligns buckets to the timeframe boundary', () => {
    expect(bucketStart(1_000, 5_000)).toBe(0);
    expect(bucketStart(4_999, 5_000)).toBe(0);
    expect(bucketStart(5_000, 5_000)).toBe(5_000);
    expect(bucketStart(61_234, 60_000)).toBe(60_000);
  });

  it('opens a candle with the first tick and tracks OHLC', () => {
    const agg = new CandleAggregator(TFS);
    agg.apply(100, 1_000);
    agg.apply(105, 2_000);
    agg.apply(95, 3_000);
    agg.apply(101, 4_000);
    const candle = agg.getCurrent('5s');
    expect(candle).toEqual({ t: 0, o: 100, h: 105, l: 95, c: 101 });
  });

  it('closes exactly one candle when crossing a boundary', () => {
    const agg = new CandleAggregator(TFS);
    agg.apply(100, 1_000);
    agg.apply(110, 4_999);
    const crossing = agg.apply(90, 5_000);

    const closed5s = crossing.closed.filter((c) => c.tf === '5s');
    expect(closed5s).toHaveLength(1);
    // the closing candle only contains ticks that belonged to its bucket
    expect(closed5s[0].candle).toEqual({ t: 0, o: 100, h: 110, l: 100, c: 110 });
    expect(agg.getCurrent('5s')).toEqual({ t: 5_000, o: 90, h: 90, l: 90, c: 90 });
    // 1m bucket is still open (both ticks are inside 0..60s)
    expect(crossing.closed.filter((c) => c.tf === '1m')).toHaveLength(0);
    expect(agg.getCurrent('1m')).toEqual({ t: 0, o: 100, h: 110, l: 90, c: 90 });
  });

  it('closes every timeframe aligned to a shared boundary', () => {
    const agg = new CandleAggregator(TIME_FRAMES);
    agg.apply(50, 1_000);
    const res = agg.apply(51, 60_000); // exactly on the 1m boundary
    const closedTfs = res.closed.map((c) => c.tf).sort();
    expect(closedTfs).toEqual(['15s', '1m', '30s', '5s'].sort());
    // 5m/15m/1h buckets did not roll over
    expect(agg.getCurrent('5m')?.t).toBe(0);
  });

  it('ignores late ticks for an already closed bucket', () => {
    const agg = new CandleAggregator(TFS);
    agg.apply(100, 1_000);
    agg.apply(101, 5_000); // closes bucket 0
    const late = agg.apply(999, 2_000); // belongs to the closed bucket
    expect(late.updated.find((u) => u.tf === '5s')).toBeUndefined();
    expect(agg.getCurrent('5s')?.o).toBe(101);
  });

  it('keeps closed history in order and supports limit/before paging', () => {
    const agg = new CandleAggregator(TFS);
    for (let i = 0; i < 10; i++) agg.apply(100 + i, i * 5_000 + 1);
    agg.apply(200, 60_000); // close bucket at 55000

    const history = agg.getHistory('5s', 100);
    // buckets 0..45000 are closed, 60000 is still forming
    expect(history.map((c) => c.t)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000]);
    expect(history[0]).toEqual({ t: 0, o: 100, h: 100, l: 100, c: 100 });
    expect(history[history.length - 1]).toEqual({ t: 45_000, o: 109, h: 109, l: 109, c: 109 });
    expect(agg.getCurrent('5s')).toEqual({ t: 60_000, o: 200, h: 200, l: 200, c: 200 });

    const page = agg.getHistory('5s', 2, 20_000);
    expect(page).toEqual([
      { t: 10_000, o: 102, h: 102, l: 102, c: 102 },
      { t: 15_000, o: 103, h: 103, l: 103, c: 103 },
    ]);
  });

  it('seeds history without duplicating timestamps and prunes old candles', () => {
    const agg = new CandleAggregator(TFS, { maxHistory: 5 });
    agg.seed('5s', [
      { t: 0, o: 1, h: 1, l: 1, c: 1 },
      { t: 5_000, o: 2, h: 2, l: 2, c: 2 },
      { t: 5_000, o: 3, h: 3, l: 3, c: 3 },
    ]);
    expect(agg.getHistory('5s', 10)).toEqual([
      { t: 0, o: 1, h: 1, l: 1, c: 1 },
      { t: 5_000, o: 3, h: 3, l: 3, c: 3 },
    ]);
    for (let i = 0; i < 10; i++) agg.seed('5s', [{ t: 10_000 + i * 5_000, o: i, h: i, l: i, c: i }]);
    expect(agg.getHistory('5s', 100).length).toBe(5);
    // history keeps the 5 newest buckets: 35000..55000
    expect(agg.prune(40_000)).toBe(1);
    expect(agg.getHistory('5s', 100).every((c) => c.t >= 40_000)).toBe(true);
  });
});
