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

const trade = (overrides: Record<string, unknown> = {}) => ({
  market: 'ASIA_COMPOSITE',
  direction: 'up',
  currency: 'USD',
  amount: 10,
  durationSec: 60,
  ...overrides,
});

describe('opening trades', () => {
  it('debits the wallet, stores the entry price and returns a preview-shaped trade', async () => {
    const user = await registerUser(ctx);
    const before = (await user.client.get('/api/v1/wallet')).body.wallets.find(
      (w: { currency: string }) => w.currency === 'USD',
    );
    const res = await user.client.post('/api/v1/trades', trade());
    expect(res.status).toBe(201);
    expect(res.body.trade.market).toBe('ASIA_COMPOSITE');
    expect(res.body.trade.entryPrice).toBe(6_000);
    expect(res.body.trade.expiryTime).toBe(res.body.trade.entryTime + 60_000);
    const usd = res.body.wallets.find((w: { currency: string }) => w.currency === 'USD');
    expect(usd.balanceMinor).toBe(before.balanceMinor - 1_000);
  });

  it('rejects a missing Idempotency-Key', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades', trade(), { idempotencyKey: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays an identical request and rejects a different payload with the same key', async () => {
    const user = await registerUser(ctx);
    const key = `idem-${Date.now()}`;
    const first = await user.client.post('/api/v1/trades', trade({ amount: 7 }), { idempotencyKey: key });
    expect(first.status).toBe(201);
    const replay = await user.client.post('/api/v1/trades', trade({ amount: 7 }), { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.trade.id).toBe(first.body.trade.id);
    const mismatch = await user.client.post('/api/v1/trades', trade({ amount: 9 }), { idempotencyKey: key });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('validates amount, duration, market status and balance server-side', async () => {
    const user = await registerUser(ctx);
    const tooSmall = await user.client.post('/api/v1/trades', trade({ amount: 0.01 }));
    expect(tooSmall.status).toBe(422);
    expect(tooSmall.body.error.code).toBe('AMOUNT_NOT_ALLOWED');

    const badDuration = await user.client.post('/api/v1/trades', trade({ durationSec: 7 }));
    expect(badDuration.status).toBe(422);
    expect(badDuration.body.error.code).toBe('DURATION_NOT_ALLOWED');

    const unknownMarket = await user.client.post('/api/v1/trades', trade({ market: 'NOPE' }));
    expect(unknownMarket.status).toBe(404);

    const tooMuch = await user.client.post('/api/v1/trades', trade({ amount: 999_999 }));
    expect(tooMuch.status).toBe(422);

    const settings = ctx.runtime.ctx.settings.get();
    const balance = ctx.runtime.ctx.wallets.viewOf(user.userId, 'USD').balance;
    expect(balance).toBe(settings.initialBalance.USD / 100);
  });

  it('blocks new trades while the market is paused and while it is outside trading hours', async () => {
    const user = await registerUser(ctx);
    const market = ctx.runtime.ctx.markets.requireRow('ASIA_COMPOSITE');
    ctx.runtime.ctx.markets.update('ASIA_COMPOSITE', { paused: true }, { actorUserId: user.userId });
    const paused = await user.client.post('/api/v1/trades', trade());
    expect(paused.status).toBe(422);
    expect(paused.body.error.code).toBe('MARKET_PAUSED');

    ctx.runtime.ctx.markets.update(
      'ASIA_COMPOSITE',
      { paused: false, tradingHours: { mode: 'schedule', timezone: 'Asia/Jakarta', days: [] } },
      { actorUserId: user.userId },
    );
    const closed = await user.client.post('/api/v1/trades', trade());
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('MARKET_OUTSIDE_HOURS');

    ctx.runtime.ctx.markets.update(
      'ASIA_COMPOSITE',
      { tradingHours: { mode: '24_7' }, paused: false },
      { actorUserId: user.userId },
    );
    expect(market.symbol).toBe('ASIA_COMPOSITE');
  });

  it('locks the trade currency while a trade is open', async () => {
    const user = await registerUser(ctx);
    const first = await user.client.post('/api/v1/trades', trade({ currency: 'USD' }));
    expect(first.status).toBe(201);
    const other = await user.client.post('/api/v1/trades', trade({ currency: 'IDR', amount: 50_000 }));
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('CURRENCY_LOCKED');
    const patch = await user.client.patch('/api/v1/account', { displayCurrency: 'IDR' });
    expect(patch.status).toBe(409);
  });

  it('returns a preview with payout and expiry without touching the balance', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades/preview', trade({ amount: 20, durationSec: 300 }));
    expect(res.status).toBe(200);
    expect(res.body.payoutRate).toBe(0.85);
    expect(res.body.payout).toBeCloseTo(37, 5);
    expect(res.body.expiryTime).toBe(res.body.entryTime + 300_000);
    const wallet = await user.client.get('/api/v1/wallet');
    expect(wallet.body.wallets.find((w: { currency: string }) => w.currency === 'USD').balance).toBe(1_000);
  });
});

describe('settlement', () => {
  it('pays out a winning UP trade', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades', trade({ amount: 10, durationSec: 5 }));
    const id = res.body.trade.id as string;
    ctx.clock.advance(4_000);
    pushPrice(ctx, 'ASIA_COMPOSITE', 6_010);
    ctx.clock.advance(2_000);
    const settled = ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    expect(settled.length).toBeGreaterThanOrEqual(1);
    const detail = await user.client.get(`/api/v1/trades/${id}`);
    expect(detail.body.trade.status).toBe('closed');
    expect(detail.body.trade.result).toBe('win');
    expect(detail.body.trade.payout).toBeCloseTo(18.5, 5);
    const wallet = await user.client.get('/api/v1/wallet');
    expect(wallet.body.wallets.find((w: { currency: string }) => w.currency === 'USD').balance).toBeCloseTo(1_008.5, 5);
  });

  it('loses the stake when price moves against the direction', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades', trade({ amount: 10, durationSec: 5, direction: 'down' }));
    const id = res.body.trade.id as string;
    ctx.clock.advance(4_000);
    pushPrice(ctx, 'ASIA_COMPOSITE', 6_050);
    ctx.clock.advance(2_000);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    const detail = await user.client.get(`/api/v1/trades/${id}`);
    expect(detail.body.trade.result).toBe('lose');
    expect(detail.body.trade.payout).toBe(0);
    const wallet = await user.client.get('/api/v1/wallet');
    expect(wallet.body.wallets.find((w: { currency: string }) => w.currency === 'USD').balance).toBeCloseTo(990, 5);
  });

  it('refunds the full stake on a draw', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades', trade({ amount: 10, durationSec: 5 }));
    const id = res.body.trade.id as string;
    const entry = res.body.trade.entryPrice as number;
    ctx.clock.advance(4_000);
    pushPrice(ctx, 'ASIA_COMPOSITE', entry);
    ctx.clock.advance(2_000);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    const detail = await user.client.get(`/api/v1/trades/${id}`);
    expect(detail.body.trade.result).toBe('draw');
    expect(detail.body.trade.payout).toBe(10);
    const wallet = await user.client.get('/api/v1/wallet');
    expect(wallet.body.wallets.find((w: { currency: string }) => w.currency === 'USD').balance).toBeCloseTo(1_000, 5);
  });

  it('never settles the same trade twice', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/trades', trade({ amount: 10, durationSec: 5 }));
    const id = res.body.trade.id as string;
    ctx.clock.advance(4_000);
    pushPrice(ctx, 'ASIA_COMPOSITE', 6_200);
    ctx.clock.advance(2_000);
    const first = ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    const second = ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    expect(first.some((s) => s.trade.id === id)).toBe(true);
    expect(second.some((s) => s.trade.id === id)).toBe(false);
    const ledger = await user.client.get('/api/v1/wallet/transactions?limit=50');
    const payouts = ledger.body.transactions.filter(
      (t: { refId: string | null; kind: string }) =>
        t.refId === id && t.kind.startsWith('trade_') && t.kind !== 'trade_stake',
    );
    expect(payouts).toHaveLength(1);
  });
});

describe('history and export', () => {
  it('filters history and exports CSV', async () => {
    const user = await registerUser(ctx);
    await user.client.post('/api/v1/trades', trade({ amount: 5, durationSec: 5 }));
    ctx.clock.advance(4_000);
    pushPrice(ctx, 'ASIA_COMPOSITE', 6_300);
    ctx.clock.advance(2_000);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());

    const list = await user.client.get('/api/v1/trades?status=closed&limit=10');
    expect(list.status).toBe(200);
    expect(list.body.trades.length).toBeGreaterThanOrEqual(1);
    expect(list.body.trades[0].market).toBe('ASIA_COMPOSITE');

    const csv = await user.client.get('/api/v1/trades/export.csv?status=closed');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(String(csv.text).split('\n')[0]).toContain('id,market,direction');
  });

  it("prevents reading another user's trade", async () => {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);
    const res = await alice.client.post('/api/v1/trades', trade({ amount: 5 }));
    const id = res.body.trade.id as string;
    const peek = await bob.client.get(`/api/v1/trades/${id}`);
    expect(peek.status).toBe(404);
  });
});
