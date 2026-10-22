import type { Mood, TrendDirection } from '../domain/constants.js';

export interface MoodPreset {
  volatility: number;
  momentumDecay: number;
  shock: number;
  /** how strongly the admin trend direction biases the walk */
  trendStrength: number;
  label: string;
}

/**
 * Mood presets used by the simulated feed:
 *  - sepi   quiet market, thin movements
 *  - normal baseline
 *  - cepat  faster, more momentum persistence
 *  - liar   wild spikes and dumps
 */
export const MOOD_PRESETS: Record<Mood, MoodPreset> = {
  sepi: { volatility: 0.35, momentumDecay: 0.86, shock: 0.28, trendStrength: 0.25, label: 'Quiet' },
  normal: { volatility: 1, momentumDecay: 0.9, shock: 0.5, trendStrength: 0.6, label: 'Normal' },
  cepat: { volatility: 1.3, momentumDecay: 0.94, shock: 0.5, trendStrength: 0.9, label: 'Fast' },
  liar: { volatility: 1.7, momentumDecay: 0.95, shock: 0.9, trendStrength: 1.4, label: 'Wild' },
};

export interface SimulatedFeedOptions {
  initialPrice: number;
  /** base step in price points for a "normal" tick */
  tickSize?: number;
  volatility?: number;
  mood?: Mood;
  trend?: TrendDirection;
  rng?: () => number;
}

/**
 * Random-walk price source with momentum, a slow trend and admin controls.
 * Deterministic for a seeded RNG (used in tests).
 */
export class SimulatedPriceFeed {
  private price: number;
  private readonly tickSize: number;
  private volatilityMultiplier: number;
  private mood: Mood;
  private trend: TrendDirection;
  private readonly rng: () => number;
  private momentum = 0;
  private drift = 0;
  private driftTarget = 0;
  private lastTime: number | null = null;
  private driftUntil = 0;

  constructor(opts: SimulatedFeedOptions) {
    this.price = opts.initialPrice;
    this.tickSize = opts.tickSize ?? 0.1;
    this.volatilityMultiplier = opts.volatility ?? 1;
    this.mood = opts.mood ?? 'normal';
    this.trend = opts.trend ?? 'neutral';
    this.rng = opts.rng ?? Math.random;
  }

  getPrice(): number {
    return this.price;
  }

  setPrice(price: number): void {
    this.price = price;
  }

  getMood(): Mood {
    return this.mood;
  }

  setMood(mood: Mood): void {
    this.mood = mood;
  }

  getTrend(): TrendDirection {
    return this.trend;
  }

  setTrend(trend: TrendDirection): void {
    this.trend = trend;
    this.driftTarget = this.randomDrift();
  }

  getVolatility(): number {
    return this.volatilityMultiplier;
  }

  setVolatility(multiplier: number): void {
    this.volatilityMultiplier = Math.max(0.01, multiplier);
  }

  describe(): Record<string, unknown> {
    return {
      mood: this.mood,
      trend: this.trend,
      volatility: this.volatilityMultiplier,
      tickSize: this.tickSize,
      momentum: Number(this.momentum.toFixed(4)),
      drift: Number(this.drift.toFixed(4)),
    };
  }

  /** Produces the next price for a server timestamp. */
  next(now: number): number {
    const preset = MOOD_PRESETS[this.mood];
    if (this.lastTime === null) {
      this.lastTime = now;
      this.driftTarget = this.randomDrift();
      this.driftUntil = now + 20_000 + this.rng() * 40_000;
      return this.price;
    }

    const dt = Math.min(2000, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    if (dt === 0) return this.price;
    const step = dt / 100; // normalised to the 100 ms design interval

    if (now >= this.driftUntil) {
      this.driftTarget = this.randomDrift();
      this.driftUntil = now + 20_000 + this.rng() * 50_000;
    }
    this.drift += (this.driftTarget - this.drift) * Math.min(0.4, 0.01 * step);

    const decay = Math.pow(preset.momentumDecay, step);
    this.momentum = this.momentum * decay + this.gauss() * preset.shock * Math.sqrt(step);

    const trendBias = this.trend === 'up' ? 1 : this.trend === 'down' ? -1 : 0;
    const scale = this.tickSize * this.volatilityMultiplier;
    const delta = (this.momentum * preset.volatility + this.drift + trendBias * preset.trendStrength) * scale;

    this.price = Math.max(this.floor(), this.price + delta);
    return this.price;
  }

  /**
   * Minimum price for a market; DOGE-like instruments trade far below 1, so the
   * floor is derived from the tick size instead of being hardcoded to 1.
   */
  private floor(): number {
    return Math.max(this.tickSize * 10, 1e-6);
  }

  private randomDrift(): number {
    const sign = this.trend === 'up' ? 0.6 : this.trend === 'down' ? -0.6 : 0;
    return (this.rng() * 2 - 1) * 0.8 + sign;
  }

  private gauss(): number {
    const u = Math.max(1e-9, this.rng());
    const v = this.rng();
    return Math.max(-4, Math.min(4, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
  }
}
