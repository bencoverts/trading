import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { AppError } from '../lib/errors.js';
import { asyncHandler, clientIp, parseInput } from '../http/validation.js';

const password = z.string().min(8, 'password must be at least 8 characters').max(128);
const registerSchema = z.object({ email: z.string().email().max(254), password });
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) });

export function authRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const body = parseInput(registerSchema, req.body);
      const user = await ctx.users.register({ email: body.email, password: body.password, ip: clientIp(req) });
      const token = ctx.tokens.sign({ sub: user.id, role: user.role });
      res.status(201).json({
        token,
        user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt },
        account: { balance: user.balance, balanceCents: user.balanceCents, currency: user.currency },
      });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const body = parseInput(loginSchema, req.body);
      const row = await ctx.users.verifyCredentials(body.email, body.password);
      if (!row) throw new AppError('INVALID_CREDENTIALS', 401, 'Email or password is incorrect');
      const token = ctx.tokens.sign({ sub: row.id, role: row.role });
      const user = await ctx.users.me(row.id);
      res.json({
        token,
        user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt },
        account: { balance: user.balance, balanceCents: user.balanceCents, currency: user.currency },
      });
    }),
  );

  return router;
}
