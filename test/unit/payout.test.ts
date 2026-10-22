import { describe, expect, it } from 'vitest';
import { computePayoutMinor, decideResult, profitMinor, quantizePrice } from '../../src/domain/payout.js';
import { convertMinor, decimalsOf, toMajor, toMinor } from '../../src/domain/money.js';

describe('decideResult (win / lose / draw)', () => {
  it('up wins when the close is above the entry', () => {
    expect(decideResult('up', 100, 100.01)).toBe('win');
    expect(decideResult('up', 100, 99.99)).toBe('lose');
  });

  it('down wins when the close is below the entry', () => {
    expect(decideResult('down', 100, 99.99)).toBe('win');
    expect(decideResult('down', 100, 100.01)).toBe('lose');
  });

  it('treats an unchanged price as a draw (refund) for both directions', () => {
    expect(decideResult('up', 100, 100)).toBe('draw');
    expect(decideResult('down', 100, 100)).toBe('draw');
    // float noise must not flip a draw into a result
    expect(decideResult('up', 0.1 + 0.2, 0.3)).toBe('draw');
  });
});

describe('payout in profit mode (default 0.85)', () => {
  it('returns stake + 85% profit on a win', () => {
    expect(computePayoutMinor(10_000, 0.85, 'profit', 'win')).toBe(18_500);
    expect(profitMinor(10_000, 0.85, 'profit')).toBe(8_500);
  });

  it('returns nothing on a loss', () => {
    expect(computePayoutMinor(10_000, 0.85, 'profit', 'lose')).toBe(0);
  });

  it('refunds the stake on a draw', () => {
    expect(computePayoutMinor(10_000, 0.85, 'profit', 'draw')).toBe(10_000);
    expect(profitMinor(10_000, 0.85, 'profit')).toBe(8_500);
  });

  it('rounds to whole minor units', () => {
    // 333 * 0.85 = 283.05 -> 283
    expect(computePayoutMinor(333, 0.85, 'profit', 'win')).toBe(616);
  });
});

describe('payout in total mode', () => {
  it('treats the rate as the total return', () => {
    expect(computePayoutMinor(10_000, 1.9, 'total', 'win')).toBe(19_000);
    expect(computePayoutMinor(10_000, 1.9, 'total', 'lose')).toBe(0);
    expect(computePayoutMinor(10_000, 1.9, 'total', 'draw')).toBe(10_000);
  });
});

describe('price + money helpers', () => {
  it('quantises prices to the market decimals', () => {
    expect(quantizePrice(0.412349, 5)).toBe(0.41235);
    expect(quantizePrice(6204.5678, 2)).toBe(6204.57);
    expect(quantizePrice(41250.5, 0)).toBe(41251);
  });

  it('converts major <-> minor per currency', () => {
    expect(toMinor(10, 'USD')).toBe(1_000);
    expect(toMinor(10_000, 'IDR')).toBe(10_000);
    expect(toMinor(0.05, 'USDT')).toBe(5);
    expect(toMajor(1_000, 'USD')).toBe(10);
    expect(toMajor(10_000, 'IDR')).toBe(10_000);
  });

  it('counts decimals of client amounts', () => {
    expect(decimalsOf(10)).toBe(0);
    expect(decimalsOf(10.25)).toBe(2);
    expect(decimalsOf(1e-7)).toBe(0);
  });

  it('converts demo currencies through the USD base', () => {
    const rates = { USD: 1, IDR: 16_000, USDT: 1 };
    // 10 USD -> 160,000 IDR (IDR has no minor units)
    expect(convertMinor(1_000, 'USD', 'IDR', rates)).toBe(160_000);
    expect(convertMinor(160_000, 'IDR', 'USD', rates)).toBe(1_000);
    expect(convertMinor(1_000, 'USD', 'USDT', rates)).toBe(1_000);
  });
});
