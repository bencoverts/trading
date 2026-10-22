export type Mood = 'sepi' | 'normal' | 'cepat' | 'liar';

export interface Tick {
  seq: number;
  symbol: string;
  price: number;
  time: number;
}

/**
 * Contract for any price source. A real broker feed can implement this later:
 * either pull-based (`next`) or push-based (`start` receives an `emit` callback).
 * The server never mixes client data into this source.
 */
export interface PriceSource {
  readonly name: string;
  /** Pull mode: called on every engine interval. */
  next?(now: number): number;
  /** Push mode: called once when the engine starts; use ctx.emit(price) on updates. */
  start?(ctx: { emit(price: number, time?: number): void; now(): number }): void | Promise<void>;
  stop?(): void | Promise<void>;
  getMood?(): Mood;
  setMood?(mood: Mood): void;
  setVolatility?(multiplier: number): void;
  /** optional: resume the source at a known price after a restart */
  setPrice?(price: number): void;
  getVolatility?(): number;
  describe?(): Record<string, unknown>;
}
