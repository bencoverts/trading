import type { Database } from '../db/sqlite.js';
import type { PriceEngine } from '../price/engine.js';
import type { SettingsService } from './settings.js';
import type { WalletService } from './wallets.js';
import type { MarketService } from './markets.js';
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
  /** server-computed live estimate for open trades */
  livePrice?: number | null;
  estimatedResult?: TradeResult | 'pending' | null;
  estimatedPayout?: number | null;
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

export class TradeService {
  readonly events = new Emitter<TradeEvents>();

  constructor(private readonly deps: TradeServiceDeps) {}

  private get db(): Database {
    return this.deps.db;
  }

  /** Business rules that do not need the database. */
  validateIntent(input: { market: string; currency: Currency; amountMinor: number; durationSec: number }): void {
    const settings = this.deps.settings.get();
    const market = this.deps.markets.requireRow(input.market);
    if (market.active !== 1) {
      throw new AppError('MARKET_CLOSED', 422, `Market ${market.symbol} is closed`);
    }
    if (market.paused === 1) {
      throw new AppError('MARKET_PAUSED', 422, `Market ${market.symbol} is paused`, { reason: market.pause_reason });
    }
    if (!Number.isInteger(input.durationSec) || input.durationSec < 5 || input.durationSec > 28_800) {
      throw AppError.unprocessable('DURATION_NOT_ALLOWED', 'durationSec must be between 5 and 28800');
    }
    if (!settings.allowedDurations.includes(input.durationSec)) {
      throw AppError.unprocessable('DURATION_NOT_ALLOWED', `durationSec must be one of ${settings.allowedDurations.join(', ')}`, {
        allowedDurations: settings.allowedDurations,
      });
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw AppError.badRequest('amount must be greater than 0');
    }
    const min = settings.minAmount[input.currency];
    const max = settings.maxAmount[input.currency];
    if (input.amountMinor < min || input.amountMinor > max) {
      throw AppError.unprocessable('AMOUNT_NOT_ALLOWED', `amount must be between ${min} and ${max} minor units`, {
        minMinor: min,
        maxMinor: max,
        currency: input.currency,
      });
    }
  }

  create(input: CreateTradeInput): { trade: TradeView; replayed: boolean; balanceMinor: number } {
    this.validateIntent(input);
    const settings = this.deps.settings.get();

    if (input.idempotencyKey) {
      const existing = this.findByIdempotency(input.userId, input.idempotencyKey);
      if (existing) {
        if (input.requestHash && existing.request_hash && existing.request_hash !== input.requestHash) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Idempotency-Key was already used with a different payload');
        }
        return {
          trade: toTradeView(existing),
          replayed: true,
          balanceMinor: Number(this.deps.wallets.get(input.userId, input.currency).balance_minor),
        };
      }
    }

    const entryPrice = this.deps.engine.lastPrice(input.market);
    if (entryPrice === null) {
      throw new AppError('CONFLICT', 409, 'Market price is not available yet, retry shortly');
    }
    const serverNow = this.deps.clock.now();
    const expiry = serverNow + input.durationSec * 1000;
    const id = newId();

    try {
      return this.db.transaction(() => {
        const open = this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'`,
          input.userId,
        );
        if (Number(open?.n ?? 0) >= settings.maxOpenTrades) {
          throw AppError.unprocessable('TRADE_LIMIT_REACHED', `Maximum ${settings.maxOpenTrades} open trades`);
        }

        // The debit and the trade insert happen in the same BEGIN IMMEDIATE
        // transaction - two parallel requests can never both spend the balance.
        const balanceAfter = this.deps.wallets.debit(input.userId, input.currency, input.amountMinor);

        this.db.run(
          `INSERT INTO trades (id, user_id, market, direction, currency, amount_minor, duration_sec,
                               entry_price, entry_time, expiry_time, status, payout_rate, payout_mode,
                               idempotency_key, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
          id,
          input.userId,
          input.market,
          input.direction,
          input.currency,
          input.amountMinor,
          input.durationSec,
          entryPrice,
          serverNow,
          expiry,
          settings.payoutRate,
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
            market: input.market,
            direction: input.direction,
            currency: input.currency,
            amountMinor: input.amountMinor,
            durationSec: input.durationSec,
            entryPrice,
            expiryTime: expiry,
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
            balanceMinor: Number(this.deps.wallets.get(input.userId, input.currency).balance_minor),
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
    if (!row || row.user_id !== userId) throw AppError.notFound('Trade not found');
    return this.withEstimate(toTradeView(row));
  }

  listForUser(opts: { userId: string; status?: 'open' | 'closed'; limit?: number; offset?: number }): TradeView[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const params: Array<string | number> = [opts.userId];
    let sql = 'SELECT * FROM trades WHERE user_id = ?';
    if (opts.status) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }
    sql += ` ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return this.db.all<TradeRow>(sql, ...params).map((row) => this.withEstimate(toTradeView(row)));
  }

  countOpen(userId: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'`,
      userId,
    );
    return Number(row?.n ?? 0);
  }

  /** Server-side live estimate for the open-trade list (never trusted from the client). */
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
    opts: { now: number; settledBy: 'expiry' | 'admin'; reason?: string | null; actorUserId?: string | null; ip?: string | null },
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

      const balanceMinor = payoutMinor > 0 ? this.deps.wallets.credit(row.user_id, row.currency, payoutMinor) : this.deps.wallets.get(row.user_id, row.currency).balance_minor;

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

  /**
   * Settles every trade whose expiry passed. Called on an interval and once at
   * boot (which is how trades that expired during downtime get completed).
   */
  settleDue(now = this.deps.clock.now()): Array<{ trade: TradeView; balanceMinor: number }> {
    const due = this.db.all<TradeRow>(
      `SELECT * FROM trades WHERE status = 'open' AND expiry_time <= ? ORDER BY expiry_time ASC LIMIT 200`,
      now,
    );
    const settled: Array<{ trade: TradeView; balanceMinor: number }> = [];
    for (const row of due) {
      // Price at the exact expiry instant. When absent (server was down for the
      // whole window) the outcome is unknowable, so the stake is refunded.
      const closePrice = this.deps.engine.priceAt(row.market, Number(row.expiry_time)) ?? Number(row.entry_price);
      try {
        const done = this.settle(row, closePrice, { now, settledBy: 'expiry', reason: null });
        if (done) settled.push(done);
      } catch (err) {
        this.deps.logger.error({ err, tradeId: row.id }, 'failed to settle trade');
      }
    }
    return settled;
  }

  /** Voids a trade at its entry price (full refund) - used by the demo balance reset. */
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

  /** Admin manual settlement for exceptional cases (audited, reason required). */
  manualSettle(
    tradeId: string,
    opts: { closePrice?: number; reason: string; actorUserId: string; ip?: string | null },
  ): TradeView {
    const row = this.row(tradeId);
    if (!row) throw AppError.notFound('Trade not found');
    if (row.status !== 'open') throw AppError.conflict('Trade is already settled');
    const price = opts.closePrice ?? this.deps.engine.priceAt(row.market, this.deps.clock.now());
    if (price === null) throw AppError.conflict('No price available for manual settlement');
    const result = this.settle(row, price, {
      now: this.deps.clock.now(),
      settledBy: 'admin',
      reason: opts.reason,
      actorUserId: opts.actorUserId,
      ip: opts.ip,
    });
    if (!result) throw AppError.conflict('Trade is already settled');
    return result.trade;
  }

  announceOpened(trade: TradeView, balanceMinor: number): void {
    this.events.emit('opened', { trade, balanceMinor });
  }
}
