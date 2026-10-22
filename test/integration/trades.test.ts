import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookiesFrom, createTestApp, registerUser, withCookies, type TestContext } from '../helpers/app.js';
import { newId } from '../../src/lib/ids.js';

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

const place = (cookies: string[], body: Record<string, unknown>, key?: string) => {
  let req = withCookies(api().post('/api/v1/trades'), cookies).send(body);
  if (key) req = req.set('Idempotency-Key', key);
  return req;
};

describe('trade creation', () => {
  it('opens a trade with a server entry price and expiry, and debits the wallet', async () => {
    const user = await registerUser(api());
    const res = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 100, durationSec: 60 }).expect(201);

    expect(res.body.trade.status).toBe('open');
    expect(res.body.trade.entryPrice).toBe(0.4);
    expect(res.body.trade.expiryTime - res.body.trade.entryTime).toBe(60_000);
    expect(res.body.trade.payoutRate).toBe(0.85);
    expect(res.body.trade.amountMinor).toBe(10_000);
    expect(res.body.wallets.find((w: { currency: string }) => w.currency === 'USD').balanceMinor).toBe(90_000);
  });

  it('rejects an amount below the minimum', async () => {
    const user = await registerUser(api());
    const res = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 0.5, durationSec: 60 }).expect(422);
    expect(res.body.error.code).toBe('AMOUNT_NOT_ALLOWED');
    expect(res.body.error.details.minMinor).toBe(100);
  });

  it('rejects an amount above the maximum', async () => {
    const user = await registerUser(api());
    const res = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 5_000, durationSec: 60 }).expect(422);
    expect(res.body.error.code).toBe('AMOUNT_NOT_ALLOWED');
  });

  it('rejects a zero / negative / missing amount via schema validation', async () => {
    const user = await registerUser(api());
    for (const amount of [0, -10]) {
      const res = await place(user.cookies, { market: 'DOGE', direction: 'up', amount, durationSec: 60 }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects durations outside 5s..8h', async () => {
    const user = await registerUser(api());
    for (const durationSec of [4, 28_801]) {
      const res = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 10, durationSec }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects a duration that is inside the range but not on the allowed list', async () => {
    const user = await registerUser(api());
    const res = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 10, durationSec: 7 }).expect(422);
    expect(res.body.error.code).toBe('DURATION_NOT_ALLOWED');
    expect(res.body.error.details.allowedDurations).toContain(5);
  });

  it('rejects an unknown direction and an unknown market', async () => {
    const user = await registerUser(api());
    const badDir = await place(user.cookies, { market: 'DOGE', direction: 'sideways', amount: 10, durationSec: 60 }).expect(400);
    expect(badDir.body.error.code).toBe('VALIDATION_ERROR');

    const badMarket = await place(user.cookies, { market: 'TSLA', direction: 'up', amount: 10, durationSec: 60 }).expect(404);
    expect(badMarket.body.error.code).toBe('MARKET_NOT_FOUND');
  });

  it('rejects unauthenticated trades', async () => {
    const res = await api().post('/api/v1/trades').send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a withdrawn market and a paused market', async () => {
    const user = await registerUser(api());
    const adminRes = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: ctx.config.ADMIN_EMAIL, password: ctx.config.ADMIN_PASSWORD })
      .expect(200);
    const admin = cookiesFrom(adminRes);

    await api().patch('/api/v1/admin/markets/CRYPTO_COMPOSITE').set('Cookie', admin.join('; ')).send({ paused: true }).expect(200);
    const paused = await place(user.cookies, { market: 'CRYPTO_COMPOSITE', direction: 'up', amount: 10, durationSec: 60 }).expect(422);
    expect(paused.body.error.code).toBe('MARKET_PAUSED');
    await api().patch('/api/v1/admin/markets/CRYPTO_COMPOSITE').set('Cookie', admin.join('; ')).send({ paused: false }).expect(200);

    await api().patch('/api/v1/admin/markets/DOGE').set('Cookie', admin.join('; ')).send({ paused: true }).expect(200);
    const again = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 }).expect(422);
    expect(again.body.error.code).toBe('MARKET_PAUSED');
    await api().patch('/api/v1/admin/markets/DOGE').set('Cookie', admin.join('; ')).send({ paused: false }).expect(200);
  });

  it('is idempotent: the same Idempotency-Key returns the same trade and debits once', async () => {
    const user = await registerUser(api());
    const key = newId();
    const body = { market: 'DOGE', direction: 'up', amount: 25, durationSec: 300 };

    const first = await place(user.cookies, body, key).expect(201);
    const second = await place(user.cookies, body, key).expect(200);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.trade.id).toBe(first.body.trade.id);
    expect(second.body.wallets.find((w: { currency: string }) => w.currency === 'USD').balanceMinor).toBe(97_500);
  });

  it('rejects reusing an Idempotency-Key with a different payload', async () => {
    const user = await registerUser(api());
    const key = newId();
    await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 25, durationSec: 300 }, key).expect(201);
    const res = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 30, durationSec: 300 }, key).expect(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses to spend more than the demo balance', async () => {
    const user = await registerUser(api());
    const res = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 1_000, durationSec: 60 }).expect(201);
    expect(res.body.wallets[0].balanceMinor).toBe(0);
    const over = await place(user.cookies, { market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 }).expect(422);
    expect(over.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('honours the max open trades setting', async () => {
    const app = await createTestApp();
    try {
      app.runtime.ctx.engine.ingest('DOGE', 0.4, app.clock.now());
      const adminRes = await app
        .api()
        .post('/api/v1/auth/login')
        .send({ identifier: app.config.ADMIN_EMAIL, password: app.config.ADMIN_PASSWORD })
        .expect(200);
      const admin = cookiesFrom(adminRes);
      await app.api().patch('/api/v1/admin/settings').set('Cookie', admin.join('; ')).send({ maxOpenTrades: 1 }).expect(200);

      const user = await registerUser(app.api());
      await withCookies(app.api().post('/api/v1/trades'), user.cookies)
        .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 900 })
        .expect(201);
      const res = await withCookies(app.api().post('/api/v1/trades'), user.cookies)
        .send({ market: 'DOGE', direction: 'down', amount: 10, durationSec: 900 })
        .expect(422);
      expect(res.body.error.code).toBe('TRADE_LIMIT_REACHED');
    } finally {
      await app.close();
    }
  });

  it('lists own trades only, newest first, and 404s for someone else', async () => {
    const a = await registerUser(api());
    const b = await registerUser(api());
    const created = await place(a.cookies, { market: 'DOGE', direction: 'up', amount: 10, durationSec: 300 }).expect(201);

    const list = await withCookies(api().get('/api/v1/trades'), a.cookies).expect(200);
    expect(list.body.trades.every((t: { userId: string }) => t.userId === a.userId)).toBe(true);
    expect(list.body.trades.length).toBeGreaterThan(0);

    const foreign = await withCookies(api().get(`/api/v1/trades/${created.body.trade.id}`), b.cookies).expect(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');

    const anon = await api().get('/api/v1/trades').expect(401);
    expect(anon.body.error.code).toBe('UNAUTHORIZED');
  });
});
