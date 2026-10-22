import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import { toPublicUser } from '../services/users.js';
import { recordAudit } from '../services/audit.js';
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUrl, verifyTotp } from '../auth/totp.js';
import {
  csrfTokenFor,
  ensureCsrfCookie,
  issueSession,
  clearSession,
  assertSameOrigin,
  type AuthedRequest,
} from '../http/session.js';
import { PERMISSION_MATRIX, permissionsFor } from '../auth/permissions.js';
import { LANGUAGES, type Language } from '../domain/constants.js';

const registerSchema = z.object({
  email: z.string().email().max(254),
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9_.-]+$/, 'username hanya boleh huruf, angka, titik, minus, dan garis bawah'),
  password: z.string().min(8).max(128),
  acceptTerms: z.boolean().refine((value) => value, 'Kamu harus menyetujui syarat dan ketentuan'),
  language: z.enum(LANGUAGES as unknown as [Language, ...Language[]]).default('id'),
});

const loginSchema = z.object({
  identifier: z.string().min(3).max(254),
  password: z.string().min(1).max(128),
  totpCode: z.string().min(6).max(20).optional(),
});

const tokenSchema = z.object({ token: z.string().min(10).max(2048) });
const resetSchema = z.object({ token: z.string().min(10).max(2048), password: z.string().min(8).max(128) });

