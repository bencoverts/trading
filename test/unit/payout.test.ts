import { describe, expect, it } from 'vitest';
import { computePayoutCents, decideResult, profitCents, quantizePrice } from '../../src/domain/payout.js';
import { centsToMajor, decimalsOf, majorToCents } from '../../src/domain/money.js';

describe('computePayoutCents', () => {
  it('pays stake + profit in "profit" mode for a win', () => {
    expect(computePayoutCents(1_000, 0.85, 'profit', 'win')).toBe(1_850);
    expect(computePayoutCents(10_000, 0.8, 'profit', 'win')).toBe(18_000);
    expect(profitCents(1_000, 0.85, 'profit')).toBe(850);
  });

  it('pays a configured total return in "total" mode for a win', () => {
    expect(computePayoutCents(1_000, 1.85, 'total', 'win')).toBe(1_850);
    expect(profitCents(1_000, 1.85, 'total')).toBe(850);
  });

  it('pays nothing on a loss', () => {
    expect(computePayoutCents(1_000, 0.85, 'profit', 'lose')).toBe(0);
    expect(computePayoutCents(1_000, 1.85, 'total', 'lose')).toBe(0);
  });

  it('refunds the full stake on a draw', () => {
    expect(computePayoutCents(1_000, 0.85, 'profit', 'draw')).toBe(1_000);
    expect(computePayoutCents(2_500, 1.85, 'total', 'draw')).toBe(2_500);
  });

  it('rounds half away from zero at the cent', () => {
    expect(computePayoutCents(1_005, 0.85, 'profit', 'win')).toBe(1_005 + 854); // 854.25 -> 854
    expect(computePayoutCents(1_000, 0.123, 'profit', 'win')).toBe(1_123);
  });

  it('is monotonic in the payout rate', () => {
    const a = computePayoutCents(5_000, 0.5, 'profit', 'win');
    const b = computePayoutCents(5_000, 0.9, 'profit', 'win');
    expect(b).toBeGreaterThan(a);
  });
});

describe('decideResult', () => {
  it('decides up trades', () => {
    expect(decideResult('up', 100, 100.01)).toBe('win');
    expect(decideResult('up', 100, 99.99)).toBe('lose');
    expect(decideResult('up', 100, 100)).toBe('draw');
  });

  it('decides down trades', () => {
    expect(decideResult('down', 100, 99.99)).toBe('win');
    expect(decideResult('down', 100, 100.01)).toBe('lose');
    expect(decideResult('down', 100, 100)).toBe('draw');
  });

  it('treats floating point noise around zero as a draw', () => {
    expect(decideResult('up', 100, 100 + 1e-12)).toBe('draw');
    expect(decideResult('down', 100, 100 - 1e-12)).toBe('draw');
  });
});

describe('prices and money helpers', () => {
  it('quantizes prices', () => {
    expect(quantizePrice(1.2345, 2)).toBe(1.23);
    expect(quantizePrice(1.235, 2)).toBe(1.24);
    expect(quantizePrice(6204.5, 0)).toBe(6205);
  });

  it('converts major units to cents safely', () => {
    expect(majorToCents(10)).toBe(1_000);
    expect(majorToCents(10.5)).toBe(1_050);
    expect(majorToCents(0.07)).toBe(7);
    expect(centsToMajor(1_050)).toBe(10.5);
  });

  it('detects decimal places of a client amount', () => {
    expect(decimalsOf(10)).toBe(0);
    expect(decimalsOf(10.5)).toBe(1);
    expect(decimalsOf(10.55)).toBe(2);
    expect(decimalsOf(10.555)).toBe(3);
  });
});
