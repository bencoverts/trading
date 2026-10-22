# API Reference (v2)

All endpoints live under `/api/v1`. Every response that carries market data or a
trade includes `"simulation": true`, and public market payloads also carry
`"label": "SIMULASI"`.

* Base URL (dev): `http://localhost:3000`
* Content type: `application/json` (max body 64 KB)
* Auth: httpOnly session cookie (`sim_session`) **or** `Authorization: Bearer <jwt>`
* Time: every timestamp is **server epoch milliseconds**. The client never sends
  time, price or result values.
* Money: amounts in requests/responses are **major units** (`10.5`) plus an
  explicit `…Minor` integer field where precision matters. Internally the server
  only stores minor units (USD/USDT = cents, IDR = whole rupiah).

---

## 1. Health & public config

### `GET /healthz`
No auth. Used by the process supervisor.

```json
{
  "status": "ok",
  "simulation": true,
  "serverTime": 1792679338230,
  "uptimeSec": 42,
  "db": "ok",
  "dbDriver": "better-sqlite3",
  "markets": [
    { "symbol": "DOGE", "lastPrice": 0.41592, "lastSeq": 55, "paused": false }
  ],
  "realtime": { "connections": 2 },
  "version": "2.0.0"
}
```
`503` when the database is unreachable.

### `GET /api/v1/config`
No auth. Public trading configuration (durations, payout, limits, FX rates,
timeframes) so the UI can render before login.

```json
{
  "simulation": true,
  "label": "SIMULASI",
  "serverTime": 1792679338257,
  "payout": { "rate": 0.85, "mode": "profit" },
  "durations": {
    "allowed": [5, 10, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800],
    "presets": [5, 10, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800],
    "minSec": 5,
    "maxSec": 28800
  },
  "limits": {
    "maxOpenTrades": 10,
    "minAmount": { "USD": 1, "IDR": 10000, "USDT": 1 },
    "maxAmount": { "USD": 1000, "IDR": 10000000, "USDT": 1000 },
    "topupMax": { "USD": 1000, "IDR": 10000000, "USDT": 1000 },
    "topupDailyCount": 5
  },
  "currencies": ["USD", "IDR", "USDT"],
  "rates": { "USD": 1, "IDR": 16000, "USDT": 1 },
  "timeframes": ["5s", "15s", "30s", "1m", "5m", "15m", "1h"],
  "moods": ["sepi", "normal", "cepat", "liar"],
  "trends": ["up", "down", "neutral"]
}
```

---

## 2. Markets (public, no login)

### `GET /api/v1/markets`
```json
{
  "simulation": true,
  "label": "SIMULASI",
  "serverTime": 1792679338249,
  "markets": [
    {
      "symbol": "ASIA_COMPOSITE",
      "name": "Asia Composite Index",
      "description": "Simulated index of Asian markets (fictional price series).",
      "priceDecimals": 2,
      "mood": "normal",
      "trend": "neutral",
      "volatility": 1,
      "paused": false,
      "pauseReason": null,
      "active": true,
      "simulation": true,
      "label": "SIMULASI",
      "ticker": {
        "price": 6204.19,
        "change24h": -37.82,
        "change24hPercent": -0.6058,
        "serverTime": 1792679338245
      }
    }
  ]
}
```

The three instruments are `ASIA_COMPOSITE`, `CRYPTO_COMPOSITE` and `DOGE`
(simulated DOGE/USDT series — not the real Dogecoin price).

### `GET /api/v1/markets/:symbol/ticker`
```json
{
  "market": "DOGE",
  "name": "Dogecoin (simulated)",
  "simulation": true,
  "label": "SIMULASI",
  "price": 0.41592,
  "priceDecimals": 5,
  "change24h": -0.01986,
  "change24hPercent": -4.5573,
  "high24h": 0.43786,
  "low24h": 0.37874,
  "paused": false,
  "active": true,
  "mood": "liar",
  "trend": "neutral",
  "volatility": 1.4,
  "serverTime": 1792679338257
}
```
`change24h` is `null` when there is not enough history (fresh database).
Unknown or inactive market → `404 MARKET_NOT_FOUND`.

