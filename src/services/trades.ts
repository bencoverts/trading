import { randomUUID } from 'node:crypto';
import type { Db } from '../db/types.js';
import type { Config } from '../config.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { Emitter } from '../lib/emitter.js';
import { computePayoutCents, decideResult, type Direction, type PayoutMode, type TradeResult } from '../domain/payout.js';
import { recordAudit } from './audit.js';
import type { SettingsService } from './settings.js';

export interface TradeRow {
  id: string;
  user_id: string;
  symbol: string;
  direction: Direction;
  amount_cents: number;
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
  payout_cents: number;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: number;
}

export interface TradeDTO {
  id: string;
  userId: string;
  symbol: string;
  direction: Direction;
  amount: number;
  amountCents: number;
  durationSec: number;
  entryPrice: number;
  entryTime: number;
  expiryTime: number;
  closePrice: number | null;
  status: 'open' | 'closed';
  result: TradeResult | null;
  payoutRate: number;
  payoutMode: PayoutMode;
  /** amount returned to the balance when settled (stake included) */
  payout: number | null;
  payoutCents: number | null;
  /** payout - stake: the trader's net profit */
  profit: number | null;
  createdAt: number;
}

export interface PriceProvider {
  getLastPrice(): number | null;
  getPriceAt(time: number): number | null;
}

export interface CreateTradeInput {
  userId: string;
  symbol: string;
  direction: Direction;
  amountCents: number;
  durationSec: number;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  ip?: string | null;
}

export interface TradeEvents {
  opened: [{ trade: TradeDTO; balanceCents: number }];
  settled: [{ trade: TradeDTO; balanceCents: number }];
}

export interface TradeServiceDeps {
  db: Db;
  config: Config;
  clock: Clock;
  price: PriceProvider;
  settings: SettingsService;
  logger: Logger;
}

