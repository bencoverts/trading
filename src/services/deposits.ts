import type { Database } from '../db/sqlite.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { toMajor, toMinor } from '../domain/money.js';
import type { Currency } from '../domain/constants.js';
import type { WalletService } from './wallets.js';
import type { CurrencyService } from './currencies.js';
import type { NotificationService } from './notifications.js';
import type { KlikQrisClient, ProviderTransaction } from '../payments/klikqris.js';
import { recordAudit } from './audit.js';

export type DepositStatus = 'pending' | 'paid' | 'expired' | 'failed' | 'cancelled' | 'review' | 'rejected';
export type DepositMethod = 'klikqris' | 'manual';

export interface DepositRow {
  id: string;
  user_id: string;
  currency: Currency;
  method: DepositMethod;
  amount_minor: number;
  unique_amount_minor: number | null;
  total_amount_minor: number | null;
  fee_minor: number;
  status: DepositStatus;
  provider: string | null;
  provider_order_id: string | null;
  provider_status: string | null;
  qris_url: string | null;
  qris_image: string | null;
  report_url: string | null;
  provider_signature: string | null;
  expires_at: number | null;
  paid_at: number | null;
  credited_at: number | null;
  idempotency_key: string | null;
  proof_path: string | null;
  reference: string | null;
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DepositView {
  id: string;
  orderId: string | null;
  currency: Currency;
  method: DepositMethod;
  amount: number;
  amountMinor: number;
  uniqueAmount: number | null;
  /** what the user actually has to pay (the provider's total_amount) */
  totalAmount: number | null;
  totalAmountMinor: number | null;
  status: DepositStatus;
  providerStatus: string | null;
  qrisUrl: string | null;
  qrisImage: string | null;
  reportUrl: string | null;
  expiresAt: number | null;
  paidAt: number | null;
  creditedAt: number | null;
  reference: string | null;
  note: string | null;
  proofUrl: string | null;
  createdAt: number;
  simulation: true;
}

function viewOf(row: DepositRow): DepositView {
  const money = (minor: number | null) => (minor === null ? null : toMajor(Number(minor), row.currency));
  return {
    id: row.id,
    orderId: row.provider_order_id,
    currency: row.currency,
    method: row.method,
    amount: toMajor(Number(row.amount_minor), row.currency),
    amountMinor: Number(row.amount_minor),
    uniqueAmount: money(row.unique_amount_minor),
    totalAmount: money(row.total_amount_minor),
    totalAmountMinor: row.total_amount_minor === null ? null : Number(row.total_amount_minor),
    status: row.status,
    providerStatus: row.provider_status,
    qrisUrl: row.qris_url,
    qrisImage: row.qris_image,
    reportUrl: row.report_url,
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    paidAt: row.paid_at === null ? null : Number(row.paid_at),
    creditedAt: row.credited_at === null ? null : Number(row.credited_at),
    reference: row.reference,
    note: row.note,
    proofUrl: row.proof_path,
    createdAt: Number(row.created_at),
    simulation: true,
  };
}

export interface DepositServiceDeps {
  db: Database;
  currencies: CurrencyService;
  wallets: WalletService;
  notifications: NotificationService;
  client: KlikQrisClient;
  now?: () => number;
  /** push a realtime event to the owning user */
  push?: (userId: string, message: Record<string, unknown>) => void;
}

const TERMINAL: DepositStatus[] = ['paid', 'expired', 'failed', 'cancelled', 'rejected'];
const CHECK_COOLDOWN_MS = 3_000;
const DEFAULT_EXPIRY_MS = 15 * 60_000;

/**
 * Deposits through KlikQRIS plus manual (review-only) deposits.
 *
 * Invariants:
 *  - a deposit is credited exactly once (`status = 'paid'` claim inside the tx);
 *  - the amount credited is the provider's `total_amount` (what the user paid);
 *  - callbacks must be signed, matched by order id and amount, and are logged;
 *  - when the provider is not configured we fail loudly instead of faking one.
 */
export class DepositService {
  private readonly now: () => number;
  private readonly lastCheck = new Map<string, number>();

