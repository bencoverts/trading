import type { Database } from '../db/sqlite.js';
import type { PriceEngine } from '../price/engine.js';
import type { SettingsService } from './settings.js';
import type { WalletService } from './wallets.js';
import type { MarketService, MarketRow } from './markets.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import { Emitter } from '../lib/emitter.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { computePayoutMinor, decideResult, type PayoutMode } from '../domain/payout.js';
import { toMajor } from '../domain/money.js';
import type { Currency, Direction, TradeResult } from '../domain/constants.js';
import { recordAudit } from './audit.js';

export interface TradeRow {
  id: string;
  user_id: string;
  market: string;
  direction: Direction;
  currency: Currency;
  amount_minor: number;
  duration_sec: number;
  entry_price: number;
  entry_time: number;
  expiry_time: number;
  close_price: number | null;
  settled_at: number | null;
  status: 'open' | 'closed';
  result: TradeResult | null;
  payout_rate: number;
  payout_mode: PayoutMode;
  payout_minor: number;
  settled_by: 'expiry' | 'admin' | null;
  settle_reason: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: number;
}

export interface TradeView {
  id: string;
  userId: string;
  market: string;
  direction: Direction;
  currency: Currency;
  amount: number;
  amountMinor: number;
  durationSec: number;
  entryPrice: number;
  entryTime: number;
  expiryTime: number;
  closePrice: number | null;
  status: 'open' | 'closed';
  result: TradeResult | null;
  payoutRate: number;
  payoutMode: PayoutMode;
  payout: number | null;
  payoutMinor: number | null;
  profit: number | null;
  profitMinor: number | null;
  settledBy: 'expiry' | 'admin' | null;
  settleReason: string | null;
  createdAt: number;
  livePrice?: number | null;
  estimatedResult?: TradeResult | 'pending' | null;
  estimatedPayout?: number | null;
  sim: true;
}

export const toTradeView = (row: TradeRow): TradeView => {
  const settled = row.status === 'closed';
  const payoutMinor = settled ? Number(row.payout_minor) : null;
  return {
    id: row.id,
    userId: row.user_id,
    market: row.market,
    direction: row.direction,
    currency: row.currency,
    amount: toMajor(Number(row.amount_minor), row.currency),
    amountMinor: Number(row.amount_minor),
    durationSec: Number(row.duration_sec),
    entryPrice: Number(row.entry_price),
    entryTime: Number(row.entry_time),
    expiryTime: Number(row.expiry_time),
    closePrice: row.close_price === null ? null : Number(row.close_price),
    status: row.status,
    result: row.result,
    payoutRate: Number(row.payout_rate),
    payoutMode: row.payout_mode,
    payout: payoutMinor === null ? null : toMajor(payoutMinor, row.currency),
    payoutMinor,
    profit: payoutMinor === null ? null : toMajor(payoutMinor - Number(row.amount_minor), row.currency),
    profitMinor: payoutMinor === null ? null : payoutMinor - Number(row.amount_minor),
    settledBy: row.settled_by,
    settleReason: row.settle_reason,
    createdAt: Number(row.created_at),
    sim: true,
  };
};

export interface CreateTradeInput {
  userId: string;
  market: string;
  direction: Direction;
  currency: Currency;
  amountMinor: number;
  durationSec: number;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  ip?: string | null;
}

export interface TradeEvents {
  opened: [{ trade: TradeView; balanceMinor: number }];
  settled: [{ trade: TradeView; balanceMinor: number }];
}

export interface TradeServiceDeps {
  db: Database;
  engine: PriceEngine;
  settings: SettingsService;
  wallets: WalletService;
  markets: MarketService;
  clock: Clock;
  logger: Logger;
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    (typeof e?.message === 'string' && /UNIQUE constraint failed/i.test(e.message))
  );
};

/** Payout rate resolution: per-market override, then per-duration, then global. */
export function resolvePayoutRate(
  settings: { payoutRate: number; payoutByDuration: Record<string, number> },
  market: MarketRow | undefined,
  durationSec: number,
): number {
  if (market?.payout_rate !== null && market?.payout_rate !== undefined) return Number(market.payout_rate);
  const perDuration = settings.payoutByDuration[String(durationSec)];
  if (perDuration !== undefined) return perDuration;
  return settings.payoutRate;
}

export class TradeService {
  readonly events = new Emitter<TradeEvents>();