export function authRoutes(ctx: AppContext): Router {
  const router = Router();

  const platformInfo = () => {
    const settings = ctx.settings.get();
    return {
      name: settings.platformName,
      logoUrl: settings.platformLogoPath ? `/uploads/${settings.platformLogoPath}` : null,
      accent: settings.themeAccent,
      disclaimer: settings.disclaimer,
      defaultLanguage: settings.defaultLanguage,
      defaultTimezone: settings.defaultTimezone,
    };
  };

  const walletPayload = (userId: string) => ctx.wallets.balances(userId);

  const sessionPayload = (userId: string, sessionId: string) => {
    const user = ctx.users.findById(userId);
    if (!user) throw AppError.unauthorized('User tidak ditemukan');
    return {
      user: toPublicUser(user),
      wallets: walletPayload(userId),
      csrfToken: csrfTokenFor(ctx, sessionId),
      permissions: permissionsFor(user.staff_role),
      platform: platformInfo(),
      simulation: true as const,
      label: 'SIMULASI',
    };
  };

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      assertSameOrigin(ctx, req);
      const body = parseInput(registerSchema, req.body);
      const user = await ctx.users.register({
        ...body,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      });
      const issued = issueSession(ctx, req, res, user.id);
      ctx.notifications.create({
        userId: user.id,
        kind: 'welcome',
        title: 'Selamat datang di SimTrade Demo',
        body: 'Semua saldo dan harga bersifat simulasi. Tidak ada uang sungguhan di platform ini.',
        link: '/faq',
      });
      res.status(201).json({
        ...sessionPayload(user.id, issued.sessionId),
        devVerificationLink: ctx.config.DEV_EMAIL_LINKS ? ctx.users.devLinkFor(user.email) : undefined,
      });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      assertSameOrigin(ctx, req);
      const body = parseInput(loginSchema, req.body);
      const result = await ctx.users.authenticate({
        identifier: body.identifier,
        password: body.password,
        totpCode: body.totpCode ?? null,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      });
      if (result.requiresTotp) {
        res.status(200).json({ totpRequired: true, message: 'Masukkan kode 2FA dari aplikasi authenticator' });
        return;
      }
      const issued = issueSession(ctx, req, res, result.user.id);
      recordAudit(ctx.db, {
        actorUserId: result.user.id,
        actorRole: result.user.role === 'admin' ? 'admin' : 'user',
        action: 'user.logged_in',
        targetType: 'user',
        targetId: result.user.id,
        ip: clientIp(req),
        now: ctx.clock.now(),
      });
      res.json(sessionPayload(result.user.id, issued.sessionId));
    }),
  );

  router.post(
    '/logout',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (auth) {
        ctx.accounts.revoke(auth.sessionId, 'logout');
        recordAudit(ctx.db, {
          actorUserId: auth.userId,
          actorRole: auth.role ? 'admin' : 'user',
          action: 'user.logged_out',
          targetType: 'session',
          targetId: auth.sessionId,
          ip: clientIp(req),
          now: ctx.clock.now(),
        });
      }
      clearSession(ctx, res);
      res.json({ ok: true, simulation: true });
    }),
  );

  router.get(
    '/me',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) {
        res.json({
          user: null,
          wallets: [],
          permissions: [],
          simulation: true,
          label: 'SIMULASI',
          csrfToken: ensureCsrfCookie(ctx, req, res),
          platform: platformInfo(),
        });
        return;
      }
      res.json(sessionPayload(auth.userId, auth.sessionId));
    }),
  );

  router.get(
    '/csrf',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      res.json({
        csrfToken: auth ? csrfTokenFor(ctx, auth.sessionId) : ensureCsrfCookie(ctx, req, res),
        header: ctx.config.CSRF_HEADER,
        cookie: ctx.config.CSRF_COOKIE,
      });
    }),
  );

  router.get(
    '/permissions',
    asyncHandler((_req, res) => {
      res.json({ matrix: PERMISSION_MATRIX, simulation: true });
    }),
  );

  // --------------------------------------------------------------- sessions
  router.get(
    '/sessions',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
      res.json({ sessions: ctx.accounts.listForUser(auth.userId, auth.sessionId) });
    }),
  );

  router.delete(
    '/sessions/:id',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
      const owned = ctx.accounts.listForUser(auth.userId).some((session) => session.id === req.params.id);
      if (!owned) throw AppError.notFound('Sesi tidak ditemukan');
      if (req.params.id === auth.sessionId) throw AppError.badRequest('Gunakan tombol keluar untuk sesi ini');
      ctx.accounts.revoke(req.params.id, 'revoked_by_user');
      recordAudit(ctx.db, {
        actorUserId: auth.userId,
        actorRole: auth.role ? 'admin' : 'user',
        action: 'user.session_revoked',
        targetType: 'session',
        targetId: req.params.id,
        ip: clientIp(req),
        now: ctx.clock.now(),
      });
      res.json({ ok: true });
    }),
  );

  /** "Keluarkan perangkat lain": keeps this device, revokes the rest. */
  router.post(
    '/logout-all',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
      const revoked = ctx.accounts.revokeAll(auth.userId, 'logout_all', auth.sessionId);
      recordAudit(ctx.db, {
        actorUserId: auth.userId,
        actorRole: auth.role ? 'admin' : 'user',
        action: 'user.sessions_revoked',
        targetType: 'user',
        targetId: auth.userId,
        meta: { revoked },
        ip: clientIp(req),
        now: ctx.clock.now(),
      });
      res.json({ ok: true, revoked });
    }),
  );

  // ------------------------------------------------------------ email flows
  router.post(
    '/verify-email',
    asyncHandler((req, res) => {
      const body = parseInput(tokenSchema, req.body);
      const user = ctx.users.verifyEmail(body.token);
      ctx.notifications.create({
        userId: user.id,
        kind: 'email_verified',
        title: 'Email terverifikasi',
        body: 'Akun demo kamu kini terverifikasi.',
      });
      res.json({ user, ok: true, simulation: true });
    }),
  );

  router.post(
    '/resend-verification',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
      const result = ctx.users.resendVerification(auth.userId);
      res.json({
        ok: true,
        message: 'Tautan verifikasi baru sudah dibuat.',
        devVerificationLink: ctx.config.DEV_EMAIL_LINKS ? result.devLink : undefined,
      });
    }),
  );

  router.post(
    '/forgot-password',
    asyncHandler((req, res) => {
      assertSameOrigin(ctx, req);
      const body = parseInput(z.object({ email: z.string().email() }), req.body);
      const result = ctx.users.requestPasswordReset(body.email.toLowerCase(), clientIp(req));
      const devResetLink = ctx.config.DEV_EMAIL_LINKS ? result.devLink : null;
      res.json({
        ok: true,
        message: 'Kalau email itu terdaftar, tautan reset sudah dibuat.',
        ...(devResetLink ? { devResetLink } : {}),
      });
    }),
  );

  router.post(
    '/reset-password',
    asyncHandler(async (req, res) => {
      assertSameOrigin(ctx, req);
      const body = parseInput(resetSchema, req.body);
      const user = await ctx.users.resetPassword(body.token, body.password);
      ctx.accounts.revokeAll(user.id, 'password_reset');
      clearSession(ctx, res);
      res.json({ ok: true, message: 'Kata sandi diperbarui. Silakan masuk lagi.' });
    }),
  );

  // ------------------------------------------------------------------- 2FA
  router.post(
    '/2fa/setup',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
      const user = ctx.users.findById(auth.userId);
      if (!user) throw AppError.unauthorized('User tidak ditemukan');
      if (user.totp_enabled === 1) throw AppError.conflict('2FA sudah aktif', 'TOTP_ENABLED');
      const secret = generateTotpSecret();
      ctx.users.setPendingTotpSecret(user.id, secret);
      res.json({
        secret,
        otpauthUrl: otpauthUrl(ctx.config.TOTP_ISSUER, user.email, secret),
        issuer: ctx.config.TOTP_ISSUER,
      });
    }),
  );

  router.post(
    '/2fa/enable',
    asyncHandler((req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
      const body = parseInput(z.object({ code: z.string().min(6).max(6) }), req.body);
      const user = ctx.users.findById(auth.userId);
      if (!user?.totp_secret) throw AppError.badRequest('Mulai setup 2FA terlebih dahulu');
      if (!verifyTotp(user.totp_secret, body.code)) throw new AppError('INVALID_TOTP', 400, 'Kode 2FA tidak valid');
      const recoveryCodes = generateRecoveryCodes(8);
      ctx.users.enableTotp(user.id, user.totp_secret, recoveryCodes.map(hashRecoveryCode));
      res.json({ ok: true, recoveryCodes });
    }),
  );

  router.post(
    '/2fa/disable',
    asyncHandler(async (req, res) => {
      const auth = (req as AuthedRequest).auth;
      if (!auth) throw AppError.unauthorized('Silakan masuk terlebih dahulu');
      const body = parseInput(
        z.object({ password: z.string().min(1).max(128), code: z.string().min(6).max(20) }),
        req.body,
      );
      const user = ctx.users.findById(auth.userId);
      if (!user || user.totp_enabled !== 1 || !user.totp_secret) throw AppError.badRequest('2FA belum aktif');
      const ok = await ctx.users.verifyPassword(user, body.password);
      if (!ok) throw new AppError('INVALID_CREDENTIALS', 401, 'Kata sandi salah');
      if (!verifyTotp(user.totp_secret, body.code)) throw new AppError('INVALID_TOTP', 400, 'Kode 2FA tidak valid');
      ctx.users.disableTotp(user.id);
      res.json({ ok: true });
    }),
  );

  /** Demo convenience: reveal the latest email link without a mail server. */
  router.get(
    '/dev/link',
    asyncHandler((req, res) => {
      if (!ctx.config.DEV_EMAIL_LINKS) throw AppError.notFound('Not found');
      const email = parseInput(z.string().email(), req.query.email).toLowerCase();
      res.json({ email, link: ctx.users.devLinkFor(email) });
    }),
  );

  return router;
}
