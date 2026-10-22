import { Router } from 'express';
import type { AppContext } from '../app/context.js';
import { asyncHandler } from '../http/validation.js';
import { CONTENT_SLUGS } from '../services/content.js';

/** Public content: banners + placeholder legal pages (FAQ, terms, privacy, contact). */
export function contentRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/banners',
    asyncHandler((_req, res) => {
      res.json({ banners: ctx.content.liveBanners(), simulation: true });
    }),
  );

  router.get(
    '/pages',
    asyncHandler((_req, res) => {
      res.json({ pages: ctx.content.pages() });
    }),
  );

  router.get(
    '/pages/:slug',
    asyncHandler((req, res) => {
      const slug = String(req.params.slug);
      if (!(CONTENT_SLUGS as readonly string[]).includes(slug)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Halaman tidak ditemukan' } });
        return;
      }
      res.json({ page: ctx.content.page(slug) });
    }),
  );

  return router;
}
