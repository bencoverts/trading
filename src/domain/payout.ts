export type Direction = 'up' | 'down';
export type TradeResult = 'win' | 'lose' | 'draw';
export type PayoutMode = 'profit' | 'total';

/**
 * payout_mode:
 *  - "profit" (default): a winning trade returns stake + round(stake * rate).
 *    rate 0.85 means the trader profits 85% of the stake.
 *  - "total": a winning trade returns round(stake * rate) in total (rate must
 *    then be > 1, e.g. 1.85). House edge is explicit in the configuration.
 *
 * A losing trade returns 0; a draw refunds the stake in full.
 */
export function computePayoutCents(
  amountCents: number,
  rate: number,
  mode: PayoutMode,
  result: TradeResult,
): number {
  if (result === 'lose') return 0;
  if (result === 'draw') return amountCents;
  if (mode === 'total') return Math.round(amountCents * rate);
  return amountCents + Math.round(amountCents * rate);
}

/** Net profit of a winning trade (used for `payout` in API responses). */
export function profitCents(amountCents: number, rate: number, mode: PayoutMode): number {
  return computePayoutCents(amountCents, rate, mode, 'win') - amountCents;
}

/**
 * Compares the closing price against the entry price to decide the outcome.
 * Prices are quantised by the server, so equality is exact; a tiny epsilon is
 * still applied to avoid surprises from floating point serialisation.
 */
export function decideResult(direction: Direction, entryPrice: number, closePrice: number): TradeResult {
  const eps = 1e-9;
  const diff = closePrice - entryPrice;
  if (Math.abs(diff) <= eps) return 'draw';
  if (direction === 'up') return diff > 0 ? 'win' : 'lose';
  return diff < 0 ? 'win' : 'lose';
}

/** Rounds a price to the configured number of decimals (server-side only). */
export function quantizePrice(price: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(price * f) / f;
}
