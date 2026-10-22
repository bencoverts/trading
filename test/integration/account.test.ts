import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, seedPrice, type TestContext } from '../helpers/app.js';

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

describe('profile', () => {
  it('returns wallets, limits and simulation flags', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.get('/api/v1/account');
    expect(res.status).toBe(200);
    expect(res.body.wallets).toHaveLength(3);
    expect(res.body.limits.maxOpenTrades).toBeGreaterThan(0);
    expect(res.body.label).toBe('SIMULASI');
    expect(res.body.rates.USD).toBe(1);
  });

  it('updates display name, language and timezone', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.patch('/api/v1/account', {
      displayName: 'Budi Simulasi',
      language: 'en',
      timezone: 'Asia/Makassar',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('Budi Simulasi');
    expect(res.body.user.language).toBe('en');
    expect(res.body.user.timezone).toBe('Asia/Makassar');
  });

  it('accepts a PNG avatar and serves it from /uploads', async () => {
    const user = await registerUser(ctx);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await user.client
      .request('post', '/api/v1/account/avatar', {})
      .then(() => null)
      .catch(() => null);
    void res;
    const upload = await ctx
      .api()
      .post('/api/v1/account/avatar')
      .set('Cookie', cookieOf(user))
      .set('x-csrf-token', user.client.csrfToken() ?? '')
      .attach('file', png, 'avatar.png');
    expect(upload.status).toBe(201);
    expect(upload.body.avatarUrl).toMatch(/^\/uploads\/avatars\/[a-z0-9-]+\.png$/);
    const served = await ctx.api().get(upload.body.avatarUrl);
    expect(served.status).toBe(200);
  });

  it('rejects a file whose magic bytes are not an image', async () => {
    const user = await registerUser(ctx);
    const upload = await ctx
      .api()
      .post('/api/v1/account/avatar')
      .set('Cookie', cookieOf(user))
      .set('x-csrf-token', user.client.csrfToken() ?? '')
      .attach('file', Buffer.from('<html>not an image</html>'), 'x.png');
    expect(upload.status).toBe(422);
    expect(upload.body.error.code).toBe('UPLOAD_INVALID');
  });
});

