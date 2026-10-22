-- v4: IDR-first currencies, KlikQRIS deposits, withdrawals and live chat.
-- Money stays in integer minor units; every balance movement also lands in the
-- append-only `ledger` table (migration 002) inside the same transaction.

-- ---------------------------------------------------------------- wallets
-- `balance_minor` is the total; `locked_minor` is the part reserved by pending
-- withdrawals. Available = balance - locked, always >= 0.
ALTER TABLE wallets ADD COLUMN locked_minor INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- currencies
CREATE TABLE IF NOT EXISTS currencies (
  code                 TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  symbol               TEXT NOT NULL,
  decimals             INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 8),
  active               INTEGER NOT NULL DEFAULT 0,
  deposit_enabled      INTEGER NOT NULL DEFAULT 0,
  withdrawal_enabled   INTEGER NOT NULL DEFAULT 0,
  trading_enabled      INTEGER NOT NULL DEFAULT 0,
  min_deposit_minor    INTEGER,
  max_deposit_minor    INTEGER,
  min_withdrawal_minor INTEGER,
  max_withdrawal_minor INTEGER,
  withdrawal_fee_minor INTEGER NOT NULL DEFAULT 0,
  withdrawal_fee_bps   INTEGER NOT NULL DEFAULT 0,
  -- demo display rate against IDR (source recorded next to it)
  fx_rate_to_idr       REAL,
  fx_source            TEXT,
  fx_updated_at        INTEGER,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);

-- IDR is the only currency enabled for deposits and withdrawals out of the box.
-- USD remains the simulated trading engine's quote currency (see DECISIONS) but
-- cannot be deposited or withdrawn until an admin enables it. USDT is fully off.
-- Balances for disabled currencies are never deleted.
INSERT OR IGNORE INTO currencies
  (code, name, symbol, decimals, active, deposit_enabled, withdrawal_enabled, trading_enabled,
   min_deposit_minor, max_deposit_minor, min_withdrawal_minor, max_withdrawal_minor,
   withdrawal_fee_minor, withdrawal_fee_bps, fx_rate_to_idr, fx_source, fx_updated_at, sort_order, updated_at)
VALUES
  ('IDR', 'Rupiah Indonesia', 'Rp', 0, 1, 1, 1, 1, 10000, 10000000, 20000, 5000000, 2500, 0, 1, 'fixed:IDR', 0, 1, 0),
  -- USD stays usable for the simulated trading engine (the demo's price maths
  -- and history are USD-based) but it is closed for deposits/withdrawals.
  ('USD', 'US Dollar (simulasi)', '$', 2, 1, 0, 0, 1, 100, 100000, 1000, 100000, 0, 0, 16250, 'demo:static', 0, 2, 0),
  ('USDT', 'Tether', '₮', 2, 0, 0, 0, 0, 100, 100000, 1000, 100000, 0, 0, 16250, 'demo:static', 0, 3, 0);

-- ---------------------------------------------------------------- deposits
CREATE TABLE IF NOT EXISTS payment_deposits (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency            TEXT NOT NULL,
  method              TEXT NOT NULL CHECK (method IN ('klikqris', 'manual')),
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  unique_amount_minor INTEGER,
  total_amount_minor  INTEGER,
  fee_minor           INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL CHECK (
    status IN ('pending', 'paid', 'expired', 'failed', 'cancelled', 'review', 'rejected')
  ),
  provider            TEXT,
  provider_order_id   TEXT,
  provider_status     TEXT,
  qris_url            TEXT,
  qris_image          TEXT,
  report_url          TEXT,
  provider_signature  TEXT,
  expires_at          INTEGER,
  paid_at             INTEGER,
  credited_at         INTEGER,
  idempotency_key     TEXT,
  proof_path          TEXT,
  reference           TEXT,
  note                TEXT,
  reviewed_by         TEXT,
  reviewed_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_deposits_provider_order
  ON payment_deposits(provider, provider_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_deposits_idempotency
  ON payment_deposits(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_deposits_user ON payment_deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_deposits_status ON payment_deposits(status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_callbacks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  deposit_id TEXT REFERENCES payment_deposits(id) ON DELETE SET NULL,
  provider   TEXT NOT NULL,
  order_id   TEXT,
  signature  TEXT,
  verified   INTEGER NOT NULL,
  accepted   INTEGER NOT NULL,
  reason     TEXT,
  payload    TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_callbacks_order ON payment_callbacks(order_id, created_at DESC);

-- ---------------------------------------------------------------- withdrawals
CREATE TABLE IF NOT EXISTS withdrawals (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency         TEXT NOT NULL,
  method           TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),
  fee_minor        INTEGER NOT NULL DEFAULT 0,
  net_minor        INTEGER NOT NULL CHECK (net_minor >= 0),
  destination      TEXT NOT NULL,
  destination_hash TEXT,
  status           TEXT NOT NULL CHECK (
    status IN ('pending', 'review', 'approved', 'processing', 'completed', 'rejected', 'cancelled')
  ),
  reason           TEXT,
  transfer_ref     TEXT,
  proof_path       TEXT,
  reviewed_by      TEXT,
  reviewed_at      INTEGER,
  processed_by     TEXT,
  processed_at     INTEGER,
  completed_at     INTEGER,
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_withdrawals_idempotency
  ON withdrawals(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_withdrawals_user ON withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_withdrawals_status ON withdrawals(status, created_at DESC);

CREATE TABLE IF NOT EXISTS withdrawal_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  withdrawal_id TEXT NOT NULL REFERENCES withdrawals(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  actor_user_id TEXT,
  actor_role    TEXT NOT NULL,
  reason        TEXT,
  meta          TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_withdrawal_events ON withdrawal_events(withdrawal_id, id);

-- ---------------------------------------------------------------- live chat
CREATE TABLE IF NOT EXISTS support_conversations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open', 'pending', 'closed')) DEFAULT 'open',
  priority        TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')) DEFAULT 'normal',
  assigned_to     TEXT,
  last_message_at INTEGER,
  last_message    TEXT,
  unread_user     INTEGER NOT NULL DEFAULT 0,
  unread_staff    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_chat_conv_user ON support_conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_chat_conv_status ON support_conversations(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_user_id  TEXT,
  sender_role     TEXT NOT NULL CHECK (sender_role IN ('user', 'staff', 'system')),
  body            TEXT NOT NULL,
  attachment_path TEXT,
  -- internal notes are staff-only and never returned to the user
  internal        INTEGER NOT NULL DEFAULT 0,
  client_id       TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_chat_messages ON support_messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_message_client
  ON support_messages(conversation_id, client_id) WHERE client_id IS NOT NULL;

-- ---------------------------------------------------------------- site config
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);
