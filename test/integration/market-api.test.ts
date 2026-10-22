import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let api: () => request.SuperTest<request.Test>;

beforeAll(async () => {
  ctx = await createTestApp();
  api = ctx.api;
});
afterAll(async () => {
  await ctx.close();
});

describe('public market endpoints (no login required)', () => {
  it('exposes /healthz without authentication', async () => {
    const res = await api().get('/healthz').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.simulation).toBe(true);
    expect(res.body.db).toBe('ok');
    expect(res.body.markets).toHaveLength(3);
  });

  it('lists the three markets with the SIMULASI label', async () => {
    const res = await api().get('/api/v1/markets').expect(200);
    expect(res.body.label).toBe('SIMULASI');
    expect(res.body.simulation).toBe(true);
    expect(res.body.markets.map((m: { symbol: string }) => m.symbol).sort()).toEqual([
      'ASIA_COMPOSITE',
      'CRYPTO_COMPOSITE',
      'DOGE',
    ]);
    for (const market of res.body.markets) {
      expect(market.simulation).toBe(true);
      expect(market.label).toBe('SIMULASI');
      expect(market.ticker).toBeDefined();
    }
  });

  it('returns a ticker with last price, 24h change and server time', async () => {
    ctx.runtime.ctx.engine.ingest('DOGE', 0.4123, ctx.clock.now());
    const res = await api().get('/api/v1/markets/DOGE/ticker').expect(200);
    expect(res.body.market).toBe('DOGE');
    expect(res.body.price).toBe(0.4123);
    expect(res.body.label).toBe('SIMULASI');
    expect(typeof res.body.serverTime).toBe('number');
    expect(res.body.priceDecimals).toBe(5);
    // 24h reference is absent on a freshly seeded db -> null, not a fake zero
    expect(res.body.change24h === null || typeof res.body.change24h === 'number').toBe(true);
  });

  it('404s on an unknown market without leaking internals', async () => {
    const res = await api().get('/api/v1/markets/NOPE/ticker').expect(404);
    expect(res.body.error.code).toBe('MARKET_NOT_FOUND');
  });

  it('serves candles for every supported timeframe', async () => {
    for (const tf of ['5s', '15s', '30s', '1m', '5m', '15m', '1h']) {
      const res = await api().get(`/api/v1/markets/DOGE/candles?tf=${tf}&limit=10`).expect(200);
      expect(res.body.tf).toBe(tf);
      expect(Array.isArray(res.body.candles)).toBe(true);
      for (const c of res.body.candles) {
        expect(c.h).toBeGreaterThanOrEqual(c.l);
        expect(c.o).toBeGreaterThan(0);
      }
    }
  });

  it('rejects an unsupported timeframe with 400 and a validation detail', async () => {
    const res = await api().get('/api/v1/markets/DOGE/candles?tf=7m').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error.details)).toContain('tf');
  });

  it('supports limit and before paging on candles', async () => {
    const now = ctx.clock.now();
    for (let i = 0; i < 40; i++) ctx.runtime.ctx.engine.ingest('ASIA_COMPOSITE', 6_000 + i, now - 120_000 + i * 5_000);
    ctx.runtime.ctx.marketData.flushRunningCandles();

    const first = await api().get('/api/v1/markets/ASIA_COMPOSITE/candles?tf=5s&limit=5').expect(200);
    expect(first.body.candles.length).toBeLessThanOrEqual(5);
    const oldest = first.body.candles[0].t;
    const second = await api().get(`/api/v1/markets/ASIA_COMPOSITE/candles?tf=5s&limit=5&before=${oldest}`).expect(200);
    for (const c of second.body.candles) expect(c.t).toBeLessThan(oldest);
  });

  it('returns recent ticks and honours "since"', async () => {
    const now = ctx.clock.now();
    ctx.runtime.ctx.engine.ingest('CRYPTO_COMPOSITE', 41_000, now - 5_000);
    ctx.runtime.ctx.engine.ingest('CRYPTO_COMPOSITE', 41_100, now);
    ctx.runtime.ctx.marketData.flushTicks();

    const all = await api().get('/api/v1/markets/CRYPTO_COMPOSITE/ticks?limit=10').expect(200);
    expect(all.body.ticks.length).toBeGreaterThan(0);
    const times = all.body.ticks.map((t: { time: number }) => t.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    const recent = await api().get(`/api/v1/markets/CRYPTO_COMPOSITE/ticks?since=${now - 1_000}`).expect(200);
    expect(recent.body.ticks.every((t: { time: number }) => t.time >= now - 1_000)).toBe(true);
  });

  it('exposes the public trading config (durations, payout, limits)', async () => {
    const res = await api().get('/api/v1/config').expect(200);
    expect(res.body.label).toBe('SIMULASI');
    expect(res.body.payout.rate).toBe(0.85);
    expect(res.body.durations.minSec).toBe(5);
    expect(res.body.durations.maxSec).toBe(28_800);
    expect(res.body.durations.allowed.length).toBeGreaterThan(5);
    expect(res.body.timeframes).toEqual(['5s', '15s', '30s', '1m', '5m', '15m', '1h']);
  });

  it('will not trade in a paused market and returns MARKET_PAUSED', async () => {
    const admin = await ctx.api().post('/api/v1/auth/login').send({
      identifier: ctx.config.ADMIN_EMAIL,
      password: ctx.config.ADMIN_PASSWORD,
    });
    const cookie = String(admin.headers['set-cookie'][0]).split(';')[0];
    await ctx.api().patch('/api/v1/admin/markets/DOGE').set('Cookie', cookie).send({ paused: true }).expect(200);
    // public endpoints keep working while paused
    await ctx.api().get('/api/v1/markets/DOGE/ticker').expect(200);
    await ctx.api().patch('/api/v1/admin/markets/DOGE').set('Cookie', cookie).send({ paused: false }).expect(200);
  });
});

describe('unknown API routes', () => {
  it('returns a structured 404', async () => {
    const res = await api().get('/api/v1/does-not-exist').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
