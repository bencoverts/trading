import { Router } from 'express';
import type { AppContext } from '../app/context.js';
import { asyncHandler, clientIp } from '../http/validation.js';
import { AppError } from '../lib/errors.js';

/**
 * Provider callbacks.
 *
 * Only the backend processes payments. The signature header name is
 * configurable (`KLIKQRIS_SIGNATURE_HEADER`) because the provider's exact scheme
 * must be confirmed from their documentation; the HMAC input lives in
 * `KlikQrisClient.canonicalCallback`. Missing/unknown signatures are rejected
 * and logged, and the handler is idempotent by deposit status.
 */
export function webhookRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post(
    '/webhooks/klikqris',
    asyncHandler((req, res) => {
      const headerName = ctx.config.KLIKQRIS_SIGNATURE_HEADER.toLowerCase();
      const signature = req.header(headerName) ?? req.header('x-signature') ?? req.header('signature') ?? null;
      if (!signature) {
        throw new AppError('SIGNATURE_INVALID', 401, 'Header signature tidak ditemukan');
      }
      if (!ctx.deposits.client.configured) {
        throw new AppError('PAYMENT_NOT_CONFIGURED', 503, 'KlikQRIS belum dikonfigurasi');
      }
      const result = ctx.deposits.handleCallback({
        payload: (req.body ?? {}) as Record<string, unknown>,
        signature,
        ip: clientIp(req),
      });
      res.status(200).json({ ok: true, duplicate: result.duplicate, status: result.deposit.status });
    }),
  );

  /** Health probe for the admin "webhook status" card (no secrets). */
  router.get('/webhooks/klikqris', (_req, res) => {
    res.json({
      ok: true,
      provider: 'klikqris',
      configured: ctx.deposits.client.configured,
      signatureHeader: ctx.config.KLIKQRIS_SIGNATURE_HEADER,
      callbackUrl: ctx.config.KLIKQRIS_CALLBACK_URL ?? null,
    });
  });

  return router;
}