  constructor(private readonly deps: TradeServiceDeps) {}

  private get db(): Database {
    return this.deps.db;
  }

  validateIntent(input: {
    userId: string;
    market: string;
    currency: Currency;
    amountMinor: number;
    durationSec: number;
  }): MarketRow {
    const settings = this.deps.settings.get();
    const market = this.deps.markets.requireRow(input.market);
    const state = this.deps.markets.isTradeable(market, this.deps.clock.now());
    if (!state.ok) {
      throw AppError.unprocessable(
        (state.code as 'MARKET_PAUSED') ?? 'MARKET_CLOSED',
        state.message ?? 'Market tidak bisa ditradingkan',
      );
    }
    if (!Number.isInteger(input.durationSec) || input.durationSec < 5 || input.durationSec > 28_800) {
      throw AppError.unprocessable('DURATION_NOT_ALLOWED', 'Durasi harus antara 5 dan 28800 detik');
    }
    if (!settings.allowedDurations.includes(input.durationSec)) {
      throw AppError.unprocessable('DURATION_NOT_ALLOWED', 'Durasi tidak diizinkan', {
        allowedDurations: settings.allowedDurations,
      });
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw AppError.badRequest('Nominal harus lebih dari 0');
    }
    const scale = input.currency === 'IDR' ? 1 : 100;
    const usdRate = settings.rates[input.currency] ?? 1;
    const amountUsdMinor = Math.round((input.amountMinor / scale / usdRate) * 100);
    const globalMaxUsd = settings.globalMaxAmountUsdMinor;
    if (globalMaxUsd > 0 && amountUsdMinor > globalMaxUsd) {
      throw AppError.unprocessable('AMOUNT_NOT_ALLOWED', 'Nominal melebihi batas maksimum akun', {
        maxAmountUsd: globalMaxUsd / 100,
      });
    }
    const min =
      market.min_amount_usd_minor === null
        ? settings.minAmount[input.currency]
        : Math.round((market.min_amount_usd_minor / 100) * usdRate * scale);
    const max =
      market.max_amount_usd_minor === null
        ? settings.maxAmount[input.currency]
        : Math.round((market.max_amount_usd_minor / 100) * usdRate * scale);
    if (input.amountMinor < min || input.amountMinor > max) {
      throw AppError.unprocessable(
        'AMOUNT_NOT_ALLOWED',
        `Nominal harus antara ${toMajor(min, input.currency)} dan ${toMajor(max, input.currency)} ${input.currency}`,
        {
          minMinor: min,
          maxMinor: max,
          currency: input.currency,
        },
      );
    }
    return market;
  }

  create(input: CreateTradeInput): { trade: TradeView; replayed: boolean; balanceMinor: number } {
    const market = this.validateIntent(input);
    const settings = this.deps.settings.get();
    const payoutRate = resolvePayoutRate(settings, market, input.durationSec);

    if (input.idempotencyKey) {
      const existing = this.findByIdempotency(input.userId, input.idempotencyKey);
      if (existing) {
        if (input.requestHash && existing.request_hash && existing.request_hash !== input.requestHash) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Idempotency-Key sudah dipakai dengan payload berbeda');
        }
        return {
          trade: toTradeView(existing),
          replayed: true,
          balanceMinor: Number(this.deps.wallets.get(input.userId, existing.currency).balance_minor),
        };
      }
    }

    const entryPrice = this.deps.engine.lastPrice(market.symbol);
    if (entryPrice === null) {
      throw new AppError('CONFLICT', 409, 'Harga market belum tersedia, coba lagi sebentar');
    }
    const serverNow = this.deps.clock.now();
    const expiry = serverNow + input.durationSec * 1000;
    const id = newId();

