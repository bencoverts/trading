import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, seedPrice, type TestContext } from '../helpers/app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
  seedPrice(ctx, 'ASIA_COMPOSITE', 6_000);
  seedPrice(ctx, 'DOGE', 0.42);
  seedPrice(ctx, 'CRYPTO_COMPOSITE', 41_000);
  // a few hundred ticks so candle/query paths have data
  for (let i = 0; i < 300; i++) {
    ctx.clock.advance(1_000);
    ctx.runtime.ctx.engine.ingest('ASIA_COMPOSITE', 6_000 + Math.sin(i / 10) * 5, ctx.clock.now());
    ctx.runtime.ctx.engine.ingest('DOGE', 0.42 + Math.cos(i / 7) * 0.002, ctx.clock.now());
  }
});

afterAll(async () => {
  await ctx.close();
});

describe('public market API', () => {
  it('lists the three seeded markets with logo fields and simulation labels', async () => {
    const res = await ctx.api().get('/api/v1/markets');
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('SIMULASI');
    expect(res.body.markets).toHaveLength(3);
    const symbols = res.body.markets.map((m: { symbol: string }) => m.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['ASIA_COMPOSITE', 'CRYPTO_COMPOSITE', 'DOGE']));
    const doge = res.body.markets.find((m: { symbol: string }) => m.symbol === 'DOGE');
    expect(doge.name).toContain('Dogecoin');
    expect(doge.priceDecimals).toBe(5);
    expect(doge.ticker.price).toBeTypeOf('number');
    expect(doge.logoUrl).toBeNull();
  });

  it('returns market detail with candles and engine parameters', async () => {
    const res = await ctx.api().get('/api/v1/markets/DOGE');
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('DOGE');
    expect(res.body.candles.length).toBeGreaterThan(0);
    expect(res.body.engine.tickSize).toBeGreaterThan(0);
    expect(res.body.category).toBe('crypto');
  });

  it('returns a ticker with 24h change, high and low', async () => {
    const res = await ctx.api().get('/api/v1/markets/ASIA_COMPOSITE/ticker');
    expect(res.status).toBe(200);
    expect(res.body.price).toBeTypeOf('number');
    expect(res.body.high24h).toBeGreaterThanOrEqual(res.body.low24h);
    expect(res.body.label).toBe('SIMULASI');
  });

  it('returns candles for every timeframe with ascending timestamps', async () => {
    for (const tf of ['5s', '15s', '30s', '1m', '5m', '15m', '1h']) {
      const res = await ctx.api().get(`/api/v1/markets/ASIA_COMPOSITE/candles?tf=${tf}&limit=50`);
      expect(res.status).toBe(200);
      expect(res.body.tf).toBe(tf);
      const candles = res.body.candles as Array<{ t: number; o: number; h: number; l: number; c: number }>;
      for (const candle of candles) {
        expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
        expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
      }
      const times = candles.map((c) => c.t);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('returns ticks with a since filter', async () => {
    const all = await ctx.api().get('/api/v1/markets/DOGE/ticks?limit=100');
    expect(all.status).toBe(200);
    expect(all.body.ticks.length).toBeGreaterThan(0);
    const since = all.body.ticks[all.body.ticks.length - 5].time as number;
    const after = await ctx.api().get(`/api/v1/markets/DOGE/ticks?since=${since}&limit=100`);
    expect(after.body.ticks.every((t: { time: number }) => t.time >= since)).toBe(true);
  });

  it('404s an unknown market', async () => {
    const res = await ctx.api().get('/api/v1/markets/NOPE/ticker');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MARKET_NOT_FOUND');
  });

  it('serves 500 candles well under the 200 ms p95 budget', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const res = await ctx.api().get('/api/v1/markets/ASIA_COMPOSITE/candles?tf=5s&limit=500');
      samples.push(performance.now() - start);
      expect(res.status).toBe(200);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(200);
  });

  it('exposes the public runtime configuration', async () => {
    const res = await ctx.api().get('/api/v1/config');
    expect(res.status).toBe(200);
    expect(res.body.durations.allowed).toContain(5);
    expect(res.body.features.deposits).toBe(true);
    expect(res.body.platform.name).toBeTruthy();
    expect(res.body.volatilityPresets.ekstrem.multiplier).toBe(3);
  });

  it('publishes the market parameter history publicly', async () => {
    ctx.runtime.ctx.markets.simulate('DOGE', { trend: 'up', mood: 'cepat' }, { actorUserId: 'test-user' });
    const res = await ctx.api().get('/api/v1/markets/DOGE/history');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries[0].action).toBeTruthy();
  });

  it('serves public content pages and banners', async () => {
    const pages = await ctx.api().get('/api/v1/pages');
    expect(pages.status).toBe(200);
    expect(pages.body.pages.map((p: { slug: string }) => p.slug)).toEqual(
      expect.arrayContaining(['faq', 'terms', 'privacy', 'contact']),
    );
    const faq = await ctx.api().get('/api/v1/pages/faq');
    expect(faq.body.page.title).toBe('FAQ');
    const banners = await ctx.api().get('/api/v1/banners');
    expect(banners.status).toBe(200);
  });

  it('reports the legacy payments surface as retired and keeps /payments/* stubbed', async () => {
    const res = await ctx.api().get('/api/v1/payments/methods');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.provider).toBe('klikqris');
    const attempt = await ctx
      .api()
      .post('/api/v1/payments/deposit')
      .send({ currency: 'USD', amount: 10, method: 'qris' });
    expect(attempt.status).toBe(501);
    expect(attempt.body.error.code).toBe('NOT_AVAILABLE');
  });
});
