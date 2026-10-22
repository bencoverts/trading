import { randomUUID } from 'node:crypto';
import type { Db } from '../db/types.js';
import type { Config } from '../config.js';
import type { PasswordHasher } from '../auth/passwords.js';
import { AppError } from '../lib/errors.js';
import { recordAudit } from './audit.js';

export interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: number;
}

export interface AccountRow {
  user_id: string;
  balance_cents: number;
  currency: string;
  updated_at: number;
}

export interface PublicUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  createdAt: number;
  balance: number;
  balanceCents: number;
  currency: string;
}

export interface UserServiceDeps {
  db: Db;
  config: Config;
  hasher: PasswordHasher;
}

export class UserService {
  constructor(private readonly deps: UserServiceDeps) {}

  private get db(): Db {
    return this.deps.db;
  }

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async register(input: { email: string; password: string; ip?: string | null }): Promise<PublicUser> {
    const email = input.email.trim();
    const normalized = this.normalizeEmail(email);
    const existing = await this.db.get<{ id: string }>(`SELECT id FROM users WHERE email_normalized = ?`, [normalized]);
    if (existing) throw new AppError('EMAIL_TAKEN', 409, 'Email is already registered');

    const hash = await this.deps.hasher.hash(input.password);
    const now = Date.now();
    const userId = randomUUID();
    const balanceCents = this.deps.config.INITIAL_BALANCE_CENTS;

    await this.db.tx(async (t) => {
      await t.run(
        `INSERT INTO users (id, email, email_normalized, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, email, normalized, hash, 'user', now],
      );
      await t.run(
        `INSERT INTO accounts (user_id, balance_cents, currency, updated_at) VALUES (?, ?, ?, ?)`,
        [userId, balanceCents, this.deps.config.CURRENCY, now],
      );
      await recordAudit(
        t,
        { userId, actor: 'user', action: 'user_registered', meta: { initialBalanceCents: balanceCents }, ip: input.ip },
        now,
      );
    });

    return {
      id: userId,
      email,
      role: 'user',
      createdAt: now,
      balance: balanceCents / 100,
      balanceCents,
      currency: this.deps.config.CURRENCY,
    };
  }

  async verifyCredentials(email: string, password: string): Promise<UserRow | null> {
    const row = await this.db.get<UserRow>(`SELECT * FROM users WHERE email_normalized = ?`, [this.normalizeEmail(email)]);
    if (!row) {
      // constant-ish work even for unknown users to reduce user enumeration timing
      await this.deps.hasher.hash('invalid-password-placeholder');
      return null;
    }
    const ok = await this.deps.hasher.verify(row.password_hash, password);
    return ok ? row : null;
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>(`SELECT * FROM users WHERE email_normalized = ?`, [this.normalizeEmail(email)]);
  }

  async promoteToAdmin(userId: string): Promise<void> {
    await this.db.run(`UPDATE users SET role = 'admin' WHERE id = ?`, [userId]);
  }

  async findById(userId: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [userId]);
  }

  async getAccount(userId: string): Promise<AccountRow | undefined> {
    return this.db.get<AccountRow>(`SELECT * FROM accounts WHERE user_id = ?`, [userId]);
  }

  async getBalanceCents(userId: string): Promise<number> {
    const row = await this.db.get<{ balance_cents: number }>(`SELECT balance_cents FROM accounts WHERE user_id = ?`, [userId]);
    if (!row) throw AppError.notFound('Account not found');
    return Number(row.balance_cents);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.findById(userId);
    if (!user) throw AppError.unauthorized('User no longer exists');
    const account = await this.getAccount(userId);
    const balanceCents = account ? Number(account.balance_cents) : 0;
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: Number(user.created_at),
      balance: balanceCents / 100,
      balanceCents,
      currency: account?.currency ?? this.deps.config.CURRENCY,
    };
  }

  /**
   * Restores the demo balance. Open trades are voided as full-refund draws
   * (recorded in trade history) and then the balance is reset to the initial
   * amount, so "reset" always yields a clean, predictable state.
   */
  async resetBalance(userId: string, ip?: string | null): Promise<{ balanceCents: number; voidedTrades: number }> {
    const now = Date.now();
    const target = this.deps.config.INITIAL_BALANCE_CENTS;
    let voided = 0;

    await this.db.tx(async (t) => {
      const open = await t.all<{ id: string; amount_cents: number; entry_price: number }>(
        `SELECT id, amount_cents, entry_price FROM trades WHERE user_id = ? AND status = 'open'`,
        [userId],
      );
      for (const trade of open) {
        const res = await t.run(
          `UPDATE trades SET status = 'closed', result = 'draw', close_price = entry_price,
                  settled_at = ?, payout_cents = amount_cents
           WHERE id = ? AND status = 'open'`,
          [now, trade.id],
        );
        voided += res.changes;
        await recordAudit(
          t,
          { userId, actor: 'user', action: 'trade_voided_by_reset', tradeId: trade.id, ip },
          now,
        );
      }

      await t.run(`UPDATE accounts SET balance_cents = ?, updated_at = ? WHERE user_id = ?`, [target, now, userId]);
      await recordAudit(t, { userId, actor: 'user', action: 'balance_reset', meta: { balanceCents: target, voidedTrades: voided }, ip }, now);
    });

    return { balanceCents: target, voidedTrades: voided };
  }

  async getSettingsRow(userId: string): Promise<AccountRow | undefined> {
    return this.getAccount(userId);
  }
}
