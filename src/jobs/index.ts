import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/sqlite.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from '../services/settings.js';
import type { MarketDataService } from '../services/marketData.js';
import type { TradeService } from '../services/trades.js';
import type { PriceEngine } from '../price/engine.js';
import { JobScheduler } from './scheduler.js';
import { newId } from '../lib/ids.js';

export interface BackupFile {
  id: string;
  filename: string;
  sizeBytes: number;
  kind: 'manual' | 'scheduled';
  createdBy: string | null;
  createdAt: number;
}

export interface JobDeps {
  db: Database;
  logger: Logger;
  settings: SettingsService;
  trades: TradeService;
  marketData: MarketDataService;
  engine: PriceEngine;
  backupDir: string;
  dbPath: string;
  now: () => number;
  /** settlement interval from config (ms) */
  settleIntervalMs: number;
  /** scheduled backup interval from config (ms) */
  backupIntervalMs?: number;
}

/** SQLite `VACUUM INTO` gives a consistent copy without stopping the server. */
export function createBackupService(deps: JobDeps) {
  mkdirSync(deps.backupDir, { recursive: true });

  const list = (): BackupFile[] => {
    const rows = deps.db.all<{
      id: string;
      filename: string;
      size_bytes: number;
      kind: 'manual' | 'scheduled';
      created_by: string | null;
      created_at: number;
    }>('SELECT * FROM backups ORDER BY created_at DESC LIMIT 100');
    return rows
      .filter((row) => existsSync(path.join(deps.backupDir, row.filename)))
      .map((row) => ({
        id: row.id,
        filename: row.filename,
        sizeBytes: Number(row.size_bytes),
        kind: row.kind,
        createdBy: row.created_by,
        createdAt: Number(row.created_at),
      }));
  };

  const run = (kind: 'manual' | 'scheduled', createdBy: string | null = null): BackupFile => {
    const now = deps.now();
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${stamp}-${kind}.sqlite`;
    const target = path.join(deps.backupDir, filename);
    if (existsSync(target)) unlinkSync(target);
    deps.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const size = statSync(target).size;
    const id = newId();
    deps.db.run(
      'INSERT INTO backups (id, filename, size_bytes, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      filename,
      size,
      kind,
      createdBy,
      now,
    );
    // keep the newest 20 files on disk
    const all = list();
    for (const stale of all.slice(20)) {
      try {
        unlinkSync(path.join(deps.backupDir, stale.filename));
      } catch {
        /* ignore */
      }
    }
    deps.logger.info({ filename, size }, 'backup database dibuat');
    return { id, filename, sizeBytes: size, kind, createdBy, createdAt: now };
  };

  const remove = (id: string): void => {
    const row = deps.db.get<{ filename: string }>('SELECT filename FROM backups WHERE id = ?', id);
    if (!row) return;
    const file = path.join(deps.backupDir, row.filename);
    if (existsSync(file)) unlinkSync(file);
    deps.db.run('DELETE FROM backups WHERE id = ?', id);
  };

  return { list, run, remove, dir: deps.backupDir };
}

export type BackupService = ReturnType<typeof createBackupService>;

export function registerJobs(deps: JobDeps, backups: BackupService): JobScheduler {
  const scheduler = new JobScheduler(deps.db, deps.logger, deps.now);

  scheduler.register({
    name: 'settlement',
    label: 'Settlement trade',
    intervalMs: Math.max(200, deps.settleIntervalMs),
    firstDelayMs: 500,
    run: () => ({ settled: deps.trades.settleDue(deps.now()).length }),
  });

  scheduler.register({
    name: 'engine',
    label: 'Health check price engine',
    intervalMs: 15_000,
    firstDelayMs: 15_000,
    run: () => {
      const markets = deps.engine.symbols.map((symbol) => ({
        symbol,
        lastPrice: deps.engine.lastPrice(symbol),
        lastSeq: deps.engine.lastSeq(symbol),
        paused: deps.engine.isPaused(symbol),
      }));
      const stale = deps.engine.listConfigs().filter((market) => deps.engine.lastPrice(market.symbol) === null);
      if (stale.length) deps.logger.warn({ stale: stale.map((m) => m.symbol) }, 'market belum punya harga');
      return { markets: markets.length, withoutPrice: stale.length };
    },
  });

  scheduler.register({
    name: 'cleanup',
    label: 'Bersihkan data lama',
    intervalMs: 6 * 3600_000,
    firstDelayMs: 60_000,
    run: () => {
      const settings = deps.settings.get();
      const now = deps.now();
      const ticks = deps.db.run('DELETE FROM ticks WHERE t < ?', now - settings.tickRetentionDays * 86_400_000);
      const candles = deps.db.run('DELETE FROM candles WHERE t < ?', now - settings.candleRetentionDays * 86_400_000);
      const sessions = deps.db.run('DELETE FROM sessions WHERE expires_at < ?', now - 7 * 86_400_000);
      const tokens = deps.db.run('DELETE FROM email_tokens WHERE expires_at < ?', now - 7 * 86_400_000);
      const jobs = deps.db.run('DELETE FROM job_runs WHERE started_at < ?', now - 30 * 86_400_000);
      return {
        ticks: ticks.changes,
        candles: candles.changes,
        sessions: sessions.changes,
        tokens: tokens.changes,
        jobRuns: jobs.changes,
      };
    },
  });

  scheduler.register({
    name: 'backup',
    label: 'Backup database',
    intervalMs: deps.backupIntervalMs ?? 6 * 3600_000,
    firstDelayMs: 30 * 60_000,
    run: () => {
      const file = backups.run('scheduled');
      return { filename: file.filename, sizeBytes: file.sizeBytes };
    },
  });

  return scheduler;
}

export function backupFilesOnDisk(dir: string): string[] {
  try {
    mkdirSync(dir, { recursive: true });
    return readdirSync(dir).filter((file) => file.endsWith('.sqlite'));
  } catch {
    return [];
  }
}
