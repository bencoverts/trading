import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
}

export type SqlParam = string | number | bigint | null | boolean | undefined | Uint8Array;

type RawStatement = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
};

type RawDatabase = {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
  pragma?(sql: string): unknown;
};

/**
 * Thin synchronous SQLite wrapper.
 *
 * Prefers `better-sqlite3` (the documented stack). If its native binding is not
 * available on the host (e.g. a network-restricted sandbox that cannot download
 * prebuilds), it transparently falls back to Node's built-in `node:sqlite`
 * driver, which exposes the same synchronous API. The active driver is reported
 * by /healthz and the startup log.
 */
export class Database {
  readonly driver: 'better-sqlite3' | 'node:sqlite';
  readonly path: string;
  private readonly raw: RawDatabase;
  private readonly cache = new Map<string, Statement>();
  private inTransaction = false;

  constructor(path: string) {
    this.path = path;
    let raw: RawDatabase | null = null;
    let driver: 'better-sqlite3' | 'node:sqlite' = 'better-sqlite3';

    try {
      const BetterSqlite3 = require('better-sqlite3');
      raw = new BetterSqlite3(path) as RawDatabase;
      raw.pragma?.('journal_mode = WAL');
      raw.pragma?.('foreign_keys = ON');
      raw.pragma?.('busy_timeout = 5000');
      raw.pragma?.('synchronous = NORMAL');
    } catch {
      const { DatabaseSync } = require('node:sqlite');
      raw = new DatabaseSync(path) as RawDatabase;
      driver = 'node:sqlite';
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('PRAGMA busy_timeout = 5000');
      raw.exec('PRAGMA synchronous = NORMAL');
    }

    this.raw = raw;
    this.driver = driver;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): Statement {
    const existing = this.cache.get(sql);
    if (existing) return existing;
    const stmt = this.raw.prepare(sql);
    const cached: Statement = {
      run: (...params) => {
        const r = stmt.run(...normalizeParams(params));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      all: <T>(...params: unknown[]) => stmt.all(...normalizeParams(params)) as T[],
      get: <T>(...params: unknown[]) => stmt.get(...normalizeParams(params)) as T | undefined,
    };
    this.cache.set(sql, cached);
    return cached;
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    return this.prepare(sql).run(...params);
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
    return this.prepare(sql).all<T>(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.prepare(sql).get<T>(...params);
  }

  /**
   * Runs `fn` inside `BEGIN IMMEDIATE` .. `COMMIT`.
   *
   * IMMEDIATE acquires the write lock up front, so two concurrent requests can
   * never both read a balance and then both debit it. Combined with the
   * `CHECK (balance_minor >= 0)` constraint this makes over-spending impossible.
   * Nested calls join the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.exec('ROLLBACK');
      } catch {
        /* ignore rollback failures, surface the original error */
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  /** True while a transaction is open (used by a few invariant checks/tests). */
  get inTx(): boolean {
    return this.inTransaction;
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

function normalizeParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}