    try {
      return this.db.transaction(() => {
        const open = this.db.all<{ currency: string }>(
          `SELECT currency FROM trades WHERE user_id = ? AND status = 'open' LIMIT 1`,
          input.userId,
        );
        // The user picks a currency when the first trade opens; while any trade
        // is open the currency cannot be switched (keeps the ledger readable).
        if (open.length && open[0].currency !== input.currency) {
          throw new AppError('CURRENCY_LOCKED', 422, 'Tutup semua trade dulu sebelum mengganti mata uang', {
            lockedCurrency: open[0].currency,
          });
        }
        const openCount = this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'`,
          input.userId,
        );
        const maxOpen = Math.min(settings.maxOpenTradesPerUser, settings.maxOpenTrades);
        if (Number(openCount?.n ?? 0) >= maxOpen) {
          throw AppError.unprocessable('TRADE_LIMIT_REACHED', `Maksimum ${maxOpen} trade terbuka`);
        }
        const limit = market.exposure_limit_usd_minor;
        if (limit) {
          const exposure = this.deps.markets.openExposureUsdMinor(market.symbol, settings.rates);
          const scale = input.currency === 'IDR' ? 1 : 100;
          const thisUsd = Math.round((input.amountMinor / scale / (settings.rates[input.currency] ?? 1)) * 100);
          if (exposure + thisUsd > limit) {
            throw new AppError('EXPOSURE_LIMIT', 422, 'Exposure market ini sudah mencapai batas', {
              exposureUsd: exposure / 100,
              limitUsd: limit / 100,
            });
          }
        }

        // The debit, the ledger entry and the trade insert share this
        // BEGIN IMMEDIATE transaction - two parallel requests cannot overdraw.
        const balanceAfter = this.deps.wallets.debit(input.userId, input.currency, input.amountMinor, {
          kind: 'trade_stake',
          refType: 'trade',
          refId: id,
        });

        this.db.run(
          `INSERT INTO trades (id, user_id, market, direction, currency, amount_minor, duration_sec,
                               entry_price, entry_time, expiry_time, status, payout_rate, payout_mode,
                               idempotency_key, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
          id,
          input.userId,
          market.symbol,
          input.direction,
          input.currency,
          input.amountMinor,
          input.durationSec,
          entryPrice,
          serverNow,
          expiry,
          payoutRate,
          settings.payoutMode,
          input.idempotencyKey ?? null,
          input.requestHash ?? null,
          serverNow,
        );

        recordAudit(this.db, {
          actorUserId: input.userId,
          actorRole: 'user',
          action: 'trade.opened',
          targetType: 'trade',
          targetId: id,
          meta: {
            market: market.symbol,
            direction: input.direction,
            currency: input.currency,
            amountMinor: input.amountMinor,
            durationSec: input.durationSec,
            entryPrice,
            expiryTime: expiry,
            payoutRate,
          },
          ip: input.ip ?? null,
          now: serverNow,
        });

        const row = this.db.get<TradeRow>('SELECT * FROM trades WHERE id = ?', id) as TradeRow;
        return { trade: toTradeView(row), replayed: false, balanceMinor: balanceAfter };
      });
    } catch (err) {
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = this.findByIdempotency(input.userId, input.idempotencyKey);
        if (existing) {
          return {
            trade: toTradeView(existing),
            replayed: true,
            balanceMinor: Number(this.deps.wallets.get(input.userId, existing.currency).balance_minor),
          };
        }
      }
      throw err;
    }
  }

  findByIdempotency(userId: string, key: string): TradeRow | undefined {
    return this.db.get<TradeRow>('SELECT * FROM trades WHERE user_id = ? AND idempotency_key = ?', userId, key);
  }

  row(id: string): TradeRow | undefined {
    return this.db.get<TradeRow>('SELECT * FROM trades WHERE id = ?', id);
  }

  getForUser(userId: string, tradeId: string): TradeView {
    const row = this.row(tradeId);
    if (!row || row.user_id !== userId) throw AppError.notFound('Trade tidak ditemukan');
    return this.withEstimate(toTradeView(row));
  }

  listForUser(opts: {
    userId: string;
    status?: 'open' | 'closed';
    market?: string;
    result?: TradeResult;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
  }): TradeView[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const clauses = ['user_id = ?'];
    const params: Array<string | number> = [opts.userId];
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.market) {
      clauses.push('market = ?');
      params.push(opts.market.toUpperCase());
    }
    if (opts.result) {
      clauses.push('result = ?');
      params.push(opts.result);
    }
    if (opts.from !== undefined) {
      clauses.push('created_at >= ?');
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      clauses.push('created_at <= ?');
      params.push(opts.to);
    }
    params.push(limit, offset);
    return this.db
      .all<TradeRow>(
        `SELECT * FROM trades WHERE ${clauses.join(' AND ')}
         ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?`,
        ...params,
      )
      .map((row) => this.withEstimate(toTradeView(row)));
  }

  countForUser(opts: {
    userId: string;
    status?: 'open' | 'closed';
    market?: string;
    result?: TradeResult;
    from?: number;
    to?: number;
  }): number {
    const clauses = ['user_id = ?'];
    const params: Array<string | number> = [opts.userId];
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.market) {
      clauses.push('market = ?');
      params.push(opts.market.toUpperCase());
    }
    if (opts.result) {
      clauses.push('result = ?');
      params.push(opts.result);
    }
    if (opts.from !== undefined) {
      clauses.push('created_at >= ?');
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      clauses.push('created_at <= ?');
      params.push(opts.to);
    }
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trades WHERE ${clauses.join(' AND ')}`,
      ...params,
    );
    return Number(row?.n ?? 0);
  }

  countOpen(userId: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'`,
      userId,
    );
    return Number(row?.n ?? 0);
  }

