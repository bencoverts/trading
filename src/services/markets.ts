import type { Database } from '../db/sqlite.js';
import type { PriceEngine, MarketConfig } from '../price/engine.js';
import {
  MARKET_CATEGORIES,
  VOLATILITY_PRESETS,
  type MarketCategory,
  type Mood,
  type TrendDirection,
  type VolatilityPreset,
} from '../domain/constants.js';
import { isMarketOpen, parseTradingHours, type TradingHours } from '../domain/marketSchedule.js';
import { recordAudit } from './audit.js';
import { newId } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { toMajor } from '../domain/money.js';

export interface MarketRow {
  symbol: string;
  name: string;
  description: string | null;
  category: MarketCategory;
  logo_path: string | null;
  price_decimals: number;
  base_price: number;
  tick_size: number;
  tick_interval_ms: number;
  mood: Mood;
  trend: TrendDirection;
  trend_strength: number;
  volatility: number;
  volatility_preset: VolatilityPreset;
  trading_hours: string;
  min_amount_usd_minor: number | null;
  max_amount_usd_minor: number | null;
  payout_rate: number | null;
  exposure_limit_usd_minor: number | null;
  featured: number;
  is_draft: number;
  paused: number;
  pause_reason: string | null;
  active: number;
  deleted_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
}

export interface MarketView {
  symbol: string;
  name: string;
  description: string | null;
  category: MarketCategory;
  logoUrl: string | null;
  priceDecimals: number;
  mood: Mood;
  trend: TrendDirection;
  trendStrength: number;
  volatility: number;
  volatilityPreset: VolatilityPreset;
  tradingHours: TradingHours;
  open: boolean;
  openReason: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  payoutRate: number | null;
  exposureLimit: number | null;
  featured: boolean;
  status: 'draft' | 'active' | 'paused' | 'inactive' | 'deleted';
  paused: boolean;
  pauseReason: string | null;
  active: boolean;
  sortOrder: number;
  simulation: true;
}

export const marketStatus = (row: MarketRow): MarketView['status'] => {
  if (row.deleted_at) return 'deleted';
  if (row.is_draft === 1) return 'draft';
  if (row.active !== 1) return 'inactive';
  if (row.paused === 1) return 'paused';
  return 'active';
};

export const toMarketView = (row: MarketRow, now = Date.now()): MarketView => {
  const hours = parseTradingHours(row.trading_hours);
  const state = isMarketOpen(hours, now);
  return {
    symbol: row.symbol,
    name: row.name,
    description: row.description,
    category: row.category,
    logoUrl: row.logo_path ? `/uploads/${row.logo_path}` : null,
    priceDecimals: row.price_decimals,
    mood: row.mood,
    trend: row.trend,
    trendStrength: row.trend_strength,
    volatility: row.volatility,
    volatilityPreset: row.volatility_preset,
    tradingHours: hours,
    open: state.open,
    openReason: state.reason ?? null,
    minAmount: row.min_amount_usd_minor === null ? null : toMajor(row.min_amount_usd_minor, 'USD'),
    maxAmount: row.max_amount_usd_minor === null ? null : toMajor(row.max_amount_usd_minor, 'USD'),
    payoutRate: row.payout_rate,
    exposureLimit: row.exposure_limit_usd_minor === null ? null : toMajor(row.exposure_limit_usd_minor, 'USD'),
    featured: row.featured === 1,
    status: marketStatus(row),
    paused: row.paused === 1,
    pauseReason: row.pause_reason,
    active: row.active === 1 && row.deleted_at === null,
    sortOrder: row.sort_order,
    simulation: true,
  };
};

export interface CreateMarketInput {
  symbol: string;
  name: string;
  description?: string | null;
  category: MarketCategory;
  priceDecimals: number;
  startPrice: number;
  tickSize: number;
  tickIntervalMs?: number;
  volatilityPreset: VolatilityPreset;
  mood: Mood;
  trend?: TrendDirection;
  trendStrength?: number;
  tradingHours?: TradingHours;
  minAmountUsd?: number | null;
  maxAmountUsd?: number | null;
  payoutRate?: number | null;
  exposureLimitUsd?: number | null;
  sortOrder?: number;
  featured?: boolean;
  logoPath?: string | null;
  activate: boolean;
}

export interface UpdateMarketInput extends Partial<Omit<CreateMarketInput, 'symbol' | 'activate'>> {
  active?: boolean;
  paused?: boolean;
  pauseReason?: string | null;
  draft?: boolean;
}

