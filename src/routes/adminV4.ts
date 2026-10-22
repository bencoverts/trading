import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import { CURRENCY_LIST, type Currency } from '../domain/constants.js';
import type { Permission } from '../auth/permissions.js';
import type { AuthedRequest } from '../http/session.js';

const currencyEnum = z.enum(CURRENCY_LIST as [Currency, ...Currency[]]);
const currencyPatch = z
  .object({
    name: z.string().min(2).max(40).optional(),
    symbol: z.string().min(1).max(4).optional(),
    active: z.boolean().optional(),
    depositEnabled: z.boolean().optional(),
    withdrawalEnabled: z.boolean().optional(),
    tradingEnabled: z.boolean().optional(),
    minDeposit: z.number().min(0).nullable().optional(),
    maxDeposit: z.number().positive().nullable().optional(),
    minWithdrawal: z.number().min(0).nullable().optional(),
    maxWithdrawal: z.number().positive().nullable().optional(),
    withdrawalFee: z.number().min(0).max(1_000_000).optional(),
    withdrawalFeeBps: z.number().int().min(0).max(2000).optional(),
    fxRateToIdr: z.number().positive().nullable().optional(),
    fxSource: z.string().max(80).nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Admin endpoints added in v4: currencies, deposits, withdrawals, KlikQRIS
 * operations, site configuration, feature flags and live chat. Every route is
 * guarded by a permission that is checked on the server.
 */
export function adminV4Routes(
  ctx: AppContext,
  guard: (...permissions: Permission[]) => RequestHandler,
  requireStaff: RequestHandler,
): Router {
  const router = Router();
  const actorId = (req: unknown) => (req as AuthedRequest).auth!.userId;

  router.use(requireStaff);

  // -------------------------------------------------------------- currencies
  router.get(
    '/currencies',
    guard('finance.read'),
    asyncHandler((_req, res) => {
      res.json({
        currencies: ctx.currencies.list({ includeInactive: true }),
        simulation: true,
      });
    }),
  );

  router.patch(
    '/currencies/:code',
    guard('currencies.write'),
    asyncHandler((req, res) => {
      const body = parseInput(currencyPatch, req.body);
      const currency = ctx.currencies.update(req.params.code, body, {
        actorUserId: actorId(req),
        ip: clientIp(req),
      });
      res.json({ currency, simulation: true });
    }),
  );

  // ---------------------------------------------------------------- deposits
  const depositFilters = z.object({
    status: z.string().max(20).optional(),
    currency: currencyEnum.optional(),
    userId: z.string().max(64).optional(),
    query: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  router.get(
    '/deposits',
    guard('deposits.read'),
    asyncHandler((req, res) => {
      const query = parseInput(depositFilters, req.query);
      res.json({ ...ctx.deposits.listAll(query), stats: ctx.deposits.stats(), simulation: true });
    }),
  );

  router.get(
    '/deposits/:id',
    guard('deposits.read'),
    asyncHandler((req, res) => {
      const row = ctx.db.get<{ id: string }>('SELECT id FROM payment_deposits WHERE id = ?', req.params.id);
      if (!row) throw AppError.notFound('Deposit tidak ditemukan');
      const list = ctx.deposits.listAll({ query: req.params.id, limit: 1 });
      res.json({
        deposit: list.items[0] ?? null,
        callbacks: ctx.db.all(
          'SELECT * FROM payment_callbacks WHERE deposit_id = ? ORDER BY id DESC LIMIT 50',
          req.params.id,
        ),
        simulation: true,
      });
    }),
  );

  router.post(
    '/deposits/:id/review',
    guard('deposits.review'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({ action: z.enum(['approve', 'reject']), reason: z.string().max(300).optional() }),
        req.body,
      );
      const deposit = ctx.deposits.reviewManual(req.params.id, body.action, {
        actorUserId: actorId(req),
        reason: body.reason,
        ip: clientIp(req),
      });
      res.json({ deposit, simulation: true });
    }),
  );

  // ------------------------------------------------------------- withdrawals
  const withdrawalFilters = z.object({
    status: z.string().max(20).optional(),
    currency: currencyEnum.optional(),
    query: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  router.get(
    '/withdrawals',
    guard('withdrawals.read'),
    asyncHandler((req, res) => {
      const query = parseInput(withdrawalFilters, req.query);
      res.json({ ...ctx.withdrawals.listAll(query), stats: ctx.withdrawals.stats(), simulation: true });
    }),
  );

  router.get(
    '/withdrawals/export.csv',
    guard('withdrawals.read'),
    asyncHandler((req, res) => {
      const query = parseInput(withdrawalFilters, req.query);
      const rows = ctx.withdrawals.listAll({ ...query, limit: 200, offset: 0 }).items;
      const header = [
        'id',
        'created_at',
        'currency',
        'amount',
        'fee',
        'net',
        'status',
        'method',
        'destination',
        'transfer_ref',
      ];
      const csv = [
        header.join(','),
        ...rows.map((row) =>
          [
            row.id,
            new Date(row.createdAt).toISOString(),
            row.currency,
            row.amount,
            row.fee,
            row.net,
            row.status,
            row.method,
            row.destinationMasked,
            row.transferRef ?? '',
          ]
            .map(csvCell)
            .join(','),
        ),
      ].join('\n');
      res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="withdrawals.csv"').send(csv);
    }),
  );

  router.get(
    '/withdrawals/:id',
    guard('withdrawals.read'),
    asyncHandler((req, res) => {
      const list = ctx.withdrawals.listAll({ query: req.params.id, limit: 1 });
      if (!list.items.length) throw AppError.notFound('Penarikan tidak ditemukan');
      res.json({
        withdrawal: list.items[0],
        events: ctx.withdrawals.events(req.params.id),
        simulation: true,
      });
    }),
  );

  router.post(
    '/withdrawals/:id/transition',
    guard('withdrawals.process'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          action: z.enum(['review', 'approve', 'process', 'complete', 'reject']),
          reason: z.string().max(300).optional(),
          transferRef: z.string().max(120).optional(),
          proofPath: z
            .string()
            .max(300)
            .regex(/^\/uploads\/[A-Za-z0-9/_.-]+$/)
            .optional(),
        }),
        req.body,
      );
      const withdrawal = ctx.withdrawals.transition(req.params.id, body.action, {
        actorUserId: actorId(req),
        reason: body.reason,
        transferRef: body.transferRef,
        proofPath: body.proofPath,
        ip: clientIp(req),
      });
      res.json({ withdrawal, simulation: true });
    }),
  );

  // ---------------------------------------------------------------- payments
  router.get(
    '/payments',
    guard('payments.read'),
    asyncHandler((_req, res) => {
      const statuses = ctx.deposits.stats();
      res.json({
        provider: ctx.payments.describe(),
        providers: ctx.payments.listProviders(),
        stats: {
          deposits: statuses,
          withdrawals: ctx.withdrawals.stats(),
          callbacks: Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payment_callbacks')?.n ?? 0),
          rejectedCallbacks: Number(
            ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payment_callbacks WHERE accepted = 0')?.n ?? 0,
          ),
        },
        webhook: {
          path: '/api/webhooks/klikqris',
          signatureHeader: ctx.config.KLIKQRIS_SIGNATURE_HEADER,
          configured: ctx.deposits.client.configured,
        },
        callbacks: ctx.deposits.callbacks(20),
        simulation: true,
      });
    }),
  );

  router.post(
    '/payments/test-connection',
    guard('payments.write'),
    asyncHandler(async (_req, res) => {
      const result = await ctx.payments.testConnection();
      res.status(result.ok ? 200 : 502).json({ ...result, simulation: true });
    }),
  );

  router.post(
    '/payments/reconcile',
    guard('payments.write'),
    asyncHandler(async (_req, res) => {
      const result = await ctx.deposits.reconcile();
      res.json({ ...result, simulation: true });
    }),
  );

  router.get(
    '/payments/callbacks',
    guard('payments.read'),
    asyncHandler((req, res) => {
      const limit = parseInput(z.coerce.number().int().min(1).max(500).default(100), req.query.limit);
      res.json({ callbacks: ctx.deposits.callbacks(limit), simulation: true });
    }),
  );

  // -------------------------------------------------------------- site config
  router.get(
    '/site',
    guard('settings.read'),
    asyncHandler((_req, res) => {
      res.json({ site: ctx.site.get(), flags: ctx.site.flags(), simulation: true });
    }),
  );

  router.patch(
    '/site',
    guard('site.write'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z
          .object({
            branding: z
              .object({
                name: z.string().min(2).max(60).optional(),
                description: z.string().max(300).optional(),
                logoUrl: z
                  .string()
                  .max(300)
                  .regex(/^\/uploads\/[A-Za-z0-9/_.-]+$/)
                  .nullable()
                  .optional(),
                faviconUrl: z
                  .string()
                  .max(300)
                  .regex(/^\/uploads\/[A-Za-z0-9/_.-]+$/)
                  .nullable()
                  .optional(),
                accent: z
                  .string()
                  .regex(/^#[0-9a-fA-F]{6}$/)
                  .optional(),
                contactEmail: z.string().email().nullable().optional(),
                social: z.record(z.string().max(200)).optional(),
              })
              .strict()
              .optional(),
            landing: z
              .object({
                heroTitle: z.string().min(4).max(120).optional(),
                heroSubtitle: z.string().min(4).max(400).optional(),
                ctaPrimary: z.string().min(2).max(40).optional(),
                ctaSecondary: z.string().min(2).max(40).optional(),
                features: z
                  .array(z.object({ title: z.string().max(80), body: z.string().max(240) }))
                  .max(8)
                  .optional(),
                faq: z
                  .array(z.object({ question: z.string().max(160), answer: z.string().max(600) }))
                  .max(12)
                  .optional(),
              })
              .strict()
              .optional(),
            seo: z
              .object({
                title: z.string().min(4).max(120).optional(),
                description: z.string().max(300).optional(),
                keywords: z.array(z.string().max(40)).max(12).optional(),
                ogImage: z
                  .string()
                  .max(300)
                  .regex(/^\/uploads\/[A-Za-z0-9/_.-]+$/)
                  .nullable()
                  .optional(),
              })
              .strict()
              .optional(),
            legal: z
              .object({
                riskWarning: z.string().max(1000).optional(),
                termsSlug: z.string().max(40).optional(),
                privacySlug: z.string().max(40).optional(),
              })
              .strict()
              .optional(),
            maintenance: z
              .object({
                enabled: z.boolean().optional(),
                message: z.string().max(300).optional(),
                allowStaff: z.boolean().optional(),
              })
              .strict()
              .optional(),
            email: z
              .object({ fromName: z.string().max(60).optional(), fromEmail: z.string().email().nullable().optional() })
              .strict()
              .optional(),
          })
          .strict(),
        req.body,
      );
      const site = ctx.site.update(body, { actorUserId: actorId(req), ip: clientIp(req) });
      res.json({ site, simulation: true });
    }),
  );

  router.patch(
    '/site/flags/:key',
    guard('flags.write'),
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ enabled: z.boolean() }), req.body);
      ctx.site.setFlag(req.params.key, body.enabled, { actorUserId: actorId(req), ip: clientIp(req) });
      res.json({ flags: ctx.site.flags(), simulation: true });
    }),
  );

  // -------------------------------------------------------------------- chat
  router.get(
    '/chat',
    guard('chat.read'),
    asyncHandler((req, res) => {
      const query = parseInput(
        z.object({ status: z.string().max(20).optional(), query: z.string().max(120).optional() }),
        req.query,
      );
      res.json({ conversations: ctx.chat.listAll(query), simulation: true });
    }),
  );

  router.get(
    '/chat/:id',
    guard('chat.read'),
    asyncHandler((req, res) => {
      res.json({
        conversation: ctx.chat.listAll().find((item) => item.id === req.params.id) ?? null,
        messages: ctx.chat.messagesForStaff(req.params.id),
        simulation: true,
      });
    }),
  );

  router.post(
    '/chat/:id/messages',
    guard('chat.write'),
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          body: z.string().trim().max(2_000).default(''),
          internal: z.boolean().default(false),
          clientId: z.string().trim().max(80).optional(),
          attachmentUrl: z
            .string()
            .max(300)
            .regex(/^\/uploads\/[A-Za-z0-9/_.-]+$/)
            .optional(),
        }),
        req.body,
      );
      const result = ctx.chat.send({
        conversationId: req.params.id,
        staffUserId: actorId(req),
        body: body.body,
        internal: body.internal,
        clientId: body.clientId,
        attachmentPath: body.attachmentUrl,
      });
      res.status(201).json({ ...result, simulation: true });
    }),
  );

  router.post(
    '/chat/:id/status',
    guard('chat.write'),
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ status: z.enum(['open', 'pending', 'closed']) }), req.body);
      res.json({ conversation: ctx.chat.setStatus(req.params.id, body.status, { actorUserId: actorId(req) }) });
    }),
  );

  router.post(
    '/chat/:id/assign',
    guard('chat.write'),
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ userId: z.string().max(64).nullable() }), req.body);
      res.json({ conversation: ctx.chat.assign(req.params.id, body.userId) });
    }),
  );

  router.post(
    '/chat/:id/priority',
    guard('chat.write'),
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ priority: z.enum(['low', 'normal', 'high']) }), req.body);
      res.json({ conversation: ctx.chat.setPriority(req.params.id, body.priority) });
    }),
  );

  // ------------------------------------------------------------------ ledger
  router.get(
    '/ledger',
    guard('finance.read'),
    asyncHandler((req, res) => {
      const query = parseInput(
        z.object({
          userId: z.string().max(64).optional(),
          currency: currencyEnum.optional(),
          kind: z.string().max(40).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        req.query,
      );
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (query.userId) {
        where.push('l.user_id = ?');
        params.push(query.userId);
      }
      if (query.currency) {
        where.push('l.currency = ?');
        params.push(query.currency);
      }
      if (query.kind) {
        where.push('l.kind = ?');
        params.push(query.kind);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = ctx.db.all(
        `SELECT l.*, u.email AS user_email FROM ledger l JOIN users u ON u.id = l.user_id
         ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
        ...params,
        query.limit,
        query.offset,
      );
      res.json({ entries: rows, totals: ctx.ledger.totalsPerCurrency(), locked: ctx.wallets.lockedTotals() });
    }),
  );

  router.get(
    '/ledger/export.csv',
    guard('finance.read'),
    asyncHandler((req, res) => {
      const query = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(5000).default(1000) }), req.query);
      const rows = ctx.db.all<Record<string, unknown>>(
        `SELECT l.*, u.email AS user_email FROM ledger l JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?`,
        query.limit,
      );
      const header = [
        'id',
        'created_at',
        'user_email',
        'currency',
        'kind',
        'direction',
        'amount_minor',
        'balance_after_minor',
        'ref_type',
        'ref_id',
      ];
      const csv = [
        header.join(','),
        ...rows.map((row) =>
          header
            .map((key) => csvCell(key === 'created_at' ? new Date(Number(row[key])).toISOString() : row[key]))
            .join(','),
        ),
      ].join('\n');
      res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="ledger.csv"').send(csv);
    }),
  );

  return router;
}
