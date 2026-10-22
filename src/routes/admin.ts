import fs from 'node:fs';
import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import { logBuffer } from '../lib/logBuffer.js';
import {
  CURRENCY_LIST,
  LANGUAGES,
  MARKET_CATEGORIES,
  MOODS,
  SIMULATION_LABEL,
  TRENDS,
  VOLATILITY_PRESET_LIST,
  type Currency,
  type MarketCategory,
} from '../domain/constants.js';
import { toMajor, toMinor } from '../domain/money.js';
import { toPublicUser } from '../services/users.js';
import { toTradeView, type TradeRow } from '../services/trades.js';
import { PERMISSION_MATRIX, STAFF_ROLES, type Permission } from '../auth/permissions.js';
import { CONTENT_SLUGS } from '../services/content.js';
import { createBackupService, registerJobs, backupFilesOnDisk } from '../jobs/index.js';
import { createLogger } from '../lib/logger.js';
import { DEFAULT_SETTINGS, type RuntimeSettings } from '../services/settings.js';

const currencyEnum = z.enum(CURRENCY_LIST as [Currency, ...Currency[]]);

const hoursSchema = z
  .object({
    mode: z.enum(['24_7', 'schedule']),
    timezone: z.string().min(3).max(64).optional(),
    days: z
      .array(
        z.object({
          day: z.number().int().min(0).max(6),
          from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        }),
      )
      .max(28)
      .optional(),
  })
  .strict();

