import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, withCookies, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let api: () => request.SuperTest<request.Test>;

beforeAll(async () => {
  ctx = await createTestApp();
  api = ctx.api;
  ctx.runtime.ctx.engine.ingest('DOGE', 0.4, ctx.clock.now());
});
afterAll(async () => {
  await ctx.close();
});

/**
 * The mandatory guarantee: the balance check and the debit run inside one
 * SQLite `BEGIN IMMEDIATE` transaction, and wallets carry a CHECK >= 0
 * constraint. N parallel requests must never spend more than the balance.
 */
describe('concurrent trade balance safety', () => {
  it('allows exactly as many trades as the balance covers and never overdraws', async () => {
    const user = await registerUser(api());
    // $1,000 demo balance, 25 requests of $100 each
    const requests = Array.from({ length: 25 }, (_, i) =>
      withCookies(api().post('/api/v1/trades'), user.cookies)
        .send({ market: 'DOGE', direction: i % 2 ? 'up' : 'down', amount: 100, durationSec: 3_600 })
        .then((res) => res.status),
    );
    const statuses = await Promise.all(requests);

    const created = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 422).length;
    expect(created).toBe(10);
    expect(rejected).toBe(15);

    const wallet = ctx.db.get<{ balance_minor: number }>(
      'SELECT balance_minor FROM wallets WHERE user_id = ? AND currency = ?',
      user.userId,
      'USD',
    );
    expect(Number(wallet?.balance_minor)).toBe(0);

    const open = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'`,
      user.userId,
    );
    expect(Number(open?.n)).toBe(10);

    // the ledger and the wallet agree
    const staked = ctx.db.get<{ total: number }>(
      `SELECT SUM(amount_minor) AS total FROM trades WHERE user_id = ?`,
      user.userId,
    );
    expect(Number(staked?.total)).toBe(100_000);
  });

  it('keeps the wallet non-negative even with mixed currencies and repeated bursts', async () => {
    const user = await registerUser(api());
    const burst = () =>
      Promise.all(
        Array.from({ length: 12 }, () =>
          withCookies(api().post('/api/v1/trades'), user.cookies)
            .send({ market: 'DOGE', direction: 'up', amount: 500, currency: 'USDT', durationSec: 3_600 })
            .then((res) => res.status),
        ),
      );
    const first = await burst();
    expect(first.filter((s) => s === 201).length).toBe(2); // 1,000 USDT / 500
    const second = await burst();
    expect(second.every((s) => s !== 201)).toBe(true);

    const usdt = ctx.db.get<{ balance_minor: number }>(
      'SELECT balance_minor FROM wallets WHERE user_id = ? AND currency = ?',
      user.userId,
      'USDT',
    );
    expect(Number(usdt?.balance_minor)).toBe(0);
  });

  it('never lets a debit slip through while another request holds the write lock', async () => {
    const user = await registerUser(api());
    // hold the write lock briefly, then release it: the queued trade must still
    // see the fresh balance and fail cleanly instead of overdrawing
    const db = ctx.runtime.ctx.db;
    expect(() =>
      db.transaction(() => {
        db.run('UPDATE wallets SET balance_minor = 50_000 WHERE user_id = ? AND currency = ?', user.userId, 'USD');
      }),
    ).not.toThrow();

    const res = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 500, durationSec: 3_600 })
      .expect(201);
    expect(res.body.wallets.find((w: { currency: string }) => w.currency === 'USD').balanceMinor).toBe(0);

    const over = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 3_600 })
      .expect(422);
    expect(over.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });
});
