import type { Mood, PriceSource } from './types.js';

export interface MoodPreset {
  /** short-term shock amplitude multiplier */
  volatility: number;
  /** how strongly previous momentum carries over (0..1) */
  momentumDecay: number;
  /** gaussian shock scale (normalised units) */
  shock: number;
  /** slow trend influence */
  trendStrength: number;
  minSec: number;
  maxSec: number;
  label: string;
}

/**
 * Mood presets ported from the "sepi / normal / cepat / liar" concept of the
 * original client-side random feed (randomFeed.js):
 *  - sepi   : quiet, thin, low amplitude
 *  - normal : baseline market
 *  - cepat  : fast but not extreme (more momentum persistence)
 *  - liar   : wild spikes, rallies and dumps
 */
export const MOOD_PRESETS: Record<Mood, MoodPreset> = {
  sepi: { volatility: 0.35, momentumDecay: 0.86, shock: 0.28, trendStrength: 0.1, minSec: 20, maxSec: 45, label: 'Quiet' },
  normal: { volatility: 1, momentumDecay: 0.9, shock: 0.5, trendStrength: 0.18, minSec: 18, maxSec: 40, label: 'Normal' },
  cepat: { volatility: 1.3, momentumDecay: 0.94, shock: 0.5, trendStrength: 0.35, minSec: 12, maxSec: 28, label: 'Fast' },
  liar: { volatility: 1.6, momentumDecay: 0.95, shock: 0.9, trendStrength: 0.7, minSec: 8, maxSec: 18, label: 'Wild' },
};

const MOOD_WEIGHTS: Array<[Mood, number]> = [
  ['sepi', 0.2],
  ['normal', 0.45],
  ['cepat', 0.22],
  ['liar', 0.13],
];

export interface SimulatedFeedOptions {
  initialPrice: number;
  /** base step in price points for a "normal" tick */
  tickSize?: number;
  /** global multiplier applied on top of mood volatility */
  volatility?: number;
  mood?: Mood;
  /** automatically rotate the mood every mood window */
  autoMood?: boolean;
  /** injectable RNG for deterministic tests */
  rng?: () => number;
}

export class SimulatedPriceFeed implements PriceSource {
  readonly name = 'simulated';
  private price: number;
  private readonly tickSize: number;
  private volatilityMultiplier: number;
  private mood: Mood;
  private readonly autoMood: boolean;
  private readonly rng: () => number;
  private momentum = 0;
  private trend = 0;
  private trendTarget = 0;
  private moodUntil = 0;
  private trendUntil = 0;
  private lastTime: number | null = null;

  constructor(opts: SimulatedFeedOptions) {
    this.price = opts.initialPrice;
    this.tickSize = opts.tickSize ?? 0.1;
    this.volatilityMultiplier = opts.volatility ?? 1;
    this.mood = opts.mood ?? 'normal';
    this.autoMood = opts.autoMood ?? true;
    this.rng = opts.rng ?? Math.random;
  }

  getMood(): Mood {
    return this.mood;
  }

  setMood(mood: Mood): void {
    this.mood = mood;
    this.moodUntil = (this.lastTime ?? Date.now()) + this.randomBetween(MOOD_PRESETS[mood].minSec, MOOD_PRESETS[mood].maxSec);
  }

  getVolatility(): number {
    return this.volatilityMultiplier;
  }

  setVolatility(multiplier: number): void {
    this.volatilityMultiplier = Math.max(0.01, multiplier);
  }

  getPrice(): number {
    return this.price;
  }

  setPrice(price: number): void {
    this.price = price;
  }

  describe(): Record<string, unknown> {
    return {
      source: this.name,
      mood: this.mood,
      volatility: this.volatilityMultiplier,
      tickSize: this.tickSize,
      autoMood: this.autoMood,
      momentum: Number(this.momentum.toFixed(4)),
      trend: Number(this.trend.toFixed(4)),
    };
  }

  /** Generates the next price for the given server timestamp. */
  next(now: number): number {
    const preset = MOOD_PRESETS[this.mood];
    if (this.lastTime === null) {
      this.lastTime = now;
      this.moodUntil = now + this.randomBetween(preset.minSec, preset.maxSec) * 1000;
      this.trendTarget = this.gauss() * 0.5;
      this.trendUntil = now + this.randomBetween(20, 60) * 1000;
      return this.price;
    }

    const dt = Math.min(2000, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    if (dt === 0) return this.price;
    const step = dt / 100; // normalised to the 100ms design interval

    // --- mood rotation ---------------------------------------------------
    if (this.autoMood && now >= this.moodUntil) {
      this.mood = this.pickMood();
      const nextPreset = MOOD_PRESETS[this.mood];
      this.moodUntil = now + this.randomBetween(nextPreset.minSec, nextPreset.maxSec) * 1000;
    }

    // --- slow trend ------------------------------------------------------
    if (now >= this.trendUntil) {
      this.trendTarget = (this.rng() * 2 - 1) * 1.6;
      this.trendUntil = now + this.randomBetween(20, 70) * 1000;
    }
    this.trend += (this.trendTarget - this.trend) * Math.min(0.4, 0.01 * step);

    // --- momentum (EMA of gaussian shocks) --------------------------------
    const decay = Math.pow(preset.momentumDecay, step);
    this.momentum = this.momentum * decay + this.gauss() * preset.shock * Math.sqrt(step);

    const scale = this.tickSize * this.volatilityMultiplier;
    const delta = (this.momentum * preset.volatility + this.trend * preset.trendStrength) * scale;

    this.price = Math.max(1, this.price + delta);
    return this.price;
  }

  private pickMood(): Mood {
    const total = MOOD_WEIGHTS.reduce((s, [, w]) => s + w, 0);
    let r = this.rng() * total;
    for (const [mood, w] of MOOD_WEIGHTS) {
      r -= w;
      if (r <= 0) return mood;
    }
    return 'normal';
  }

  private randomBetween(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }

  /** Box-Muller standard normal, bounded to avoid absurd outliers. */
  private gauss(): number {
    const u = Math.max(1e-9, this.rng());
    const v = this.rng();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(-4, Math.min(4, n));
  }
}