### `GET /api/v1/markets/:symbol/candles`
| query | values | default |
| --- | --- | --- |
| `tf` | `5s`, `15s`, `30s`, `1m`, `5m`, `15m`, `1h` | `1m` |
| `limit` | 1–1000 | 300 |
| `before` | epoch ms, exclusive | – |
| `includeCurrent` | `true`/`false` | `true` |

```json
{
  "market": "DOGE",
  "tf": "1m",
  "tfMs": 60000,
  "serverTime": 1792679338267,
  "priceDecimals": 5,
  "simulation": true,
  "label": "SIMULASI",
  "candles": [
    { "t": 1792679220000, "o": 0.42872, "h": 0.42876, "l": 0.42833, "c": 0.42866 }
  ],
  "current": { "t": 1792679280000, "o": 0.42871, "h": 0.42871, "l": 0.41235, "c": 0.41592 }
}
```
Candles are aggregated **on the server** from the simulated tick stream and
persisted. `current` is the still-forming candle (omitted from paged results when
`before` is used, so pagination only returns closed candles).
Invalid `tf` → `400 VALIDATION_ERROR`.

### `GET /api/v1/markets/:symbol/ticks`
| query | values | default |
| --- | --- | --- |
| `since` | epoch ms | – |
| `limit` | 1–5000 | 500 |

```json
{
  "market": "DOGE",
  "simulation": true,
  "label": "SIMULASI",
  "serverTime": 1792679338257,
  "priceDecimals": 5,
  "ticks": [{ "price": 0.41592, "time": 1792679338257 }]
}
```
Ticks are ordered oldest → newest. Retention is 7 days (`TICK_RETENTION_DAYS`).

---

## 3. Authentication

Session cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when
`COOKIE_SECURE=true`. Cookie name: `sim_session` (configurable).
The token is a HS256 JWT valid for `SESSION_TTL_SEC` and carries a
`token_version` that is bumped on password change, reset and blocking, which
revokes existing sessions.

### `POST /api/v1/auth/register`
```json
{ "email": "you@example.com", "username": "trader1", "password": "min 8 chars" }
```
`201` → `{ user, wallets, token, simulation: true, devVerificationLink? }`

* Creates one demo wallet per currency (USD, IDR, USDT) with the
  admin-configured starting balance.
* Sends a verification link. In development the link is logged **and** returned
  as `devVerificationLink` (never in production).
* Errors: `409 EMAIL_TAKEN`, `409 USERNAME_TAKEN`, `400 VALIDATION_ERROR`.

### `POST /api/v1/auth/login`
```json
{ "identifier": "you@example.com or username", "password": "…" }
```
`200` → `{ user, wallets, token, simulation: true }` + `Set-Cookie`.
Errors: `401 INVALID_CREDENTIALS`, `403 ACCOUNT_BLOCKED`, `429 RATE_LIMITED`.

### `POST /api/v1/auth/logout` (auth required)
Clears the cookie. `200 { ok: true }`. The JWT itself is stateless — the client
stops sending it.

### `POST /api/v1/auth/verify-email`
`{ "token": "…" }` → `200 { user, ok: true }`. Single use; `400 INVALID_TOKEN`
when expired/reused.

### `POST /api/v1/auth/forgot-password`
`{ "email": "…" }` → always `200` with the same message (no account
enumeration). In development the reset link is returned as `devResetLink`.

### `POST /api/v1/auth/reset-password`
`{ "token": "…", "password": "…" }` → `200 { ok: true }`. Single use, bumps
`token_version` (all sessions revoked).

### `GET /api/v1/auth/dev/link?email=…` (development only)
Returns the last verification/reset link issued for that address. Disabled when
`DEV_EMAIL_LINKS=false` (forced off in production).

---

## 4. Account & demo wallet (auth required)

