import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';

/**
 * Real-money surface - deliberately disabled.
 *
 * These routes exist so a future implementation (QRIS, bank transfer, card,
 * withdrawal) can be added behind the same paths without touching the rest of
 * the app. They always answer 501 NOT_AVAILABLE.
 */
export function paymentRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/payments/providers',
    asyncHandler((_req, res) => {
      res.json({
        simulation: true,
        liveAccounts: false,
        providers: ctx.payments.listProviders(),
        message: 'Only demo accounts exist. No payment provider is integrated.',
      });
    }),
  );

  /** Placeholder status used by the "Segera hadir" pages. */
  router.get(
    '/payments/methods',
    asyncHandler((_req, res) => {
      res.json({
        enabled: false,
        status: 'not_available',
        message: 'Endpoint lama; gunakan /api/v1/deposits dan /api/v1/withdrawals',
        provider: ctx.payments.describe().provider,
        methods: [],
        simulation: true,
        label: 'SIMULASI',
      });
    }),
  );

  const notAvailable = asyncHandler((_req, res) => {
    const result = ctx.payments.notAvailable();
    res.status(501).json({ error: { code: 'NOT_AVAILABLE', message: result.message }, ...result });
  });

  router.post(
    '/payments/deposit',
    (req, _res, next) => {
      // validate shape anyway so the contract is testable, then refuse
      parseInput(
        z.object({
          currency: z.string().min(1).max(8),
          amount: z.number().positive(),
          method: z.enum(['qris', 'bank_transfer', 'card', 'crypto']),
        }),
        req.body,
      );
      next();
    },
    notAvailable,
  );

  router.post(
    '/payments/withdraw',
    (req, _res, next) => {
      parseInput(
        z.object({
          currency: z.string().min(1).max(8),
          amount: z.number().positive(),
          method: z.enum(['bank_transfer', 'crypto']),
          destination: z.string().min(3).max(200),
        }),
        req.body,
      );
      next();
    },
    notAvailable,
  );

  router.get(
    '/payments/history',
    asyncHandler(() => {
      throw AppError.notAvailable('Real-money payment history');
    }),
  );

  return router;
}
