import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';

const candlesSchema = z.object({
  symbol: z.string().min(1).max(32).optional(),
  tf: z.string().min(1).max(8).default('1m'),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  before: z.coerce.number().int().nonnegative().optional(),
  includeCurrent: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === undefined || v === 'true' || v === '1'),
});

const ticksSchema = z.object({
  symbol: z.string().min(1).max(32).optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

export function marketRoutes(ctx: AppContext): Router {
  const router = Router();

  const ensureSymbol = (symbol?: string) => {
    const active = ctx.engine.symbol;
    if (symbol && symbol !== active) {
      throw AppError.unprocessable('SYMBOL_INACTIVE', `Symbol "${symbol}" is not active`, { activeSymbols: [active] });
    }
    return active;
  };

  /** Static market configuration for the client (limits, durations, decimals...). */
  router.get(
    '/market',
    asyncHandler(async (_req, res) => {
      const settings = ctx.settings.get();
      res.json({
        symbol: ctx.engine.symbol,
        symbolName: ctx.config.SYMBOL_NAME,
        timeframes: ctx.engine.timeframes,
        timeframeMs: Object.fromEntries(Object.entries(ctx.config.TIMEFRAMES)),
        priceDecimals: ctx.config.PRICE_DECIMALS,
        currency: ctx.config.CURRENCY,
        serverTime: ctx.clock.now(),
        trading: {
          allowedDurations: settings.allowedDurations,
          minAmount: settings.minAmountCents / 100,
          maxAmount: settings.maxAmountCents / 100,
          payoutRate: settings.payoutRate,
          payoutMode: settings.payoutMode,
          maxOpenTrades: settings.maxOpenTrades,
        },
      });
    }),
  );

  router.get(
    '/candles',
    asyncHandler(async (req, res) => {
      const q = parseInput(candlesSchema, req.query);
      const symbol = ensureSymbol(q.symbol);
      const tfMs = ctx.config.TIMEFRAMES[q.tf];
      if (!tfMs) {
        throw AppError.badRequest(`tf must be one of ${ctx.engine.timeframes.join(', ')}`);
      }
      const candles = ctx.engine.getCandles(q.tf, q.limit, q.before);
      const current = q.before === undefined && q.includeCurrent ? ctx.engine.getCurrentCandle(q.tf) : undefined;
      const merged = current ? [...candles.filter((c) => c.t < current.t), current] : candles;
      res.json({
        symbol,
        tf: q.tf,
        tfMs,
        serverTime: ctx.clock.now(),
        priceDecimals: ctx.config.PRICE_DECIMALS,
        seq: ctx.engine.lastSeq,
        candles: merged.slice(-q.limit),
        lastPrice: ctx.engine.getLastPrice(),
        current: current ?? null,
      });
    }),
  );

  router.get(
    '/ticks',
    asyncHandler(async (req, res) => {
      const q = parseInput(ticksSchema, req.query);
      const symbol = ensureSymbol(q.symbol);
      const ticks = ctx.engine.getRecentTicks(q.limit, q.since);
      res.json({
        symbol,
        serverTime: ctx.clock.now(),
        priceDecimals: ctx.config.PRICE_DECIMALS,
        seq: ctx.engine.lastSeq,
        ticks: ticks.map((t) => ({ price: t.price, time: t.time, seq: t.seq })),
      });
    }),
  );

  return router;
}
