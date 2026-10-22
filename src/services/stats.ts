import type { Database } from '../db/sqlite.js';
import type { Currency } from '../domain/constants.js';

export interface DashboardStats {
  users: { total: number; activeToday: number; newToday: number; staff: number; blocked: number };
  trades: {
    today: number;
    open: number;
    settledToday: number;
    volumeTodayMinor: number;
    payoutTodayMinor: number;
    profitTodayMinor: number;
    volumeTotalMinor: number;
    payoutTotalMinor: number;
  };
  markets: Array<{ symbol: string; name: string; status: string; trades24h: number; volume24hMinor: number }>;
  wallets: Array<{ currency: Currency; totalMinor: number }>;
  perHour: Array<{ hour: number; trades: number; volumeMinor: number }>;
  perDay: Array<{ day: string; trades: number; volumeMinor: number; payoutMinor: number }>;
  activity: Array<{ at: number; kind: string; label: string; actor: string | null; amountMinor: number | null }>;
  alerts: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string }>;
}

const DAY = 86_400_000;

/**
 * Read-only aggregation for the admin dashboard. All monetary values are in
 * minor units and labelled as simulated.
 */
export class StatsService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  dashboard(opts: {
    wsConnections: number;
    wsDropped: number;
    jobsStale: string[];
    diskFreeMb: number | null;
  }): DashboardStats {
    const now = this.now();
    const dayStart = Math.floor(now / DAY) * DAY;

    const userRow = this.db.get<{ total: number; staff: number; blocked: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN staff_role IS NOT NULL THEN 1 ELSE 0 END) AS staff,
              SUM(CASE WHEN blocked_at IS NOT NULL THEN 1 ELSE 0 END) AS blocked
         FROM users`,
    );
    const activeToday = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?', dayStart);
    const newToday = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', dayStart);

    const tradeToday = this.db.get<{ n: number; volume: number; payout: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS volume, COALESCE(SUM(payout_minor), 0) AS payout
         FROM trades WHERE created_at >= ?`,
      dayStart,
    );
    const settledToday = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM trades WHERE settled_at >= ?`, dayStart);
    const openTrades = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trades WHERE status = 'open'");
    const totals = this.db.get<{ volume: number; payout: number }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS volume, COALESCE(SUM(payout_minor), 0) AS payout FROM trades WHERE status = 'closed'`,
    );

    const markets = this.db.all<{
      symbol: string;
      name: string;
      active: number;
      paused: number;
      is_draft: number;
      deleted_at: number | null;
      trades24h: number;
      volume24h: number;
    }>(
      `SELECT m.symbol, m.name, m.active, m.paused, m.is_draft, m.deleted_at,
              (SELECT COUNT(*) FROM trades t WHERE t.market = m.symbol AND t.created_at >= ?) AS trades24h,
              (SELECT COALESCE(SUM(amount_minor), 0) FROM trades t WHERE t.market = m.symbol AND t.created_at >= ?) AS volume24h
         FROM markets m WHERE m.deleted_at IS NULL ORDER BY m.sort_order, m.symbol`,
      now - DAY,
      now - DAY,
    );

    const wallets = this.db.all<{ currency: Currency; totalMinor: number }>(
      'SELECT currency, SUM(balance_minor) AS totalMinor FROM wallets GROUP BY currency',
    );

    const perHourRows = this.db.all<{ hour: number; trades: number; volume: number }>(
      `SELECT CAST(strftime('%H', created_at / 1000, 'unixepoch') AS INTEGER) AS hour,
              COUNT(*) AS trades, COALESCE(SUM(amount_minor), 0) AS volume
         FROM trades WHERE created_at >= ? GROUP BY hour ORDER BY hour`,
      now - DAY,
    );

    const perDayRows = this.db.all<{ day: string; trades: number; volume: number; payout: number }>(
      `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS trades,
              COALESCE(SUM(amount_minor), 0) AS volume, COALESCE(SUM(payout_minor), 0) AS payout
         FROM trades WHERE created_at >= ? GROUP BY day ORDER BY day`,
      now - 14 * DAY,
    );

    const activityRows = this.db.all<{ created_at: number; action: string; actor: string | null; meta: string | null }>(
      `SELECT a.created_at, a.action, u.username AS actor, a.meta
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.id DESC LIMIT 20`,
    );

    const alerts: DashboardStats['alerts'] = [];
    for (const job of opts.jobsStale) {
      alerts.push({ level: 'warn', code: 'JOB_STALE', message: `Job "${job}" tidak berjalan sesuai jadwal` });
    }
    if (opts.diskFreeMb !== null && opts.diskFreeMb < 512) {
      alerts.push({
        level: 'error',
        code: 'DISK_LOW',
        message: `Ruang disk tersisa ±${Math.round(opts.diskFreeMb)} MB`,
      });
    }
    if (opts.wsDropped > 50) {
      alerts.push({
        level: 'warn',
        code: 'WS_DROPS',
        message: `${opts.wsDropped} koneksi WebSocket terputus dalam 10 menit terakhir`,
      });
    }
    if (opts.wsConnections > 400) {
      alerts.push({ level: 'info', code: 'WS_LOAD', message: `${opts.wsConnections} koneksi WebSocket aktif` });
    }

    return {
      users: {
        total: Number(userRow?.total ?? 0),
        activeToday: Number(activeToday?.n ?? 0),
        newToday: Number(newToday?.n ?? 0),
        staff: Number(userRow?.staff ?? 0),
        blocked: Number(userRow?.blocked ?? 0),
      },
      trades: {
        today: Number(tradeToday?.n ?? 0),
        open: Number(openTrades?.n ?? 0),
        settledToday: Number(settledToday?.n ?? 0),
        volumeTodayMinor: Number(tradeToday?.volume ?? 0),
        payoutTodayMinor: Number(tradeToday?.payout ?? 0),
        profitTodayMinor: Number(tradeToday?.volume ?? 0) - Number(tradeToday?.payout ?? 0),
        volumeTotalMinor: Number(totals?.volume ?? 0),
        payoutTotalMinor: Number(totals?.payout ?? 0),
      },
      markets: markets.map((row) => ({
        symbol: row.symbol,
        name: row.name,
        status: row.deleted_at
          ? 'deleted'
          : row.is_draft
            ? 'draft'
            : row.active !== 1
              ? 'inactive'
              : row.paused === 1
                ? 'paused'
                : 'active',
        trades24h: Number(row.trades24h),
        volume24hMinor: Number(row.volume24h),
      })),
      wallets: wallets.map((row) => ({ currency: row.currency, totalMinor: Number(row.totalMinor ?? 0) })),
      // always 24 hourly buckets so the dashboard chart has a stable shape
      perHour: Array.from({ length: 24 }, (_unused, hour) => {
        const row = perHourRows.find((r) => Number(r.hour) === hour);
        return { hour, trades: Number(row?.trades ?? 0), volumeMinor: Number(row?.volume ?? 0) };
      }),
      perDay: Array.from({ length: 14 }, (_unused, index) => {
        const day = new Date(now - (13 - index) * DAY).toISOString().slice(0, 10);
        const row = perDayRows.find((r) => r.day === day);
        return {
          day,
          trades: Number(row?.trades ?? 0),
          volumeMinor: Number(row?.volume ?? 0),
          payoutMinor: Number(row?.payout ?? 0),
        };
      }),
      activity: activityRows.map((row) => ({
        at: Number(row.created_at),
        kind: row.action,
        label: humanizeAction(row.action),
        actor: row.actor,
        amountMinor: extractAmount(row.meta),
      })),
      alerts,
    };
  }
}

function humanizeAction(action: string): string {
  const map: Record<string, string> = {
    'user.registered': 'Pendaftaran user baru',
    'user.logged_in': 'Login berhasil',
    'trade.opened': 'Trade dibuka',
    'trade.settled': 'Trade diselesaikan',
    'admin.market_created': 'Market baru dibuat',
    'admin.market_updated': 'Parameter market diubah',
    'admin.market_price_changed': 'Harga awal market diubah',
    'admin.market_deleted': 'Market dihapus (soft delete)',
    'admin.trade_settled': 'Settlement manual',
    'admin.user_blocked': 'User diblokir',
    'admin.user_unblocked': 'Blokir dibuka',
    'admin.wallet_adjusted': 'Saldo demo disesuaikan',
    'settings.updated': 'Pengaturan diubah',
  };
  return map[action] ?? action;
}

function extractAmount(meta: string | null): number | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { amountMinor?: number };
    return typeof parsed.amountMinor === 'number' ? parsed.amountMinor : null;
  } catch {
    return null;
  }
}
