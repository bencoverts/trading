import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

/**
 * KlikQRIS API client.
 *
 * Only the backend talks to the provider. The API key never leaves the server:
 * it is read from the environment, attached to outbound requests, and redacted
 * from logs/errors. Amounts are sent in whole rupiah (the provider's minor unit
 * for IDR is 1), and every response is validated structurally before use.
 *
 * The signature scheme below is configurable because the provider's callback
 * documentation must be confirmed before production. The canonical string is
 * `order_id|status|amount|merchant_id`, signed with HMAC-SHA256 and sent as a
 * hex digest in `KLIKQRIS_SIGNATURE_HEADER`. If that does not match the real
 * documentation, only `verifyCallbackSignature` needs to change.
 */
export interface KlikQrisOptions {
  baseUrl: string;
  apiKey?: string;
  merchantId?: string;
  callbackUrl?: string;
  webhookSecret?: string;
  signatureHeader: string;
  timeoutMs: number;
  logger?: Logger;
}

export interface ProviderTransaction {
  orderId: string;
  amountMinor: number;
  totalAmountMinor: number;
  uniqueAmountMinor: number | null;
  status: string;
  qrisUrl: string | null;
  qrisImage: string | null;
  reportUrl: string | null;
  signature: string | null;
  expiredAt: number | null;
  createdAt: number | null;
  raw: Record<string, unknown>;
}

export interface CreateTransactionInput {
  orderId: string;
  amountMinor: number;
  description: string;
}

export interface ProviderHistoryItem {
  orderId: string;
  amountMinor: number;
  status: string;
  createdAt: number | null;
  raw: Record<string, unknown>;
}

/** Injectable transport so tests never reach the network. */
export type KlikQrisTransport = (input: {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}) => Promise<{ status: number; json: unknown; text: string }>;

const DEFAULT_STATUS_MAP: Record<string, string> = {
  paid: 'paid',
  success: 'paid',
  settlement: 'paid',
  settled: 'paid',
  completed: 'paid',
  pending: 'pending',
  unpaid: 'pending',
  waiting: 'pending',
  expired: 'expired',
  expire: 'expired',
  failed: 'failed',
  failure: 'failed',
  cancel: 'cancelled',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function toTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    // some providers nest the payload
    for (const container of ['data', 'result', 'transaction']) {
      const nested = obj[container];
      if (nested && typeof nested === 'object') {
        const value = (nested as Record<string, unknown>)[key];
        if (value !== undefined && value !== null && value !== '') return value;
      }
    }
  }
  return undefined;
}

/** Normalises the provider status into our internal terminal set. */
export function mapProviderStatus(status: unknown): string {
  const key = String(status ?? '').toLowerCase();
  return DEFAULT_STATUS_MAP[key] ?? (key || 'pending');
}

export function parseTransaction(raw: unknown, fallbackOrderId?: string): ProviderTransaction {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Respons penyedia pembayaran tidak valid');
  }
  const obj = raw as Record<string, unknown>;
  const orderId = str(pick(obj, ['order_id', 'orderId', 'id'])) ?? fallbackOrderId;
  const amount = toNumber(pick(obj, ['amount', 'nominal']));
  const total = toNumber(pick(obj, ['total_amount', 'totalAmount', 'total']));
  if (!orderId || amount === null || amount <= 0) {
    throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Respons pembayaran tidak memuat order_id/amount yang valid');
  }
  return {
    orderId,
    amountMinor: Math.round(amount),
    totalAmountMinor: Math.round(total ?? amount),
    uniqueAmountMinor: (() => {
      const uniq = toNumber(pick(obj, ['amount_uniq', 'unique_amount', 'amountUnique']));
      return uniq === null ? null : Math.round(uniq);
    })(),
    status: mapProviderStatus(pick(obj, ['status', 'transaction_status', 'payment_status'])),
    qrisUrl: str(pick(obj, ['qris_url', 'qrisUrl', 'payment_url'])),
    qrisImage: str(pick(obj, ['qris_image', 'qrisImage', 'qr_image'])),
    reportUrl: str(pick(obj, ['report_url', 'reportUrl'])),
    signature: str(pick(obj, ['signature'])),
    expiredAt: toTime(pick(obj, ['expired_at', 'expiredAt', 'expiry'])),
    createdAt: toTime(pick(obj, ['created_at', 'createdAt'])),
    raw: obj,
  };
}

