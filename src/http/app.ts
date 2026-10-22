import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { AppContext } from '../app/context.js';
import { AppError } from '../lib/errors.js';
import { createAuthMiddleware } from '../auth/middleware.js';
import { authRoutes } from '../routes/auth.js';
import { accountRoutes } from '../routes/account.js';
import { tradeRoutes } from '../routes/trades.js';
import { marketRoutes } from '../routes/market.js';
import { adminRoutes } from '../routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', '..', 'public');

export function createApp(ctx: AppContext): express.Express {
  const { config, logger } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false);

  // --- security headers ----------------------------------------------------
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
          // allow embedding in the workspace preview iframe / any product shell
          frameAncestors: null,
          // only force https upgrade in production; it would break ws:// in local dev
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      // the demo UI may be embedded in the workspace preview iframe
      frameguard: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  // --- CORS: explicit allowlist + same-host (reverse proxy / preview) ------
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // non-browser clients
        if (config.CORS_ORIGINS.includes('*') || config.CORS_ORIGINS.includes(origin)) return callback(null, true);
        try {
          const host = new URL(origin).host;
          const allowed = config.CORS_ORIGINS.some((o) => {
            try {
              return new URL(o).host === host;
            } catch {
              return false;
            }
          });
          if (allowed) return callback(null, true);
        } catch {
          /* fall through */
        }
        return callback(null, false);
      },
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposedHeaders: ['Idempotency-Key', 'Idempotent-Replayed'],
      maxAge: 600,
    }),
  );

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url?.startsWith('/assets') === true },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // --- health (outside the rate limit so probes always work) ---------------
  app.get('/healthz', async (_req, res) => {
    const startedAt = process.uptime();
    let dbOk = true;
    try {
      await ctx.db.get('SELECT 1 AS ok');
    } catch {
      dbOk = false;
    }
    const last = ctx.engine.getLastTick();
    const body = {
      status: dbOk ? 'ok' : 'degraded',
      serverTime: ctx.clock.now(),
      uptimeSec: Math.round(startedAt),
      db: dbOk ? 'ok' : 'error',
      engine: {
        symbol: ctx.engine.symbol,
        lastSeq: ctx.engine.lastSeq,
        lastPrice: ctx.engine.getLastPrice(),
        lastTickAgeMs: last ? ctx.clock.now() - last.time : null,
        source: ctx.engine.describeSource(),
      },
      realtime: { connections: ctx.realtime?.connectionCount ?? 0 },
      version: process.env.npm_package_version ?? '1.0.0',
    };
    res.status(dbOk ? 200 : 503).json(body);
  });

  // --- api ----------------------------------------------------------------
  app.use('/api', express.json({ limit: '32kb' }));

  const globalLimiter = rateLimit({
    windowMs: config.RATE_GLOBAL_WINDOW_MS,
    limit: config.RATE_GLOBAL_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } }),
  });

  const authLimiter = rateLimit({
    windowMs: config.RATE_AUTH_WINDOW_MS,
    limit: config.RATE_AUTH_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts' } }),
  });

  const tradeLimiter = rateLimit({
    windowMs: config.RATE_TRADE_WINDOW_MS,
    limit: config.RATE_TRADE_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.auth?.userId ?? ipKeyGenerator(req.ip ?? ''),
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many trade requests, slow down' } }),
  });

  const { requireAuth, requireAdmin } = createAuthMiddleware(ctx.tokens);

  app.use('/api/auth', authLimiter, authRoutes(ctx));
  app.use('/api', globalLimiter, marketRoutes(ctx));
  app.use('/api', globalLimiter, accountRoutes(ctx, requireAuth));
  app.use('/api', globalLimiter, tradeRoutes(ctx, requireAuth, tradeLimiter));
  app.use('/api/admin', globalLimiter, adminRoutes(ctx, requireAdmin));

  app.use('/api', (_req, _res, next) => next(AppError.notFound('Unknown API endpoint')));

  // --- static demo client --------------------------------------------------
  app.use(
    express.static(publicDir, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // --- errors --------------------------------------------------------------
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, url: req.url }, 'request failed');
      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
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
