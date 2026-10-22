import { describe, expect, it } from 'vitest';
import { CURRENCIES, DURATION_PRESETS, MARKET_CATEGORIES, VOLATILITY_PRESETS } from '../../src/domain/constants.js';
import { decimalsOf, formatMoney, toMajor, toMinor } from '../../src/domain/money.js';
import { isMarketOpen, parseTradingHours, zonedParts } from '../../src/domain/marketSchedule.js';
import { decideResult, computePayoutMinor, quantizePrice } from '../../src/domain/payout.js';
import { resolvePayoutRate } from '../../src/services/trades.js';
import type { MarketRow } from '../../src/services/markets.js';

describe('money', () => {
  it('converts major and minor units for every currency', () => {
    expect(toMinor(10.5, 'USD')).toBe(1050);
    expect(toMajor(1050, 'USD')).toBe(10.5);
    expect(toMinor(15_000, 'IDR')).toBe(15_000);
    expect(toMinor(0.01, 'USDT')).toBe(1);
    for (const code of Object.keys(CURRENCIES) as Array<keyof typeof CURRENCIES>) {
      expect(toMajor(toMinor(1, code), code)).toBeCloseTo(1, CURRENCIES[code].decimals);
    }
  });

  it('counts decimals and rejects over-precise amounts', () => {
    expect(decimalsOf(10.55)).toBe(2);
    expect(decimalsOf(10)).toBe(0);
    expect(decimalsOf(0.00001)).toBe(5);
    expect(toMajor(1234, 'USD')).toBe(12.34);
    expect(formatMoney(1234, 'USD')).toBe('$ 12.34');
  });
});

describe('duration presets', () => {
  it('matches the documented short and long durations', () => {
    for (const value of [5, 10, 15, 30, 60, 120, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800]) {
      expect(DURATION_PRESETS).toContain(value);
    }
    expect(Math.min(...DURATION_PRESETS)).toBe(5);
    expect(Math.max(...DURATION_PRESETS)).toBe(28_800);
  });
});

describe('market catalog defaults', () => {
  it('offers the documented categories and volatility presets', () => {
    expect(MARKET_CATEGORIES).toEqual(['index', 'crypto', 'forex', 'komoditas', 'lainnya']);
    expect(VOLATILITY_PRESETS.rendah.multiplier).toBeLessThan(VOLATILITY_PRESETS.sedang.multiplier);
    expect(VOLATILITY_PRESETS.ekstrem.multiplier).toBe(3);
  });
});

describe('trading hours', () => {
  it('is always open in 24/7 mode', () => {
    expect(isMarketOpen({ mode: '24_7' }, Date.now()).open).toBe(true);
  });

  it('honours per-day windows in Asia/Jakarta', () => {
    const hours = parseTradingHours(
      JSON.stringify({ mode: 'schedule', timezone: 'Asia/Jakarta', days: [{ day: 1, from: '08:00', to: '22:00' }] }),
    );
    // Monday 2024-01-01 10:00 Jakarta = 03:00 UTC
    const monday10 = Date.UTC(2024, 0, 1, 3, 0, 0);
    expect(zonedParts(monday10, 'Asia/Jakarta')).toEqual({ day: 1, minutes: 600 });
    expect(isMarketOpen(hours, monday10).open).toBe(true);
    const monday23 = Date.UTC(2024, 0, 1, 16, 0, 0);
    expect(isMarketOpen(hours, monday23).open).toBe(false);
  });

  it('treats a window crossing midnight as open on both sides', () => {
    const hours = parseTradingHours(
      JSON.stringify({ mode: 'schedule', timezone: 'Asia/Jakarta', days: [{ day: 1, from: '22:00', to: '02:00' }] }),
    );
    const monday23 = Date.UTC(2024, 0, 1, 16, 0, 0); // 23:00 Jakarta
    expect(isMarketOpen(hours, monday23).open).toBe(true);
  });

  it('falls back to 24/7 for corrupt JSON', () => {
    expect(parseTradingHours('{not json').mode).toBe('24_7');
  });
});

describe('payout resolution', () => {
  const base = { payoutRate: 0.8, payoutByDuration: { 60: 0.9 } as Record<string, number> };

  it('prefers the per-market override, then per-duration, then global', () => {
    const market = { payout_rate: 0.95 } as MarketRow;
    expect(resolvePayoutRate(base, market, 60)).toBe(0.95);
    expect(resolvePayoutRate(base, { payout_rate: null } as MarketRow, 60)).toBe(0.9);
    expect(resolvePayoutRate(base, undefined, 300)).toBe(0.8);
  });

  it('computes profit and total payout modes', () => {
    expect(computePayoutMinor(1_000, 0.85, 'profit', 'win')).toBe(1_850);
    expect(computePayoutMinor(1_000, 0.85, 'total', 'win')).toBe(850);
    expect(computePayoutMinor(1_000, 0.85, 'profit', 'lose')).toBe(0);
    expect(computePayoutMinor(1_000, 0.85, 'profit', 'draw')).toBe(1_000);
  });

  it('decides win/lose/draw from the recorded prices only', () => {
    expect(decideResult('up', 100, 100.5)).toBe('win');
    expect(decideResult('up', 100, 99.5)).toBe('lose');
    expect(decideResult('down', 100, 99.5)).toBe('win');
    expect(decideResult('down', 100, 100.5)).toBe('lose');
    expect(decideResult('up', 100, 100)).toBe('draw');
    expect(decideResult('down', 100, 100)).toBe('draw');
  });

  it('quantizes prices to the market decimals', () => {
    expect(quantizePrice(0.4287123, 5)).toBe(0.42871);
    expect(quantizePrice(6204.5678, 2)).toBe(6204.57);
  });
});
