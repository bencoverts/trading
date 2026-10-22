import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db, DbConfig, Tx } from './types.js';

// Epoch-ms / counts are BIGINT in Postgres; return them as JS numbers.
pg.types.setTypeParser(20, (v) => Number(v));

/** Rewrites `?` placeholders (portable SQL) into Postgres `$1..$n`. */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function createPostgresDb(cfg: Extract<DbConfig, { driver: 'postgres' }>): Db {
  const pool = new pg.Pool({ connectionString: cfg.connectionString, max: cfg.max ?? 10 });
  const als = new AsyncLocalStorage<Tx>();

  type Executor = { query(sql: string, params?: unknown[]): Promise<pg.QueryResult> };

  const makeTx = (exec: Executor): Tx => ({
    async run(sql, params = []) {
      const r = await exec.query(toPg(sql), params);
      return { changes: r.rowCount ?? 0 };
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const r = await exec.query(toPg(sql), params);
      return r.rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const r = await exec.query(toPg(sql), params);
      return r.rows[0] as T | undefined;
    },
    async execScript(sql: string) {
      await exec.query(sql);
    },
  });

  const poolTx = makeTx(pool);

  const runOnPool = async (fn: (t: Tx) => Promise<unknown>) => fn(poolTx);

  const db: Db = {
    driver: 'postgres',
    run: (sql, params) => {
      const active = als.getStore();
      return (active ?? poolTx).run(sql, params);
    },
    all: <T>(sql: string, params?: unknown[]) => {
      const active = als.getStore();
      return (active ?? poolTx).all<T>(sql, params);
    },
    get: <T>(sql: string, params?: unknown[]) => {
      const active = als.getStore();
      return (active ?? poolTx).get<T>(sql, params);
    },
    execScript(sql) {
      const active = als.getStore();
      return (active ?? poolTx).execScript(sql);
    },
    async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
      const active = als.getStore();
      if (active) return fn(active);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = makeTx(client);
        const result = await als.run(tx, () => fn(tx));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback failure, surface the original error */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };

  void runOnPool;
  return db;
}