  /** The currency the user is locked into (if any open trade exists). */
  lockedCurrency(userId: string): Currency | null {
    const row = this.db.get<{ currency: Currency }>(
      `SELECT currency FROM trades WHERE user_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1`,
      userId,
    );
    return row?.currency ?? null;
  }

  private withEstimate(view: TradeView): TradeView {
    if (view.status !== 'open') return view;
    const live = this.deps.engine.lastPrice(view.market);
    if (live === null) return { ...view, livePrice: null, estimatedResult: 'pending', estimatedPayout: null };
    const result = decideResult(view.direction, view.entryPrice, live);
    const payout = computePayoutMinor(view.amountMinor, view.payoutRate, view.payoutMode, result);
    return {
      ...view,
      livePrice: live,
      estimatedResult: result,
      estimatedPayout: toMajor(payout, view.currency),
    };
  }

  /**
   * Settles one open trade at `closePrice`. The conditional UPDATE claims the
   * row, so a restart/settlement race can never pay twice.
   */
  settle(
    row: TradeRow,
    closePrice: number,
    opts: {
      now: number;
      settledBy: 'expiry' | 'admin';
      reason?: string | null;
      actorUserId?: string | null;
      ip?: string | null;
    },
  ): { trade: TradeView; balanceMinor: number } | null {
    if (row.status === 'closed') return null;
    const result = decideResult(row.direction, Number(row.entry_price), closePrice);
    const payoutMinor = computePayoutMinor(Number(row.amount_minor), Number(row.payout_rate), row.payout_mode, result);

    const settled = this.db.transaction(() => {
      const claim = this.db.run(
        `UPDATE trades SET status = 'closed', result = ?, close_price = ?, settled_at = ?, payout_minor = ?,
                           settled_by = ?, settle_reason = ?
          WHERE id = ? AND status = 'open'`,
        result,
        closePrice,
        opts.now,
        payoutMinor,
        opts.settledBy,
        opts.reason ?? null,
        row.id,
      );
      if (claim.changes === 0) return null;

      const balanceMinor =
        payoutMinor > 0
          ? this.deps.wallets.credit(row.user_id, row.currency, payoutMinor, {
              kind: result === 'draw' ? 'trade_refund' : 'trade_payout',
              refType: 'trade',
              refId: row.id,
            })
          : this.deps.wallets.get(row.user_id, row.currency).balance_minor;

      recordAudit(this.db, {
        actorUserId: opts.actorUserId ?? null,
        actorRole: opts.settledBy === 'admin' ? 'admin' : 'system',
        action: opts.settledBy === 'admin' ? 'admin.trade_settled' : 'trade.settled',
        targetType: 'trade',
        targetId: row.id,
        meta: {
          result,
          entryPrice: Number(row.entry_price),
          closePrice,
          payoutMinor,
          amountMinor: Number(row.amount_minor),
          reason: opts.reason ?? null,
        },
        ip: opts.ip ?? null,
        now: opts.now,
      });

      const updated = this.row(row.id) as TradeRow;
      return { trade: toTradeView(updated), balanceMinor };
    });

    if (settled) this.events.emit('settled', settled);
    return settled;
  }

  settleDue(now = this.deps.clock.now()): Array<{ trade: TradeView; balanceMinor: number }> {
    const due = this.db.all<TradeRow>(
      `SELECT * FROM trades WHERE status = 'open' AND expiry_time <= ? ORDER BY expiry_time ASC LIMIT 200`,
      now,
    );
    const settled: Array<{ trade: TradeView; balanceMinor: number }> = [];
    for (const row of due) {
      const closePrice = this.deps.engine.priceAt(row.market, Number(row.expiry_time)) ?? Number(row.entry_price);
      try {
        const done = this.settle(row, closePrice, { now, settledBy: 'expiry', reason: null });
        if (done) settled.push(done);
      } catch (err) {
        this.deps.logger.error({ err, tradeId: row.id }, 'gagal settle trade');
      }
    }
    return settled;
  }

