import type { Database } from '../db/sqlite.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { toMajor, toMinor } from '../domain/money.js';
import type { Currency } from '../domain/constants.js';
import type { WalletService } from './wallets.js';
import type { CurrencyService } from './currencies.js';
import type { NotificationService } from './notifications.js';
import { recordAudit } from './audit.js';

export type WithdrawalStatus =
  'pending' | 'review' | 'approved' | 'processing' | 'completed' | 'rejected' | 'cancelled';

export const WITHDRAWAL_STATUSES: WithdrawalStatus[] = [
  'pending',
  'review',
  'approved',
  'processing',
  'completed',
  'rejected',
  'cancelled',
];

export interface WithdrawalRow {
  id: string;
  user_id: string;
  currency: Currency;
  method: string;
  amount_minor: number;
  fee_minor: number;
  net_minor: number;
  destination: string;
  destination_hash: string | null;
  status: WithdrawalStatus;
  reason: string | null;
  transfer_ref: string | null;
  proof_path: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  processed_by: string | null;
  processed_at: number | null;
  completed_at: number | null;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface WithdrawalView {
  id: string;
  currency: Currency;
  method: string;
  amount: number;
  amountMinor: number;
  fee: number;
  feeMinor: number;
  net: number;
  netMinor: number;
  status: WithdrawalStatus;
  destination: Record<string, unknown>;
  destinationMasked: string;
  reason: string | null;
  transferRef: string | null;
  proofUrl: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  processedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  canCancel: boolean;
  simulation: true;
}

export interface DestinationInput {
  bank?: string;
  accountNumber?: string;
  accountName?: string;
  provider?: string;
  phone?: string;
}

export interface WithdrawalServiceDeps {
  db: Database;
  currencies: CurrencyService;
  wallets: WalletService;
  notifications: NotificationService;
  now?: () => number;
  push?: (userId: string, message: Record<string, unknown>) => void;
}

const ALLOWED_METHODS = ['bank_transfer', 'ewallet'] as const;

function maskAccount(value: string | undefined): string {
  if (!value) return '';
  const clean = value.replace(/\s+/g, '');
  if (clean.length <= 4) return `••••${clean.slice(-2)}`;
  return `${'•'.repeat(Math.max(2, clean.length - 4))}${clean.slice(-4)}`;
}

function describeDestination(destination: Record<string, unknown>): string {
  if (destination.bank) {
    return `${String(destination.bank).toUpperCase()} ${maskAccount(destination.accountNumber as string)} a/n ${destination.accountName ?? '-'}`;
  }
  if (destination.provider) {
    return `${String(destination.provider)} ${maskAccount(destination.phone as string)}`;
  }
  return 'Tujuan tidak tersedia';
}

/** Deep-copies without mutating the stored row and strips PII for responses. */
function safeDestination(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...parsed,
      accountNumber: parsed.accountNumber ? maskAccount(parsed.accountNumber as string) : undefined,
      phone: parsed.phone ? maskAccount(parsed.phone as string) : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Withdrawal workflow with a locked-balance hold.
 *
 * Money never leaves the wallet twice: the request locks the amount, a rejection
 * releases it, and only a completion (`settleLocked`) turns the reservation into
 * a real debit. Each transition is appended to `withdrawal_events` and audited.
 */
export class WithdrawalService {
  private readonly now: () => number;

  constructor(private readonly deps: WithdrawalServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get db(): Database {
    return this.deps.db;
  }

  private requireRow(id: string): WithdrawalRow {
    const row = this.db.get<WithdrawalRow>('SELECT * FROM withdrawals WHERE id = ?', id);
    if (!row) throw AppError.notFound('Penarikan tidak ditemukan');
    return row;
  }

  view(row: WithdrawalRow): WithdrawalView {
    const destination = safeDestination(row.destination);
    return {
      id: row.id,
      currency: row.currency,
      method: row.method,
      amount: toMajor(Number(row.amount_minor), row.currency),
      amountMinor: Number(row.amount_minor),
      fee: toMajor(Number(row.fee_minor), row.currency),
      feeMinor: Number(row.fee_minor),
      net: toMajor(Number(row.net_minor), row.currency),
      netMinor: Number(row.net_minor),
      status: row.status,
      destination,
      destinationMasked: describeDestination(destination),
      reason: row.reason,
      transferRef: row.transfer_ref,
      proofUrl: row.proof_path,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at),
      processedAt: row.processed_at === null ? null : Number(row.processed_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      canCancel: row.status === 'pending',
      simulation: true,
    };
  }

  getForUser(userId: string, id: string): WithdrawalView {
    const row = this.db.get<WithdrawalRow>('SELECT * FROM withdrawals WHERE id = ? AND user_id = ?', id, userId);
    if (!row) throw AppError.notFound('Penarikan tidak ditemukan');
    return this.view(row);
  }

  listForUser(userId: string, limit = 50): WithdrawalView[] {
    return this.db
      .all<WithdrawalRow>(
        'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        userId,
        Math.min(Math.max(limit, 1), 200),
      )
      .map((row) => this.view(row));
  }

  listAll(
    filters: {
      status?: string;
      currency?: string;
      userId?: string;
      query?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): { items: WithdrawalView[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status && filters.status !== 'all') {
      where.push('w.status = ?');
      params.push(filters.status);
    }
    if (filters.currency) {
      where.push('w.currency = ?');
      params.push(filters.currency);
    }
    if (filters.userId) {
      where.push('w.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.query) {
      const like = `%${filters.query}%`;
      where.push('(w.id LIKE ? OR w.transfer_ref LIKE ? OR u.email LIKE ? OR u.username LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const rows = this.db.all<WithdrawalRow & { user_email: string }>(
      `SELECT w.*, u.email AS user_email FROM withdrawals w JOIN users u ON u.id = w.user_id ${whereSql}
        ORDER BY w.created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM withdrawals w JOIN users u ON u.id = w.user_id ${whereSql}`,
      ...params,
    );
    return {
      items: rows.map((row) => ({ ...this.view(row), userEmail: row.user_email })),
      total: Number(total?.n ?? 0),
    };
  }

  stats(): { pending: number; review: number; processing: number; completedMinor: number; rejected: number } {
    const byStatus = this.db.all<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM withdrawals GROUP BY status',
    );
    const count = (status: string) => Number(byStatus.find((row) => row.status === status)?.count ?? 0);
    const completed = this.db.get<{ totalMinor: number }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS totalMinor FROM withdrawals WHERE status = 'completed'`,
    );
    return {
      pending: count('pending'),
      review: count('review'),
      processing: count('processing'),
      completedMinor: Number(completed?.totalMinor ?? 0),
      rejected: count('rejected'),
    };
  }

  events(id: string): Array<Record<string, unknown>> {
    return this.db.all('SELECT * FROM withdrawal_events WHERE withdrawal_id = ? ORDER BY id', id);
  }

  quote(currency: string, amount: number): { amountMinor: number; feeMinor: number; netMinor: number } {
    const row = this.deps.currencies.get(currency);
    const amountMinor = Math.round(toMinor(amount, row.code));
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw AppError.badRequest('Nominal penarikan tidak valid');
    const feeMinor = Math.min(
      amountMinor - 1,
      Math.round(Number(row.withdrawal_fee_minor) + (amountMinor * Number(row.withdrawal_fee_bps)) / 10_000),
    );
    return { amountMinor, feeMinor: Math.max(0, feeMinor), netMinor: amountMinor - Math.max(0, feeMinor) };
  }

  request(
    userId: string,
    input: {
      currency: string;
      amount: number;
      method: string;
      destination: DestinationInput;
      idempotencyKey?: string | null;
    },
    ip?: string | null,
  ): WithdrawalView {
    const currencyRow = this.deps.currencies.requireEnabled(input.currency, 'withdrawal');
    if (!(ALLOWED_METHODS as readonly string[]).includes(input.method)) {
      throw AppError.badRequest('Metode penarikan tidak didukung');
    }
    if (input.idempotencyKey) {
      const existing = this.db.get<WithdrawalRow>(
        'SELECT * FROM withdrawals WHERE user_id = ? AND idempotency_key = ?',
        userId,
        input.idempotencyKey,
      );
      if (existing) return this.view(existing);
    }

    const destination = this.normalizeDestination(input.method, input.destination);
    const { amountMinor, feeMinor, netMinor } = this.quote(currencyRow.code, input.amount);
    if (netMinor <= 0) {
      throw AppError.unprocessable('AMOUNT_NOT_ALLOWED', 'Nominal terlalu kecil setelah biaya');
    }
    if (currencyRow.min_withdrawal_minor != null && amountMinor < currencyRow.min_withdrawal_minor) {
      throw AppError.unprocessable(
        'AMOUNT_NOT_ALLOWED',
        `Minimum penarikan ${toMajor(currencyRow.min_withdrawal_minor, currencyRow.code)} ${currencyRow.code}`,
        { minMinor: currencyRow.min_withdrawal_minor },
      );
    }
    if (currencyRow.max_withdrawal_minor != null && amountMinor > currencyRow.max_withdrawal_minor) {
      throw AppError.unprocessable(
        'AMOUNT_NOT_ALLOWED',
        `Maksimum penarikan ${toMajor(currencyRow.max_withdrawal_minor, currencyRow.code)} ${currencyRow.code}`,
        { maxMinor: currencyRow.max_withdrawal_minor },
      );
    }

    const id = newId();
    const at = this.now();
    this.db.transaction(() => {
      this.deps.wallets.lockFunds(userId, currencyRow.code, amountMinor, {
        refType: 'withdrawal',
        refId: id,
        note: 'Penarikan diajukan',
      });
      this.db.run(
        `INSERT INTO withdrawals
          (id, user_id, currency, method, amount_minor, fee_minor, net_minor, destination, status,
           idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        id,
        userId,
        currencyRow.code,
        input.method,
        amountMinor,
        feeMinor,
        netMinor,
        JSON.stringify(destination),
        input.idempotencyKey ?? null,
        at,
        at,
      );
      this.addEvent(id, null, 'pending', { actorUserId: userId, actorRole: 'user', reason: 'diajukan pengguna' });
      recordAudit(this.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'withdrawal.requested',
        targetType: 'withdrawal',
        targetId: id,
        meta: { currency: currencyRow.code, amountMinor, feeMinor, netMinor, method: input.method },
        ip: ip ?? null,
        now: at,
      });
    });

    const notification = this.deps.notifications.create({
      userId,
      kind: 'withdrawal_requested',
      title: 'Pengajuan penarikan diterima',
      body: `Menunggu review admin: ${toMajor(amountMinor, currencyRow.code)} ${currencyRow.code}`,
      link: '/transactions',
    });
    this.deps.push?.(userId, { type: 'notification', notification });
    this.deps.push?.(userId, { type: 'withdrawal:updated', withdrawal: this.view(this.requireRow(id)) });
    return this.view(this.requireRow(id));
  }

  private normalizeDestination(method: string, input: DestinationInput): Record<string, string> {
    if (method === 'bank_transfer') {
      const bank = (input.bank ?? '').trim();
      const accountNumber = (input.accountNumber ?? '').replace(/\s+/g, '');
      const accountName = (input.accountName ?? '').trim();
      if (bank.length < 2 || bank.length > 40) throw AppError.badRequest('Nama bank wajib diisi');
      if (!/^\d{6,20}$/.test(accountNumber)) throw AppError.badRequest('Nomor rekening tidak valid (6-20 digit)');
      if (accountName.length < 2 || accountName.length > 80)
        throw AppError.badRequest('Nama pemilik rekening wajib diisi');
      return { bank, accountNumber, accountName };
    }
    const provider = (input.provider ?? '').trim();
    const phone = (input.phone ?? '').replace(/[^\d+]/g, '');
    if (provider.length < 2 || provider.length > 40) throw AppError.badRequest('Penyedia e-wallet wajib diisi');
    if (!/^(\+?\d{8,15})$/.test(phone)) throw AppError.badRequest('Nomor e-wallet tidak valid');
    return { provider, phone };
  }

  cancel(userId: string, id: string, ip?: string | null): WithdrawalView {
    const row = this.db.get<WithdrawalRow>('SELECT * FROM withdrawals WHERE id = ? AND user_id = ?', id, userId);
    if (!row) throw AppError.notFound('Penarikan tidak ditemukan');
    if (row.status !== 'pending') {
      throw new AppError('WITHDRAWAL_INVALID_STATUS', 409, 'Penarikan sudah diproses dan tidak dapat dibatalkan', {
        status: row.status,
      });
    }
    const now = this.now();
    this.db.transaction(() => {
      const updated = this.db.run(
        `UPDATE withdrawals SET status = 'cancelled', reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
        'dibatalkan pengguna',
        now,
        id,
      );
      if (updated.changes === 0) throw new AppError('WITHDRAWAL_INVALID_STATUS', 409, 'Status berubah, coba lagi');
      this.deps.wallets.releaseFunds(userId, row.currency, Number(row.amount_minor), {
        refType: 'withdrawal',
        refId: id,
        note: 'Penarikan dibatalkan pengguna',
      });
      this.addEvent(id, 'pending', 'cancelled', { actorUserId: userId, actorRole: 'user', reason: 'dibatalkan' });
      recordAudit(this.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'withdrawal.cancelled',
        targetType: 'withdrawal',
        targetId: id,
        meta: { amountMinor: Number(row.amount_minor) },
        ip: ip ?? null,
        now,
      });
    });
    this.deps.push?.(userId, { type: 'withdrawal:updated', withdrawal: this.view(this.requireRow(id)) });
    return this.view(this.requireRow(id));
  }

  /**
   * Admin workflow. Every transition validates the current status first, so a
   * double click cannot release funds twice.
   */
  transition(
    id: string,
    action: 'review' | 'approve' | 'process' | 'complete' | 'reject',
    ctx: {
      actorUserId: string;
      reason?: string | null;
      transferRef?: string | null;
      proofPath?: string | null;
      ip?: string | null;
    },
  ): WithdrawalView {
    const row = this.requireRow(id);
    const now = this.now();
    const to: Record<typeof action, WithdrawalStatus> = {
      review: 'review',
      approve: 'approved',
      process: 'processing',
      complete: 'completed',
      reject: 'rejected',
    };
    const from: Record<typeof action, WithdrawalStatus[]> = {
      review: ['pending'],
      approve: ['pending', 'review'],
      process: ['approved', 'review'],
      complete: ['approved', 'processing'],
      reject: ['pending', 'review', 'approved', 'processing'],
    };
    if (!from[action].includes(row.status)) {
      throw new AppError('WITHDRAWAL_INVALID_STATUS', 409, `Tidak bisa ${action} dari status ${row.status}`, {
        status: row.status,
      });
    }
    if (action === 'reject' && (!ctx.reason || ctx.reason.trim().length < 5)) {
      throw AppError.badRequest('Alasan penolakan wajib diisi (minimal 5 karakter)');
    }
    if (action === 'complete' && (!ctx.transferRef || ctx.transferRef.trim().length < 3)) {
      throw AppError.badRequest('Referensi transfer wajib diisi sebelum menyelesaikan');
    }

    this.db.transaction(() => {
      const claimed = this.db.run(
        `UPDATE withdrawals SET status = ?, reason = COALESCE(?, reason), transfer_ref = COALESCE(?, transfer_ref),
                proof_path = COALESCE(?, proof_path), reviewed_by = CASE WHEN ? IN ('approved','rejected','review') THEN ? ELSE reviewed_by END,
                reviewed_at = CASE WHEN ? IN ('approved','rejected','review') THEN ? ELSE reviewed_at END,
                processed_by = CASE WHEN ? IN ('processing','completed') THEN ? ELSE processed_by END,
                processed_at = CASE WHEN ? IN ('processing','completed') THEN ? ELSE processed_at END,
                completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
                updated_at = ?
          WHERE id = ? AND status = ?`,
        to[action],
        ctx.reason?.slice(0, 300) ?? null,
        ctx.transferRef?.slice(0, 120) ?? null,
        ctx.proofPath ?? null,
        action,
        ctx.actorUserId,
        action,
        now,
        action,
        ctx.actorUserId,
        action,
        now,
        action,
        now,
        now,
        id,
        row.status,
      );
      if (claimed.changes === 0) throw new AppError('WITHDRAWAL_INVALID_STATUS', 409, 'Status berubah, coba lagi');

      if (action === 'reject') {
        this.deps.wallets.releaseFunds(row.user_id, row.currency, Number(row.amount_minor), {
          refType: 'withdrawal',
          refId: id,
          note: `Penarikan ditolak: ${ctx.reason}`,
        });
      }
      if (action === 'complete') {
        this.deps.wallets.settleLocked(row.user_id, row.currency, Number(row.amount_minor), {
          refType: 'withdrawal',
          refId: id,
          note: `Penarikan selesai (ref ${ctx.transferRef})`,
        });
      }
      this.addEvent(id, row.status, to[action], {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        reason: ctx.reason ?? null,
        meta: { transferRef: ctx.transferRef ?? null, proofPath: ctx.proofPath ?? null },
      });
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: `admin.withdrawal_${action}`,
        targetType: 'withdrawal',
        targetId: id,
        meta: {
          from: row.status,
          to: to[action],
          amountMinor: Number(row.amount_minor),
          reason: ctx.reason ?? null,
          transferRef: ctx.transferRef ?? null,
        },
        ip: ctx.ip ?? null,
        now,
      });
      const notification = this.deps.notifications.create({
        userId: row.user_id,
        kind: `withdrawal_${to[action]}`,
        title:
          action === 'reject'
            ? 'Penarikan ditolak'
            : action === 'complete'
              ? 'Penarikan selesai'
              : `Penarikan ${to[action]}`,
        body:
          action === 'reject'
            ? (ctx.reason ?? null)
            : action === 'complete'
              ? `Dana ${toMajor(Number(row.net_minor), row.currency)} ${row.currency} dikirim (ref ${ctx.transferRef})`
              : `Status penarikan: ${to[action]}`,
        link: '/transactions',
      });
      this.deps.push?.(row.user_id, { type: 'notification', notification });
    });
    this.deps.push?.(row.user_id, { type: 'withdrawal:updated', withdrawal: this.view(this.requireRow(id)) });
    return this.view(this.requireRow(id));
  }

  private addEvent(
    withdrawalId: string,
    fromStatus: string | null,
    toStatus: string,
    meta: { actorUserId: string; actorRole: string; reason?: string | null; meta?: Record<string, unknown> },
  ): void {
    this.db.run(
      `INSERT INTO withdrawal_events (withdrawal_id, from_status, to_status, actor_user_id, actor_role, reason, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      withdrawalId,
      fromStatus,
      toStatus,
      meta.actorUserId,
      meta.actorRole,
      meta.reason ?? null,
      meta.meta ? JSON.stringify(meta.meta) : null,
      this.now(),
    );
  }
}