export function toTradeDTO(row: TradeRow): TradeDTO {
  const settled = row.status === 'closed';
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    direction: row.direction,
    amount: Number(row.amount_cents) / 100,
    amountCents: Number(row.amount_cents),
    durationSec: Number(row.duration_sec),
    entryPrice: Number(row.entry_price),
    entryTime: Number(row.entry_time),
    expiryTime: Number(row.expiry_time),
    closePrice: row.close_price === null ? null : Number(row.close_price),
    status: row.status,
    result: row.result,
    payoutRate: Number(row.payout_rate),
    payoutMode: row.payout_mode,
    payout: settled ? Number(row.payout_cents) / 100 : null,
    payoutCents: settled ? Number(row.payout_cents) : null,
    profit: settled ? (Number(row.payout_cents) - Number(row.amount_cents)) / 100 : null,
    createdAt: Number(row.created_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code === '23505') return true; // postgres unique_violation
  if (typeof e?.code === 'string' && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  return typeof e?.message === 'string' && /UNIQUE constraint failed|duplicate key value/i.test(e.message);
}

export class TradeService {
  readonly events = new Emitter<TradeEvents>();
  private readonly db: Db;

  constructor(private readonly deps: TradeServiceDeps) {
    this.db = deps.db;
  }

  get settings(): SettingsService {
    return this.deps.settings;
  }

  /** Validates business rules that do not need the database. */
  validateIntent(input: { symbol: string; durationSec: number; amountCents: number }): void {
    const s = this.settings.get();
    if (input.symbol !== this.deps.config.SYMBOL) {
      throw AppError.unprocessable('SYMBOL_INACTIVE', `Symbol "${input.symbol}" is not active`, {
        activeSymbols: [this.deps.config.SYMBOL],
      });
    }
    if (!s.allowedDurations.includes(input.durationSec)) {
      throw AppError.unprocessable('DURATION_NOT_ALLOWED', `durationSec must be one of ${s.allowedDurations.join(', ')}`, {
        allowedDurations: s.allowedDurations,
      });
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw AppError.badRequest('amount must be greater than 0');
    }
    if (input.amountCents < s.minAmountCents) {
      throw AppError.unprocessable('VALIDATION_ERROR', `Minimum stake is ${s.minAmountCents / 100}`, {
        minAmount: s.minAmountCents / 100,
      });
    }
    if (input.amountCents > s.maxAmountCents) {
      throw AppError.unprocessable('VALIDATION_ERROR', `Maximum stake is ${s.maxAmountCents / 100}`, {
        maxAmount: s.maxAmountCents / 100,
      });
    }
  }

  async create(input: CreateTradeInput): Promise<{ trade: TradeDTO; replayed: boolean; balanceCents: number }> {
    this.validateIntent(input);
    const settings = this.settings.get();

    // --- idempotency fast path ------------------------------------------------
    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(input.userId, input.idempotencyKey);
      if (existing) {
        if (input.requestHash && existing.request_hash && existing.request_hash !== input.requestHash) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Idempotency-Key was already used with a different payload');
        }
        return {
          trade: toTradeDTO(existing),
          replayed: true,
          balanceCents: await this.getBalanceCents(input.userId),
        };
      }
    }

    const entryPrice = this.deps.price.getLastPrice();
    if (entryPrice === null) {
      throw new AppError('PRICE_UNAVAILABLE', 503, 'Price feed is not ready yet, retry shortly');
    }

    const now = this.deps.clock.now();
    const expiry = now + input.durationSec * 1000;
    const id = randomUUID();

    try {
      return await this.db.tx(async (t) => {
        const openRow = await t.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'`,
          [input.userId],
        );
        if (Number(openRow?.n ?? 0) >= settings.maxOpenTrades) {
          throw new AppError('TRADE_LIMIT_REACHED', 422, `Maximum ${settings.maxOpenTrades} open trades per account`);
        }

        // Hold the stake atomically - the CHECK (balance >= 0) is the last line of defence.
        const hold = await t.run(
          `UPDATE accounts SET balance_cents = balance_cents - ?, updated_at = ?
           WHERE user_id = ? AND balance_cents >= ?`,
          [input.amountCents, now, input.userId, input.amountCents],
        );
        if (hold.changes === 0) {
          throw new AppError('INSUFFICIENT_FUNDS', 422, 'Insufficient demo balance', {
            required: input.amountCents / 100,
          });
        }

        await t.run(
          `INSERT INTO trades (
             id, user_id, symbol, direction, amount_cents, duration_sec, entry_price, entry_time,
             expiry_time, close_price, settled_at, status, result, payout_rate, payout_mode,
             payout_cents, idempotency_key, request_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'open', NULL, ?, ?, 0, ?, ?, ?)`,
          [
            id,
            input.userId,
            input.symbol,
            input.direction,
            input.amountCents,
            input.durationSec,
            entryPrice,
            now,
            expiry,
            settings.payoutRate,
            settings.payoutMode,
            input.idempotencyKey ?? null,
            input.requestHash ?? null,
            now,
          ],
        );

        const created = await t.get<TradeRow>(`SELECT * FROM trades WHERE id = ?`, [id]);
        if (!created) throw new Error('trade insert failed');
        const account = await t.get<{ balance_cents: number }>(
          `SELECT balance_cents FROM accounts WHERE user_id = ?`,
          [input.userId],
        );

        await recordAudit(
          t,
          {
            userId: input.userId,
            actor: 'user',
            action: 'trade_opened',
            tradeId: id,
            ip: input.ip,
            meta: {
              symbol: input.symbol,
              direction: input.direction,
              amountCents: input.amountCents,
              durationSec: input.durationSec,
              entryPrice,
              expiryTime: expiry,
            },
          },
          now,
        );

        const dto = toTradeDTO(created);
        const balanceCents = Number(account?.balance_cents ?? 0);
        return { trade: dto, replayed: false, balanceCents };
      });
    } catch (err) {
      // A concurrent request with the same Idempotency-Key: return the winner's trade.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findByIdempotencyKey(input.userId, input.idempotencyKey);
        if (existing) {
          return { trade: toTradeDTO(existing), replayed: true, balanceCents: await this.getBalanceCents(input.userId) };
        }
      }
      throw err;
    }
  }

  /** Emits the realtime event after the transaction committed. */
  announceOpened(trade: TradeDTO, balanceCents: number): void {
    this.events.emit('opened', { trade, balanceCents });
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<TradeRow | undefined> {
    return this.db.get<TradeRow>(`SELECT * FROM trades WHERE user_id = ? AND idempotency_key = ?`, [userId, key]);
  }

  async getTrade(userId: string, tradeId: string): Promise<TradeDTO> {
    const row = await this.db.get<TradeRow>(`SELECT * FROM trades WHERE id = ?`, [tradeId]);
    if (!row || row.user_id !== userId) throw AppError.notFound('Trade not found');
    return toTradeDTO(row);
  }

  async listTrades(opts: { userId: string; status?: 'open' | 'closed'; limit?: number }): Promise<TradeDTO[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: unknown[] = [opts.userId];
    let sql = `SELECT * FROM trades WHERE user_id = ?`;
    if (opts.status) {
      sql += ` AND status = ?`;
      params.push(opts.status);
    } else {
      // open trades first, then newest closed ones
      sql += ` ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`;
      params.push(limit);
      const rows = await this.db.all<TradeRow>(sql, params);
      return rows.map(toTradeDTO);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = await this.db.all<TradeRow>(sql, params);
    return rows.map(toTradeDTO);
  }

  async getBalanceCents(userId: string): Promise<number> {
    const row = await this.db.get<{ balance_cents: number }>(`SELECT balance_cents FROM accounts WHERE user_id = ?`, [userId]);
    if (!row) throw AppError.notFound('Account not found');
    return Number(row.balance_cents);
  }

  /**
   * Settles one open trade. The conditional UPDATE acts as a claim so two
   * settlement workers (or a restart racing a timer) can never pay twice.
   */
  async settleOne(row: TradeRow, closePrice: number, now = this.deps.clock.now()): Promise<{ trade: TradeDTO; balanceCents: number } | null> {
    if (row.status === 'closed') return null;

    const result = decideResult(row.direction, Number(row.entry_price), closePrice);
    const payoutCents = computePayoutCents(Number(row.amount_cents), Number(row.payout_rate), row.payout_mode, result);

    const settled = await this.db.tx(async (t) => {
      const claim = await t.run(
        `UPDATE trades SET status = 'closed', result = ?, close_price = ?, settled_at = ?, payout_cents = ?
         WHERE id = ? AND status = 'open'`,
        [result, closePrice, now, payoutCents, row.id],
      );
      if (claim.changes === 0) return null;

      if (payoutCents > 0) {
        const credit = await t.run(
          `UPDATE accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ?`,
          [payoutCents, now, row.user_id],
        );
        if (credit.changes === 0) throw new Error(`account missing for user ${row.user_id}`);
      }

      await recordAudit(
        t,
        {
          userId: row.user_id,
          actor: 'system',
          action: 'trade_settled',
          tradeId: row.id,
          meta: {
            result,
            entryPrice: Number(row.entry_price),
            closePrice,
            payoutCents,
            amountCents: Number(row.amount_cents),
            payoutRate: Number(row.payout_rate),
            payoutMode: row.payout_mode,
          },
        },
        now,
      );

      const updated = await t.get<TradeRow>(`SELECT * FROM trades WHERE id = ?`, [row.id]);
      const account = await t.get<{ balance_cents: number }>(
        `SELECT balance_cents FROM accounts WHERE user_id = ?`,
        [row.user_id],
      );
      if (!updated) throw new Error('trade disappeared during settlement');
      return { trade: toTradeDTO(updated), balanceCents: Number(account?.balance_cents ?? 0) };
    });

    if (!settled) return null;
    this.events.emit('settled', settled);
    return settled;
  }

  /** Settles all trades whose expiry has passed. Returns what was settled. */
  async settleDue(now = this.deps.clock.now()): Promise<Array<{ trade: TradeDTO; balanceCents: number }>> {
    const due = await this.db.all<TradeRow>(
      `SELECT * FROM trades WHERE status = 'open' AND expiry_time <= ? ORDER BY expiry_time ASC LIMIT 200`,
      [now],
    );
    const settled: Array<{ trade: TradeDTO; balanceCents: number }> = [];
    for (const row of due) {
      // The close price is the last tick at or before expiry. If none exists
      // (e.g. the trade expired while the server was down) the market outcome
      // for that instant is unknown, so the stake is refunded as a draw.
      const closePrice = this.deps.price.getPriceAt(Number(row.expiry_time)) ?? Number(row.entry_price);
      try {
        const done = await this.settleOne(row, closePrice, now);
        if (done) settled.push(done);
      } catch (err) {
        this.deps.logger.error({ err, tradeId: row.id }, 'failed to settle trade');
      }
    }
    return settled;
  }

  async countOpenTrades(userId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND status = 'open'`,
      [userId],
    );
    return Number(row?.n ?? 0);
  }
}