describe('demo wallets', () => {
  it('tops up within the cap and enforces the cooldown', async () => {
    const user = await registerUser(ctx);
    const ok = await user.client.post('/api/v1/wallet/topup', { currency: 'USD', amount: 100 });
    expect(ok.status).toBe(201);
    expect(ok.body.wallet.balance).toBe(1_100);
    const again = await user.client.post('/api/v1/wallet/topup', { currency: 'USD', amount: 100 });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('COOLDOWN');

    const overCap = await user.client.post('/api/v1/wallet/topup', { currency: 'USD', amount: 99_999 });
    expect(overCap.status).toBe(422); // the per-transaction cap is validated first
  });

  it('rejects a top-up above the configured cap', async () => {
    const user = await registerUser(ctx);
    ctx.runtime.ctx.settings.update({ topupCooldownSec: 0 }, { actorRole: 'system' });
    const over = await user.client.post('/api/v1/wallet/topup', { currency: 'IDR', amount: 999_999_999 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('AMOUNT_NOT_ALLOWED');
    ctx.runtime.ctx.settings.update({ topupCooldownSec: 30 }, { actorRole: 'system' });
  });

  it('converts between demo currencies using the configured FX rate', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/wallet/convert', { from: 'USD', to: 'IDR', amount: 10 });
    expect(res.status).toBe(201);
    expect(res.body.rate).toBe(16_000);
    expect(res.body.to.balance).toBe(15_000_000 + 160_000);
    expect(res.body.from.balance).toBe(990);
    const rows = ctx.db.all<{ n: number }>('SELECT id FROM conversions WHERE user_id = ?', user.userId);
    expect(rows).toHaveLength(1);
  });

  it('cannot convert more than the balance', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/wallet/convert', { from: 'USD', to: 'IDR', amount: 5_000 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('resets demo balances to the configured starting balance', async () => {
    const user = await registerUser(ctx);
    await user.client.post('/api/v1/wallet/topup', { currency: 'USD', amount: 50 });
    ctx.clock.advance(10 * 60_000);
    const res = await user.client.post('/api/v1/account/reset', {});
    expect(res.status).toBe(200);
    expect(res.body.wallets.find((w: { currency: string }) => w.currency === 'USD').balance).toBe(1_000);
    expect(res.body.voidedTrades).toBe(0);
  });

  it('voids open trades as refunds when resetting', async () => {
    const user = await registerUser(ctx);
    await user.client.post('/api/v1/wallet/topup', { currency: 'USD', amount: 10 });
    const trade = await user.client.post('/api/v1/trades', {
      market: 'DOGE',
      direction: 'up',
      currency: 'USD',
      amount: 5,
      durationSec: 300,
    });
    expect(trade.status).toBe(201);
    ctx.clock.advance(10 * 60_000);
    const res = await user.client.post('/api/v1/account/reset', {});
    expect(res.status).toBe(200);
    expect(res.body.voidedTrades).toBe(1);
    const row = ctx.db.get<{ status: string; settle_reason: string | null }>(
      'SELECT status, settle_reason FROM trades WHERE id = ?',
      trade.body.trade.id,
    );
    expect(row?.status).toBe('closed');
    expect(row?.settle_reason).toContain('reset');
  });

  it('lists ledger entries with direction and running balance', async () => {
    const user = await registerUser(ctx);
    await user.client.post('/api/v1/wallet/topup', { currency: 'USD', amount: 25 });
    const res = await user.client.get('/api/v1/wallet/transactions?currency=USD');
    expect(res.status).toBe(200);
    const kinds = res.body.transactions.map((t: { kind: string }) => t.kind);
    expect(kinds).toContain('demo_topup');
    expect(res.body.transactions[0].balanceAfter).toBe(1_025);
    expect(res.body.transactions[0].direction).toBe('credit');
  });
});

describe('favourites and notifications', () => {
  it('toggles a favourite and returns it in the account payload', async () => {
    const user = await registerUser(ctx);
    const add = await user.client.post('/api/v1/favorites/DOGE', {});
    expect(add.status).toBe(200);
    expect(add.body.favorites).toContain('DOGE');
    const account = await user.client.get('/api/v1/account');
    expect(account.body.favorites).toContain('DOGE');
    const remove = await user.client.post('/api/v1/favorites/DOGE', {});
    expect(remove.body.favorites).not.toContain('DOGE');
  });

  it('reorders favourites through PUT', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.put('/api/v1/favorites', { markets: ['DOGE', 'ASIA_COMPOSITE'] });
    expect(res.status).toBe(200);
    expect(res.body.favorites).toEqual(['DOGE', 'ASIA_COMPOSITE']);
  });

  it('creates a notification when a trade settles and can mark it read', async () => {
    const user = await registerUser(ctx);
    const trade = await user.client.post('/api/v1/trades', {
      market: 'ASIA_COMPOSITE',
      direction: 'up',
      currency: 'USD',
      amount: 5,
      durationSec: 5,
    });
    ctx.clock.advance(4_000);
    ctx.runtime.ctx.engine.ingest('ASIA_COMPOSITE', 6_100, ctx.clock.now());
    ctx.clock.advance(2_000);
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());
    const list = await user.client.get('/api/v1/notifications');
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    expect(list.body.unread).toBeGreaterThanOrEqual(1);
    const read = await user.client.post('/api/v1/notifications/read', { id: 'all' });
    expect(read.status).toBe(200);
    const after = await user.client.get('/api/v1/notifications');
    expect(after.body.unread).toBe(0);
    expect(trade.status).toBe(201);
  });
});

function cookieOf(user: { client: { cookies: Map<string, string> } }): string {
  return [...user.client.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
