import type { Database } from './sqlite.js';
import type { PasswordHasher } from '../auth/passwords.js';
import type { Config } from '../config.js';
import { recordAudit } from '../services/audit.js';
import { DEFAULT_SETTINGS } from '../services/settings.js';
import { newId } from '../lib/ids.js';
import { CURRENCY_LIST } from '../domain/constants.js';

export interface SeedMarket {
  symbol: string;
  name: string;
  description: string;
  priceDecimals: number;
  basePrice: number;
  tickSize: number;
  mood: 'sepi' | 'normal' | 'cepat' | 'liar';
  trend: 'up' | 'down' | 'neutral';
  volatility: number;
  sortOrder: number;
}

/**
 * The three simulated instruments. Prices are made up by the server; DOGE here is
 * a simulated asset that merely borrows the name of the well-known coin.
 */
export const SEED_MARKETS: SeedMarket[] = [
  {
    symbol: 'ASIA_COMPOSITE',
    name: 'Asia Composite Index',
    description: 'Simulated index of Asian markets (fictional price series).',
    priceDecimals: 2,
    basePrice: 6204.5,
    tickSize: 0.1,
    mood: 'normal',
    trend: 'neutral',
    volatility: 1,
    sortOrder: 1,
  },
  {
    symbol: 'CRYPTO_COMPOSITE',
    name: 'Crypto Composite Index',
    description: 'Simulated composite of major cryptoassets (fictional price series).',
    priceDecimals: 2,
    basePrice: 41_250,
    tickSize: 1,
    mood: 'cepat',
    trend: 'neutral',
    volatility: 1.2,
    sortOrder: 2,
  },
  {
    symbol: 'DOGE',
    name: 'Dogecoin (simulated)',
    description: 'Simulated DOGE/USDT series. Not the real Dogecoin market price.',
    priceDecimals: 5,
    basePrice: 0.42871,
    tickSize: 0.0001,
    mood: 'liar',
    trend: 'neutral',
    volatility: 1.4,
    sortOrder: 3,
  },
];

export interface SeedResult {
  marketsInserted: number;
  adminCreated: boolean;
  settingsCreated: boolean;
}

/**
 * Idempotent seed: three markets, default runtime settings and the initial
 * admin account (from ADMIN_EMAIL / ADMIN_USERNAME / ADMIN_PASSWORD).
 */
export async function seedDatabase(db: Database, config: Config, hasher: PasswordHasher): Promise<SeedResult> {
  const now = Date.now();
  let marketsInserted = 0;
  let settingsCreated = false;
  let adminCreated = false;

  db.transaction(() => {
    for (const market of SEED_MARKETS) {
      const exists = db.get<{ symbol: string }>('SELECT symbol FROM markets WHERE symbol = ?', market.symbol);
      if (exists) continue;
      db.run(
        `INSERT INTO markets (symbol, name, description, price_decimals, base_price, tick_size, tick_interval_ms,
                              mood, trend, volatility, paused, active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 100, ?, ?, ?, 0, 1, ?, ?, ?)`,
        market.symbol,
        market.name,
        market.description,
        market.priceDecimals,
        market.basePrice,
        market.tickSize,
        market.mood,
        market.trend,
        market.volatility,
        market.sortOrder,
        now,
        now,
      );
      marketsInserted += 1;
    }

    const settingsRow = db.get<{ key: string }>('SELECT key FROM settings WHERE key = ?', 'runtime');
    if (!settingsRow && !settingsCreated) {
      db.run(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        'runtime',
        JSON.stringify(DEFAULT_SETTINGS),
        now,
      );
      settingsCreated = true;
    }
  });

  const email = config.ADMIN_EMAIL.trim().toLowerCase();
  const existing = db.get<{ id: string }>('SELECT id FROM users WHERE email_normalized = ?', email);
  if (!existing) {
    const passwordHash = await hasher.hash(config.ADMIN_PASSWORD);
    const id = newId();
    const balances = DEFAULT_SETTINGS.initialBalance;
    db.transaction(() => {
      db.run(
        `INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, role,
                            email_verified_at, display_currency, token_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, 'USD', 0, ?, ?)`,
        id,
        config.ADMIN_EMAIL,
        email,
        config.ADMIN_USERNAME,
        config.ADMIN_USERNAME.toLowerCase(),
        passwordHash,
        now,
        now,
        now,
      );
      for (const currency of CURRENCY_LIST) {
        db.run(
          'INSERT INTO wallets (user_id, currency, balance_minor, updated_at) VALUES (?, ?, ?, ?)',
          id,
          currency,
          balances[currency],
          now,
        );
      }
      recordAudit(db, {
        actorUserId: id,
        actorRole: 'system',
        action: 'admin.seeded',
        targetType: 'user',
        targetId: id,
        meta: { email: config.ADMIN_EMAIL, username: config.ADMIN_USERNAME },
        now,
      });
    });
    adminCreated = true;
  }

  return { marketsInserted, adminCreated, settingsCreated };
}
