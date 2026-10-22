import type { Db, DbConfig } from './types.js';
import { createSqliteDb } from './sqlite.js';
import { createPostgresDb } from './postgres.js';
import type { Config } from '../config.js';

export type { Db, Tx } from './types.js';

export function dbConfigFromConfig(config: Config): DbConfig {
  if (config.DB_DRIVER === 'postgres') {
    return { driver: 'postgres', connectionString: config.DATABASE_URL as string };
  }
  return { driver: 'sqlite', path: config.SQLITE_PATH };
}

export function createDb(cfg: DbConfig): Db {
  if (cfg.driver === 'postgres') return createPostgresDb(cfg);
  return createSqliteDb(cfg);
}
