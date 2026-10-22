import type { Db } from '../db/types.js';
import type { Config } from '../config.js';
import type { Mood } from '../price/types.js';
import type { PayoutMode } from '../domain/payout.js';
import { recordAudit } from './audit.js';

export interface RuntimeSettings {
  payoutRate: number;
  payoutMode: PayoutMode;
  allowedDurations: number[];
  minAmountCents: number;
  maxAmountCents: number;
  maxOpenTrades: number;
  mood: Mood;
  volatility: number;
}

const SETTINGS_KEY = 'runtime';

/**
 * Business parameters editable by an admin at runtime without a restart.
 * Values are persisted as one JSON document; the environment config is the
 * source of the initial values.
 */
export class SettingsService {
  private current: RuntimeSettings;

  constructor(
    private readonly db: Db,
    defaults: RuntimeSettings,
  ) {
    this.current = { ...defaults };
  }

  static defaultsFromConfig(config: Config): RuntimeSettings {
    return {
      payoutRate: config.PAYOUT_RATE,
      payoutMode: config.PAYOUT_MODE,
      allowedDurations: [...config.ALLOWED_DURATIONS],
      minAmountCents: config.TRADE_MIN_CENTS,
      maxAmountCents: config.TRADE_MAX_CENTS,
      maxOpenTrades: config.MAX_OPEN_TRADES,
      mood: config.FEED_MOOD,
      volatility: config.FEED_VOLATILITY,
    };
  }

  async load(): Promise<void> {
    const row = await this.db.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [SETTINGS_KEY]);
    if (!row) return;
    try {
      this.current = this.merge(JSON.parse(row.value) as Partial<RuntimeSettings>);
    } catch {
      /* corrupt settings document: keep environment defaults */
    }
  }

  get(): RuntimeSettings {
    return { ...this.current, allowedDurations: [...this.current.allowedDurations] };
  }

  async update(
    patch: Partial<RuntimeSettings>,
    actor: 'admin' | 'system',
    userId?: string,
    ip?: string | null,
  ): Promise<RuntimeSettings> {
    const next = this.merge(patch);
    await this.db.tx(async (t) => {
      await t.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [SETTINGS_KEY, JSON.stringify(next), Date.now()],
      );
      await recordAudit(
        t,
        { actor, userId: userId ?? null, action: 'settings_updated', meta: { patch }, ip: ip ?? null },
        Date.now(),
      );
    });
    this.current = next;
    return this.get();
  }

  private merge(patch: Partial<RuntimeSettings>): RuntimeSettings {
    const next: RuntimeSettings = { ...this.current, ...patch } as RuntimeSettings;
    if (patch.allowedDurations) {
      next.allowedDurations = [...new Set(patch.allowedDurations)].filter((d) => Number.isInteger(d) && d > 0).sort((a, b) => a - b);
      if (next.allowedDurations.length === 0) next.allowedDurations = [...this.current.allowedDurations];
    }
    next.payoutRate = Math.max(0, Math.min(5, next.payoutRate));
    next.volatility = Math.max(0.01, next.volatility);
    next.minAmountCents = Math.max(1, Math.min(next.minAmountCents, next.maxAmountCents));
    return next;
  }
}
