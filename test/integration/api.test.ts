import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestApp } from '../helpers/runtime.js';

describe('market data API', () => {
  let app: TestApp;

  afterEach(async () => {
    await app?.close();
  });

  it('serves market configuration with trading limits', async () => {
    app = await createTestApp();
    const res = await app.request.get('/api/market');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      symbol: 'ASIA50',
      priceDecimals: 2,
      currency: 'USD',
      timeframes: ['5s', '15s', '30s', '1m', '5m'],
      trading: { allowedDurations: [5, 15, 30, 60], minAmount: 1, maxAmount: 500, payoutRate: 0.85, payoutMode: 'profit' },
    });
    expect(res.body.timeframeMs['5s']).toBe(5_000);
    expect(res.body.serverTime).toBe(app.clock.now());
  });

  it('returns closed candles plus the forming candle', async () => {
    app = await createTestApp();
    const t0 = app.clock.now();
    const engine = app.runtime.ctx.engine;
    engine.ingest(6200, t0);
    engine.ingest(6210, t0 + 1_000);
    engine.ingest(6190, t0 + 2_000);
    engine.ingest(6205, t0 + 6_000); // opens 5s bucket t0+5000

    const res = await app.request.get('/api/candles?symbol=ASIA50&tf=5s&limit=10');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'ASIA50', tf: '5s', tfMs: 5_000, priceDecimals: 2 });
    expect(res.body.candles).toHaveLength(2);
    expect(res.body.candles[0]).toEqual({ t: t0, o: 6200, h: 6210, l: 6190, c: 6190 });
    expect(res.body.candles[1]).toEqual({ t: t0 + 5_000, o: 6205, h: 6205, l: 6205, c: 6205 });
    expect(res.body.current).toEqual({ t: t0 + 5_000, o: 6205, h: 6205, l: 6205, c: 6205 });
    expect(res.body.lastPrice).toBe(6205);
    expect(res.body.seq).toBe(4);

    const closedOnly = await app.request.get('/api/candles?tf=5s&includeCurrent=false');
    expect(closedOnly.body.candles).toHaveLength(1);
    expect(closedOnly.body.current).toBeNull();

    const limited = await app.request.get('/api/candles?tf=5s&limit=1');
    expect(limited.body.candles).toHaveLength(1);
    expect(limited.body.candles[0].t).toBe(t0 + 5_000);
  });

  it('aggregates every timeframe consistently from the same ticks', async () => {
    app = await createTestApp();
    const t0 = app.clock.now();
    const engine = app.runtime.ctx.engine;
    for (let i = 0; i < 12; i++) engine.ingest(6200 + i, t0 + i * 5_000);

    const five = await app.request.get('/api/candles?tf=5s&limit=50&includeCurrent=false');
    const fifteen = await app.request.get('/api/candles?tf=15s&limit=50&includeCurrent=false');
    const oneMinute = await app.request.get('/api/candles?tf=1m&limit=50&includeCurrent=false');

    expect(five.body.candles.length).toBe(11);
    expect(fifteen.body.candles.length).toBe(3);
    expect(oneMinute.body.candles.length).toBe(0);

    // the 15s candle must equal the merge of the three 5s candles in its bucket
    const bucket = fifteen.body.candles[0];
    const children = five.body.candles.filter((c: any) => c.t >= bucket.t && c.t < bucket.t + 15_000);
    expect(children).toHaveLength(3);
    expect(bucket.o).toBe(children[0].o);
    expect(bucket.c).toBe(children[2].c);
    expect(bucket.h).toBe(Math.max(...children.map((c: any) => c.h)));
    expect(bucket.l).toBe(Math.min(...children.map((c: any) => c.l)));
  });

  it('rejects unsupported timeframes and symbols', async () => {
    app = await createTestApp();
    expect((await app.request.get('/api/candles?tf=7s')).status).toBe(400);
    const wrongSymbol = await app.request.get('/api/candles?symbol=BTCUSD&tf=5s');
    expect(wrongSymbol.status).toBe(422);
    expect(wrongSymbol.body.error.code).toBe('SYMBOL_INACTIVE');
    expect((await app.request.get('/api/candles?tf=5s&limit=0')).status).toBe(400);
    expect((await app.request.get('/api/candles?tf=5s&limit=10001')).status).toBe(400);
  });

  it('returns recent ticks with since/limit filters', async () => {
    app = await createTestApp();
    const t0 = app.clock.now();
    for (let i = 0; i < 6; i++) app.runtime.ctx.engine.ingest(6200 + i, t0 + i * 100);

    const all = await app.request.get('/api/ticks?limit=100');
    expect(all.status).toBe(200);
    expect(all.body.ticks).toHaveLength(6);
    expect(all.body.ticks[0]).toEqual({ price: 6200, time: t0, seq: 1 });

    const since = await app.request.get('/api/ticks?since=' + (t0 + 300));
    expect(since.body.ticks.map((t: any) => t.price)).toEqual([6203, 6204, 6205]);

    const lastTwo = await app.request.get('/api/ticks?limit=2');
    expect(lastTwo.body.ticks.map((t: any) => t.price)).toEqual([6204, 6205]);
  });
});

