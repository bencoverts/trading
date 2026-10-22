import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, login, registerUser, TEST_ADMIN, type TestContext } from '../helpers/app.js';
import type { KlikQrisTransport } from '../../src/payments/klikqris.js';

const SECRET = 'integration-webhook-secret-123';
const MERCHANT = 'M-INT-01';
const API_KEY = 'integration-api-key-123';

interface ProviderState {
  status: 'pending' | 'paid' | 'expired';
  total: number;
  creates: number;
  history: Array<{ order_id: string; amount: number; status: string }>;
}

let ctx: TestContext;
let state: ProviderState;

const sign = (orderId: string, status: string, amount: number) =>
  createHmac('sha256', SECRET).update(`${orderId}|${status}|${amount}|${MERCHANT}`).digest('hex');

const transport: KlikQrisTransport = async (input) => {
  if (input.url.endsWith('/qris/create')) {
    state.creates += 1;
    const body = input.body as { order_id: string; amount: number };
    state.total = body.amount + 77;
    return {
      status: 200,
      text: '',
      json: {
        order_id: body.order_id,
        amount: body.amount,
        total_amount: state.total,
        amount_uniq: 77,
        status: 'pending',
        qris_url: `https://qris.test/${body.order_id}`,
        qris_image: `https://qris.test/${body.order_id}.png`,
        report_url: `https://qris.test/report/${body.order_id}`,
        expired_at: Date.now() + 15 * 60_000,
      },
    };
  }
  if (input.url.includes('/qris/status/')) {
    const orderId = decodeURIComponent(input.url.split('/').pop() ?? '');
    return {
      status: 200,
      text: '',
      json: { order_id: orderId, amount: state.total, total_amount: state.total, status: state.status },
    };
  }
  if (input.url.endsWith('/qris/history')) {
    return { status: 200, text: '', json: { data: state.history } };
  }
  return { status: 404, json: { message: 'not found' }, text: '' };
};

const env = {
  PAYMENTS_ENABLED: 'true',
  KLIKQRIS_API_KEY: API_KEY,
  KLIKQRIS_MERCHANT_ID: MERCHANT,
  KLIKQRIS_WEBHOOK_SECRET: SECRET,
};

