-- Simulated trading platform - SQLite schema (v1)
-- All timestamps are Unix epoch milliseconds produced by the server.
-- All money is stored as integer minor units per currency (USD 2dp, IDR 0dp, USDT 2dp).

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  email_normalized   TEXT NOT NULL UNIQUE,
  username           TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  email_verified_at  INTEGER,
  blocked_at         INTEGER,
  blocked_reason     TEXT,
  display_currency   TEXT NOT NULL DEFAULT 'USD' CHECK (display_currency IN ('USD', 'IDR', 'USDT')),
  token_version      INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency      TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'USDT')),
  balance_minor INTEGER NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, currency)
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_email_tokens_user ON email_tokens(user_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS markets (
  symbol           TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  price_decimals   INTEGER NOT NULL CHECK (price_decimals BETWEEN 0 AND 8),
  base_price       REAL NOT NULL CHECK (base_price > 0),
  tick_size        REAL NOT NULL CHECK (tick_size > 0),
  tick_interval_ms INTEGER NOT NULL DEFAULT 100 CHECK (tick_interval_ms BETWEEN 20 AND 5000),
  mood             TEXT NOT NULL DEFAULT 'normal' CHECK (mood IN ('sepi', 'normal', 'cepat', 'liar')),
  trend            TEXT NOT NULL DEFAULT 'neutral' CHECK (trend IN ('up', 'down', 'neutral')),
  volatility       REAL NOT NULL DEFAULT 1 CHECK (volatility BETWEEN 0.01 AND 20),
  paused           INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  pause_reason     TEXT,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market          TEXT NOT NULL REFERENCES markets(symbol),
  direction       TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  currency        TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'USDT')),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  duration_sec    INTEGER NOT NULL CHECK (duration_sec BETWEEN 5 AND 28800),
  entry_price     REAL NOT NULL,
  entry_time      INTEGER NOT NULL,
  expiry_time     INTEGER NOT NULL,
  close_price     REAL,
  settled_at      INTEGER,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  result          TEXT CHECK (result IN ('win', 'lose', 'draw')),
  payout_rate     REAL NOT NULL,
  payout_mode     TEXT NOT NULL CHECK (payout_mode IN ('profit', 'total')),
  payout_minor    INTEGER NOT NULL DEFAULT 0 CHECK (payout_minor >= 0),
  settled_by      TEXT CHECK (settled_by IN ('expiry', 'admin')),
  settle_reason   TEXT,
  idempotency_key TEXT,
  request_hash    TEXT,
  created_at      INTEGER NOT NULL,
  CHECK (status = 'open' OR (result IS NOT NULL AND close_price IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_trades_idempotency
  ON trades(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_trades_due ON trades(status, expiry_time);
CREATE INDEX IF NOT EXISTS ix_trades_user ON trades(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_trades_market ON trades(market, created_at DESC);

CREATE TABLE IF NOT EXISTS ticks (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL REFERENCES markets(symbol),
  t      INTEGER NOT NULL,
  price  REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_ticks_market_t ON ticks(market, t);
CREATE INDEX IF NOT EXISTS ix_ticks_time ON ticks(t);

CREATE TABLE IF NOT EXISTS candles (
  market TEXT NOT NULL REFERENCES markets(symbol),
  tf     TEXT NOT NULL,
  t      INTEGER NOT NULL,
  o      REAL NOT NULL,
  h      REAL NOT NULL,
  l      REAL NOT NULL,
  c      REAL NOT NULL,
  PRIMARY KEY (market, tf, t)
);

CREATE INDEX IF NOT EXISTS ix_candles_time ON candles(t);

CREATE TABLE IF NOT EXISTS deposits (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency     TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'USDT')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  kind         TEXT NOT NULL DEFAULT 'demo_topup' CHECK (kind IN ('demo_topup', 'admin_adjustment')),
  note         TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_deposits_user ON deposits(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  actor_role    TEXT NOT NULL CHECK (actor_role IN ('guest', 'user', 'admin', 'system')),
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  meta          TEXT,
  ip            TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_user ON audit_log(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
