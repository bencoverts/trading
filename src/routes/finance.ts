import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { CURRENCY_LIST, type Currency } from '../domain/constants.js';
import { toMajor } from '../domain/money.js';
import { AppError } from '../lib/errors.js';
import type { AuthedRequest } from '../http/session.js';

const currencyEnum = z.enum(CURRENCY_LIST as [Currency, ...Currency[]]);

const depositSchema = z.object({
  currency: currencyEnum.default('IDR'),
  amount: z.number().positive().max(1_000_000_000),
});

const manualDepositSchema = z.object({
  currency: currencyEnum.default('IDR'),
  amount: z.number().positive().max(1_000_000_000),
  reference: z.string().trim().min(4).max(120),
  note: z.string().trim().max(300).optional(),
  proofPath: z
    .string()
    .trim()
    .max(300)
    .regex(/^\/(uploads\/)?[A-Za-z0-9/_.-]+$/, 'Path bukti tidak valid')
    .optional(),
});

const withdrawalSchema = z.object({
  currency: currencyEnum.default('IDR'),
  method: z.enum(['bank_transfer', 'ewallet']),
  amount: z.number().positive().max(1_000_000_000),
  destination: z.object({
    bank: z.string().trim().min(2).max(40).optional(),
    accountNumber: z.string().trim().min(6).max(24).optional(),
    accountName: z.string().trim().min(2).max(80).optional(),
    provider: z.string().trim().min(2).max(40).optional(),
    phone: z.string().trim().min(8).max(20).optional(),
  }),
});

