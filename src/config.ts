import path from 'node:path';
import 'dotenv/config';
import { z } from 'zod';

/** All tunables in one place; every value is validated at boot. */
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

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  SQLITE_PATH: z.string().default('./data/simulated-trading.sqlite'),

  JWT_SECRET: z.string().optional(),
  SESSION_TTL_SEC: int(60 * 60 * 12, 60),
  COOKIE_NAME: z.string().default('sim_session'),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),

  APP_PUBLIC_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),

  ARGON2_MEMORY_KIB: int(19456, 8),
  ARGON2_TIME_COST: int(2, 1),

  ADMIN_EMAIL: z.string().email().default('admin@simtrade.local'),
  ADMIN_USERNAME: z.string().min(3).max(32).default('admin'),
  ADMIN_PASSWORD: z.string().min(8).default('admin-demo-123'),

  /** development convenience: expose verification/reset links on stdout + dev endpoint */
  DEV_EMAIL_LINKS: bool(true),
  EXPOSE_DEV_TOKENS: bool(true),
  /** when true, an unverified email blocks trading (default off for the demo) */
  REQUIRE_EMAIL_VERIFICATION: bool(false),

  /** file storage outside the source tree */
  UPLOADS_DIR: z.string().default('./data/uploads'),
  MAX_UPLOAD_BYTES: int(524_288, 1024, 5_242_880),
  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_INTERVAL_MS: int(6 * 3600_000, 60_000),
  TOTP_ISSUER: z.string().default('SimTrade Demo'),
  /** CSRF: state-changing requests must echo the CSRF cookie in this header */
  CSRF_HEADER: z.string().default('x-csrf-token'),
  CSRF_COOKIE: z.string().default('sim_csrf'),
  LOGIN_MAX_ATTEMPTS: int(8, 1),
  LOGIN_LOCK_MIN_MS: int(15 * 60_000, 10_000),

  RATE_AUTH_MAX: int(20, 1),
  RATE_AUTH_WINDOW_MS: int(60_000, 1000),
  RATE_TRADE_MAX: int(30, 1),
  RATE_TRADE_WINDOW_MS: int(60_000, 1000),
  RATE_GLOBAL_MAX: int(1200, 1),
  RATE_GLOBAL_WINDOW_MS: int(60_000, 1000),

  PAYOUT_RATE: z.coerce.number().min(0).max(5).default(0.85),
  PAYOUT_MODE: z.enum(['profit', 'total']).default('profit'),

  WS_TICK_MAX_PER_SEC: int(15, 1, 60),
  WS_HEARTBEAT_MS: int(30_000, 1000),
  WS_MAX_SUBSCRIPTIONS: int(30, 1),
  WS_MAX_CONNECTIONS: int(2_000, 1),

  TICK_RETENTION_DAYS: int(7, 1, 90),
  CANDLE_RETENTION_DAYS: int(30, 1, 365),
  AUDIT_RETENTION_DAYS: int(90, 1, 3650),
  HOUSEKEEPING_INTERVAL_MS: int(600_000, 1000),
  TICKS_FLUSH_MS: int(1_000, 100, 10_000),

  SETTLE_INTERVAL_MS: int(250, 20),
  TEST_SETTLE_INTERVAL_MS: int(100, 10),

  /**
   * KlikQRIS. Secrets come from the environment only and are never echoed to
   * the browser or the logs. Without an API key + merchant id the integration
   * reports `configured: false` and refuses to create transactions instead of
   * pretending a payment succeeded.
   */
  KLIKQRIS_BASE_URL: z.string().url().default('https://klikqris.com/api'),
  KLIKQRIS_API_KEY: z.string().min(8).optional(),
  KLIKQRIS_MERCHANT_ID: z.string().min(1).optional(),
  KLIKQRIS_CALLBACK_URL: z.string().url().optional(),
  /** HMAC-SHA256 secret used to verify callbacks (confirm the scheme with the provider) */
  KLIKQRIS_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** signature header sent by the provider; configurable because the API docs must be confirmed */
  KLIKQRIS_SIGNATURE_HEADER: z.string().default('x-callback-signature'),
  KLIKQRIS_TIMEOUT_MS: int(15_000, 1000, 60_000),
  /** allow deposits/withdrawals in this build; false keeps the demo wallet only */
  PAYMENTS_ENABLED: bool(false),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;

  const isProd = e.NODE_ENV === 'production';
  if (isProd && (!e.JWT_SECRET || e.JWT_SECRET.length < 32)) {
    throw new Error('JWT_SECRET (>= 32 characters) is required in production');
  }
  if (isProd && e.ADMIN_PASSWORD === 'admin-demo-123') {
    throw new Error('ADMIN_PASSWORD must be changed in production');
  }
  if (isProd && (e.EXPOSE_DEV_TOKENS || e.DEV_EMAIL_LINKS)) {
    // dev helpers are disabled by default in prod but allow an explicit opt-in only for staging
    if (e.NODE_ENV === 'production' && e.EXPOSE_DEV_TOKENS) {
      throw new Error('EXPOSE_DEV_TOKENS must be false in production');
    }
  }

  const absolute = (value: string) => (path.isAbsolute(value) ? value : path.resolve(process.cwd(), value));
  // `:memory:` must stay verbatim (tests use it); resolving it would create a
  // literal file called ":memory:" in the working directory.
  const sqlitePath =
    e.SQLITE_PATH === ':memory:' || e.SQLITE_PATH.startsWith('file:') ? e.SQLITE_PATH : absolute(e.SQLITE_PATH);
  return {
    ...e,
    APP_VERSION: process.env.npm_package_version ?? '3.0.0',
    SQLITE_PATH: sqlitePath,
    DB_PATH: sqlitePath,
    PAYMENTS_CONFIGURED: Boolean(e.KLIKQRIS_API_KEY && e.KLIKQRIS_MERCHANT_ID && e.KLIKQRIS_WEBHOOK_SECRET),
    DATA_DIR: sqlitePath === ':memory:' ? process.cwd() : path.dirname(sqlitePath),
    PUBLIC_URL: e.APP_PUBLIC_URL,
    UPLOADS_DIR: absolute(e.UPLOADS_DIR),
    BACKUP_DIR: absolute(e.BACKUP_DIR),
    CORS_ORIGINS: e.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    JWT_SECRET: e.JWT_SECRET ?? 'dev-only-insecure-secret-change-me-32chars',
    isProd,
    isTest: e.NODE_ENV === 'test',
    isDev: e.NODE_ENV === 'development',
  };
}
