import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookiesFrom, createTestApp, login, registerUser, withCookies, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let api: () => request.SuperTest<request.Test>;

beforeAll(async () => {
  ctx = await createTestApp({ env: { } });
  api = ctx.api;
  ctx.runtime.ctx.engine.ingest('DOGE', 0.4, ctx.clock.now());
});
afterAll(async () => {
  await ctx.close();
});

describe('account profile', () => {
  it('returns profile, wallets, FX rates and limits', async () => {
    const user = await registerUser(api());
    const res = await withCookies(api().get('/api/v1/account'), user.cookies).expect(200);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.wallets).toHaveLength(3);
    expect(res.body.rates).toEqual({ USD: 1, IDR: 16_000, USDT: 1 });
    expect(res.body.limits.maxOpenTrades).toBe(10);
    expect(res.body.simulation).toBe(true);
  });

  it('stores the display currency preference', async () => {
    const user = await registerUser(api());
    const res = await withCookies(api().patch('/api/v1/account'), user.cookies).send({ displayCurrency: 'IDR' }).expect(200);
    expect(res.body.user.displayCurrency).toBe('IDR');
    const fresh = await withCookies(api().get('/api/v1/account'), user.cookies).expect(200);
    expect(fresh.body.user.displayCurrency).toBe('IDR');
    const bad = await withCookies(api().patch('/api/v1/account'), user.cookies).send({ displayCurrency: 'EUR' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('changes the password, revokes old sessions and issues a working cookie', async () => {
    const user = await registerUser(api());
    const res = await withCookies(api().post('/api/v1/account/password'), user.cookies)
      .send({ currentPassword: user.password, newPassword: 'new-password-9876' })
      .expect(200);
    const freshCookie = cookiesFrom(res);
    expect(freshCookie.length).toBe(1);

    // old cookie is revoked, new one works
    await withCookies(api().get('/api/v1/account'), user.cookies).expect(401);
    await withCookies(api().get('/api/v1/account'), freshCookie).expect(200);
    await api().post('/api/v1/auth/login').send({ identifier: user.email, password: 'new-password-9876' }).expect(200);

    const wrong = await withCookies(api().post('/api/v1/account/password'), freshCookie)
      .send({ currentPassword: 'not-the-password', newPassword: 'another-password' })
      .expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('demo top-up', () => {
  it('adds virtual funds and records a deposit row', async () => {
    const user = await registerUser(api());
    const res = await withCookies(api().post('/api/v1/wallet/topup'), user.cookies)
      .send({ currency: 'IDR', amount: 50_000 })
      .expect(201);
    expect(res.body.wallet.balanceMinor).toBe(15_000_000 + 50_000);
    expect(res.body.message).toContain('virtual');

    const tx = await withCookies(api().get('/api/v1/wallet/transactions'), user.cookies).expect(200);
    expect(tx.body.transactions[0]).toMatchObject({ kind: 'demo_topup', amount: 50_000, currency: 'IDR' });
  });

  it('enforces the per-transaction cap', async () => {
    const user = await registerUser(api());
    const res = await withCookies(api().post('/api/v1/wallet/topup'), user.cookies)
      .send({ currency: 'USD', amount: 5_000 })
      .expect(422);
    expect(res.body.error.code).toBe('AMOUNT_NOT_ALLOWED');
    expect(res.body.error.details.maxMinor).toBe(100_000);
  });

  it('enforces the daily top-up count', async () => {
    const user = await registerUser(api());
    for (let i = 0; i < 5; i++) {
      await withCookies(api().post('/api/v1/wallet/topup'), user.cookies).send({ currency: 'USD', amount: 10 }).expect(201);
    }
    const res = await withCookies(api().post('/api/v1/wallet/topup'), user.cookies).send({ currency: 'USD', amount: 10 }).expect(422);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('validates currency and amount', async () => {
    const user = await registerUser(api());
    const bad = await withCookies(api().post('/api/v1/wallet/topup'), user.cookies).send({ currency: 'EUR', amount: 10 }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const negative = await withCookies(api().post('/api/v1/wallet/topup'), user.cookies).send({ currency: 'USD', amount: -10 }).expect(400);
    expect(negative.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires a session', async () => {
    await api().post('/api/v1/wallet/topup').send({ currency: 'USD', amount: 10 }).expect(401);
  });
});

describe('demo balance reset', () => {
  it('restores every wallet and voids open trades with a refund', async () => {
    const user = await registerUser(api());
    await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 200, durationSec: 3_600 })
      .expect(201);

    const res = await withCookies(api().post('/api/v1/account/reset'), user.cookies).expect(200);
    expect(res.body.voidedTrades).toBe(1);
    const usd = res.body.wallets.find((w: { currency: string }) => w.currency === 'USD');
    expect(usd.balanceMinor).toBe(100_000);

    const trades = await withCookies(api().get('/api/v1/trades?status=closed'), user.cookies).expect(200);
    expect(trades.body.trades).toHaveLength(1);
    expect(trades.body.trades[0].result).toBe('draw');
    expect(trades.body.trades[0].settleReason).toBe('demo balance reset');
  });
});

describe('session hygiene', () => {
  it('refuses protected pages for anonymous callers', async () => {
    for (const path of ['/api/v1/account', '/api/v1/trades', '/api/v1/wallet/transactions']) {
      await api().get(path).expect(401);
    }
  });

  it('accepts a Bearer token as an alternative to the cookie', async () => {
    const user = await registerUser(api());
    const token = (await login(api(), user.email, user.password)).length ? (await api().post('/api/v1/auth/login').send({ identifier: user.email, password: user.password })).body.token : '';
    await api().get('/api/v1/account').set('Authorization', `Bearer ${token}`).expect(200);
    await api().get('/api/v1/account').set('Authorization', 'Bearer nonsense').expect(401);
  });
});