  voidAtEntry(tradeId: string, reason: string, actorUserId: string | null, ip?: string | null): TradeView | null {
    const row = this.row(tradeId);
    if (!row || row.status !== 'open') return null;
    const settled = this.settle(row, Number(row.entry_price), {
      now: this.deps.clock.now(),
      settledBy: 'admin',
      reason,
      actorUserId,
      ip,
    });
    return settled?.trade ?? null;
  }

  manualSettle(
    tradeId: string,
    opts: { closePrice?: number; reason: string; actorUserId: string; ip?: string | null },
  ): TradeView {
    const row = this.row(tradeId);
    if (!row) throw AppError.notFound('Trade tidak ditemukan');
    if (row.status !== 'open') throw AppError.conflict('Trade sudah diselesaikan');
    const price =
      opts.closePrice ??
      this.deps.engine.priceAt(row.market, this.deps.clock.now()) ??
      this.deps.engine.lastPrice(row.market);
    if (price === null) throw AppError.conflict('Tidak ada harga untuk settlement manual');
    const result = this.settle(row, price, {
      now: this.deps.clock.now(),
      settledBy: 'admin',
      reason: opts.reason,
      actorUserId: opts.actorUserId,
      ip: opts.ip,
    });
    if (!result) throw AppError.conflict('Trade sudah diselesaikan');
    return result.trade;
  }

  announceOpened(trade: TradeView, balanceMinor: number): void {
    this.events.emit('opened', { trade, balanceMinor });
  }

  /** Aggregates used by the admin trade statistics screen. */
  stats(opts: { from?: number; to?: number } = {}): {
    byMarket: Array<{
      market: string;
      count: number;
      win: number;
      lose: number;
      draw: number;
      volumeMinor: number;
      payoutMinor: number;
    }>;
    byDuration: Array<{
      durationSec: number;
      count: number;
      win: number;
      lose: number;
      draw: number;
      volumeMinor: number;
      payoutMinor: number;
    }>;
  } {
    const clauses: string[] = [`status = 'closed'`];
    const params: number[] = [];
    if (opts.from !== undefined) {
      clauses.push('created_at >= ?');
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      clauses.push('created_at <= ?');
      params.push(opts.to);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const byMarket = this.db.all<{
      market: string;
      count: number;
      win: number;
      lose: number;
      draw: number;
      volumeMinor: number;
      payoutMinor: number;
    }>(
      `SELECT market, COUNT(*) AS count,
              SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS win,
              SUM(CASE WHEN result = 'lose' THEN 1 ELSE 0 END) AS lose,
              SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draw,
              SUM(amount_minor) AS volumeMinor, SUM(payout_minor) AS payoutMinor
         FROM trades ${where} GROUP BY market ORDER BY count DESC`,
      ...params,
    );
    const byDuration = this.db.all<{
      durationSec: number;
      count: number;
      win: number;
      lose: number;
      draw: number;
      volumeMinor: number;
      payoutMinor: number;
    }>(
      `SELECT duration_sec AS durationSec, COUNT(*) AS count,
              SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS win,
              SUM(CASE WHEN result = 'lose' THEN 1 ELSE 0 END) AS lose,
              SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draw,
              SUM(amount_minor) AS volumeMinor, SUM(payout_minor) AS payoutMinor
         FROM trades ${where} GROUP BY duration_sec ORDER BY duration_sec`,
      ...params,
    );
    const num = <T extends Record<string, unknown>>(rows: T[]) =>
      rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row))
          out[key] = typeof value === 'bigint' ? Number(value) : (value ?? 0);
        return out;
      });
    return {
      byMarket: num(byMarket) as unknown as Array<{
        market: string;
        count: number;
        win: number;
        lose: number;
        draw: number;
        volumeMinor: number;
        payoutMinor: number;
      }>,
      byDuration: num(byDuration) as unknown as Array<{
        durationSec: number;
        count: number;
        win: number;
        lose: number;
        draw: number;
        volumeMinor: number;
        payoutMinor: number;
      }>,
    };
  }
}