### `GET /api/v1/account`
```json
{
  "user": {
    "id": "uuid", "email": "you@example.com", "username": "trader1",
    "role": "user", "emailVerified": true, "blocked": false,
    "displayCurrency": "USD", "createdAt": 1792679343588
  },
  "wallets": [
    { "currency": "USD", "balance": 990, "balanceMinor": 99000, "display": 990 }
  ],
  "displayCurrency": "USD",
  "rates": { "USD": 1, "IDR": 16000, "USDT": 1 },
  "limits": { "minAmount": {...}, "maxAmount": {...}, "topupMax": {...}, "topupDailyCount": 5, "maxOpenTrades": 10 },
  "openTrades": 1,
  "payout": { "rate": 0.85, "mode": "profit" },
  "simulation": true
}
```

### `PATCH /api/v1/account`
`{ "displayCurrency": "IDR" }` → updated `{ user }`. Display only; no conversion
of stored balances happens.

### `POST /api/v1/account/password`
`{ "currentPassword": "…", "newPassword": "…" }` → `200 { ok: true }` and a fresh
cookie. Errors: `401 INVALID_CREDENTIALS`, `400 VALIDATION_ERROR`.

### `POST /api/v1/account/reset`
Restores every demo wallet to the configured starting balance and voids open
trades at their entry price (full refund, `result: "draw"`). Audited.

```json
{ "wallets": [...], "voidedTrades": 1, "simulation": true }
```

### `POST /api/v1/wallet/topup`
Instant **DEMO** top-up. No QRIS, no bank transfer, no payment gateway.

```json
{ "currency": "USD", "amount": 100 }
```
`201` → `{ wallet, wallets, simulation: true, message: "Demo balance topped up (virtual money only)" }`

Errors: `422 AMOUNT_NOT_ALLOWED` (above `topupMax`), `422 RATE_LIMITED`
(daily count exceeded), `400 VALIDATION_ERROR`.

### `GET /api/v1/wallet/transactions?limit=50`
```json
{ "transactions": [{ "id": "uuid", "currency": "USD", "amount": 100, "amountMinor": 10000, "kind": "demo_topup", "note": "Instant demo top-up", "createdAt": 1792679343588 }] }
```

---

## 5. Trading (auth required)

### `POST /api/v1/trades`
Headers: optional `Idempotency-Key` (8–128 chars, `[A-Za-z0-9._:-]`).

```json
{
  "market": "DOGE",
  "direction": "up",
  "currency": "USD",
  "amount": 10,
  "durationSec": 60
}
```

`201` (or `200` + `Idempotent-Replayed: true` for a replay)
```json
{
  "trade": {
    "id": "uuid", "userId": "uuid", "market": "DOGE", "direction": "up",
    "currency": "USD", "amount": 10, "amountMinor": 1000, "durationSec": 60,
    "entryPrice": 0.40873, "entryTime": 1792679343617, "expiryTime": 1792679403617,
    "closePrice": null, "status": "open", "result": null,
    "payoutRate": 0.85, "payoutMode": "profit",
    "payout": null, "payoutMinor": null, "profit": null, "profitMinor": null,
    "settledBy": null, "settleReason": null, "createdAt": 1792679343617
  },
  "wallets": [{ "currency": "USD", "balance": 990, "balanceMinor": 99000 }],
  "simulation": true
}
```

Server rules (all enforced server-side, in this order):

| check | error |
| --- | --- |
| market exists | `404 MARKET_NOT_FOUND` |
| market open (`active`) | `422 MARKET_CLOSED` |
| market not paused | `422 MARKET_PAUSED` |
| schema (`direction`, currency, amount > 0, 5 ≤ duration ≤ 28800) | `400 VALIDATION_ERROR` |
| duration on the admin allow-list | `422 DURATION_NOT_ALLOWED` |
| amount within min/max for the currency | `422 AMOUNT_NOT_ALLOWED` |
| open-trade count below limit | `422 TRADE_LIMIT_REACHED` |
| **balance ⩾ amount** | `422 INSUFFICIENT_FUNDS` |

The balance check and the debit happen inside a single
`BEGIN IMMEDIATE` transaction together with the trade insert, and the schema
enforces `CHECK (balance_minor >= 0)`. Concurrent requests therefore cannot
overdraw an account (see `test/integration/concurrency.test.ts`).
`entryPrice` is the latest server tick and `entryTime` is the server clock at
insert time; `payoutRate`/`payoutMode` are snapshotted onto the trade.