beforeAll(async () => {
  ctx = await createTestApp({ env, paymentTransport: transport });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(() => {
  state = { status: 'pending', total: 0, creates: 0, history: [] };
});

const walletOf = (userId: string, currency = 'IDR') => {
  const row = ctx.db.get<{ balance_minor: number; locked_minor: number }>(
    'SELECT balance_minor, locked_minor FROM wallets WHERE user_id = ? AND currency = ?',
    userId,
    currency,
  );
  return { balance: Number(row!.balance_minor), locked: Number(row!.locked_minor) };
};

describe('currency configuration', () => {
  it('enables IDR for deposits/withdrawals and keeps USD/USDT closed for money flows', async () => {
    const res = await ctx.api().get('/api/v1/currencies');
    expect(res.status).toBe(200);
    const all = res.body.all as Array<{
      code: string;
      active: boolean;
      depositEnabled: boolean;
      withdrawalEnabled: boolean;
      tradingEnabled: boolean;
    }>;
    const idr = all.find((row) => row.code === 'IDR')!;
    const usd = all.find((row) => row.code === 'USD')!;
    const usdt = all.find((row) => row.code === 'USDT')!;
    expect(idr).toMatchObject({ active: true, depositEnabled: true, withdrawalEnabled: true });
    expect(usd.depositEnabled).toBe(false);
    expect(usd.withdrawalEnabled).toBe(false);
    expect(usdt.active).toBe(false);
    expect(usdt.tradingEnabled).toBe(false);
  });
});

describe('KlikQRIS deposits', () => {
  it('refuses to create a transaction when the provider is not configured', async () => {
    const unconfigured = await createTestApp({ env: { PAYMENTS_ENABLED: 'true' } });
    try {
      const user = await registerUser(unconfigured);
      const res = await user.client.post('/api/v1/deposits', { currency: 'IDR', amount: 50_000 });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENT_NOT_CONFIGURED');
      expect(unconfigured.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payment_deposits')?.n).toBe(0);
    } finally {
      await unconfigured.close();
    }
  });

  it('creates a pending deposit with the provider total amount and never credits early', async () => {
    const user = await registerUser(ctx);
    const before = walletOf(user.userId);
    const res = await user.client.post(
      '/api/v1/deposits',
      { currency: 'IDR', amount: 50_000 },
      { idempotencyKey: 'dep-key-0001' },
    );
    expect(res.status).toBe(201);
    expect(res.body.deposit.status).toBe('pending');
    expect(res.body.deposit.totalAmount).toBe(50_077);
    expect(res.body.deposit.qrisUrl).toContain('qris.test');
    expect(res.body.deposit.expiresAt).toBeTruthy();
    expect(walletOf(user.userId).balance).toBe(before.balance);
    expect(state.creates).toBe(1);

    const replay = await user.client.post(
      '/api/v1/deposits',
      { currency: 'IDR', amount: 50_000 },
      { idempotencyKey: 'dep-key-0001' },
    );
    expect(replay.status).toBe(200);
    expect(replay.body.reused).toBe(true);
    expect(replay.body.deposit.id).toBe(res.body.deposit.id);
    expect(state.creates).toBe(1);
  });

  it('rejects an unsigned or tampered callback without touching the balance', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/deposits', { currency: 'IDR', amount: 30_000 });
    const orderId = created.body.deposit.orderId as string;
    const amount = created.body.deposit.totalAmountMinor as number;
    const before = walletOf(user.userId);

    const missing = await request(ctx.runtime.app)
      .post('/api/webhooks/klikqris')
      .send({ order_id: orderId, status: 'paid', total_amount: amount });
    expect(missing.status).toBe(401);

    const bad = await request(ctx.runtime.app)
      .post('/api/webhooks/klikqris')
      .set('x-callback-signature', 'deadbeef')
      .send({ order_id: orderId, status: 'paid', total_amount: amount });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('SIGNATURE_INVALID');
    expect(walletOf(user.userId).balance).toBe(before.balance);
  });

  it('credits exactly once on a valid paid callback and is idempotent on retries', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/deposits', { currency: 'IDR', amount: 40_000 });
    const orderId = created.body.deposit.orderId as string;
    const amount = created.body.deposit.totalAmountMinor as number;
    const before = walletOf(user.userId);

    const ok = await request(ctx.runtime.app)
      .post('/api/webhooks/klikqris')
      .set('x-callback-signature', sign(orderId, 'paid', amount))
      .send({ order_id: orderId, status: 'paid', total_amount: amount });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, duplicate: false });
    expect(walletOf(user.userId).balance).toBe(before.balance + amount);

    const again = await request(ctx.runtime.app)
      .post('/api/webhooks/klikqris')
      .set('x-callback-signature', sign(orderId, 'paid', amount))
      .send({ order_id: orderId, status: 'paid', total_amount: amount });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(walletOf(user.userId).balance).toBe(before.balance + amount);

    const ledgerRows = ctx.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ledger WHERE kind = 'deposit' AND ref_id = ?",
      created.body.deposit.id,
    );
    expect(Number(ledgerRows[0]?.n)).toBe(1);
  });

  it('refuses a callback whose amount does not match the invoice', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/deposits', { currency: 'IDR', amount: 20_000 });
    const orderId = created.body.deposit.orderId as string;
    const wrong = 1_000;
    const before = walletOf(user.userId);
    const res = await request(ctx.runtime.app)
      .post('/api/webhooks/klikqris')
      .set('x-callback-signature', sign(orderId, 'paid', wrong))
      .send({ order_id: orderId, status: 'paid', total_amount: wrong });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(walletOf(user.userId).balance).toBe(before.balance);
  });

  it('rejects an unknown order id and does not credit anything', async () => {
    const res = await request(ctx.runtime.app)
      .post('/api/webhooks/klikqris')
      .set('x-callback-signature', sign('DEP-UNKNOWN', 'paid', 10_000))
      .send({ order_id: 'DEP-UNKNOWN', status: 'paid', total_amount: 10_000 });
    expect(res.status).toBe(404);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payment_callbacks')?.n).toBeGreaterThan(0);
  });

  it('marks an expired callback as expired without crediting', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/deposits', { currency: 'IDR', amount: 25_000 });
    const orderId = created.body.deposit.orderId as string;
    const amount = created.body.deposit.totalAmountMinor as number;
    const before = walletOf(user.userId);
    const res = await request(ctx.runtime.app)
      .post('/api/webhooks/klikqris')
      .set('x-callback-signature', sign(orderId, 'expired', amount))
      .send({ order_id: orderId, status: 'expired', total_amount: amount });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expired');
    expect(walletOf(user.userId).balance).toBe(before.balance);
  });

  it('synchronises a pending deposit through the status endpoint (cooldown enforced)', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/deposits', { currency: 'IDR', amount: 60_000 });
    const id = created.body.deposit.id as string;
    const amount = created.body.deposit.totalAmountMinor as number;
    const before = walletOf(user.userId);
    state.status = 'paid';

    const res = await user.client.post(`/api/v1/deposits/${id}/check`, {});
    expect(res.status).toBe(200);
    expect(res.body.deposit.status).toBe('paid');
    expect(walletOf(user.userId).balance).toBe(before.balance + amount);

    const again = await user.client.post(`/api/v1/deposits/${id}/check`, {});
    expect(again.status).toBe(200);
    expect(walletOf(user.userId).balance).toBe(before.balance + amount);

    ctx.clock.advance(5_000);
    const second = await user.client.post(`/api/v1/deposits/${id}/check`, {});
    expect(second.status).toBe(200);
    expect(walletOf(user.userId).balance).toBe(before.balance + amount);
  });

  it('reports provider-only transactions during reconciliation', async () => {
    state.history = [{ order_id: 'DEP-ONLY-IN-PROVIDER', amount: 12_345, status: 'paid' }];
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const res = await admin.post('/api/v1/admin/payments/reconcile', {});
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.providerOnly).toBe(1);
    expect(res.body.checked).toBe(1);
  });
});