const idempotency = (req: { header: (name: string) => string | undefined }): string | null => {
  const value = req.header('idempotency-key');
  if (!value) return null;
  if (value.length < 8 || value.length > 128) {
    throw AppError.badRequest('Idempotency-Key harus 8-128 karakter', undefined, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw AppError.badRequest('Idempotency-Key mengandung karakter tidak valid', undefined, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return value;
};

const userId = (req: unknown): string => (req as AuthedRequest).auth!.userId;

/**
 * User-facing money endpoints: currencies, KlikQRIS/manual deposits and
 * withdrawals. Balance changes only ever happen through the services, never
 * from a request body.
 */
export function financeRoutes(ctx: AppContext, requireAuth: RequestHandler): Router {
  const router = Router();

  /** Public branding / SEO / maintenance state (no secrets). */
  router.get(
    '/site',
    asyncHandler((_req, res) => {
      res.json({ ...ctx.site.publicConfig(), flags: ctx.site.flags() });
    }),
  );

  router.get(
    '/currencies',
    asyncHandler((_req, res) => {
      res.json({
        currencies: ctx.currencies.list(),
        all: ctx.currencies.list({ includeInactive: true }),
        simulation: true,
        label: 'SIMULASI',
      });
    }),
  );

  router.get(
    '/deposits/methods',
    asyncHandler((_req, res) => {
      const currencies = ctx.currencies.list();
      res.json({
        provider: ctx.payments.describe(),
        methods: [
          {
            id: 'klikqris',
            label: 'QRIS (KlikQRIS)',
            enabled: ctx.deposits.client.configured && ctx.site.isEnabled('deposits'),
            requiresConfiguration: !ctx.deposits.client.configured,
          },
          { id: 'manual', label: 'Transfer manual (verifikasi admin)', enabled: ctx.site.isEnabled('deposits') },
        ],
        currencies: currencies.filter((currency) => currency.depositEnabled),
        simulation: true,
        label: 'SIMULASI',
      });
    }),
  );

  router.post(
    '/deposits',
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!ctx.site.isEnabled('deposits')) {
        throw new AppError('NOT_AVAILABLE', 503, 'Deposit sedang dinonaktifkan');
      }
      const body = parseInput(depositSchema, req.body);
      const result = await ctx.deposits.createQris(
        userId(req),
        { ...body, idempotencyKey: idempotency(req) },
        clientIp(req),
      );
      res.status(result.reused ? 200 : 201).json({
        deposit: result.deposit,
        reused: result.reused,
        simulation: true,
        label: 'SIMULASI',
      });
    }),
  );

  router.post(
    '/deposits/manual',
    requireAuth,
    asyncHandler((req, res) => {
      if (!ctx.site.isEnabled('deposits')) {
        throw new AppError('NOT_AVAILABLE', 503, 'Deposit sedang dinonaktifkan');
      }
      const body = parseInput(manualDepositSchema, req.body);
      const deposit = ctx.deposits.createManual(userId(req), body, clientIp(req));
      res.status(201).json({ deposit, simulation: true, label: 'SIMULASI' });
    }),
  );

  router.get(
    '/deposits',
    requireAuth,
    asyncHandler((req, res) => {
      res.json({ deposits: ctx.deposits.listForUser(userId(req)), simulation: true, label: 'SIMULASI' });
    }),
  );

  router.get(
    '/deposits/:id',
    requireAuth,
    asyncHandler((req, res) => {
      res.json({ deposit: ctx.deposits.getForUser(userId(req), req.params.id), simulation: true });
    }),
  );

  router.post(
    '/deposits/:id/check',
    requireAuth,
    asyncHandler(async (req, res) => {
      const deposit = await ctx.deposits.checkStatus(userId(req), req.params.id);
      res.json({ deposit, simulation: true, label: 'SIMULASI' });
    }),
  );

  router.get(
    '/withdrawals/quote',
    requireAuth,
    asyncHandler((req, res) => {
      const params = parseInput(
        z.object({ currency: currencyEnum.default('IDR'), amount: z.coerce.number().positive() }),
        req.query,
      );
      res.json({ ...ctx.withdrawals.quote(params.currency, params.amount), currency: params.currency });
    }),
  );

  router.post(
    '/withdrawals',
    requireAuth,
    asyncHandler((req, res) => {
      if (!ctx.site.isEnabled('withdrawals')) {
        throw new AppError('NOT_AVAILABLE', 503, 'Penarikan sedang dinonaktifkan');
      }
      const body = parseInput(withdrawalSchema, req.body);
      const withdrawal = ctx.withdrawals.request(
        userId(req),
        { ...body, idempotencyKey: idempotency(req) },
        clientIp(req),
      );
      res.status(201).json({ withdrawal, simulation: true, label: 'SIMULASI' });
    }),
  );

  router.get(
    '/withdrawals',
    requireAuth,
    asyncHandler((req, res) => {
      res.json({ withdrawals: ctx.withdrawals.listForUser(userId(req)), simulation: true });
    }),
  );

  router.get(
    '/withdrawals/:id',
    requireAuth,
    asyncHandler((req, res) => {
      res.json({
        withdrawal: ctx.withdrawals.getForUser(userId(req), req.params.id),
        events: ctx.withdrawals.events(req.params.id),
        simulation: true,
      });
    }),
  );

  router.post(
    '/withdrawals/:id/cancel',
    requireAuth,
    asyncHandler((req, res) => {
      const withdrawal = ctx.withdrawals.cancel(userId(req), req.params.id, clientIp(req));
      res.json({ withdrawal, simulation: true });
    }),
  );

  /** Unified money history used by /transactions. */
  router.get(
    '/transactions',
    requireAuth,
    asyncHandler((req, res) => {
      const query = parseInput(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(40),
          currency: currencyEnum.optional(),
          kind: z.enum(['all', 'deposit', 'withdrawal', 'ledger']).default('all'),
        }),
        req.query,
      );
      const account = userId(req);
      const ledger = ctx.ledger.list({ userId: account, limit: query.limit, currency: query.currency }).map((row) => ({
        id: row.id,
        currency: row.currency,
        kind: row.kind,
        direction: row.direction,
        amount: toMajor(Number(row.amount_minor), row.currency),
        amountMinor: Number(row.amount_minor),
        balanceAfter: toMajor(Number(row.balance_after_minor), row.currency),
        balanceAfterMinor: Number(row.balance_after_minor),
        refType: row.ref_type,
        refId: row.ref_id,
        note: (() => {
          try {
            return (JSON.parse(row.meta ?? '{}') as { note?: string }).note ?? null;
          } catch {
            return null;
          }
        })(),
        createdAt: Number(row.created_at),
      }));
      const deposits = ctx.deposits.listForUser(account, { limit: query.limit });
      const withdrawals = ctx.withdrawals.listForUser(account, query.limit);
      res.json({
        ledger,
        deposits: query.kind === 'ledger' ? [] : deposits,
        withdrawals: query.kind === 'ledger' ? [] : withdrawals,
        wallets: ctx.wallets.balances(account),
        simulation: true,
        label: 'SIMULASI',
      });
    }),
  );

  return router;
}
