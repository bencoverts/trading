# API reference

**Demo only.** Every account is funded with a virtual balance. There is no deposit,
withdrawal, payment provider or real money anywhere in this API.

- Base URL (dev): `http://localhost:3000`
- WebSocket: `ws://localhost:3000/ws` (or `wss://` behind TLS)
- Content type: `application/json` for every request/response body
- Interactive spec: [`docs/openapi.yaml`](./openapi.yaml)

---

## 1. Conventions

### 1.1 Authentication

`Authorization: Bearer <jwt>` — obtain the token from `/api/auth/register` or
`/api/auth/login`. Tokens are HS256 JWTs valid for `JWT_TTL_SEC` (default 12 h).
Market data endpoints are public; account, trade and admin endpoints require a token.
Admin endpoints additionally require `role = "admin"` on the token.

### 1.2 Money

- Requests send `amount` in **major units** (e.g. `10.5` = 10.50 USD), max 2 decimals.
- Responses include both `amount` (major units, JSON number) and `amountCents`
  (integer minor units, the exact stored value).
- Internally all money is integer **cents**; `accounts.balance_cents` has a
  `CHECK (balance_cents >= 0)` constraint.

### 1.3 Time

All timestamps are Unix epoch **milliseconds** (integers), always produced by the
server. Client clocks are never used for pricing, expiry or settlement.

