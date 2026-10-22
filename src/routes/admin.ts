import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import { CURRENCY_LIST, MOODS, TRENDS, type Currency } from '../domain/constants.js';
import { toMajor, toMinor } from '../domain/money.js';
import { toPublicUser, toPublicUser as publicUser } from '../services/users.js';
import { toTradeView, type TradeRow } from '../services/trades.js';

const currencyEnum = z.enum(CURRENCY_LIST as [Currency, ...Currency[]]);

const marketPatchSchema = z
  .object({
    mood: z.enum(MOODS).optional(),
    trend: z.enum(TRENDS).optional(),
    volatility: z.number().min(0.01).max(20).optional(),
    paused: z.boolean().optional(),
    pauseReason: z.string().max(200).nullish(),
    active: z.boolean().optional(),
  })
  .strict();

const settingsPatchSchema = z
  .object({
    payoutRate: z.number().min(0).max(5).optional(),
    payoutMode: z.enum(['profit', 'total']).optional(),
    allowedDurations: z.array(z.number().int().min(5).max(28_800)).min(1).max(20).optional(),
    maxOpenTrades: z.number().int().min(1).max(100).optional(),
    minAmount: z.record(currencyEnum, z.number().positive()).optional(),
    maxAmount: z.record(currencyEnum, z.number().positive()).optional(),
    initialBalance: z.record(currencyEnum, z.number().min(0)).optional(),
    topupMax: z.record(currencyEnum, z.number().positive()).optional(),
    topupDailyCount: z.number().int().min(1).max(100).optional(),
    rates: z.record(currencyEnum, z.number().positive()).optional(),
  })
  .strict();

