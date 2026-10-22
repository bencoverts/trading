export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface CandleCloseEvent {
  tf: string;
  candle: Candle;
}

export const TIMEFRAMES = { '5s': 5_000, '15s': 15_000, '30s': 30_000, '1m': 60_000, '5m': 300_000 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;

export function bucketStart(time: number, tfMs: number): number {
  return Math.floor(time / tfMs) * tfMs;
}

/**
 * Server-side OHLC aggregation for every supported timeframe.
 * One tick updates all timeframes; a tick crossing a bucket boundary emits
 * exactly one `candle_closed` for that timeframe (never dropped).
 */
export class CandleAggregator {
  private current = new Map<string, Candle>();
  private history = new Map<string, Candle[]>();
  private readonly maxHistory: number;

  constructor(
    private readonly timeframes: Record<string, number>,
    opts: { maxHistory?: number; now?: () => number } = {},
  ) {
    this.maxHistory = opts.maxHistory ?? 3_000;
    for (const tf of Object.keys(this.timeframes)) {
      this.current.set(tf, undefined as unknown as Candle);
      this.history.set(tf, []);
    }
  }

  /** Bucket size in ms, or undefined for unsupported timeframe. */
  tfMs(tf: string): number | undefined {
    return this.timeframes[tf];
  }

  get timeframesList(): string[] {
    return Object.keys(this.timeframes);
  }

  /**
   * Applies one server tick.
   * @returns the current (possibly just opened) candle per timeframe and the
   *          candles that just closed, in timeframe declaration order.
   */
  apply(price: number, time: number): { updated: Array<{ tf: string; candle: Candle }>; closed: CandleCloseEvent[] } {
    const updated: Array<{ tf: string; candle: Candle }> = [];
    const closed: CandleCloseEvent[] = [];

    for (const [tf, tfMs] of Object.entries(this.timeframes)) {
      const bucket = bucketStart(time, tfMs);
      const cur = this.current.get(tf);

      if (!cur || cur.t < bucket) {
        if (cur) {
          closed.push({ tf, candle: { ...cur } });
          this.pushHistory(tf, cur);
        }
        const fresh: Candle = { t: bucket, o: price, h: price, l: price, c: price };
        this.current.set(tf, fresh);
        updated.push({ tf, candle: { ...fresh } });
        continue;
      }

      // Out-of-order tick for an already closed bucket: ignore for this timeframe.
      if (cur.t > bucket) continue;

      if (price > cur.h) cur.h = price;
      if (price < cur.l) cur.l = price;
      cur.c = price;
      updated.push({ tf, candle: { ...cur } });
    }

    return { updated, closed };
  }

  private pushHistory(tf: string, candle: Candle): void {
    const arr = this.history.get(tf) as Candle[];
    const last = arr[arr.length - 1];
    if (last && last.t >= candle.t) return;
    arr.push({ ...candle });
    if (arr.length > this.maxHistory) arr.splice(0, arr.length - this.maxHistory);
  }

  /** Current forming candle (a copy) or undefined before the first tick. */
  getCurrent(tf: string): Candle | undefined {
    const c = this.current.get(tf);
    return c ? { ...c } : undefined;
  }

  /** Closed candles, oldest first. */
  getHistory(tf: string, limit = 200, before?: number): Candle[] {
    const arr = this.history.get(tf) ?? [];
    const filtered = before === undefined ? arr : arr.filter((c) => c.t < before);
    return filtered.slice(-limit).map((c) => ({ ...c }));
  }

  /** Seeds history (used on boot to merge persisted candles back into memory). */
  seed(tf: string, candles: Candle[]): void {
    const arr = this.history.get(tf) ?? [];
    const byT = new Map<number, Candle>();
    for (const c of arr) byT.set(c.t, c);
    for (const c of candles) byT.set(c.t, { ...c });
    const merged = [...byT.values()].sort((a, b) => a.t - b.t);
    this.history.set(tf, merged.slice(-this.maxHistory));
  }

  /** Drops history older than `cutoff` (ms). */
  prune(cutoff: number): number {
    let removed = 0;
    for (const [tf, arr] of this.history) {
      const kept = arr.filter((c) => c.t >= cutoff);
      removed += arr.length - kept.length;
      this.history.set(tf, kept);
    }
    return removed;
  }
}
