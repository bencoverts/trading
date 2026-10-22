import type { Database } from '../db/sqlite.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { NotificationService } from './notifications.js';

export type ChatStatus = 'open' | 'pending' | 'closed';
export type ChatPriority = 'low' | 'normal' | 'high';

export interface ConversationRow {
  id: string;
  user_id: string;
  subject: string;
  status: ChatStatus;
  priority: ChatPriority;
  assigned_to: string | null;
  last_message_at: number | null;
  last_message: string | null;
  unread_user: number;
  unread_staff: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_user_id: string | null;
  sender_role: 'user' | 'staff' | 'system';
  body: string;
  attachment_path: string | null;
  internal: number;
  client_id: string | null;
  created_at: number;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderRole: 'user' | 'staff' | 'system';
  senderUserId: string | null;
  body: string;
  attachmentUrl: string | null;
  internal: boolean;
  clientId: string | null;
  createdAt: number;
}

export interface ConversationView {
  id: string;
  userId: string;
  userEmail?: string | null;
  username?: string | null;
  subject: string;
  status: ChatStatus;
  priority: ChatPriority;
  assignedTo: string | null;
  lastMessage: string | null;
  lastMessageAt: number | null;
  unreadUser: number;
  unreadStaff: number;
  createdAt: number;
  updatedAt: number;
}

function conversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    userId: row.user_id,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assigned_to,
    lastMessage: row.last_message,
    lastMessageAt: row.last_message_at === null ? null : Number(row.last_message_at),
    unreadUser: Number(row.unread_user ?? 0),
    unreadStaff: Number(row.unread_staff ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function messageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderRole: row.sender_role,
    senderUserId: row.sender_user_id,
    body: row.body,
    attachmentUrl: row.attachment_path,
    internal: row.internal === 1,
    clientId: row.client_id,
    createdAt: Number(row.created_at),
  };
}

export interface ChatServiceDeps {
  db: Database;
  notifications: NotificationService;
  now?: () => number;
  push?: (userId: string, message: Record<string, unknown>) => void;
  pushStaff?: (message: Record<string, unknown>) => void;
}

const MAX_BODY = 2_000;

/**
 * Live-chat storage. Every message is persisted before it is broadcast, and the
 * conversation ownership checks live here (single source of truth) so a user can
 * never read or write another user's thread.
 */
export class ChatService {
  private readonly now: () => number;