export function adminRoutes(ctx: AppContext, requireAdmin: RequestHandler): Router {
  const router = Router();
  router.use(requireAdmin);

  const fill = (input?: Partial<Record<Currency, number>>): Partial<Record<Currency, number>> => input ?? {};

  const minorMap = (input?: Partial<Record<Currency, number>>) => {
    if (!input) return undefined;
    const out: Partial<Record<Currency, number>> = {};
    for (const [currency, value] of Object.entries(input)) {
      if (value !== undefined) out[currency as Currency] = toMinor(value, currency as Currency);
    }
    return out;
  };

  // --------------------------------------------------------------- dashboard
  router.get(
    '/stats',
    asyncHandler((_req, res) => {
      const trades = ctx.db.get<Record<string, number | null>>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'lose' THEN 1 ELSE 0 END) AS losses,
                SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draws,
                SUM(CASE WHEN status = 'closed' THEN amount_minor ELSE 0 END) AS volume_closed,
                SUM(payout_minor) AS payout_total,
                SUM(CASE WHEN status = 'open' THEN amount_minor ELSE 0 END) AS open_exposure
           FROM trades`,
      );
      const users = ctx.db.get<Record<string, number | null>>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
                SUM(CASE WHEN blocked_at IS NOT NULL THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN email_verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified
           FROM users`,
      );
      const walletTotals = ctx.db.all<{ currency: Currency; total: number }>(
        'SELECT currency, SUM(balance_minor) AS total FROM wallets GROUP BY currency',
      );
      const topups = ctx.db.get<{ n: number | null; total: number | null }>(
        `SELECT COUNT(*) AS n, SUM(amount_minor) AS total FROM deposits WHERE kind = 'demo_topup'`,
      );
      const volume = Number(trades?.volume_closed ?? 0);
      const payout = Number(trades?.payout_total ?? 0);
      res.json({
        simulation: true,
        users: {
          total: Number(users?.total ?? 0),
          admins: Number(users?.admins ?? 0),
          blocked: Number(users?.blocked ?? 0),
          verified: Number(users?.verified ?? 0),
        },
        trades: {
          total: Number(trades?.total ?? 0),
          open: Number(trades?.open ?? 0),
          wins: Number(trades?.wins ?? 0),
          losses: Number(trades?.losses ?? 0),
          draws: Number(trades?.draws ?? 0),
          // volume/payout mix currencies, so they are reported in minor units plus USD conversion
          volumeMinor: volume,
          payoutMinor: payout,
          /** simulated house result: settled stakes - payouts (mixed-currency, informational) */
          simulatedProfitMinor: volume - payout,
          openExposureMinor: Number(trades?.open_exposure ?? 0),
        },
        wallets: walletTotals.map((w) => ({ currency: w.currency, totalMinor: Number(w.total ?? 0) })),
        demoTopups: { count: Number(topups?.n ?? 0), totalMinor: Number(topups?.total ?? 0) },
        settings: ctx.settings.get(),
        generatedAt: ctx.clock.now(),
      });
    }),
  );

  // ------------------------------------------------------------------ market
  router.get(
    '/markets',
    asyncHandler((_req, res) => {
      const markets = ctx.markets.views(true).map((m) => ({
        ...m,
        engine: ctx.engine.describe(m.symbol),
      }));
      res.json({ markets, muted: false });
    }),
  );

  router.patch(
    '/markets/:symbol',
    asyncHandler((req, res) => {
      const patch = parseInput(marketPatchSchema, req.body);
      const market = ctx.markets.update(req.params.symbol, patch, {
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      res.json({ market, engine: ctx.engine.describe(market.symbol) });
    }),
  );

  // ---------------------------------------------------------------- settings
  router.get(
    '/settings',
    asyncHandler((_req, res) => {
      res.json({ settings: ctx.settings.get() });
    }),
  );

  router.patch(
    '/settings',
    asyncHandler((req, res) => {
      const patch = parseInput(settingsPatchSchema, req.body);
      const settings = ctx.settings.update(
        {
          ...(patch.payoutRate !== undefined ? { payoutRate: patch.payoutRate } : {}),
          ...(patch.payoutMode !== undefined ? { payoutMode: patch.payoutMode } : {}),
          ...(patch.allowedDurations !== undefined ? { allowedDurations: patch.allowedDurations } : {}),
          ...(patch.maxOpenTrades !== undefined ? { maxOpenTrades: patch.maxOpenTrades } : {}),
          ...(patch.minAmount ? { minAmount: { ...ctx.settings.get().minAmount, ...fill(minorMap(patch.minAmount)) } } : {}),
          ...(patch.maxAmount ? { maxAmount: { ...ctx.settings.get().maxAmount, ...fill(minorMap(patch.maxAmount)) } } : {}),
          ...(patch.initialBalance
            ? { initialBalance: { ...ctx.settings.get().initialBalance, ...fill(minorMap(patch.initialBalance)) } }
            : {}),
          ...(patch.topupMax ? { topupMax: { ...ctx.settings.get().topupMax, ...fill(minorMap(patch.topupMax)) } } : {}),
          ...(patch.topupDailyCount !== undefined ? { topupDailyCount: patch.topupDailyCount } : {}),
          ...(patch.rates
            ? {
                rates: {
                  USD: 1,
                  IDR: patch.rates.IDR ?? ctx.settings.get().rates.IDR,
                  USDT: patch.rates.USDT ?? ctx.settings.get().rates.USDT,
                },
              }
            : {}),
        },
        { actorRole: 'admin', actorUserId: req.auth!.userId, ip: clientIp(req) },
        ctx.clock.now(),
      );
      res.json({ settings });
    }),
  );

  // ------------------------------------------------------------------ trades
  router.get(
    '/trades',
    asyncHandler((req, res) => {
      const q = parseInput(
        z.object({
          status: z.enum(['open', 'closed']).optional(),
          market: z.string().max(32).optional(),
          userId: z.string().uuid().optional(),
          result: z.enum(['win', 'lose', 'draw']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        req.query,
      );
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (q.status) {
        clauses.push('t.status = ?');
        params.push(q.status);
      }
      if (q.market) {
        clauses.push('t.market = ?');
        params.push(q.market.toUpperCase());
      }
      if (q.userId) {
        clauses.push('t.user_id = ?');
        params.push(q.userId);
      }
      if (q.result) {
        clauses.push('t.result = ?');
        params.push(q.result);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(q.limit, q.offset);
      const rows = ctx.db.all<TradeRow & { email: string; username: string }>(
        `SELECT t.*, u.email, u.username FROM trades t JOIN users u ON u.id = t.user_id
         ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
        ...params,
      );
      const count = ctx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM trades t ${where}`,
        ...params.slice(0, -2),
      );
      res.json({
        trades: rows.map((r) => ({ ...toTradeView(r), email: r.email, username: r.username })),
        total: Number(count?.n ?? 0),
      });
    }),
  );

  /** Manual settlement for exceptional cases - a reason is mandatory and audited. */
  router.post(
    '/trades/:id/settle',
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          reason: z.string().min(5).max(300),
          closePrice: z.number().positive().optional(),
        }),
        req.body,
      );
      const trade = ctx.trades.manualSettle(req.params.id, {
        closePrice: body.closePrice,
        reason: body.reason,
        actorUserId: req.auth!.userId,
        ip: clientIp(req),
      });
      res.json({ trade, simulation: true });
    }),
  );

  // ------------------------------------------------------------------- users
  router.get(
    '/users',
    asyncHandler((req, res) => {
      const q = parseInput(
        z.object({
          search: z.string().max(120).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        req.query,
      );
      const { users, total } = ctx.users.list(q);
      res.json({
        total,
        users: users.map((u) => ({
          ...toPublicUser(u),
          wallets: ctx.wallets.balances(u.id),
          openTrades: ctx.trades.countOpen(u.id),
        })),
      });
    }),
  );

  router.get(
    '/users/:id',
    asyncHandler((req, res) => {
      const user = ctx.users.findById(req.params.id);
      if (!user) throw AppError.notFound('User not found');
      const trades = ctx.trades.listForUser({ userId: user.id, limit: 20 });
      const deposits = ctx.db.all(
        'SELECT id, currency, amount_minor, kind, note, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
        user.id,
      );
      res.json({
        user: toPublicUser(user),
        wallets: ctx.wallets.balances(user.id),
        trades,
        deposits,
        audit: ctx.db.all(
          'SELECT id, action, actor_role, meta, created_at FROM audit_log WHERE target_id = ? OR actor_user_id = ? ORDER BY created_at DESC LIMIT 50',
          user.id,
          user.id,
        ),
      });
    }),
  );

  router.post(
    '/users/:id/block',
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ blocked: z.boolean(), reason: z.string().max(200).nullish() }), req.body);
      const user = ctx.users.setBlocked(
        req.params.id,
        body.blocked,
        body.reason ?? null,
        req.auth!.userId,
        clientIp(req),
      );
      res.json({ user });
    }),
  );

  router.post(
    '/users/:id/wallet',
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          currency: currencyEnum,
          /** signed major-unit delta, e.g. 25 or -10 */
          delta: z.number(),
          reason: z.string().min(3).max(200),
        }),
        req.body,
      );
      if (body.delta === 0) throw AppError.badRequest('delta must not be zero');
      const deltaMinor = toMinor(body.delta, body.currency);
      if (deltaMinor === 0) throw AppError.badRequest('delta is too small for this currency');
      const wallet = ctx.wallets.adminAdjust(
        req.params.id,
        body.currency,
        deltaMinor,
        req.auth!.userId,
        body.reason,
        clientIp(req),
      );
      res.json({ wallet, wallets: ctx.wallets.balances(req.params.id) });
    }),
  );

  // ------------------------------------------------------------------- audit
  router.get(
    '/audit',
    asyncHandler((req, res) => {
      const q = parseInput(
        z.object({
          action: z.string().max(64).optional(),
          actorUserId: z.string().uuid().optional(),
          targetId: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        req.query,
      );
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (q.action) {
        clauses.push('action LIKE ?');
        params.push(`${q.action}%`);
      }
      if (q.actorUserId) {
        clauses.push('actor_user_id = ?');
        params.push(q.actorUserId);
      }
      if (q.targetId) {
        clauses.push('target_id = ?');
        params.push(q.targetId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(q.limit, q.offset);
      const rows = ctx.db.all<{
        id: number;
        actor_user_id: string | null;
        actor_role: string;
        action: string;
        target_type: string | null;
        target_id: string | null;
        meta: string | null;
        ip: string | null;
        created_at: number;
      }>(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...params);
      res.json({
        entries: rows.map((r) => ({ ...r, meta: r.meta ? (JSON.parse(r.meta) as unknown) : null })),
      });
    }),
  );

  void publicUser;
  return router;
}
