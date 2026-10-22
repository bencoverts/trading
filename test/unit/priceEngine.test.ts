import { describe, expect, it } from 'vitest';
import { PriceEngine } from '../../src/price/engine.js';
import type { PriceSource, Tick } from '../../src/price/types.js';

function makeEngine(opts: { timeframes?: Record<string, number>; decimals?: number; source?: PriceSource } = {}) {
  const engine = new PriceEngine({
    symbol: 'TEST',
    source: opts.source ?? { name: 'manual', next: () => 100 },
    timeframes: opts.timeframes ?? { '5s': 5_000, '1m': 60_000 },
    decimals: opts.decimals ?? 2,
    intervalMs: 100,
    jitter: false,
    bufferSize: 50,
  });
  return engine;
}

const base = 1_699_999_800_000; // divisible by 5000, 60000 and 300000

describe('PriceEngine', () => {
  it('assigns increasing sequence numbers and keeps the latest price', () => {
    const engine = makeEngine();
    const t1 = engine.ingest(100.123, base);
    const t2 = engine.ingest(100.987, base + 100);

    expect(t1.seq).toBe(1);
    expect(t2.seq).toBe(2);
    expect(engine.lastSeq).toBe(2);
    expect(engine.getLastPrice()).toBe(100.99);
    expect(engine.getLastTick()?.time).toBe(base + 100);
  });

  it('quantises prices to the configured decimals', () => {
    const engine = makeEngine({ decimals: 3 });
    const tick = engine.ingest(6204.56789, base);
    expect(tick.price).toBe(6204.568);
  });

  it('rejects non-finite or non-positive prices', () => {
    const engine = makeEngine();
    expect(() => engine.ingest(Number.NaN, base)).toThrow();
    expect(() => engine.ingest(0, base)).toThrow();
    expect(() => engine.ingest(-5, base)).toThrow();
  });

  it('emits tick and running candle events', () => {
    const engine = makeEngine();
    const ticks: Tick[] = [];
    const candles: any[] = [];
    engine.events.on('tick', (t) => ticks.push(t));
    engine.events.on('candle', (c) => candles.push(c));

    engine.ingest(100, base);
    engine.ingest(102, base + 1_000);

    expect(ticks).toHaveLength(2);
    expect(candles).toHaveLength(4); // 2 ticks x 2 timeframes
    expect(engine.getCurrentCandle('5s')).toEqual({ t: base, o: 100, h: 102, l: 100, c: 102 });
    expect(engine.getCurrentCandle('1m')).toEqual({ t: base, o: 100, h: 102, l: 100, c: 102 });
  });

  it('closes exactly one 5s candle when crossing a bucket, keeping 1m open', () => {
    const engine = makeEngine();
    const closed: any[] = [];
    engine.events.on('candle_closed', (c) => closed.push(c));

    engine.ingest(100, base + 1_000);
    engine.ingest(101, base + 4_999);
    expect(closed).toHaveLength(0);

    engine.ingest(99, base + 5_000);

    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({ tf: '5s', candle: { t: base, o: 100, h: 101, l: 100, c: 101 } });
    expect(engine.getCurrentCandle('5s')).toEqual({ t: base + 5_000, o: 99, h: 99, l: 99, c: 99 });
    expect(engine.getCurrentCandle('1m')?.t).toBe(base);
    expect(engine.getCandles('5s')).toHaveLength(1);
  });

  it('ignores late ticks that belong to an already closed bucket', () => {
    const engine = makeEngine();
    engine.ingest(100, base);
    engine.ingest(101, base + 5_000); // closes [base, base+5000)
    engine.ingest(999, base + 1_000); // late, same bucket already closed

    expect(engine.getCurrentCandle('5s')).toEqual({ t: base + 5_000, o: 101, h: 101, l: 101, c: 101 });
    // the closed candle keeps the value it had when it closed
    expect(engine.getCandles('5s')[0]).toEqual({ t: base, o: 100, h: 100, l: 100, c: 100 });
  });

  it('answers getPriceAt with the last tick at or before the instant', () => {
    const engine = makeEngine();
    engine.ingest(100, base);
    engine.ingest(105, base + 1_000);

    expect(engine.getPriceAt(base + 500)).toBe(100);
    expect(engine.getPriceAt(base + 1_000)).toBe(105);
    expect(engine.getPriceAt(base - 1)).toBeNull();
    expect(engine.getPriceAt(base + 10_000)).toBe(105);
  });

  it('supports sequence based resume from the ring buffer', () => {
    const engine = makeEngine({ timeframes: { '5s': 5_000 } });
    for (let i = 0; i < 5; i++) engine.ingest(100 + i, base + i * 1_000);

    expect(engine.getTicksSinceSeq(2).map((t) => t.seq)).toEqual([3, 4, 5]);
    expect(engine.canResumeFrom(2)).toBe(true);
    expect(engine.canResumeFrom(5)).toBe(true);
    expect(engine.canResumeFrom(999)).toBe(true);

    // overflow the 50-tick buffer -> very old sequence numbers cannot resume
    for (let i = 0; i < 80; i++) engine.ingest(200 + i, base + 6_000 + i * 100);
    expect(engine.canResumeFrom(1)).toBe(false);
    expect(engine.canResumeFrom(engine.lastSeq)).toBe(true);
  });

  it('caps the tick ring buffer but keeps the newest ticks', () => {
    const engine = makeEngine({ timeframes: { '5s': 5_000 } });
    for (let i = 0; i < 120; i++) engine.ingest(100 + i, base + i * 10);
    const recent = engine.getRecentTicks(1_000);
    expect(recent).toHaveLength(50);
    expect(recent[recent.length - 1].price).toBe(219);
  });

  it('pulls prices from a source on an interval and stops cleanly', async () => {
    let i = 0;
    const source: PriceSource = { name: 'pull', next: () => 100 + i++ };
    const engine = makeEngine({ source });
    await engine.start();
    await new Promise((r) => setTimeout(r, 350));
    await engine.stop();

    expect(engine.lastSeq).toBeGreaterThan(1);
    const seqAfterStop = engine.lastSeq;
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.lastSeq).toBe(seqAfterStop);
  });

  it('accepts pushed prices from a push-mode adapter', async () => {
    const holder: { emit?: (price: number, time?: number) => void } = {};
    const source: PriceSource = {
      name: 'push',
      start: (ctx) => {
        holder.emit = ctx.emit;
      },
    };
    const engine = makeEngine({ source });
    await engine.start();
    expect(engine.getLastPrice()).toBeNull();
    holder.emit?.(321.5);
    expect(engine.getLastPrice()).toBe(321.5);
    await engine.stop();
  });
});