  constructor(private readonly deps: ChatServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get db(): Database {
    return this.deps.db;
  }

  getForUser(userId: string, conversationId: string): ConversationRow {
    const row = this.db.get<ConversationRow>(
      'SELECT * FROM support_conversations WHERE id = ? AND user_id = ?',
      conversationId,
      userId,
    );
    if (!row) throw new AppError('CHAT_FORBIDDEN', 403, 'Percakapan ini bukan milik Anda');
    return row;
  }

  listForUser(userId: string): ConversationView[] {
    return this.db
      .all<ConversationRow>('SELECT * FROM support_conversations WHERE user_id = ? ORDER BY updated_at DESC', userId)
      .map(conversationView);
  }

  listAll(filters: { status?: string; query?: string; limit?: number } = {}): ConversationView[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status && filters.status !== 'all') {
      where.push('c.status = ?');
      params.push(filters.status);
    }
    if (filters.query) {
      const like = `%${filters.query}%`;
      where.push('(c.subject LIKE ? OR u.email LIKE ? OR u.username LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 80, 1), 200);
    const rows = this.db.all<ConversationRow & { user_email: string; username: string }>(
      `SELECT c.*, u.email AS user_email, u.username AS username
         FROM support_conversations c JOIN users u ON u.id = c.user_id
         ${whereSql} ORDER BY c.updated_at DESC LIMIT ?`,
      ...params,
      limit,
    );
    return rows.map((row) => ({
      ...conversationView(row),
      userEmail: row.user_email,
      username: row.username,
    }));
  }

  /** Returns the user's open conversation or creates one. */
  startConversation(userId: string, subject?: string): ConversationView {
    const existing = this.db.get<ConversationRow>(
      `SELECT * FROM support_conversations WHERE user_id = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 1`,
      userId,
    );
    if (existing) return conversationView(existing);
    const id = newId();
    const at = this.now();
    const title = (subject ?? 'Percakapan baru').trim().slice(0, 120) || 'Percakapan baru';
    this.db.run(
      `INSERT INTO support_conversations (id, user_id, subject, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, 'open', 'normal', ?, ?)`,
      id,
      userId,
      title,
      at,
      at,
    );
    this.deps.pushStaff?.({ type: 'chat:new', conversation: conversationView(this.requireConversation(id)) });
    return conversationView(this.requireConversation(id));
  }

  private requireConversation(id: string): ConversationRow {
    const row = this.db.get<ConversationRow>('SELECT * FROM support_conversations WHERE id = ?', id);
    if (!row) throw AppError.notFound('Percakapan tidak ditemukan');
    return row;
  }

  messagesForUser(userId: string, conversationId: string, afterId?: string): MessageView[] {
    this.getForUser(userId, conversationId);
    this.db.run('UPDATE support_conversations SET unread_user = 0 WHERE id = ?', conversationId);
    const rows = afterId
      ? this.db.all<MessageRow>(
          `SELECT * FROM support_messages WHERE conversation_id = ? AND internal = 0 AND id > ?
            ORDER BY created_at LIMIT 500`,
          conversationId,
          afterId,
        )
      : this.db.all<MessageRow>(
          `SELECT * FROM support_messages WHERE conversation_id = ? AND internal = 0 ORDER BY created_at LIMIT 500`,
          conversationId,
        );
    return rows.map(messageView);
  }

  messagesForStaff(conversationId: string): MessageView[] {
    this.requireConversation(conversationId);
    const rows = this.db.all<MessageRow>(
      'SELECT * FROM support_messages WHERE conversation_id = ? ORDER BY created_at LIMIT 1000',
      conversationId,
    );
    this.db.run('UPDATE support_conversations SET unread_staff = 0 WHERE id = ?', conversationId);
    return rows.map(messageView);
  }

  /**
   * Persists a message. `clientId` makes retries idempotent: the same client id
   * in the same conversation returns the stored message instead of duplicating.
   */
  send(input: {
    conversationId: string;
    userId?: string;
    staffUserId?: string;
    body: string;
    clientId?: string | null;
    attachmentPath?: string | null;
    internal?: boolean;
    staffName?: string | null;
  }): { message: MessageView; conversation: ConversationView } {
    const conversation = this.requireConversation(input.conversationId);
    const isStaff = Boolean(input.staffUserId);
    if (!isStaff && conversation.user_id !== input.userId) {
      throw new AppError('CHAT_FORBIDDEN', 403, 'Percakapan ini bukan milik Anda');
    }
    if (conversation.status === 'closed' && !isStaff) {
      throw new AppError('CHAT_FORBIDDEN', 403, 'Percakapan sudah ditutup');
    }
    const body = input.body.trim().slice(0, MAX_BODY);
    if (!body && !input.attachmentPath) throw AppError.badRequest('Pesan tidak boleh kosong');

    if (input.clientId) {
      const existing = this.db.get<MessageRow>(
        'SELECT * FROM support_messages WHERE conversation_id = ? AND client_id = ?',
        input.conversationId,
        input.clientId,
      );
      if (existing) {
        return { message: messageView(existing), conversation: conversationView(conversation) };
      }
    }

    const id = newId();
    const at = this.now();
    const role: MessageRow['sender_role'] = isStaff ? 'staff' : 'user';
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO support_messages (id, conversation_id, sender_user_id, sender_role, body, attachment_path, internal, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.conversationId,
        isStaff ? input.staffUserId : conversation.user_id,
        role,
        body,
        input.attachmentPath ?? null,
        input.internal ? 1 : 0,
        input.clientId ?? null,
        at,
      );
      const preview = body.length > 120 ? `${body.slice(0, 117)}...` : body;
      this.db.run(
        `UPDATE support_conversations
            SET updated_at = ?, last_message_at = ?, last_message = ?,
                unread_user = unread_user + ?, unread_staff = unread_staff + ?,
                status = CASE WHEN status = 'closed' AND ? = 1 THEN 'open' ELSE status END
          WHERE id = ?`,
        at,
        at,
        preview,
        isStaff && !input.internal ? 1 : 0,
        isStaff ? 0 : 1,
        isStaff ? 1 : 0,
        input.conversationId,
      );
    });

    const message = messageView(
      this.db.get<MessageRow>('SELECT * FROM support_messages WHERE id = ?', id) as MessageRow,
    );
    const updatedConversation = conversationView(this.requireConversation(input.conversationId));

    if (!input.internal) {
      if (isStaff) {
        this.deps.push?.(conversation.user_id, {
          type: 'chat:message',
          message,
          conversation: updatedConversation,
        });
        this.deps.notifications.create({
          userId: conversation.user_id,
          kind: 'chat_reply',
          title: 'Balasan dari support',
          body: previewOf(message.body),
          link: '/chat',
        });
      } else {
        this.deps.pushStaff?.({
          type: 'chat:message',
          message,
          conversation: updatedConversation,
        });
      }
    }
    return { message, conversation: updatedConversation };
  }

  setStatus(id: string, status: ChatStatus, ctx: { actorUserId: string }): ConversationView {
    this.requireConversation(id);
    const at = this.now();
    this.db.transaction(() => {
      this.db.run('UPDATE support_conversations SET status = ?, updated_at = ? WHERE id = ?', status, at, id);
      this.db.run(
        `INSERT INTO support_messages (id, conversation_id, sender_user_id, sender_role, body, internal, created_at)
         VALUES (?, ?, ?, 'system', ?, 0, ?)`,
        newId(),
        id,
        ctx.actorUserId,
        status === 'closed' ? 'Percakapan ditutup oleh support' : `Status percakapan: ${status}`,
        at,
      );
    });
    return conversationView(this.requireConversation(id));
  }

  assign(id: string, staffUserId: string | null): ConversationView {
    this.requireConversation(id);
    this.db.run(
      'UPDATE support_conversations SET assigned_to = ?, updated_at = ? WHERE id = ?',
      staffUserId,
      this.now(),
      id,
    );
    return conversationView(this.requireConversation(id));
  }

  setPriority(id: string, priority: ChatPriority): ConversationView {
    this.requireConversation(id);
    this.db.run('UPDATE support_conversations SET priority = ?, updated_at = ? WHERE id = ?', priority, this.now(), id);
    return conversationView(this.requireConversation(id));
  }
}

function previewOf(body: string): string {
  return body.length > 120 ? `${body.slice(0, 117)}...` : body;
}
