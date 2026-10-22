import type { Database } from '../db/sqlite.js';
import { CURRENCY_LIST, MAX_DURATION_SEC, MIN_DURATION_SEC, type Currency } from '../domain/constants.js';
import type { PayoutMode } from '../domain/payout.js';
import { recordAudit } from './audit.js';
import { AppError } from '../lib/errors.js';

export interface RuntimeSettings {
  payoutRate: number;
  payoutMode: PayoutMode;
  allowedDurations: number[];
  maxOpenTrades: number;
  /** per-currency minimum / maximum stake, in minor units */
  minAmount: Record<Currency, number>;
  maxAmount: Record<Currency, number>;
  /** per-currency starting balance for new accounts, in minor units */
  initialBalance: Record<Currency, number>;
  /** per-currency cap for one DEMO top-up, in minor units */
  topupMax: Record<Currency, number>;
  topupDailyCount: number;
  /** seconds between two demo top-ups / resets */
  topupCooldownSec: number;
  resetCooldownSec: number;
  /** demo FX rates: units of currency per 1 USD */
  rates: Record<Currency, number>;
  /** per-duration payout override (seconds -> rate); empty = use payoutRate */
  payoutByDuration: Record<string, number>;
  /** per-market USD exposure cap, in USD minor units */
  globalMaxAmountUsdMinor: number;
  maxOpenTradesPerUser: number;
  tradeRateLimitPerMin: number;
  loginRateLimitPerMin: number;
  tickRetentionDays: number;
  candleRetentionDays: number;
  /** platform chrome */
  platformName: string;
  platformLogoPath: string | null;
  faviconPath: string | null;
  themeAccent: string;
  disclaimer: string;
  defaultLanguage: 'id' | 'en';
  defaultTimezone: string;
  platformTerms: string;
}

const KEY = 'runtime';

export const DEFAULT_SETTINGS: RuntimeSettings = {
  payoutRate: 0.85,
  payoutMode: 'profit',
  allowedDurations: [5, 10, 15, 30, 60, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800],
  maxOpenTrades: 10,
  minAmount: { USD: 100, IDR: 10_000, USDT: 100 },
  maxAmount: { USD: 100_000, IDR: 10_000_000, USDT: 100_000 },
  initialBalance: { USD: 100_000, IDR: 15_000_000, USDT: 100_000 },
  topupMax: { USD: 100_000, IDR: 10_000_000, USDT: 100_000 },
  topupDailyCount: 5,
  topupCooldownSec: 30,
  resetCooldownSec: 300,
  rates: { USD: 1, IDR: 16_000, USDT: 1 },
  payoutByDuration: {},
  globalMaxAmountUsdMinor: 200_000,
  maxOpenTradesPerUser: 20,
  tradeRateLimitPerMin: 20,
  loginRateLimitPerMin: 20,
  tickRetentionDays: 7,
  candleRetentionDays: 90,
  platformName: 'SimTrade Demo',
  platformLogoPath: null,
  faviconPath: null,
  themeAccent: '#5b8cff',
  disclaimer:
    'SIMULASI / DEMO. Semua harga dihasilkan oleh server simulasi dan semua saldo adalah virtual. Ini bukan layanan investasi dan tidak ada uang sungguhan yang terlibat.',
  defaultLanguage: 'id',
  defaultTimezone: 'Asia/Jakarta',
  platformTerms:
    'Platform ini adalah demo teknis untuk tujuan edukasi. Tidak ada layanan investasi, tidak ada uang sungguhan, dan tidak ada jaminan hasil apa pun.',
};

/**
 * Business parameters owned by the product/admin, persisted as one JSON row so
 * they survive restarts and can be changed without a deploy.
 */
export class SettingsService {
  private current: RuntimeSettings;

  constructor(
    private readonly db: Database,
    defaults: Partial<RuntimeSettings> = {},
  ) {
    this.current = normalize({ ...DEFAULT_SETTINGS, ...defaults });
  }

  load(): void {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY);
    if (!row) return;
    try {
      this.current = normalize({ ...this.current, ...(JSON.parse(row.value) as Partial<RuntimeSettings>) });
    } catch {
      /* keep defaults when the stored document is corrupt */
    }
  }

  get(): RuntimeSettings {
    return structuredClone(this.current);
  }

  update(
    patch: Partial<RuntimeSettings>,
    ctx: { actorRole: 'admin' | 'system'; actorUserId?: string | null; ip?: string | null },
    now = Date.now(),
  ): RuntimeSettings {
    const next = normalize({ ...this.current, ...patch });
    validate(next);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        KEY,
        JSON.stringify(next),
        now,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId ?? null,
        actorRole: ctx.actorRole,
        action: 'settings.updated',
        targetType: 'settings',
        targetId: KEY,
        meta: { patch, previous: this.current },
        ip: ctx.ip ?? null,
        now,
      });
    });
    this.current = next;
    return this.get();
  }
}

