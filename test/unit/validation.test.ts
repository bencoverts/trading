import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestApp, type RegisteredUser } from '../helpers/runtime.js';
import { AppError } from '../../src/lib/errors.js';

describe('trade intent validation and balance guards', () => {
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
  const base = () => ({
    userId: user.userId,
    symbol: ctx().config.SYMBOL,
    direction: 'up' as const,
    amountCents: 1_000,
    durationSec: 5,
  });

  it('rejects an amount above the balance and holds nothing', async () => {
    await expect(ctx().trades.create({ ...base(), amountCents: 2_000_000 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    // raise the ceiling so we exercise the balance guard, not the max-stake guard
    await ctx().settings.update({ maxAmountCents: 5_000_000 }, 'system');

    await expect(ctx().trades.create({ ...base(), amountCents: 2_000_000 })).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(await ctx().users.getBalanceCents(user.userId)).toBe(1_000_000);
    expect(await ctx().trades.countOpenTrades(user.userId)).toBe(0);
  });

  it('rejects a duration that is not allowed', async () => {
    await expect(ctx().trades.create({ ...base(), durationSec: 7 })).rejects.toMatchObject({
      code: 'DURATION_NOT_ALLOWED',
    });
  });

  it('rejects a non-positive amount', async () => {
    await expect(ctx().trades.create({ ...base(), amountCents: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(ctx().trades.create({ ...base(), amountCents: -500 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects an inactive symbol', async () => {
    await expect(ctx().trades.create({ ...base(), symbol: 'BTCUSD' })).rejects.toMatchObject({
      code: 'SYMBOL_INACTIVE',
    });
  });

  it('rejects an amount below the configured minimum', async () => {
    await expect(ctx().trades.create({ ...base(), amountCents: 10 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('caps the number of simultaneously open trades', async () => {
    for (let i = 0; i < 5; i++) await ctx().trades.create(base());
    await expect(ctx().trades.create(base())).rejects.toMatchObject({ code: 'TRADE_LIMIT_REACHED' });
    expect(await ctx().trades.countOpenTrades(user.userId)).toBe(5);
    // no stake was held for the rejected trade
    expect(await ctx().users.getBalanceCents(user.userId)).toBe(1_000_000 - 5_000);
  });

  it('is idempotent for a repeated Idempotency-Key and holds the stake once', async () => {
    const first = await ctx().trades.create({ ...base(), idempotencyKey: 'key-12345678', requestHash: 'hash-a' });
    const second = await ctx().trades.create({ ...base(), idempotencyKey: 'key-12345678', requestHash: 'hash-a' });

    expect(second.replayed).toBe(true);
    expect(second.trade.id).toBe(first.trade.id);
    expect(await ctx().users.getBalanceCents(user.userId)).toBe(1_000_000 - 1_000);
    expect(await ctx().trades.countOpenTrades(user.userId)).toBe(1);
  });

  it('rejects an Idempotency-Key reused with a different payload', async () => {
    await ctx().trades.create({ ...base(), idempotencyKey: 'key-abcdefgh', requestHash: 'hash-a' });
    await expect(
      ctx().trades.create({ ...base(), amountCents: 2_000, idempotencyKey: 'key-abcdefgh', requestHash: 'hash-b' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await ctx().trades.countOpenTrades(user.userId)).toBe(1);
  });

  it('snapshots the payout rate at trade creation time', async () => {
    const first = await ctx().trades.create(base());
    await ctx().settings.update({ payoutRate: 0.5 }, 'system');
    const second = await ctx().trades.create(base());

    expect(first.trade.payoutRate).toBe(0.85);
    expect(second.trade.payoutRate).toBe(0.5);

    app.clock.advance(5_000);
    ctx().engine.ingest(105, app.clock.now());
    const settled = await ctx().trades.settleDue(app.clock.now());
    const payouts = Object.fromEntries(settled.map((s) => [s.trade.id, s.trade.payoutCents]));
    expect(payouts[first.trade.id]).toBe(1_850);
    expect(payouts[second.trade.id]).toBe(1_500);
  });

  it('throws AppError instances with stable codes', async () => {
    try {
      await ctx().trades.create({ ...base(), durationSec: 3 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(422);
    }
  });
});
