import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, login, registerUser, TEST_ADMIN, type TestContext } from '../helpers/app.js';
import { generateRecoveryCodes, hashRecoveryCode, totp } from '../../src/auth/totp.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

const unique = () => Math.random().toString(36).slice(2, 8);

describe('registration', () => {
  it('creates a user, opens a session and sets an httpOnly cookie', async () => {
    const client = ctx.client();
    await client.get('/api/v1/config');
    const suffix = unique();
    const res = await client.post('/api/v1/auth/register', {
      email: `new_${suffix}@example.com`,
      username: `new_${suffix}`,
      password: 'password-12345',
      acceptTerms: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(`new_${suffix}@example.com`);
    expect(res.body.user.termsAcceptedAt).toBeTypeOf('number');
    expect(res.body.wallets).toHaveLength(3);
    expect(res.body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
  });

  it('rejects registration without accepting the terms', async () => {
    const client = ctx.client();
    await client.get('/api/v1/config');
    const suffix = unique();
    const res = await client.post('/api/v1/auth/register', {
      email: `nterms_${suffix}@example.com`,
      username: `nterms_${suffix}`,
      password: 'password-12345',
      acceptTerms: false,
    });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate email and username case-insensitively', async () => {
    const user = await registerUser(ctx);
    const other = ctx.client();
    await other.get('/api/v1/config');
    const email = await other.post('/api/v1/auth/register', {
      email: user.email.toUpperCase(),
      username: `x_${unique()}`,
      password: 'password-12345',
      acceptTerms: true,
    });
    expect(email.status).toBe(409);
    expect(email.body.error.code).toBe('EMAIL_TAKEN');
    const username = await other.post('/api/v1/auth/register', {
      email: `fresh_${unique()}@example.com`,
      username: user.username.toUpperCase(),
      password: 'password-12345',
      acceptTerms: true,
    });
    expect(username.status).toBe(409);
    expect(username.body.error.code).toBe('USERNAME_TAKEN');
  });
});

describe('login, sessions and CSRF', () => {
  it('logs in by email or username', async () => {
    const user = await registerUser(ctx);
    const byEmail = await login(ctx, user.email, user.password);
    const byUsername = await login(ctx, user.username, user.password);
    expect(byEmail.cookies.get(ctx.config.COOKIE_NAME)).toBeTruthy();
    expect(byUsername.cookies.get(ctx.config.COOKIE_NAME)).toBeTruthy();
  });

  it('requires the CSRF header on mutations', async () => {
    const user = await registerUser(ctx);
    const res = await user.client.post('/api/v1/account/reset', {}, { noCsrf: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('lists sessions and revokes another device', async () => {
    const user = await registerUser(ctx);
    const second = await login(ctx, user.email, user.password);
    const list = await user.client.get('/api/v1/auth/sessions');
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(2);
    const other = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect(other).toBeTruthy();
    const revoked = await user.client.delete(`/api/v1/auth/sessions/${other.id}`);
    expect(revoked.status).toBe(200);
    // the other device's session is dead immediately
    const after = await second.get('/api/v1/auth/me');
    expect(after.body.user).toBeNull();
  });

  it('kills every other session with logout-all but keeps the current one', async () => {
    const user = await registerUser(ctx);
    const second = await login(ctx, user.email, user.password);
    const res = await user.client.post('/api/v1/auth/logout-all', {});
    expect(res.status).toBe(200);
    expect((await second.get('/api/v1/auth/me')).body.user).toBeNull();
    expect((await user.client.get('/api/v1/auth/me')).body.user.id).toBe(user.userId);
  });

  it('locks the account temporarily after too many failed logins', async () => {
    const user = await registerUser(ctx);
    for (let i = 0; i < 8; i++) {
      const res = await ctx.client().post('/api/v1/auth/login', { identifier: user.email, password: 'wrong-password' });
      expect([401, 423]).toContain(res.status);
    }
    const locked = await ctx.client().post('/api/v1/auth/login', { identifier: user.email, password: user.password });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('password reset and email verification', () => {
  it('resets the password with a single-use token', async () => {
    const user = await registerUser(ctx);
    const client = ctx.client();
    const forgot = await client.post('/api/v1/auth/forgot-password', { email: user.email });
    expect(forgot.status).toBe(200);
    const link: string = forgot.body.devResetLink;
    expect(link).toContain('reset-password?token=');
    const token = new URL(link, 'http://local').searchParams.get('token')!;
    const reset = await client.post('/api/v1/auth/reset-password', { token, password: 'brand-new-password' });
    expect(reset.status).toBe(200);
    const reuse = await client.post('/api/v1/auth/reset-password', { token, password: 'another-password' });
    expect(reuse.status).toBe(400);
    const loggedIn = await login(ctx, user.email, 'brand-new-password');
    expect(loggedIn.sessionCookie()).toBeTruthy();
  });

  it('verifies the email through the dev link', async () => {
    const user = await registerUser(ctx);
    const dev = await user.client.get(`/api/v1/auth/dev/link?email=${encodeURIComponent(user.email)}`);
    const token = new URL(dev.body.link, 'http://local').searchParams.get('token')!;
    const verified = await ctx.client().post('/api/v1/auth/verify-email', { token });
    expect(verified.status).toBe(200);
    expect(verified.body.user.emailVerified).toBe(true);
  });

  it('does not leak whether an email exists', async () => {
    const res = await ctx.client().post('/api/v1/auth/forgot-password', { email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.devResetLink).toBeUndefined();
  });
});

describe('two-factor authentication', () => {
  it('enables 2FA, requires a code at login and accepts a recovery code once', async () => {
    const user = await registerUser(ctx);
    const setup = await user.client.post('/api/v1/auth/2fa/setup', {});
    expect(setup.status).toBe(200);
    const secret: string = setup.body.secret;
    expect(setup.body.otpauthUrl).toContain('otpauth://totp/');

    const wrong = await user.client.post('/api/v1/auth/2fa/enable', { code: '000000' });
    expect(wrong.status).toBe(400);

    const code = totp(secret);
    const enabled = await user.client.post('/api/v1/auth/2fa/enable', { code });
    expect(enabled.status).toBe(200);
    const recoveryCodes: string[] = enabled.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(8);

    const needCode = await ctx.client().post('/api/v1/auth/login', { identifier: user.email, password: user.password });
    expect(needCode.status).toBe(200);
    expect(needCode.body.totpRequired).toBe(true);
    expect(needCode.headers['set-cookie']).toBeUndefined();

    const withCode = await ctx.client().post('/api/v1/auth/login', {
      identifier: user.email,
      password: user.password,
      totpCode: totp(secret),
    });
    expect(withCode.status).toBe(200);
    expect(withCode.body.user.twoFactorEnabled).toBe(true);

    const withRecovery = await ctx.client().post('/api/v1/auth/login', {
      identifier: user.email,
      password: user.password,
      totpCode: recoveryCodes[0],
    });
    expect(withRecovery.status).toBe(200);

    const reused = await ctx.client().post('/api/v1/auth/login', {
      identifier: user.email,
      password: user.password,
      totpCode: recoveryCodes[0],
    });
    expect(reused.status).toBe(401);

    const disable = await user.client.post('/api/v1/auth/2fa/disable', {
      password: user.password,
      code: totp(secret),
    });
    expect(disable.status).toBe(200);
  });

  it('hashes recovery codes (never stores the plain code)', async () => {
    const codes = generateRecoveryCodes(3);
    const hashed = codes.map(hashRecoveryCode);
    expect(hashed.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });
});

describe('admin seed credentials', () => {
  it('exposes the seeded admin as super_admin', async () => {
    const admin = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const me = await admin.get('/api/v1/auth/me');
    expect(me.body.user.staffRole).toBe('super_admin');
    expect(me.body.permissions).toContain('settings.write');
  });
});
