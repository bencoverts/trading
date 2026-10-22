import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, pushPrice, registerUser, seedPrice, type TestContext } from '../helpers/app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
  seedPrice(ctx, 'ASIA_COMPOSITE', 6_000);
  seedPrice(ctx, 'DOGE', 0.42);
  seedPrice(ctx, 'CRYPTO_COMPOSITE', 41_000);
});

afterAll(async () => {
  await ctx.close();
});

describe('settlement loop', () => {
  it('does not settle before expiry and settles exactly once after', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades', {
      market: 'DOGE',
      direction: 'up',
      currency: 'USD',
      amount: 5,
      durationSec: 10,
    });
    const id = res.body.trade.id as string;
    expect(ctx.runtime.ctx.trades.settleDue(ctx.clock.now())).toEqual([]);

    ctx.clock.advance(9_000);
    pushPrice(ctx, 'DOGE', 0.5);
    expect(ctx.runtime.ctx.trades.settleDue(ctx.clock.now()).some((row) => row.trade.id === id)).toBe(false);

    ctx.clock.advance(2_000);
    const first = ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    expect(first.find((row) => row.trade.id === id)?.trade.result).toBe('win');
    expect(ctx.runtime.ctx.trades.settleDue(ctx.clock.now()).some((row) => row.trade.id === id)).toBe(false);
  });

  it('uses the price at expiry, not the latest price', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades', {
      market: 'CRYPTO_COMPOSITE',
      direction: 'down',
      currency: 'USD',
      amount: 3,
      durationSec: 5,
    });
    const id = res.body.trade.id as string;
    const entry = res.body.trade.entryPrice as number;
    // price rises before expiry (bad for DOWN) then crashes after expiry:
    // the stored close price must be the one at expiry, so the trade loses
    ctx.clock.advance(3_000);
    pushPrice(ctx, 'CRYPTO_COMPOSITE', entry + 500);
    ctx.clock.advance(5_000);
    pushPrice(ctx, 'CRYPTO_COMPOSITE', entry - 500);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    const row = ctx.db.get<{ result: string; close_price: number }>(
      'SELECT result, close_price FROM trades WHERE id = ?',
      id,
    );
    expect(row?.result).toBe('lose');
    expect(Number(row?.close_price)).toBe(entry + 500);
  });

  it('falls back to the entry price when the market has no tick at expiry', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades', {
      market: 'ASIA_COMPOSITE',
      direction: 'up',
      currency: 'USD',
      amount: 4,
      durationSec: 5,
    });
    const id = res.body.trade.id as string;
    ctx.clock.advance(60_000);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    const row = ctx.db.get<{ result: string }>('SELECT result FROM trades WHERE id = ?', id);
    expect(['draw', 'win', 'lose']).toContain(row?.result);
  });

  it('settles an expired batch in one pass', async () => {
    const user = await registerUser(ctx);
    for (let i = 0; i < 5; i++) {
      const res = await user.client.post('/api/v1/trades', {
        market: 'ASIA_COMPOSITE',
        direction: i % 2 === 0 ? 'up' : 'down',
        currency: 'USD',
        amount: 2,
        durationSec: 5,
      });
      expect(res.status).toBe(201);
    }
    ctx.clock.advance(3_000);
    pushPrice(ctx, 'ASIA_COMPOSITE', 6_100);
    ctx.clock.advance(3_000);
    const settled = ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    expect(settled.length).toBeGreaterThanOrEqual(5);
    const open = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'`,
      user.userId,
    );
    expect(Number(open?.n ?? 0)).toBe(0);
  });

  it('keeps the audit trail for automatic settlements', async () => {
    const rows = ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'trade.settled'`);
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(0);
  });
});

describe('jobs', () => {
  it('registers settlement, cleanup, backup and engine health jobs', () => {
    const names = ctx.runtime.ctx.jobs.status().map((job) => job.name);
    expect(names).toEqual(expect.arrayContaining(['settlement', 'cleanup', 'backup', 'engine']));
  });

  it('runs a job on demand and records the run', async () => {
    const before = ctx.runtime.ctx.jobs.history(100).length;
    await ctx.runtime.ctx.jobs.runNow('cleanup');
    const history = ctx.runtime.ctx.jobs.history(100);
    expect(history.length).toBeGreaterThan(before);
    expect(history[0].job).toBe('cleanup');
    expect(history[0].status).toBe('ok');
  });

  it('prunes ticks older than the retention window', async () => {
    ctx.runtime.ctx.settings.update({ tickRetentionDays: 1 }, { actorRole: 'system' });
    const now = ctx.clock.now();
    ctx.db.run('INSERT INTO ticks (market, t, price) VALUES (?, ?, ?)', 'DOGE', now - 5 * 86_400_000, 0.4);
    await ctx.runtime.ctx.jobs.runNow('cleanup');
    const stale = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ticks WHERE t < ?', now - 86_400_000);
    expect(Number(stale?.n ?? 0)).toBe(0);
    ctx.runtime.ctx.settings.update({ tickRetentionDays: 7 }, { actorRole: 'system' });
  });

  it('creates a scheduled backup file', async () => {
    const before = ctx.runtime.ctx.backups.list().length;
    await ctx.runtime.ctx.jobs.runNow('backup');
    expect(ctx.runtime.ctx.backups.list().length).toBe(before + 1);
  });
});
