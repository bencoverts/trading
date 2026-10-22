import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import { toPublicUser } from '../services/users.js';
import { recordAudit } from '../services/audit.js';
import { toMajor } from '../domain/money.js';

const registerSchema = z.object({
  email: z.string().email().max(254),
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9_.-]+$/, 'username may contain letters, digits, dot, dash and underscore'),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  identifier: z.string().min(3).max(254).optional(),
  email: z.string().min(3).max(254).optional(),
  password: z.string().min(1).max(128),
});

const tokenSchema = z.object({ token: z.string().min(10).max(2048) });
const resetSchema = z.object({ token: z.string().min(10).max(2048), password: z.string().min(8).max(128) });

export function authRoutes(ctx: AppContext, requireAuth: import('express').RequestHandler): Router {
  const router = Router();

  const setSessionCookie = (res: import('express').Response, token: string) => {
    res.cookie(ctx.config.COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.COOKIE_SECURE,
      path: '/',
      maxAge: ctx.config.SESSION_TTL_SEC * 1000,
    });
  };

  const walletPayload = (userId: string) =>
    ctx.wallets.balances(userId).map((w) => ({ ...w, display: toMajor(w.balanceMinor, w.currency) }));

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const body = parseInput(registerSchema, req.body);
      const user = await ctx.users.register({ ...body, ip: clientIp(req) });
      const token = ctx.users.signSession(user);
      setSessionCookie(res, token);
      res.status(201).json({
        user: toPublicUser(user),
        wallets: walletPayload(user.id),
        token,
        simulation: true,
        /** dev only: the verification link that was "emailed" */
        devVerificationLink: ctx.config.DEV_EMAIL_LINKS ? ctx.users.devLinkFor(user.email) : undefined,
      });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const body = parseInput(loginSchema, req.body);
      const identifier = body.identifier ?? body.email;
      if (!identifier) throw AppError.badRequest('identifier (email or username) is required');
      const user = ctx.users.findByIdentifier(identifier);
      if (!user || !(await ctx.users.verifyPassword(user, body.password))) {
        throw new AppError('INVALID_CREDENTIALS', 401, 'Email/username or password is incorrect');
      }
      if (user.blocked_at) {
        throw new AppError('ACCOUNT_BLOCKED', 403, 'This account is blocked', { reason: user.blocked_reason });
      }
      const token = ctx.users.signSession(user);
      setSessionCookie(res, token);
      recordAudit(ctx.db, {
        actorUserId: user.id,
        actorRole: user.role,
        action: 'user.logged_in',
        targetType: 'user',
        targetId: user.id,
        ip: clientIp(req),
        now: ctx.clock.now(),
      });
      res.json({ user: toPublicUser(user), wallets: walletPayload(user.id), token, simulation: true });
    }),
  );

  router.post(
    '/logout',
    requireAuth,
    asyncHandler((req, res) => {
      res.clearCookie(ctx.config.COOKIE_NAME, { path: '/' });
      res.json({ ok: true });
    }),
  );

  router.post(
    '/verify-email',
    asyncHandler((req, res) => {
      const body = parseInput(tokenSchema, req.body);
      const user = ctx.users.verifyEmail(body.token);
      res.json({ user, ok: true });
    }),
  );

  router.post(
    '/forgot-password',
    asyncHandler((req, res) => {
      const body = parseInput(z.object({ email: z.string().email() }), req.body);
      const result = ctx.users.requestPasswordReset(body.email, clientIp(req));
      res.json({
        ok: true,
        message: 'If that email exists, a reset link has been sent.',
        devResetLink: ctx.config.DEV_EMAIL_LINKS ? result.devLink : undefined,
      });
    }),
  );

  router.post(
    '/reset-password',
    asyncHandler(async (req, res) => {
      const body = parseInput(resetSchema, req.body);
      await ctx.users.resetPassword(body.token, body.password);
      res.json({ ok: true, message: 'Password updated, please sign in again.' });
    }),
  );

  /** Development-only convenience so the demo can complete email flows without a mail server. */
  router.get(
    '/dev/link',
    asyncHandler((req, res) => {
      if (!ctx.config.DEV_EMAIL_LINKS) throw AppError.notFound('Not found');
      const email = parseInput(z.string().email(), req.query.email);
      const link = ctx.users.devLinkFor(email);
      res.json({ email, link });
    }),
  );

  return router;
}
