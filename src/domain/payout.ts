import type { Direction, TradeResult } from './constants.js';

export type PayoutMode = 'profit' | 'total';

/**
 * payoutMode = "profit" (default): a win returns stake + round(stake * rate)
 *   → rate 0.85 means the trader profits 85% of the stake.
 * payoutMode = "total": a win returns round(stake * rate) in total (rate > 1).
 * A loss returns 0. A draw returns the stake (refund).
 */
export function computePayoutMinor(amountMinor: number, rate: number, mode: PayoutMode, result: TradeResult): number {
  if (result === 'lose') return 0;
  if (result === 'draw') return amountMinor;
  if (mode === 'total') return Math.round(amountMinor * rate);
  return amountMinor + Math.round(amountMinor * rate);
}

/** Net trader profit for a winning trade, in minor units. */
export function profitMinor(amountMinor: number, rate: number, mode: PayoutMode): number {
  return computePayoutMinor(amountMinor, rate, mode, 'win') - amountMinor;
}

/**
 * Compares close against entry.
 * Prices are quantised by the server before comparison, so equality is exact;
 * a tiny epsilon keeps float serialisation noise from flipping a result.
 */
export function decideResult(direction: Direction, entryPrice: number, closePrice: number): TradeResult {
  const eps = 1e-9;
  const diff = closePrice - entryPrice;
  if (Math.abs(diff) <= eps) return 'draw';
  if (direction === 'up') return diff > 0 ? 'win' : 'lose';
  return diff < 0 ? 'win' : 'lose';
}

export function quantizePrice(price: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(price * f) / f;
}
