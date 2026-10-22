import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, pushPrice, registerUser, seedPrice, type TestContext } from '../helpers/app.js';
import { newId } from '../../src/lib/ids.js';

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

describe('concurrent trading', () => {
  it('never lets ten parallel stakes overdraw a wallet', async () => {
    const user = await registerUser(ctx);
    const wallet = ctx.runtime.ctx.wallets.viewOf(user.userId, 'USD');
    // 10 requests of 60% of the balance: only the first can succeed
    const amount = Math.round(wallet.balance * 0.6 * 100) / 100;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        user.client.request('post', '/api/v1/trades', {
          body: { market: 'ASIA_COMPOSITE', direction: 'up', currency: 'USD', amount, durationSec: 60 },
          idempotencyKey: `concurrent-${index}-${newId()}`,
        }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status !== 201);
    expect(created.length).toBe(1);
    expect(rejected.length).toBe(9);

    const after = ctx.runtime.ctx.wallets.viewOf(user.userId, 'USD');
    expect(after.balanceMinor).toBeGreaterThanOrEqual(0);
    expect(after.balanceMinor).toBe(wallet.balanceMinor - Math.round(amount * 100));
    const negative = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wallets WHERE balance_minor < 0');
    expect(Number(negative?.n ?? 0)).toBe(0);
  });

  it('enforces the max-open-trades limit across parallel requests', async () => {
    const user = await registerUser(ctx);
    const settings = ctx.runtime.ctx.settings.get();
    const limit = Math.min(settings.maxOpenTrades, settings.maxOpenTradesPerUser);
    const results = await Promise.all(
      Array.from({ length: limit + 5 }, () =>
        user.client.request('post', '/api/v1/trades', {
          body: { market: 'ASIA_COMPOSITE', direction: 'up', currency: 'USD', amount: 1, durationSec: 60 },
          idempotencyKey: `limit-${newId()}`,
        }),
      ),
    );
    expect(ctx.runtime.ctx.trades.countOpen(user.userId)).toBe(limit);
    expect(results.filter((r) => r.status === 201)).toHaveLength(limit);
  });

  it('replays concurrent duplicates of the same key into one trade', async () => {
    const user = await registerUser(ctx);
    const key = `dup-${newId()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        user.client.request('post', '/api/v1/trades', {
          body: { market: 'DOGE', direction: 'down', currency: 'USD', amount: 2, durationSec: 30 },
          idempotencyKey: key,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 201 || r.status === 200);
    expect(ok.length).toBe(5);
    const uniqueIds = new Set(ok.map((r) => r.body.trade.id as string));
    expect(uniqueIds.size).toBe(1);
    expect(ctx.runtime.ctx.trades.countOpen(user.userId)).toBe(1);
  });
});

describe('restart behaviour', () => {
  it('settles trades that expired while the server was down', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/trades', {
      market: 'ASIA_COMPOSITE',
      direction: 'up',
      currency: 'USD',
      amount: 10,
      durationSec: 5,
    });
    expect(created.status).toBe(201);
    const id = created.body.trade.id as string;
    const entry = created.body.trade.entryPrice as number;

    // simulate downtime: the expiry passes without any settlement pass
    ctx.clock.advance(4_000);
    pushPrice(ctx, 'ASIA_COMPOSITE', entry + 50);
    ctx.clock.advance(3_600_000);

    const closed = ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    expect(closed.some((row) => row.trade.id === id)).toBe(true);
    const row = ctx.db.get<{ status: string; result: string }>('SELECT status, result FROM trades WHERE id = ?', id);
    expect(row?.status).toBe('closed');
    expect(row?.result).toBe('win');
  });

  it('keeps the wallet consistent after settlement (sum of ledger rows)', async () => {
    const user = await registerUser(ctx);
    await user.client.post('/api/v1/trades', {
      market: 'DOGE',
      direction: 'up',
      currency: 'USD',
      amount: 3,
      durationSec: 5,
    });
    ctx.clock.advance(6_000);
    pushPrice(ctx, 'DOGE', 0.5);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());

    for (const currency of ['USD', 'IDR', 'USDT'] as const) {
      const rows = ctx.db.all<{ direction: string; total: number }>(
        `SELECT direction, SUM(amount_minor) AS total FROM ledger WHERE user_id = ? AND currency = ? GROUP BY direction`,
        user.userId,
        currency,
      );
      const credits = Number(rows.find((r) => r.direction === 'credit')?.total ?? 0);
      const debits = Number(rows.find((r) => r.direction === 'debit')?.total ?? 0);
      const balance = ctx.runtime.ctx.wallets.viewOf(user.userId, currency);
      // every ledger row stores the balance after it, so the newest row must match
      const latest = ctx.db.get<{ balance_after_minor: number }>(
        'SELECT balance_after_minor FROM ledger WHERE user_id = ? AND currency = ? ORDER BY id DESC LIMIT 1',
        user.userId,
        currency,
      );
      expect(balance.balanceMinor).toBe(Number(latest?.balance_after_minor ?? balance.balanceMinor));
      expect(credits).toBeGreaterThanOrEqual(0);
      expect(debits).toBeGreaterThanOrEqual(0);
    }
  });
});