  constructor(private readonly deps: DepositServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get db(): Database {
    return this.deps.db;
  }

  get client(): KlikQrisClient {
    return this.deps.client;
  }

  private requireRow(id: string): DepositRow {
    const row = this.db.get<DepositRow>('SELECT * FROM payment_deposits WHERE id = ?', id);
    if (!row) throw AppError.notFound('Deposit tidak ditemukan');
    return row;
  }

  view(row: DepositRow): DepositView {
    return viewOf(row);
  }

  getForUser(userId: string, id: string): DepositView {
    const row = this.db.get<DepositRow>('SELECT * FROM payment_deposits WHERE id = ? AND user_id = ?', id, userId);
    if (!row) throw AppError.notFound('Deposit tidak ditemukan');
    return viewOf(row);
  }

  listForUser(userId: string, opts: { limit?: number } = {}): DepositView[] {
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
    return this.db
      .all<DepositRow>(
        'SELECT * FROM payment_deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        userId,
        limit,
      )
      .map(viewOf);
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
  ): { items: DepositView[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status && filters.status !== 'all') {
      where.push('d.status = ?');
      params.push(filters.status);
    }
    if (filters.currency) {
      where.push('d.currency = ?');
      params.push(filters.currency);
    }
    if (filters.userId) {
      where.push('d.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.query) {
      where.push('(d.id LIKE ? OR d.provider_order_id LIKE ? OR d.reference LIKE ? OR u.email LIKE ?)');
      const like = `%${filters.query}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const rows = this.db.all<DepositRow & { user_email: string }>(
      `SELECT d.*, u.email AS user_email FROM payment_deposits d JOIN users u ON u.id = d.user_id
       ${whereSql} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payment_deposits d JOIN users u ON u.id = d.user_id ${whereSql}`,
      ...params,
    );
    return {
      items: rows.map((row) => ({ ...viewOf(row), userEmail: row.user_email })),
      total: Number(total?.n ?? 0),
    };
  }

  stats(): Array<{ status: string; count: number; totalMinor: number }> {
    return this.db.all(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(COALESCE(total_amount_minor, amount_minor)), 0) AS totalMinor
         FROM payment_deposits GROUP BY status`,
    );
  }

  /** Creates a KlikQRIS transaction; nothing is credited until the provider says paid. */
  async createQris(
    userId: string,
    input: { currency: string; amount: number; idempotencyKey?: string | null },
    ip?: string | null,
  ): Promise<{ deposit: DepositView; reused: boolean }> {
    const currencyRow = this.deps.currencies.requireEnabled(input.currency, 'deposit');
    if (input.idempotencyKey) {
      const existing = this.db.get<DepositRow>(
        'SELECT * FROM payment_deposits WHERE user_id = ? AND idempotency_key = ?',
        userId,
        input.idempotencyKey,
      );
      if (existing) return { deposit: viewOf(existing), reused: true };
    }
    const amountMinor = Math.round(toMinor(input.amount, currencyRow.code));
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw AppError.badRequest('Nominal deposit tidak valid');
    }
    if (currencyRow.min_deposit_minor != null && amountMinor < currencyRow.min_deposit_minor) {
      throw AppError.unprocessable(
        'AMOUNT_NOT_ALLOWED',
        `Minimum deposit ${toMajor(currencyRow.min_deposit_minor, currencyRow.code)} ${currencyRow.code}`,
        {
          minMinor: currencyRow.min_deposit_minor,
        },
      );
    }
    if (currencyRow.max_deposit_minor != null && amountMinor > currencyRow.max_deposit_minor) {
      throw AppError.unprocessable(
        'AMOUNT_NOT_ALLOWED',
        `Maksimum deposit ${toMajor(currencyRow.max_deposit_minor, currencyRow.code)} ${currencyRow.code}`,
        {
          maxMinor: currencyRow.max_deposit_minor,
        },
      );
    }
    if (!this.deps.client.configured) {
      throw new AppError(
        'PAYMENT_NOT_CONFIGURED',
        503,
        'KlikQRIS belum dikonfigurasi. Hubungi admin atau gunakan deposit manual bila tersedia.',
      );
    }

    const id = newId();
    const providerOrderId = `DEP-${this.now().toString(36).toUpperCase()}-${id.slice(0, 6).toUpperCase()}`;
    const at = this.now();
    this.db.run(
      `INSERT INTO payment_deposits
        (id, user_id, currency, method, amount_minor, status, provider, provider_order_id,
         idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'klikqris', ?, 'pending', 'klikqris', ?, ?, ?, ?)`,
      id,
      userId,
      currencyRow.code,
      amountMinor,
      providerOrderId,
      input.idempotencyKey ?? null,
      at,
      at,
    );

    let tx: ProviderTransaction;
    try {
      tx = await this.deps.client.createTransaction({
        orderId: providerOrderId,
        amountMinor,
        description: `Deposit ${currencyRow.code} ${providerOrderId}`,
      });
    } catch (error) {
      this.db.run(
        `UPDATE payment_deposits SET status = 'failed', provider_status = ?, note = ?, updated_at = ? WHERE id = ?`,
        'create_failed',
        (error as Error).message.slice(0, 200),
        this.now(),
        id,
      );
      throw error;
    }

    const expiresAt = tx.expiredAt ?? at + DEFAULT_EXPIRY_MS;
    this.db.run(
      `UPDATE payment_deposits
          SET unique_amount_minor = ?, total_amount_minor = ?, provider_status = ?, qris_url = ?, qris_image = ?,
              report_url = ?, provider_signature = ?, expires_at = ?, updated_at = ?
        WHERE id = ?`,
      tx.uniqueAmountMinor,
      tx.totalAmountMinor,
      tx.status,
      tx.qrisUrl,
      tx.qrisImage,
      tx.reportUrl,
      tx.signature,
      expiresAt,
      this.now(),
      id,
    );
    recordAudit(this.db, {
      actorUserId: userId,
      actorRole: 'user',
      action: 'deposit.created',
      targetType: 'deposit',
      targetId: id,
      meta: { orderId: providerOrderId, amountMinor, totalMinor: tx.totalAmountMinor, provider: 'klikqris' },
      ip: ip ?? null,
      now: this.now(),
    });
    return { deposit: viewOf(this.requireRow(id)), reused: false };
  }

  /** Manual deposit: only an admin can turn this into a balance. */
  createManual(
    userId: string,
    input: { currency: string; amount: number; reference: string; note?: string | null; proofPath?: string | null },
    ip?: string | null,
  ): DepositView {
    const currencyRow = this.deps.currencies.requireEnabled(input.currency, 'deposit');
    const amountMinor = Math.round(toMinor(input.amount, currencyRow.code));
    if (amountMinor <= 0) throw AppError.badRequest('Nominal deposit tidak valid');
    if (currencyRow.min_deposit_minor != null && amountMinor < currencyRow.min_deposit_minor) {
      throw AppError.unprocessable('AMOUNT_NOT_ALLOWED', 'Nominal di bawah minimum deposit');
    }
    if (currencyRow.max_deposit_minor != null && amountMinor > currencyRow.max_deposit_minor) {
      throw AppError.unprocessable('AMOUNT_NOT_ALLOWED', 'Nominal di atas maksimum deposit');
    }
    const reference = input.reference.trim().slice(0, 120);
    if (reference.length < 4) throw AppError.badRequest('Referensi pembayaran wajib diisi');
    const duplicate = this.db.get<DepositRow>(
      `SELECT * FROM payment_deposits WHERE reference = ? AND status IN ('review', 'paid') LIMIT 1`,
      reference,
    );
    if (duplicate) {
      throw new AppError('PAYMENT_ALREADY_PAID', 409, 'Referensi pembayaran sudah pernah diajukan');
    }
    const id = newId();
    const at = this.now();
    this.db.run(
      `INSERT INTO payment_deposits
        (id, user_id, currency, method, amount_minor, status, reference, note, proof_path, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, 'review', ?, ?, ?, ?, ?)`,
      id,
      userId,
      currencyRow.code,
      amountMinor,
      reference,
      input.note?.slice(0, 300) ?? null,
      input.proofPath ?? null,
      at,
      at,
    );
    recordAudit(this.db, {
      actorUserId: userId,
      actorRole: 'user',
      action: 'deposit.manual_submitted',
      targetType: 'deposit',
      targetId: id,
      meta: { amountMinor, reference },
      ip: ip ?? null,
      now: at,
    });
    return viewOf(this.requireRow(id));
  }

  /**
   * Exposes the status check to the user-facing "Periksa status" button with a
   * small cooldown so a click-spam cannot hammer the provider.
   */
  async checkStatus(userId: string, id: string): Promise<DepositView> {
    const row = this.requireRow(id);
    if (row.user_id !== userId) throw AppError.notFound('Deposit tidak ditemukan');
    if (TERMINAL.includes(row.status)) return viewOf(row);
    const last = this.lastCheck.get(id) ?? 0;
    const now = this.now();
    if (now - last < CHECK_COOLDOWN_MS) {
      throw new AppError('COOLDOWN', 429, 'Tunggu beberapa detik sebelum memeriksa lagi', {
        nextAllowedAt: last + CHECK_COOLDOWN_MS,
      });
    }
    this.lastCheck.set(id, now);
    if (row.method !== 'klikqris' || !row.provider_order_id) return viewOf(row);
    if (!this.deps.client.configured) {
      throw new AppError('PAYMENT_NOT_CONFIGURED', 503, 'KlikQRIS belum dikonfigurasi');
    }
    let tx: ProviderTransaction;
    try {
      tx = await this.deps.client.statusOnce(row.provider_order_id);
    } catch (error) {
      this.recordCallback({ row, verified: false, accepted: false, reason: (error as Error).message, payload: null });
      throw error;
    }
    return this.applyProviderState(row, tx, 'status_check', null);
  }

  /**
   * Applies a provider transaction. Idempotent: only a `pending` deposit can
   * become `paid`, and the credit happens inside one transaction.
   */
  private applyProviderState(
    row: DepositRow,
    tx: ProviderTransaction,
    source: 'callback' | 'status_check' | 'reconcile',
    ip: string | null,
  ): DepositView {
    const now = this.now();
    if (row.status === 'paid') return viewOf(row);
    if (TERMINAL.includes(row.status)) {
      throw new AppError('PAYMENT_EXPIRED', 409, 'Transaksi sudah tidak aktif', { status: row.status });
    }
    const expected = Number(row.total_amount_minor ?? row.amount_minor);
    if (tx.totalAmountMinor !== expected && tx.amountMinor !== Number(row.amount_minor)) {
      this.recordCallback({
        row,
        verified: true,
        accepted: false,
        reason: `amount_mismatch expected=${expected} got=${tx.totalAmountMinor}/${tx.amountMinor}`,
        payload: tx.raw,
      });
      throw new AppError('AMOUNT_MISMATCH', 409, 'Nominal pembayaran tidak cocok dengan tagihan', {
        expectedMinor: expected,
      });
    }

    if (tx.status === 'paid') {
      this.db.transaction(() => {
        const claimed = this.db.run(
          `UPDATE payment_deposits SET status = 'paid', provider_status = ?, paid_at = ?, credited_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
          tx.status,
          tx.createdAt ?? this.now(),
          this.now(),
          this.now(),
          row.id,
        );
        if (claimed.changes === 0) return; // lost the race: another worker credited it
        this.deps.wallets.credit(row.user_id, row.currency, Number(row.total_amount_minor ?? row.amount_minor), {
          kind: 'deposit',
          refType: 'deposit',
          refId: row.id,
          note: `Deposit via ${row.method}`,
        });
        const notification = this.deps.notifications.create({
          userId: row.user_id,
          kind: 'deposit_paid',
          title: 'Deposit berhasil',
          body: `Saldo ${row.currency} bertambah ${toMajor(Number(row.total_amount_minor ?? row.amount_minor), row.currency)}`,
          link: '/transactions',
        });
        this.deps.push?.(row.user_id, { type: 'notification', notification });
        this.deps.push?.(row.user_id, { type: 'deposit:updated', deposit: viewOf(this.requireRow(row.id)) });
      });
      this.recordCallback({ row, verified: true, accepted: true, reason: `${source}:paid`, payload: tx.raw, ip });
      return viewOf(this.requireRow(row.id));
    }

    if (tx.status === 'expired' || tx.status === 'failed' || tx.status === 'cancelled') {
      this.db.run(
        `UPDATE payment_deposits SET status = ?, provider_status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
        tx.status,
        tx.status,
        now,
        row.id,
      );
      this.recordCallback({
        row,
        verified: true,
        accepted: true,
        reason: `${source}:${tx.status}`,
        payload: tx.raw,
        ip,
      });
      return viewOf(this.requireRow(row.id));
    }

    this.db.run(`UPDATE payment_deposits SET provider_status = ?, updated_at = ? WHERE id = ?`, tx.status, now, row.id);
    this.recordCallback({ row, verified: true, accepted: true, reason: `${source}:${tx.status}`, payload: tx.raw, ip });
    return viewOf(this.requireRow(row.id));
  }

  /** Webhook entry point. Signature + amount + order id are all mandatory. */
  handleCallback(input: { payload: Record<string, unknown>; signature: string | null; ip: string | null }): {
    ok: true;
    duplicate: boolean;
    deposit: DepositView;
  } {
    const orderId = String(input.payload.order_id ?? input.payload.orderId ?? '').slice(0, 120);
    const status = String(input.payload.status ?? '').toLowerCase();
    const amount = Number(input.payload.total_amount ?? input.payload.amount ?? 0);
    if (!orderId || !status || !Number.isFinite(amount)) {
      throw AppError.badRequest('Payload callback tidak lengkap');
    }
    const row = this.db.get<DepositRow>('SELECT * FROM payment_deposits WHERE provider_order_id = ?', orderId);
    if (!row) {
      this.recordCallback({
        row: null,
        orderId,
        verified: false,
        accepted: false,
        reason: 'unknown order',
        payload: input.payload,
        ip: input.ip,
      });
      throw AppError.notFound('Order tidak dikenal');
    }
    const signature = input.signature ?? '';
    const verified = this.deps.client.verifyCallbackSignature({
      orderId,
      status,
      amountMinor: Math.round(amount),
      signature,
    });
    if (!verified) {
      this.recordCallback({
        row,
        verified: false,
        accepted: false,
        reason: 'signature',
        payload: input.payload,
        ip: input.ip,
      });
      throw new AppError('SIGNATURE_INVALID', 401, 'Signature callback tidak valid');
    }
    if (row.status === 'paid') {
      this.recordCallback({
        row,
        verified: true,
        accepted: true,
        reason: 'duplicate',
        payload: input.payload,
        ip: input.ip,
      });
      return { ok: true, duplicate: true, deposit: viewOf(row) };
    }
    const mapped = { ...input.payload, status, total_amount: amount };
    const tx = this.parseCallback(mapped);
    if (tx.status === 'paid') {
      const deposit = this.applyProviderState(row, tx, 'callback', input.ip);
      return { ok: true, duplicate: false, deposit };
    }
    // Non-paid statuses still update the local state (expired/failed), never credit.
    const deposit = this.applyProviderState(row, tx, 'callback', input.ip);
    return { ok: true, duplicate: false, deposit };
  }

  /** Re-uses the provider parser but keeps callback handling self-contained. */
  private parseCallback(payload: Record<string, unknown>): ProviderTransaction {
    const orderId = String(payload.order_id ?? payload.orderId ?? '');
    const amount = Number(payload.amount ?? 0);
    const total = Number(payload.total_amount ?? amount);
    return {
      orderId,
      amountMinor: Math.round(amount),
      totalAmountMinor: Math.round(total),
      uniqueAmountMinor: payload.amount_uniq == null ? null : Math.round(Number(payload.amount_uniq)),
      status: normalizeStatus(String(payload.status ?? '')),
      qrisUrl: null,
      qrisImage: null,
      reportUrl: null,
      signature: null,
      expiredAt: null,
      createdAt: null,
      raw: payload,
    };
  }

  private recordCallback(input: {
    row: DepositRow | null;
    orderId?: string;
    verified: boolean;
    accepted: boolean;
    reason: string;
    payload: Record<string, unknown> | null;
    ip?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO payment_callbacks (deposit_id, provider, order_id, signature, verified, accepted, reason, payload, ip, created_at)
       VALUES (?, 'klikqris', ?, NULL, ?, ?, ?, ?, ?, ?)`,
      input.row?.id ?? null,
      input.orderId ?? input.row?.provider_order_id ?? null,
      input.verified ? 1 : 0,
      input.accepted ? 1 : 0,
      input.reason.slice(0, 300),
      input.payload ? JSON.stringify(input.payload).slice(0, 4000) : null,
      input.ip ?? null,
      this.now(),
    );
  }

  /** Marks stale pending deposits as expired; called by a job and on read. */
  expireStale(limit = 200): number {
    const now = this.now();
    const rows = this.db.all<DepositRow>(
      `SELECT * FROM payment_deposits WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ? LIMIT ?`,
      now,
      limit,
    );
    let expired = 0;
    for (const row of rows) {
      const result = this.db.run(
        `UPDATE payment_deposits SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'`,
        now,
        row.id,
      );
      if (result.changes > 0) {
        expired += 1;
        this.deps.push?.(row.user_id, {
          type: 'deposit:updated',
          deposit: viewOf(this.requireRow(row.id)),
        });
      }
    }
    return expired;
  }

  /** Admin review of a manual deposit. Crediting happens only on approve. */
  reviewManual(
    id: string,
    action: 'approve' | 'reject',
    ctx: { actorUserId: string; reason?: string | null; ip?: string | null },
  ): DepositView {
    const row = this.requireRow(id);
    if (row.method !== 'manual') throw AppError.badRequest('Hanya deposit manual yang dapat direview');
    if (row.status !== 'review') {
      throw new AppError('WITHDRAWAL_INVALID_STATUS', 409, 'Deposit tidak berada pada status review', {
        status: row.status,
      });
    }
    if (action === 'reject' && (!ctx.reason || ctx.reason.trim().length < 5)) {
      throw AppError.badRequest('Alasan penolakan wajib diisi (minimal 5 karakter)');
    }
    const now = this.now();
    if (action === 'reject') {
      this.db.run(
        `UPDATE payment_deposits SET status = 'rejected', note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
        ctx.reason?.slice(0, 300) ?? null,
        ctx.actorUserId,
        now,
        now,
        id,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.deposit_rejected',
        targetType: 'deposit',
        targetId: id,
        meta: { reason: ctx.reason },
        ip: ctx.ip ?? null,
        now,
      });
      this.deps.notifications.create({
        userId: row.user_id,
        kind: 'deposit_rejected',
        title: 'Deposit manual ditolak',
        body: ctx.reason?.slice(0, 300) ?? null,
        link: '/transactions',
      });
      return viewOf(this.requireRow(id));
    }

    this.db.transaction(() => {
      const claimed = this.db.run(
        `UPDATE payment_deposits SET status = 'paid', paid_at = ?, credited_at = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'review'`,
        now,
        now,
        ctx.actorUserId,
        now,
        now,
        id,
      );
      if (claimed.changes === 0) throw new AppError('PAYMENT_ALREADY_PAID', 409, 'Deposit sudah diproses');
      this.deps.wallets.credit(row.user_id, row.currency, Number(row.amount_minor), {
        kind: 'deposit',
        refType: 'deposit',
        refId: id,
        note: 'Deposit manual disetujui admin',
      });
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.deposit_approved',
        targetType: 'deposit',
        targetId: id,
        meta: { amountMinor: Number(row.amount_minor), reference: row.reference, reason: ctx.reason },
        ip: ctx.ip ?? null,
        now,
      });
      this.deps.notifications.create({
        userId: row.user_id,
        kind: 'deposit_paid',
        title: 'Deposit manual disetujui',
        body: `Saldo ${row.currency} bertambah ${toMajor(Number(row.amount_minor), row.currency)}`,
        link: '/transactions',
      });
    });
    this.deps.push?.(row.user_id, {
      type: 'deposit:updated',
      deposit: viewOf(this.requireRow(id)),
    });
    return viewOf(this.requireRow(id));
  }

  callbacks(limit = 100): Array<Record<string, unknown>> {
    return this.db.all('SELECT * FROM payment_callbacks ORDER BY id DESC LIMIT ?', Math.min(Math.max(limit, 1), 500));
  }

  /**
   * Compares the provider history with local deposits. Read-only: it reports
   * mismatches so an operator can decide what to reconcile.
   */
  async reconcile(limit = 50): Promise<{
    checked: number;
    providerOnly: number;
    localOnlyPending: number;
    amountMismatch: number;
    configured: boolean;
  }> {
    if (!this.deps.client.configured) {
      return { checked: 0, providerOnly: 0, localOnlyPending: 0, amountMismatch: 0, configured: false };
    }
    const history = await this.deps.client.history({ limit });
    let providerOnly = 0;
    let amountMismatch = 0;
    for (const item of history) {
      const row = this.db.get<DepositRow>('SELECT * FROM payment_deposits WHERE provider_order_id = ?', item.orderId);
      if (!row) {
        providerOnly += 1;
        continue;
      }
      const expected = Number(row.total_amount_minor ?? row.amount_minor);
      if (item.amountMinor !== expected && item.amountMinor !== Number(row.amount_minor)) amountMismatch += 1;
    }
    const localOnlyPending = Number(
      this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payment_deposits WHERE status = 'pending'`)?.n ?? 0,
    );
    return { checked: history.length, providerOnly, localOnlyPending, amountMismatch, configured: true };
  }
}

function normalizeStatus(status: string): string {
  const key = status.toLowerCase();
  if (['paid', 'success', 'settlement', 'settled', 'completed'].includes(key)) return 'paid';
  if (['expired', 'expire'].includes(key)) return 'expired';
  if (['failed', 'failure'].includes(key)) return 'failed';
  if (['cancel', 'cancelled', 'canceled'].includes(key)) return 'cancelled';
  return key || 'pending';
}
