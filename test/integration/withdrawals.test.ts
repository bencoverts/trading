import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, login, registerUser, TEST_ADMIN, type TestContext } from '../helpers/app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp({ env: { PAYMENTS_ENABLED: 'true' } });
});

afterAll(async () => {
  await ctx.close();
});

const wallet = (userId: string, currency = 'IDR') => {
  const row = ctx.db.get<{ balance_minor: number; locked_minor: number }>(
    'SELECT balance_minor, locked_minor FROM wallets WHERE user_id = ? AND currency = ?',
    userId,
    currency,
  );
  return { balance: Number(row!.balance_minor), locked: Number(row!.locked_minor) };
};

const bank = { bank: 'BCA', accountNumber: '1234567890', accountName: 'Budi Demo' };

describe('withdrawal holds', () => {
  it('locks the requested amount without debiting the total balance', async () => {
    const user = await registerUser(ctx);
    const before = wallet(user.userId);
    const res = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 100_000,
      destination: bank,
    });
    expect(res.status).toBe(201);
    expect(res.body.withdrawal.status).toBe('pending');
    expect(res.body.withdrawal.fee).toBe(2_500);
    expect(res.body.withdrawal.net).toBe(97_500);
    expect(res.body.withdrawal.destinationMasked).toContain('7890');
    expect(JSON.stringify(res.body.withdrawal)).not.toContain('1234567890');

    const after = wallet(user.userId);
    expect(after.balance).toBe(before.balance);
    expect(after.locked).toBe(100_000);

    const wallets = await user.client.get('/api/v1/wallet');
    const idr = (wallets.body.wallets as Array<{ currency: string; availableMinor: number; lockedMinor: number }>).find(
      (row) => row.currency === 'IDR',
    )!;
    expect(idr.lockedMinor).toBe(100_000);
    expect(idr.availableMinor).toBe(before.balance - 100_000);
  });

  it('rejects amounts outside the configured limits, below the fee and on disabled currencies', async () => {
    const user = await registerUser(ctx);
    const tooSmall = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 10_000,
      destination: bank,
    });
    expect(tooSmall.status).toBe(422);
    expect(tooSmall.body.error.code).toBe('AMOUNT_NOT_ALLOWED');

    const tooBig = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 900_000_000,
      destination: bank,
    });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe('AMOUNT_NOT_ALLOWED');

    const usd = await user.client.post('/api/v1/withdrawals', {
      currency: 'USD',
      method: 'bank_transfer',
      amount: 10,
      destination: bank,
    });
    expect(usd.status).toBe(409);
    expect(usd.body.error.code).toBe('CURRENCY_NOT_AVAILABLE');
  });

  it('refuses an amount above the per-request maximum', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 20_000_000,
      destination: bank,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AMOUNT_NOT_ALLOWED');
    expect(wallet(user.userId).locked).toBe(0);
  });

  it('never lets held funds exceed the balance', async () => {
    const user = await registerUser(ctx);
    const payload = { currency: 'IDR', method: 'bank_transfer', amount: 5_000_000, destination: bank };
    for (let i = 0; i < 3; i += 1) {
      const res = await user.client.post('/api/v1/withdrawals', payload);
      expect(res.status).toBe(201);
    }
    const overflow = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 100_000,
      destination: bank,
    });
    expect(overflow.status).toBe(422);
    expect(overflow.body.error.code).toBe('INSUFFICIENT_AVAILABLE_FUNDS');
    expect(wallet(user.userId).locked).toBe(15_000_000);
  });

  it('validates the destination data', async () => {
    const user = await registerUser(ctx);
    const badAccount = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 100_000,
      destination: { bank: 'BCA', accountNumber: 'abc', accountName: 'X' },
    });
    expect(badAccount.status).toBe(400);
    const missingEwallet = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'ewallet',
      amount: 100_000,
      destination: { phone: '1' },
    });
    expect(missingEwallet.status).toBe(400);
  });

  it('releases the hold exactly once when the user cancels', async () => {
    const user = await registerUser(ctx);
    const before = wallet(user.userId);
    const created = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 200_000,
      destination: bank,
    });
    const id = created.body.withdrawal.id as string;
    const cancelled = await user.client.post(`/api/v1/withdrawals/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.withdrawal.status).toBe('cancelled');
    expect(wallet(user.userId).locked).toBe(0);
    expect(wallet(user.userId).balance).toBe(before.balance);

    const again = await user.client.post(`/api/v1/withdrawals/${id}/cancel`, {});
    expect(again.status).toBe(409);
    expect(wallet(user.userId).locked).toBe(0);
  });

  it('does not allow two concurrent withdrawals to reserve the same money', async () => {
    const user = await registerUser(ctx);
    const payload = {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 4_000_000,
      destination: bank,
    };
    const results = await Promise.all([
      user.client.post('/api/v1/withdrawals', payload),
      user.client.post('/api/v1/withdrawals', payload),
      user.client.post('/api/v1/withdrawals', payload),
      user.client.post('/api/v1/withdrawals', payload),
    ]);
    const ok = results.filter((res) => res.status === 201);
    expect(ok.length).toBe(3);
    expect(results.filter((res) => res.status === 422).length).toBe(1);
    const state = wallet(user.userId);
    expect(state.locked).toBe(12_000_000);
    expect(state.balance - state.locked).toBeGreaterThanOrEqual(0);
  });
});

describe('admin withdrawal workflow', () => {
  it('rejects with a mandatory reason and releases the hold', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 150_000,
      destination: bank,
    });
    const id = created.body.withdrawal.id as string;
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const noReason = await admin.post(`/api/v1/admin/withdrawals/${id}/transition`, { action: 'reject' });
    expect(noReason.status).toBe(400);

    const rejected = await admin.post(`/api/v1/admin/withdrawals/${id}/transition`, {
      action: 'reject',
      reason: 'Rekening tidak valid',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.withdrawal.status).toBe('rejected');
    expect(wallet(user.userId).locked).toBe(0);
    expect(wallet(user.userId).balance).toBe(15_000_000);

    const twice = await admin.post(`/api/v1/admin/withdrawals/${id}/transition`, {
      action: 'reject',
      reason: 'Rekening tidak valid',
    });
    expect(twice.status).toBe(409);
  });

  it('completes the payout once, debiting the held amount and writing the transfer reference', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 300_000,
      destination: bank,
    });
    const id = created.body.withdrawal.id as string;
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);

    await admin.post(`/api/v1/admin/withdrawals/${id}/transition`, { action: 'approve' });
    await admin.post(`/api/v1/admin/withdrawals/${id}/transition`, { action: 'process' });
    const noRef = await admin.post(`/api/v1/admin/withdrawals/${id}/transition`, { action: 'complete' });
    expect(noRef.status).toBe(400);

    const done = await admin.post(`/api/v1/admin/withdrawals/${id}/transition`, {
      action: 'complete',
      transferRef: 'TRF-2026-0001',
    });
    expect(done.status).toBe(200);
    expect(done.body.withdrawal.status).toBe('completed');
    expect(done.body.withdrawal.transferRef).toBe('TRF-2026-0001');
    expect(wallet(user.userId).locked).toBe(0);
    expect(wallet(user.userId).balance).toBe(15_000_000 - 300_000);

    const twice = await admin.post(`/api/v1/admin/withdrawals/${id}/transition`, {
      action: 'complete',
      transferRef: 'TRF-2026-0001',
    });
    expect(twice.status).toBe(409);
    expect(wallet(user.userId).balance).toBe(15_000_000 - 300_000);

    const events = ctx.db.all<{ to_status: string }>(
      'SELECT to_status FROM withdrawal_events WHERE withdrawal_id = ? ORDER BY id',
      id,
    );
    expect(events.map((row) => row.to_status)).toEqual(['pending', 'approved', 'processing', 'completed']);
  });

  it('blocks users from approving their own withdrawals', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 120_000,
      destination: bank,
    });
    const res = await user.client.post(`/api/v1/admin/withdrawals/${created.body.withdrawal.id}/transition`, {
      action: 'approve',
    });
    expect(res.status).toBe(403);
  });

  it('isolates withdrawals between users', async () => {
    const owner = await registerUser(ctx);
    const other = await registerUser(ctx);
    const created = await owner.client.post('/api/v1/withdrawals', {
      currency: 'IDR',
      method: 'bank_transfer',
      amount: 100_000,
      destination: bank,
    });
    const res = await other.client.get(`/api/v1/withdrawals/${created.body.withdrawal.id}`);
    expect(res.status).toBe(404);
  });
});
