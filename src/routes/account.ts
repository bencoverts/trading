import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import { CURRENCY_LIST, type Currency } from '../domain/constants.js';
import { toMajor, toMinor } from '../domain/money.js';
import { toPublicUser } from '../services/users.js';
import { recordAudit } from '../services/audit.js';

const currencyEnum = z.enum(CURRENCY_LIST as [Currency, ...Currency[]]);

const topupSchema = z.object({
  currency: currencyEnum,
  amount: z.number().positive().max(1_000_000_000),
});

export function accountRoutes(ctx: AppContext, requireAuth: RequestHandler): Router {
  const router = Router();

  const wallets = (userId: string) =>
    ctx.wallets.balances(userId).map((w) => ({
      currency: w.currency,
      balance: w.balance,
      balanceMinor: w.balanceMinor,
      display: toMajor(w.balanceMinor, w.currency),
    }));

  const profile = (userId: string) => {
    const user = ctx.users.findById(userId);
    if (!user) throw AppError.unauthorized('User no longer exists');
    const settings = ctx.settings.get();
    return {
      user: toPublicUser(user),
      wallets: wallets(userId),
      displayCurrency: user.display_currency,
      rates: settings.rates,
      limits: {
        minAmount: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.minAmount[c], c)])),
        maxAmount: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.maxAmount[c], c)])),
        topupMax: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.topupMax[c], c)])),
        topupDailyCount: settings.topupDailyCount,
        maxOpenTrades: settings.maxOpenTrades,
      },
      openTrades: ctx.trades.countOpen(userId),
      payout: { rate: settings.payoutRate, mode: settings.payoutMode },
      simulation: true,
    };
  };

  router.get(
    '/account',
    requireAuth,
    asyncHandler((req, res) => {
      res.json(profile(req.auth!.userId));
    }),
  );

  router.patch(
    '/account',
    requireAuth,
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ displayCurrency: currencyEnum }), req.body);
      const user = ctx.users.setDisplayCurrency(req.auth!.userId, body.displayCurrency);
      res.json({ user, simulation: true });
    }),
  );

  router.post(
    '/account/password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = parseInput(
        z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(8).max(128) }),
        req.body,
      );
      await ctx.users.changePassword(req.auth!.userId, body.currentPassword, body.newPassword);
      // password change revokes old sessions; issue a fresh cookie for this client
      const user = ctx.users.findById(req.auth!.userId);
      if (user) {
        res.cookie(ctx.config.COOKIE_NAME, ctx.users.signSession(user), {
          httpOnly: true,
          sameSite: 'lax',
          secure: ctx.config.COOKIE_SECURE,
          path: '/',
          maxAge: ctx.config.SESSION_TTL_SEC * 1000,
        });
      }
      res.json({ ok: true, message: 'Password updated' });
    }),
  );

  /** Reset every demo wallet to the configured starting balance. */
  router.post(
    '/account/reset',
    requireAuth,
    asyncHandler((req, res) => {
      const userId = req.auth!.userId;
      const now = ctx.clock.now();
      // open trades are voided as full-refund draws so the reset is predictable
      const open = ctx.db.all<{ id: string; amount_minor: number }>(
        `SELECT id, amount_minor FROM trades WHERE user_id = ? AND status = 'open'`,
        userId,
      );
      for (const trade of open) {
        // full refund at the entry price: the reset must be predictable
        ctx.trades.voidAtEntry(trade.id, 'demo balance reset', userId, clientIp(req));
      }
      const balances = ctx.wallets.resetAll(userId, clientIp(req));
      recordAudit(ctx.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'account.reset',
        targetType: 'user',
        targetId: userId,
        meta: { balances: balances.map((b) => b.balanceMinor), voidedTrades: open.length },
        ip: clientIp(req),
        now,
      });
      ctx.realtime?.sendToUser(userId, { type: 'account:reset', wallets: balances });
      res.json({ wallets: wallets(userId), voidedTrades: open.length, simulation: true });
    }),
  );

  /** Instant DEMO top-up (virtual money, capped per transaction and per day). */
  router.post(
    '/wallet/topup',
    requireAuth,
    asyncHandler((req, res) => {
      const body = parseInput(topupSchema, req.body);
      const amountMinor = toMinor(body.amount, body.currency);
      if (amountMinor <= 0) throw AppError.badRequest('amount is too small');
      const wallet = ctx.wallets.topUp(req.auth!.userId, body.currency, amountMinor, clientIp(req));
      ctx.realtime?.sendToUser(req.auth!.userId, { type: 'balance', wallets: wallets(req.auth!.userId) });
      res.status(201).json({
        wallet: { ...wallet, display: toMajor(wallet.balanceMinor, wallet.currency) },
        wallets: wallets(req.auth!.userId),
        simulation: true,
        message: 'Demo balance topped up (virtual money only)',
      });
    }),
  );

  router.get(
    '/wallet/transactions',
    requireAuth,
    asyncHandler((req, res) => {
      const q = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
      const rows = ctx.db.all<{
        id: string;
        currency: Currency;
        amount_minor: number;
        kind: string;
        note: string | null;
        created_at: number;
      }>(
        'SELECT id, currency, amount_minor, kind, note, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        req.auth!.userId,
        q.limit,
      );
      res.json({
        transactions: rows.map((r) => ({
          id: r.id,
          currency: r.currency,
          amount: toMajor(Number(r.amount_minor), r.currency),
          amountMinor: Number(r.amount_minor),
          kind: r.kind,
          note: r.note,
          createdAt: Number(r.created_at),
        })),
      });
    }),
  );

  return router;
}
