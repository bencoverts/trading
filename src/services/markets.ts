import type { Database } from '../db/sqlite.js';
import type { PriceEngine, MarketConfig } from '../price/engine.js';
import type { Mood, TrendDirection } from '../domain/constants.js';
import { recordAudit } from './audit.js';
import { AppError } from '../lib/errors.js';

export interface MarketRow {
  symbol: string;
  name: string;
  description: string | null;
  price_decimals: number;
  base_price: number;
  tick_size: number;
  tick_interval_ms: number;
  mood: Mood;
  trend: TrendDirection;
  volatility: number;
  paused: number;
  pause_reason: string | null;
  active: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface MarketView {
  symbol: string;
  name: string;
  description: string | null;
  priceDecimals: number;
  mood: Mood;
  trend: TrendDirection;
  volatility: number;
  paused: boolean;
  pauseReason: string | null;
  active: boolean;
  simulation: true;
}

export interface MarketPatch {
  mood?: Mood;
  trend?: TrendDirection;
  volatility?: number;
  paused?: boolean;
  pauseReason?: string | null;
  active?: boolean;
}

export const toMarketView = (row: MarketRow): MarketView => ({
  symbol: row.symbol,
  name: row.name,
  description: row.description,
  priceDecimals: row.price_decimals,
  mood: row.mood,
  trend: row.trend,
  volatility: row.volatility,
  paused: row.paused === 1,
  pauseReason: row.pause_reason,
  active: row.active === 1,
  simulation: true,
});

export interface MarketServiceDeps {
  db: Database;
  now?: () => number;
}

/**
 * Market metadata + admin controls (trend, mood, volatility, pause, open/close).
 * Every admin change is written to the audit log in the same transaction.
 */
export class MarketService {
  private readonly now: () => number;
  private engineRef: PriceEngine | null = null;

  constructor(private readonly deps: MarketServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Attached once the price engine exists (both read/write the same market rows). */
  attachEngine(engine: PriceEngine): void {
    this.engineRef = engine;
  }

  get engine(): PriceEngine {
    if (!this.engineRef) throw new Error('MarketService: price engine not attached yet');
    return this.engineRef;
  }

  private get db(): Database {
    return this.deps.db;
  }

  rows(includeInactive = false): MarketRow[] {
    return this.db.all<MarketRow>(
      `SELECT * FROM markets ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order ASC, symbol ASC`,
    );
  }

  row(symbol: string): MarketRow | undefined {
    return this.db.get<MarketRow>('SELECT * FROM markets WHERE symbol = ?', symbol.toUpperCase());
  }

  /** Throws MARKET_NOT_FOUND for unknown symbols. */
  requireRow(symbol: string): MarketRow {
    const row = this.row(symbol);
    if (!row) throw AppError.notFound(`Unknown market: ${symbol}`, 'MARKET_NOT_FOUND');
    return row;
  }

  views(includeInactive = false): MarketView[] {
    return this.rows(includeInactive).map(toMarketView);
  }

  engineConfigs(): MarketConfig[] {
    return this.rows(true).map((row) => ({
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

  update(
    symbol: string,
    patch: MarketPatch,
    ctx: { actorUserId: string; ip?: string | null },
  ): MarketView {
    const row = this.requireRow(symbol);
    const now = this.now();
    const next = {
      mood: patch.mood ?? row.mood,
      trend: patch.trend ?? row.trend,
      volatility: patch.volatility ?? row.volatility,
      paused: patch.paused === undefined ? row.paused : patch.paused ? 1 : 0,
      pause_reason: patch.paused === undefined ? row.pause_reason : patch.paused ? (patch.pauseReason ?? row.pause_reason) : null,
      active: patch.active === undefined ? row.active : patch.active ? 1 : 0,
    };
    if (!(next.volatility >= 0.01 && next.volatility <= 20)) {
      throw AppError.badRequest('volatility must be between 0.01 and 20');
    }

    this.db.transaction(() => {
      this.db.run(
        `UPDATE markets
            SET mood = ?, trend = ?, volatility = ?, paused = ?, pause_reason = ?, active = ?, updated_at = ?
          WHERE symbol = ?`,
        next.mood,
        next.trend,
        next.volatility,
        next.paused,
        next.pause_reason,
        next.active,
        now,
        row.symbol,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.market_updated',
        targetType: 'market',
        targetId: row.symbol,
        meta: {
          patch,
          previous: {
            mood: row.mood,
            trend: row.trend,
            volatility: row.volatility,
            paused: row.paused === 1,
            active: row.active === 1,
          },
        },
        ip: ctx.ip ?? null,
        now,
      });
    });

    this.engine.configure(row.symbol, {
      mood: next.mood,
      trend: next.trend,
      volatility: next.volatility,
      paused: next.paused === 1,
    });

    if (next.active === 0) {
      // a closed market stops producing simulated ticks (no new trade is possible)
      this.engine.configure(row.symbol, { paused: true });
    }

    return toMarketView(this.requireRow(row.symbol));
  }
}
