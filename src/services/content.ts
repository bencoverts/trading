import type { Database } from '../db/sqlite.js';
import { recordAudit } from './audit.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

export const CONTENT_SLUGS = ['faq', 'terms', 'privacy', 'contact'] as const;
export type ContentSlug = (typeof CONTENT_SLUGS)[number];

export interface BannerRow {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  active: number;
  starts_at: number | null;
  ends_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface BannerView {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  active: boolean;
  startsAt: number | null;
  endsAt: number | null;
  live: boolean;
  createdAt: number;
}

export interface ContentPage {
  slug: string;
  title: string;
  body: string;
  updatedAt: number;
  updatedBy: string | null;
}

/**
 * Editable demo content (FAQ/terms/privacy/contact) and announcements.
 * The body is plain text / light markdown, rendered safely by the frontend
 * (never injected as HTML).
 */
export class ContentService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  pages(): ContentPage[] {
    return this.db
      .all<{ slug: string; title: string; body: string; updated_at: number; updated_by: string | null }>(
        'SELECT slug, title, body, updated_at, updated_by FROM content_pages ORDER BY slug',
      )
      .map((row) => ({
        slug: row.slug,
        title: row.title,
        body: row.body,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      }));
  }

  page(slug: string): ContentPage {
    const row = this.db.get<{
      slug: string;
      title: string;
      body: string;
      updated_at: number;
      updated_by: string | null;
    }>('SELECT slug, title, body, updated_at, updated_by FROM content_pages WHERE slug = ?', slug);
    if (!row) throw AppError.notFound('Halaman tidak ditemukan');
    return { slug: row.slug, title: row.title, body: row.body, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  updatePage(slug: string, input: { title: string; body: string }, actorUserId: string): ContentPage {
    if (!(CONTENT_SLUGS as readonly string[]).includes(slug)) throw AppError.notFound('Halaman tidak ditemukan');
    if (input.title.trim().length < 3) throw AppError.badRequest('Judul minimal 3 karakter');
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO content_pages (slug, title, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET title = excluded.title, body = excluded.body,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        slug,
        input.title.trim().slice(0, 120),
        input.body.slice(0, 20_000),
        now,
        actorUserId,
      );
      recordAudit(this.db, {
        actorUserId,
        actorRole: 'admin',
        action: 'admin.content_updated',
        targetType: 'content',
        targetId: slug,
        meta: { title: input.title },
        now,
      });
    });
    return this.page(slug);
  }

  banners(includeInactive = false): BannerView[] {
    const now = this.now();
    const rows = this.db.all<BannerRow>(
      `SELECT * FROM banners ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY created_at DESC`,
    );
    return rows.map((row) => this.toBanner(row, now)).filter((banner) => includeInactive || banner.live);
  }

  liveBanners(): BannerView[] {
    return this.banners(false);
  }

  createBanner(
    input: {
      title: string;
      body?: string | null;
      link?: string | null;
      active?: boolean;
      startsAt?: number | null;
      endsAt?: number | null;
    },
    actorUserId: string,
  ): BannerView {
    if (input.title.trim().length < 3) throw AppError.badRequest('Judul minimal 3 karakter');
    if (input.link && !/^(https?:\/\/|\/)/.test(input.link))
      throw AppError.badRequest('Tautan harus diawali http(s):// atau /');
    const now = this.now();
    const id = newId();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO banners (id, title, body, link, active, starts_at, ends_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.title.trim().slice(0, 160),
        input.body?.slice(0, 1000) ?? null,
        input.link ?? null,
        input.active === false ? 0 : 1,
        input.startsAt ?? null,
        input.endsAt ?? null,
        now,
        now,
      );
      recordAudit(this.db, {
        actorUserId,
        actorRole: 'admin',
        action: 'admin.banner_created',
        targetType: 'banner',
        targetId: id,
        meta: { title: input.title },
        now,
      });
    });
    return this.toBanner(this.db.get<BannerRow>('SELECT * FROM banners WHERE id = ?', id) as BannerRow, now);
  }

  updateBanner(
    id: string,
    input: {
      title?: string;
      body?: string | null;
      link?: string | null;
      active?: boolean;
      startsAt?: number | null;
      endsAt?: number | null;
    },
    actorUserId: string,
  ): BannerView {
    const row = this.db.get<BannerRow>('SELECT * FROM banners WHERE id = ?', id);
    if (!row) throw AppError.notFound('Banner tidak ditemukan');
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE banners SET title = ?, body = ?, link = ?, active = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?`,
        input.title?.trim().slice(0, 160) ?? row.title,
        input.body === undefined ? row.body : (input.body?.slice(0, 1000) ?? null),
        input.link === undefined ? row.link : input.link,
        input.active === undefined ? row.active : input.active ? 1 : 0,
        input.startsAt === undefined ? row.starts_at : input.startsAt,
        input.endsAt === undefined ? row.ends_at : input.endsAt,
        now,
        id,
      );
      recordAudit(this.db, {
        actorUserId,
        actorRole: 'admin',
        action: 'admin.banner_updated',
        targetType: 'banner',
        targetId: id,
        meta: { title: input.title ?? row.title },
        now,
      });
    });
    return this.toBanner(this.db.get<BannerRow>('SELECT * FROM banners WHERE id = ?', id) as BannerRow, now);
  }

  deleteBanner(id: string, actorUserId: string): void {
    const row = this.db.get<BannerRow>('SELECT * FROM banners WHERE id = ?', id);
    if (!row) throw AppError.notFound('Banner tidak ditemukan');
    const now = this.now();
    this.db.transaction(() => {
      this.db.run('DELETE FROM banners WHERE id = ?', id);
      recordAudit(this.db, {
        actorUserId,
        actorRole: 'admin',
        action: 'admin.banner_deleted',
        targetType: 'banner',
        targetId: id,
        meta: { title: row.title },
        now,
      });
    });
  }

  private toBanner(row: BannerRow, now: number): BannerView {
    const live =
      row.active === 1 &&
      (row.starts_at === null || row.starts_at <= now) &&
      (row.ends_at === null || row.ends_at >= now);
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      link: row.link,
      active: row.active === 1,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      live,
      createdAt: row.created_at,
    };
  }
}
