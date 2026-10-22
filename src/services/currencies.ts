import type { Database } from '../db/sqlite.js';
import { AppError } from '../lib/errors.js';
import { recordAudit } from './audit.js';
import { CURRENCY_LIST, type Currency } from '../domain/constants.js';
import { toMajor } from '../domain/money.js';

export interface CurrencyRow {
  code: Currency;
  name: string;
  symbol: string;
  decimals: number;
  active: number;
  deposit_enabled: number;
  withdrawal_enabled: number;
  trading_enabled: number;
  min_deposit_minor: number | null;
  max_deposit_minor: number | null;
  min_withdrawal_minor: number | null;
  max_withdrawal_minor: number | null;
  withdrawal_fee_minor: number;
  withdrawal_fee_bps: number;
  fx_rate_to_idr: number | null;
  fx_source: string | null;
  fx_updated_at: number | null;
  sort_order: number;
  updated_at: number;
}

export interface CurrencyView {
  code: Currency;
  name: string;
  symbol: string;
  decimals: number;
  active: boolean;
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
  tradingEnabled: boolean;
  minDeposit: number | null;
  maxDeposit: number | null;
  minWithdrawal: number | null;
  maxWithdrawal: number | null;
  withdrawalFee: number;
  withdrawalFeeBps: number;
  fxRateToIdr: number | null;
  fxSource: string | null;
  fxUpdatedAt: number | null;
  sortOrder: number;
}

export interface CurrencyPatch {
  name?: string;
  symbol?: string;
  active?: boolean;
  depositEnabled?: boolean;
  withdrawalEnabled?: boolean;
  tradingEnabled?: boolean;
  minDeposit?: number | null;
  maxDeposit?: number | null;
  minWithdrawal?: number | null;
  maxWithdrawal?: number | null;
  withdrawalFee?: number;
  withdrawalFeeBps?: number;
  fxRateToIdr?: number | null;
  fxSource?: string | null;
  sortOrder?: number;
}

export function viewOfCurrency(row: CurrencyRow): CurrencyView {
  const view = (minor: number | null) => (minor === null ? null : toMajor(Number(minor), row.code));
  return {
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    active: row.active === 1,
    depositEnabled: row.deposit_enabled === 1,
    withdrawalEnabled: row.withdrawal_enabled === 1,
    tradingEnabled: row.trading_enabled === 1,
    minDeposit: view(row.min_deposit_minor),
    maxDeposit: view(row.max_deposit_minor),
    minWithdrawal: view(row.min_withdrawal_minor),
    maxWithdrawal: view(row.max_withdrawal_minor),
    withdrawalFee: toMajor(Number(row.withdrawal_fee_minor), row.code),
    withdrawalFeeBps: Number(row.withdrawal_fee_bps),
    fxRateToIdr: row.fx_rate_to_idr === null ? null : Number(row.fx_rate_to_idr),
    fxSource: row.fx_source,
    fxUpdatedAt: row.fx_updated_at === null ? null : Number(row.fx_updated_at),
    sortOrder: Number(row.sort_order),
  };
}

/**
 * Currency catalogue. Withdrawals, deposits and trading are gated here so a
 * disabled currency can never be used even if a client asks for it directly.
 * Disabling a currency never deletes balances: rows in `wallets` stay intact.
 */