describe('auth API', () => {
  let app: TestApp;

  afterEach(async () => {
    await app?.close();
  });

  it('rejects duplicate emails and weak passwords', async () => {
    app = await createTestApp();
    await registerUser(app, 'dup@example.com');

    const dup = await app.request.post('/api/auth/register').send({ email: 'DUP@example.com', password: 'password123' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');

    const weak = await app.request.post('/api/auth/register').send({ email: 'weak@example.com', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');

    const badEmail = await app.request.post('/api/auth/register').send({ email: 'not-an-email', password: 'password123' });
    expect(badEmail.status).toBe(400);
  });

  it('logs in with valid credentials only', async () => {
    app = await createTestApp();
    await registerUser(app, 'login@example.com', 'correct-password');

    const wrong = await app.request.post('/api/auth/login').send({ email: 'login@example.com', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await app.request.post('/api/auth/login').send({ email: 'ghost@example.com', password: 'whatever1' });
    expect(unknown.status).toBe(401);

    const ok = await app.request.post('/api/auth/login').send({ email: 'LOGIN@example.com', password: 'correct-password' });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe('string');
    expect(ok.body.account.balance).toBe(10_000);

    const me = await app.request.get('/api/me').set('Authorization', `Bearer ${ok.body.token}`);
    expect(me.body.user.email).toBe('login@example.com');
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash/i);
  });

  it('rejects invalid bearer tokens', async () => {
    app = await createTestApp();
    expect((await app.request.get('/api/me').set('Authorization', 'Bearer nonsense')).status).toBe(401);
    expect((await app.request.get('/api/me').set('Authorization', 'Basic abc')).status).toBe(401);
  });
});

describe('health, security headers and CORS', () => {
  let app: TestApp;

  afterEach(async () => {
    await app?.close();
  });

  it('reports engine and db health', async () => {
    app = await createTestApp();
    app.runtime.ctx.engine.ingest(6204.5, app.clock.now());

    const res = await app.request.get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(res.body.engine).toMatchObject({ symbol: 'ASIA50', lastSeq: 1, lastPrice: 6204.5 });
    expect(res.body.engine.lastTickAgeMs).toBe(0);
  });

  it('sets strict security headers without blocking iframes', async () => {
    app = await createTestApp();
    const res = await app.request.get('/healthz');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows configured origins only', async () => {
    app = await createTestApp();

    const allowed = await app.request.get('/api/market').set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const blocked = await app.request.get('/api/market').set('Origin', 'https://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await app.request
      .options('/api/trades')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,idempotency-key,content-type');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toMatch(/idempotency-key/i);
  });

  it('returns JSON 404 for unknown endpoints', async () => {
    app = await createTestApp();
    const res = await app.request.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('rate limiting', () => {
  it('limits trade requests per user', async () => {
    const app = await createTestApp({ overrides: { RATE_TRADE_MAX: '2', RATE_TRADE_WINDOW_MS: '60000' } });
    try {
      app.runtime.ctx.engine.ingest(6200, app.clock.now());
      const user = await registerUser(app);
      const call = (i: number) =>
        app.request
          .post('/api/trades')
          .set('Authorization', `Bearer ${user.token}`)
          .send({ symbol: 'ASIA50', direction: 'up', amount: 1, durationSec: 5 });

      expect((await call(1)).status).toBe(201);
      expect((await call(2)).status).toBe(201);
      const limited = await call(3);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });

  it('limits login attempts per IP', async () => {
    const app = await createTestApp({ overrides: { RATE_AUTH_MAX: '2', RATE_AUTH_WINDOW_MS: '60000' } });
    try {
      const body = { email: 'nobody@example.com', password: 'wrong-password' };
      expect((await app.request.post('/api/auth/login').send(body)).status).toBe(401);
      expect((await app.request.post('/api/auth/login').send(body)).status).toBe(401);
      const limited = await app.request.post('/api/auth/login').send(body);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });
});

describe('admin API', () => {
  let app: TestApp;
  let adminToken: string;
  let userToken: string;

  const adminApp = () =>
    createTestApp({
      overrides: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'super-secret-admin' },
    });

  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin tune payout, durations, mood and read stats', async () => {
    app = await adminApp();
    const login = await app.request.post('/api/auth/login').send({ email: 'admin@example.com', password: 'super-secret-admin' });
    expect(login.status).toBe(200);
    adminToken = login.body.token;
    expect(login.body.user.role).toBe('admin');
    userToken = (await registerUser(app)).token;

    const forbidden = await app.request.get('/api/admin/settings').set('Authorization', `Bearer ${userToken}`);
    expect(forbidden.status).toBe(403);
    expect((await app.request.get('/api/admin/settings')).status).toBe(401);

    const settings = await app.request.get('/api/admin/settings').set('Authorization', `Bearer ${adminToken}`);
    expect(settings.status).toBe(200);
    expect(settings.body.settings.payoutRate).toBe(0.85);

    const patch = await app.request
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ payoutRate: 0.9, allowedDurations: [10, 20], maxAmount: 25, mood: 'liar', volatility: 2.5 });
    expect(patch.status).toBe(200);
    expect(patch.body.settings).toMatchObject({
      payoutRate: 0.9,
      allowedDurations: [10, 20],
      maxAmountCents: 2_500,
      mood: 'liar',
      volatility: 2.5,
    });
    expect(patch.body.source).toMatchObject({ mood: 'liar', volatility: 2.5 });

    const market = await app.request.get('/api/market');
    expect(market.body.trading.allowedDurations).toEqual([10, 20]);
    expect(market.body.trading.maxAmount).toBe(25);

    const feed = await app.request.get('/api/admin/feed').set('Authorization', `Bearer ${adminToken}`);
    expect(feed.body.source.mood).toBe('liar');

    app.runtime.ctx.engine.ingest(6200, app.clock.now());
    await app.request
      .post('/api/trades')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ symbol: 'ASIA50', direction: 'up', amount: 10, durationSec: 10 });

    const stats = await app.request.get('/api/admin/stats').set('Authorization', `Bearer ${adminToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body.trades).toMatchObject({ total: 1, open: 1, openExposure: 10 });
    expect(stats.body.accounts).toMatchObject({ users: 2, currency: 'USD' });

    const trades = await app.request.get('/api/admin/trades?limit=10').set('Authorization', `Bearer ${adminToken}`);
    expect(trades.body.trades).toHaveLength(1);
    expect(trades.body.trades[0].email).toBeDefined();

    const audit = await app.request.get('/api/admin/audit?action=settings_updated').set('Authorization', `Bearer ${adminToken}`);
    expect(audit.body.entries.length).toBeGreaterThanOrEqual(1);

    const settle = await app.request.post('/api/admin/settle').set('Authorization', `Bearer ${adminToken}`);
    expect(settle.status).toBe(200);
    expect(settle.body.settled).toBe(0);
  });

  it('validates the settings patch', async () => {
    app = await adminApp();
    const login = await app.request.post('/api/auth/login').send({ email: 'admin@example.com', password: 'super-secret-admin' });
    const token = login.body.token;

    const bad = await app.request.patch('/api/admin/settings').set('Authorization', `Bearer ${token}`).send({ payoutRate: 99 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const unknownField = await app.request
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ payoutrate: 0.5 });
    expect(unknownField.status).toBe(400);
  });
});
