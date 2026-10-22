import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import { CURRENCY_LIST, LANGUAGES, type Currency } from '../domain/constants.js';
import { toMajor } from '../domain/money.js';
import { toPublicUser } from '../services/users.js';
import { recordAudit } from '../services/audit.js';
import { csrfTokenFor } from '../http/session.js';

const currencyEnum = z.enum(CURRENCY_LIST as [Currency, ...Currency[]]);

const topupSchema = z.object({
  currency: currencyEnum,
  /** major units; the server converts to minor units with the currency scale */
  amount: z.number().positive().max(1_000_000_000),
});

const convertSchema = z.object({
  from: currencyEnum,
  to: currencyEnum,
  amount: z.number().positive().max(1_000_000_000),
});

export function accountRoutes(ctx: AppContext, requireAuth: RequestHandler, optionalAuth: RequestHandler): Router {
  const router = Router();

  const wallets = (userId: string) =>
    ctx.wallets.balances(userId).map((w) => ({
      currency: w.currency,
      balance: w.balance,
      balanceMinor: w.balanceMinor,
      locked: w.locked,
      lockedMinor: w.lockedMinor,
      available: w.available,
      availableMinor: w.availableMinor,
      display: w.available,
      active: ctx.currencies.get(w.currency).active === 1,
      depositEnabled: ctx.currencies.get(w.currency).deposit_enabled === 1,
      withdrawalEnabled: ctx.currencies.get(w.currency).withdrawal_enabled === 1,
    }));

  const cooldowns = (userId: string) => {
    const settings = ctx.settings.get();
    const last = (kind: string) =>
      Number(
        ctx.db.get<{ created_at: number | null }>(
          'SELECT MAX(created_at) AS created_at FROM ledger WHERE user_id = ? AND kind = ?',
          userId,
          kind,
        )?.created_at ?? 0,
      );
    const topupAt = last('demo_topup');
    const resetAt = last('demo_reset');
    return {
      topupNextAt: settings.topupCooldownSec > 0 && topupAt ? topupAt + settings.topupCooldownSec * 1000 : 0,
      resetNextAt: settings.resetCooldownSec > 0 && resetAt ? resetAt + settings.resetCooldownSec * 1000 : 0,
    };
  };

  const profile = (userId: string) => {
    const user = ctx.users.findById(userId);
    if (!user) throw AppError.unauthorized('User tidak lagi ada');
    const settings = ctx.settings.get();
    return {
      user: toPublicUser(user),
      wallets: wallets(userId),
      limits: {
        minAmount: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.minAmount[c], c)])),
        maxAmount: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.maxAmount[c], c)])),
        topupMax: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.topupMax[c], c)])),
        topupDailyCount: settings.topupDailyCount,
        maxOpenTrades: settings.maxOpenTrades,
        maxOpenTradesPerUser: settings.maxOpenTradesPerUser,
        globalMaxAmountUsd: toMajor(settings.globalMaxAmountUsdMinor, 'USD'),
      },
      cooldowns: cooldowns(userId),
      rates: settings.rates,
      payout: { rate: settings.payoutRate, byDuration: settings.payoutByDuration, mode: settings.payoutMode },
      favorites: favoritesOf(userId),
      openTrades: ctx.trades.countOpen(userId),
      sessionCount: ctx.accounts.countActive(userId),
      simulation: true,
      label: 'SIMULASI',
    };
  };

  const favoritesOf = (userId: string): string[] =>
    ctx.db
      .all<{ market: string }>('SELECT market FROM favorites WHERE user_id = ? ORDER BY created_at ASC', userId)
      .map((row) => row.market);

  router.get(
    '/account',
    requireAuth,
    asyncHandler((req, res) => {
      res.json(profile(req.auth!.userId));
    }),
  );

  router.patch(
    '/account',
    requireAuth,
    asyncHandler((req, res) => {
      const body = parseInput(
        z.object({
          displayName: z.string().min(2).max(40).nullish(),
          language: z.enum(LANGUAGES as unknown as [string, ...string[]]).optional(),
          timezone: z.string().min(3).max(64).optional(),
          displayCurrency: currencyEnum.optional(),
        }),
        req.body,
      );
      if (body.displayCurrency) {
        const locked = ctx.trades.lockedCurrency(req.auth!.userId);
        if (locked && locked !== body.displayCurrency) {
          throw new AppError(
            'CURRENCY_LOCKED',
            409,
            `Mata uang tidak bisa diganti saat masih ada trade terbuka (${locked})`,
            { lockedCurrency: locked },
          );
        }
      }
      const user = ctx.users.updateProfile(req.auth!.userId, {
        displayName: body.displayName,
        language: body.language as 'id' | 'en' | undefined,
        timezone: body.timezone,
        displayCurrency: body.displayCurrency,
      });
      res.json({ user, simulation: true });
    }),
  );

  // ------------------------------------------------------------- avatar
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ctx.config.MAX_UPLOAD_BYTES } });

  router.post(
    '/account/avatar',
    requireAuth,
    upload.single('file'),
    asyncHandler((req, res) => {
      if (!req.file) throw new AppError('UPLOAD_INVALID', 400, 'File avatar wajib diunggah (field "file")');
      const stored = ctx.uploads.store(req.file.buffer, { folder: 'avatars', maxBytes: ctx.config.MAX_UPLOAD_BYTES });
      const previous = ctx.users.findById(req.auth!.userId)?.avatar_path ?? null;
      const user = ctx.users.updateProfile(req.auth!.userId, { avatarPath: stored.relativePath });
      if (previous) ctx.uploads.remove(previous);
      recordAudit(ctx.db, {
        actorUserId: req.auth!.userId,
        actorRole: 'user',
        action: 'user.avatar_changed',
        targetType: 'user',
        targetId: req.auth!.userId,
        meta: { path: stored.relativePath, bytes: stored.bytes },
        now: ctx.clock.now(),
      });
      res.status(201).json({ user, avatarUrl: stored.url });
    }),
  );

  router.delete(
    '/account/avatar',
    requireAuth,
    asyncHandler((req, res) => {
      const previous = ctx.users.findById(req.auth!.userId)?.avatar_path ?? null;
      if (previous) ctx.uploads.remove(previous);
      const user = ctx.users.updateProfile(req.auth!.userId, { avatarPath: null });
      res.json({ user });
    }),
  );

  router.post(
    '/account/password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = parseInput(
        z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(8).max(128) }),
        req.body,
      );
      const currentSession = req.auth!.sessionId;
      await ctx.users.changePassword(req.auth!.userId, body.currentPassword, body.newPassword);
      // the password change bumps token_version: this device gets a fresh session
      ctx.accounts.revokeAll(req.auth!.userId, 'password_changed', currentSession);
      const user = ctx.users.findById(req.auth!.userId);
      if (!user) throw AppError.unauthorized('User tidak ditemukan');
      const session = ctx.accounts.create({
        userId: user.id,
        tokenVersion: user.token_version,
        ttlMs: ctx.config.SESSION_TTL_SEC * 1000,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      });
      const token = ctx.tokens.sign({ sub: user.id, sid: session.id, v: user.token_version });
      // the CSRF token is bound to the session id, so it must rotate with it
      res.cookie(ctx.config.CSRF_COOKIE, csrfTokenFor(ctx, session.id), {
        httpOnly: false,
        sameSite: 'lax',
        secure: ctx.config.COOKIE_SECURE,
        path: '/',
        maxAge: ctx.config.SESSION_TTL_SEC * 1000,
      });
      res.cookie(ctx.config.COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.config.COOKIE_SECURE,
        path: '/',
        maxAge: ctx.config.SESSION_TTL_SEC * 1000,
      });
      res.json({ ok: true, message: 'Password diperbarui' });
    }),
  );

  /** Reset every demo wallet to the configured starting balance (with cooldown). */
  router.post(
    '/account/reset',
    requireAuth,
    asyncHandler((req, res) => {
      const userId = req.auth!.userId;
      const open = ctx.db.all<{ id: string }>(`SELECT id FROM trades WHERE user_id = ? AND status = 'open'`, userId);
      for (const trade of open) {
        // full refund at the entry price: the reset must be predictable
        ctx.trades.voidAtEntry(trade.id, 'reset saldo demo', userId, clientIp(req));
      }
      const result = ctx.wallets.resetAll(userId, clientIp(req));
      recordAudit(ctx.db, {
        actorUserId: userId,
        actorRole: 'user',
        action: 'account.reset',
        targetType: 'user',
        targetId: userId,
        meta: { balances: result.wallets.map((w) => w.balanceMinor), voidedTrades: open.length },
        ip: clientIp(req),
        now: ctx.clock.now(),
      });
      ctx.realtime?.sendToUser(userId, { type: 'account:reset', wallets: result.wallets });
      res.json({
        wallets: wallets(userId),
        voidedTrades: open.length,
        nextAllowedAt: result.nextAllowedAt,
        simulation: true,
      });
    }),
  );

  // --------------------------------------------------------------- wallets
  router.get(
    '/wallet',
    requireAuth,
    asyncHandler((req, res) => {
      const settings = ctx.settings.get();
      res.json({
        wallets: wallets(req.auth!.userId),
        rates: settings.rates,
        cooldowns: cooldowns(req.auth!.userId),
        limits: {
          topupMax: Object.fromEntries(CURRENCY_LIST.map((c) => [c, toMajor(settings.topupMax[c], c)])),
          topupDailyCount: settings.topupDailyCount,
          topupCooldownSec: settings.topupCooldownSec,
          resetCooldownSec: settings.resetCooldownSec,
        },
        lockedCurrency: ctx.trades.lockedCurrency(req.auth!.userId),
        simulation: true,
      });
    }),
  );

  /** Instant DEMO top-up (virtual money, capped per transaction and per day). */
  router.post(
    '/wallet/topup',
    requireAuth,
    asyncHandler((req, res) => {
      const body = parseInput(topupSchema, req.body);
      const amountMinor = Math.round(body.amount * (body.currency === 'IDR' ? 1 : 100));
      if (amountMinor <= 0) throw AppError.badRequest('Nominal terlalu kecil');
      const result = ctx.wallets.topUp(req.auth!.userId, body.currency, amountMinor, clientIp(req));
      ctx.realtime?.sendToUser(req.auth!.userId, { type: 'balance', wallets: wallets(req.auth!.userId) });
      res.status(201).json({
        wallet: result.wallet,
        wallets: wallets(req.auth!.userId),
        nextAllowedAt: result.nextAllowedAt,
        simulation: true,
        message: 'Saldo demo ditambah (uang virtual)',
      });
    }),
  );

  router.post(
    '/wallet/convert',
    requireAuth,
    asyncHandler((req, res) => {
      const body = parseInput(convertSchema, req.body);
      if (body.from === body.to)
        throw new AppError('CONVERSION_INVALID', 400, 'Mata uang asal dan tujuan harus berbeda');
      const fromMinor = Math.round(body.amount * (body.from === 'IDR' ? 1 : 100));
      if (fromMinor <= 0) throw new AppError('CONVERSION_INVALID', 400, 'Nominal terlalu kecil');
      const result = ctx.wallets.convert(req.auth!.userId, body.from, body.to, fromMinor);
      ctx.realtime?.sendToUser(req.auth!.userId, { type: 'balance', wallets: wallets(req.auth!.userId) });
      res.status(201).json({
        from: result.from,
        to: result.to,
        rate: result.rate,
        wallets: wallets(req.auth!.userId),
        simulation: true,
      });
    }),
  );

  router.get(
    '/wallet/transactions',
    requireAuth,
    asyncHandler((req, res) => {
      const q = parseInput(
        z.object({
          currency: currencyEnum.optional(),
          kind: z.string().max(40).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        req.query,
      );
      const rows = ctx.ledger.list({ userId: req.auth!.userId, ...q });
      res.json({
        transactions: rows.map((entry) => ({
          id: entry.id,
          currency: entry.currency,
          kind: entry.kind,
          direction: entry.direction,
          amount: toMajor(Number(entry.amount_minor), entry.currency),
          amountMinor: Number(entry.amount_minor),
          balanceAfter: toMajor(Number(entry.balance_after_minor), entry.currency),
          refType: entry.ref_type,
          refId: entry.ref_id,
          note: entry.meta ? ((JSON.parse(entry.meta) as { note?: string }).note ?? null) : null,
          createdAt: Number(entry.created_at),
        })),
        total: rows.length,
      });
    }),
  );

  router.get(
    '/wallet/conversions',
    requireAuth,
    asyncHandler((req, res) => {
      const rows = ctx.db.all<{
        id: string;
        from_currency: Currency;
        to_currency: Currency;
        from_minor: number;
        to_minor: number;
        rate: number;
        created_at: number;
      }>('SELECT * FROM conversions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', req.auth!.userId);
      res.json({
        conversions: rows.map((row) => ({
          id: row.id,
          from: row.from_currency,
          to: row.to_currency,
          fromAmount: toMajor(Number(row.from_minor), row.from_currency),
          toAmount: toMajor(Number(row.to_minor), row.to_currency),
          rate: Number(row.rate),
          createdAt: Number(row.created_at),
        })),
      });
    }),
  );

  // --------------------------------------------------------- favourites
  router.get(
    '/favorites',
    requireAuth,
    asyncHandler((req, res) => {
      res.json({ favorites: favoritesOf(req.auth!.userId) });
    }),
  );

  router.put(
    '/favorites',
    requireAuth,
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ markets: z.array(z.string().min(1).max(20)).max(50) }), req.body);
      const now = ctx.clock.now();
      const symbols = [...new Set(body.markets.map((s) => s.toUpperCase()))].filter((s) => Boolean(ctx.markets.row(s)));
      ctx.db.transaction(() => {
        ctx.db.run('DELETE FROM favorites WHERE user_id = ?', req.auth!.userId);
        for (const symbol of symbols) {
          ctx.db.run(
            'INSERT INTO favorites (user_id, market, created_at) VALUES (?, ?, ?)',
            req.auth!.userId,
            symbol,
            now,
          );
        }
      });
      res.json({ favorites: symbols });
    }),
  );

  router.post(
    '/favorites/:symbol',
    requireAuth,
    asyncHandler((req, res) => {
      const symbol = String(req.params.symbol).toUpperCase();
      if (!ctx.markets.row(symbol)) throw AppError.notFound(`Market tidak ditemukan: ${symbol}`, 'MARKET_NOT_FOUND');
      const existing = ctx.db.get(
        'SELECT 1 AS ok FROM favorites WHERE user_id = ? AND market = ?',
        req.auth!.userId,
        symbol,
      );
      if (existing) {
        ctx.db.run('DELETE FROM favorites WHERE user_id = ? AND market = ?', req.auth!.userId, symbol);
      } else {
        ctx.db.run(
          'INSERT INTO favorites (user_id, market, created_at) VALUES (?, ?, ?)',
          req.auth!.userId,
          symbol,
          ctx.clock.now(),
        );
      }
      res.json({ favorites: favoritesOf(req.auth!.userId) });
    }),
  );

  // ------------------------------------------------------ notifications
  router.get(
    '/notifications',
    optionalAuth,
    asyncHandler((req, res) => {
      if (!req.auth) {
        res.json({ items: [], unread: 0 });
        return;
      }
      const q = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
      res.json(ctx.notifications.list(req.auth!.userId, q.limit));
    }),
  );

  router.post(
    '/notifications/read',
    requireAuth,
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ id: z.union([z.string().max(64), z.literal('all')]) }), req.body);
      const changed = ctx.notifications.markRead(req.auth!.userId, body.id);
      res.json({ ok: true, changed, unread: ctx.notifications.list(req.auth!.userId, 1).unread });
    }),
  );

  return router;
}
