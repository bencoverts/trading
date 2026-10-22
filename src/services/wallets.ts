import type { Database } from '../db/sqlite.js';
import type { SettingsService } from './settings.js';
import { recordAudit } from './audit.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { CURRENCY_LIST, type Currency } from '../domain/constants.js';
import { toMajor } from '../domain/money.js';

export interface WalletRow {
  user_id: string;
  currency: Currency;
  balance_minor: number;
  updated_at: number;
}

export interface WalletView {
  currency: Currency;
  balanceMinor: number;
  balance: number;
}

export interface WalletServiceDeps {
  db: Database;
  settings: SettingsService;
  now?: () => number;
}

/**
 * All balance changes go through this service and run inside a single
 * `BEGIN IMMEDIATE` transaction, so concurrent requests cannot overdraw.
 */
export class WalletService {
  private readonly now: () => number;

  constructor(private readonly deps: WalletServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get db(): Database {
    return this.deps.db;
  }

  get(userId: string, currency: Currency): WalletRow {
    const row = this.db.get<WalletRow>('SELECT * FROM wallets WHERE user_id = ? AND currency = ?', userId, currency);
    if (!row) throw AppError.notFound('Wallet not found');
    return row;
  }

  balances(userId: string): WalletView[] {
    const rows = this.db.all<WalletRow>('SELECT * FROM wallets WHERE user_id = ?', userId);
    return CURRENCY_LIST.map((currency) => {
      const row = rows.find((r) => r.currency === currency);
      const minor = Number(row?.balance_minor ?? 0);
      return { currency, balanceMinor: minor, balance: toMajor(minor, currency) };
    });
  }

  /**
   * Debits a wallet. Must be called inside an existing transaction when the
   * caller needs atomicity with another write (e.g. inserting the trade).
   */
  debit(userId: string, currency: Currency, amountMinor: number): number {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw AppError.badRequest('amount must be a positive integer in minor units');
    }
    const result = this.db.run(
      `UPDATE wallets SET balance_minor = balance_minor - ?, updated_at = ?
       WHERE user_id = ? AND currency = ? AND balance_minor >= ?`,
      amountMinor,
      this.now(),
      userId,
      currency,
      amountMinor,
    );
    if (result.changes === 0) {
      throw new AppError('INSUFFICIENT_FUNDS', 422, 'Insufficient demo balance', { currency, requiredMinor: amountMinor });
    }
    return this.get(userId, currency).balance_minor;
  }

  credit(userId: string, currency: Currency, amountMinor: number): number {
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      throw AppError.badRequest('amount must be a non-negative integer in minor units');
    }
    if (amountMinor === 0) return this.get(userId, currency).balance_minor;
    const result = this.db.run(
      'UPDATE wallets SET balance_minor = balance_minor + ?, updated_at = ? WHERE user_id = ? AND currency = ?',
      amountMinor,
      this.now(),
      userId,
      currency,
    );
    if (result.changes === 0) throw AppError.notFound('Wallet not found');
    return this.get(userId, currency).balance_minor;
  }

  /**
   * DEMO top-up (virtual money only). Capped per transaction and per day.
   */
  topUp(userId: string, currency: Currency, amountMinor: number, ip?: string | null): WalletView {
    const settings = this.deps.settings.get();
    const max = settings.topupMax[currency];
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw AppError.badRequest('amount must be greater than 0');
    }
    if (amountMinor > max) {
      throw AppError.unprocessable('AMOUNT_NOT_ALLOWED', `Maximum demo top-up is ${max} minor units`, { maxMinor: max });
    }
    const now = this.now();
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const count = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deposits WHERE user_id = ? AND kind = 'demo_topup' AND created_at >= ?`,
      userId,
      dayStart,
    );
    if (Number(count?.n ?? 0) >= settings.topupDailyCount) {
      throw AppError.unprocessable('RATE_LIMITED', `Demo top-up limit reached (${settings.topupDailyCount}/day)`, {
        dailyLimit: settings.topupDailyCount,
      });
    }

    this.db.transaction(() => {
      const balance = this.credit(userId, currency, amountMinor);
      this.db.run(
        `INSERT INTO deposits (id, user_id, currency, amount_minor, kind, note, created_at)
         VALUES (?, ?, ?, ?, 'demo_topup', ?, ?)`,
        newId(),
        userId,
        currency,
        amountMinor,
        'Instant demo top-up',
        now,
      );
      recordAudit(this.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'wallet.demo_topup',
        targetType: 'wallet',
        targetId: userId,
        meta: { currency, amountMinor, balanceMinor: balance },
        ip: ip ?? null,
        now,
      });
    });
    return this.viewOf(userId, currency);
  }

  /** Restores every demo wallet to the configured starting balances. */
  resetAll(userId: string, ip?: string | null): WalletView[] {
    const settings = this.deps.settings.get();
    const now = this.now();
    this.db.transaction(() => {
      for (const currency of CURRENCY_LIST) {
        this.db.run(
          'UPDATE wallets SET balance_minor = ?, updated_at = ? WHERE user_id = ? AND currency = ?',
          settings.initialBalance[currency],
          now,
          userId,
          currency,
        );
      }
      recordAudit(this.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'wallet.reset',
        targetType: 'wallet',
        targetId: userId,
        meta: { balances: settings.initialBalance },
        ip: ip ?? null,
        now,
      });
    });
    return this.balances(userId);
  }

  /** Admin adjustment (audited, cannot go below zero). */
  adminAdjust(
    userId: string,
    currency: Currency,
    deltaMinor: number,
    actorUserId: string,
    reason: string,
    ip?: string | null,
  ): WalletView {
    if (!Number.isInteger(deltaMinor) || deltaMinor === 0) {
      throw AppError.badRequest('delta must be a non-zero integer in minor units');
    }
    const now = this.now();
    this.db.transaction(() => {
      if (deltaMinor > 0) this.credit(userId, currency, deltaMinor);
      else this.debit(userId, currency, -deltaMinor);
      recordAudit(this.db, {
        actorUserId,
        actorRole: 'admin',
        action: 'admin.wallet_adjusted',
        targetType: 'wallet',
        targetId: userId,
        meta: { currency, deltaMinor, reason },
        ip: ip ?? null,
        now,
      });
    });
    return this.viewOf(userId, currency);
  }

  private viewOf(userId: string, currency: Currency): WalletView {
    const minor = Number(this.get(userId, currency).balance_minor);
    return { currency, balanceMinor: minor, balance: toMajor(minor, currency) };
  }
}
