import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db, DbConfig, Tx } from './types.js';

/**
 * SQLite driver (development / tests).
 *
 * better-sqlite3 is synchronous, so a naive async wrapper could interleave two
 * "transactions" on the same connection. Every operation is therefore serialised
 * through a promise-chain mutex; the active transaction is tracked with
 * AsyncLocalStorage so nested helpers transparently join it.
 */
export function createSqliteDb(cfg: Extract<DbConfig, { driver: 'sqlite' }>): Db {
  const raw = new Database(cfg.path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  const als = new AsyncLocalStorage<Tx>();
  let lock: Promise<unknown> = Promise.resolve();

  const makeTx = (): Tx => ({
    async run(sql, params = []) {
      const info = raw.prepare(sql).run(...(params as never[]));
      return { changes: info.changes };
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    async execScript(sql: string) {
      raw.exec(sql);
    },
  });

  const txExec: Tx = makeTx();

  const withLock = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const result = lock.then(() => fn());
    lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const db: Db = {
    driver: 'sqlite',
    run(sql, params = []) {
      const active = als.getStore();
      if (active) return active.run(sql, params);
      return withLock(() => txExec.run(sql, params));
    },
    all<T>(sql: string, params: unknown[] = []) {
      const active = als.getStore();
      if (active) return active.all<T>(sql, params);
      return withLock(() => txExec.all<T>(sql, params));
    },
    get<T>(sql: string, params: unknown[] = []) {
      const active = als.getStore();
      if (active) return active.get<T>(sql, params);
      return withLock(() => txExec.get<T>(sql, params));
    },
    execScript(sql) {
      const active = als.getStore();
      if (active) return active.execScript(sql);
      return withLock(() => txExec.execScript(sql));
    },
    async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
      if (als.getStore()) return fn(als.getStore() as Tx);
      return withLock(async () => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await als.run(txExec, () => fn(txExec));
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* connection may already be rolled back */
          }
          throw err;
        }
      });
    },
    async close() {
      raw.close();
    },
  };

  return db;
}
