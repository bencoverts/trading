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
  market: z.string().max(32).optional(),
  result: z.enum(['win', 'lose', 'draw']).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idempotencySchema = z
  .string()
  .min(8, 'Idempotency-Key minimal 8 karakter')
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key mengandung karakter tidak valid');

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function tradeRoutes(ctx: AppContext, requireAuth: RequestHandler, tradeLimiter: RequestHandler): Router {
  const router = Router();

  const fingerprint = (input: {
    market: string;
    direction: string;
    currency: string;
    amountMinor: number;
    durationSec: number;
  }) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

  const wallets = (userId: string) =>
    ctx.wallets
      .balances(userId)
      .map((w) => ({ currency: w.currency, balance: w.balance, balanceMinor: w.balanceMinor }));

  router.post(
    '/trades',
    requireAuth,
    tradeLimiter,
    asyncHandler((req, res) => {
      const body = parseInput(createSchema, req.body);
      const user = ctx.users.findById(req.auth!.userId);
      if (!user) throw AppError.unauthorized('User tidak lagi ada');
      if (ctx.config.REQUIRE_EMAIL_VERIFICATION && !user.email_verified_at) {
        throw new AppError('EMAIL_NOT_VERIFIED', 403, 'Verifikasi email dulu sebelum trading');
      }
      if (decimalsOf(body.amount) > CURRENCIES[body.currency].decimals) {
        throw AppError.badRequest(
          `Nominal maksimal ${CURRENCIES[body.currency].decimals} desimal untuk ${body.currency}`,
        );
      }
      const amountMinor = toMinor(body.amount, body.currency);
      const market = body.market.toUpperCase();
      // trading is only allowed on currencies an admin has enabled for trading
      ctx.currencies.requireEnabled(body.currency, 'trading');

      // Idempotency-Key is mandatory: a retried POST can never open two trades.
      const rawKey = req.header('idempotency-key');
      if (!rawKey) {
        throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 400, 'Header Idempotency-Key wajib dikirim untuk membuka trade');
      }
      const idempotencyKey = parseInput(idempotencySchema, rawKey);

      const result = ctx.trades.create({
        userId: user.id,
        market,
        direction: body.direction,
        currency: body.currency,
        amountMinor,
        durationSec: body.durationSec,
        idempotencyKey,
        requestHash: fingerprint({
          market,
          direction: body.direction,
          currency: body.currency,
          amountMinor,
          durationSec: body.durationSec,
        }),
        ip: clientIp(req),
      });

      if (!result.replayed) ctx.trades.announceOpened(result.trade, result.balanceMinor);
      if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
      res.setHeader('Idempotency-Key', idempotencyKey);
      res.status(result.replayed ? 200 : 201).json({
        trade: { ...result.trade, amountDisplay: toMajor(result.trade.amountMinor, result.trade.currency) },
        wallets: wallets(user.id),
        simulation: true,
        label: 'SIMULASI',
      });
    }),
  );

  /** Cheapest possible pre-check so the UI can show fees/payout before confirming. */
  router.post(
    '/trades/preview',
    requireAuth,
    asyncHandler((req, res) => {
      const body = parseInput(createSchema, req.body);
      const amountMinor = toMinor(body.amount, body.currency);
      const market = ctx.trades.validateIntent({
        userId: req.auth!.userId,
        market: body.market.toUpperCase(),
        currency: body.currency,
        amountMinor,
        durationSec: body.durationSec,
      });
      const settings = ctx.settings.get();
      const rate =
        market.payout_rate !== null
          ? Number(market.payout_rate)
          : (settings.payoutByDuration[String(body.durationSec)] ?? settings.payoutRate);
      const payoutMinor = Math.round(amountMinor * (1 + rate));
      const entryPrice = ctx.engine.lastPrice(market.symbol);
      const now = ctx.clock.now();
      res.json({
        market: market.symbol,
        direction: body.direction,
        currency: body.currency,
        amount: body.amount,
        amountMinor,
        durationSec: body.durationSec,
        payoutRate: rate,
        payout: toMajor(payoutMinor, body.currency),
        payoutMinor,
        profit: toMajor(payoutMinor - amountMinor, body.currency),
        priceDecimals: market.price_decimals,
        entryPrice,
        entryTime: now,
        expiryTime: now + body.durationSec * 1000,
        simulation: true,
      });
    }),
  );

  router.get(
    '/trades',
    requireAuth,
    asyncHandler((req, res) => {
      const q = parseInput(listSchema, req.query);
      const trades = ctx.trades.listForUser({
        userId: req.auth!.userId,
        status: q.status === 'all' ? undefined : q.status,
        market: q.market?.toUpperCase(),
        result: q.result,
        from: q.from,
        to: q.to,
        limit: q.limit,
        offset: q.offset,
      });
      const total = ctx.trades.countForUser({
        userId: req.auth!.userId,
        status: q.status === 'all' ? undefined : q.status,
        market: q.market?.toUpperCase(),
        result: q.result,
        from: q.from,
        to: q.to,
      });
      res.json({
        trades: trades.map((t) => ({ ...t, amountDisplay: toMajor(t.amountMinor, t.currency) })),
        total,
        simulation: true,
        serverTime: ctx.clock.now(),
      });
    }),
  );

  router.get(
    '/trades/export.csv',
    requireAuth,
    asyncHandler((req, res) => {
      const q = parseInput(listSchema, req.query);
      const trades = ctx.trades.listForUser({
        userId: req.auth!.userId,
        status: q.status === 'all' ? undefined : q.status,
        market: q.market?.toUpperCase(),
        result: q.result,
        from: q.from,
        to: q.to,
        limit: 200,
        offset: q.offset,
      });
      const header = [
        'id',
        'market',
        'direction',
        'currency',
        'amount',
        'duration_sec',
        'entry_price',
        'close_price',
        'status',
        'result',
        'payout',
        'entry_time',
        'expiry_time',
        'settled_at',
        'settled_by',
      ];
      const lines = [header.join(',')];
      for (const t of trades) {
        lines.push(
          [
            t.id,
            t.market,
            t.direction,
            t.currency,
            t.amount,
            t.durationSec,
            t.entryPrice,
            t.closePrice,
            t.status,
            t.result,
            t.payout,
            new Date(t.entryTime).toISOString(),
            new Date(t.expiryTime).toISOString(),
            t.status === 'closed' ? new Date(t.expiryTime).toISOString() : '',
            t.settledBy,
          ]
            .map(csvCell)
            .join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="trades-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(`${lines.join('\n')}\n`);
    }),
  );

  router.get(
    '/trades/active',
    requireAuth,
    asyncHandler((req, res) => {
      res.json({
        trades: ctx.trades.listForUser({ userId: req.auth!.userId, status: 'open', limit: 50 }),
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
