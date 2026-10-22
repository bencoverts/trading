import { loadConfig } from '../config.js';
import { Database } from './sqlite.js';
import { resolveMigrationsDir, runMigrations } from './migrate.js';
import { seedDatabase } from './seed.js';
import { createPasswordHasher } from '../auth/passwords.js';
import { SettingsService } from '../services/settings.js';

const config = loadConfig();
const db = new Database(config.SQLITE_PATH);
try {
  runMigrations(db, resolveMigrationsDir());
  const hasher = createPasswordHasher({ memoryCost: config.ARGON2_MEMORY_KIB, timeCost: config.ARGON2_TIME_COST });
  const settings = new SettingsService(db, { payoutRate: config.PAYOUT_RATE, payoutMode: config.PAYOUT_MODE });
  settings.load();
  const demoData = process.argv.includes('--no-demo') ? false : true;
  const result = await seedDatabase(db, config, hasher, settings, { demoData });
  settings.load();
  console.log('[seed]', result);
  console.log(`[seed] admin login: ${config.ADMIN_EMAIL} / ${config.ADMIN_PASSWORD} (ganti di production)`);
  if (demoData) console.log('[seed] demo login: demo@simtrade.local / demo-password-123');
} finally {
  db.close();
}
