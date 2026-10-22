import type { Database } from '../db/sqlite.js';
import { AppError } from '../lib/errors.js';
import { recordAudit } from './audit.js';

export interface SiteBranding {
  name: string;
  description: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  accent: string;
  contactEmail: string | null;
  social: { twitter?: string; instagram?: string; telegram?: string };
}

export interface SiteSection {
  heroTitle: string;
  heroSubtitle: string;
  ctaPrimary: string;
  ctaSecondary: string;
  features: Array<{ title: string; body: string }>;
  faq: Array<{ question: string; answer: string }>;
}

export interface SiteSeo {
  title: string;
  description: string;
  keywords: string[];
  ogImage: string | null;
}

export interface SiteLegal {
  riskWarning: string;
  termsSlug: string;
  privacySlug: string;
}

export interface SiteMaintenance {
  enabled: boolean;
  message: string;
  allowStaff: boolean;
}

export interface SiteEmail {
  fromName: string;
  fromEmail: string | null;
}

export interface SiteConfig {
  branding: SiteBranding;
  landing: SiteSection;
  seo: SiteSeo;
  legal: SiteLegal;
  maintenance: SiteMaintenance;
  email: SiteEmail;
}

const DEFAULTS: SiteConfig = {
  branding: {
    name: 'SimTrade Demo',
    description: 'Platform trading simulasi dengan saldo virtual dan label SIMULASI di setiap halaman.',
    logoUrl: null,
    faviconUrl: null,
    accent: '#5b8cff',
    contactEmail: 'support@simtrade.local',
    social: {},
  },
  landing: {
    heroTitle: 'Latihan trading tanpa risiko uang nyata',
    heroSubtitle:
      'Market, candle, dan settlement dihasilkan oleh server simulasi. Semua saldo virtual dan tidak ada dana sungguhan.',
    ctaPrimary: 'Mulai dengan akun demo',
    ctaSecondary: 'Lihat market',
    features: [
      { title: 'Market simulasi', body: 'Tiga market awal dengan candle dan tick yang dihasilkan server.' },
      { title: 'Saldo virtual', body: 'Top-up demo, konversi, dan ledger yang dapat diaudit.' },
      { title: 'Transparan', body: 'Perubahan parameter simulasi admin tampil di riwayat market publik.' },
    ],
    faq: [
      {
        question: 'Apakah ini menggunakan uang sungguhan?',
        answer: 'Tidak. Seluruh saldo bersifat virtual dan setiap halaman menampilkan label SIMULASI.',
      },
      {
        question: 'Dari mana harga berasal?',
        answer: 'Server simulasi internal; tidak ada koneksi ke bursa atau penyedia data harga.',
      },
    ],
  },
  seo: {
    title: 'SimTrade Demo — platform trading simulasi',
    description: 'Demo platform trading biner dengan saldo virtual, chart server, dan panel admin.',
    keywords: ['simulasi', 'demo trading', 'saldo virtual'],
    ogImage: null,
  },
  legal: {
    riskWarning:
      'SIMULASI / DEMO. Ini bukan layanan investasi, tidak ada uang nyata, dan performa masa lalu tidak menjamin hasil.',
    termsSlug: 'terms',
    privacySlug: 'privacy',
  },
  maintenance: {
    enabled: false,
    message: 'Sedang dalam pemeliharaan. Silakan kembali sebentar lagi.',
    allowStaff: true,
  },
  email: { fromName: 'SimTrade Demo', fromEmail: null },
};

/**
 * Persisted, admin-editable site configuration. Values are stored as JSON per
 * section so a migration is not needed for every new landing-page field, while
 * the API still returns a typed shape with defaults for missing keys.
 */
export class SiteService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private read<T>(key: keyof SiteConfig): T {
    const row = this.db.get<{ value: string }>('SELECT value FROM site_settings WHERE key = ?', key);
    if (!row) return DEFAULTS[key] as T;
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      return { ...(DEFAULTS[key] as object), ...parsed } as T;
    } catch {
      return DEFAULTS[key] as T;
    }
  }

  get(): SiteConfig {
    return {
      branding: this.read('branding'),
      landing: this.read('landing'),
      seo: this.read('seo'),
      legal: this.read('legal'),
      maintenance: this.read('maintenance'),
      email: this.read('email'),
    };
  }

  publicConfig(): {
    branding: SiteBranding;
    seo: SiteSeo;
    maintenance: SiteMaintenance;
    label: 'SIMULASI';
    simulation: true;
  } {
    const config = this.get();
    return {
      branding: config.branding,
      seo: config.seo,
      maintenance: config.maintenance,
      label: 'SIMULASI',
      simulation: true,
    };
  }

  update(
    patch: { [K in keyof SiteConfig]?: Partial<SiteConfig[K]> },
    ctx: { actorUserId: string; ip?: string | null },
  ): SiteConfig {
    const now = this.now();
    const entries = Object.entries(patch).filter(([key]) => key in DEFAULTS) as Array<[keyof SiteConfig, unknown]>;
    if (!entries.length) return this.get();
    this.db.transaction(() => {
      for (const [key, value] of entries) {
        if (!value || typeof value !== 'object') continue;
        const merged = { ...(this.read(key) as object), ...(value as object) };
        this.db.run(
          `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          key,
          JSON.stringify(merged),
          ctx.actorUserId,
          now,
        );
      }
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.site_updated',
        targetType: 'site',
        targetId: 'settings',
        meta: { sections: entries.map(([key]) => key) },
        ip: ctx.ip ?? null,
        now,
      });
    });
    return this.get();
  }

  /** Keyed view consumed by the UI and the API (`flags.deposits === true`). */
  flags(): Record<string, boolean> {
    return Object.fromEntries(this.flagDetails().map((flag) => [flag.key, flag.enabled]));
  }

  flagDetails(): Array<{ key: string; enabled: boolean; description: string | null }> {
    const defaults: Array<{ key: string; enabled: boolean; description: string }> = [
      { key: 'deposits', enabled: true, description: 'Halaman deposit aktif' },
      { key: 'withdrawals', enabled: true, description: 'Halaman penarikan aktif' },
      { key: 'live_chat', enabled: true, description: 'Live chat dukungan' },
      { key: 'demo_topup', enabled: true, description: 'Top-up saldo demo instan' },
      { key: 'registrations', enabled: true, description: 'Pendaftaran akun baru' },
    ];
    const rows = this.db.all<{ key: string; enabled: number; description: string | null }>(
      'SELECT key, enabled, description FROM feature_flags',
    );
    return defaults.map((fallback) => {
      const row = rows.find((item) => item.key === fallback.key);
      return {
        key: fallback.key,
        enabled: row ? row.enabled === 1 : fallback.enabled,
        description: row?.description ?? fallback.description,
      };
    });
  }

  isEnabled(key: string): boolean {
    return this.flags()[key] ?? false;
  }

  setFlag(key: string, enabled: boolean, ctx: { actorUserId: string; ip?: string | null }): void {
    const now = this.now();
    const known = this.flagDetails().find((flag) => flag.key === key);
    if (!known) throw AppError.badRequest(`Feature flag tidak dikenal: ${key}`);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO feature_flags (key, enabled, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        key,
        enabled ? 1 : 0,
        known.description,
        ctx.actorUserId,
        now,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.feature_flag_updated',
        targetType: 'feature_flag',
        targetId: key,
        meta: { enabled },
        ip: ctx.ip ?? null,
        now,
      });
    });
  }
}
