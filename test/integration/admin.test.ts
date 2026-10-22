import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createStaffUser,
  createTestApp,
  loginAdmin,
  registerUser,
  seedPrice,
  type TestContext,
} from '../helpers/app.js';

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof loginAdmin>>;

beforeAll(async () => {
  ctx = await createTestApp();
  seedPrice(ctx, 'ASIA_COMPOSITE', 6_000);
  seedPrice(ctx, 'DOGE', 0.42);
  seedPrice(ctx, 'CRYPTO_COMPOSITE', 41_000);
  admin = await loginAdmin(ctx);
});

afterAll(async () => {
  await ctx.close();
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('dashboard and permissions', () => {
  it('returns cards, charts and alerts', async () => {
    const res = await admin.get('/api/v1/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.users.total).toBeGreaterThan(0);
    expect(res.body.trades).toBeTruthy();
    expect(res.body.perHour).toHaveLength(24);
    expect(res.body.perDay.length).toBeGreaterThanOrEqual(7);
    expect(Array.isArray(res.body.alerts)).toBe(true);
  });

  it('exposes the permission matrix', async () => {
    const res = await admin.get('/api/v1/admin/permissions');
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('support');
    const entry = res.body.matrix.find((row: { permission: string }) => row.permission === 'markets.write');
    expect(entry.roles.operator).toBe(true);
    expect(entry.roles.viewer).toBe(false);
  });
});

describe('market management', () => {
  it('creates a market with an uploaded logo, then shows it to users', async () => {
    const upload = await ctx
      .api()
      .post('/api/v1/admin/uploads/image?folder=markets')
      .set('Cookie', cookieOf(admin))
      .set('x-csrf-token', admin.csrfToken() ?? '')
      .attach('file', png, 'logo.png');
    expect(upload.status).toBe(201);
    expect(upload.body.url).toMatch(/^\/uploads\/markets\//);

    const suggestion = await admin.get('/api/v1/admin/markets/suggestions/forex');
    expect(suggestion.status).toBe(200);
    expect(suggestion.body.price).toBeGreaterThan(0);

    const preview = await admin.post('/api/v1/admin/markets/preview', {
      startPrice: 1.085,
      priceDecimals: 4,
      volatilityPreset: 'sedang',
      mood: 'normal',
    });
    expect(preview.status).toBe(200);
    expect(preview.body.candles.length).toBeGreaterThan(0);

    const created = await admin.post('/api/v1/admin/markets', {
      symbol: 'EURUSD_DEMO',
      name: 'EUR/USD (simulasi)',
      description: 'Pasangan mata uang simulasi',
      category: 'forex',
      priceDecimals: 4,
      startPrice: 1.085,
      tickSize: 0.0001,
      volatilityPreset: 'rendah',
      mood: 'sepi',
      minAmountUsd: 1,
      maxAmountUsd: 500,
      exposureLimitUsd: 5_000,
      logoPath: upload.body.relativePath,
      activate: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.market.symbol).toBe('EURUSD_DEMO');
    expect(created.body.market.logoUrl).toBe(upload.body.url);
    expect(created.body.market.status).toBe('active');

    const publicList = await ctx.api().get('/api/v1/markets');
    const found = publicList.body.markets.find((m: { symbol: string }) => m.symbol === 'EURUSD_DEMO');
    expect(found).toBeTruthy();
    expect(found.logoUrl).toBe(upload.body.url);
    expect(ctx.runtime.ctx.engine.lastPrice('EURUSD_DEMO')).toBeTypeOf('number');
    const candles = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM candles WHERE market = ?', 'EURUSD_DEMO');
    expect(Number(candles?.n ?? 0)).toBeGreaterThan(0);
  });

  it('rejects a duplicate symbol and an invalid symbol', async () => {
    const base = {
      name: 'Duplikat',
      category: 'lainnya',
      priceDecimals: 2,
      startPrice: 10,
      tickSize: 0.1,
      volatilityPreset: 'sedang',
      mood: 'normal',
    };
    const dup = await admin.post('/api/v1/admin/markets', { ...base, symbol: 'EURUSD_DEMO' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('MARKET_SYMBOL_TAKEN');
    const invalid = await admin.post('/api/v1/admin/markets', { ...base, symbol: 'bad symbol' });
    expect(invalid.status).toBe(400);
  });

  it('creates a draft market that is invisible to users until activated', async () => {
    const draft = await admin.post('/api/v1/admin/markets', {
      symbol: 'DRAFT_TEST',
      name: 'Draft Market',
      category: 'index',
      priceDecimals: 2,
      startPrice: 100,
      tickSize: 0.5,
      volatilityPreset: 'sedang',
      mood: 'normal',
      activate: false,
    });
    expect(draft.status).toBe(201);
    expect(draft.body.market.status).toBe('draft');
    const list = await ctx.api().get('/api/v1/markets');
    expect(list.body.markets.map((m: { symbol: string }) => m.symbol)).not.toContain('DRAFT_TEST');

    const activated = await admin.patch('/api/v1/admin/markets/DRAFT_TEST', { active: true, draft: false });
    expect(activated.status).toBe(200);
    expect(activated.body.market.status).toBe('active');
  });

  it('changes simulation parameters and records every change in market history', async () => {
    const res = await admin.post('/api/v1/admin/markets/DOGE/simulate', {
      trend: 'up',
      trendStrength: 8,
      volatilityPreset: 'ekstrem',
      mood: 'liar',
    });
    expect(res.status).toBe(200);
    expect(res.body.engine.trend).toBe('up');
    const history = await admin.get('/api/v1/admin/markets/DOGE/history');
    expect(history.body.entries.length).toBeGreaterThan(0);
    const latest = history.body.entries[0];
    expect(latest.actorRole).toBe('admin');
    expect(latest.after).toBeTruthy();

    const pause = await admin.post('/api/v1/admin/markets/DOGE/simulate', { paused: true, pauseReason: 'maintenance' });
    expect(pause.status).toBe(200);
    const publicHistory = await ctx.api().get('/api/v1/markets/DOGE/history');
    expect(
      publicHistory.body.entries.some((e: { after: { paused?: number } | null }) => Boolean(e.after?.paused)),
    ).toBe(true);
    await admin.post('/api/v1/admin/markets/DOGE/simulate', { paused: false });
  });

  it('warns when the start price is edited but leaves running trades untouched', async () => {
    const trader = await registerUser(ctx);
    const trade = await trader.client.post('/api/v1/trades', {
      market: 'ASIA_COMPOSITE',
      direction: 'up',
      currency: 'USD',
      amount: 5,
      durationSec: 300,
    });
    expect(trade.status).toBe(201);
    const entryBefore = trade.body.trade.entryPrice as number;
    const patch = await admin.patch('/api/v1/admin/markets/ASIA_COMPOSITE', { startPrice: 6_500 });
    expect(patch.status).toBe(200);
    const row = ctx.db.get<{ entry_price: number; base_price: number }>(
      'SELECT entry_price, base_price FROM trades t JOIN markets m ON m.symbol = t.market WHERE t.id = ?',
      trade.body.trade.id,
    );
    expect(row?.entry_price).toBe(entryBefore);
    expect(row?.base_price).toBe(6_500);
  });

  it('refuses to soft delete a market with open trades, then deletes when clear', async () => {
    const trader = await registerUser(ctx);
    await trader.client.post('/api/v1/trades', {
      market: 'EURUSD_DEMO',
      direction: 'up',
      currency: 'USD',
      amount: 2,
      durationSec: 300,
    });
    const blocked = await admin.delete('/api/v1/admin/markets/EURUSD_DEMO');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MARKET_HAS_OPEN_TRADES');

    ctx.clock.advance(400_000);
    ctx.runtime.ctx.engine.ingest('EURUSD_DEMO', 1.09, ctx.clock.now());
    ctx.runtime.ctx.trades.settleDue(ctx.clock.now());

    const ok = await admin.delete('/api/v1/admin/markets/EURUSD_DEMO');
    expect(ok.status).toBe(200);
    const list = await ctx.api().get('/api/v1/markets');
    expect(list.body.markets.map((m: { symbol: string }) => m.symbol)).not.toContain('EURUSD_DEMO');
    const restore = await admin.post('/api/v1/admin/markets/EURUSD_DEMO/restore', {});
    expect(restore.status).toBe(200);
  });
});

describe('trades administration', () => {
  it('lists trades with filters and exports CSV', async () => {
    const list = await admin.get('/api/v1/admin/trades?status=closed&limit=10');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.trades)).toBe(true);
    const csv = await admin.get('/api/v1/admin/trades/export.csv');
    expect(csv.status).toBe(200);
    expect(String(csv.text).split('\n')[0]).toContain('user_email');
    const stats = await admin.get('/api/v1/admin/trades/stats');
    expect(stats.body.byDuration.length).toBeGreaterThanOrEqual(0);
  });

  it('manually settles a trade with a mandatory reason and notifies the user', async () => {
    const trader = await registerUser(ctx);
    const trade = await trader.client.post('/api/v1/trades', {
      market: 'CRYPTO_COMPOSITE',
      direction: 'down',
      currency: 'USD',
      amount: 5,
      durationSec: 300,
    });
    const id = trade.body.trade.id as string;
    const noReason = await admin.post(`/api/v1/admin/trades/${id}/settle`, {});
    expect(noReason.status).toBe(400);

    const settled = await admin.post(`/api/v1/admin/trades/${id}/settle`, {
      reason: 'koreksi manual untuk uji',
      closePrice: 40_000,
    });
    expect(settled.status).toBe(200);
    expect(settled.body.trade.result).toBe('win');
    expect(settled.body.trade.settledBy).toBe('admin');
    expect(settled.body.trade.settleReason).toContain('koreksi');

    const history = await trader.client.get('/api/v1/trades?status=closed');
    expect(history.body.trades[0].settledBy).toBe('admin');
    const notifications = await trader.client.get('/api/v1/notifications');
    expect(notifications.body.items.some((n: { kind: string }) => n.kind === 'trade_admin_settled')).toBe(true);

    const audit = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.trade_settled' AND target_id = ?`,
      id,
    );
    expect(Number(audit?.n ?? 0)).toBe(1);
  });
});

describe('user administration', () => {
  it('searches users and shows their detail', async () => {
    const user = await registerUser(ctx);
    const search = await admin.get(`/api/v1/admin/users?search=${user.username}`);
    expect(search.status).toBe(200);
    expect(search.body.users[0].username).toBe(user.username);
    const detail = await admin.get(`/api/v1/admin/users/${user.userId}`);
    expect(detail.body.wallets).toHaveLength(3);
    expect(detail.body.sessions.length).toBeGreaterThan(0);
  });

  it('adjusts a demo balance with a reason and notifies the user', async () => {
    const user = await registerUser(ctx);
    const res = await admin.post(`/api/v1/admin/users/${user.userId}/wallet`, {
      currency: 'USD',
      mode: 'set',
      amount: 250,
      reason: 'kompensasi demo',
    });
    expect(res.status).toBe(200);
    expect(res.body.wallet.balance).toBe(250);
    const ledger = await user.client.get('/api/v1/wallet/transactions');
    expect(ledger.body.transactions[0].kind).toBe('admin_adjustment');
    const negative = await admin.post(`/api/v1/admin/users/${user.userId}/wallet`, {
      currency: 'USD',
      mode: 'subtract',
      amount: 10_000,
      reason: 'uji saldo negatif',
    });
    expect(negative.status).toBe(422);
  });

  it('blocks a user, killing their sessions immediately', async () => {
    const user = await registerUser(ctx);
    const res = await admin.post(`/api/v1/admin/users/${user.userId}/block`, {
      blocked: true,
      reason: 'pelanggaran aturan demo',
    });
    expect(res.status).toBe(200);
    const after = await user.client.get('/api/v1/auth/me');
    expect(after.body.user).toBeNull();
    const trade = await user.client.post('/api/v1/trades', {
      market: 'DOGE',
      direction: 'up',
      currency: 'USD',
      amount: 1,
      durationSec: 60,
    });
    expect(trade.status).toBe(401);
    const unblock = await admin.post(`/api/v1/admin/users/${user.userId}/block`, { blocked: false });
    expect(unblock.status).toBe(200);
  });

  it('adds internal notes visible only to staff', async () => {
    const user = await registerUser(ctx);
    const res = await admin.post(`/api/v1/admin/users/${user.userId}/notes`, { body: 'Sering logout sendiri.' });
    expect(res.status).toBe(201);
    expect(res.body.notes[0].body).toContain('logout');
    const asUser = await user.client.get(`/api/v1/admin/users/${user.userId}/notes`);
    expect(asUser.status).toBe(403);
  });
});

describe('settings, content and finance', () => {
  it('updates platform settings and validates them', async () => {
    const res = await admin.patch('/api/v1/admin/settings', {
      payoutRate: 0.9,
      maxOpenTrades: 12,
      platformName: 'SimTrade Uji',
      themeAccent: '#22aa88',
    });
    expect(res.status).toBe(200);
    expect(res.body.settings.payoutRate).toBe(0.9);
    expect(res.body.settings.platformName).toBe('SimTrade Uji');
    const config = await ctx.api().get('/api/v1/config');
    expect(config.body.platform.accent).toBe('#22aa88');
    const invalid = await admin.patch('/api/v1/admin/settings', { minAmount: { USD: 500 }, maxAmount: { USD: 100 } });
    expect(invalid.status).toBe(400);
    await admin.patch('/api/v1/admin/settings', { platformName: 'SimTrade Demo', payoutRate: 0.85 });
  });

  it('maintains banners and content pages', async () => {
    const banner = await admin.post('/api/v1/admin/banners', {
      title: 'Selamat datang di demo',
      body: 'Semua saldo virtual.',
      link: '/faq',
    });
    expect(banner.status).toBe(201);
    const live = await ctx.api().get('/api/v1/banners');
    expect(live.body.banners[0].title).toContain('demo');
    const updated = await admin.patch(`/api/v1/admin/banners/${banner.body.banner.id}`, { active: false });
    expect(updated.status).toBe(200);
    const after = await ctx.api().get('/api/v1/banners');
    expect(after.body.banners).toHaveLength(0);

    const page = await admin.put('/api/v1/admin/pages/faq', {
      title: 'FAQ',
      body: '## FAQ\n\nSemua simulasi.',
    });
    expect(page.status).toBe(200);
    const publicFaq = await ctx.api().get('/api/v1/pages/faq');
    expect(publicFaq.body.page.body).toContain('Semua simulasi');
  });

  it('reports demo finance and updates FX with history', async () => {
    const finance = await admin.get('/api/v1/admin/finance');
    expect(finance.status).toBe(200);
    expect(finance.body.rates.USD).toBe(1);
    const fx = await admin.post('/api/v1/admin/finance/fx', { IDR: 16_250, USDT: 1, note: 'uji kurs' });
    expect(fx.status).toBe(200);
    expect(fx.body.rates.IDR).toBe(16_250);
    expect(fx.body.history.length).toBeGreaterThan(0);
    await admin.post('/api/v1/admin/finance/fx', { IDR: 16_000, USDT: 1 });
  });
});

describe('system', () => {
  it('reports health, jobs, backups and logs', async () => {
    const system = await admin.get('/api/v1/admin/system');
    expect(system.status).toBe(200);
    expect(system.body.db.ok).toBe(true);
    expect(Array.isArray(system.body.jobs)).toBe(true);
    const jobs = await admin.get('/api/v1/admin/jobs');
    expect(jobs.body.jobs.length).toBeGreaterThanOrEqual(4);
    const run = await admin.post('/api/v1/admin/jobs/cleanup/run', {});
    expect(run.status).toBe(200);

    const backup = await admin.post('/api/v1/admin/backups', {});
    expect(backup.status).toBe(201);
    expect(backup.body.backup.sizeBytes).toBeGreaterThan(0);
    const list = await admin.get('/api/v1/admin/backups');
    expect(list.body.backups.length).toBe(1);
    const download = await admin.get(`/api/v1/admin/backups/${backup.body.backup.id}/download`);
    expect(download.status).toBe(200);

    const logs = await admin.get('/api/v1/admin/logs?level=info');
    expect(logs.status).toBe(200);
    const audit = await admin.get('/api/v1/admin/audit?limit=5');
    expect(audit.status).toBe(200);
    expect(audit.body.total).toBeGreaterThan(0);
    const auditCsv = await admin.get('/api/v1/admin/audit/export.csv');
    expect(String(auditCsv.text).split('\n')[0]).toContain('action');
  });

  it('keeps the payments module disabled', async () => {
    const res = await admin.get('/api/v1/admin/payments');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('writes every privileged action to the audit log', async () => {
    const rows = ctx.db.all<{ action: string }>(
      `SELECT action FROM audit_log WHERE actor_role = 'admin' ORDER BY id DESC LIMIT 50`,
    );
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['admin.market_created', 'settings.updated', 'admin.wallet_adjusted']),
    );
  });
});

describe('staff roles', () => {
  it('lets an operator manage markets but not settings', async () => {
    const operator = await createStaffUser(ctx, 'operator');
    const markets = await operator.client.get('/api/v1/admin/markets');
    expect(markets.status).toBe(200);
    const settings = await operator.client.patch('/api/v1/admin/settings', { payoutRate: 0.9 });
    expect(settings.status).toBe(403);
    const simulate = await operator.client.post('/api/v1/admin/markets/DOGE/simulate', { mood: 'normal' });
    expect(simulate.status).toBe(200);
  });

  it('lets support adjust balances but not settle trades', async () => {
    const support = await createStaffUser(ctx, 'support');
    const user = await registerUser(ctx);
    const adjust = await support.client.post(`/api/v1/admin/users/${user.userId}/wallet`, {
      currency: 'USD',
      mode: 'add',
      amount: 5,
      reason: 'bantuan demo',
    });
    expect(adjust.status).toBe(200);
    const settle = await support.client.post('/api/v1/admin/trades/00000000-0000-4000-8000-000000000000/settle', {
      reason: 'tes',
    });
    expect(settle.status).toBe(403);
  });

  it('gives viewers read-only access', async () => {
    const viewer = await createStaffUser(ctx, 'viewer');
    expect((await viewer.client.get('/api/v1/admin/trades')).status).toBe(200);
    expect((await viewer.client.patch('/api/v1/admin/settings', { payoutRate: 0.8 })).status).toBe(403);
    expect((await viewer.client.post('/api/v1/admin/markets/DOGE/simulate', { mood: 'cepat' })).status).toBe(403);
  });
});

function cookieOf(client: { cookies: Map<string, string> }): string {
  return [...client.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
