import fs from 'node:fs';
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
import { can, permissionsFor, type Permission } from '../auth/permissions.js';
import { marketRoutes } from '../routes/market.js';
import { authRoutes } from '../routes/auth.js';
import { accountRoutes } from '../routes/account.js';
import { tradeRoutes } from '../routes/trades.js';
import { adminRoutes } from '../routes/admin.js';
import { paymentRoutes } from '../routes/payments.js';
import { contentRoutes } from '../routes/content.js';
import { financeRoutes } from '../routes/finance.js';
import { chatRoutes } from '../routes/chat.js';
import { webhookRoutes } from '../routes/webhooks.js';
import { adminV4Routes } from '../routes/adminV4.js';
import { csrfGuard, ensureCsrfCookie, requireAuth, sessionMiddleware, type AuthedRequest } from './session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', '..', 'public');

/**
 * HTTP application: security headers, strict CORS, cookie sessions + CSRF,
 * versioned API, static SPA shell and a single JSON error handler.
 */
export function createApp(ctx: AppContext): express.Express {
  const { config, logger } = ctx;
  fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });

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
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
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

  const hostOf = (value: string): string | null => {
    try {
      return new URL(value).host;
    } catch {
      return null;
    }
  };
  const allowedOrigins = new Set(config.CORS_ORIGINS.map(hostOf).filter((h): h is string => Boolean(h)));

  /**
   * Same-origin requests (including proxied preview domains) are allowed; extra
   * origins must be listed explicitly in CORS_ORIGINS. Everything else receives
   * no CORS headers at all.
   */
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
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', config.CSRF_HEADER],
      exposedHeaders: ['Idempotency-Key', 'Idempotent-Replayed'],
      maxAge: 600,
    })(req, res, next);
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || Boolean(req.url?.startsWith('/assets')),
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
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

  app.use(sessionMiddleware(ctx));

  const requireStaff =
    (...needed: Permission[]): express.RequestHandler =>
    (req, _res, next) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) return next(AppError.unauthorized('Silakan masuk terlebih dahulu'));
      if (!auth.role) return next(AppError.forbidden('Akses khusus staf'));
      for (const permission of needed) {
        if (!can(auth.role, permission)) {
          return next(AppError.forbidden(`Role ${auth.role} tidak punya izin ${permission}`));
        }
      }
      return next();
    };

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
      label: 'SIMULASI',
      serverTime: ctx.clock.now(),
      uptimeSec: Math.round(process.uptime()),
      db: dbOk ? 'ok' : 'error',
      dbDriver: ctx.db.driver,
      markets,
      realtime: { connections: ctx.realtime?.connectionCount ?? 0 },
      jobs: ctx.jobs.status().map((job) => ({ name: job.name, status: job.lastStatus, stale: job.stale })),
      version: config.APP_VERSION,
    });
  });

  // --------------------------------------------------------------- API v1
  const api = express.Router();
  api.use(csrfGuard(ctx));

  // every safe request hands the SPA a fresh double-submit CSRF cookie
  api.use((req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) ensureCsrfCookie(ctx, req, res);
    next();
  });

  const limiter = (windowMs: number, limit: number, message: string, keyGenerator?: (req: Request) => string) =>
    rateLimit({
      windowMs,
      limit: config.isTest ? limit * 100 : limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      passOnStoreError: true,
      keyGenerator,
      handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
    });

  const globalLimiter = limiter(config.RATE_GLOBAL_WINDOW_MS, config.RATE_GLOBAL_MAX, 'Too many requests');
  const authLimiter = limiter(
    config.RATE_AUTH_WINDOW_MS,
    ctx.settings.get().loginRateLimitPerMin,
    'Terlalu banyak percobaan. Coba lagi nanti.',
  );
  const tradeLimiter = limiter(
    config.RATE_TRADE_WINDOW_MS,
    ctx.settings.get().tradeRateLimitPerMin,
    'Terlalu banyak permintaan trade',
    (req) => (req as AuthedRequest).auth?.userId ?? ipKeyGenerator(req.ip ?? ''),
  );

  api.use(globalLimiter);

  // Maintenance gate: staff can keep working, the public (and /auth so a user
  // can still sign out) gets a clear 503 with the configured message.
  api.use((req, _res, next) => {
    const maintenance = ctx.site.get().maintenance;
    if (!maintenance.enabled) return next();
    if (req.path.startsWith('/auth') || req.path === '/site' || req.path === '/config') return next();
    const auth = (req as AuthedRequest).auth;
    if (auth?.role && maintenance.allowStaff !== false) return next();
    return next(
      new AppError('MAINTENANCE_MODE', 503, maintenance.message || 'Platform sedang dalam perawatan. Coba lagi nanti.'),
    );
  });

  api.use(marketRoutes(ctx));
  api.use(contentRoutes(ctx));
  api.use('/auth', authLimiter, authRoutes(ctx));
  const optionalAuth: express.RequestHandler = (_req, _res, next) => next();
  api.use(accountRoutes(ctx, requireAuth as never, optionalAuth));
  api.use(tradeRoutes(ctx, requireAuth as never, tradeLimiter));
  // v4 admin routes first: they supersede the v3 payments placeholder
  api.use('/admin', requireStaff(), adminV4Routes(ctx, requireStaff, requireStaff()));
  api.use('/admin', requireStaff(), adminRoutes(ctx, requireStaff));
  api.use(financeRoutes(ctx, requireAuth as never));
  api.use('/chat', chatRoutes(ctx, requireAuth));
  api.use(paymentRoutes(ctx));
  api.use((_req, _res, next) => next(AppError.notFound('Unknown API endpoint')));

  app.use('/api/v1', api);

  // Provider callbacks: no session, no CSRF cookie, signature-verified.
  app.use(
    '/api',
    rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }),
    webhookRoutes(ctx),
  );

  // ------------------------------------------------------------- static UI
  const staticOptions = {
    index: 'index.html',
    setHeaders: (res: Response, filePath: string) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      if (filePath.endsWith('.js') || filePath.endsWith('.css')) res.setHeader('Cache-Control', 'public, max-age=300');
    },
  };

  app.use(express.static(publicDir, staticOptions));

  // uploaded images live outside the source tree and are served read-only
  app.use(
    '/uploads',
    express.static(config.UPLOADS_DIR, {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      },
    }),
  );

  // SPA shell: any extension-less GET is handled by the client router
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
    if (path.extname(req.path)) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // --------------------------------------------------------------- errors
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, url: req.url }, 'request failed');
      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
      return;
    }
    const e = err as { type?: string; status?: number; code?: string };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
      return;
    }
    if (e?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: { code: 'UPLOAD_INVALID', message: 'Ukuran file terlalu besar' } });
      return;
    }
    logger.error({ err, url: req.url }, 'unhandled request error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  void permissionsFor;
  return app;
}