export interface MarketServiceDeps {
  db: Database;
  now?: () => number;
}

const SYMBOL_RE = /^[A-Z0-9_]{2,20}$/;
const VALID_CATEGORIES = new Set<string>(MARKET_CATEGORIES);
const VALID_PRESETS = new Set<string>(Object.keys(VOLATILITY_PRESETS));

export class MarketService {
  private readonly now: () => number;
  private engineRef: PriceEngine | null = null;
  private historyBootstrap: ((symbol: string) => void) | null = null;

  constructor(private readonly deps: MarketServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  attachEngine(engine: PriceEngine): void {
    this.engineRef = engine;
  }

  /** Wired by bootstrap: generates initial ticks/candles for a new market. */
  setHistoryBootstrap(fn: (symbol: string) => void): void {
    this.historyBootstrap = fn;
  }

  get engine(): PriceEngine {
    if (!this.engineRef) throw new Error('MarketService: price engine belum terpasang');
    return this.engineRef;
  }

  private get db(): Database {
    return this.deps.db;
  }

  rows(opts: { includeDeleted?: boolean; includeInactive?: boolean } = {}): MarketRow[] {
    const clauses: string[] = [];
    if (!opts.includeDeleted) clauses.push('deleted_at IS NULL');
    if (!opts.includeInactive) clauses.push('active = 1', 'is_draft = 0');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all<MarketRow>(`SELECT * FROM markets ${where} ORDER BY featured DESC, sort_order ASC, symbol ASC`);
  }

  row(symbol: string, opts: { includeDeleted?: boolean } = {}): MarketRow | undefined {
    const row = this.db.get<MarketRow>('SELECT * FROM markets WHERE symbol = ?', symbol.toUpperCase());
    if (!row) return undefined;
    if (row.deleted_at && !opts.includeDeleted) return undefined;
    return row;
  }

  requireRow(symbol: string): MarketRow {
    const row = this.row(symbol);
    if (!row) throw AppError.notFound(`Market tidak ditemukan: ${symbol}`, 'MARKET_NOT_FOUND');
    return row;
  }

  /** Public list: active, non-draft, non-deleted. */
  views(): MarketView[] {
    const now = this.now();
    return this.rows()
      .filter((row) => row.active === 1)
      .map((row) => toMarketView(row, now));
  }

  adminViews(): Array<MarketView & { deleted: boolean; createdAt: number; updatedAt: number }> {
    const now = this.now();
    return this.rows({ includeInactive: true }).map((row) => ({
      ...toMarketView(row, now),
      deleted: row.deleted_at !== null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  engineConfigs(): MarketConfig[] {
    return this.rows({ includeInactive: true })
      .filter((row) => row.active === 1 && row.is_draft === 0)
      .map((row) => ({
        symbol: row.symbol,
        name: row.name,
        priceDecimals: row.price_decimals,
        basePrice: row.base_price,
        tickSize: row.tick_size,
        tickIntervalMs: row.tick_interval_ms,
        mood: row.mood,
        trend: row.trend,
        volatility: row.volatility,
        paused: row.paused === 1,
      }));
  }

  isTradeable(row: MarketRow, at = this.now()): { ok: boolean; code?: string; message?: string } {
    if (row.deleted_at) return { ok: false, code: 'MARKET_CLOSED', message: 'Market sudah dihapus' };
    if (row.is_draft === 1) return { ok: false, code: 'MARKET_CLOSED', message: 'Market masih draft' };
    if (row.active !== 1) return { ok: false, code: 'MARKET_CLOSED', message: `Market ${row.symbol} tidak aktif` };
    if (row.paused === 1) {
      return { ok: false, code: 'MARKET_PAUSED', message: `Market ${row.symbol} sedang di-pause` };
    }
    const state = isMarketOpen(parseTradingHours(row.trading_hours), at);
    if (!state.open) return { ok: false, code: 'MARKET_OUTSIDE_HOURS', message: state.reason ?? 'Di luar jam trading' };
    return { ok: true };
  }

  create(input: CreateMarketInput, ctx: { actorUserId: string; ip?: string | null }): MarketRow {
    const symbol = input.symbol.trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) {
      throw AppError.badRequest('Symbol hanya huruf besar, angka, dan underscore (2-20 karakter)');
    }
    if (!VALID_CATEGORIES.has(input.category)) throw AppError.badRequest('Kategori tidak dikenal');
    if (!VALID_PRESETS.has(input.volatilityPreset)) throw AppError.badRequest('Preset volatilitas tidak dikenal');
    if (!(input.startPrice > 0)) throw AppError.badRequest('Harga awal harus lebih besar dari 0');
    if (!(input.tickSize > 0)) throw AppError.badRequest('Tick size harus lebih besar dari 0');
    if (this.db.get('SELECT symbol FROM markets WHERE symbol = ?', symbol)) {
      throw AppError.conflict(`Symbol ${symbol} sudah dipakai`, 'MARKET_SYMBOL_TAKEN');
    }
    if (input.minAmountUsd != null && input.maxAmountUsd != null && input.minAmountUsd > input.maxAmountUsd) {
      throw AppError.badRequest('Batas nominal minimum tidak boleh melebihi maksimum');
    }

    const now = this.now();
    const volatility = VOLATILITY_PRESETS[input.volatilityPreset].multiplier;
    const active = input.activate ? 1 : 0;
    const draft = input.activate ? 0 : 1;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO markets (symbol, name, description, category, logo_path, price_decimals, base_price, tick_size,
                              tick_interval_ms, mood, trend, trend_strength, volatility, volatility_preset,
                              trading_hours, min_amount_usd_minor, max_amount_usd_minor, payout_rate,
                              exposure_limit_usd_minor, featured, is_draft, paused, active, sort_order,
                              created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        symbol,
        input.name.trim().slice(0, 80) || symbol,
        input.description?.slice(0, 400) ?? null,
        input.category,
        input.logoPath ?? null,
        input.priceDecimals,
        input.startPrice,
        input.tickSize,
        input.tickIntervalMs ?? 100,
        input.mood,
        input.trend ?? 'neutral',
        input.trendStrength ?? 5,
        volatility,
        input.volatilityPreset,
        JSON.stringify(input.tradingHours ?? { mode: '24_7' }),
        input.minAmountUsd == null ? null : Math.round(input.minAmountUsd * 100),
        input.maxAmountUsd == null ? null : Math.round(input.maxAmountUsd * 100),
        input.payoutRate ?? null,
        input.exposureLimitUsd == null ? null : Math.round(input.exposureLimitUsd * 100),
        input.featured ? 1 : 0,
        draft,
        active,
        input.sortOrder ?? 100,
        now,
        now,
        ctx.actorUserId,
        ctx.actorUserId,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.market_created',
        targetType: 'market',
        targetId: symbol,
        meta: { input, status: active ? 'active' : 'draft' },
        ip: ctx.ip ?? null,
        now,
      });
      this.history(symbol, ctx, 'created', null, { ...input, symbol }, 'market dibuat');
    });

    const row = this.requireRow(symbol);
    if (row.active === 1) {
      this.engine.addMarket({
        symbol,
        name: row.name,
        priceDecimals: row.price_decimals,
        basePrice: row.base_price,
        tickSize: row.tick_size,
        tickIntervalMs: row.tick_interval_ms,
        mood: row.mood,
        trend: row.trend,
        volatility: row.volatility,
        paused: row.paused === 1,
      });
      this.historyBootstrap?.(symbol);
    }
    return row;
  }

  update(
    symbol: string,
    patch: UpdateMarketInput,
    ctx: { actorUserId: string; ip?: string | null },
    /** Audit labels; the simulate/reset panels get distinct actions. */
    labels: { audit?: string; history?: string } = {},
  ): MarketRow {
    const row = this.requireRow(symbol);
    const now = this.now();
    const before = snapshot(row);

    const next = {
      name: patch.name?.trim().slice(0, 80) ?? row.name,
      description: patch.description === undefined ? row.description : (patch.description?.slice(0, 400) ?? null),
      category: patch.category ?? row.category,
      logo_path: patch.logoPath === undefined ? row.logo_path : patch.logoPath,
      price_decimals: patch.priceDecimals ?? row.price_decimals,
      base_price: patch.startPrice ?? row.base_price,
      tick_size: patch.tickSize ?? row.tick_size,
      tick_interval_ms: patch.tickIntervalMs ?? row.tick_interval_ms,
      mood: patch.mood ?? row.mood,
      trend: patch.trend ?? row.trend,
      trend_strength: patch.trendStrength ?? row.trend_strength,
      volatility_preset: patch.volatilityPreset ?? row.volatility_preset,
      volatility: patch.volatilityPreset ? VOLATILITY_PRESETS[patch.volatilityPreset].multiplier : row.volatility,
      trading_hours: patch.tradingHours ? JSON.stringify(patch.tradingHours) : row.trading_hours,
      min_amount_usd_minor:
        patch.minAmountUsd === undefined
          ? row.min_amount_usd_minor
          : patch.minAmountUsd === null
            ? null
            : Math.round(patch.minAmountUsd * 100),
      max_amount_usd_minor:
        patch.maxAmountUsd === undefined
          ? row.max_amount_usd_minor
          : patch.maxAmountUsd === null
            ? null
            : Math.round(patch.maxAmountUsd * 100),
      payout_rate: patch.payoutRate === undefined ? row.payout_rate : patch.payoutRate,
      exposure_limit_usd_minor:
        patch.exposureLimitUsd === undefined
          ? row.exposure_limit_usd_minor
          : patch.exposureLimitUsd === null
            ? null
            : Math.round(patch.exposureLimitUsd * 100),
      featured: patch.featured === undefined ? row.featured : patch.featured ? 1 : 0,
      sort_order: patch.sortOrder ?? row.sort_order,
      is_draft: patch.draft === undefined ? row.is_draft : patch.draft ? 1 : 0,
      paused: patch.paused === undefined ? row.paused : patch.paused ? 1 : 0,
      pause_reason:
        patch.paused === undefined
          ? row.pause_reason
          : patch.paused
            ? (patch.pauseReason ?? row.pause_reason ?? 'di-pause admin')
            : null,
      active: patch.active === undefined ? row.active : patch.active ? 1 : 0,
    };
    if (
      next.min_amount_usd_minor != null &&
      next.max_amount_usd_minor != null &&
      next.min_amount_usd_minor > next.max_amount_usd_minor
    ) {
      throw AppError.badRequest('Batas nominal minimum tidak boleh melebihi maksimum');
    }
    const startPriceChanged = next.base_price !== row.base_price;

    this.db.transaction(() => {
      this.db.run(
        `UPDATE markets SET name = ?, description = ?, category = ?, logo_path = ?, price_decimals = ?, base_price = ?,
                            tick_size = ?, tick_interval_ms = ?, mood = ?, trend = ?, trend_strength = ?, volatility = ?,
                            volatility_preset = ?, trading_hours = ?, min_amount_usd_minor = ?, max_amount_usd_minor = ?,
                            payout_rate = ?, exposure_limit_usd_minor = ?, featured = ?, is_draft = ?, paused = ?,
                            pause_reason = ?, active = ?, sort_order = ?, updated_at = ?, updated_by = ?
          WHERE symbol = ?`,
        next.name,
        next.description,
        next.category,
        next.logo_path,
        next.price_decimals,
        next.base_price,
        next.tick_size,
        next.tick_interval_ms,
        next.mood,
        next.trend,
        next.trend_strength,
        next.volatility,
        next.volatility_preset,
        next.trading_hours,
        next.min_amount_usd_minor,
        next.max_amount_usd_minor,
        next.payout_rate,
        next.exposure_limit_usd_minor,
        next.featured,
        next.is_draft,
        next.paused,
        next.pause_reason,
        next.active,
        next.sort_order,
        now,
        ctx.actorUserId,
        row.symbol,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: startPriceChanged ? 'admin.market_price_changed' : (labels.audit ?? 'admin.market_updated'),
        targetType: 'market',
        targetId: row.symbol,
        meta: { patch, before, startPriceChanged },
        ip: ctx.ip ?? null,
        now,
      });
      this.history(
        row.symbol,
        ctx,
        startPriceChanged ? 'start_price_changed' : (labels.history ?? 'updated'),
        before,
        next,
        patch.pauseReason ?? null,
      );
    });

    const updated = this.requireRow(row.symbol);
    if (updated.active === 1 && updated.is_draft === 0) {
      this.engine.addMarket({
        symbol: updated.symbol,
        name: updated.name,
        priceDecimals: updated.price_decimals,
        basePrice: updated.base_price,
        tickSize: updated.tick_size,
        tickIntervalMs: updated.tick_interval_ms,
        mood: updated.mood,
        trend: updated.trend,
        volatility: updated.volatility,
        paused: updated.paused === 1,
      });
      this.engine.configure(updated.symbol, {
        mood: updated.mood,
        trend: updated.trend,
        volatility: updated.volatility,
        paused: updated.paused === 1,
      });
      // A changed start price seeds the series only when the market has no live
      // price yet; running trades keep their recorded entry price.
      if (startPriceChanged && this.engine.lastPrice(updated.symbol) === null) {
        this.engine.setPrice(updated.symbol, updated.base_price);
      }
    } else {
      this.engine.configure(updated.symbol, { paused: true });
    }
    return updated;
  }