### 1.4 Errors

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Insufficient demo balance", "details": { "required": 200 } } }
```

| HTTP | code | when |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | body/query/header failed validation, malformed JSON |
| 401 | `UNAUTHORIZED` | missing/invalid/expired token, bad login |
| 401 | `INVALID_CREDENTIALS` | wrong email or password |
| 403 | `FORBIDDEN` | not an admin |
| 404 | `NOT_FOUND` | unknown endpoint, unknown trade (also for other users' trades) |
| 409 | `EMAIL_TAKEN` | registration with an existing email |
| 409 | `IDEMPOTENCY_KEY_REUSED` | same `Idempotency-Key`, different payload |
| 413 | `PAYLOAD_TOO_LARGE` | body > 32 kB |
| 422 | `INSUFFICIENT_FUNDS` | stake > balance |
| 422 | `TRADE_LIMIT_REACHED` | too many open trades (`MAX_OPEN_TRADES`) |
| 422 | `DURATION_NOT_ALLOWED` | `durationSec` not in `allowedDurations` |
| 422 | `SYMBOL_INACTIVE` | symbol is not the active instrument |
| 429 | `RATE_LIMITED` | rate limit hit (per user for trades, per IP elsewhere) |
| 503 | `PRICE_UNAVAILABLE` | price feed has not produced a tick yet |
| 500 | `INTERNAL` | unexpected server error (logged with a request id) |

### 1.5 Rate limits

| scope | key | default |
| --- | --- | --- |
| `/api/trades` (POST) | authenticated user id | 10 / 60 s |
| `/api/auth/*` | client IP | 20 / 60 s |
| all other `/api/*` | client IP | 600 / 60 s |

Configured by `RATE_TRADE_*`, `RATE_AUTH_*`, `RATE_GLOBAL_*`. Responses include
`RateLimit-*` headers (draft-7). Limits are in-process; use a shared store
(e.g. Redis) when running more than one instance.

### 1.6 CORS & headers

CORS is an explicit allowlist (`CORS_ORIGINS`) plus same-host origins, so it works
behind reverse proxies. Allowed request headers: `Content-Type`, `Authorization`,
`Idempotency-Key`. Helmet sets CSP (`default-src 'self'`), `nosniff`, referrer policy
and HSTS in production; `X-Frame-Options` is intentionally not set so the UI can be
embedded.

---

## 2. Endpoints

### 2.1 `GET /healthz`

Public, no rate limit. `200` when the database answers, `503` otherwise.

```json
{
  "status": "ok",
  "serverTime": 1792678348569,
  "uptimeSec": 5,
  "db": "ok",
  "engine": {
    "symbol": "ASIA50",
    "lastSeq": 47,
    "lastPrice": 6201.68,
    "lastTickAgeMs": 70,
    "source": { "source": "simulated", "mood": "normal", "volatility": 1, "autoMood": true }
  },
  "realtime": { "connections": 1 },
  "version": "1.0.0"
}
```

### 2.2 `POST /api/auth/register`

```json
{ "email": "trader@example.com", "password": "min-8-chars" }
```

`201`:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { "id": "uuid", "email": "trader@example.com", "role": "user", "createdAt": 1792678346000 },
  "account": { "balance": 10000, "balanceCents": 1000000, "currency": "USD" }
}
```

Creates the user **and** the demo account with `INITIAL_BALANCE_CENTS` in one
transaction. Passwords are hashed with argon2id.

### 2.3 `POST /api/auth/login`

Same body. `200` with the same shape; `401 INVALID_CREDENTIALS` on failure.

### 2.4 `GET /api/me` 🔒

```json
{
  "user": { "id": "uuid", "email": "trader@example.com", "role": "user", "createdAt": 1792678346000 },
  "account": { "balance": 9990, "balanceCents": 999000, "currency": "USD" },
  "limits": {
    "minAmount": 1,
    "maxAmount": 1000,
    "allowedDurations": [5, 15, 30, 60],
    "payoutRate": 0.85,
    "payoutMode": "profit",
    "maxOpenTrades": 5,
    "openTrades": 1
  }
}
```

`limits` reflects the **current** runtime settings (admin may change them).

### 2.5 `POST /api/account/reset` 🔒

Resets the demo balance to `INITIAL_BALANCE_CENTS`.

```json
{ "account": { "balance": 10000, "balanceCents": 1000000, "currency": "USD" }, "voidedTrades": 1 }
```

Any open trade is closed as a `draw` with a full refund recorded in history (the
balance is then reset), and an audit entry is written. Emits `balance` over WS.

### 2.6 `GET /api/market`

Public market configuration.

```json
{
  "symbol": "ASIA50",
  "symbolName": "ASIA COMPOSITE INDEX",
  "timeframes": ["5s", "15s", "30s", "1m", "5m"],
  "timeframeMs": { "5s": 5000, "15s": 15000, "30s": 30000, "1m": 60000, "5m": 300000 },
  "priceDecimals": 2,
  "currency": "USD",
  "serverTime": 1792678348578,
  "trading": {
    "allowedDurations": [5, 15, 30, 60],
    "minAmount": 1,
    "maxAmount": 1000,
    "payoutRate": 0.85,
    "payoutMode": "profit",
    "maxOpenTrades": 5
  }
}
```

### 2.7 `GET /api/candles`

| query | default | notes |
| --- | --- | --- |
| `symbol` | active symbol | other symbols → `422 SYMBOL_INACTIVE` |
| `tf` | `1m` | one of `5s,15s,30s,1m,5m` |
| `limit` | `200` | 1–1000 |
| `before` | – | epoch ms, only candles with `t < before` |
| `includeCurrent` | `true` | append the still-forming candle |

```json
{
  "symbol": "ASIA50",
  "tf": "5s",
  "tfMs": 5000,
  "serverTime": 1792678348578,
  "priceDecimals": 2,
  "seq": 47,
  "lastPrice": 6201.68,
  "candles": [
    { "t": 1792678340000, "o": 6204.5, "h": 6204.9, "l": 6203.68, "c": 6203.68 },
    { "t": 1792678345000, "o": 6203.55, "h": 6203.55, "l": 6201.68, "c": 6201.68 }
  ],
  "current": { "t": 1792678345000, "o": 6203.55, "h": 6203.55, "l": 6201.68, "c": 6201.68 }
}
```

`candles` are closed candles only (oldest → newest); `current` is the forming one.
Candles are aggregated **on the server** from the single price stream, for all
timeframes, and persisted (48 h retention by default).

### 2.8 `GET /api/ticks`

| query | default | notes |
| --- | --- | --- |
| `symbol` | active symbol | |
| `since` | – | epoch ms, inclusive |
| `limit` | `500` | 1–5000, returns the newest matches |

```json
{
  "symbol": "ASIA50",
  "serverTime": 1792678348578,
  "priceDecimals": 2,
  "seq": 47,
  "ticks": [{ "price": 6201.68, "time": 1792678348569, "seq": 47 }]
}
```

Ticks live in a bounded in-memory ring buffer (`TICK_BUFFER_SIZE`, default 20 000 ≈ 33 min
at 10 ticks/s) and are **not** persisted; they exist for replay/resume and short windows.

#### Why `/api/candles` is the canonical history endpoint

The demo UI uses **`/api/candles`** for chart history:

- one tick stream, five timeframes aggregated server-side → all clients see identical OHLC;
- a 5 m chart needs hours of data; fetching that as ticks would be hundreds of thousands of
  JSON objects, while 300 candles is a few kB;
- switching timeframe becomes one small request instead of re-aggregating a huge local buffer.

`/api/ticks` remains available for tick-level replay (and is what the reference client uses
for the initial price), but it is not used for chart history.

### 2.9 `POST /api/trades` 🔒

```http
POST /api/trades
Authorization: Bearer <token>
Idempotency-Key: 7f5c1f3e-... (optional but strongly recommended)
Content-Type: application/json

{ "symbol": "ASIA50", "direction": "up", "amount": 10, "durationSec": 5 }
```

Rules enforced by the server:

1. `amount > 0`, ≤ `maxAmount`, ≥ `minAmount`, at most 2 decimals;
2. `amountCents` ≤ current balance (the stake is held atomically);
3. `durationSec` ∈ `allowedDurations`;
4. `symbol` is the active instrument;
5. open trades per user < `MAX_OPEN_TRADES`;
6. entry price = **server's latest price**, entry time = server clock,
   expiry = entry time + `durationSec`, payout rate snapshot from settings.

`201` (new) / `200` (idempotent replay, header `Idempotent-Replayed: true`):

```json
{
  "trade": {
    "id": "uuid",
    "userId": "uuid",
    "symbol": "ASIA50",
    "direction": "up",
    "amount": 10,
    "amountCents": 1000,
    "durationSec": 5,
    "entryPrice": 6204.5,
    "entryTime": 1792678346000,
    "expiryTime": 1792678351000,
    "closePrice": null,
    "status": "open",
    "result": null,
    "payoutRate": 0.85,
    "payoutMode": "profit",
    "payout": null,
    "payoutCents": null,
    "profit": null,
    "createdAt": 1792678346000
  }
}
```

Idempotency: the key is scoped per user (unique index). The same key with the same
payload returns the original trade and never opens a second one; the same key with a
different payload returns `409 IDEMPOTENCY_KEY_REUSED`. Send a fresh UUID per click.
Non-UUID keys of 8–128 chars matching `[A-Za-z0-9._:-]+` are accepted.

### 2.10 `GET /api/trades` 🔒

| query | default | notes |
| --- | --- | --- |
| `status` | `all` | `open` \| `closed` \| `all` |
| `limit` | `50` | 1–200 |

`{ "trades": [Trade, ...] }` — newest first (open trades first when `status=all`).

### 2.11 `GET /api/trades/:id` 🔒

`{ "trade": Trade }`; a trade owned by another user returns `404`.

### 2.12 `GET /api/trades/:id/status` 🔒

Lightweight polling alternative to the WebSocket:

```json
{ "id": "uuid", "status": "closed", "result": "win" }
```

Settlement rules (all server-side):

| close vs entry | `up` | `down` |
| --- | --- | --- |
| `close > entry` | win | lose |
| `close < entry` | lose | win |
| `close == entry` | draw (full refund) | draw (full refund) |

If no tick exists at or before the expiry instant (for example the trade expired
while the server was down), the outcome for that moment is unknown and the trade is
settled as a **draw with a full refund** — never against a post-expiry price.

`payoutMode = "profit"` (default): a win credits `stake + round(stake × payoutRate)`.
`payoutMode = "total"`: a win credits `round(stake × payoutRate)` (rate > 1).
A loss credits 0. The close price is the **last server tick at or before the expiry
timestamp** (`GET /api/ticks`-style lookup in the ring buffer), not the price when a
timer happened to run.

---

## 3. Admin endpoints 🔒 (role `admin`)

| method | path | description |
| --- | --- | --- |
| `GET` | `/api/admin/settings` | current runtime settings |
| `PATCH` | `/api/admin/settings` | update payout/durations/limits/mood/volatility |
| `GET` | `/api/admin/feed` | feed adapter state, last tick, source description |
| `POST` | `/api/admin/settle` | force a settlement pass (ops/testing) |
| `GET` | `/api/admin/stats` | trade/account aggregates |
| `GET` | `/api/admin/trades?limit=&status=&userId=` | all trades with owner email |
| `GET` | `/api/admin/audit?limit=&action=&userId=` | audit trail |

`PATCH /api/admin/settings` accepts (all optional, unknown fields rejected):

```json
{
  "payoutRate": 0.9,
  "payoutMode": "profit",
  "allowedDurations": [10, 20],
  "minAmount": 1,
  "maxAmount": 25,
  "maxOpenTrades": 10,
  "mood": "liar",
  "volatility": 2.5
}
```

`mood` (`sepi` \| `normal` \| `cepat` \| `liar`) and `volatility` (0.01–20 multiplier)
are applied to the live feed immediately. Payout changes apply to **new** trades;
existing trades keep the rate they were opened with.

`GET /api/admin/stats` example:

```json
{
  "trades": {
    "total": 42, "open": 2, "closed": 40, "wins": 18, "losses": 20, "draws": 2,
    "wagered": 420, "paidOut": 331.5, "ggr": 88.5, "openExposure": 20
  },
  "accounts": { "users": 7, "totalBalance": 69420, "currency": "USD" },
  "settings": { "...": "..." },
  "feed": { "source": "simulated", "mood": "normal" },
  "generatedAt": 1792678348578
}
```

---

## 4. WebSocket `/ws`

### 4.1 Connection

```
ws://host/ws?token=<jwt>       # optional token: needed for account/trade events
```

- Origin checks: allowlisted `CORS_ORIGINS`, same-host origins, or no `Origin`
  (non-browser clients).
- Max payload 8 kB, max connections `WS_MAX_CONNECTIONS` (default 2000).
- Market data works anonymously; `trade:opened`, `trade:settled` and `balance` are only
  sent to sockets authenticated as the trade owner.
- A socket can authenticate later with `{ "type": "auth", "token": "..." }`.

### 4.2 Client → server messages

| type | payload | purpose |
| --- | --- | --- |
| `subscribe` | `{ symbol, timeframe }` | subscribe to a symbol/timeframe |
| `unsubscribe` | `{ symbol, timeframe }` | stop receiving that stream |
| `ping` | `{ id? }` | application heartbeat, answered with `pong` |
| `auth` | `{ token }` | authenticate an anonymous socket |
| `resume` | `{ lastSeq }` | replay ticks after a reconnect |

```json
{ "type": "subscribe", "symbol": "ASIA50", "timeframe": "5s" }
```

### 4.3 Server → client messages

All messages are JSON objects with a `type` field.

**`hello`** — sent on connect and after `auth`:

```json
{
  "type": "hello",
  "serverTime": 1792678348569,
  "seq": 31,
  "symbol": "ASIA50",
  "symbolName": "ASIA COMPOSITE INDEX",
  "timeframes": ["5s", "15s", "30s", "1m", "5m"],
  "priceDecimals": 2,
  "authenticated": true,
  "userId": "uuid",
  "tickIntervalMs": 100,
  "heartbeatMs": 30000
}
```

**`subscribed`**:

```json
{ "type": "subscribed", "symbol": "ASIA50", "timeframe": "5s", "seq": 31 }
```

**`tick`** — throttled and coalesced per client (default ≤ 15/s; see below):

```json
{ "type": "tick", "symbol": "ASIA50", "price": 6204.5, "time": 1792678348569, "seq": 47 }
```

**`candle`** — update of the forming candle (coalesced per timeframe):

```json
{ "type": "candle", "symbol": "ASIA50", "tf": "5s", "t": 1792678345000, "o": 6203.55, "h": 6203.55, "l": 6201.68, "c": 6201.68, "seq": 47 }
```

**`candle_closed`** — sent immediately, never throttled and never dropped:

```json
{ "type": "candle_closed", "symbol": "ASIA50", "tf": "5s", "candle": { "t": 1792678340000, "o": 6204.5, "h": 6204.9, "l": 6203.68, "c": 6203.68 }, "seq": 47 }
```

**`trade:opened`** (owner only):

```json
{ "type": "trade:opened", "trade": { "id": "uuid", "status": "open", "direction": "up", "amount": 10, "...": "..." } }
```

**`trade:settled`** (owner only):

```json
{ "type": "trade:settled", "id": "uuid", "result": "win", "payout": 18.5, "closePrice": 6210.75, "trade": { "...": "..." } }
```

`payout` is the total credited amount (stake + profit); `lose` → `0`, `draw` → stake.

**`balance`** (owner only) — after a trade opens/settles or a reset:

```json
{ "type": "balance", "amount": 9990, "amountCents": 999000, "currency": "USD" }
```

**`pong`**:

```json
{ "type": "pong", "id": "abc-1", "serverTime": 1792678348569, "seq": 47 }
```

**`replay`** — answer to `resume`:

```json
{ "type": "replay", "fromSeq": 12, "seq": 47, "ticks": [ { "type": "tick", "...": "..." } ], "candles": [ { "type": "candle", "...": "..." } ] }
```

**`resync`** — the requested sequence is older than the ring buffer:

```json
{ "type": "resync", "reason": "seq_too_old", "seq": 47 }
```

Client should then re-fetch `/api/candles` and continue.

**`error`**:

```json
{ "type": "error", "code": "TIMEFRAME_NOT_SUPPORTED", "message": "timeframe must be one of 5s, 15s, 30s, 1m, 5m" }
```

Codes: `INVALID_JSON`, `INVALID_MESSAGE`, `RATE_LIMITED`, `UNAUTHORIZED`,
`SYMBOL_INACTIVE`, `TIMEFRAME_NOT_SUPPORTED`, `TOO_MANY_SUBSCRIPTIONS`.

### 4.4 Throttling, heartbeat and resume

- **Ticks** are coalesced: each client has a pending slot; a timer flushes the newest
  price at `WS_TICK_MAX_PER_SEC` (default 15/s). A slow client receives fewer, newer
  ticks — the queue never grows. If `bufferedAmount` exceeds `WS_MAX_BUFFERED_BYTES`
  the pending tick/candles are dropped for that client.
- **Candles** are coalesced per timeframe at the same rate, so the chart stays smooth.
- **`candle_closed`** bypasses both queues: it is sent as soon as the bucket closes.
- **Heartbeat**: the server sends a WebSocket ping every `WS_HEARTBEAT_MS` (30 s) and
  terminates sockets that miss it. Application-level `ping`/`pong` is also supported.
  Clients should reconnect with exponential backoff and application-level pings.
- **Resume**: every `tick`/`candle` carries `seq`. After a reconnect send
  `{ "type": "resume", "lastSeq": <last seq you processed> }`; the server replays all
  buffered ticks after that sequence (up to 1000) plus the current candle per timeframe.
  If the gap is too old the server answers `resync` and the client refetches history.

### 4.5 Reference flow

```js
const ws = new WebSocket(`wss://host/ws?token=${token}`);
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', symbol: 'ASIA50', timeframe: '5s' }));
  if (msg.type === 'tick') lastSeq = msg.seq;
  if (msg.type === 'candle_closed') console.log('closed', msg.tf, msg.candle);
  if (msg.type === 'trade:settled') console.log('result', msg.result, msg.payout);
};
```

A complete runnable client is in [`examples/client.js`](../examples/client.js)
(`node examples/client.js --url http://localhost:3000 --duration 5`).

---

## 5. Data model

```
users(id, email, email_normalized UQ, password_hash, role, created_at)
accounts(user_id PK→users, balance_cents >= 0, currency, updated_at)
trades(id, user_id→users, symbol, direction, amount_cents>0, duration_sec>0,
       entry_price, entry_time, expiry_time, close_price, settled_at,
       status open|closed, result win|lose|draw, payout_rate, payout_mode,
       payout_cents>=0, idempotency_key, request_hash, created_at)
       UNIQUE(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       INDEX(status, expiry_time), INDEX(user_id, created_at)
candles(symbol, tf, t, o, h, l, c)  PK(symbol, tf, t)   -- 24–48 h retention
audit_log(id, user_id, actor user|admin|system, action, trade_id, meta, ip, created_at)
settings(key, value, updated_at)    -- runtime business parameters (JSON)
schema_migrations(name, applied_at)
```

Every balance change happens inside a database transaction together with the trade
row and an audit row. Settlement claims a trade with
`UPDATE ... WHERE id = ? AND status = 'open'`, so it can never pay twice.
