import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../app/context.js';
import { AppError } from '../lib/errors.js';
import { clientIp } from './validation.js';
import { can, permissionsFor, isStaffRole, type Permission, type StaffRole } from '../auth/permissions.js';

export interface IssuedSession {
  token: string;
  csrfToken: string;
  sessionId: string;
}

export interface AuthInfo {
  userId: string;
  sessionId: string;
  role: StaffRole | null;
  permissions: Permission[];
}

export type AuthedRequest = Request;

/** CSRF tokens are derived from the session id, so they never need a table. */
export const csrfTokenFor = (ctx: AppContext, sessionId: string): string =>
  createHmac('sha256', `${ctx.config.JWT_SECRET}:csrf`).update(sessionId).digest('hex');

const cookieOptions = (ctx: AppContext) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: ctx.config.COOKIE_SECURE,
  path: '/',
});

/** Creates the session row, signs the JWT and sets both cookies. */
export function issueSession(ctx: AppContext, req: Request, res: Response, userId: string): IssuedSession {
  const user = ctx.users.findById(userId);
  if (!user) throw AppError.unauthorized('User tidak ditemukan');
  const ttlMs = ctx.config.SESSION_TTL_SEC * 1000;
  const account = ctx.accounts.create({
    userId,
    tokenVersion: user.token_version,
    ttlMs,
    ip: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
  });
  const token = ctx.tokens.sign({ sub: userId, sid: account.id, v: user.token_version });
  const csrfToken = csrfTokenFor(ctx, account.id);
  res.cookie(ctx.config.COOKIE_NAME, token, { ...cookieOptions(ctx), maxAge: ttlMs });
  res.cookie(ctx.config.CSRF_COOKIE, csrfToken, {
    ...cookieOptions(ctx),
    httpOnly: false, // readable by the SPA for the double-submit header
    maxAge: ttlMs,
  });
  return { token, csrfToken, sessionId: account.id };
}

export function clearSession(ctx: AppContext, res: Response): void {
  res.clearCookie(ctx.config.COOKIE_NAME, { path: '/' });
  res.clearCookie(ctx.config.CSRF_COOKIE, { path: '/' });
}

/** Anonymous CSRF cookie (login/register). Value is a random double-submit token. */
export function ensureCsrfCookie(ctx: AppContext, req: Request, res: Response): string {
  const existing = (req as Request & { cookies?: Record<string, string> }).cookies?.[ctx.config.CSRF_COOKIE];
  if (existing && existing.length >= 16) return existing;
  const value = createHmac('sha256', ctx.config.JWT_SECRET)
    .update(`${clientIp(req) ?? 'anon'}:${Date.now()}:${Math.random()}`)
    .digest('base64url');
  res.cookie(ctx.config.CSRF_COOKIE, value, {
    ...cookieOptions(ctx),
    httpOnly: false,
    maxAge: ctx.config.SESSION_TTL_SEC * 1000,
  });
  return value;
}

/** Resolves the session cookie into an AuthInfo. Returns null when anonymous/invalid. */
export function resolveAuth(ctx: AppContext, req: Request): AuthInfo | null {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[ctx.config.COOKIE_NAME];
  if (!token) return null;
  const payload = ctx.tokens.verify(token);
  if (!payload) return null;
  const session = ctx.accounts.active(payload.sid);
  if (!session || session.user_id !== payload.sub) return null;
  const user = ctx.users.findById(payload.sub);
  if (!user) return null;
  // token_version bump (password change / force logout) kills every old token
  if (Number(user.token_version) !== Number(payload.v) || Number(session.token_version) !== Number(payload.v))
    return null;
  if (user.blocked_at !== null && user.blocked_at !== undefined) return null;
  ctx.accounts.touch(payload.sid);
  const role = isStaffRole(user.staff_role) ? user.staff_role : null;
  return { userId: user.id, sessionId: payload.sid, role, permissions: permissionsFor(role) };
}

export function sessionMiddleware(ctx: AppContext): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as AuthedRequest).auth = resolveAuth(ctx, req) ?? undefined;
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!(req as AuthedRequest).auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
  next();
};

export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const auth = (req as AuthedRequest).auth;
    if (!auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
    if (!auth.role) throw AppError.forbidden('Akses khusus staf');
    for (const permission of permissions) {
      if (!can(auth.role, permission)) {
        throw AppError.forbidden(`Role ${auth.role} tidak punya izin ${permission}`);
      }
    }
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Auth entrypoints authenticate with credentials, not ambient cookies. */
const CSRF_EXEMPT = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/dev/link',
  // these endpoints are guaranteed no-ops (501) and never touch money or state
  '/api/v1/payments/deposit',
  '/api/v1/payments/withdraw',
]);

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Double-submit CSRF for every mutation, validated against the session-derived token. */
export function csrfGuard(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const fullPath = (req.originalUrl ?? req.path).split('?')[0];
    if (CSRF_EXEMPT.has(fullPath) || CSRF_EXEMPT.has(req.path)) return next();
    const header = req.header(ctx.config.CSRF_HEADER) ?? '';
    const auth = (req as AuthedRequest).auth;
    const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[ctx.config.CSRF_COOKIE] ?? '';
    const expected = auth ? csrfTokenFor(ctx, auth.sessionId) : cookie;
    if (!header || !expected || !sameSecret(header, expected)) {
      throw new AppError('CSRF_FAILED', 403, 'Token CSRF tidak valid. Muat ulang halaman.');
    }
    next();
  };
}

/** Origin check for browser mutations. Non-browser clients send no Origin. */
export function assertSameOrigin(ctx: AppContext, req: Request): void {
  const origin = req.header('origin');
  if (!origin) return;
  const host = req.header('host');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError('FORBIDDEN', 403, 'Origin tidak valid');
  }
  const allowed = ctx.config.CORS_ORIGINS ?? [];
  if (originHost !== host && !allowed.includes(origin)) {
    throw new AppError('FORBIDDEN', 403, 'Origin tidak diizinkan');
  }
}