describe('manual deposits', () => {
  it('stays in review until an authorised admin approves it', async () => {
    const user = await registerUser(ctx);
    const before = walletOf(user.userId);
    const created = await user.client.post('/api/v1/deposits/manual', {
      currency: 'IDR',
      amount: 75_000,
      reference: 'TRX-MANUAL-0001',
    });
    expect(created.status).toBe(201);
    expect(created.body.deposit.status).toBe('review');
    expect(walletOf(user.userId).balance).toBe(before.balance);

    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const approved = await admin.post(`/api/v1/admin/deposits/${created.body.deposit.id}/review`, {
      action: 'approve',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.deposit.status).toBe('paid');
    expect(walletOf(user.userId).balance).toBe(before.balance + 75_000);

    const twice = await admin.post(`/api/v1/admin/deposits/${created.body.deposit.id}/review`, {
      action: 'approve',
    });
    expect(twice.status).toBe(409);
    expect(walletOf(user.userId).balance).toBe(before.balance + 75_000);
  });

  it('requires a reason to reject and never credits a rejected deposit', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/deposits/manual', {
      currency: 'IDR',
      amount: 90_000,
      reference: 'TRX-MANUAL-0002',
    });
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const denied = await admin.post(`/api/v1/admin/deposits/${created.body.deposit.id}/review`, {
      action: 'reject',
      reason: 'no',
    });
    expect(denied.status).toBe(400);
    const rejected = await admin.post(`/api/v1/admin/deposits/${created.body.deposit.id}/review`, {
      action: 'reject',
      reason: 'Bukti transfer tidak ditemukan',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.deposit.status).toBe('rejected');
    const before = walletOf(user.userId);
    expect(before.balance).toBe(15_000_000);
  });

  it('rejects a duplicate manual reference and a deposit above the configured maximum', async () => {
    const user = await registerUser(ctx);
    await user.client.post('/api/v1/deposits/manual', {
      currency: 'IDR',
      amount: 20_000,
      reference: 'TRX-DUPLICATE',
    });
    const duplicate = await user.client.post('/api/v1/deposits/manual', {
      currency: 'IDR',
      amount: 20_000,
      reference: 'TRX-DUPLICATE',
    });
    expect(duplicate.status).toBe(409);
    const tooBig = await user.client.post('/api/v1/deposits/manual', {
      currency: 'IDR',
      amount: 50_000_000,
      reference: 'TRX-TOO-BIG',
    });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe('AMOUNT_NOT_ALLOWED');
  });
});
