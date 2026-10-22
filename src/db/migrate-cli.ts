import { loadConfig } from '../config.js';
import { createDb, dbConfigFromConfig } from './index.js';
import { resolveMigrationsDir, runMigrations } from './migrate.js';

async function main() {
  const config = loadConfig();
  const db = createDb(dbConfigFromConfig(config));
  try {
    const dir = await resolveMigrationsDir(db.driver);
    const applied = await runMigrations(db, dir);
    if (applied.length === 0) {
      console.log(`[migrate] ${db.driver}: database already up to date (${dir})`);
    } else {
      console.log(`[migrate] ${db.driver}: applied ${applied.join(', ')}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
