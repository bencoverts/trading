/**
 * Minimal database abstraction. SQL is written once with `?` placeholders and is
 * portable between SQLite and PostgreSQL (the Postgres adapter rewrites them to $n).
 *
 * Everything is async even for SQLite so callers never depend on driver specifics.
 */
export interface Tx {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execScript(sql: string): Promise<void>;
}

export interface Db extends Tx {
  readonly driver: 'sqlite' | 'postgres';
  /**
   * Runs `fn` inside a single ACID transaction. Nested calls join the outer
   * transaction (they are not separate savepoints) which keeps "hold funds +
   * insert trade" atomic as a unit.
   */
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbConfig =
  | { driver: 'sqlite'; path: string }
  | { driver: 'postgres'; connectionString: string; max?: number };
