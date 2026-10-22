import { Router, type RequestHandler } from 'express';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp } from '../http/validation.js';

export function accountRoutes(ctx: AppContext, requireAuth: RequestHandler): Router {
  const router = Router();

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await ctx.users.me(req.auth!.userId);
      const limits = ctx.settings.get();
      const openTrades = await ctx.trades.countOpenTrades(req.auth!.userId);
      res.json({
        user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt },
        account: { balance: user.balance, balanceCents: user.balanceCents, currency: user.currency },
        limits: {
          minAmount: limits.minAmountCents / 100,
          maxAmount: limits.maxAmountCents / 100,
          allowedDurations: limits.allowedDurations,
          payoutRate: limits.payoutRate,
          payoutMode: limits.payoutMode,
          maxOpenTrades: limits.maxOpenTrades,
          openTrades,
        },
      });
    }),
  );

  router.post(
    '/account/reset',
    requireAuth,
    asyncHandler(async (req, res) => {
      const result = await ctx.users.resetBalance(req.auth!.userId, clientIp(req));
      const currency = ctx.config.CURRENCY;
      const payload = {
        account: {
          balance: result.balanceCents / 100,
          balanceCents: result.balanceCents,
          currency,
        },
        voidedTrades: result.voidedTrades,
      };
      ctx.realtime?.sendToUser(req.auth!.userId, {
        type: 'balance',
        amount: payload.account.balance,
        amountCents: payload.account.balanceCents,
        currency,
      });
      res.json(payload);
    }),
  );

  return router;
}
