import type { Tx } from '../db/types.js';

export interface AuditEntry {
  userId?: string | null;
  actor: 'user' | 'admin' | 'system';
  action: string;
  tradeId?: string | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
}

/** Append-only audit trail; must be called inside the same transaction as the change. */
export async function recordAudit(t: Tx, entry: AuditEntry, now = Date.now()): Promise<void> {
  await t.run(
    `INSERT INTO audit_log (user_id, actor, action, trade_id, meta, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId ?? null,
      entry.actor,
      entry.action,
      entry.tradeId ?? null,
      entry.meta ? JSON.stringify(entry.meta) : null,
      entry.ip ?? null,
      now,
    ],
  );
}
