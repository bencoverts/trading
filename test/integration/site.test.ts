import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, createTestApp, login, registerUser, TEST_ADMIN, type TestContext } from '../helpers/app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp({ env: { PAYMENTS_ENABLED: 'true' } });
});

afterAll(async () => {
  await ctx.close();
});

describe('site configuration', () => {
  it('exposes public branding without leaking secrets', async () => {
    const res = await ctx.api().get('/api/v1/site');
    expect(res.status).toBe(200);
    expect(res.body.branding.name).toBeTruthy();
    expect(res.body.flags.deposits).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/api[_-]?key|secret|password/i);
  });

  it('validates the patch and audits the change', async () => {
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const invalid = await admin.patch('/api/v1/admin/site', { branding: { accent: 'blue' } });
    expect(invalid.status).toBe(400);
    const ok = await admin.patch('/api/v1/admin/site', {
      branding: { name: 'SimTrade Demo Baru' },
      landing: { heroTitle: 'Judul baru untuk demo' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.site.branding.name).toBe('SimTrade Demo Baru');
    const audit = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.site_updated'");
    expect(Number(audit?.n)).toBeGreaterThan(0);
    const publicSite = await ctx.api().get('/api/v1/site');
    expect(publicSite.body.branding.name).toBe('SimTrade Demo Baru');
  });

  it('blocks a non-super-admin from editing the site', async () => {
    const operator = await createStaffUser(ctx, 'operator');
    const res = await operator.client.patch('/api/v1/admin/site', { branding: { name: 'Nope' } });
    expect(res.status).toBe(403);
  });

  it('gates deposits, withdrawals and chat behind feature flags', async () => {
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const user = await registerUser(ctx);

    const off = await admin.patch('/api/v1/admin/site/flags/deposits', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.flags.deposits).toBe(false);
    const blocked = await user.client.post('/api/v1/deposits/manual', {
      currency: 'IDR',
      amount: 20_000,
      reference: 'FLAG-TEST-1',
    });
    expect(blocked.status).toBe(503);
    const chatBlocked = await admin
      .patch('/api/v1/admin/site/flags/live_chat', { enabled: false })
      .then(() => user.client.post('/api/v1/chat', { subject: 'Halo' }));
    expect(chatBlocked.status).toBe(503);

    await admin.patch('/api/v1/admin/site/flags/deposits', { enabled: true });
    await admin.patch('/api/v1/admin/site/flags/live_chat', { enabled: true });
    const allowed = await user.client.post('/api/v1/deposits/manual', {
      currency: 'IDR',
      amount: 20_000,
      reference: 'FLAG-TEST-2',
    });
    expect(allowed.status).toBe(201);
  });

  it('rejects unknown flags', async () => {
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const res = await admin.patch('/api/v1/admin/site/flags/nope', { enabled: true });
    expect([400, 404]).toContain(res.status);
  });

  it('serves maintenance mode to users but keeps staff and auth working', async () => {
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const user = await registerUser(ctx);
    const enable = await admin.patch('/api/v1/admin/site', {
      maintenance: { enabled: true, message: 'Sedang perawatan demo' },
    });
    expect(enable.status).toBe(200);

    const blocked = await user.client.get('/api/v1/markets');
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('MAINTENANCE_MODE');
    expect(blocked.body.error.message).toContain('perawatan');

    expect((await user.client.get('/api/v1/auth/me')).status).toBe(200);
    expect((await user.client.get('/api/v1/site')).status).toBe(200);
    expect((await admin.get('/api/v1/markets')).status).toBe(200);
    expect((await admin.get('/api/v1/admin/dashboard')).status).toBe(200);

    await admin.patch('/api/v1/admin/site', { maintenance: { enabled: false } });
    expect((await user.client.get('/api/v1/markets')).status).toBe(200);
  });
});

describe('currency administration', () => {
  it('lets finance activate a currency only with a documented FX rate', async () => {
    const finance = await createStaffUser(ctx, 'finance');
    const enabled = await finance.client.patch('/api/v1/admin/currencies/USD', {
      active: true,
      depositEnabled: true,
      fxRateToIdr: 16_300,
      fxSource: 'demo:admin-2026-10',
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.currency.active).toBe(true);
    expect(enabled.body.currency.fxRateToIdr).toBe(16_300);

    const audit = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'admin.currency%'");
    expect(Number(audit?.n)).toBeGreaterThan(0);

    const back = await finance.client.patch('/api/v1/admin/currencies/USD', { active: false, depositEnabled: false });
    expect(back.status).toBe(200);
  });

  it('rejects a negative rate and keeps USDT unusable while inactive', async () => {
    const finance = await createStaffUser(ctx, 'finance');
    const bad = await finance.client.patch('/api/v1/admin/currencies/USDT', { fxRateToIdr: -1 });
    expect(bad.status).toBe(400);
    const attempt = await finance.client.post('/api/v1/withdrawals', {
      currency: 'USDT',
      method: 'ewallet',
      amount: 10,
      destination: { provider: 'OVO', phone: '081234567890' },
    });
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toMatch(/^CURRENCY_(INACTIVE|NOT_AVAILABLE)$/);
  });
});
