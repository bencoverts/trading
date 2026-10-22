/**
 * Money is stored as integer minor units ("cents") to keep arithmetic exact.
 * The public HTTP/WS contract uses major units (e.g. 10.5 == 10.50 USD);
 * conversion happens exactly at the API boundary.
 */

export function majorToCents(amount: number): number {
  return Math.round(amount * 100);
}

export function centsToMajor(cents: number): number {
  return Math.round(cents) / 100;
}

/** Number of decimals the client sent (0, 1 or 2) - used for validation. */
export function decimalsOf(amount: number): number {
  const s = String(amount);
  if (s.includes('e') || s.includes('E')) return 0;
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}