function normalize(input: RuntimeSettings): RuntimeSettings {
  const currencies = CURRENCY_LIST;
  const out: RuntimeSettings = {
    payoutRate: Number(input.payoutRate),
    payoutMode: input.payoutMode === 'total' ? 'total' : 'profit',
    allowedDurations: [...new Set((input.allowedDurations ?? []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= MIN_DURATION_SEC && d <= MAX_DURATION_SEC)
      .sort((a, b) => a - b),
    maxOpenTrades: Math.max(1, Math.round(Number(input.maxOpenTrades))),
    minAmount: { ...DEFAULT_SETTINGS.minAmount },
    maxAmount: { ...DEFAULT_SETTINGS.maxAmount },
    initialBalance: { ...DEFAULT_SETTINGS.initialBalance },
    topupMax: { ...DEFAULT_SETTINGS.topupMax },
    topupDailyCount: Math.max(1, Math.round(Number(input.topupDailyCount ?? DEFAULT_SETTINGS.topupDailyCount))),
    topupCooldownSec: Math.max(0, Math.round(Number(input.topupCooldownSec ?? DEFAULT_SETTINGS.topupCooldownSec))),
    resetCooldownSec: Math.max(0, Math.round(Number(input.resetCooldownSec ?? DEFAULT_SETTINGS.resetCooldownSec))),
    rates: { USD: 1, IDR: 16_000, USDT: 1 },
    payoutByDuration: normalizeDurationRates(input.payoutByDuration),
    globalMaxAmountUsdMinor: Math.max(
      0,
      Math.round(Number(input.globalMaxAmountUsdMinor ?? DEFAULT_SETTINGS.globalMaxAmountUsdMinor)),
    ),
    maxOpenTradesPerUser: Math.max(
      1,
      Math.round(Number(input.maxOpenTradesPerUser ?? DEFAULT_SETTINGS.maxOpenTradesPerUser)),
    ),
    tradeRateLimitPerMin: Math.max(
      1,
      Math.round(Number(input.tradeRateLimitPerMin ?? DEFAULT_SETTINGS.tradeRateLimitPerMin)),
    ),
    loginRateLimitPerMin: Math.max(
      1,
      Math.round(Number(input.loginRateLimitPerMin ?? DEFAULT_SETTINGS.loginRateLimitPerMin)),
    ),
    tickRetentionDays: Math.max(1, Math.round(Number(input.tickRetentionDays ?? DEFAULT_SETTINGS.tickRetentionDays))),
    candleRetentionDays: Math.max(
      1,
      Math.round(Number(input.candleRetentionDays ?? DEFAULT_SETTINGS.candleRetentionDays)),
    ),
    platformName:
      String(input.platformName ?? DEFAULT_SETTINGS.platformName).slice(0, 60) || DEFAULT_SETTINGS.platformName,
    platformLogoPath: input.platformLogoPath ?? null,
    faviconPath: input.faviconPath ?? null,
    themeAccent: /^#[0-9a-fA-F]{6}$/.test(String(input.themeAccent))
      ? String(input.themeAccent)
      : DEFAULT_SETTINGS.themeAccent,
    disclaimer: String(input.disclaimer ?? DEFAULT_SETTINGS.disclaimer).slice(0, 1000),
    defaultLanguage: input.defaultLanguage === 'en' ? 'en' : 'id',
    defaultTimezone: String(input.defaultTimezone ?? DEFAULT_SETTINGS.defaultTimezone),
    platformTerms: String(input.platformTerms ?? DEFAULT_SETTINGS.platformTerms).slice(0, 5000),
  };
  for (const c of currencies) {
    if (input.minAmount?.[c] !== undefined) out.minAmount[c] = Math.round(Number(input.minAmount[c]));
    if (input.maxAmount?.[c] !== undefined) out.maxAmount[c] = Math.round(Number(input.maxAmount[c]));
    if (input.initialBalance?.[c] !== undefined) out.initialBalance[c] = Math.round(Number(input.initialBalance[c]));
    if (input.topupMax?.[c] !== undefined) out.topupMax[c] = Math.round(Number(input.topupMax[c]));
    if (input.rates?.[c] !== undefined) out.rates[c] = Number(input.rates[c]);
  }
  out.rates.USD = 1;
  if (!out.allowedDurations.length) out.allowedDurations = [...DEFAULT_SETTINGS.allowedDurations];
  return out;
}

/** Cross-field rules that cannot be expressed in the request schema alone. */
function validate(s: RuntimeSettings): void {
  const fail = (message: string) => {
    throw AppError.badRequest(message);
  };
  if (!(s.payoutRate >= 0 && s.payoutRate <= 5)) fail('payoutRate must be between 0 and 5');
  if (s.payoutMode === 'total' && s.payoutRate <= 1) fail('payoutRate must be > 1 when payoutMode is "total"');
  if (!s.allowedDurations.length) fail('at least one allowed duration is required');
  if (s.allowedDurations.some((d) => d < MIN_DURATION_SEC || d > MAX_DURATION_SEC)) {
    fail('allowedDurations contains an unsupported value');
  }
  for (const c of CURRENCY_LIST) {
    if (!(s.minAmount[c] > 0)) fail(`minAmount.${c} must be > 0`);
    if (s.maxAmount[c] < s.minAmount[c]) fail(`maxAmount.${c} must be >= minAmount.${c}`);
    if (!(s.initialBalance[c] >= 0)) fail(`initialBalance.${c} must be >= 0`);
    if (!(s.topupMax[c] > 0)) fail(`topupMax.${c} must be > 0`);
    if (!(s.rates[c] > 0)) fail(`rates.${c} must be > 0`);
  }
  if (s.maxOpenTradesPerUser < 1) fail('maxOpenTradesPerUser minimal 1');
  if (s.globalMaxAmountUsdMinor < 0) fail('globalMaxAmountUsdMinor tidak boleh negatif');
  for (const [duration, rate] of Object.entries(s.payoutByDuration)) {
    if (!Number.isInteger(Number(duration))) fail('payoutByDuration harus memakai durasi dalam detik');
    if (!(rate >= 0 && rate <= 5)) fail('payout rate per durasi harus 0..5');
  }
}

function normalizeDurationRates(input: Record<string, number> | undefined): Record<string, number> {
  if (!input) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    const duration = Math.round(Number(key));
    const rate = Number(value);
    if (!Number.isFinite(duration) || duration < MIN_DURATION_SEC || duration > MAX_DURATION_SEC) continue;
    if (!Number.isFinite(rate) || rate < 0 || rate > 5) continue;
    out[String(duration)] = rate;
  }
  return out;
}