### `GET /api/v1/trades?status=open|closed|all&limit=50&offset=0`
Open trades include a live estimate computed from the current server price:
`livePrice`, `estimatedResult` (`win|lose|draw|pending`), `estimatedPayout`.

### `GET /api/v1/trades/:id`
Own trade only, otherwise `404`. Settled trades carry `result`
(`win|lose|draw`), `closePrice`, `payout`, `profit`, `settledBy`
(`expiry|admin`) and `settleReason`.

**Settlement rules**

| outcome | condition | payout |
| --- | --- | --- |
| win | UP and close > entry, or DOWN and close < entry | `stake + round(stake × rate)` (profit mode, default 0.85 → +85 %) |
| lose | opposite direction | `0` |
| draw | close == entry (server-quantised) | stake refunded |

Settlement runs on an interval (`SETTLE_INTERVAL_MS`), once at boot (this is how
trades that expired during downtime are completed) and is claim-based
(`UPDATE … WHERE status='open'`), so a trade can never pay twice.

---

## 6. Admin (`role = admin` required on every route)

A normal user gets `403 FORBIDDEN`; an anonymous request gets `401`. The role is
read from the database, not from the token.

### `GET /api/v1/admin/stats`
```json
{
  "users": { "total": 12, "admins": 1, "blocked": 0, "verified": 9 },
  "trades": { "total": 40, "open": 3, "wins": 17, "losses": 19, "draws": 1,
              "volumeMinor": 500000, "payoutMinor": 300000,
              "simulatedProfitMinor": 200000, "openExposureMinor": 25000 },
  "wallets": [{ "currency": "USD", "totalMinor": 1234500 }],
  "demoTopups": { "count": 4, "totalMinor": 40000 },
  "settings": { "...": "..." },
  "generatedAt": 1792679338257,
  "simulation": true
}
```
`volumeMinor`/`payoutMinor` mix currencies; they are reported in minor units for
transparency, not as a real P&L.

### `GET /api/v1/admin/markets`
All markets (including inactive) plus live engine state
(`mood`, `trend`, `volatility`, `momentum`, `seq`, `lastPrice`, `paused`).

### `PATCH /api/v1/admin/markets/:symbol`
```json
{ "trend": "up", "mood": "liar", "volatility": 1.8, "paused": true, "pauseReason": "maintenance", "active": true }
```
All fields optional; `volatility` ∈ [0.01, 20]. Applies to the live feed
immediately and writes an `admin.market_updated` audit entry containing the
patch and the previous values.

### `GET /api/v1/admin/settings` / `PATCH /api/v1/admin/settings`
PATCH accepts any subset of:

```json
{
  "payoutRate": 0.85,
  "payoutMode": "profit",
  "allowedDurations": [5, 10, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800],
  "maxOpenTrades": 10,
  "minAmount": { "USD": 1, "IDR": 10000, "USDT": 1 },
  "maxAmount": { "USD": 1000, "IDR": 10000000, "USDT": 1000 },
  "initialBalance": { "USD": 1000, "IDR": 15000000, "USDT": 1000 },
  "topupMax": { "USD": 1000, "IDR": 10000000, "USDT": 1000 },
  "topupDailyCount": 5,
  "rates": { "IDR": 16000, "USDT": 1 }
}
```
Cross-field rules return `400`: `payoutMode="total"` requires `payoutRate > 1`,
`maxAmount ≥ minAmount`, positive FX rates, at least one duration. Every change
is audited as `settings.updated`.

### `GET /api/v1/admin/trades?status=&market=&userId=&result=&limit=&offset=`
Trades joined with `email`/`username`, newest first.

### `POST /api/v1/admin/trades/:id/settle`
```json
{ "reason": "required, 5-300 chars", "closePrice": 0.45 }
```
`closePrice` is optional (defaults to the current server price). Writes
`admin.trade_settled` with the reason. Already-closed trade → `409 CONFLICT`.

