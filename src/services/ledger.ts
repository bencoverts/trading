import type { Database } from '../db/sqlite.js';
import type { Currency } from '../domain/constants.js';

export type LedgerDirection = 'debit' | 'credit';

export interface LedgerEntry {
  userId: string;
  currency: Currency;
  kind: string;
  direction: LedgerDirection;
  amountMinor: number;
  balanceAfterMinor: number;
  refType?: string | null;
  refId?: string | null;
  meta?: Record<string, unknown> | null;
  /** short human note folded into meta */
  note?: string;
  now?: number;
}

export interface LedgerRow {
  id: number;
  user_id: string;
  currency: Currency;
  kind: string;
  direction: LedgerDirection;
  amount_minor: number;
  balance_after_minor: number;
  ref_type: string | null;
  ref_id: string | null;
  meta: string | null;
  created_at: number;
}

/**
 * Append-only, double-entry style ledger: every balance movement is recorded as
 * one debit or credit row together with the resulting balance, inside the same
 * SQLite transaction as the wallet update.
 */
export class LedgerService {
  constructor(private readonly db: Database) {}

  write(entry: LedgerEntry): void {
    if (!Number.isInteger(entry.amountMinor) || entry.amountMinor <= 0) {
      throw new Error(`ledger amount must be a positive integer, got ${entry.amountMinor}`);
    }
    this.db.run(
      `INSERT INTO ledger (user_id, currency, kind, direction, amount_minor, balance_after_minor, ref_type, ref_id, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.userId,
      entry.currency,
      entry.kind,
      entry.direction,
      entry.amountMinor,
      entry.balanceAfterMinor,
      entry.refType ?? null,
      entry.refId ?? null,
      entry.meta || entry.note
        ? JSON.stringify({ ...(entry.meta ?? {}), ...(entry.note ? { note: entry.note } : {}) })
        : null,
      entry.now ?? Date.now(),
    );
  }

  list(opts: { userId: string; limit?: number; offset?: number; currency?: Currency }): LedgerRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    if (opts.currency) {
      return this.db.all<LedgerRow>(
        'SELECT * FROM ledger WHERE user_id = ? AND currency = ? ORDER BY id DESC LIMIT ? OFFSET ?',
        opts.userId,
        opts.currency,
        limit,
        offset,
      );
    }
    return this.db.all<LedgerRow>(
      'SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      opts.userId,
      limit,
      offset,
    );
  }

  /** Sum of credits minus debits per kind, used by the finance reports. */
  summaryByKind(
    from: number,
    to: number,
  ): Array<{ kind: string; currency: Currency; direction: LedgerDirection; totalMinor: number; count: number }> {
    return this.db.all(
      `SELECT kind, currency, direction, SUM(amount_minor) AS totalMinor, COUNT(*) AS count
         FROM ledger WHERE created_at BETWEEN ? AND ?
        GROUP BY kind, currency, direction ORDER BY kind`,
      from,
      to,
    );
  }

  totalsPerCurrency(): Array<{ currency: Currency; totalMinor: number }> {
    return this.db.all<{ currency: Currency; totalMinor: number }>(
      'SELECT currency, SUM(balance_minor) AS totalMinor FROM wallets GROUP BY currency',
    );
  }
}
