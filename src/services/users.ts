import type { Database } from '../db/sqlite.js';
import type { PasswordHasher } from '../auth/passwords.js';
import type { Mailer } from './mailer.js';
import type { SettingsService } from './settings.js';
import type { StaffRole } from '../auth/permissions.js';
import { recordAudit } from './audit.js';
import { AppError } from '../lib/errors.js';
import { newId, newToken, sha256 } from '../lib/ids.js';
import { hashRecoveryCode, verifyTotp } from '../auth/totp.js';
import { CURRENCY_LIST, type Currency, type Language } from '../domain/constants.js';

export interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  role: 'user' | 'admin';
  staff_role: StaffRole | null;
  display_name: string | null;
  avatar_path: string | null;
  language: Language;
  timezone: string;
  terms_accepted_at: number | null;
  email_verified_at: number | null;
  blocked_at: number | null;
  blocked_reason: string | null;
  display_currency: Currency;
  token_version: number;
  totp_secret: string | null;
  totp_enabled: number;
  totp_recovery_hashes: string | null;
  failed_login_count: number;
  locked_until: number | null;
  last_login_at: number | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  role: 'user' | 'admin';
  staffRole: StaffRole | null;
  avatarUrl: string | null;
  language: Language;
  timezone: string;
  emailVerified: boolean;
  blocked: boolean;
  blockedReason: string | null;
  twoFactorEnabled: boolean;
  displayCurrency: Currency;
  termsAcceptedAt: number | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export const toPublicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  email: row.email,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  staffRole: row.staff_role,
  avatarUrl: row.avatar_path ? `/uploads/${row.avatar_path}` : null,
  language: row.language,
  timezone: row.timezone,
  emailVerified: row.email_verified_at !== null,
  blocked: row.blocked_at !== null,
  blockedReason: row.blocked_reason,
  twoFactorEnabled: row.totp_enabled === 1,
  displayCurrency: row.display_currency,
  termsAcceptedAt: row.terms_accepted_at,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
});

export interface UserServiceDeps {
  db: Database;
  hasher: PasswordHasher;
  mailer: Mailer;
  settings: SettingsService;
  publicUrl: string;
  exposeDevTokens: boolean;
  verifyTtlMs?: number;
  resetTtlMs?: number;
  now?: () => number;
  loginMaxAttempts?: number;
  loginLockMs?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;

export interface LoginResult {
  user: UserRow;
  requiresTotp: boolean;
}

export class UserService {
  private readonly now: () => number;

