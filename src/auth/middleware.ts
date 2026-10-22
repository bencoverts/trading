import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TokenService } from './tokens.js';
import type { UserService } from '../services/users.js';
import { AppError } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; role: 'user' | 'admin' };
    }
  }
}

/**
 * Session cookie or Bearer token. The cookie is httpOnly + SameSite=Lax so the
 * browser never exposes the token to scripts; Bearer is kept for API clients.
 */
export function createAuthMiddleware(tokens: TokenService, users: UserService) {
  const tokenFrom = (req: Request): string | null => {
    const header = req.header('authorization');
    if (header) {
      const [scheme, token] = header.split(' ');
      if (token && scheme.toLowerCase() === 'bearer') return token.trim();
    }
    const cookieName = users.cookieName;
    const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[cookieName];
    return cookie ?? null;
  };

  const loadUser = (req: Request) => {
    const token = tokenFrom(req);
    if (!token) return null;
    const payload = tokens.verify(token);
    if (!payload) return null;
    const user = users.findById(payload.sub);
    if (!user || user.token_version !== payload.v) return null;
    if (user.blocked_at) throw new AppError('ACCOUNT_BLOCKED', 403, 'This account is blocked');
    return user;
  };

  const requireAuth: RequestHandler = (req, _res, next) => {
    try {
      const user = loadUser(req);
      if (!user) return next(AppError.unauthorized('Missing or invalid session'));
      req.auth = { userId: user.id, role: user.role };
      next();
    } catch (err) {
      next(err);
    }
  };

  const optionalAuth: RequestHandler = (req, _res, next) => {
    try {
      const user = loadUser(req);
      if (user) req.auth = { userId: user.id, role: user.role };
      next();
    } catch {
      /* blocked accounts simply stay anonymous on public endpoints */
    }
    next();
  };

  const requireAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (req.auth?.role !== 'admin') return next(AppError.forbidden('Admin role required'));
      next();
    });
  };

  return { requireAuth, requireAdmin, optionalAuth };
}
