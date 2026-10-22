import type { Database } from '../db/sqlite.js';
import { newId } from '../lib/ids.js';

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: number | null;
  created_at: number;
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: number;
}

export class NotificationService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: {
    userId: string;
    kind: string;
    title: string;
    body?: string | null;
    link?: string | null;
  }): NotificationView {
    const row: NotificationRow = {
      id: newId(),
      user_id: input.userId,
      kind: input.kind,
      title: input.title.slice(0, 160),
      body: input.body?.slice(0, 500) ?? null,
      link: input.link ?? null,
      read_at: null,
      created_at: this.now(),
    };
    this.db.run(
      `INSERT INTO notifications (id, user_id, kind, title, body, link, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      row.id,
      row.user_id,
      row.kind,
      row.title,
      row.body,
      row.link,
      row.created_at,
    );
    return this.toView(row);
  }

  list(userId: string, limit = 30): { items: NotificationView[]; unread: number } {
    const rows = this.db.all<NotificationRow>(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      userId,
      Math.min(Math.max(limit, 1), 100),
    );
    const unread = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
      userId,
    );
    return { items: rows.map((row) => this.toView(row)), unread: Number(unread?.n ?? 0) };
  }

  markRead(userId: string, id: string | 'all'): number {
    const now = this.now();
    if (id === 'all') {
      const result = this.db.run(
        'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
        now,
        userId,
      );
      return result.changes;
    }
    const result = this.db.run(
      'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
      now,
      id,
      userId,
    );
    return result.changes;
  }

  /** Best-effort broadcast to a role group (used for announcements). */
  broadcast(userIds: string[], input: { kind: string; title: string; body?: string; link?: string }): number {
    let count = 0;
    this.db.transaction(() => {
      for (const userId of userIds) {
        this.create({ userId, ...input });
        count += 1;
      }
    });
    return count;
  }

  private toView(row: NotificationRow): NotificationView {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      read: row.read_at !== null,
      createdAt: row.created_at,
    };
  }
}
