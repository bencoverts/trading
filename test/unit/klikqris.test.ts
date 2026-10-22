import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KlikQrisClient,
  mapProviderStatus,
  parseTransaction,
  type KlikQrisTransport,
} from '../../src/payments/klikqris.js';
import { AppError } from '../../src/lib/errors.js';

const options = {
  baseUrl: 'https://klikqris.test/api',
  apiKey: 'test-key-abcdef',
  merchantId: 'M-12345',
  webhookSecret: 'unit-test-webhook-secret',
  signatureHeader: 'x-callback-signature',
  timeoutMs: 1_000,
};

const signed = (orderId: string, status: string, amount: number) =>
  createHmac('sha256', options.webhookSecret)
    .update(`${orderId}|${status}|${amount}|${options.merchantId}`)
    .digest('hex');

describe('KlikQRIS response parsing', () => {
  it('maps provider statuses to the internal set', () => {
    expect(mapProviderStatus('PAID')).toBe('paid');
    expect(mapProviderStatus('settlement')).toBe('paid');
    expect(mapProviderStatus('expired')).toBe('expired');
    expect(mapProviderStatus('cancel')).toBe('cancelled');
    expect(mapProviderStatus('weird')).toBe('weird');
    expect(mapProviderStatus(undefined)).toBe('pending');
  });

  it('reads the documented fields including total_amount and amount_uniq', () => {
    const tx = parseTransaction({
      order_id: 'DEP-1',
      amount: 50_000,
      total_amount: 50_123,
      amount_uniq: 123,
      status: 'pending',
      qris_url: 'https://qris.test/abc',
      qris_image: 'https://qris.test/abc.png',
      report_url: 'https://qris.test/report',
      expired_at: '2026-10-22T16:00:00.000Z',
      created_at: 1_792_680_000,
    });
    expect(tx.orderId).toBe('DEP-1');
    expect(tx.totalAmountMinor).toBe(50_123);
    expect(tx.uniqueAmountMinor).toBe(123);
    expect(tx.qrisUrl).toContain('qris.test');
    expect(tx.reportUrl).toContain('report');
    expect(tx.expiredAt).toBe(Date.parse('2026-10-22T16:00:00.000Z'));
  });

  it('accepts nested payloads but rejects responses without order id or amount', () => {
    const nested = parseTransaction({ data: { order_id: 'X-1', amount: 10_000, status: 'paid' } });
    expect(nested.orderId).toBe('X-1');
    expect(nested.totalAmountMinor).toBe(10_000);
    expect(() => parseTransaction({ status: 'paid' })).toThrow(AppError);
    expect(() => parseTransaction(null)).toThrow(AppError);
  });
});

describe('KlikQRIS callback signatures', () => {
  it('accepts a correct HMAC and rejects tampering', () => {
    const client = new KlikQrisClient(options);
    const signature = signed('DEP-1', 'paid', 50_123);
    expect(client.verifyCallbackSignature({ orderId: 'DEP-1', status: 'paid', amountMinor: 50_123, signature })).toBe(
      true,
    );
    expect(client.verifyCallbackSignature({ orderId: 'DEP-1', status: 'paid', amountMinor: 50_124, signature })).toBe(
      false,
    );
    expect(client.verifyCallbackSignature({ orderId: 'DEP-2', status: 'paid', amountMinor: 50_123, signature })).toBe(
      false,
    );
    expect(
      client.verifyCallbackSignature({ orderId: 'DEP-1', status: 'paid', amountMinor: 50_123, signature: 'x' }),
    ).toBe(false);
  });

  it('refuses to verify anything when no webhook secret is configured', () => {
    const client = new KlikQrisClient({ ...options, webhookSecret: undefined });
    const signature = signed('DEP-1', 'paid', 50_123);
    expect(client.verifyCallbackSignature({ orderId: 'DEP-1', status: 'paid', amountMinor: 50_123, signature })).toBe(
      false,
    );
    expect(client.describe().webhookSecretSet).toBe(false);
  });

  it('never exposes the API key or the full merchant id', () => {
    const described = new KlikQrisClient(options).describe();
    expect(JSON.stringify(described)).not.toContain(options.apiKey);
    expect(JSON.stringify(described)).not.toContain('M-12345');
    expect(described.merchantIdMasked).toContain('*');
    expect(described.apiKeySet).toBe(true);
  });
});

describe('KlikQRIS client behaviour', () => {
  it('fails loudly when credentials are missing', async () => {
    const client = new KlikQrisClient({ ...options, apiKey: undefined, merchantId: undefined });
    await expect(
      client.createTransaction({ orderId: 'X', amountMinor: 10_000, description: 'x' }),
    ).rejects.toMatchObject({
      code: 'PAYMENT_NOT_CONFIGURED',
    });
  });

  it('sends the API key only in a server-side header and validates the response', async () => {
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const transport: KlikQrisTransport = async (input) => {
      captured = { url: input.url, headers: input.headers, body: input.body };
      return {
        status: 200,
        text: '',
        json: { order_id: 'DEP-9', amount: 25_000, total_amount: 25_077, status: 'pending', qris_url: 'https://q' },
      };
    };
    const client = new KlikQrisClient(options, transport);
    const tx = await client.createTransaction({ orderId: 'DEP-9', amountMinor: 25_000, description: 'top up' });
    expect(tx.totalAmountMinor).toBe(25_077);
    expect(captured!.headers['x-api-key']).toBe(options.apiKey);
    expect((captured!.body as { id_merchant: string }).id_merchant).toBe(options.merchantId);
  });

  it('turns non-2xx responses and invalid payloads into provider errors', async () => {
    const failing: KlikQrisTransport = async () => ({ status: 500, json: { message: 'boom' }, text: 'boom' });
    await expect(
      new KlikQrisClient(options, failing).createTransaction({ orderId: 'A', amountMinor: 1_000, description: 'x' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });

    const garbage: KlikQrisTransport = async () => ({ status: 200, json: { hello: 'world' }, text: '' });
    await expect(
      new KlikQrisClient(options, garbage).createTransaction({ orderId: 'A', amountMinor: 1_000, description: 'x' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
  });

  it('coalesces concurrent status checks for the same order', async () => {
    let calls = 0;
    const transport: KlikQrisTransport = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: 200, json: { order_id: 'O-1', amount: 1000, status: 'pending' }, text: '' };
    };
    const client = new KlikQrisClient(options, transport);
    await Promise.all([client.statusOnce('O-1'), client.statusOnce('O-1'), client.statusOnce('O-1')]);
    expect(calls).toBe(1);
  });
});
