import type { Database } from '../db/sqlite.js';
import type { SettingsService } from './settings.js';
import type { LedgerService } from './ledger.js';
import { recordAudit } from './audit.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { CURRENCY_LIST, type Currency } from '../domain/constants.js';
import { toMajor, toMinor, scaleOf } from '../domain/money.js';

export interface WalletRow {
  user_id: string;
  currency: Currency;
  balance_minor: number;
  /** reserved by pending withdrawals; still part of the user's total */
  locked_minor: number;
  updated_at: number;
}

export interface WalletView {
  currency: Currency;
  /** total balance = available + locked */
  balanceMinor: number;
  balance: number;
  lockedMinor: number;
  locked: number;
  availableMinor: number;
  available: number;
}

export interface WalletServiceDeps {
  db: Database;
  settings: SettingsService;
  ledger: LedgerService;
  now?: () => number;
}

export interface TopUpResult {
  wallet: WalletView;
  nextAllowedAt: number;
}

/**
 * All balance changes go through this service and, when they are part of a
 * bigger operation, run inside the caller's `BEGIN IMMEDIATE` transaction so
 * concurrent requests can never overdraw. Every movement is mirrored into the
 * ledger with the resulting balance.
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
    if (!row) throw AppError.notFound('Dompet tidak ditemukan');
    return row;
  }

  balances(userId: string): WalletView[] {
    const rows = this.db.all<WalletRow>('SELECT * FROM wallets WHERE user_id = ?', userId);
    return CURRENCY_LIST.map((currency) => {
      const row = rows.find((r) => r.currency === currency);
      return this.viewOfRow(currency, Number(row?.balance_minor ?? 0), Number(row?.locked_minor ?? 0));
    });
  }

  private viewOfRow(currency: Currency, totalMinor: number, lockedMinor: number): WalletView {
    const availableMinor = Math.max(0, totalMinor - lockedMinor);
    return {
      currency,
      balanceMinor: totalMinor,
      balance: toMajor(totalMinor, currency),
      lockedMinor,
      locked: toMajor(lockedMinor, currency),
      availableMinor,
      available: toMajor(availableMinor, currency),
    };
  }

  /** Debit with the ledger entry. Must run inside the caller's transaction for atomicity. */
  debit(
    userId: string,
    currency: Currency,
    amountMinor: number,
    meta: { kind: string; refType?: string; refId?: string; note?: string } = { kind: 'debit' },
  ): number {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw AppError.badRequest('nominal harus bilangan bulat positif (minor unit)');
    }
    const at = this.now();
    const result = this.db.run(
      `UPDATE wallets SET balance_minor = balance_minor - ?, updated_at = ?
       WHERE user_id = ? AND currency = ? AND balance_minor - locked_minor >= ?`,
      amountMinor,
      at,
      userId,
      currency,
      amountMinor,
    );
    if (result.changes === 0) {
      throw new AppError('INSUFFICIENT_FUNDS', 422, 'Saldo demo tidak cukup', { currency, requiredMinor: amountMinor });
    }
    const balance = Number(this.get(userId, currency).balance_minor);
    this.deps.ledger.write({
      userId,
      currency,
      kind: meta.kind,
      direction: 'debit',
      amountMinor,
      balanceAfterMinor: balance,
      refType: meta.refType ?? null,
      refId: meta.refId ?? null,
      meta: meta.note ? { note: meta.note } : null,
      now: at,
    });
    return balance;
  }

  credit(
    userId: string,
    currency: Currency,
    amountMinor: number,
    meta: { kind: string; refType?: string; refId?: string; note?: string } = { kind: 'credit' },
  ): number {
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      throw AppError.badRequest('nominal harus bilangan bulat non-negatif (minor unit)');
    }
    const current = Number(this.get(userId, currency).balance_minor);
    if (amountMinor === 0) return current;
    const at = this.now();
    const result = this.db.run(
      'UPDATE wallets SET balance_minor = balance_minor + ?, updated_at = ? WHERE user_id = ? AND currency = ?',
      amountMinor,
      at,
      userId,
      currency,
    );
    if (result.changes === 0) throw AppError.notFound('Dompet tidak ditemukan');
    const balance = Number(this.get(userId, currency).balance_minor);
    this.deps.ledger.write({
      userId,
      currency,
      kind: meta.kind,
      direction: 'credit',
      amountMinor,
      balanceAfterMinor: balance,
      refType: meta.refType ?? null,
      refId: meta.refId ?? null,
      meta: meta.note ? { note: meta.note } : null,
      now: at,
    });
    return balance;
  }

  /**
   * Reserves part of the balance for a pending withdrawal. The total balance is
   * unchanged, so the money is still visible to the user but cannot be spent.
   * The ledger row is marked `affectsBalance: false`.
   */
  lockFunds(
    userId: string,
    currency: Currency,
    amountMinor: number,
    meta: { kind?: string; refType?: string; refId?: string; note?: string },
  ): WalletView {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw AppError.badRequest('nominal harus bilangan bulat positif (minor unit)');
    }
    const at = this.now();
    const result = this.db.run(
      `UPDATE wallets SET locked_minor = locked_minor + ?, updated_at = ?
        WHERE user_id = ? AND currency = ? AND balance_minor - locked_minor >= ?`,
      amountMinor,
      at,
      userId,
      currency,
      amountMinor,
    );
    if (result.changes === 0) {
      throw new AppError('INSUFFICIENT_AVAILABLE_FUNDS', 422, 'Saldo tersedia tidak cukup', {
        currency,
        requiredMinor: amountMinor,
      });
    }
    const row = this.get(userId, currency);
    this.deps.ledger.write({
      userId,
      currency,
      kind: meta.kind ?? 'withdrawal_hold',
      direction: 'debit',
      amountMinor,
      balanceAfterMinor: Number(row.balance_minor),
      refType: meta.refType ?? null,
      refId: meta.refId ?? null,
      meta: { affectsBalance: false, lockedMinor: Number(row.locked_minor), ...(meta.note ? { note: meta.note } : {}) },
      now: at,
    });
    return this.viewOf(userId, currency);
  }

  /** Releases a reservation (rejected/cancelled withdrawal). */
  releaseFunds(
    userId: string,
    currency: Currency,
    amountMinor: number,
    meta: { kind?: string; refType?: string; refId?: string; note?: string },
  ): WalletView {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw AppError.badRequest('nominal harus bilangan bulat positif (minor unit)');
    }
    const at = this.now();
    const result = this.db.run(
      `UPDATE wallets SET locked_minor = locked_minor - ?, updated_at = ?
        WHERE user_id = ? AND currency = ? AND locked_minor >= ?`,
      amountMinor,
      at,
      userId,
      currency,
      amountMinor,
    );
    if (result.changes === 0) {
      throw new AppError('LOCK_MISMATCH', 409, 'Saldo terkunci tidak cocok; hubungi admin', { currency });
    }
    const row = this.get(userId, currency);
    this.deps.ledger.write({
      userId,
      currency,
      kind: meta.kind ?? 'withdrawal_hold_released',
      direction: 'credit',
      amountMinor,
      balanceAfterMinor: Number(row.balance_minor),
      refType: meta.refType ?? null,
      refId: meta.refId ?? null,
      meta: { affectsBalance: false, lockedMinor: Number(row.locked_minor), ...(meta.note ? { note: meta.note } : {}) },
      now: at,
    });
    return this.viewOf(userId, currency);
  }

  /**
   * Turns a reservation into a real debit (withdrawal completed). Balance and
   * locked amount are reduced together, so available stays consistent.
   */
  settleLocked(
    userId: string,
    currency: Currency,
    amountMinor: number,
    meta: { kind?: string; refType?: string; refId?: string; note?: string },
  ): WalletView {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw AppError.badRequest('nominal harus bilangan bulat positif (minor unit)');
    }
    const at = this.now();
    const result = this.db.run(
      `UPDATE wallets SET balance_minor = balance_minor - ?, locked_minor = locked_minor - ?, updated_at = ?
        WHERE user_id = ? AND currency = ? AND locked_minor >= ? AND balance_minor >= ?`,
      amountMinor,
      amountMinor,
      at,
      userId,
      currency,
      amountMinor,
      amountMinor,
    );
    if (result.changes === 0) {
      throw new AppError('LOCK_MISMATCH', 409, 'Saldo terkunci tidak cocok; hubungi admin', { currency });
    }
    const row = this.get(userId, currency);
    this.deps.ledger.write({
      userId,
      currency,
      kind: meta.kind ?? 'withdrawal',
      direction: 'debit',
      amountMinor,
      balanceAfterMinor: Number(row.balance_minor),
      refType: meta.refType ?? null,
      refId: meta.refId ?? null,
      meta: { lockedMinor: Number(row.locked_minor), ...(meta.note ? { note: meta.note } : {}) },
      now: at,
    });
    return this.viewOf(userId, currency);
  }

  /** Preview for the UI: payout of a conversion without applying it. */
  quote(from: Currency, to: Currency, amountMinor: number): { fromMinor: number; toMinor: number; rate: number } {
    if (amountMinor <= 0) throw AppError.badRequest('nominal harus lebih dari 0');
    const settings = this.deps.settings.get();
    const rate = settings.rates[to] / settings.rates[from];
    const toMinor = Math.round((amountMinor / scaleOf(from)) * rate * scaleOf(to));
    return { fromMinor: amountMinor, toMinor, rate };
  }

  /** Demo currency conversion (display + demo balance only), fully ledgered. */
  convert(
    userId: string,
    from: Currency,
    to: Currency,
    amountMinor: number,
  ): { from: WalletView; to: WalletView; rate: number } {
    if (from === to) throw AppError.badRequest('Mata uang asal dan tujuan sama');
    const quote = this.quote(from, to, amountMinor);
    if (quote.toMinor <= 0) throw new AppError('CONVERSION_INVALID', 422, 'Nilai konversi terlalu kecil');
    const now = this.now();
    this.db.transaction(() => {
      this.debit(userId, from, amountMinor, { kind: 'conversion_out', refType: 'conversion', refId: `${from}->${to}` });
      // rounding dust is discarded, never invented
      this.credit(userId, to, quote.toMinor, { kind: 'conversion_in', refType: 'conversion', refId: `${from}->${to}` });
      this.db.run(
        `INSERT INTO conversions (id, user_id, from_currency, to_currency, from_minor, to_minor, rate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        userId,
        from,
        to,
        amountMinor,
        quote.toMinor,
        quote.rate,
        now,
      );
      recordAudit(this.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'wallet.converted',
        targetType: 'wallet',
        targetId: userId,
        meta: { from, to, amountMinor, toMinor: quote.toMinor, rate: quote.rate },
        now,
      });
    });
    return { from: this.viewOf(userId, from), to: this.viewOf(userId, to), rate: quote.rate };
  }

  /** Instant DEMO top-up, capped per transaction and rate-limited by a cooldown. */
  topUp(userId: string, currency: Currency, amountMinor: number, ip?: string | null): TopUpResult {
    const settings = this.deps.settings.get();
    const max = settings.topupMax[currency];
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw AppError.badRequest('nominal harus lebih dari 0');
    }
    if (amountMinor > max) {
      throw AppError.unprocessable('AMOUNT_NOT_ALLOWED', `Maksimum top-up demo ${toMajor(max, currency)} ${currency}`, {
        maxMinor: max,
      });
    }
    const now = this.now();
    const last = this.db.get<{ created_at: number }>(
      `SELECT created_at FROM ledger WHERE user_id = ? AND kind = 'demo_topup'
        ORDER BY created_at DESC LIMIT 1`,
      userId,
    );
    const cooldownMs = settings.topupCooldownSec * 1000;
    if (last && now - Number(last.created_at) < cooldownMs) {
      const nextAllowedAt = Number(last.created_at) + cooldownMs;
      throw new AppError('COOLDOWN', 429, `Tunggu sebentar sebelum top-up lagi`, { nextAllowedAt });
    }
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const count = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND kind = 'demo_topup' AND created_at >= ?`,
      userId,
      dayStart,
    );
    if (Number(count?.n ?? 0) >= settings.topupDailyCount) {
      throw new AppError('RATE_LIMITED', 429, `Batas top-up demo harian tercapai (${settings.topupDailyCount}x)`, {
        dailyLimit: settings.topupDailyCount,
      });
    }

    this.db.transaction(() => {
      this.credit(userId, currency, amountMinor, { kind: 'demo_topup', note: 'Top-up demo instan' });
      recordAudit(this.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'wallet.demo_topup',
        targetType: 'wallet',
        targetId: userId,
        meta: { currency, amountMinor },
        ip: ip ?? null,
        now,
      });
    });
    return { wallet: this.viewOf(userId, currency), nextAllowedAt: now + cooldownMs };
  }

  /** Restores every demo wallet to the configured starting balances. */
  resetAll(userId: string, ip?: string | null): { wallets: WalletView[]; nextAllowedAt: number } {
    const settings = this.deps.settings.get();
    const now = this.now();
    const last = this.db.get<{ created_at: number }>(
      `SELECT created_at FROM ledger WHERE user_id = ? AND kind = 'demo_reset' ORDER BY created_at DESC LIMIT 1`,
      userId,
    );
    const cooldownMs = settings.resetCooldownSec * 1000;
    if (last && now - Number(last.created_at) < cooldownMs) {
      throw new AppError('COOLDOWN', 429, 'Reset saldo demo masih dalam cooldown', {
        nextAllowedAt: Number(last.created_at) + cooldownMs,
      });
    }
    this.db.transaction(() => {
      for (const currency of CURRENCY_LIST) {
        const target = settings.initialBalance[currency];
        const current = Number(this.get(userId, currency).balance_minor);
        const delta = target - current;
        this.db.run(
          'UPDATE wallets SET balance_minor = ?, updated_at = ? WHERE user_id = ? AND currency = ?',
          target,
          now,
          userId,
          currency,
        );
        this.deps.ledger.write({
          userId,
          currency,
          kind: 'demo_reset',
          direction: delta >= 0 ? 'credit' : 'debit',
          amountMinor: Math.max(1, Math.abs(delta)),
          balanceAfterMinor: target,
          meta: { previousMinor: current, targetMinor: target },
          now,
        });
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
    return { wallets: this.balances(userId), nextAllowedAt: now + cooldownMs };
  }

  /** Admin adjustment (audited + ledgered, cannot go below zero). */
  adminAdjust(
    userId: string,
    currency: Currency,
    mode: 'add' | 'subtract' | 'set',
    amountMajorOrMinor: number,
    opts: { reason: string; actorUserId: string; ip?: string | null; minor?: boolean },
  ): WalletView {
    const amountMinor = opts.minor ? Math.round(amountMajorOrMinor) : toMinor(amountMajorOrMinor, currency);
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      throw AppError.badRequest('nominal tidak valid');
    }
    const now = this.now();
    this.db.transaction(() => {
      const current = Number(this.get(userId, currency).balance_minor);
      let delta: number;
      if (mode === 'add') delta = amountMinor;
      else if (mode === 'subtract') delta = -amountMinor;
      else delta = amountMinor - current;
      if (delta > 0) {
        this.credit(userId, currency, delta, { kind: 'admin_adjustment', note: opts.reason });
      } else if (delta < 0) {
        this.debit(userId, currency, -delta, { kind: 'admin_adjustment', note: opts.reason });
      }
      recordAudit(this.db, {
        actorUserId: opts.actorUserId,
        actorRole: 'admin',
        action: 'admin.wallet_adjusted',
        targetType: 'wallet',
        targetId: userId,
        meta: { currency, mode, amountMinor, delta, reason: opts.reason, before: current },
        ip: opts.ip ?? null,
        now,
      });
    });
    return this.viewOf(userId, currency);
  }

  viewOf(userId: string, currency: Currency): WalletView {
    const row = this.get(userId, currency);
    return this.viewOfRow(currency, Number(row.balance_minor), Number(row.locked_minor ?? 0));
  }

  /** Total locked per currency across all users (finance dashboard). */
  lockedTotals(): Array<{ currency: Currency; totalMinor: number }> {
    return this.db.all<{ currency: Currency; totalMinor: number }>(
      'SELECT currency, SUM(locked_minor) AS totalMinor FROM wallets GROUP BY currency',
    );
  }
}