export class CurrencyService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  rows(): CurrencyRow[] {
    const rows = this.db.all<CurrencyRow>('SELECT * FROM currencies ORDER BY sort_order, code');
    // The migration inserts the three known currencies; this keeps a restored or
    // partially seeded database usable without inventing exchange rates.
    if (rows.length === CURRENCY_LIST.length) return rows;
    return CURRENCY_LIST.map(
      (code) =>
        rows.find((row) => row.code === code) ??
        ({
          code,
          name: code,
          symbol: code,
          decimals: code === 'IDR' ? 0 : 2,
          active: 0,
          deposit_enabled: 0,
          withdrawal_enabled: 0,
          trading_enabled: 0,
          min_deposit_minor: null,
          max_deposit_minor: null,
          min_withdrawal_minor: null,
          max_withdrawal_minor: null,
          withdrawal_fee_minor: 0,
          withdrawal_fee_bps: 0,
          fx_rate_to_idr: null,
          fx_source: null,
          fx_updated_at: null,
          sort_order: 99,
          updated_at: 0,
        } as CurrencyRow),
    );
  }

  list(opts: { includeInactive?: boolean } = {}): CurrencyView[] {
    return this.rows()
      .filter((row) => opts.includeInactive || row.active === 1)
      .map(viewOfCurrency);
  }

  get(code: string): CurrencyRow {
    if (!(CURRENCY_LIST as readonly string[]).includes(code)) {
      throw new AppError('CURRENCY_NOT_FOUND', 404, `Mata uang ${code} tidak dikenal`);
    }
    const row = this.rows().find((item) => item.code === code);
    if (!row) throw new AppError('CURRENCY_NOT_FOUND', 404, `Mata uang ${code} tidak dikenal`);
    return row;
  }

  getView(code: string): CurrencyView {
    return viewOfCurrency(this.get(code));
  }

  /** Throws unless the currency may be used for the given purpose right now. */
  requireEnabled(code: string, purpose: 'deposit' | 'withdrawal' | 'trading'): CurrencyRow {
    const row = this.get(code);
    if (row.active !== 1) {
      throw new AppError('CURRENCY_INACTIVE', 409, `Mata uang ${code} sedang tidak aktif`);
    }
    const flag =
      purpose === 'deposit'
        ? row.deposit_enabled
        : purpose === 'withdrawal'
          ? row.withdrawal_enabled
          : row.trading_enabled;
    if (flag !== 1) {
      throw new AppError('CURRENCY_NOT_AVAILABLE', 409, `Mata uang ${code} tidak tersedia untuk ${purpose}`);
    }
    return row;
  }

  update(code: string, patch: CurrencyPatch, ctx: { actorUserId: string; ip?: string | null }): CurrencyView {
    const row = this.get(code);
    const now = this.now();
    const next = {
      name: patch.name?.trim() ?? row.name,
      symbol: patch.symbol?.trim() ?? row.symbol,
      active: patch.active === undefined ? row.active : patch.active ? 1 : 0,
      deposit_enabled: patch.depositEnabled === undefined ? row.deposit_enabled : patch.depositEnabled ? 1 : 0,
      withdrawal_enabled:
        patch.withdrawalEnabled === undefined ? row.withdrawal_enabled : patch.withdrawalEnabled ? 1 : 0,
      trading_enabled: patch.tradingEnabled === undefined ? row.trading_enabled : patch.tradingEnabled ? 1 : 0,
      min_deposit_minor:
        patch.minDeposit === undefined
          ? row.min_deposit_minor
          : patch.minDeposit === null
            ? null
            : Math.round(patch.minDeposit * 10 ** row.decimals),
      max_deposit_minor:
        patch.maxDeposit === undefined
          ? row.max_deposit_minor
          : patch.maxDeposit === null
            ? null
            : Math.round(patch.maxDeposit * 10 ** row.decimals),
      min_withdrawal_minor:
        patch.minWithdrawal === undefined
          ? row.min_withdrawal_minor
          : patch.minWithdrawal === null
            ? null
            : Math.round(patch.minWithdrawal * 10 ** row.decimals),
      max_withdrawal_minor:
        patch.maxWithdrawal === undefined
          ? row.max_withdrawal_minor
          : patch.maxWithdrawal === null
            ? null
            : Math.round(patch.maxWithdrawal * 10 ** row.decimals),
      withdrawal_fee_minor:
        patch.withdrawalFee === undefined
          ? row.withdrawal_fee_minor
          : Math.round(patch.withdrawalFee * 10 ** row.decimals),
      withdrawal_fee_bps: patch.withdrawalFeeBps ?? row.withdrawal_fee_bps,
      fx_rate_to_idr: patch.fxRateToIdr === undefined ? row.fx_rate_to_idr : patch.fxRateToIdr,
      fx_source: patch.fxSource === undefined ? row.fx_source : patch.fxSource,
      fx_updated_at: patch.fxRateToIdr === undefined ? row.fx_updated_at : now,
      sort_order: patch.sortOrder ?? row.sort_order,
    };
    if (
      next.min_deposit_minor != null &&
      next.max_deposit_minor != null &&
      next.min_deposit_minor > next.max_deposit_minor
    ) {
      throw AppError.badRequest('Batas deposit minimum tidak boleh melebihi maksimum');
    }
    if (
      next.min_withdrawal_minor != null &&
      next.max_withdrawal_minor != null &&
      next.min_withdrawal_minor > next.max_withdrawal_minor
    ) {
      throw AppError.badRequest('Batas penarikan minimum tidak boleh melebihi maksimum');
    }
    if (next.withdrawal_fee_minor < 0 || next.withdrawal_fee_bps < 0 || next.withdrawal_fee_bps > 10_000) {
      throw AppError.badRequest('Biaya penarikan tidak valid');
    }
    if (patch.active === false) {
      // Deactivating is a single, safe action: every dependent switch follows.
      next.deposit_enabled = 0;
      next.withdrawal_enabled = 0;
      next.trading_enabled = 0;
    }
    if (next.active === 0 && (next.deposit_enabled || next.withdrawal_enabled || next.trading_enabled)) {
      throw AppError.badRequest('Mata uang nonaktif tidak boleh mengaktifkan deposit/penarikan/trading');
    }
    if (code === 'IDR' && next.active === 0) {
      throw AppError.badRequest('IDR adalah mata uang dasar platform dan tidak dapat dinonaktifkan');
    }

    this.db.transaction(() => {
      this.db.run(
        `UPDATE currencies SET name = ?, symbol = ?, active = ?, deposit_enabled = ?, withdrawal_enabled = ?,
                trading_enabled = ?, min_deposit_minor = ?, max_deposit_minor = ?, min_withdrawal_minor = ?,
                max_withdrawal_minor = ?, withdrawal_fee_minor = ?, withdrawal_fee_bps = ?, fx_rate_to_idr = ?,
                fx_source = ?, fx_updated_at = ?, sort_order = ?, updated_at = ?
           WHERE code = ?`,
        next.name,
        next.symbol,
        next.active,
        next.deposit_enabled,
        next.withdrawal_enabled,
        next.trading_enabled,
        next.min_deposit_minor,
        next.max_deposit_minor,
        next.min_withdrawal_minor,
        next.max_withdrawal_minor,
        next.withdrawal_fee_minor,
        next.withdrawal_fee_bps,
        next.fx_rate_to_idr,
        next.fx_source,
        next.fx_updated_at,
        next.sort_order,
        now,
        code,
      );
      recordAudit(this.db, {
        actorUserId: ctx.actorUserId,
        actorRole: 'admin',
        action: 'admin.currency_updated',
        targetType: 'currency',
        targetId: code,
        meta: { patch },
        ip: ctx.ip ?? null,
        now,
      });
    });
    return this.getView(code);
  }
}
