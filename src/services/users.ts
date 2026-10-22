import type { Database } from '../db/sqlite.js';
import type { PasswordHasher } from '../auth/passwords.js';
import type { TokenService } from '../auth/tokens.js';
import type { Mailer } from './mailer.js';
import type { SettingsService } from './settings.js';
import { recordAudit } from './audit.js';
import { AppError } from '../lib/errors.js';
import { newId, newToken, sha256 } from '../lib/ids.js';
import { CURRENCY_LIST, type Currency } from '../domain/constants.js';

export interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  role: 'user' | 'admin';
  email_verified_at: number | null;
  blocked_at: number | null;
  blocked_reason: string | null;
  display_currency: Currency;
  token_version: number;
  created_at: number;
  updated_at: number;
}

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  role: 'user' | 'admin';
  emailVerified: boolean;
  blocked: boolean;
  displayCurrency: Currency;
  createdAt: number;
}

export const toPublicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  email: row.email,
  username: row.username,
  role: row.role,
  emailVerified: row.email_verified_at !== null,
  blocked: row.blocked_at !== null,
  displayCurrency: row.display_currency,
  createdAt: row.created_at,
});

export interface UserServiceDeps {
  db: Database;
  hasher: PasswordHasher;
  tokens: TokenService;
  mailer: Mailer;
  settings: SettingsService;
  publicUrl: string;
  cookieName: string;
  exposeDevTokens: boolean;
  verifyTtlMs?: number;
  resetTtlMs?: number;
  now?: () => number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class UserService {
  readonly cookieName: string;
  private readonly now: () => number;

  constructor(private readonly deps: UserServiceDeps) {
    this.cookieName = deps.cookieName;
    this.now = deps.now ?? Date.now;
  }

  private get db(): Database {
    return this.deps.db;
  }

  findById(id: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }

  findByEmail(email: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE email_normalized = ?', normalize(email));
  }

  findByUsername(username: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE username_normalized = ?', normalize(username));
  }

  /** Email or username. */
  findByIdentifier(identifier: string): UserRow | undefined {
    const value = normalize(identifier);
    return (
      this.db.get<UserRow>('SELECT * FROM users WHERE email_normalized = ?', value) ??
      this.db.get<UserRow>('SELECT * FROM users WHERE username_normalized = ?', value)
    );
  }

  async register(input: { email: string; username: string; password: string; ip?: string | null }): Promise<UserRow> {
    const email = input.email.trim();
    const username = input.username.trim();
    if (!EMAIL_RE.test(email)) throw AppError.badRequest('A valid email is required');
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
      throw AppError.badRequest('username must be 3-24 characters: letters, digits, dot, dash or underscore');
    }
    if (input.password.length < 8) throw AppError.badRequest('password must be at least 8 characters');
    if (this.findByEmail(email)) throw AppError.conflict('Email is already registered', 'EMAIL_TAKEN');
    if (this.findByUsername(username)) throw AppError.conflict('Username is already taken', 'USERNAME_TAKEN');

    const hash = await this.deps.hasher.hash(input.password);
    const now = this.now();
    const id = newId();
    const settings = this.deps.settings.get();

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, role,
                            email_verified_at, display_currency, token_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'user', NULL, 'USD', 0, ?, ?)`,
        id,
        email,
        normalize(email),
        username,
        normalize(username),
        hash,
        now,
        now,
      );
      for (const currency of CURRENCY_LIST) {
        this.db.run(
          'INSERT INTO wallets (user_id, currency, balance_minor, updated_at) VALUES (?, ?, ?, ?)',
          id,
          currency,
          settings.initialBalance[currency],
          now,
        );
      }
      recordAudit(this.db, {
        actorUserId: id,
        actorRole: 'user',
        action: 'user.registered',
        targetType: 'user',
        targetId: id,
        meta: { email, username, initialBalance: settings.initialBalance },
        ip: input.ip ?? null,
        now,
      });
    });

    this.issueEmailToken(id, email, 'verify_email');
    const row = this.findById(id);
    if (!row) throw new Error('user creation failed');
    return row;
  }

  async verifyPassword(row: UserRow, password: string): Promise<boolean> {
    const ok = await this.deps.hasher.verify(row.password_hash, password);
    if (!ok) {
      // keep timing similar for unknown users
      await this.deps.hasher.hash('placeholder-password');
      return false;
    }
    return true;
  }

  signSession(row: UserRow): string {
    return this.deps.tokens.sign({ sub: row.id, role: row.role, v: row.token_version });
  }

  issueEmailToken(userId: string, email: string, purpose: 'verify_email' | 'reset_password'): string {
    const token = newToken();
    const now = this.now();
    const ttl = purpose === 'verify_email' ? (this.deps.verifyTtlMs ?? 24 * 3600_000) : (this.deps.resetTtlMs ?? 3600_000);
    this.db.run(
      `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      newId(),
      userId,
      purpose,
      sha256(token),
      now + ttl,
      now,
    );
    const path = purpose === 'verify_email' ? '/verify-email' : '/reset-password';
    const link = `${this.deps.publicUrl}${path}?token=${encodeURIComponent(token)}`;
    this.deps.mailer.send({
      to: email,
      subject: purpose === 'verify_email' ? 'Verify your account' : 'Reset your password',
      body: `Open this link to ${purpose === 'verify_email' ? 'verify your email' : 'choose a new password'}: ${link}`,
      link,
    });
    return token;
  }

  /** Development helper: last link issued for an email (never enabled in production). */
  devLinkFor(email: string): string | null {
    return this.deps.exposeDevTokens ? this.deps.mailer.lastLinkFor(email) : null;
  }

  consumeEmailToken(token: string, purpose: 'verify_email' | 'reset_password'): UserRow {
    const now = this.now();
    const row = this.db.get<{ id: string; user_id: string; expires_at: number; used_at: number | null }>(
      'SELECT id, user_id, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?',
      sha256(token),
      purpose,
    );
    if (!row || row.used_at !== null || row.expires_at < now) {
      throw new AppError('INVALID_TOKEN', 400, 'This link is invalid or has expired');
    }
    const user = this.findById(row.user_id);
    if (!user) throw new AppError('INVALID_TOKEN', 400, 'This link is invalid or has expired');
    return user;
  }

  verifyEmail(token: string): PublicUser {
    const user = this.consumeEmailToken(token, 'verify_email');
    const now = this.now();
    this.db.transaction(() => {
      this.db.run('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?', now, sha256(token));
      this.db.run('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?', now, now, user.id);
      recordAudit(this.db, {
        actorUserId: user.id,
        actorRole: 'user',
        action: 'user.email_verified',
        targetType: 'user',
        targetId: user.id,
        now,
      });
    });
    return toPublicUser(this.findById(user.id) as UserRow);
  }

  requestPasswordReset(email: string, ip?: string | null): { devLink: string | null } {
    const user = this.findByEmail(email);
    if (user && !user.blocked_at) {
      this.issueEmailToken(user.id, user.email, 'reset_password');
      recordAudit(this.db, {
        actorUserId: user.id,
        actorRole: 'user',
        action: 'user.password_reset_requested',
        targetType: 'user',
        targetId: user.id,
        ip: ip ?? null,
        now: this.now(),
      });
    }
    // Always the same answer so the endpoint cannot be used to enumerate emails.
    return { devLink: user ? this.devLinkFor(email) : null };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) throw AppError.badRequest('password must be at least 8 characters');
    const user = this.consumeEmailToken(token, 'reset_password');
    const hash = await this.deps.hasher.hash(newPassword);
    const now = this.now();
    this.db.transaction(() => {
      this.db.run('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?', now, sha256(token));
      this.db.run(
        'UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?',
        hash,
        now,
        user.id,
      );
      recordAudit(this.db, {
        actorUserId: user.id,
        actorRole: 'user',
        action: 'user.password_reset',
        targetType: 'user',
        targetId: user.id,
        now,
      });
    });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<UserRow> {
    const user = this.findById(userId);
    if (!user) throw AppError.unauthorized('User no longer exists');
    if (!(await this.verifyPassword(user, currentPassword))) {
      throw new AppError('INVALID_CREDENTIALS', 401, 'Current password is incorrect');
    }
    if (newPassword.length < 8) throw AppError.badRequest('password must be at least 8 characters');
    const hash = await this.deps.hasher.hash(newPassword);
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        'UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?',
        hash,
        now,
        userId,
      );
      recordAudit(this.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'user.password_changed',
        targetType: 'user',
        targetId: userId,
        now,
      });
    });
    return this.findById(userId) as UserRow;
  }

  setDisplayCurrency(userId: string, currency: Currency): PublicUser {
    this.db.run('UPDATE users SET display_currency = ?, updated_at = ? WHERE id = ?', currency, this.now(), userId);
    return toPublicUser(this.findById(userId) as UserRow);
  }

  /** Revokes every issued token for this user. */
  logoutEverywhere(userId: string): void {
    this.db.run('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?', this.now(), userId);
  }

  setBlocked(userId: string, blocked: boolean, reason: string | null, actorUserId: string, ip?: string | null): PublicUser {
    const user = this.findById(userId);
    if (!user) throw AppError.notFound('User not found');
    if (user.role === 'admin' && blocked) throw AppError.forbidden('Admin accounts cannot be blocked');
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE users SET blocked_at = ?, blocked_reason = ?, token_version = token_version + 1, updated_at = ?
         WHERE id = ?`,
        blocked ? now : null,
        blocked ? reason : null,
        now,
        userId,
      );
      recordAudit(this.db, {
        actorUserId,
        actorRole: 'admin',
        action: blocked ? 'admin.user_blocked' : 'admin.user_unblocked',
        targetType: 'user',
        targetId: userId,
        meta: { reason },
        ip: ip ?? null,
        now,
      });
    });
    return toPublicUser(this.findById(userId) as UserRow);
  }

  list(opts: { search?: string; limit?: number; offset?: number }): { users: UserRow[]; total: number } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const search = opts.search?.trim();
    if (search) {
      const like = `%${search.toLowerCase()}%`;
      const rows = this.db.all<UserRow>(
        `SELECT * FROM users WHERE email_normalized LIKE ? OR username_normalized LIKE ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        like,
        like,
        limit,
        offset,
      );
      const total = this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM users WHERE email_normalized LIKE ? OR username_normalized LIKE ?',
        like,
        like,
      );
      return { users: rows, total: Number(total?.n ?? 0) };
    }
    const rows = this.db.all<UserRow>('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset);
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return { users: rows, total: Number(total?.n ?? 0) };
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
