import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import { CURRENCIES, CURRENCY_LIST, type Currency } from '../domain/constants.js';
import { decimalsOf, toMajor, toMinor } from '../domain/money.js';

const currencyEnum = z.enum(CURRENCY_LIST as [Currency, ...Currency[]]);

const createSchema = z.object({
  market: z.string().min(1).max(32),
  direction: z.enum(['up', 'down']),
  currency: currencyEnum.default('USD'),
  amount: z.number().positive().max(1_000_000_000),
  durationSec: z.number().int().min(5).max(28_800),
});

const listSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idempotencySchema = z
  .string()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key contains invalid characters');

export function tradeRoutes(ctx: AppContext, requireAuth: RequestHandler, tradeLimiter: RequestHandler): Router {
  const router = Router();

  const fingerprint = (input: { market: string; direction: string; currency: string; amountMinor: number; durationSec: number }) =>
    createHash('sha256').update(JSON.stringify(input)).digest('hex');

  const wallets = (userId: string) =>
    ctx.wallets.balances(userId).map((w) => ({ currency: w.currency, balance: w.balance, balanceMinor: w.balanceMinor }));

  router.post(
    '/trades',
    requireAuth,
    tradeLimiter,
    asyncHandler((req, res) => {
      const body = parseInput(createSchema, req.body);
      const user = ctx.users.findById(req.auth!.userId);
      if (!user) throw AppError.unauthorized('User no longer exists');
      if (ctx.config.REQUIRE_EMAIL_VERIFICATION && !user.email_verified_at) {
        throw new AppError('EMAIL_NOT_VERIFIED', 403, 'Please verify your email before trading');
      }
      if (decimalsOf(body.amount) > CURRENCIES[body.currency].decimals) {
        throw AppError.badRequest(`amount supports at most ${CURRENCIES[body.currency].decimals} decimals for ${body.currency}`);
      }
      const amountMinor = toMinor(body.amount, body.currency);

      let idempotencyKey: string | null = null;
      const rawKey = req.header('idempotency-key');
      if (rawKey !== undefined) idempotencyKey = parseInput(idempotencySchema, rawKey);

      const market = body.market.toUpperCase();
      const result = ctx.trades.create({
        userId: user.id,
        market,
        direction: body.direction,
        currency: body.currency,
        amountMinor,
        durationSec: body.durationSec,
        idempotencyKey,
        requestHash: idempotencyKey
          ? fingerprint({
              market,
              direction: body.direction,
              currency: body.currency,
              amountMinor,
              durationSec: body.durationSec,
            })
          : null,
        ip: clientIp(req),
      });

      if (!result.replayed) {
        ctx.trades.announceOpened(result.trade, result.balanceMinor);
        ctx.realtime?.sendToUser(user.id, { type: 'balance', wallets: wallets(user.id) });
      }
      if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
      if (idempotencyKey) res.setHeader('Idempotency-Key', idempotencyKey);
      res.status(result.replayed ? 200 : 201).json({
        trade: result.trade,
        wallets: wallets(user.id),
        simulation: true,
      });
    }),
  );

  router.get(
    '/trades',
    requireAuth,
    asyncHandler((req, res) => {
      const q = parseInput(listSchema, req.query);
      const status = q.status === 'all' ? undefined : q.status;
      const trades = ctx.trades.listForUser({ userId: req.auth!.userId, status, limit: q.limit, offset: q.offset });
      res.json({
        trades: trades.map((t) => ({
          ...t,
          amountDisplay: toMajor(t.amountMinor, t.currency),
        })),
        simulation: true,
        serverTime: ctx.clock.now(),
      });
    }),
  );

  router.get(
    '/trades/:id',
    requireAuth,
    asyncHandler((req, res) => {
      const id = parseInput(z.string().uuid(), req.params.id);
      res.json({ trade: ctx.trades.getForUser(req.auth!.userId, id), simulation: true });
    }),
  );

  return router;
}
