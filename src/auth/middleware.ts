import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TokenService } from './tokens.js';
import type { UserService, UserRow } from '../services/users.js';
import type { AccountService } from './accounts.js';
import { can, isStaffRole, permissionsFor, type Permission, type StaffRole } from './permissions.js';
import { AppError } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        role: StaffRole | null;
        sessionId: string;
        permissions: Permission[];
      };
      user?: UserRow;
    }
  }
}

export interface AuthMiddlewareDeps {
  tokens: TokenService;
  users: UserService;
  accounts: AccountService;
  csrfCookie: string;
  csrfHeader: string;
  csrfSecret: string;
  cookieName: string;
  /** true when the request authenticated through a Bearer token (CSRF then not required) */
  isSafe(method: string): boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signedCookieToken(req: Request, deps: AuthMiddlewareDeps): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
  const fromCookie = cookies[deps.cookieName];
  if (fromCookie) return fromCookie;
  const header = req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * Resolves the session on every request. The session row is the source of
 * truth: revoked rows and token-version bumps invalidate the cookie instantly.
 */
function attachAuth(deps: AuthMiddlewareDeps, req: Request): void {
  const token = signedCookieToken(req, deps);
  if (!token) return;
  const payload = deps.tokens.verify(token);
  if (!payload) return;
  const row = deps.accounts.active(payload.sid);
  if (!row || row.user_id !== payload.sub) return;
  if (row.token_version !== payload.v) return;
  const user = deps.users.findById(payload.sub);
  if (!user) return;
  if (user.token_version !== payload.v) return;
  if (user.blocked_at !== null && user.blocked_at !== undefined) return;
  req.user = user;
  req.auth = {
    userId: user.id,
    role: isStaffRole(user.staff_role) ? user.staff_role : null,
    sessionId: row.id,
    permissions: permissionsFor(isStaffRole(user.staff_role) ? user.staff_role : null),
  };
  deps.accounts.touch(row.id);
}

/** Double-submit CSRF: the header must match the session-derived token. */
function checkCsrf(deps: AuthMiddlewareDeps, req: Request): void {
  if (deps.isSafe(req.method)) return;
  if (!req.auth) return; // anonymous mutations are protected by credential checks
  const expected = deps.accounts.csrfFor(req.auth.sessionId, `${deps.csrfSecret}:csrf:v1`);
  const provided = req.header(deps.csrfHeader) ?? '';
  if (!provided || !safeEqual(provided, expected)) {
    throw new AppError('CSRF_FAILED', 403, 'Token CSRF tidak valid. Muat ulang halaman.');
  }
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const guard = (req: Request, _res: Response, next: NextFunction) => {
    attachAuth(deps, req);
    try {
      checkCsrf(deps, req);
    } catch (err) {
      next(err);
      return;
    }
    next();
  };

  const requireAuth: RequestHandler = (req, _res, next) => {
    if (!req.auth) {
      next(AppError.unauthorized('Silakan masuk terlebih dahulu'));
      return;
    }
    next();
  };

  const optionalAuth: RequestHandler = (_req, _res, next) => next();

  const requireStaff =
    (...allowed: Permission[]): RequestHandler =>
    (req, _res, next) => {
      if (!req.auth) {
        next(AppError.unauthorized('Silakan masuk terlebih dahulu'));
        return;
      }
      if (!req.auth.role) {
        next(AppError.forbidden('Halaman ini hanya untuk staf'));
        return;
      }
      const missing = allowed.filter((permission) => !can(req.auth?.role, permission));
      if (missing.length) {
        next(AppError.forbidden(`Role ${req.auth.role} tidak punya izin: ${missing.join(', ')}`));
        return;
      }
      next();
    };

  return { guard, requireAuth, optionalAuth, requireStaff };
}

export const SAFE_METHODS_LIST = [...SAFE_METHODS];
