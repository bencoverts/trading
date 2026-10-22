import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, withCookies, type TestContext } from '../helpers/app.js';
import { createRuntime } from '../../src/bootstrap.js';
import { FakeClock } from '../../src/lib/clock.js';

let ctx: TestContext;
let api: () => request.SuperTest<request.Test>;

beforeAll(async () => {
  ctx = await createTestApp();
  api = ctx.api;
});
afterAll(async () => {
  await ctx.close();
});

const walletOf = (userId: string, currency = 'USD') =>
  Number(ctx.db.get<{ balance_minor: number }>(
    'SELECT balance_minor FROM wallets WHERE user_id = ? AND currency = ?',
    userId,
    currency,
  )?.balance_minor);

describe('server-side settlement', () => {
  it('pays stake + profit when an UP trade finishes above its entry', async () => {
    const user = await registerUser(api());
    ctx.runtime.ctx.engine.ingest('DOGE', 0.4, ctx.clock.now());
    const res = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 100, durationSec: 5 })
      .expect(201);
    const trade = res.body.trade;
    expect(walletOf(user.userId)).toBe(90_000);

    // 5 s later the simulated price moved up (server clock drives expiry)
    ctx.clock.advance(4_000);
    ctx.runtime.ctx.engine.ingest('DOGE', 0.405, ctx.clock.now());
    ctx.clock.advance(1_000);
    const settled = ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    expect(settled).toHaveLength(1);

    const detail = await withCookies(api().get(`/api/v1/trades/${trade.id}`), user.cookies).expect(200);
    expect(detail.body.trade.status).toBe('closed');
    expect(detail.body.trade.result).toBe('win');
    expect(detail.body.trade.closePrice).toBe(0.405);
    expect(detail.body.trade.payout).toBe(185);
    expect(detail.body.trade.profit).toBe(85);
    expect(walletOf(user.userId)).toBe(108_500);
  });

  it('pays nothing when an UP trade finishes below its entry', async () => {
    const user = await registerUser(api());
    ctx.runtime.ctx.engine.ingest('DOGE', 0.5, ctx.clock.now());
    const res = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 50, durationSec: 5 })
      .expect(201);

    ctx.clock.advance(4_000);
    ctx.runtime.ctx.engine.ingest('DOGE', 0.49, ctx.clock.now());
    ctx.clock.advance(1_000);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());

    const detail = await withCookies(api().get(`/api/v1/trades/${res.body.trade.id}`), user.cookies).expect(200);
    expect(detail.body.trade.result).toBe('lose');
    expect(detail.body.trade.payout).toBe(0);
    expect(walletOf(user.userId)).toBe(95_000);
  });

  it('refunds the stake on a tie (draw)', async () => {
    const user = await registerUser(api());
    ctx.runtime.ctx.engine.ingest('DOGE', 0.321, ctx.clock.now());
    const res = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'down', amount: 40, durationSec: 5 })
      .expect(201);

    ctx.clock.advance(5_000);
    ctx.runtime.ctx.engine.ingest('DOGE', 0.321, ctx.clock.now());
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());

    const detail = await withCookies(api().get(`/api/v1/trades/${res.body.trade.id}`), user.cookies).expect(200);
    expect(detail.body.trade.result).toBe('draw');
    expect(detail.body.trade.payout).toBe(40);
    expect(walletOf(user.userId)).toBe(100_000);
  });

  it('wins a DOWN trade when the price falls', async () => {
    const user = await registerUser(api());
    ctx.runtime.ctx.engine.ingest('DOGE', 0.44, ctx.clock.now());
    const res = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'down', amount: 100, durationSec: 300 })
      .expect(201);

    ctx.clock.advance(299_000);
    ctx.runtime.ctx.engine.ingest('DOGE', 0.43, ctx.clock.now());
    ctx.clock.advance(1_000);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());

    const detail = await withCookies(api().get(`/api/v1/trades/${res.body.trade.id}`), user.cookies).expect(200);
    expect(detail.body.trade.result).toBe('win');
    expect(walletOf(user.userId)).toBe(108_500);
  });

  it('does not settle before the expiry timestamp', async () => {
    const user = await registerUser(api());
    ctx.runtime.ctx.engine.ingest('DOGE', 0.4, ctx.clock.now());
    await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 10, durationSec: 60 })
      .expect(201);

    ctx.clock.advance(59_000);
    expect(ctx.runtime.ctx.trades.settleDue(ctx.clock.now())).toHaveLength(0);

    ctx.clock.advance(1_000);
    ctx.runtime.ctx.engine.ingest('DOGE', 0.41, ctx.clock.now());
    expect(ctx.runtime.ctx.trades.settleDue(ctx.clock.now())).toHaveLength(1);
  });

  it('settles only once even when the settlement pass runs twice', async () => {
    const user = await registerUser(api());
    ctx.runtime.ctx.engine.ingest('DOGE', 0.4, ctx.clock.now());
    const res = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'DOGE', direction: 'up', amount: 20, durationSec: 5 })
      .expect(201);

    ctx.clock.advance(5_000);
    ctx.runtime.ctx.engine.ingest('DOGE', 0.42, ctx.clock.now());
    ctx.clock.advance(1_000);
    expect(ctx.runtime.ctx.trades.settleDue(ctx.clock.now())).toHaveLength(1);
    expect(ctx.runtime.ctx.trades.settleDue(ctx.clock.now())).toHaveLength(0);

    const balance = walletOf(user.userId);
    expect(balance).toBe(100_000 - 20_00 + 20_00 * 1.85);
    const row = ctx.db.get<{ settled_at: number | null }>('SELECT settled_at FROM trades WHERE id = ?', res.body.trade.id);
    expect(row?.settled_at).not.toBeNull();
  });

  it('settles trades that expired while the server was down at boot', async () => {
    const first = await createTestApp();
    let tradeId = '';
    let userId = '';
    try {
      tradeId = '';
      first.runtime.ctx.engine.ingest('DOGE', 0.4, first.clock.now());
      const user = await registerUser(first.api());
      userId = user.userId;
      const res = await withCookies(first.api().post('/api/v1/trades'), user.cookies)
        .send({ market: 'DOGE', direction: 'up', amount: 100, durationSec: 30 })
        .expect(201);
      tradeId = res.body.trade.id;
      // price moves up slightly before the "outage"
      first.clock.advance(5_000);
      first.runtime.ctx.engine.ingest('DOGE', 0.41, first.clock.now());
      first.runtime.ctx.marketData.flushTicks();
    } finally {
      await first.close();
    }

    // "restart": new runtime on the same database file, clock advanced past expiry
    const clock = new FakeClock(first.clock.now());
    clock.advance(30_000);
    const second = await createRuntime({
      config: first.config,
      db: new (await import('../../src/db/sqlite.js')).Database(first.dbPath),
      clock,
      attachRealtime: false,
      startEngine: false,
      runSettlementLoop: false,
      backfill: false,
    });
    try {
      second.ctx.engine.ingest('DOGE', 0.4, clock.now());
      second.ctx.marketData.seedEngineFromDb();
      const settled = second.ctx.trades.settleDue(clock.now());
      expect(settled.map((s) => s.trade.id)).toContain(tradeId);
      const row = second.ctx.db.get<{ status: string; result: string; settled_at: number | null }>(
        'SELECT status, result, settled_at FROM trades WHERE id = ?',
        tradeId,
      );
      expect(row?.status).toBe('closed');
      expect(row?.settled_at).not.toBeNull();

      const wallet = second.ctx.db.get<{ balance_minor: number }>(
        'SELECT balance_minor FROM wallets WHERE user_id = ? AND currency = ?',
        userId,
        'USD',
      );
      // stake was debited at open, payout credited on restart -> never 0
      expect(Number(wallet?.balance_minor)).toBeGreaterThan(90_000);
    } finally {
      await second.stop();
    }
  });

  it('refunds the stake when no tick newer than the entry exists at expiry', async () => {
    const user = await registerUser(api());
    ctx.runtime.ctx.engine.ingest('ASIA_COMPOSITE', 6_100, ctx.clock.now());
    const res = await withCookies(api().post('/api/v1/trades'), user.cookies)
      .send({ market: 'ASIA_COMPOSITE', direction: 'up', amount: 30, durationSec: 5 })
      .expect(201);
    // the feed goes quiet: nothing trades between entry and expiry, so the only
    // price at/before expiry is the entry tick itself -> the outcome is a tie
    ctx.clock.advance(10_000);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    const detail = await withCookies(api().get(`/api/v1/trades/${res.body.trade.id}`), user.cookies).expect(200);
    expect(detail.body.trade.result).toBe('draw');
    expect(detail.body.trade.payout).toBe(30);
    expect(walletOf(user.userId)).toBe(100_000);
  });
});
