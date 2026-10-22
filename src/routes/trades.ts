import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { AppError } from '../lib/errors.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { decimalsOf, majorToCents } from '../domain/money.js';

const uuid = z.string().uuid();

const createTradeSchema = z.object({
  symbol: z.string().min(1).max(32),
  direction: z.enum(['up', 'down']),
  amount: z
    .number()
    .positive('amount must be greater than 0')
    .max(1_000_000)
    .refine((a) => decimalsOf(a) <= 2, 'amount supports at most 2 decimals'),
  durationSec: z.number().int().positive().max(86_400),
});

const listSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const idempotencyKeySchema = z
  .string()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key contains invalid characters');

/** Stable fingerprint of the intent behind a request, used to detect key reuse. */
function fingerprint(input: { symbol: string; direction: string; amountCents: number; durationSec: number }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function tradeRoutes(ctx: AppContext, requireAuth: RequestHandler, tradeLimiter: RequestHandler): Router {
  const router = Router();

  router.post(
    '/trades',
    requireAuth,
    tradeLimiter,
    asyncHandler(async (req, res) => {
      const body = parseInput(createTradeSchema, req.body);
      const rawKey = req.header('idempotency-key');
      let idempotencyKey: string | null = null;
      if (rawKey !== undefined) {
        idempotencyKey = parseInput(idempotencyKeySchema, rawKey);
      }

      const amountCents = majorToCents(body.amount);
      const userId = req.auth!.userId;

      const result = await ctx.trades.create({
        userId,
        symbol: body.symbol,
        direction: body.direction,
        amountCents,
        durationSec: body.durationSec,
        idempotencyKey,
        requestHash: idempotencyKey
          ? fingerprint({ symbol: body.symbol, direction: body.direction, amountCents, durationSec: body.durationSec })
          : null,
        ip: clientIp(req),
      });

      if (!result.replayed) {
        // the realtime hub broadcasts trade:opened + balance to every socket of this user
        ctx.trades.announceOpened(result.trade, result.balanceCents);
      }

      if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
      if (idempotencyKey) res.setHeader('Idempotency-Key', idempotencyKey);
      res.status(result.replayed ? 200 : 201).json({ trade: result.trade });
    }),
  );

  router.get(
    '/trades',
    requireAuth,
    asyncHandler(async (req, res) => {
      const query = parseInput(listSchema, req.query);
      const status = query.status && query.status !== 'all' ? query.status : undefined;
      const trades = await ctx.trades.listTrades({
        userId: req.auth!.userId,
        status,
        limit: query.limit ?? 50,
      });
      res.json({ trades });
    }),
  );

  router.get(
    '/trades/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = parseInput(uuid, req.params.id);
      const trade = await ctx.trades.getTrade(req.auth!.userId, id);
      res.json({ trade });
    }),
  );

  router.get(
    '/trades/:id/status',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = parseInput(uuid, req.params.id);
      const trade = await ctx.trades.getTrade(req.auth!.userId, id);
      res.json({ id: trade.id, status: trade.status, result: trade.result });
    }),
  );

  // keep AppError import used for future guards
  void AppError;
  return router;
}
