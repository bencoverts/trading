import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { AppContext } from '../app/context.js';
import { AppError } from '../lib/errors.js';
import { createAuthMiddleware } from '../auth/middleware.js';
import { marketRoutes } from '../routes/market.js';
import { authRoutes } from '../routes/auth.js';
import { accountRoutes } from '../routes/account.js';
import { tradeRoutes } from '../routes/trades.js';
import { adminRoutes } from '../routes/admin.js';
import { paymentRoutes } from '../routes/payments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', '..', 'public');

export function createApp(ctx: AppContext): express.Express {
  const { config, logger } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: null,
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      frameguard: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  /**
   * Strict CORS: an origin is allowed when it is listed in CORS_ORIGINS or when
   * its host equals the request host (same-origin behind a reverse proxy or a
   * preview domain). Anything else gets no CORS headers at all - the origin is
   * never reflected blindly.
   */
  const hostOf = (value: string): string | null => {
    try {
      return new URL(value).host;
    } catch {
      return null;
    }
  };
  const allowedOrigins = new Set(config.CORS_ORIGINS.map(hostOf).filter((h): h is string => Boolean(h)));

  app.use((req, res, next) => {
    const requestOrigin = req.header('origin');
    const allow = (origin: string) => {
      const host = hostOf(origin);
      return (
        config.CORS_ORIGINS.includes('*') ||
        config.CORS_ORIGINS.includes(origin) ||
        (host !== null && (allowedOrigins.has(host) || host === req.headers.host))
      );
    };
    cors({
      origin: (_origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!requestOrigin) return callback(null, true);
        return callback(null, allow(requestOrigin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposedHeaders: ['Idempotency-Key', 'Idempotent-Replayed'],
      maxAge: 600,
    })(req, res, next);
  });

  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/healthz' || Boolean(req.url?.startsWith('/assets')) },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req: { method?: string; url?: string; remoteAddress?: string }) => ({
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  const { requireAuth, requireAdmin } = createAuthMiddleware(ctx.tokens, ctx.users);

  app.get('/healthz', (_req, res) => {
    let dbOk = true;
    try {
      ctx.db.get('SELECT 1 AS ok');
    } catch {
      dbOk = false;
    }
    const markets = ctx.engine.listConfigs().map((m) => ({
      symbol: m.symbol,
      lastPrice: ctx.engine.lastPrice(m.symbol),
      lastSeq: ctx.engine.lastSeq(m.symbol),
      paused: m.paused,
    }));
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      simulation: true,
      serverTime: ctx.clock.now(),
      uptimeSec: Math.round(process.uptime()),
      db: dbOk ? 'ok' : 'error',
      dbDriver: ctx.db.driver,
      markets,
      realtime: { connections: ctx.realtime?.connectionCount ?? 0 },
      version: process.env.npm_package_version ?? '2.0.0',
    });
  });

  // --------------------------------------------------------------- API v1
  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));

  const limiter = (
    windowMs: number,
    limit: number,
    message: string,
    keyGenerator?: (req: Request) => string,
  ) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      passOnStoreError: true,
      keyGenerator,
      handler: (_req, res) =>
        res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
    });

  const globalLimiter = limiter(config.RATE_GLOBAL_WINDOW_MS, config.RATE_GLOBAL_MAX, 'Too many requests');
  const authLimiter = limiter(config.RATE_AUTH_WINDOW_MS, config.RATE_AUTH_MAX, 'Too many authentication attempts');
  const tradeLimiter = limiter(
    config.RATE_TRADE_WINDOW_MS,
    config.RATE_TRADE_MAX,
    'Too many trade requests',
    (req) => req.auth?.userId ?? ipKeyGenerator(req.ip ?? ''),
  );

  api.use(globalLimiter);
  api.use(marketRoutes(ctx));
  api.use('/auth', authLimiter, authRoutes(ctx, requireAuth));
  api.use(accountRoutes(ctx, requireAuth));
  api.use(tradeRoutes(ctx, requireAuth, tradeLimiter));
  api.use('/admin', requireAdmin, adminRoutes(ctx, requireAdmin));
  api.use(paymentRoutes(ctx));

  api.use((_req, _res, next) => next(AppError.notFound('Unknown API endpoint')));

  app.use('/api/v1', api);

  // ------------------------------------------------------------- static UI
  app.use(
    express.static(publicDir, {
      index: 'index.html',
      extensions: ['html'],
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // SPA routes
  const appShell = (_req: Request, res: Response) => res.sendFile(path.join(publicDir, 'index.html'));
  for (const route of ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/trading', '/account', '/admin']) {
    app.get(route, appShell);
  }

  // --------------------------------------------------------------- errors
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, url: req.url }, 'request failed');
      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
      return;
    }
    logger.error({ err, url: req.url }, 'unhandled request error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  return app;
}