### `GET /api/v1/admin/users?search=&limit=&offset=`
### `GET /api/v1/admin/users/:id`
Profile, wallets, recent trades, deposits and audit entries.

### `POST /api/v1/admin/users/:id/block`
`{ "blocked": true, "reason": "abuse" }` → revokes sessions and blocks login.
Admin accounts cannot be blocked (`403`).

### `POST /api/v1/admin/users/:id/wallet`
`{ "currency": "USD", "delta": 250, "reason": "compensation" }` — signed delta in
major units. Negative deltas cannot overdraw (`422 INSUFFICIENT_FUNDS`).
Audited as `admin.wallet_adjusted`.

### `GET /api/v1/admin/audit?action=&actorUserId=&targetId=&limit=&offset=`
Newest first; `meta` is parsed back into an object. Actions include:
`user.registered`, `user.logged_in`, `user.email_verified`,
`user.password_changed`, `user.password_reset`, `wallet.demo_topup`,
`wallet.reset`, `account.reset`, `trade.opened`, `trade.settled`,
`admin.market_updated`, `admin.trade_settled`, `admin.wallet_adjusted`,
`admin.user_blocked`, `admin.user_unblocked`, `settings.updated`,
`admin.seeded`.

---

## 7. Payments (deliberately not implemented)

| method | path | response |
| --- | --- | --- |
| GET | `/api/v1/payments/providers` | `200` list, all `available: false` |
| POST | `/api/v1/payments/deposit` | `501 NOT_AVAILABLE` |
| POST | `/api/v1/payments/withdraw` | `501 NOT_AVAILABLE` |
| GET | `/api/v1/payments/history` | `501 NOT_AVAILABLE` |

Bodies are validated first (so the future contract is testable) and then refused:

```json
{
  "error": { "code": "NOT_AVAILABLE", "message": "belum tersedia - real-money deposits and withdrawals are not implemented. Only the instant DEMO top-up (/api/v1/wallet/topup) exists in this build." },
  "status": "not_available"
}
```

The interface seam lives in `src/payments/service.ts` (`PaymentProvider`,
`DepositRequest`, `PaymentResult`). No QRIS, bank transfer, card or crypto
integration exists in this build.

---

## 8. WebSocket `GET /ws`

Optional `?token=<jwt>` authenticates the socket (otherwise use the `auth`
message). Origin is validated against `CORS_ORIGINS` / same host; the payload cap
is 8 KB; `WS_MAX_CONNECTIONS` and `WS_MAX_SUBSCRIPTIONS` are enforced.

### Client → server
```json
{ "type": "subscribe", "market": "DOGE", "timeframe": "5s" }
{ "type": "unsubscribe", "market": "DOGE", "timeframe": "5s" }
{ "type": "ping", "id": 1 }
{ "type": "auth", "token": "<jwt>" }
{ "type": "resume", "market": "DOGE", "lastSeq": 1200 }
```
Message budget: 30 messages/second per connection, otherwise
`{ "type": "error", "code": "RATE_LIMITED" }`.

### Server → client
```json
{ "type": "hello", "serverTime": 1792679338257, "simulation": true,
  "markets": [{ "symbol": "DOGE", "name": "Dogecoin (simulated)", "lastSeq": 55, "paused": false, "priceDecimals": 5 }],
  "timeframes": ["5s", "15s", "30s", "1m", "5m", "15m", "1h"],
  "authenticated": false, "userId": null, "tickMaxPerSec": 15, "heartbeatMs": 30000 }

{ "type": "subscribed", "market": "DOGE", "timeframe": "5s",
  "snapshot": { "lastPrice": 0.41592, "candle": { "t": 1792679280000, "o": 0.42, "h": 0.421, "l": 0.41, "c": 0.41592 } } }

{ "type": "tick", "market": "DOGE", "price": 0.41592, "time": 1792679338257, "seq": 56 }

{ "type": "candle", "market": "DOGE", "tf": "5s", "t": 1792679280000, "o": 0.42, "h": 0.421, "l": 0.41, "c": 0.41592, "seq": 56 }

{ "type": "candle_closed", "market": "DOGE", "tf": "5s",
  "candle": { "t": 1792679280000, "o": 0.42, "h": 0.421, "l": 0.41, "c": 0.41592 }, "seq": 56 }

{ "type": "replay", "market": "DOGE", "fromSeq": 50, "seq": 56,
  "ticks": [{ "price": 0.41, "time": 1792679338000, "seq": 51 }],
  "candles": [{ "tf": "5s", "t": 1792679280000, "o": 0.42, "h": 0.421, "l": 0.41, "c": 0.41592 }] }

{ "type": "resync", "market": "DOGE", "reason": "seq_too_old", "seq": 56 }

{ "type": "pong", "id": 1, "serverTime": 1792679338257 }
{ "type": "error", "code": "INVALID_MESSAGE", "message": "…" }
```

