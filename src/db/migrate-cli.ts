import { loadConfig } from '../config.js';
import { Database } from './sqlite.js';
import { resolveMigrationsDir, runMigrations } from './migrate.js';

const config = loadConfig();
const db = new Database(config.SQLITE_PATH);
try {
  const dir = resolveMigrationsDir();
  const applied = runMigrations(db, dir);
  console.log(
    applied.length
      ? `[migrate] ${db.driver}: applied ${applied.join(', ')} (${dir})`
      : `[migrate] ${db.driver}: database already up to date (${dir})`,
  );
} finally {
  db.close();
}
