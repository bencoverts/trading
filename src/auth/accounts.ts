import type { Database } from '../db/sqlite.js';
import type { StaffRole } from './permissions.js';
import { AppError } from '../lib/errors.js';
import { newId, sha256 } from '../lib/ids.js';

export interface AccountRow {
  id: string;
  user_id: string;
  token_version: number;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface Account {
  id: string;
  userId: string;
  tokenVersion: number;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface AccountServiceDeps {
  db: Database;
  now?: () => number;
}

const deviceLabel = (userAgent: string | null): string => {
  if (!userAgent) return 'Perangkat tidak dikenal';
  const ua = userAgent.toLowerCase();
  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('chrome')
      ? 'Chrome'
      : ua.includes('safari') && !ua.includes('chrome')
        ? 'Safari'
        : ua.includes('firefox')
          ? 'Firefox'
          : 'Browser';
  const os = ua.includes('android')
    ? 'Android'
    : ua.includes('iphone') || ua.includes('ipad')
      ? 'iOS'
      : ua.includes('windows')
        ? 'Windows'
        : ua.includes('mac os')
          ? 'macOS'
          : ua.includes('linux')
            ? 'Linux'
            : 'Perangkat';
  return `${browser} · ${os}`;
};

/**
 * Server-side session registry. The JWT carries a session id; revoking the row
 * (or bumping the user's token_version) invalidates the token immediately.
 */
export class AccountService {
  private readonly now: () => number;

  constructor(private readonly deps: AccountServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get db(): Database {
    return this.deps.db;
  }

  create(input: {
    userId: string;
    tokenVersion: number;
    ttlMs: number;
    ip?: string | null;
    userAgent?: string | null;
  }): Account {
    const now = this.now();
    const id = newId();
    this.db.run(
      `INSERT INTO sessions (id, user_id, token_version, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.tokenVersion,
      input.ip ?? null,
      input.userAgent ?? null,
      now,
      now,
      now + input.ttlMs,
    );
    return {
      id,
      userId: input.userId,
      tokenVersion: input.tokenVersion,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + input.ttlMs,
    };
  }

  touch(sessionId: string, minIntervalMs = 30_000): void {
    const now = this.now();
    this.db.run(
      'UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?',
      now,
      sessionId,
      now - minIntervalMs,
    );
  }

  active(sessionId: string): AccountRow | undefined {
    const row = this.db.get<AccountRow>('SELECT * FROM sessions WHERE id = ?', sessionId);
    if (!row) return undefined;
    const now = this.now();
    if (row.revoked_at !== null || row.expires_at <= now) return undefined;
    return row;
  }

  listForUser(userId: string, currentSessionId?: string | null): Array<Account & { current: boolean; device: string }> {
    const now = this.now();
    const rows = this.db.all<AccountRow>(
      `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_seen_at DESC LIMIT 50`,
      userId,
      now,
    );
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      tokenVersion: row.token_version,
      ip: row.ip,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      current: row.id === currentSessionId,
      device: deviceLabel(row.user_agent),
    }));
  }

  revoke(sessionId: string, reason = 'logout'): void {
    this.db.run(
      'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
      this.now(),
      reason,
      sessionId,
    );
  }

  revokeAll(userId: string, reason: string, exceptSessionId?: string | null): number {
    const now = this.now();
    const result = exceptSessionId
      ? this.db.run(
          'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?',
          now,
          reason,
          userId,
          exceptSessionId,
        )
      : this.db.run(
          'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
          now,
          reason,
          userId,
        );
    return result.changes;
  }

  /** Fingerprint stored in the CSRF cookie so the token is bound to a browser. */
  csrfFor(sessionId: string, secret: string): string {
    return sha256(`${sessionId}:${secret}`);
  }

  requireActive(sessionId: string): AccountRow {
    const row = this.active(sessionId);
    if (!row) throw AppError.unauthorized('Sesi sudah berakhir, silakan login lagi', 'SESSION_REVOKED');
    return row;
  }

  countActive(userId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
      userId,
      this.now(),
    );
    return Number(row?.n ?? 0);
  }
}

export type { StaffRole };
