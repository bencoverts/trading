import { CURRENCIES, type Currency } from './constants.js';

/** Minor units per currency: USD 100, IDR 1, USDT 100. */
export function scaleOf(currency: Currency): number {
  return 10 ** CURRENCIES[currency].decimals;
}

export function toMinor(amount: number, currency: Currency): number {
  return Math.round(amount * scaleOf(currency));
}

export function toMajor(minor: number, currency: Currency): number {
  const scale = scaleOf(currency);
  return Math.round(minor) / scale;
}

/** Decimals accepted from clients for this currency's major-unit amount. */
export function maxDecimals(currency: Currency): number {
  return CURRENCIES[currency].decimals;
}

export function decimalsOf(value: number): number {
  const s = String(value);
  if (s.includes('e') || s.includes('E')) return 0;
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Converts between demo currencies using admin-configured rates.
 * Rates are expressed as "units of this currency per 1 USD".
 */
export function convertMinor(
  amountMinor: number,
  from: Currency,
  to: Currency,
  rates: Record<Currency, number>,
): number {
  if (from === to) return amountMinor;
  const usd = amountMinor / scaleOf(from) / rates[from];
  const target = Math.round(usd * rates[to] * scaleOf(to));
  return Math.max(0, target);
}

export function formatMoney(minor: number, currency: Currency): string {
  const meta = CURRENCIES[currency];
  const value = toMajor(minor, currency);
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: meta.decimals,
    maximumFractionDigits: meta.decimals,
  }).format(value);
  return `${meta.symbol} ${formatted}`;
}
