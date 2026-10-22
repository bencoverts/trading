import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, createTestApp, registerUser, seedPrice, type TestContext } from '../helpers/app.js';
import { ROLE_PERMISSIONS, PERMISSION_MATRIX, STAFF_ROLES } from '../../src/auth/permissions.js';

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

const adminEndpoints: Array<{ method: 'get' | 'post' | 'patch' | 'delete'; path: string; body?: unknown }> = [
  { method: 'get', path: '/api/v1/admin/dashboard' },
  { method: 'get', path: '/api/v1/admin/markets' },
  { method: 'get', path: '/api/v1/admin/trades' },
  { method: 'get', path: '/api/v1/admin/users' },
  { method: 'get', path: '/api/v1/admin/settings' },
  { method: 'get', path: '/api/v1/admin/finance' },
  { method: 'get', path: '/api/v1/admin/system' },
  { method: 'get', path: '/api/v1/admin/audit' },
  { method: 'post', path: '/api/v1/admin/backups', body: {} },
  { method: 'patch', path: '/api/v1/admin/settings', body: { payoutRate: 0.5 } },
];

describe('normal users', () => {
  it('is blocked from every admin endpoint', async () => {
    const user = await registerUser(ctx);
    for (const endpoint of adminEndpoints) {
      const res = await user.client.request(endpoint.method, endpoint.path, { body: endpoint.body });
      expect(res.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
    }
  });

  it('is unauthenticated without a session', async () => {
    for (const endpoint of adminEndpoints.slice(0, 4)) {
      const res = await ctx.api()[endpoint.method](endpoint.path);
      expect([401, 403]).toContain(res.status);
    }
  });
});

describe('role matrix', () => {
  it('matches the documented permission matrix', () => {
    for (const role of STAFF_ROLES) {
      for (const row of PERMISSION_MATRIX) {
        expect(row.roles[role]).toBe(ROLE_PERMISSIONS[role].includes(row.permission));
      }
    }
    expect(ROLE_PERMISSIONS.super_admin.length).toBe(PERMISSION_MATRIX.length);
  });

  it('only super_admin can change roles', async () => {
    const operator = await createStaffUser(ctx, 'operator');
    const target = await registerUser(ctx);
    const denied = await operator.client.post(`/api/v1/admin/users/${target.userId}/role`, { staffRole: 'support' });
    expect(denied.status).toBe(403);
  });

  it('lets office staff read the dashboard but not the system page unless allowed', async () => {
    const support = await createStaffUser(ctx, 'support');
    expect((await support.client.get('/api/v1/admin/dashboard')).status).toBe(200);
    const system = await support.client.get('/api/v1/admin/system');
    // support has no system.read
    expect(system.status).toBe(403);
  });

  it('rejects staff mutations without a CSRF token', async () => {
    const operator = await createStaffUser(ctx, 'operator');
    const res = await operator.client.post('/api/v1/admin/markets/DOGE/simulate', { mood: 'normal' }, { noCsrf: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('invalidates a staff session as soon as the role is removed', async () => {
    const viewer = await createStaffUser(ctx, 'viewer');
    expect((await viewer.client.get('/api/v1/admin/dashboard')).status).toBe(200);
    // role removal bumps token_version: the old session stops working
    ctx.runtime.ctx.users.setStaffRole(viewer.userId, null, { userId: viewer.userId, role: 'admin' });
    const after = await viewer.client.get('/api/v1/admin/dashboard');
    expect(after.status).toBe(401);
  });

  it('separates market administration from finance work', async () => {
    const finance = await createStaffUser(ctx, 'finance');
    const operator = await createStaffUser(ctx, 'operator');

    // finance can read money queues but not touch markets
    expect((await finance.client.get('/api/v1/admin/deposits?status=all')).status).toBe(200);
    expect((await finance.client.get('/api/v1/admin/withdrawals?status=all')).status).toBe(200);
    expect((await finance.client.post('/api/v1/admin/markets/DOGE/simulate', { mood: 'normal' })).status).toBe(403);

    // operators keep their market powers and cannot process withdrawals
    expect((await operator.client.get('/api/v1/admin/deposits?status=all')).status).toBe(403);
    expect((await operator.client.patch('/api/v1/admin/currencies/IDR', { active: false })).status).toBe(403);
  });

  it('blocks viewer and support from reviewing deposits', async () => {
    const viewer = await createStaffUser(ctx, 'viewer');
    const support = await createStaffUser(ctx, 'support');
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/deposits/manual', {
      currency: 'IDR',
      amount: 20_000,
      reference: `ACC-${Math.random().toString(36).slice(2, 8)}`,
    });
    expect(created.status).toBe(201);
    const id = created.body.deposit.id as string;
    for (const staff of [viewer, support]) {
      const res = await staff.client.post(`/api/v1/admin/deposits/${id}/review`, { action: 'approve' });
      expect(res.status).toBe(403);
    }
    const finance = await createStaffUser(ctx, 'finance');
    const ok = await finance.client.post(`/api/v1/admin/deposits/${id}/review`, { action: 'approve' });
    expect(ok.status).toBe(200);
  });

  it('gives support chat access without money permissions', async () => {
    const support = await createStaffUser(ctx, 'support');
    expect((await support.client.get('/api/v1/admin/chat')).status).toBe(200);
    // read-only payment visibility is fine for support, writes are not
    expect((await support.client.get('/api/v1/admin/payments')).status).toBe(200);
    expect((await support.client.post('/api/v1/admin/payments/test-connection', {})).status).toBe(403);
    expect(
      (await support.client.post('/api/v1/admin/withdrawals/unknown/transition', { action: 'approve' })).status,
    ).toBe(403);
  });
});
