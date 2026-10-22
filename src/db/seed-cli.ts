import { loadConfig } from '../config.js';
import { Database } from './sqlite.js';
import { resolveMigrationsDir, runMigrations } from './migrate.js';
import { seedDatabase } from './seed.js';
import { createPasswordHasher } from '../auth/passwords.js';

const config = loadConfig();
const db = new Database(config.SQLITE_PATH);
try {
  runMigrations(db, resolveMigrationsDir());
  const hasher = createPasswordHasher({ memoryCost: config.ARGON2_MEMORY_KIB, timeCost: config.ARGON2_TIME_COST });
  const result = await seedDatabase(db, config, hasher);
  console.log('[seed]', result);
  console.log(`[seed] admin login: ${config.ADMIN_EMAIL} / ${config.ADMIN_PASSWORD} (change in production)`);
} finally {
  db.close();
}
