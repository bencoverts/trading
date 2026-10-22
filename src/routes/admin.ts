import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { majorToCents } from '../domain/money.js';

const patchSettingsSchema = z
  .object({
    payoutRate: z.number().min(0).max(5).optional(),
    payoutMode: z.enum(['profit', 'total']).optional(),
    allowedDurations: z.array(z.number().int().positive().max(3600)).min(1).max(12).optional(),
    minAmount: z.number().positive().optional(),
    maxAmount: z.number().positive().optional(),
    maxOpenTrades: z.number().int().min(1).max(100).optional(),
    mood: z.enum(['sepi', 'normal', 'cepat', 'liar']).optional(),
    volatility: z.number().min(0.01).max(20).optional(),
  })
  .strict();

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export function adminRoutes(ctx: AppContext, requireAdmin: RequestHandler): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get(
    '/settings',
    asyncHandler(async (_req, res) => {
      res.json({ settings: ctx.settings.get() });
    }),
  );

  router.patch(
    '/settings',
    asyncHandler(async (req, res) => {
      const patch = parseInput(patchSettingsSchema, req.body);
      const updated = await ctx.settings.update(
        {
          ...(patch.payoutRate !== undefined ? { payoutRate: patch.payoutRate } : {}),
          ...(patch.payoutMode !== undefined ? { payoutMode: patch.payoutMode } : {}),
          ...(patch.allowedDurations !== undefined ? { allowedDurations: patch.allowedDurations } : {}),
          ...(patch.minAmount !== undefined ? { minAmountCents: majorToCents(patch.minAmount) } : {}),
          ...(patch.maxAmount !== undefined ? { maxAmountCents: majorToCents(patch.maxAmount) } : {}),
          ...(patch.maxOpenTrades !== undefined ? { maxOpenTrades: patch.maxOpenTrades } : {}),
          ...(patch.mood !== undefined ? { mood: patch.mood } : {}),
          ...(patch.volatility !== undefined ? { volatility: patch.volatility } : {}),
        },
        'admin',
        req.auth?.userId,
        clientIp(req),
      );
      if (patch.mood) ctx.engine.setMood(patch.mood);
      if (patch.volatility !== undefined) ctx.engine.setVolatility(patch.volatility);
      res.json({ settings: updated, source: ctx.engine.describeSource() });
    }),
  );

  router.get(
    '/feed',
    asyncHandler(async (_req, res) => {
      const last = ctx.engine.getLastTick();
      res.json({
        source: ctx.engine.describeSource(),
        symbol: ctx.engine.symbol,
        lastPrice: ctx.engine.getLastPrice(),
        lastTick: last,
        seq: ctx.engine.lastSeq,
        tickIntervalMs: ctx.config.TICK_INTERVAL_MS,
      });
    }),
  );

  router.post(
    '/settle',
    asyncHandler(async (_req, res) => {
      const settled = await ctx.trades.settleDue(ctx.clock.now());
      res.json({ settled: settled.length, trades: settled.map((s) => s.trade) });
    }),
  );

  router.get(
    '/stats',
    asyncHandler(async (_req, res) => {
      const trades = await ctx.db.get<Record<string, unknown>>(
        `SELECT COUNT(*) AS total_trades,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_trades,
                SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'lose' THEN 1 ELSE 0 END) AS losses,
                SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draws,
                SUM(CASE WHEN status = 'closed' THEN amount_cents ELSE 0 END) AS wagered_cents,
                SUM(payout_cents) AS paid_cents,
                SUM(CASE WHEN status = 'open' THEN amount_cents ELSE 0 END) AS open_exposure_cents
           FROM trades`,
      );
      const users = await ctx.db.get<Record<string, unknown>>(
        `SELECT COUNT(*) AS users, SUM(balance_cents) AS balance_cents FROM accounts`,
      );
      const wagered = num(trades?.wagered_cents);
      const paid = num(trades?.paid_cents);
      res.json({
        trades: {
          total: num(trades?.total_trades),
          open: num(trades?.open_trades),
          closed: num(trades?.total_trades) - num(trades?.open_trades),
          wins: num(trades?.wins),
          losses: num(trades?.losses),
          draws: num(trades?.draws),
          wagered: wagered / 100,
          paidOut: paid / 100,
          /** gross gaming revenue: stakes - payouts (positive = house ahead) */
          ggr: (wagered - paid) / 100,
          openExposure: num(trades?.open_exposure_cents) / 100,
        },
        accounts: {
          users: num(users?.users),
          totalBalance: num(users?.balance_cents) / 100,
          currency: ctx.config.CURRENCY,
        },
        settings: ctx.settings.get(),
        feed: ctx.engine.describeSource(),
        generatedAt: ctx.clock.now(),
      });
    }),
  );

  router.get(
    '/trades',
    asyncHandler(async (req, res) => {
      const q = parseInput(
        z.object({
          status: z.enum(['open', 'closed']).optional(),
          userId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        req.query,
      );
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (q.status) {
        clauses.push('t.status = ?');
        params.push(q.status);
      }
      if (q.userId) {
        clauses.push('t.user_id = ?');
        params.push(q.userId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(q.limit);
      const rows = await ctx.db.all<Record<string, unknown>>(
        `SELECT t.*, u.email FROM trades t JOIN users u ON u.id = t.user_id ${where} ORDER BY t.created_at DESC LIMIT ?`,
        params,
      );
      res.json({ trades: rows });
    }),
  );

  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const q = parseInput(
        z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          action: z.string().max(64).optional(),
          userId: z.string().uuid().optional(),
        }),
        req.query,
      );
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (q.action) {
        clauses.push('action = ?');
        params.push(q.action);
      }
      if (q.userId) {
        clauses.push('user_id = ?');
        params.push(q.userId);
      }
      params.push(q.limit);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await ctx.db.all<Record<string, unknown>>(
        `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ?`,
        params,
      );
      res.json({ entries: rows });
    }),
  );

  return router;
}
