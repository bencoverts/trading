import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestApp } from '../helpers/runtime.js';
import type { RegisteredUser } from '../helpers/runtime.js';

const INITIAL = 1_000_000; // cents (10,000.00)

describe('trade settlement', () => {
  let app: TestApp;
  let user: RegisteredUser;

  beforeEach(async () => {
    app = await createTestApp();
    user = await registerUser(app);
    app.runtime.ctx.engine.ingest(100, app.clock.now());
  });

  afterEach(async () => {
    await app.close();
  });

  const ctx = () => app.runtime.ctx;

  async function open(direction: 'up' | 'down', amountCents = 1_000, durationSec = 5) {
    const res = await ctx().trades.create({
      userId: user.userId,
      symbol: ctx().config.SYMBOL,
      direction,
      amountCents,
      durationSec,
    });
    return res.trade;
  }

  async function balance(): Promise<number> {
    return ctx().users.getBalanceCents(user.userId);
  }

  it('wins an "up" trade when the close price is higher', async () => {
    const trade = await open('up');
    expect(trade.status).toBe('open');
    expect(trade.entryPrice).toBe(100);
    expect(await balance()).toBe(INITIAL - 1_000); // stake held immediately

    app.clock.advance(5_000);
    ctx().engine.ingest(101.5, app.clock.now());

    const settled = await ctx().trades.settleDue(app.clock.now());
    expect(settled).toHaveLength(1);
    const result = settled[0].trade;
    expect(result.status).toBe('closed');
    expect(result.result).toBe('win');
    expect(result.closePrice).toBe(101.5);
    expect(result.payoutCents).toBe(1_850);
    expect(result.profit).toBe(8.5);
    expect(await balance()).toBe(INITIAL - 1_000 + 1_850);

    const stored = await ctx().trades.getTrade(user.userId, trade.id);
    expect(stored.result).toBe('win');
  });

  it('loses an "up" trade when the close price is lower (stake is lost)', async () => {
    const trade = await open('up');
    app.clock.advance(5_000);
    ctx().engine.ingest(99, app.clock.now());

    const settled = await ctx().trades.settleDue(app.clock.now());
    expect(settled[0].trade.result).toBe('lose');
    expect(settled[0].trade.payoutCents).toBe(0);
    expect(await balance()).toBe(INITIAL - 1_000);
    expect((await ctx().trades.getTrade(user.userId, trade.id)).status).toBe('closed');
  });

  it('wins a "down" trade when the price falls', async () => {
    await open('down');
    app.clock.advance(5_000);
    ctx().engine.ingest(97.25, app.clock.now());

    const settled = await ctx().trades.settleDue(app.clock.now());
    expect(settled[0].trade.result).toBe('win');
    expect(await balance()).toBe(INITIAL - 1_000 + 1_850);
  });

  it('refunds the stake on a draw (identical close price)', async () => {
    await open('down');
    app.clock.advance(5_000);
    ctx().engine.ingest(100, app.clock.now());

    const settled = await ctx().trades.settleDue(app.clock.now());
    expect(settled[0].trade.result).toBe('draw');
    expect(settled[0].trade.payoutCents).toBe(1_000);
    expect(await balance()).toBe(INITIAL);
  });

  it('does not settle a trade before its expiry', async () => {
    await open('up');
    app.clock.advance(4_999);
    ctx().engine.ingest(200, app.clock.now());
    const settled = await ctx().trades.settleDue(app.clock.now());
    expect(settled).toHaveLength(0);
  });

  it('settles at the price recorded at the expiry instant, not at settle time', async () => {
    await open('up', 1_000, 5);
    app.clock.advance(5_000);
    ctx().engine.ingest(101, app.clock.now()); // price at expiry -> win
    app.clock.advance(5_000);
    ctx().engine.ingest(50, app.clock.now()); // price collapses before the loop runs

    const settled = await ctx().trades.settleDue(app.clock.now());
    expect(settled[0].trade.result).toBe('win');
    expect(settled[0].trade.closePrice).toBe(101);
  });

  it('never settles the same trade twice (claim is atomic)', async () => {
    await open('up');
    app.clock.advance(5_000);
    ctx().engine.ingest(102, app.clock.now());

    const first = await ctx().trades.settleDue(app.clock.now());
    const second = await ctx().trades.settleDue(app.clock.now());
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(await balance()).toBe(INITIAL - 1_000 + 1_850);

    const direct = await ctx().trades.settleOne(
      (await ctx().db.get<any>(`SELECT * FROM trades WHERE id = ?`, [first[0].trade.id])) as any,
      999,
      app.clock.now(),
    );
    expect(direct).toBeNull();
    expect(await balance()).toBe(INITIAL - 1_000 + 1_850);
  });

  it('refunds a trade that expired while the server was down (price unknown)', async () => {
    const trade = await open('up');
    app.clock.advance(60_000); // far beyond expiry, no ticks in between

    const settled = await ctx().trades.settleDue(app.clock.now());
    expect(settled).toHaveLength(1);
    // last known price == entry price -> draw -> full refund, never a silent loss
    expect(settled[0].trade.result).toBe('draw');
    expect(settled[0].trade.closePrice).toBe(trade.entryPrice);
    expect(await balance()).toBe(INITIAL);
  });

  it('refunds instead of using a post-expiry price when no tick exists at expiry', async () => {
    // this is what a restart looks like: the first tick arrives after expiry
    const trade = await open('up');
    app.clock.advance(6_000);
    ctx().engine.ingest(500, app.clock.now()); // wildly different price, but after expiry

    const settled = await ctx().trades.settleDue(app.clock.now());
    expect(settled).toHaveLength(1);
    expect(settled[0].trade.result).toBe('draw');
    expect(settled[0].trade.closePrice).toBe(trade.entryPrice);
    expect(await balance()).toBe(INITIAL);
  });

  it('emits trade:settled with the documented payload', async () => {
    await open('up');
    const events: any[] = [];
    ctx().trades.events.on('settled', (e) => events.push(e));

    app.clock.advance(5_000);
    ctx().engine.ingest(105, app.clock.now());
    await ctx().trades.settleDue(app.clock.now());

    expect(events).toHaveLength(1);
    expect(events[0].trade.result).toBe('win');
    expect(events[0].trade.payout).toBe(18.5);
    expect(events[0].balanceCents).toBe(INITIAL - 1_000 + 1_850);
  });

  it('keeps balance records consistent when many small trades settle at once', async () => {
    for (let i = 0; i < 5; i++) await open('up', 1_000, 5);
    expect(await ctx().trades.countOpenTrades(user.userId)).toBe(5);
    expect(await balance()).toBe(INITIAL - 5_000);

    app.clock.advance(5_000);
    ctx().engine.ingest(101, app.clock.now());
    const settled = await ctx().trades.settleDue(app.clock.now());

    expect(settled).toHaveLength(5);
    expect(await balance()).toBe(INITIAL - 5_000 + 5 * 1_850);
  });
});