  /** Simulation controls used by the admin "simulate" panel. */
  simulate(
    symbol: string,
    patch: {
      trend?: TrendDirection;
      trendStrength?: number;
      volatilityPreset?: VolatilityPreset;
      mood?: Mood;
      paused?: boolean;
      pauseReason?: string | null;
    },
    ctx: { actorUserId: string; ip?: string | null },
  ): MarketRow {
    return this.update(symbol, patch, ctx, { audit: 'admin.market_simulated', history: 'simulated' });
  }

  resetSimulation(symbol: string, ctx: { actorUserId: string; ip?: string | null }): MarketRow {
    return this.update(
      symbol,
      { trend: 'neutral', trendStrength: 5, volatilityPreset: 'sedang', mood: 'normal', paused: false },
      ctx,
      { audit: 'admin.market_reset', history: 'reset' },
    );
  }

  /** Soft delete; refused while the market still has open trades. */
  softDelete(symbol: string, ctx: { actorUserId: string; ip?: string | null }): void {
    const row = this.requireRow(symbol);
    const open = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trades WHERE market = ? AND status = 'open'`,
      row.symbol,
    );
    if (Number(open?.n ?? 0) > 0) {
      throw new AppError('MARKET_HAS_OPEN_TRADES', 409, 'Market masih punya trade terbuka', {
        openTrades: Number(open?.n),
      });
    }
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        'UPDATE markets SET deleted_at = ?, active = 0, updated_at = ?, updated_by = ? WHERE symbol = ?',
        now,
        now,
        ctx.actorUserId,
        row.symbol,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.market_deleted',
        targetType: 'market',
        targetId: row.symbol,
        meta: { softDelete: true },
        ip: ctx.ip ?? null,
        now,
      });
      this.history(row.symbol, ctx, 'deleted', snapshot(row), null, 'soft delete');
    });
    this.engine.removeMarket(row.symbol);
  }

  restore(symbol: string, ctx: { actorUserId: string; ip?: string | null }): MarketRow {
    const row = this.row(symbol, { includeDeleted: true });
    if (!row) throw AppError.notFound('Market tidak ditemukan', 'MARKET_NOT_FOUND');
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        'UPDATE markets SET deleted_at = NULL, active = 1, is_draft = 0, updated_at = ?, updated_by = ? WHERE symbol = ?',
        now,
        ctx.actorUserId,
        row.symbol,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.market_restored',
        targetType: 'market',
        targetId: row.symbol,
        now,
        ip: ctx.ip ?? null,
      });
    });
    const restored = this.requireRow(row.symbol);
    this.engine.addMarket({
      symbol: restored.symbol,
      name: restored.name,
      priceDecimals: restored.price_decimals,
      basePrice: restored.base_price,
      tickSize: restored.tick_size,
      tickIntervalMs: restored.tick_interval_ms,
      mood: restored.mood,
      trend: restored.trend,
      volatility: restored.volatility,
      paused: restored.paused === 1,
    });
    return restored;
  }

  historyList(
    symbol: string,
    limit = 50,
  ): Array<{
    id: number;
    action: string;
    actorRole: string;
    before: unknown;
    after: unknown;
    note: string | null;
    createdAt: number;
  }> {
    const rows = this.db.all<{
      id: number;
      action: string;
      actor_role: string;
      before_json: string | null;
      after_json: string | null;
      note: string | null;
      created_at: number;
    }>(
      'SELECT id, action, actor_role, before_json, after_json, note, created_at FROM market_param_history WHERE market = ? ORDER BY id DESC LIMIT ?',
      symbol.toUpperCase(),
      Math.min(Math.max(limit, 1), 200),
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorRole: row.actor_role,
      before: row.before_json ? safeJson(row.before_json) : null,
      after: row.after_json ? safeJson(row.after_json) : null,
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  private history(
    symbol: string,
    ctx: { actorUserId: string; ip?: string | null },
    action: string,
    before: unknown,
    after: unknown,
    note: string | null,
  ): void {
    this.db.run(
      `INSERT INTO market_param_history (market, actor_user_id, actor_role, action, before_json, after_json, note, ip, created_at)
       VALUES (?, ?, 'admin', ?, ?, ?, ?, ?, ?)`,
      symbol,
      ctx.actorUserId,
      action,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      note,
      ctx.ip ?? null,
      this.now(),
    );
  }

  /** Total stake currently open on a market, converted to USD minor units. */
  openExposureUsdMinor(symbol: string, rates: Record<string, number>): number {
    const rows = this.db.all<{ currency: string; amount_minor: number }>(
      `SELECT currency, amount_minor FROM trades WHERE market = ? AND status = 'open'`,
      symbol,
    );
    let total = 0;
    for (const row of rows) {
      const rate = rates[row.currency] ?? 1;
      const scale = row.currency === 'IDR' ? 1 : 100;
      total += Math.round((Number(row.amount_minor) / scale / rate) * 100);
    }
    return total;
  }

  /** "SUGGEST" helper for the admin form: plausible start prices per category. */
  static suggestion(category: MarketCategory): { price: number; decimals: number; tickSize: number; label: string } {
    switch (category) {
      case 'crypto':
        return { price: 0.42, decimals: 5, tickSize: 0.0001, label: 'aset kripto murah (0.42)' };
      case 'forex':
        return { price: 15_250, decimals: 2, tickSize: 1, label: 'pair rupiah (15,250.00)' };
      case 'komoditas':
        return { price: 2_350.5, decimals: 2, tickSize: 0.1, label: 'komoditas (2,350.50)' };
      case 'index':
        return { price: 6_200, decimals: 2, tickSize: 0.1, label: 'indeks (6,200.00)' };
      default:
        return { price: 100, decimals: 2, tickSize: 0.01, label: 'instrumen umum (100.00)' };
    }
  }

  /** Preview used by the admin form before saving. */
  previewSeries(input: {
    startPrice: number;
    priceDecimals: number;
    volatilityPreset: VolatilityPreset;
    mood: Mood;
  }): Array<{ t: number; o: number; h: number; l: number; c: number }> {
    const now = this.now();
    const bucket = Math.floor(now / 60_000) * 60_000;
    const vol = VOLATILITY_PRESETS[input.volatilityPreset].multiplier;
    let price = input.startPrice;
    const out: Array<{ t: number; o: number; h: number; l: number; c: number }> = [];
    let seed = Math.max(1, Math.round(input.startPrice * 7919));
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 40; i >= 0; i--) {
      const o = price;
      let h = price;
      let l = price;
      for (let k = 0; k < 12; k++) {
        price = Math.max(
          input.startPrice * 0.5,
          price * (1 + (rng() - 0.5) * 0.004 * vol * (input.mood === 'liar' ? 2 : 1)),
        );
        h = Math.max(h, price);
        l = Math.min(l, price);
      }
      const f = 10 ** input.priceDecimals;
      out.push({
        t: bucket - i * 60_000,
        o: Math.round(o * f) / f,
        h: Math.round(h * f) / f,
        l: Math.round(l * f) / f,
        c: Math.round(price * f) / f,
      });
    }
    return out;
  }

  /** Human-readable list of the changes for the admin UI. */
  diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Array<{ field: string; from: unknown; to: unknown }> {
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...fields]
      .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      .map((field) => ({ field, from: before[field], to: after[field] }));
  }

  newId(): string {
    return newId();
  }
}

function snapshot(row: MarketRow): Record<string, unknown> {
  return {
    name: row.name,
    description: row.description,
    category: row.category,
    priceDecimals: row.price_decimals,
    startPrice: row.base_price,
    tickSize: row.tick_size,
    tickIntervalMs: row.tick_interval_ms,
    mood: row.mood,
    trend: row.trend,
    trendStrength: row.trend_strength,
    volatility: row.volatility,
    volatilityPreset: row.volatility_preset,
    tradingHours: parseTradingHours(row.trading_hours),
    minAmountUsd: row.min_amount_usd_minor === null ? null : row.min_amount_usd_minor / 100,
    maxAmountUsd: row.max_amount_usd_minor === null ? null : row.max_amount_usd_minor / 100,
    payoutRate: row.payout_rate,
    exposureLimitUsd: row.exposure_limit_usd_minor === null ? null : row.exposure_limit_usd_minor / 100,
    featured: row.featured === 1,
    paused: row.paused === 1,
    active: row.active === 1,
    draft: row.is_draft === 1,
    sortOrder: row.sort_order,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
