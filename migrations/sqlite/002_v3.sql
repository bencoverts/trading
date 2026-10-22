-- Simulated trading platform - v3 additions
-- Adds staff roles, sessions, 2FA, market metadata/logo/schedule, ledger,
-- notifications, content pages, favourites and backups.
-- All timestamps are epoch milliseconds from the server clock.

-- ---------------------------------------------------------------- users
ALTER TABLE users ADD COLUMN staff_role TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar_path TEXT;
ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'id';
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta';
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_recovery_hashes TEXT;
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until INTEGER;
ALTER TABLE users ADD COLUMN last_login_at INTEGER;
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;

UPDATE users SET staff_role = 'super_admin' WHERE role = 'admin' AND staff_role IS NULL;

CREATE INDEX IF NOT EXISTS ix_users_staff ON users(staff_role);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_version INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS login_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  identifier TEXT NOT NULL,
  success    INTEGER NOT NULL,
  reason     TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_login_history_user ON login_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_user_notes_user ON user_notes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market     TEXT NOT NULL REFERENCES markets(symbol) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, market)
);

-- --------------------------------------------------------------- markets
ALTER TABLE markets ADD COLUMN category TEXT NOT NULL DEFAULT 'index';
ALTER TABLE markets ADD COLUMN logo_path TEXT;
ALTER TABLE markets ADD COLUMN volatility_preset TEXT NOT NULL DEFAULT 'sedang';
ALTER TABLE markets ADD COLUMN trend_strength INTEGER NOT NULL DEFAULT 5;
ALTER TABLE markets ADD COLUMN trading_hours TEXT NOT NULL DEFAULT '{"mode":"24_7"}';
ALTER TABLE markets ADD COLUMN min_amount_usd_minor INTEGER;
ALTER TABLE markets ADD COLUMN max_amount_usd_minor INTEGER;
ALTER TABLE markets ADD COLUMN payout_rate REAL;
ALTER TABLE markets ADD COLUMN exposure_limit_usd_minor INTEGER;
ALTER TABLE markets ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN deleted_at INTEGER;
ALTER TABLE markets ADD COLUMN created_by TEXT;
ALTER TABLE markets ADD COLUMN updated_by TEXT;

UPDATE markets SET category = CASE
  WHEN symbol = 'DOGE' THEN 'crypto'
  WHEN symbol = 'CRYPTO_COMPOSITE' THEN 'crypto'
  ELSE 'index' END
WHERE category = 'index';

CREATE INDEX IF NOT EXISTS ix_markets_status ON markets(deleted_at, active, paused);

CREATE TABLE IF NOT EXISTS market_param_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  market        TEXT NOT NULL,
  actor_user_id TEXT,
  actor_role    TEXT NOT NULL,
  action        TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  note          TEXT,
  ip            TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_market_history ON market_param_history(market, created_at DESC);

-- ---------------------------------------------------------------- ledger
CREATE TABLE IF NOT EXISTS ledger (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency            TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'USDT')),
  kind                TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  balance_after_minor INTEGER NOT NULL,
  ref_type            TEXT,
  ref_id              TEXT,
  meta                TEXT,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_ledger_user ON ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ledger_kind ON ledger(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS conversions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_currency  TEXT NOT NULL,
  to_currency    TEXT NOT NULL,
  from_minor     INTEGER NOT NULL,
  to_minor       INTEGER NOT NULL,
  rate           REAL NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_conversions_user ON conversions(user_id, created_at DESC);

-- --------------------------------------------------------- notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, created_at DESC);

-- ---------------------------------------------------------------- content
CREATE TABLE IF NOT EXISTS banners (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  starts_at  INTEGER,
  ends_at    INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS content_pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS backups (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'scheduled')),
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

-- Seed the editable legal/help pages with clearly-marked demo placeholders.
INSERT OR IGNORE INTO content_pages (slug, title, body, updated_at) VALUES
  ('faq', 'FAQ', '## FAQ (demo)\n\nSemua harga dan saldo di platform ini adalah simulasi. Tidak ada uang sungguhan.', 0),
  ('terms', 'Syarat dan Ketentuan', '## Syarat dan Ketentuan (demo)\n\nPlatform ini adalah demo teknis. Tidak ada layanan investasi, tidak ada uang sungguhan, dan tidak ada jaminan hasil.', 0),
  ('privacy', 'Kebijakan Privasi', '## Kebijakan Privasi (demo)\n\nData yang disimpan hanya untuk keperluan demo: email, username, dan aktivitas simulasi.', 0),
  ('contact', 'Kontak', '## Kontak (demo)\n\nEmail placeholder: demo@example.invalid', 0);

CREATE TABLE IF NOT EXISTS job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('ok', 'error', 'running')),
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  detail      TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS ix_job_runs_job ON job_runs(job, started_at DESC);
