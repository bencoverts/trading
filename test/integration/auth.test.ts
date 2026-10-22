import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookiesFrom, createTestApp, registerUser, type TestContext } from '../helpers/app.js';

let ctx: TestContext;
let api: () => request.SuperTest<request.Test>;

beforeAll(async () => {
  ctx = await createTestApp();
  api = ctx.api;
});
afterAll(async () => {
  await ctx.close();
});

describe('registration and demo wallets', () => {
  it('creates a user with USD, IDR and USDT demo wallets', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'wallet-check@example.com', username: 'walletcheck', password: 'password-12345' })
      .expect(201);

    expect(res.body.user.email).toBe('wallet-check@example.com');
    expect(res.body.user.role).toBe('user');
    expect(res.body.user.emailVerified).toBe(false);
    expect(res.body.wallets.map((w: { currency: string }) => w.currency).sort()).toEqual(['IDR', 'USD', 'USDT']);
    const usd = res.body.wallets.find((w: { currency: string }) => w.currency === 'USD');
    expect(usd.balanceMinor).toBe(100_000); // $1,000.00 default demo balance
    // dev helper: the verification link is returned instead of emailed
    expect(res.body.devVerificationLink).toContain('/verify-email?token=');
  });

  it('rejects duplicate emails and usernames with distinct codes', async () => {
    const dupEmail = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'wallet-check@example.com', username: 'someoneelse', password: 'password-12345' })
      .expect(409);
    expect(dupEmail.body.error.code).toBe('EMAIL_TAKEN');

    const dupUser = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'other@example.com', username: 'walletcheck', password: 'password-12345' })
      .expect(409);
    expect(dupUser.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('validates email, username and password length', async () => {
    const bad = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', username: 'ab', password: 'short' })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it('verifies the email from the dev link', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'verify-me@example.com', username: 'verifyme', password: 'password-12345' })
      .expect(201);
    const token = new URL(reg.body.devVerificationLink).searchParams.get('token');
    const res = await api().post('/api/v1/auth/verify-email').send({ token }).expect(200);
    expect(res.body.user.emailVerified).toBe(true);
    // the link is single use
    await api().post('/api/v1/auth/verify-email').send({ token }).expect(400);
  });
});

describe('login / logout', () => {
  it('accepts email or username and sets an httpOnly session cookie', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'login-me@example.com', username: 'loginme', password: 'password-12345' })
      .expect(201);

    const rawCookie = String(reg.headers['set-cookie'][0]);
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie.toLowerCase()).toContain('samesite=lax');

    await api().post('/api/v1/auth/login').send({ identifier: 'login-me@example.com', password: 'password-12345' }).expect(200);
    const byUsername = await api().post('/api/v1/auth/login').send({ identifier: 'loginme', password: 'password-12345' }).expect(200);
    expect(byUsername.body.user.id).toBe(reg.body.user.id);

    const wrong = await api().post('/api/v1/auth/login').send({ identifier: 'loginme', password: 'wrong-password' }).expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('clears the session cookie on logout', async () => {
    const { cookies } = await registerUser(api());
    const res = await api().post('/api/v1/auth/logout').set('Cookie', cookies.join('; ')).expect(200);
    const cleared = String(res.headers['set-cookie'][0]);
    expect(cleared).toContain('sim_session=');
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    // no cookie at all -> 401 (logout is stateless: the JWT simply stops being sent)
    const anon = await api().post('/api/v1/auth/logout').expect(401);
    expect(anon.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('password reset', () => {
  it('returns the same answer for unknown emails (no account enumeration)', async () => {
    const unknown = await api().post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.com' }).expect(200);
    expect(unknown.body.devResetLink).toBeFalsy();
    expect(unknown.body.message).toContain('If that email exists');
  });

  it('resets the password with a single-use token and invalidates old sessions', async () => {
    const user = await registerUser(api());
    const forgot = await api().post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(200);
    const token = new URL(forgot.body.devResetLink).searchParams.get('token');

    // old session still valid before the reset
    await api().get('/api/v1/account').set('Cookie', user.cookies.join('; ')).expect(200);

    await api().post('/api/v1/auth/reset-password').send({ token, password: 'brand-new-password' }).expect(200);
    // token is single use
    await api().post('/api/v1/auth/reset-password').send({ token, password: 'another-password' }).expect(400);
    // old cookie is revoked (token version bumped)
    await api().get('/api/v1/account').set('Cookie', user.cookies.join('; ')).expect(401);
    // new password works, old one does not
    await api().post('/api/v1/auth/login').send({ identifier: user.email, password: 'brand-new-password' }).expect(200);
    await api().post('/api/v1/auth/login').send({ identifier: user.email, password: user.password }).expect(401);
  });
});

describe('rate limits on auth', () => {
  it('returns 429 after too many login attempts', async () => {
    const app = await createTestApp({ env: { RATE_AUTH_MAX: '5', RATE_AUTH_WINDOW_MS: '60000' } });
    try {
      for (let i = 0; i < 5; i++) {
        await app.api().post('/api/v1/auth/login').send({ identifier: 'x@example.com', password: 'nope' });
      }
      const res = await app.api().post('/api/v1/auth/login').send({ identifier: 'x@example.com', password: 'nope' });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });
});

describe('security headers', () => {
  it('sends helmet headers and no x-powered-by', async () => {
    const res = await api().get('/api/v1/config').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not reflect arbitrary origins in CORS', async () => {
    const blocked = await api().get('/api/v1/config').set('Origin', 'https://evil.example').expect(200);
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
    const allowed = await api().get('/api/v1/config').set('Origin', 'http://localhost:3000').expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});

describe('blocked accounts', () => {
  it('cannot log in once blocked by an admin', async () => {
    const user = await registerUser(api());
    const adminLogin = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: ctx.config.ADMIN_EMAIL, password: ctx.config.ADMIN_PASSWORD })
      .expect(200);
    const adminCookies = cookiesFrom(adminLogin);
    await api()
      .post(`/api/v1/admin/users/${user.userId}/block`)
      .set('Cookie', adminCookies.join('; '))
      .send({ blocked: true, reason: 'test block' })
      .expect(200);

    const res = await api().post('/api/v1/auth/login').send({ identifier: user.email, password: user.password }).expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_BLOCKED');
    // blocking bumps token_version, so every existing session is revoked
    const oldSession = await api().get('/api/v1/account').set('Cookie', user.cookies.join('; ')).expect(401);
    expect(oldSession.body.error.code).toBe('UNAUTHORIZED');
  });
});
