import { loadConfig, type Config } from '../../src/config.js';

/** Config for tests: in-memory SQLite, cheap argon2, deterministic feed. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: ':memory:',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    ARGON2_MEMORY_KIB: '1024',
    ARGON2_TIME_COST: '1',
    INITIAL_BALANCE_CENTS: '1000000',
    TRADE_MIN_CENTS: '100',
    TRADE_MAX_CENTS: '50000',
    PAYOUT_RATE: '0.85',
    PAYOUT_MODE: 'profit',
    ALLOWED_DURATIONS: '5,15,30,60',
    MAX_OPEN_TRADES: '5',
    PRICE_DECIMALS: '2',
    SYMBOL: 'ASIA50',
    TICK_JITTER: 'false',
    TICK_INTERVAL_MS: '100',
    FEED_MOOD_AUTO: 'false',
    RATE_TRADE_MAX: '1000',
    RATE_GLOBAL_MAX: '100000',
    RATE_AUTH_MAX: '1000',
    WS_TICK_MAX_PER_SEC: '20',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