export class KlikQrisClient {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly options: KlikQrisOptions,
    private readonly transport: KlikQrisTransport = defaultTransport,
  ) {}

  get configured(): boolean {
    return Boolean(this.options.apiKey && this.options.merchantId);
  }

  /** Safe status for the admin UI: booleans and a masked merchant id only. */
  describe(): {
    configured: boolean;
    baseUrl: string;
    merchantId: string | null;
    merchantIdMasked: string | null;
    callbackUrl: string | null;
    signatureHeader: string;
    webhookSecretSet: boolean;
    apiKeySet: boolean;
  } {
    const merchant = this.options.merchantId ?? null;
    return {
      configured: this.configured,
      baseUrl: this.options.baseUrl,
      merchantId: null,
      merchantIdMasked: merchant
        ? `${merchant.slice(0, 3)}${'*'.repeat(Math.max(3, merchant.length - 5))}${merchant.slice(-2)}`
        : null,
      callbackUrl: this.options.callbackUrl ?? null,
      signatureHeader: this.options.signatureHeader,
      webhookSecretSet: Boolean(this.options.webhookSecret),
      apiKeySet: Boolean(this.options.apiKey),
    };
  }

  private async call<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new AppError('PAYMENT_NOT_CONFIGURED', 503, 'KlikQRIS belum dikonfigurasi (API key / merchant ID kosong)');
    }
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-key': this.options.apiKey as string,
      id_merchant: this.options.merchantId as string,
    };
    let response: { status: number; json: unknown; text: string };
    try {
      response = await this.transport({ url, method, headers, body, timeoutMs: this.options.timeoutMs });
    } catch (error) {
      this.options.logger?.warn({ path, err: (error as Error).message }, 'klikqris request failed');
      throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'Tidak dapat menghubungi KlikQRIS');
    }
    if (response.status < 200 || response.status >= 300) {
      this.options.logger?.warn({ path, status: response.status }, 'klikqris rejected request');
      throw new AppError('PAYMENT_PROVIDER_ERROR', 502, 'KlikQRIS menolak permintaan', {
        providerStatus: response.status,
      });
    }
    return response.json as T;
  }

  /** Creates a QRIS transaction. The caller stores the *returned* total amount. */
  async createTransaction(input: CreateTransactionInput): Promise<ProviderTransaction> {
    const raw = await this.call<Record<string, unknown>>('/qris/create', 'POST', {
      order_id: input.orderId,
      amount: input.amountMinor,
      id_merchant: this.options.merchantId,
      keterangan: input.description,
      ...(this.options.callbackUrl ? { callback_url: this.options.callbackUrl } : {}),
    });
    const parsed = parseTransaction(raw, input.orderId);
    if (parsed.status === 'failed') {
      throw new AppError('PAYMENT_REJECTED', 502, 'KlikQRIS menolak transaksi', { orderId: parsed.orderId });
    }
    return parsed;
  }

  async status(orderId: string): Promise<ProviderTransaction> {
    const raw = await this.call<Record<string, unknown>>(`/qris/status/${encodeURIComponent(orderId)}`, 'GET');
    return parseTransaction(raw, orderId);
  }

  async history(params: { limit?: number } = {}): Promise<ProviderHistoryItem[]> {
    const raw = await this.call<unknown>('/qris/history', 'POST', { limit: params.limit ?? 50 });
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as Record<string, unknown>)?.data)
        ? ((raw as Record<string, unknown>).data as unknown[])
        : [];
    const items: ProviderHistoryItem[] = [];
    for (const entry of list) {
      try {
        const parsed = parseTransaction(entry);
        items.push({
          orderId: parsed.orderId,
          amountMinor: parsed.totalAmountMinor,
          status: parsed.status,
          createdAt: parsed.createdAt,
          raw: parsed.raw,
        });
      } catch {
        /* skip malformed rows rather than failing the whole sync */
      }
    }
    return items;
  }

  /** Simple coalescing so two "check status" clicks do not double-hit the API. */
  async statusOnce(orderId: string): Promise<ProviderTransaction> {
    const pending = this.inflight.get(`status:${orderId}`);
    if (pending) return pending as Promise<ProviderTransaction>;
    const promise = this.status(orderId).finally(() => this.inflight.delete(`status:${orderId}`));
    this.inflight.set(`status:${orderId}`, promise);
    return promise;
  }

  /** Test connection: cheap, read-only call used by the admin panel. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.configured) return { ok: false, message: 'API key / merchant ID belum diisi' };
    try {
      await this.call('/qris/history', 'POST', { limit: 1 });
      return { ok: true, message: 'Koneksi ke KlikQRIS berhasil' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /** Canonical string that the callback signature is computed over. */
  canonicalCallback(input: { orderId: string; status: string; amountMinor: number }): string {
    return `${input.orderId}|${input.status}|${input.amountMinor}|${this.options.merchantId ?? ''}`;
  }

  /**
   * Verifies a callback signature. Returns false when no secret is configured;
   * callers must treat that as "not verifiable" and reject the callback.
   */
  verifyCallbackSignature(input: { orderId: string; status: string; amountMinor: number; signature: string }): boolean {
    if (!this.options.webhookSecret) return false;
    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(this.canonicalCallback(input))
      .digest('hex');
    const given = input.signature
      .trim()
      .toLowerCase()
      .replace(/^sha256=/, '');
    if (given.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  signatureHeader(): string {
    return this.options.signatureHeader;
  }
}

/** Default transport using the global fetch (Node 18+/22). */
const defaultTransport: KlikQrisTransport = async ({ url, method, headers, body, timeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
};
