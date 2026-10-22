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
  MOODS,
  SIMULATION_LABEL,
  TIME_FRAMES,
  TIMEFRAME_LIST,
  TRENDS,
  VOLATILITY_PRESETS,
} from '../domain/constants.js';
import { toMajor } from '../domain/money.js';

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

/**
 * Public market surface. Every payload carries the SIMULASI label on purpose:
 * the simulation flag is part of the API contract, not just the UI.
 */
export function marketRoutes(ctx: AppContext): Router {
  const router = Router();

  const marketRow = (symbolParam: string) => {
    const symbol = String(symbolParam).toUpperCase();
    const row = ctx.markets.row(symbol);
    if (!row || row.active !== 1 || row.deleted_at) {
      throw AppError.notFound(`Market tidak dikenal: ${symbol}`, 'MARKET_NOT_FOUND');
    }
    return row;
  };

  const tickerOf = (symbol: string) => {
    const row = marketRow(symbol);
    const last = ctx.engine.lastPrice(row.symbol) ?? ctx.engine.lastTick(row.symbol)?.price ?? null;
    const now = ctx.clock.now();
    const reference = ctx.marketData.price24hAgo(row.symbol, now);
    const changeAbs = last !== null && reference !== null ? last - reference : null;
    const changePct = last !== null && reference ? ((last - reference) / reference) * 100 : null;
    const range = ctx.marketData.range24h(row.symbol, now);
    const view = ctx.markets.views().find((m) => m.symbol === row.symbol);
    return {
      market: row.symbol,
      symbol: row.symbol,
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
      open: view?.open ?? true,
      status: view?.status ?? 'active',
      mood: row.mood,
      trend: row.trend,
      volatility: row.volatility,
      volatilityPreset: row.volatility_preset,
      serverTime: now,
    };
  };

  const tickerSummary = (symbol: string) => {
    const full = tickerOf(symbol);
    return {
      price: full.price,
      priceDecimals: full.priceDecimals,
      change24h: full.change24h,
      change24hPercent: full.change24hPercent,
      high24h: full.high24h,
      low24h: full.low24h,
      serverTime: full.serverTime,
    };
  };

  router.get(
    '/markets',
    asyncHandler((_req, res) => {
      const markets = ctx.markets.views().map((view) => ({
        ...view,
        label: SIMULATION_LABEL,
        ticker: tickerSummary(view.symbol),
      }));
      res.json({ simulation: true, label: SIMULATION_LABEL, serverTime: ctx.clock.now(), markets });
    }),
  );

  router.get(
    '/markets/:symbol',
    asyncHandler((req, res) => {
      const row = marketRow(req.params.symbol);
      const view = ctx.markets.views().find((m) => m.symbol === row.symbol);
      const candles = ctx.marketData.candles(row.symbol, '1m', { limit: 180, includeCurrent: true });
      res.json({
        ...view,
        market: row.symbol,
        simulation: true,
        label: SIMULATION_LABEL,
        engine: ctx.engine.describe(row.symbol),
        ticker: tickerOf(row.symbol),
        candles: candles.candles,
        current: candles.current,
      });
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
      const row = marketRow(req.params.symbol);
      const result = ctx.marketData.candles(row.symbol, q.tf, {
        limit: q.limit,
        before: q.before,
        includeCurrent: q.includeCurrent,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        market: row.symbol,
        symbol: row.symbol,
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
      const row = marketRow(req.params.symbol);
      const ticks = ctx.marketData.recentTicks(row.symbol, { since: q.since, limit: q.limit });
      res.json({
        market: row.symbol,
        symbol: row.symbol,
        simulation: true,
        label: SIMULATION_LABEL,
        serverTime: ctx.clock.now(),
        priceDecimals: row.price_decimals,
        ticks,
      });
    }),
  );

  /** Public simulation-parameter history: admin changes must be visible. */
  router.get(
    '/markets/:symbol/history',
    asyncHandler((req, res) => {
      const row = marketRow(req.params.symbol);
      const q = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
      res.json({
        market: row.symbol,
        label: SIMULATION_LABEL,
        entries: ctx.markets.historyList(row.symbol, q.limit),
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
        platform: {
          name: settings.platformName,
          logoUrl: settings.platformLogoPath ? `/uploads/${settings.platformLogoPath}` : null,
          faviconUrl: settings.faviconPath ? `/uploads/${settings.faviconPath}` : null,
          accent: settings.themeAccent,
          disclaimer: settings.disclaimer,
          defaultLanguage: settings.defaultLanguage,
          defaultTimezone: settings.defaultTimezone,
        },
        payout: { rate: settings.payoutRate, byDuration: settings.payoutByDuration, mode: settings.payoutMode },
        durations: {
          allowed: settings.allowedDurations,
          presets: DURATION_PRESETS,
          minSec: MIN_DURATION_SEC,
          maxSec: MAX_DURATION_SEC,
        },
        limits: {
          maxOpenTrades: settings.maxOpenTrades,
          maxOpenTradesPerUser: settings.maxOpenTradesPerUser,
          minAmount: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.minAmount[c], c)])),
          maxAmount: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.maxAmount[c], c)])),
          globalMaxAmountUsd: toMajor(settings.globalMaxAmountUsdMinor, 'USD'),
          topupMax: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.topupMax[c], c)])),
          topupDailyCount: settings.topupDailyCount,
          topupCooldownSec: settings.topupCooldownSec,
          resetCooldownSec: settings.resetCooldownSec,
        },
        currencies: ctx.currencies.list({ includeInactive: true }),
        activeCurrencies: ctx.currencies.list(),
        rates: settings.rates,
        site: ctx.site.publicConfig(),
        payments: ctx.payments.describe(),
        timeframes: TIMEFRAME_LIST,
        moods: MOODS,
        trends: TRENDS,
        volatilityPresets: VOLATILITY_PRESETS,
        features: {
          deposits: ctx.site.isEnabled('deposits'),
          withdrawals: ctx.site.isEnabled('withdrawals'),
          payments: ctx.payments.describe().configured,
          demoTopup: ctx.site.isEnabled('demo_topup'),
          registration: ctx.site.isEnabled('registrations'),
          liveChat: ctx.site.isEnabled('live_chat'),
          twoFactor: true,
        },
      });
    }),
  );

  return router;
}
