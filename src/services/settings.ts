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
  /** demo FX rates: units of currency per 1 USD */
  rates: Record<Currency, number>;
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
  rates: { USD: 1, IDR: 16_000, USDT: 1 },
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
    topupDailyCount: Math.max(1, Math.round(Number(input.topupDailyCount))),
    rates: { USD: 1, IDR: 16_000, USDT: 1 },
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
}