const marketSchema = z
  .object({
    symbol: z
      .string()
      .min(2)
      .max(20)
      .regex(/^[A-Z0-9_]+$/),
    name: z.string().min(2).max(60),
    description: z.string().max(500).nullish(),
    category: z.enum(MARKET_CATEGORIES as unknown as [MarketCategory, ...MarketCategory[]]),
    priceDecimals: z.number().int().min(0).max(8),
    startPrice: z.number().positive().max(1_000_000),
    tickSize: z.number().positive().max(1_000),
    tickIntervalMs: z.number().int().min(100).max(10_000).optional(),
    volatilityPreset: z.enum(VOLATILITY_PRESET_LIST as [string, ...string[]]),
    mood: z.enum(MOODS as unknown as [string, ...string[]]),
    trend: z.enum(TRENDS as unknown as [string, ...string[]]).optional(),
    trendStrength: z.number().int().min(1).max(10).optional(),
    tradingHours: hoursSchema.optional(),
    minAmountUsd: z.number().positive().nullish(),
    maxAmountUsd: z.number().positive().nullish(),
    payoutRate: z.number().min(0).max(5).nullish(),
    exposureLimitUsd: z.number().positive().nullish(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    featured: z.boolean().optional(),
    logoPath: z.string().max(200).nullish(),
    activate: z.boolean().optional(),
  })
  .strict();

const marketPatchSchema = marketSchema.partial().extend({
  active: z.boolean().optional(),
  paused: z.boolean().optional(),
  pauseReason: z.string().max(200).nullish(),
  draft: z.boolean().optional(),
});

const settingsSchema = z
  .object({
    payoutRate: z.number().min(0).max(3).optional(),
    payoutMode: z.enum(['profit', 'total']).optional(),
    payoutByDuration: z.record(z.string().regex(/^\d+$/), z.number().min(0).max(3)).optional(),
    allowedDurations: z.array(z.number().int().min(5).max(28_800)).min(1).max(30).optional(),
    maxOpenTrades: z.number().int().min(1).max(200).optional(),
    maxOpenTradesPerUser: z.number().int().min(1).max(100).optional(),
    minAmount: z.record(currencyEnum, z.number().positive()).optional(),
    maxAmount: z.record(currencyEnum, z.number().positive()).optional(),
    initialBalance: z.record(currencyEnum, z.number().min(0)).optional(),
    topupMax: z.record(currencyEnum, z.number().positive()).optional(),
    topupDailyCount: z.number().int().min(1).max(100).optional(),
    topupCooldownSec: z.number().int().min(0).max(86_400).optional(),
    resetCooldownSec: z.number().int().min(0).max(86_400).optional(),
    rates: z.record(currencyEnum, z.number().positive()).optional(),
    globalMaxAmountUsd: z.number().positive().optional(),
    tradeRateLimitPerMin: z.number().int().min(1).max(600).optional(),
    loginRateLimitPerMin: z.number().int().min(1).max(600).optional(),
    tickRetentionDays: z.number().int().min(1).max(90).optional(),
    candleRetentionDays: z.number().int().min(1).max(365).optional(),
    platformName: z.string().min(2).max(60).optional(),
    themeAccent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    disclaimer: z.string().min(10).max(1000).optional(),
    platformTerms: z.string().min(10).max(5000).optional(),
    defaultLanguage: z.enum(LANGUAGES as unknown as [string, ...string[]]).optional(),
    defaultTimezone: z.string().min(3).max(64).optional(),
  })
  .strict();

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const diskFreeMb = (dir: string): number | null => {
  try {
    const stats = fs.statfsSync(dir);
    return Math.round((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
};

/**
 * Admin API. Every route is protected by a permission check on the server;
 * the UI only mirrors those checks. Simulation parameters are the only thing
 * admins can tune - trade outcomes are always computed from recorded prices.
 */
export function adminRoutes(ctx: AppContext, requireStaff: (...allowed: Permission[]) => RequestHandler): Router {
  const router = Router();
  const guard = (...needed: Permission[]) => requireStaff(...needed);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ctx.config.MAX_UPLOAD_BYTES } });

  const minorMap = (input?: Partial<Record<Currency, number>>) => {
    if (!input) return undefined;
    const out: Partial<Record<Currency, number>> = {};
    for (const [currency, value] of Object.entries(input)) {
      if (value !== undefined) out[currency as Currency] = toMinor(value, currency as Currency);
    }
    return out;
  };

  const majorMap = (input: Record<Currency, number>) =>
    Object.fromEntries(CURRENCY_LIST.map((code) => [code, toMajor(input[code], code)]));

  // ------------------------------------------------------------- dashboard
  router.get(
    '/dashboard',
    guard('dashboard.read'),
    asyncHandler((_req, res) => {
      const jobs = ctx.jobs.status();
      const stats = ctx.stats.dashboard({
        wsConnections: ctx.realtime?.connectionCount ?? 0,
        wsDropped: ctx.realtime?.recentDrops ?? 0,
        jobsStale: jobs.filter((job) => job.stale).map((job) => job.name),
        diskFreeMb: diskFreeMb(ctx.config.DATA_DIR),
      });
      res.json({ ...stats, simulation: true, label: SIMULATION_LABEL, serverTime: ctx.clock.now() });
    }),
  );

  router.get(
    '/permissions',
    guard('dashboard.read'),
    asyncHandler((_req, res) => {
      res.json({ matrix: PERMISSION_MATRIX, roles: STAFF_ROLES, simulation: true });
    }),
  );

  // -------------------------------------------------------------- markets
  router.get(
    '/markets',
    guard('markets.read'),
    asyncHandler((_req, res) => {
      res.json({
        markets: ctx.markets.adminViews(),
        categories: MARKET_CATEGORIES,
        moods: MOODS,
        trends: TRENDS,
        volatilityPresets: VOLATILITY_PRESET_LIST,
        simulation: true,
      });
    }),
  );

  router.get(
    '/markets/:symbol',
    guard('markets.read'),
    asyncHandler((req, res) => {
      const row = ctx.markets.row(String(req.params.symbol).toUpperCase(), { includeDeleted: true });
      if (!row) throw AppError.notFound('Market tidak ditemukan', 'MARKET_NOT_FOUND');
      const view = ctx.markets.adminViews().find((m) => m.symbol === row.symbol);
      const candles = ctx.marketData.candles(row.symbol, '1m', { limit: 120, includeCurrent: true });
      res.json({
        market: view,
        row: { ...row, trading_hours: JSON.parse(row.trading_hours) },
        history: ctx.markets.historyList(row.symbol, 100),
        candles: candles.candles,
        current: candles.current,
        simulation: true,
      });
    }),
  );

  /** Chart preview for a not-yet-created market (start price + volatility + mood). */
  router.post(
    '/markets/preview',
    guard('markets.write'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          startPrice: z.number().positive(),
          priceDecimals: z.number().int().min(0).max(8),
          volatilityPreset: z.enum(VOLATILITY_PRESET_LIST as [string, ...string[]]),
          mood: z.enum(MOODS as unknown as [string, ...string[]]),
        }),
        req.body,
      );
      res.json({ candles: ctx.markets.previewSeries(body as never), simulation: true });
    }),
  );

  router.get(
    '/markets/suggestions/:category',
    guard('markets.write'),
    asyncHandler((req, res) => {
      const category = parseInput(
        z.enum(MARKET_CATEGORIES as unknown as [MarketCategory, ...MarketCategory[]]),
        req.params.category,
      );
      const adjectives = ['Aurora', 'Nusantara', 'Kompas', 'Sentosa', 'Bima', 'Cakra', 'Meridian', 'Selat'];
      const nouns: Record<MarketCategory, string[]> = {
        index: ['Indeks', 'Komposit', 'Bursa'],
        crypto: ['Kripto', 'Token', 'Rantai'],
        forex: ['Valas', 'Dolar', 'Rupiah'],
        komoditas: ['Komoditas', 'Logam', 'Energi'],
        lainnya: ['Sintetis', 'Global', 'Campuran'],
      };
      const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
      const noun = nouns[category][Math.floor(Math.random() * nouns[category].length)];
      const priceBands: Record<MarketCategory, [number, number, number]> = {
        index: [1000, 8000, 2],
        crypto: [0.5, 500, 4],
        forex: [0.8, 2.5, 4],
        komoditas: [50, 900, 2],
        lainnya: [10, 1000, 2],
      };
      const [min, max, decimals] = priceBands[category];
      const price = Number((min + Math.random() * (max - min)).toFixed(decimals));
      res.json({ name: `${adjective} ${noun}`, price, priceDecimals: decimals, simulation: true });
    }),
  );

  router.post(
    '/markets',
    guard('markets.write'),
    asyncHandler((req, res) => {
      const body = parseInput(marketSchema, req.body);
      const row = ctx.markets.create(
        {
          ...body,
          activate: body.activate ?? true,
        } as never,
        { actorUserId: req.auth!.userId, ip: clientIp(req) },
      );
      res.status(201).json({
        market: ctx.markets.adminViews().find((m) => m.symbol === row.symbol),
        history: ctx.markets.historyList(row.symbol, 20),
        simulation: true,
      });
    }),
  );

  router.patch(
    '/markets/:symbol',
    guard('markets.write'),
    asyncHandler((req, res) => {
      const body = parseInput(marketPatchSchema, req.body);
      const row = ctx.markets.update(String(req.params.symbol).toUpperCase(), body as never, {
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      res.json({
        market: ctx.markets.adminViews().find((m) => m.symbol === row.symbol),
        history: ctx.markets.historyList(row.symbol, 20),
        simulation: true,
      });
    }),
  );

  router.post(
    '/markets/:symbol/simulate',
    guard('markets.simulate'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          trend: z.enum(TRENDS as unknown as [string, ...string[]]).optional(),
          trendStrength: z.number().int().min(1).max(10).optional(),
          volatilityPreset: z.enum(VOLATILITY_PRESET_LIST as [string, ...string[]]).optional(),
          mood: z.enum(MOODS as unknown as [string, ...string[]]).optional(),
          paused: z.boolean().optional(),
          pauseReason: z.string().max(200).nullish(),
        }),
        req.body,
      );
      const row = ctx.markets.simulate(String(req.params.symbol).toUpperCase(), body as never, {
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      ctx.realtime?.broadcastMarketStatus(row.symbol);
      res.json({
        market: ctx.markets.adminViews().find((m) => m.symbol === row.symbol),
        engine: ctx.engine.describe(row.symbol),
        trend: row.trend,
        volatility: row.volatility,
        mood: row.mood,
        paused: row.paused === 1,
        history: ctx.markets.historyList(row.symbol, 20),
        simulation: true,
      });
    }),
  );

  router.post(
    '/markets/:symbol/reset',
    guard('markets.simulate'),
    asyncHandler((req, res) => {
      const row = ctx.markets.resetSimulation(String(req.params.symbol).toUpperCase(), {
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      ctx.realtime?.broadcastMarketStatus(row.symbol);
      res.json({
        market: ctx.markets.adminViews().find((m) => m.symbol === row.symbol),
        history: ctx.markets.historyList(row.symbol, 20),
        simulation: true,
      });
    }),
  );

  router.delete(
    '/markets/:symbol',
    guard('markets.write'),
    asyncHandler((req, res) => {
      ctx.markets.softDelete(String(req.params.symbol).toUpperCase(), {
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      res.json({ ok: true, simulation: true });
    }),
  );

  router.post(
    '/markets/:symbol/restore',
    guard('markets.write'),
    asyncHandler((req, res) => {
      const row = ctx.markets.restore(String(req.params.symbol).toUpperCase(), {
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      res.json({ market: ctx.markets.adminViews().find((m) => m.symbol === row.symbol), simulation: true });
    }),
  );

  router.get(
    '/markets/:symbol/history',
    guard('markets.read'),
    asyncHandler((req, res) => {
      const q = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
      res.json({
        market: String(req.params.symbol).toUpperCase(),
        entries: ctx.markets.historyList(String(req.params.symbol), q.limit),
        simulation: true,
      });
    }),
  );

  /** Upload for market logos / platform branding (magic-byte validated). */
  router.post(
    '/uploads/image',
    guard('markets.write'),
    upload.single('file'),
    asyncHandler((req, res) => {
      if (!req.file) throw new AppError('UPLOAD_INVALID', 400, 'File wajib diunggah pada field "file"');
      const folder = parseInput(z.enum(['markets', 'branding', 'admin']), req.query.folder ?? 'markets');
      const stored = ctx.uploads.store(req.file.buffer, { folder });
      res.status(201).json({ ...stored, simulation: true });
    }),
  );

  // --------------------------------------------------------------- trades
  const tradeFilters = z.object({
    status: z.enum(['all', 'open', 'closed']).default('all'),
    market: z.string().max(20).optional(),
    result: z.enum(['win', 'lose', 'draw']).optional(),
    userId: z.string().max(64).optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  const tradeWhere = (q: z.infer<typeof tradeFilters>) => {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (q.status !== 'all') {
      clauses.push('t.status = ?');
      params.push(q.status);
    }
    if (q.market) {
      clauses.push('t.market = ?');
      params.push(q.market.toUpperCase());
    }
    if (q.result) {
      clauses.push('t.result = ?');
      params.push(q.result);
    }
    if (q.userId) {
      clauses.push('t.user_id = ?');
      params.push(q.userId);
    }
    if (q.from !== undefined) {
      clauses.push('t.created_at >= ?');
      params.push(q.from);
    }
    if (q.to !== undefined) {
      clauses.push('t.created_at <= ?');
      params.push(q.to);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  };

  router.get(
    '/trades',
    guard('trades.read'),
    asyncHandler((req, res) => {
      const q = parseInput(tradeFilters, req.query);
      const { where, params } = tradeWhere(q);
      const rows = ctx.db.all<TradeRow & { email: string; username: string }>(
        `SELECT t.*, u.email, u.username FROM trades t JOIN users u ON u.id = t.user_id
         ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
        ...params,
        q.limit,
        q.offset,
      );
      const count = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM trades t ${where}`, ...params);
      res.json({
        trades: rows.map((row) => ({ ...toTradeView(row), email: row.email, username: row.username })),
        total: Number(count?.n ?? 0),
        simulation: true,
      });
    }),
  );

  router.get(
    '/trades/export.csv',
    guard('trades.export'),
    asyncHandler((req, res) => {
      const q = parseInput(tradeFilters, req.query);
      const { where, params } = tradeWhere(q);
      const rows = ctx.db.all<TradeRow & { email: string }>(
        `SELECT t.*, u.email FROM trades t JOIN users u ON u.id = t.user_id ${where} ORDER BY t.created_at DESC LIMIT 5000`,
        ...params,
      );
      const header = [
        'id',
        'user_email',
        'market',
        'direction',
        'currency',
        'amount',
        'duration_sec',
        'entry_price',
        'close_price',
        'status',
        'result',
        'payout',
        'settled_by',
        'created_at',
      ];
      const lines = [header.join(',')];
      for (const row of rows) {
        lines.push(
          [
            row.id,
            row.email,
            row.market,
            row.direction,
            row.currency,
            toMajor(Number(row.amount_minor), row.currency),
            row.duration_sec,
            row.entry_price,
            row.close_price,
            row.status,
            row.result,
            row.payout_minor === null ? '' : toMajor(Number(row.payout_minor), row.currency),
            row.settled_by,
            new Date(Number(row.created_at)).toISOString(),
          ]
            .map(csvCell)
            .join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="admin-trades-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(`${lines.join('\n')}\n`);
    }),
  );

  router.get(
    '/trades/stats',
    guard('trades.read'),
    asyncHandler((req, res) => {
      const q = parseInput(
        z.object({
          from: z.coerce.number().int().nonnegative().optional(),
          to: z.coerce.number().int().nonnegative().optional(),
        }),
        req.query,
      );
      res.json({ ...ctx.trades.stats(q), simulation: true });
    }),
  );

  router.get(
    '/trades/:id',
    guard('trades.read'),
    asyncHandler((req, res) => {
      const row = ctx.trades.row(req.params.id);
      if (!row) throw AppError.notFound('Trade tidak ditemukan');
      const user = ctx.users.findById(row.user_id);
      res.json({
        trade: toTradeView(row),
        user: user ? toPublicUser(user) : null,
        audit: ctx.db.all(
          'SELECT id, action, actor_role, meta, created_at FROM audit_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 20',
          row.id,
        ),
        simulation: true,
      });
    }),
  );

  router.post(
    '/trades/:id/settle',
    guard('trades.settle'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({ reason: z.string().min(5).max(300), closePrice: z.number().positive().optional() }),
        req.body,
      );
      const trade = ctx.trades.manualSettle(req.params.id, {
        closePrice: body.closePrice,
        reason: body.reason,
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      ctx.notifications.create({
        userId: trade.userId,
        kind: 'trade_admin_settled',
        title: `Trade ${trade.market} diselesaikan admin`,
        body: `Alasan: ${body.reason}`,
        link: '/history',
      });
      res.json({ trade, simulation: true });
    }),
  );

  // ---------------------------------------------------------------- users
  const userFilters = z.object({
    search: z.string().max(120).optional(),
    status: z.enum(['all', 'blocked', 'verified', 'unverified']).default('all'),
    role: z.enum(['user', ...(STAFF_ROLES as unknown as [string, ...string[]])]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  });

  router.get(
    '/users',
    guard('users.read'),
    asyncHandler((req, res) => {
      const q = parseInput(userFilters, req.query);
      const result = ctx.users.list(q as never);
      res.json({
        users: result.users.map((user) => ({
          ...toPublicUser(user),
          wallets: ctx.wallets.balances(user.id),
          openTrades: ctx.trades.countOpen(user.id),
        })),
        total: result.total,
        simulation: true,
      });
    }),
  );

  router.get(
    '/users/:id',
    guard('users.read'),
    asyncHandler((req, res) => {
      const user = ctx.users.findById(req.params.id);
      if (!user) throw AppError.notFound('User tidak ditemukan');
      res.json({
        user: toPublicUser(user),
        wallets: ctx.wallets.balances(user.id),
        trades: ctx.trades.listForUser({ userId: user.id, limit: 20 }),
        ledger: ctx.ledger.list({ userId: user.id, limit: 50 }),
        sessions: ctx.accounts.listForUser(user.id),
        loginHistory: ctx.users.loginHistory(user.id, 30),
        notes: ctx.users.notes(user.id),
        audit: ctx.db.all(
          'SELECT id, action, actor_role, meta, created_at FROM audit_log WHERE actor_user_id = ? OR target_id = ? ORDER BY created_at DESC LIMIT 30',
          user.id,
          user.id,
        ),
        simulation: true,
      });
    }),
  );

  router.post(
    '/users/:id/block',
    guard('users.support'),
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ blocked: z.boolean(), reason: z.string().max(200).optional() }), req.body);
      const user = ctx.users.setBlocked(
        req.params.id,
        body.blocked,
        body.reason ?? null,
        { userId: req.auth!.userId, role: 'admin' },
        clientIp(req),
      );
      if (body.blocked) ctx.users.logoutEverywhere(req.params.id, 'user_blocked');
      res.json({ user, simulation: true });
    }),
  );

  router.post(
    '/users/:id/logout',
    guard('users.support'),
    asyncHandler((req, res) => {
      const user = ctx.users.findById(req.params.id);
      if (!user) throw AppError.notFound('User tidak ditemukan');
      ctx.users.logoutEverywhere(user.id, 'admin_force_logout');
      res.json({ ok: true, simulation: true });
    }),
  );

  router.post(
    '/users/:id/wallet',
    guard('users.balance'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          currency: currencyEnum,
          mode: z.enum(['add', 'subtract', 'set']),
          amount: z.number().min(0),
          reason: z.string().min(5).max(200),
        }),
        req.body,
      );
      const wallet = ctx.wallets.adminAdjust(req.params.id, body.currency, body.mode, body.amount, {
        reason: body.reason,
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      ctx.realtime?.sendToUser(req.params.id, { type: 'balance', wallets: ctx.wallets.balances(req.params.id) });
      res.json({ wallet, wallets: ctx.wallets.balances(req.params.id), simulation: true });
    }),
  );

  router.post(
    '/users/:id/role',
    guard('users.role'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({ staffRole: z.enum(STAFF_ROLES as unknown as [string, ...string[]]).nullable() }),
        req.body,
      );
      const user = ctx.users.setStaffRole(req.params.id, body.staffRole as never, {
        userId: req.auth!.userId,
        role: 'admin',
      });
      ctx.users.logoutEverywhere(user.id, 'role_changed');
      res.json({ user, simulation: true });
    }),
  );

  router.patch(
    '/users/:id/role',
    guard('users.role'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({ staffRole: z.enum(STAFF_ROLES as unknown as [string, ...string[]]).nullable() }),
        req.body,
      );
      const user = ctx.users.setStaffRole(req.params.id, body.staffRole as never, {
        userId: req.auth!.userId,
        role: 'admin',
      });
      ctx.users.logoutEverywhere(user.id, 'role_changed');
      res.json({ user, simulation: true });
    }),
  );

  router.get(
    '/users/:id/notes',
    guard('users.read'),
    asyncHandler((req, res) => {
      res.json({ notes: ctx.users.notes(req.params.id), simulation: true });
    }),
  );

  router.post(
    '/users/:id/notes',
    guard('users.support'),
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ body: z.string().min(2).max(1000) }), req.body);
      ctx.users.addNote(req.params.id, req.auth!.userId, body.body);
      res.status(201).json({ notes: ctx.users.notes(req.params.id), simulation: true });
    }),
  );

  router.post(
    '/users/:id/send-reset',
    guard('users.support'),
    asyncHandler((req, res) => {
      const user = ctx.users.findById(req.params.id);
      if (!user) throw AppError.notFound('User tidak ditemukan');
      const link = ctx.users.issueEmailToken(user.id, user.email, 'reset_password');
      res.json({
        ok: true,
        message: 'Tautan reset dibuat.',
        devResetLink: ctx.config.DEV_EMAIL_LINKS ? `${ctx.config.PUBLIC_URL}/reset-password?token=${link}` : undefined,
        simulation: true,
      });
    }),
  );

  // -------------------------------------------------------------- finance
  router.get(
    '/finance',
    guard('finance.read'),
    asyncHandler((_req, res) => {
      const totals = ctx.ledger.totalsPerCurrency();
      const wallets = ctx.db.all<{ currency: Currency; total: number; n: number }>(
        `SELECT currency, COALESCE(SUM(balance_minor), 0) AS total, COUNT(*) AS n FROM wallets GROUP BY currency`,
      );
      const since = Date.now() - 7 * 86_400_000;
      const conversions = ctx.db.all(
        'SELECT id, user_id, from_currency, to_currency, from_minor, to_minor, rate, created_at FROM conversions ORDER BY created_at DESC LIMIT 50',
      );
      const pendingSettlement = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM trades WHERE status = 'open'`);
      const exposure = ctx.db.get<{ total: number }>(
        `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount_minor WHEN currency = 'IDR' THEN amount_minor / 16000 ELSE amount_minor END), 0) AS total
           FROM trades WHERE status = 'open'`,
      );
      res.json({
        simulation: true,
        label: SIMULATION_LABEL,
        totals,
        wallets: wallets.map((row) => ({
          currency: row.currency,
          totalMinor: Number(row.total),
          accounts: Number(row.n),
          total: toMajor(Number(row.total), row.currency),
        })),
        flows: ctx.ledger
          .summaryByKind(since, Date.now())
          .map((row) => ({ ...row, totalMinor: Number(row.totalMinor) })),
        conversions,
        openTrades: Number(pendingSettlement?.n ?? 0),
        openExposureUsd: toMajor(Number(exposure?.total ?? 0), 'USD'),
        settings: settingsPayload(),
        rates: ctx.settings.get().rates,
        methods: { deposit: false, withdraw: false, note: 'Tidak ada pembayaran nyata di platform demo ini.' },
      });
    }),
  );

  router.post(
    '/finance/fx',
    guard('finance.write'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z
          .object({
            rates: z.record(currencyEnum, z.number().positive()).optional(),
            USD: z.number().positive().optional(),
            IDR: z.number().positive().optional(),
            USDT: z.number().positive().optional(),
            note: z.string().max(200).optional(),
          })
          .refine(
            (value) =>
              Boolean(value.rates) || value.USD !== undefined || value.IDR !== undefined || value.USDT !== undefined,
            {
              message: 'kirim rates atau minimal satu kurs',
            },
          ),
        req.body,
      );
      const before = ctx.settings.get().rates;
      const incoming: Partial<Record<Currency, number>> = { ...(body.rates ?? {}) };
      for (const code of CURRENCY_LIST) {
        const direct = body[code];
        if (typeof direct === 'number') incoming[code] = direct;
      }
      const rates = { ...before, ...incoming };
      ctx.settings.update(
        { rates },
        { actorRole: 'admin', actorUserId: req.auth!.userId, ip: clientIp(req) },
        ctx.clock.now(),
      );
      ctx.db.run(
        `INSERT INTO market_param_history (market, action, actor_role, before_json, after_json, note, created_at)
         VALUES ('__FX__', 'fx_updated', 'admin', ?, ?, ?, ?)`,
        JSON.stringify(before),
        JSON.stringify(rates),
        body.note ?? 'kurs demo diperbarui',
        ctx.clock.now(),
      );
      res.json({ rates, history: ctx.markets.historyList('__FX__', 20), simulation: true });
    }),
  );

  // ------------------------------------------------------------- settings
  function settingsPayload() {
    const settings = ctx.settings.get();
    return {
      ...settings,
      minAmount: majorMap(settings.minAmount),
      maxAmount: majorMap(settings.maxAmount),
      initialBalance: majorMap(settings.initialBalance),
      topupMax: majorMap(settings.topupMax),
      globalMaxAmountUsd: toMajor(settings.globalMaxAmountUsdMinor, 'USD'),
      defaults: {
        ...DEFAULT_SETTINGS,
        minAmount: majorMap(DEFAULT_SETTINGS.minAmount),
        maxAmount: majorMap(DEFAULT_SETTINGS.maxAmount),
        initialBalance: majorMap(DEFAULT_SETTINGS.initialBalance),
        topupMax: majorMap(DEFAULT_SETTINGS.topupMax),
        globalMaxAmountUsd: toMajor(DEFAULT_SETTINGS.globalMaxAmountUsdMinor, 'USD'),
      },
      simulation: true,
      label: SIMULATION_LABEL,
    };
  }

  router.get(
    '/settings',
    guard('settings.read'),
    asyncHandler((_req, res) => {
      res.json(settingsPayload());
    }),
  );

  router.patch(
    '/settings',
    guard('settings.write'),
    asyncHandler((req, res) => {
      const body = parseInput(settingsSchema, req.body);
      const patch: Partial<RuntimeSettings> = {
        ...body,
        minAmount: minorMap(body.minAmount),
        maxAmount: minorMap(body.maxAmount),
        initialBalance: minorMap(body.initialBalance),
        topupMax: minorMap(body.topupMax),
        defaultLanguage: body.defaultLanguage as 'id' | 'en' | undefined,
        globalMaxAmountUsdMinor:
          body.globalMaxAmountUsd === undefined ? undefined : toMinor(body.globalMaxAmountUsd, 'USD'),
      } as Partial<RuntimeSettings>;
      if (patch.globalMaxAmountUsdMinor === undefined) delete patch.globalMaxAmountUsdMinor;
      if (patch.minAmount === undefined) delete patch.minAmount;
      if (patch.maxAmount === undefined) delete patch.maxAmount;
      if (patch.initialBalance === undefined) delete patch.initialBalance;
      if (patch.topupMax === undefined) delete patch.topupMax;
      if (patch.defaultLanguage === undefined) delete patch.defaultLanguage;
      ctx.settings.update(
        patch,
        { actorRole: 'admin', actorUserId: req.auth!.userId, ip: clientIp(req) },
        ctx.clock.now(),
      );
      res.json({ settings: settingsPayload(), simulation: true, message: 'Pengaturan disimpan (audit tercatat).' });
    }),
  );

  // -------------------------------------------------------------- content
  router.get(
    '/banners',
    guard('content.read'),
    asyncHandler((_req, res) => {
      res.json({ banners: ctx.content.banners(true), simulation: true });
    }),
  );

  router.post(
    '/banners',
    guard('content.write'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          title: z.string().min(3).max(160),
          body: z.string().max(1000).nullish(),
          link: z.string().max(300).nullish(),
          active: z.boolean().optional(),
          startsAt: z.number().int().nonnegative().nullish(),
          endsAt: z.number().int().nonnegative().nullish(),
        }),
        req.body,
      );
      res.status(201).json({ banner: ctx.content.createBanner(body as never, req.auth!.userId), simulation: true });
    }),
  );

  router.patch(
    '/banners/:id',
    guard('content.write'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          title: z.string().min(3).max(160).optional(),
          body: z.string().max(1000).nullish(),
          link: z.string().max(300).nullish(),
          active: z.boolean().optional(),
          startsAt: z.number().int().nonnegative().nullish(),
          endsAt: z.number().int().nonnegative().nullish(),
        }),
        req.body,
      );
      res.json({ banner: ctx.content.updateBanner(req.params.id, body as never, req.auth!.userId), simulation: true });
    }),
  );

  router.delete(
    '/banners/:id',
    guard('content.write'),
    asyncHandler((req, res) => {
      ctx.content.deleteBanner(req.params.id, req.auth!.userId);
      res.json({ ok: true, simulation: true });
    }),
  );

  router.get(
    '/pages',
    guard('content.read'),
    asyncHandler((_req, res) => {
      res.json({ pages: ctx.content.pages(), slugs: CONTENT_SLUGS, simulation: true });
    }),
  );

  router.put(
    '/pages/:slug',
    guard('content.write'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({ title: z.string().min(3).max(120), body: z.string().min(10).max(20_000) }),
        req.body,
      );
      res.json({ page: ctx.content.updatePage(req.params.slug, body, req.auth!.userId), simulation: true });
    }),
  );

  // --------------------------------------------------------------- system
  router.get(
    '/system',
    guard('system.read'),
    asyncHandler((_req, res) => {
      const jobs = ctx.jobs.status();
      const dbSize = (() => {
        try {
          return fs.statSync(ctx.config.DB_PATH).size;
        } catch {
          return null;
        }
      })();
      res.json({
        simulation: true,
        label: SIMULATION_LABEL,
        version: ctx.config.APP_VERSION,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        db: { ok: true, driver: ctx.db.driver, sizeBytes: dbSize, path: path.basename(ctx.config.DB_PATH) },
        diskFreeMb: diskFreeMb(ctx.config.DATA_DIR),
        backups: ctx.backups.list(),
        backupDir: ctx.backups.dir,
        backupFiles: backupFilesOnDisk(ctx.backups.dir).slice(0, 20),
        uploads: {
          dir: path.basename(ctx.config.UPLOADS_DIR),
          files: fs.readdirSync(ctx.config.UPLOADS_DIR, { recursive: true }).length,
        },
        ws: { connections: ctx.realtime?.connectionCount ?? 0, dropped: ctx.realtime?.recentDrops ?? 0 },
        jobs,
        alerts: ctx.stats.dashboard({
          wsConnections: ctx.realtime?.connectionCount ?? 0,
          wsDropped: ctx.realtime?.recentDrops ?? 0,
          jobsStale: jobs.filter((job) => job.stale).map((job) => job.name),
          diskFreeMb: diskFreeMb(ctx.config.DATA_DIR),
        }).alerts,
      });
    }),
  );

  router.get(
    '/jobs',
    guard('system.read'),
    asyncHandler((_req, res) => {
      res.json({ jobs: ctx.jobs.status(), history: ctx.jobs.history(50), simulation: true });
    }),
  );

  router.post(
    '/jobs/:name/run',
    guard('system.write'),
    asyncHandler(async (req, res) => {
      const job = ctx.jobs.status().find((entry) => entry.name === req.params.name);
      if (!job) throw AppError.notFound('Job tidak ditemukan');
      const detail = await ctx.jobs.runNow(req.params.name);
      res.json({ ok: true, job: req.params.name, detail, simulation: true });
    }),
  );

  router.get(
    '/backups',
    guard('system.read'),
    asyncHandler((_req, res) => {
      res.json({ backups: ctx.backups.list(), dir: ctx.backups.dir, simulation: true });
    }),
  );

  router.post(
    '/backups',
    guard('system.write'),
    asyncHandler((req, res) => {
      const file = ctx.backups.run('manual', req.auth!.userId);
      res.status(201).json({ backup: file, simulation: true });
    }),
  );

  router.get(
    '/backups/:id/download',
    guard('system.read'),
    asyncHandler((req, res) => {
      const file = ctx.backups.list().find((entry) => entry.id === req.params.id);
      if (!file) throw AppError.notFound('Backup tidak ditemukan');
      const target = path.join(ctx.backups.dir, file.filename);
      if (!target.startsWith(ctx.backups.dir) || !fs.existsSync(target))
        throw AppError.notFound('File backup tidak ada di disk');
      res.download(target, file.filename);
    }),
  );

  router.delete(
    '/backups/:id',
    guard('system.write'),
    asyncHandler((req, res) => {
      ctx.backups.remove(req.params.id);
      res.json({ ok: true, simulation: true });
    }),
  );

  router.get(
    '/logs',
    guard('system.read'),
    asyncHandler((req, res) => {
      const q = parseInput(
        z.object({
          level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
          search: z.string().max(120).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        req.query,
      );
      res.json({ entries: logBuffer.list(q), simulation: true });
    }),
  );

  router.get(
    '/audit',
    guard('audit.read'),
    asyncHandler((req, res) => {
      const q = parseInput(
        z.object({
          action: z.string().max(60).optional(),
          userId: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        req.query,
      );
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (q.action) {
        clauses.push('action LIKE ?');
        params.push(`%${q.action}%`);
      }
      if (q.userId) {
        clauses.push('(actor_user_id = ? OR target_user_id = ?)');
        params.push(q.userId, q.userId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const entries = ctx.db.all(
        `SELECT id, actor_user_id, actor_role, action, target_type, target_id, meta, ip, created_at
           FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        ...params,
        q.limit,
        q.offset,
      );
      res.json({ entries, total: entries.length, simulation: true });
    }),
  );

  router.get(
    '/audit/export.csv',
    guard('audit.read'),
    asyncHandler((_req, res) => {
      const rows = ctx.db.all<{
        id: number;
        action: string;
        actor_role: string;
        target_type: string;
        target_id: string;
        created_at: number;
      }>(
        'SELECT id, action, actor_role, target_type, target_id, created_at FROM audit_log ORDER BY created_at DESC LIMIT 5000',
      );
      const lines = ['id,action,actor_role,target_type,target_id,created_at'];
      for (const row of rows) {
        lines.push(
          [
            row.id,
            row.action,
            row.actor_role,
            row.target_type,
            row.target_id,
            new Date(Number(row.created_at)).toISOString(),
          ]
            .map(csvCell)
            .join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(`${lines.join('\n')}\n`);
    }),
  );

  router.get(
    '/payments',
    guard('payments.read'),
    asyncHandler((_req, res) => {
      res.json({
        simulation: true,
        enabled: false,
        status: 'not_available',
        label: 'SEGERA HADIR',
        message: 'Modul pembayaran (QRIS, transfer bank, kartu, penarikan) sengaja tidak diimplementasikan.',
        providers: ctx.payments.listProviders(),
      });
    }),
  );

  // Keeps the backup service referenced for the type-checker in dev builds.
  void createBackupService;
  void registerJobs;
  void createLogger;

  return router;
}
