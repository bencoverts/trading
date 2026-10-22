import type { Database } from '../db/sqlite.js';

export type ActorRole = 'guest' | 'user' | 'admin' | 'system';

export interface AuditInput {
  actorUserId?: string | null;
  actorRole: ActorRole;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
  now?: number;
}

/** Append-only audit trail. Call inside the same transaction as the change it records. */
export function recordAudit(db: Database, input: AuditInput): void {
  db.run(
    `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, meta, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.actorUserId ?? null,
    input.actorRole,
    input.action,
    input.targetType ?? null,
    input.targetId ?? null,
    input.meta ? JSON.stringify(input.meta) : null,
    input.ip ?? null,
    input.now ?? Date.now(),
  );
}

export interface AuditRow {
  id: number;
  actor_user_id: string | null;
  actor_role: ActorRole;
  action: string;
  target_type: string | null;
  target_id: string | null;
  meta: string | null;
  ip: string | null;
  created_at: number;
}
