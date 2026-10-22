import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import type { TokenService } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; role: 'user' | 'admin' };
    }
  }
}

export function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

export function createAuthMiddleware(tokens: TokenService) {
  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    const payload = token ? tokens.verify(token) : null;
    if (!payload) return next(AppError.unauthorized('Missing or invalid access token'));
    req.auth = { userId: payload.sub, role: payload.role };
    next();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (req.auth?.role !== 'admin') return next(AppError.forbidden('Admin role required'));
      next();
    });
  };

  return { requireAuth, requireAdmin };
}