  constructor(private readonly deps: UserServiceDeps) {
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

  findByIdentifier(identifier: string): UserRow | undefined {
    const value = normalize(identifier);
    return (
      this.db.get<UserRow>('SELECT * FROM users WHERE email_normalized = ?', value) ??
      this.db.get<UserRow>('SELECT * FROM users WHERE username_normalized = ?', value)
    );
  }

  async register(input: {
    email: string;
    username: string;
    password: string;
    acceptTerms: boolean;
    ip?: string | null;
    userAgent?: string | null;
    language?: Language;
  }): Promise<UserRow> {
    const email = input.email.trim();
    const username = input.username.trim();
    if (!EMAIL_RE.test(email)) throw AppError.badRequest('Email tidak valid');
    if (!USERNAME_RE.test(username)) {
      throw AppError.badRequest('Username 3-24 karakter: huruf, angka, titik, minus, atau garis bawah');
    }
    if (input.password.length < 8) throw AppError.badRequest('Password minimal 8 karakter');
    if (!input.acceptTerms) throw AppError.badRequest('Kamu harus menyetujui syarat dan ketentuan');
    if (this.findByEmail(email)) throw AppError.conflict('Email sudah terdaftar', 'EMAIL_TAKEN');
    if (this.findByUsername(username)) throw AppError.conflict('Username sudah dipakai', 'USERNAME_TAKEN');

    const hash = await this.deps.hasher.hash(input.password);
    const now = this.now();
    const id = newId();
    const settings = this.deps.settings.get();

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, role,
                            email_verified_at, display_currency, token_version, created_at, updated_at,
                            terms_accepted_at, language, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, 'user', NULL, 'USD', 0, ?, ?, ?, ?, ?)`,
        id,
        email,
        normalize(email),
        username,
        normalize(username),
        hash,
        now,
        now,
        now,
        input.language ?? 'id',
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

  /** Password + lockout + optional TOTP. Failures are written to login_history. */
  async authenticate(input: {
    identifier: string;
    password: string;
    totpCode?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<LoginResult> {
    const now = this.now();
    const user = this.findByIdentifier(input.identifier);
    const log = (success: boolean, reason: string | null, userId: string | null) => {
      this.db.run(
        'INSERT INTO login_history (user_id, identifier, success, reason, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        userId,
        input.identifier,
        success ? 1 : 0,
        reason,
        input.ip ?? null,
        input.userAgent ?? null,
        now,
      );
    };

    if (!user) {
      await this.deps.hasher.hash('timing-placeholder');
      log(false, 'unknown_user', null);
      throw new AppError('INVALID_CREDENTIALS', 401, 'Email/username atau password salah');
    }
    if (user.locked_until && user.locked_until > now) {
      log(false, 'locked', user.id);
      throw new AppError('ACCOUNT_LOCKED', 423, 'Terlalu banyak percobaan login. Coba lagi nanti.', {
        until: user.locked_until,
      });
    }
    if (user.blocked_at) {
      log(false, 'blocked', user.id);
      throw new AppError('ACCOUNT_BLOCKED', 403, 'Akun ini diblokir oleh admin', { reason: user.blocked_reason });
    }

    const ok = await this.deps.hasher.verify(user.password_hash, input.password);
    if (!ok) {
      const attempts = user.failed_login_count + 1;
      const max = this.deps.loginMaxAttempts ?? 8;
      const lockMs = this.deps.loginLockMs ?? 15 * 60_000;
      const lock = attempts >= max ? now + lockMs : null;
      this.db.run(
        'UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?',
        lock ? 0 : attempts,
        lock,
        now,
        user.id,
      );
      log(false, lock ? 'locked_now' : 'bad_password', user.id);
      if (lock) {
        throw new AppError('ACCOUNT_LOCKED', 423, 'Terlalu banyak percobaan login. Akun dikunci sementara.', {
          until: lock,
        });
      }
      throw new AppError('INVALID_CREDENTIALS', 401, 'Email/username atau password salah');
    }

    if (user.totp_enabled === 1) {
      if (!input.totpCode) {
        log(false, 'totp_required', user.id);
        return { user, requiresTotp: true };
      }
      const validTotp = user.totp_secret ? verifyTotp(user.totp_secret, input.totpCode) : false;
      const recoveryOk = !validTotp && this.consumeRecoveryCode(user, input.totpCode);
      if (!validTotp && !recoveryOk) {
        log(false, 'bad_totp', user.id);
        throw new AppError('INVALID_TOTP', 401, 'Kode 2FA salah', { totpRequired: true });
      }
    }

    this.db.run(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?',
      now,
      now,
      now,
      user.id,
    );
    log(true, null, user.id);
    return { user: this.findById(user.id) as UserRow, requiresTotp: false };
  }

  private consumeRecoveryCode(user: UserRow, code: string): boolean {
    if (!user.totp_recovery_hashes) return false;
    let hashes: string[];
    try {
      hashes = JSON.parse(user.totp_recovery_hashes) as string[];
    } catch {
      return false;
    }
    const provided = hashRecoveryCode(code);
    if (!hashes.includes(provided)) return false;
    const remaining = hashes.filter((hash) => hash !== provided);
    this.db.run('UPDATE users SET totp_recovery_hashes = ? WHERE id = ?', JSON.stringify(remaining), user.id);
    recordAudit(this.db, {
      actorUserId: user.id,
      actorRole: user.role === 'admin' ? 'admin' : 'user',
      action: 'user.recovery_code_used',
      targetType: 'user',
      targetId: user.id,
      meta: { remaining: remaining.length },
      now: this.now(),
    });
    return true;
  }

  touchSeen(userId: string): void {
    this.db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', this.now(), userId);
  }

  issueEmailToken(userId: string, email: string, purpose: 'verify_email' | 'reset_password'): string {
    const token = newToken();
    const now = this.now();
    const ttl =
      purpose === 'verify_email' ? (this.deps.verifyTtlMs ?? 24 * 3600_000) : (this.deps.resetTtlMs ?? 3600_000);
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
      subject: purpose === 'verify_email' ? 'Verifikasi akun demo kamu' : 'Reset password akun demo',
      body: `Buka tautan ini untuk ${purpose === 'verify_email' ? 'verifikasi email' : 'membuat password baru'}: ${link}`,
      link,
    });
    return token;
  }

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
      throw new AppError('INVALID_TOKEN', 400, 'Tautan tidak valid atau sudah kedaluwarsa');
    }
    const user = this.findById(row.user_id);
    if (!user) throw new AppError('INVALID_TOKEN', 400, 'Tautan tidak valid atau sudah kedaluwarsa');
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
    return { devLink: user ? this.devLinkFor(email) : null };
  }

  async resetPassword(token: string, newPassword: string): Promise<UserRow> {
    if (newPassword.length < 8) throw AppError.badRequest('Password minimal 8 karakter');
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
    return this.findById(user.id) as UserRow;
  }

  /** Verifies a plain password against the stored hash (used by 2FA disable / re-auth). */
  async verifyPassword(user: UserRow, password: string): Promise<boolean> {
    return this.deps.hasher.verify(user.password_hash, password);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<UserRow> {
    const user = this.findById(userId);
    if (!user) throw AppError.unauthorized('User tidak ditemukan');
    if (!(await this.deps.hasher.verify(user.password_hash, currentPassword))) {
      throw new AppError('INVALID_CREDENTIALS', 401, 'Password saat ini salah');
    }
    if (newPassword.length < 8) throw AppError.badRequest('Password minimal 8 karakter');
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

  updateProfile(
    userId: string,
    patch: {
      displayName?: string | null;
      language?: Language;
      timezone?: string;
      displayCurrency?: Currency;
      avatarPath?: string | null;
    },
  ): PublicUser {
    const user = this.findById(userId);
    if (!user) throw AppError.notFound('User tidak ditemukan');
    this.db.run(
      `UPDATE users SET display_name = ?, language = ?, timezone = ?, display_currency = ?, avatar_path = ?, updated_at = ?
       WHERE id = ?`,
      patch.displayName === undefined ? user.display_name : patch.displayName,
      patch.language ?? user.language,
      patch.timezone ?? user.timezone,
      patch.displayCurrency ?? user.display_currency,
      patch.avatarPath === undefined ? user.avatar_path : patch.avatarPath,
      this.now(),
      userId,
    );
    return toPublicUser(this.findById(userId) as UserRow);
  }

  setDisplayCurrency(userId: string, currency: Currency): PublicUser {
    this.db.run('UPDATE users SET display_currency = ?, updated_at = ? WHERE id = ?', currency, this.now(), userId);
    return toPublicUser(this.findById(userId) as UserRow);
  }

  /** Revokes every issued token for this user (all devices). */
  logoutEverywhere(userId: string, reason = 'logout_all'): void {
    this.db.transaction(() => {
      this.db.run(
        'UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?',
        this.now(),
        userId,
      );
      recordAudit(this.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'user.logout_all',
        targetType: 'user',
        targetId: userId,
        meta: { reason },
        now: this.now(),
      });
    });
  }

  setBlocked(
    userId: string,
    blocked: boolean,
    reason: string | null,
    actor: { userId: string; role: 'user' | 'admin' | 'system' },
    ip?: string | null,
  ): PublicUser {
    const user = this.findById(userId);
    if (!user) throw AppError.notFound('User tidak ditemukan');
    if (user.staff_role === 'super_admin' && blocked) {
      throw AppError.forbidden('Akun super admin tidak bisa diblokir');
    }
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
        actorUserId: actor.userId,
        actorRole: actor.role,
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

  setStaffRole(
    userId: string,
    staffRole: StaffRole | null,
    actor: { userId: string; role: 'user' | 'admin' },
    ip?: string | null,
  ): PublicUser {
    const user = this.findById(userId);
    if (!user) throw AppError.notFound('User tidak ditemukan');
    const now = this.now();
    const role: 'user' | 'admin' = staffRole ? 'admin' : 'user';
    this.db.transaction(() => {
      this.db.run(
        'UPDATE users SET staff_role = ?, role = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?',
        staffRole,
        role,
        now,
        userId,
      );
      recordAudit(this.db, {
        actorUserId: actor.userId,
        actorRole: 'admin',
        action: 'admin.user_role_changed',
        targetType: 'user',
        targetId: userId,
        meta: { from: user.staff_role, to: staffRole },
        ip: ip ?? null,
        now,
      });
    });
    return toPublicUser(this.findById(userId) as UserRow);
  }

  list(opts: {
    search?: string;
    status?: 'all' | 'blocked' | 'verified' | 'unverified';
    role?: StaffRole | 'user';
    limit?: number;
    offset?: number;
  }): {
    users: UserRow[];
    total: number;
  } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.search) {
      const like = `%${opts.search.trim().toLowerCase()}%`;
      clauses.push(
        "(email_normalized LIKE ? OR username_normalized LIKE ? OR LOWER(COALESCE(display_name, '')) LIKE ?)",
      );
      params.push(like, like, like);
    }
    if (opts.status === 'blocked') clauses.push('blocked_at IS NOT NULL');
    if (opts.status === 'verified') clauses.push('email_verified_at IS NOT NULL');
    if (opts.status === 'unverified') clauses.push('email_verified_at IS NULL');
    if (opts.role === 'user') clauses.push('staff_role IS NULL');
    else if (opts.role) {
      clauses.push('staff_role = ?');
      params.push(opts.role);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.all<UserRow>(
      `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users ${where}`, ...params);
    return { users: rows, total: Number(total?.n ?? 0) };
  }

  notes(userId: string): Array<{ id: string; body: string; author: string | null; createdAt: number }> {
    const rows = this.db.all<{ id: string; body: string; created_at: number; username: string | null }>(
      `SELECT n.id, n.body, n.created_at, u.username FROM user_notes n
       LEFT JOIN users u ON u.id = n.author_id
       WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`,
      userId,
    );
    return rows.map((row) => ({ id: row.id, body: row.body, author: row.username, createdAt: row.created_at }));
  }

  addNote(userId: string, authorId: string, body: string): void {
    const trimmed = body.trim();
    if (trimmed.length < 2) throw AppError.badRequest('Catatan minimal 2 karakter');
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO user_notes (id, user_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
        newId(),
        userId,
        authorId,
        trimmed.slice(0, 2000),
        now,
      );
      recordAudit(this.db, {
        actorUserId: authorId,
        actorRole: 'admin',
        action: 'admin.user_note_added',
        targetType: 'user',
        targetId: userId,
        meta: { body: trimmed.slice(0, 200) },
        now,
      });
    });
  }

  loginHistory(
    userId: string,
    limit = 20,
  ): Array<{
    success: boolean;
    reason: string | null;
    ip: string | null;
    userAgent: string | null;
    createdAt: number;
  }> {
    const rows = this.db.all<{
      success: number;
      reason: string | null;
      ip: string | null;
      user_agent: string | null;
      created_at: number;
    }>(
      'SELECT success, reason, ip, user_agent, created_at FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      userId,
      limit,
    );
    return rows.map((row) => ({
      success: row.success === 1,
      reason: row.reason,
      ip: row.ip,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    }));
  }

  /** Stores the secret for a *pending* 2FA setup (not enabled until verified). */
  setPendingTotpSecret(userId: string, secret: string): void {
    this.db.run(
      'UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_recovery_hashes = NULL, updated_at = ? WHERE id = ?',
      secret,
      this.now(),
      userId,
    );
  }

  /** Re-issues the "verify your email" link for the signed-in user. */
  resendVerification(userId: string): { devLink: string | null } {
    const user = this.findById(userId);
    if (!user) throw AppError.notFound('User tidak ditemukan');
    if (user.email_verified_at) throw AppError.badRequest('Email sudah terverifikasi');
    this.issueEmailToken(user.id, user.email, 'verify_email');
    return { devLink: this.deps.exposeDevTokens ? this.devLinkFor(user.email) : null };
  }

  /** Called by the TOTP setup flow once the first code is verified. */
  enableTotp(userId: string, secret: string, recoveryHashes: string[]): void {
    this.db.run(
      'UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_recovery_hashes = ?, updated_at = ? WHERE id = ?',
      secret,
      JSON.stringify(recoveryHashes),
      this.now(),
      userId,
    );
    recordAudit(this.db, {
      actorUserId: userId,
      actorRole: 'user',
      action: 'user.totp_enabled',
      targetType: 'user',
      targetId: userId,
      now: this.now(),
    });
  }

  disableTotp(userId: string): void {
    this.db.run(
      'UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_recovery_hashes = NULL, updated_at = ? WHERE id = ?',
      this.now(),
      userId,
    );
    recordAudit(this.db, {
      actorUserId: userId,
      actorRole: 'user',
      action: 'user.totp_disabled',
      targetType: 'user',
      targetId: userId,
      now: this.now(),
    });
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