Authenticated sockets also receive account pushes:
```json
{ "type": "trade:opened", "trade": { "...": "TradeView" } }
{ "type": "trade:settled", "id": "uuid", "result": "win", "payout": 18.5, "closePrice": 0.421, "trade": { "...": "TradeView" } }
{ "type": "balance", "wallets": [{ "currency": "USD", "balance": 1009.5, "balanceMinor": 100950 }] }
{ "type": "account:reset", "wallets": [ ... ] }
```

Behaviour:
* Ticks are **coalesced per client** and flushed at `WS_TICK_MAX_PER_SEC`
  (default 15/s). `candle_closed` is never throttled.
* Server heartbeat: protocol ping every `WS_HEARTBEAT_MS`; clients that do not
  answer two heartbeats are terminated. Clients should also send their own
  `ping` (the bundled front-end does).
* `seq` is per market and monotonically increasing. On reconnect send `resume`
  with the last sequence seen; if the in-memory buffer no longer covers it the
  server answers `resync` and the client must reload history via
  `GET /candles`.

---

## 9. Errors

Every error uses the same envelope:

```json
{ "error": { "code": "AMOUNT_NOT_ALLOWED", "message": "amount must be between 100 and 100000 minor units", "details": { "minMinor": 100, "maxMinor": 100000, "currency": "USD" } } }
```

| HTTP | codes |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `INVALID_TOKEN` |
| 401 | `UNAUTHORIZED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN`, `ACCOUNT_BLOCKED`, `EMAIL_NOT_VERIFIED` |
| 404 | `NOT_FOUND`, `MARKET_NOT_FOUND` |
| 409 | `CONFLICT`, `EMAIL_TAKEN`, `USERNAME_TAKEN`, `IDEMPOTENCY_KEY_REUSED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `INSUFFICIENT_FUNDS`, `AMOUNT_NOT_ALLOWED`, `DURATION_NOT_ALLOWED`, `MARKET_PAUSED`, `MARKET_CLOSED`, `TRADE_LIMIT_REACHED`, `RATE_LIMITED` |
| 429 | `RATE_LIMITED` (HTTP limiter) |
| 500 | `INTERNAL` |
| 501 | `NOT_AVAILABLE` (payments) |

Rate limits (per IP unless noted, configurable):

| scope | default |
| --- | --- |
| auth endpoints | 20 / minute |
| `POST /trades` | 30 / minute per user |
| everything | 1200 / minute |
| WebSocket messages | 30 / second per socket |

---

## 10. Minimal client example

```bash
# 1. register (sets the session cookie in a cookie jar)
curl -c jar.txt -X POST localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","username":"demo","password":"password-12345"}'

# 2. public market data
curl -s localhost:3000/api/v1/markets/DOGE/ticker

# 3. place a 60 s UP trade of $10
curl -b jar.txt -X POST localhost:3000/api/v1/trades \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"market":"DOGE","direction":"up","currency":"USD","amount":10,"durationSec":60}'

# 4. watch your open trades
curl -b jar.txt localhost:3000/api/v1/trades?status=open
```

```js
// WebSocket subscription
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onmessage = (event) => console.log(JSON.parse(event.data));
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', market: 'DOGE', timeframe: '5s' }));
};
```
