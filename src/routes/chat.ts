import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import multer from 'multer';
import type { AppContext } from '../app/context.js';
import { asyncHandler, parseInput } from '../http/validation.js';
import { AppError } from '../lib/errors.js';
import type { AuthedRequest } from '../http/session.js';

const messageSchema = z.object({
  body: z.string().trim().max(2_000).default(''),
  clientId: z
    .string()
    .trim()
    .min(6)
    .max(80)
    .regex(/^[A-Za-z0-9._:-]+$/, 'clientId tidak valid')
    .optional(),
  attachmentUrl: z
    .string()
    .trim()
    .max(300)
    .regex(/^\/uploads\/[A-Za-z0-9/_.-]+$/)
    .optional(),
});

const idParam = z.string().min(8).max(80);

/**
 * User side of the live chat. Ownership is enforced by the service on every
 * call, and messages are persisted before they are streamed over the socket.
 */
export function chatRoutes(ctx: AppContext, requireAuth: RequestHandler): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ctx.config.MAX_UPLOAD_BYTES } });
  const userId = (req: unknown) => (req as AuthedRequest).auth!.userId;

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler((req, res) => {
      res.json({
        conversations: ctx.chat.listForUser(userId(req)),
        enabled: ctx.site.isEnabled('live_chat'),
        simulation: true,
        label: 'SIMULASI',
      });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      if (!ctx.site.isEnabled('live_chat')) throw new AppError('NOT_AVAILABLE', 503, 'Live chat sedang nonaktif');
      const body = parseInput(z.object({ subject: z.string().trim().min(3).max(120).optional() }), req.body);
      const conversation = ctx.chat.startConversation(userId(req), body.subject);
      res.status(201).json({ conversation, simulation: true });
    }),
  );

  router.get(
    '/:id/messages',
    asyncHandler((req, res) => {
      const id = parseInput(idParam, req.params.id);
      const query = parseInput(z.object({ after: z.string().max(80).optional() }), req.query);
      res.json({
        conversation: ctx.chat.listForUser(userId(req)).find((item) => item.id === id) ?? null,
        messages: ctx.chat.messagesForUser(userId(req), id, query.after),
        simulation: true,
      });
    }),
  );

  router.post(
    '/:id/messages',
    asyncHandler((req, res) => {
      if (!ctx.site.isEnabled('live_chat')) throw new AppError('NOT_AVAILABLE', 503, 'Live chat sedang nonaktif');
      const id = parseInput(idParam, req.params.id);
      const body = parseInput(messageSchema, req.body);
      const result = ctx.chat.send({
        conversationId: id,
        userId: userId(req),
        body: body.body,
        clientId: body.clientId,
        attachmentPath: body.attachmentUrl,
      });
      res.status(201).json({ ...result, simulation: true });
    }),
  );

  router.post(
    '/:id/upload',
    upload.single('file'),
    asyncHandler((req, res) => {
      const id = parseInput(idParam, req.params.id);
      ctx.chat.getForUser(userId(req), id);
      if (!req.file) throw new AppError('UPLOAD_INVALID', 400, 'File wajib diunggah pada field "file"');
      const stored = ctx.uploads.store(req.file.buffer, { folder: 'chat' });
      res.status(201).json({ ...stored, simulation: true });
    }),
  );

  router.post(
    '/:id/close',
    asyncHandler((req, res) => {
      const id = parseInput(idParam, req.params.id);
      ctx.chat.getForUser(userId(req), id);
      const conversation = ctx.chat.setStatus(id, 'closed', { actorUserId: userId(req) });
      res.json({ conversation, simulation: true });
    }),
  );

  return router;
}
