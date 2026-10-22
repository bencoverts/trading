import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import {
  CURRENCY_LIST,
  DURATION_PRESETS,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  SIMULATION_LABEL,
  TIME_FRAMES,
  TIMEFRAME_LIST,
} from '../domain/constants.js';
import { toMajor } from '../domain/money.js';
import { MOODS, TRENDS } from '../domain/constants.js';

const candlesQuery = z.object({
  tf: z.enum(TIMEFRAME_LIST as [string, ...string[]]).default('1m'),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
  before: z.coerce.number().int().nonnegative().optional(),
  includeCurrent: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === undefined || v === 'true' || v === '1'),
});

const ticksQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

export function marketRoutes(ctx: AppContext): Router {
  const router = Router();

  const market = (symbolParam: string) => {
    const symbol = symbolParam.toUpperCase();
    const row = ctx.markets.row(symbol);
    if (!row || row.active !== 1) throw AppError.notFound(`Unknown market: ${symbol}`, 'MARKET_NOT_FOUND');
    return row;
  };

  const tickerOf = (symbol: string) => {
    const row = market(symbol);
    const last = ctx.engine.lastPrice(row.symbol) ?? ctx.engine.lastTick(row.symbol)?.price ?? null;
    const reference = ctx.marketData.price24hAgo(row.symbol, ctx.clock.now());
    const changeAbs = last !== null && reference !== null ? last - reference : null;
    const changePct = last !== null && reference ? ((last - reference) / reference) * 100 : null;
    const range = ctx.marketData.range24h(row.symbol, ctx.clock.now());
    return {
      market: row.symbol,
      name: row.name,
      simulation: true,
      label: SIMULATION_LABEL,
      price: last,
      priceDecimals: row.price_decimals,
      change24h: changeAbs,
      change24hPercent: changePct,
      high24h: range?.high ?? null,
      low24h: range?.low ?? null,
      paused: row.paused === 1,
      active: row.active === 1,
      mood: row.mood,
      trend: row.trend,
      volatility: row.volatility,
      serverTime: ctx.clock.now(),
    };
  };

  /** Public market list (SIMULASI label is part of the payload). */
  router.get(
    '/markets',
    asyncHandler((_req, res) => {
      const markets = ctx.markets.views(false).map((m) => {
        const t = tickerOf(m.symbol);
        return {
          ...m,
          label: SIMULATION_LABEL,
          ticker: {
            price: t.price,
            change24h: t.change24h,
            change24hPercent: t.change24hPercent,
            serverTime: t.serverTime,
          },
        };
      });
      res.json({ simulation: true, label: SIMULATION_LABEL, serverTime: ctx.clock.now(), markets });
    }),
  );

  router.get(
    '/markets/:symbol/ticker',
    asyncHandler((req, res) => {
      res.json(tickerOf(req.params.symbol));
    }),
  );

  router.get(
    '/markets/:symbol/candles',
    asyncHandler((req, res) => {
      const q = parseInput(candlesQuery, req.query);
      const row = market(req.params.symbol);
      const result = ctx.marketData.candles(row.symbol, q.tf, {
        limit: q.limit,
        before: q.before,
        includeCurrent: q.includeCurrent,
      });
      res.json({
        market: row.symbol,
        name: row.name,
        simulation: true,
        label: SIMULATION_LABEL,
        tf: q.tf,
        tfMs: TIME_FRAMES[q.tf as keyof typeof TIME_FRAMES],
        serverTime: ctx.clock.now(),
        priceDecimals: row.price_decimals,
        candles: result.candles,
        current: result.current,
      });
    }),
  );

  router.get(
    '/markets/:symbol/ticks',
    asyncHandler((req, res) => {
      const q = parseInput(ticksQuery, req.query);
      const row = market(req.params.symbol);
      const ticks = ctx.marketData.recentTicks(row.symbol, { since: q.since, limit: q.limit });
      res.json({
        market: row.symbol,
        simulation: true,
        label: SIMULATION_LABEL,
        serverTime: ctx.clock.now(),
        priceDecimals: row.price_decimals,
        ticks,
      });
    }),
  );

  /** Public trading configuration (durations, payout preview, currencies, rates). */
  router.get(
    '/config',
    asyncHandler((_req, res) => {
      const settings = ctx.settings.get();
      res.json({
        simulation: true,
        label: SIMULATION_LABEL,
        serverTime: ctx.clock.now(),
        payout: { rate: settings.payoutRate, mode: settings.payoutMode },
        durations: {
          allowed: settings.allowedDurations,
          presets: DURATION_PRESETS,
          minSec: MIN_DURATION_SEC,
          maxSec: MAX_DURATION_SEC,
        },
        limits: {
          maxOpenTrades: settings.maxOpenTrades,
          minAmount: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.minAmount[c], c)])),
          maxAmount: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.maxAmount[c], c)])),
          topupMax: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.topupMax[c], c)])),
          topupDailyCount: settings.topupDailyCount,
        },
        currencies: CURRENCY_LIST,
        rates: settings.rates,
        timeframes: TIMEFRAME_LIST,
        moods: MOODS,
        trends: TRENDS,
      });
    }),
  );

  return router;
}
