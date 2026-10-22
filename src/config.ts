import 'dotenv/config';
import { z } from 'zod';

/**
 * All tunables that a product owner may want to change are read here.
 * Business defaults are intentionally conservative (see README "Business decisions").
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number, min?: number, max?: number) => {
  let s = z.coerce.number().int();
  if (min !== undefined) s = s.min(min);
  if (max !== undefined) s = s.max(max);
  return s.default(def);
};

const csvInts = (def: number[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v
            .split(',')
            .map((x) => Number(x.trim()))
            .filter((n) => Number.isInteger(n) && n > 0),
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // --- persistence -------------------------------------------------------
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().optional(),
  SQLITE_PATH: z.string().default('./data/demo.sqlite'),

  // --- auth --------------------------------------------------------------
  JWT_SECRET: z.string().optional(),
  JWT_TTL_SEC: int(60 * 60 * 12, 60),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),
  ARGON2_MEMORY_KIB: int(19456, 8),
  ARGON2_TIME_COST: int(2, 1),

  // --- http/security -----------------------------------------------------
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://127.0.0.1:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: bool(false),
  RATE_TRADE_MAX: int(10, 1),
  RATE_TRADE_WINDOW_MS: int(60_000, 1000),
  RATE_GLOBAL_MAX: int(600, 1),
  RATE_GLOBAL_WINDOW_MS: int(60_000, 1000),
  RATE_AUTH_MAX: int(20, 1),
  RATE_AUTH_WINDOW_MS: int(60_000, 1000),

  // --- trading economy (business decisions) ------------------------------
  CURRENCY: z.string().min(1).max(8).default('USD'),
  INITIAL_BALANCE_CENTS: int(1_000_000, 0), // 10,000.00
  TRADE_MIN_CENTS: int(100, 1),
  TRADE_MAX_CENTS: int(100_000, 1),
  PAYOUT_RATE: z.coerce.number().min(0).max(5).default(0.85),
  PAYOUT_MODE: z.enum(['profit', 'total']).default('profit'),
  ALLOWED_DURATIONS: csvInts([5, 15, 30, 60]),
  MAX_OPEN_TRADES: int(5, 1),
  PRICE_DECIMALS: int(2, 0, 8),

  // --- price engine ------------------------------------------------------
  SYMBOL: z.string().default('ASIA50'),
  SYMBOL_NAME: z.string().default('ASIA COMPOSITE INDEX'),
  INITIAL_PRICE: z.coerce.number().positive().default(6204.5),
  FEED_ADAPTER: z.enum(['simulated']).default('simulated'),
  FEED_MOOD: z.enum(['sepi', 'normal', 'cepat', 'liar']).default('normal'),
  FEED_MOOD_AUTO: bool(true),
  FEED_VOLATILITY: z.coerce.number().min(0.01).max(20).default(1),
  TICK_INTERVAL_MS: int(100, 20, 5000),
  TICK_JITTER: bool(true),
  TICK_SIZE: z.coerce.number().min(0).default(0.1),
  TICK_BUFFER_SIZE: int(20_000, 100),

  // --- retention / housekeeping -----------------------------------------
  CANDLE_RETENTION_SEC: int(48 * 3600, 300),
  AUDIT_RETENTION_SEC: int(30 * 24 * 3600, 3600),
  HOUSEKEEPING_INTERVAL_MS: int(600_000, 1000),

  // --- realtime ----------------------------------------------------------
  WS_TICK_MAX_PER_SEC: int(15, 1, 60),
  WS_HEARTBEAT_MS: int(30_000, 1000),
  WS_MAX_SUBSCRIPTIONS: int(20, 1),
  WS_MAX_BUFFERED_BYTES: int(1_000_000, 10_000),
  WS_MAX_CONNECTIONS: int(2_000, 1),

  // --- tests only --------------------------------------------------------
  TEST_SETTLE_INTERVAL_MS: int(100, 10),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;

  if (e.TRADE_MIN_CENTS > e.TRADE_MAX_CENTS) {
    throw new Error('TRADE_MIN_CENTS must be <= TRADE_MAX_CENTS');
  }
  if (e.ALLOWED_DURATIONS.length === 0) {
    throw new Error('ALLOWED_DURATIONS must contain at least one duration');
  }
  if (e.DB_DRIVER === 'postgres' && !e.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
  }
  if (e.NODE_ENV === 'production' && (!e.JWT_SECRET || e.JWT_SECRET.length < 32)) {
    throw new Error('JWT_SECRET (>=32 chars) is required in production');
  }

  const allowedDurations = [...new Set(e.ALLOWED_DURATIONS)].sort((a, b) => a - b);
  const jwtSecret = e.JWT_SECRET ?? 'dev-only-insecure-secret-change-me-please-32';

  return {
    ...e,
    ALLOWED_DURATIONS: allowedDurations,
    JWT_SECRET: jwtSecret,
    isProd: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    /** accepted timeframes, in ms - the only ones the server aggregates/streams */
    TIMEFRAMES: { '5s': 5_000, '15s': 15_000, '30s': 30_000, '1m': 60_000, '5m': 300_000 } as Record<
      string,
      number
    >,
  };
}
