import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loginAdmin, registerUser, withCookies, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let api: () => request.SuperTest<request.Test>;
let admin: string[];

beforeAll(async () => {
  ctx = await createTestApp();
  api = ctx.api;
  ctx.runtime.ctx.engine.ingest('DOGE', 0.4, ctx.clock.now());
  admin = await loginAdmin(api());
});
afterAll(async () => {
  await ctx.close();
});

describe('admin authorisation', () => {
  it('rejects anonymous requests with 401 on every admin route', async () => {
    for (const path of ['/api/v1/admin/stats', '/api/v1/admin/users', '/api/v1/admin/trades', '/api/v1/admin/audit', '/api/v1/admin/settings']) {
      const res = await api().get(path).expect(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects a normal user with 403 on every admin route (role checked server-side)', async () => {
    const user = await registerUser(api());
    for (const path of ['/api/v1/admin/stats', '/api/v1/admin/users', '/api/v1/admin/trades', '/api/v1/admin/audit', '/api/v1/admin/settings']) {
      const res = await withCookies(api().get(path), user.cookies).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    const patchRes = await withCookies(api().patch('/api/v1/admin/markets/DOGE'), user.cookies).send({ paused: true }).expect(403);
    expect(patchRes.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a forged admin role in a signed-by-us token only if the DB says admin (no client trust)', async () => {
    const user = await registerUser(api());
    // the role inside the JWT is not enough: the user row is the source of truth
    const token = (await api().post('/api/v1/auth/login').send({ identifier: user.email, password: user.password })).body.token;
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.role = 'admin';
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    // signature no longer matches -> 401
    await api().get('/api/v1/admin/stats').set('Authorization', `Bearer ${forged}`).expect(401);
    // a valid token for a normal user is still refused by the role check
    await api().get('/api/v1/admin/stats').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('serves the dashboard to an admin', async () => {
    const res = await withCookies(api().get('/api/v1/admin/stats'), admin).expect(200);
    expect(res.body.simulation).toBe(true);
    expect(res.body.users.total).toBeGreaterThanOrEqual(1);
    expect(res.body.trades).toHaveProperty('simulatedProfitMinor');
    expect(res.body.settings.payoutRate).toBe(0.85);
  });
});

describe('market controls', () => {
  it('updates trend/mood/volatility and pauses a market', async () => {
    const res = await withCookies(api().patch('/api/v1/admin/markets/DOGE'), admin)
      .send({ trend: 'up', mood: 'liar', volatility: 1.8, paused: true, pauseReason: 'maintenance' })
      .expect(200);
    expect(res.body.market).toMatchObject({ symbol: 'DOGE', trend: 'up', mood: 'liar', volatility: 1.8, paused: true });
    expect(res.body.engine.mood).toBe('liar');

    const user = await registerUser(api());
    const blocked = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 })
      .expect(422);
    expect(blocked.body.error.code).toBe('MARKET_PAUSED');

    const resumed = await withCookies(api().patch('/api/v1/admin/markets/DOGE'), admin).send({ paused: false, trend: 'neutral', mood: 'normal', volatility: 1 }).expect(200);
    expect(resumed.body.market.paused).toBe(false);
  });

  it('validates the payload and unknown markets', async () => {
    const bad = await withCookies(api().patch('/api/v1/admin/markets/DOGE'), admin).send({ mood: 'chaotic' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const unknown = await withCookies(api().patch('/api/v1/admin/markets/TSLA'), admin).send({ trend: 'up' }).expect(404);
    expect(unknown.body.error.code).toBe('MARKET_NOT_FOUND');
    const tooVolatile = await withCookies(api().patch('/api/v1/admin/markets/DOGE'), admin).send({ volatility: 99 }).expect(400);
    expect(tooVolatile.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('writes every market change to the audit log with the admin as actor', async () => {
    await withCookies(api().patch('/api/v1/admin/markets/ASIA_COMPOSITE'), admin).send({ trend: 'down' }).expect(200);
    const audit = await withCookies(api().get('/api/v1/admin/audit?action=admin.market_updated'), admin).expect(200);
    const entry = audit.body.entries.find((e: { meta: { patch: { trend?: string } } }) => e.meta?.patch?.trend === 'down');
    expect(entry).toBeDefined();
    expect(entry.actor_role).toBe('admin');
    expect(entry.target_id).toBe('ASIA_COMPOSITE');
    await withCookies(api().patch('/api/v1/admin/markets/ASIA_COMPOSITE'), admin).send({ trend: 'neutral' }).expect(200);
  });
});

describe('settings', () => {
  it('changes payout rate and applies it to new trades only', async () => {
    const before = await withCookies(api().get('/api/v1/admin/settings'), admin).expect(200);
    expect(before.body.settings.payoutRate).toBe(0.85);

    await withCookies(api().patch('/api/v1/admin/settings'), admin).send({ payoutRate: 0.9 }).expect(200);

    const user = await registerUser(api());
    const trade = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 })
      .expect(201);
    expect(trade.body.trade.payoutRate).toBe(0.9);

    await withCookies(api().patch('/api/v1/admin/settings'), admin).send({ payoutRate: 0.85 }).expect(200);
    const after = await withCookies(api().get(`/api/v1/trades/${trade.body.trade.id}`), user.cookies).expect(200);
    expect(after.body.trade.payoutRate).toBe(0.9); // snapshotted per trade
  });

  it('rejects an invalid payout configuration', async () => {
    const res = await withCookies(api().patch('/api/v1/admin/settings'), admin).send({ payoutMode: 'total', payoutRate: 1 }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('payoutRate');
    const bad = await withCookies(api().patch('/api/v1/admin/settings'), admin).send({ payoutRate: 9 }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('restricts allowed durations and amount limits for new trades', async () => {
    await withCookies(api().patch('/api/v1/admin/settings'), admin)
      .send({ allowedDurations: [5, 60], minAmount: { USD: 5 }, maxAmount: { USD: 20 } })
      .expect(200);

    const user = await registerUser(api());
    const badDuration = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 300 })
      .expect(422);
    expect(badDuration.body.error.code).toBe('DURATION_NOT_ALLOWED');

    const badAmount = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 25, durationSec: 60 })
      .expect(422);
    expect(badAmount.body.error.code).toBe('AMOUNT_NOT_ALLOWED');

    await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 })
      .expect(201);

    await withCookies(api().patch('/api/v1/admin/settings'), admin)
      .send({ allowedDurations: [5, 10, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800], minAmount: { USD: 1 }, maxAmount: { USD: 1000 } })
      .expect(200);
  });

  it('updates demo FX rates and validates them', async () => {
    const res = await withCookies(api().patch('/api/v1/admin/settings'), admin).send({ rates: { IDR: 17_000 } }).expect(200);
    expect(res.body.settings.rates.IDR).toBe(17_000);
    expect(res.body.settings.rates.USD).toBe(1);
    await withCookies(api().patch('/api/v1/admin/settings'), admin).send({ rates: { IDR: 16_000 } }).expect(200);
    const bad = await withCookies(api().patch('/api/v1/admin/settings'), admin).send({ rates: { IDR: -5 } }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('trade administration', () => {
  it('lists trades with filters including user email/username', async () => {
    const user = await registerUser(api());
    await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 })
      .expect(201);

    const res = await withCookies(api().get('/api/v1/admin/trades?status=open&market=DOGE'), admin).expect(200);
    expect(res.body.trades.length).toBeGreaterThan(0);
    expect(res.body.trades[0]).toHaveProperty('username');
    expect(res.body.trades.every((t: { status: string; market: string }) => t.status === 'open' && t.market === 'DOGE')).toBe(true);

    const filtered = await withCookies(api().get(`/api/v1/admin/trades?userId=${user.userId}`), admin).expect(200);
    expect(filtered.body.trades).toHaveLength(1);
  });

  it('requires a reason for manual settlement and records it', async () => {
    const user = await registerUser(api());
    ctx.runtime.ctx.engine.ingest('DOGE', 0.4, ctx.clock.now());
    const created = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 100, durationSec: 3_600 })
      .expect(201);
    const id = created.body.trade.id;

    const noReason = await withCookies(api().post(`/api/v1/admin/trades/${id}/settle`), admin).send({}).expect(400);
    expect(noReason.body.error.code).toBe('VALIDATION_ERROR');

    const short = await withCookies(api().post(`/api/v1/admin/trades/${id}/settle`), admin).send({ reason: 'oops' }).expect(400);
    expect(short.body.error.code).toBe('VALIDATION_ERROR');

    const ok = await withCookies(api().post(`/api/v1/admin/trades/${id}/settle`), admin)
      .send({ reason: 'manual settlement test', closePrice: 0.45 })
      .expect(200);
    expect(ok.body.trade.status).toBe('closed');
    expect(ok.body.trade.settledBy).toBe('admin');
    expect(ok.body.trade.result).toBe('win');

    const audit = await withCookies(api().get('/api/v1/admin/audit?action=admin.trade_settled'), admin).expect(200);
    const entry = audit.body.entries.find((e: { target_id: string }) => e.target_id === id);
    expect(entry).toBeDefined();
    expect(entry.meta.reason).toBe('manual settlement test');

    const twice = await withCookies(api().post(`/api/v1/admin/trades/${id}/settle`), admin).send({ reason: 'second attempt' }).expect(409);
    expect(twice.body.error.code).toBe('CONFLICT');
  });

  it('blocks and unblocks users, and refuses to block an admin', async () => {
    const user = await registerUser(api());
    const blocked = await withCookies(api().post(`/api/v1/admin/users/${user.userId}/block`), admin)
      .send({ blocked: true, reason: 'abuse' })
      .expect(200);
    expect(blocked.body.user.blocked).toBe(true);

    const audit = await withCookies(api().get('/api/v1/admin/audit?action=admin.user_blocked'), admin).expect(200);
    expect(audit.body.entries.some((e: { target_id: string }) => e.target_id === user.userId)).toBe(true);

    const unblocked = await withCookies(api().post(`/api/v1/admin/users/${user.userId}/block`), admin)
      .send({ blocked: false })
      .expect(200);
    expect(unblocked.body.user.blocked).toBe(false);

    const adminId = (await withCookies(api().get('/api/v1/account'), admin).expect(200)).body.user.id;
    const selfBlock = await withCookies(api().post(`/api/v1/admin/users/${adminId}/block`), admin).send({ blocked: true }).expect(403);
    expect(selfBlock.body.error.code).toBe('FORBIDDEN');
  });

  it('adjusts a user demo balance and audits the delta', async () => {
    const user = await registerUser(api());
    const res = await withCookies(api().post(`/api/v1/admin/users/${user.userId}/wallet`), admin)
      .send({ currency: 'USD', delta: 250, reason: 'compensation' })
      .expect(200);
    expect(res.body.wallet.balanceMinor).toBe(125_000);

    const neg = await withCookies(api().post(`/api/v1/admin/users/${user.userId}/wallet`), admin)
      .send({ currency: 'USD', delta: -2_000, reason: 'clawback' })
      .expect(422);
    expect(neg.body.error.code).toBe('INSUFFICIENT_FUNDS');

    const detail = await withCookies(api().get(`/api/v1/admin/users/${user.userId}`), admin).expect(200);
    expect(detail.body.audit.some((a: { action: string }) => a.action === 'admin.wallet_adjusted')).toBe(true);
  });

  it('searches users', async () => {
    const res = await withCookies(api().get('/api/v1/admin/users?search=user_'), admin).expect(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.users.every((u: { username: string }) => u.username.includes('user_'))).toBe(true);
  });

  it('exposes the audit log with actor, action and target', async () => {
    const res = await withCookies(api().get('/api/v1/admin/audit?limit=200'), admin).expect(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const entry of res.body.entries) {
      expect(entry).toHaveProperty('action');
      expect(entry).toHaveProperty('actor_role');
      expect(['guest', 'user', 'admin', 'system']).toContain(entry.actor_role);
    }
  });
});

describe('payments module stubs', () => {
  it('returns 501 "belum tersedia" for deposit and withdraw', async () => {
    const providers = await api().get('/api/v1/payments/providers').expect(200);
    expect(providers.body.providers.every((p: { available: boolean }) => p.available === false)).toBe(true);

    const deposit = await api()
      .post('/api/v1/payments/deposit')
      .send({ currency: 'USD', amount: 10, method: 'qris' })
      .expect(501);
    expect(deposit.body.error.code).toBe('NOT_AVAILABLE');
    expect(deposit.body.status).toBe('not_available');
    expect(deposit.body.message).toContain('belum tersedia');

    const withdraw = await api()
      .post('/api/v1/payments/withdraw')
      .send({ currency: 'USD', amount: 10, method: 'bank_transfer', destination: 'acct-1' })
      .expect(501);
    expect(withdraw.body.error.code).toBe('NOT_AVAILABLE');

    const history = await api().get('/api/v1/payments/history').expect(501);
    expect(history.body.error.code).toBe('NOT_AVAILABLE');
  });

  it('validates the payload before refusing', async () => {
    const res = await api().post('/api/v1/payments/deposit').send({ currency: 'USD', method: 'qris' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
