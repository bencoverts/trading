# Test Report

_Last run: the numbers below come from `npx vitest run` and
`npm run typecheck` on Node 22.22.3 (Linux x64), SQLite driver `node:sqlite`._

## Summary

| suite | file | tests | result |
| --- | --- | --- | --- |
| unit — payout & money | `test/unit/payout.test.ts` | 12 | pass |
| unit — candle aggregation | `test/unit/candles.test.ts` | 7 | pass |
| unit — price engine & feed | `test/unit/price-engine.test.ts` | 12 | pass |
| integration — public market API | `test/integration/market-api.test.ts` | 11 | pass |
| integration — auth & security | `test/integration/auth.test.ts` | 12 | pass |
| integration — trade creation/validation | `test/integration/trades.test.ts` | 14 | pass |
| integration — concurrent balance safety | `test/integration/concurrency.test.ts` | 3 | pass |
| integration — settlement | `test/integration/settlement.test.ts` | 8 | pass |
| integration — admin & payments stubs | `test/integration/admin.test.ts` | 19 | pass |
| integration — account & demo wallet | `test/integration/account.test.ts` | 11 | pass |
| integration — WebSocket | `test/integration/ws.test.ts` | 9 | pass |
| integration — browser UI (jsdom) | `test/integration/frontend.test.ts` | 5 | pass |
| **total** | **12 files** | **123** | **123 pass, 0 fail** |

```
Test Files  12 passed (12)
     Tests  123 passed (123)
  Duration  ~4.5 s
```

`npm run typecheck` (`tsc -p tsconfig.json --noEmit` + `tsc -p tsconfig.test.json`)
exits 0 with no diagnostics.

## What is actually verified

### Price simulation and candles
* Tick prices are finite, strictly positive and quantised to the market's
  decimals; invalid input (`0`, `NaN`) is rejected.
* The feed is deterministic for a seeded RNG and drifts up/down with the admin
  trend. `liar` produces a wider range than `sepi`.
* Sequence numbers increase per market independently.
* Buckets align to timeframe boundaries; one tick crossing a boundary emits
  exactly one `candle_closed`; a shared boundary closes `5s`, `15s`, `30s` and
  `1m` together while `5m`/`15m`/`1h` stay open.
* Late ticks for an already closed bucket do not mutate history.
* History paging (`limit`, `before`) returns closed candles only and stops at the
  requested boundary; seeding de-duplicates timestamps; pruning drops old ones.
* `priceAt(expiry)` resolves the last tick at or before an instant and returns
  `null` when nothing exists.

### Payout and settlement
* UP wins above entry, DOWN wins below entry, equal prices are a draw for both
  directions (including `0.1 + 0.2` float noise).
* Profit mode: stake + 85 % on win, 0 on loss, refund on draw; rounding is to
  whole minor units. Total mode treats the rate as the total return.
* Integration: win → balance `+85 %` profit; lose → stake gone; draw → exact
  refund; DOWN wins on a falling price; nothing settles before `expiryTime`.
* Two consecutive settlement passes pay once (claim-based
  `UPDATE … WHERE status='open'`).
* A trade that expired while the process was down is settled by the next boot
  (verified with the real server: place 10 s trade → SIGTERM → restart → the
  trade is `closed`, `settledBy: expiry`).
* When no tick exists after entry, the stake is refunded instead of inventing a
  result.

### Balance safety (mandatory `BEGIN IMMEDIATE` requirement)
* 25 parallel `POST /trades` of $100 against a $1,000 balance → exactly **10**
  succeed, 15 fail with `INSUFFICIENT_FUNDS`, wallet ends at `0`, and the sum of
  stakes equals the amount debited.
* A second burst after the balance is exhausted creates nothing (wallet stays
  `>= 0`, enforced by `CHECK (balance_minor >= 0)` as well).
* A manually pinned balance is honoured by the next request (no stale reads).

### Validation and trading rules
* `durationSec` outside 5–28800 → `400`; inside the range but not on the admin
  allow-list (e.g. 7) → `422 DURATION_NOT_ALLOWED`.
* Amount below minimum / above maximum → `422 AMOUNT_NOT_ALLOWED`; zero or
  negative → `400`.
* Unknown direction/timeframe → `400`; unknown market → `404 MARKET_NOT_FOUND`.
* Paused market → `422 MARKET_PAUSED`; withdrawn (`active=false`) → no trades.
* Unauthenticated trade → `401`; another user's trade → `404`.
* Max-open-trades limit is enforced after the admin lowers it to 1.
* Idempotency: same key + same payload → same trade, one debit, `200` +
  `Idempotent-Replayed`; same key + different payload → `409`.

### Accounts, sessions, security
* Registration creates USD/IDR/USDT wallets with the configured starting
  balances and a verification link; duplicate email/username → `409` with
  distinct codes; short password/invalid email → `400` with per-field details.
* Verification tokens are single use; reset tokens are single use and revoke old
  sessions (`token_version`); the old password stops working.
* Forgot-password answers identically for unknown addresses (no enumeration).
* Login by email **or** username; wrong password → `401`; blocked user → `403`
  and their existing session is revoked.
* Auth rate limiting returns `429` after the configured number of attempts.
* Logout clears the cookie (`Max-Age=0`/expiry) and requires a session for the
  first call.
* Helmet headers present (`CSP`, `nosniff`, no `x-powered-by`); CORS reflects
  only allow-listed origins.
* Bearer tokens work as an alternative to the cookie; garbage tokens → `401`.
* Admin: anonymous → `401` and normal user → `403` on every admin route; a JWT
  whose payload claims `role: admin` (invalid signature) → `401`, and a valid
  non-admin token → `403` (the database is the source of truth).
* Admin market/settings/wallet/block/manual-settlement actions are written to the
  audit log with actor, target, previous value and reason; manual settlement
  without a reason → `400`, twice → `409`.
* Payments endpoints validate their payload then answer `501 NOT_AVAILABLE`
  ("belum tersedia").

### WebSocket
* `hello` advertises markets/timeframes and `simulation: true`.
* Subscribing yields the snapshot plus live `tick` and `candle` frames for that
  market only; `candle_closed` arrives once per boundary, never throttled.
* `ping` → `pong`; malformed JSON → `INVALID_JSON` without dropping the socket;
  unknown market/timeframe → `MARKET_NOT_FOUND` / `TIMEFRAME_NOT_SUPPORTED`.
* `resume` replays missed ticks with `seq > lastSeq`; a stale sequence gets
  `resync`.
* Token-authenticated sockets receive `trade:opened` and `balance` pushes.
* A foreign browser origin is refused by the origin check.

### Browser UI (jsdom against the real server)
* The app boots, fetches `/config`, `/account` and `/markets`, and renders the
  trading layout: 3 markets, chart canvas, 7 timeframes, BUY/SELL, quick amount
  buttons (`½`, `x2`, `min`, `max`), 12 duration presets, payout preview, and the
  **SIMULASI** label.
* A market switch plus a server tick updates the live price through the
  WebSocket (verified `0.43210` for DOGE).
* Login, register and forgot-password pages render and navigation does not throw.
* Signed-in flow: demo balance shows in the header, BUY opens the confirmation
  dialog (market, entry price, payout), confirming creates the trade and it
  appears in the open-trades list.
* No uncaught errors or unhandled rejections in the window during the run.

### Operationally verified (manual, not automated)
* `npm run build` (tsc → `dist/`) and `npm start` under `NODE_ENV=production`
  with a real `JWT_SECRET`/`ADMIN_PASSWORD`: `/healthz` → 200, static UI → 200
  for HTML/CSS/JS, register → wallets, trade → settlement after 5 s
  (`lose`, payout 0, `settledBy: expiry`).
* Graceful `SIGTERM` shutdown (flushes ticks/candles, closes sockets) and restart
  on the same database, including catch-up settlement of a trade that expired
  during downtime.
* `npm run migrate` and `npm run seed` are idempotent (second run applies
  nothing).
* Fixed: `before` paging had appended the forming candle; ticks were only
  buffered after `start()`; the WS fan-out keyed ticks by `market|tf` so nothing
  was delivered. All three are covered by the tests above now.

## Failures found and fixed during development

Recorded because an "all green" report is only meaningful with the history:

1. Candle paging returned the forming candle on the second page (fixed in
   `MarketDataService.candles`; asserted in `market-api.test.ts`).
2. Tick buffering depended on `start()` being called, so short-lived runtimes
   lost ticks (subscribed in the constructor; asserted in `market-api` and
   `candle` tests).
3. WebSocket tick fan-out never matched a subscription (wrong key) — caught by
   `ws.test.ts` after it was written.
4. Settings cross-field validation threw a bare `Error` → HTTP 500; now a
   `400 VALIDATION_ERROR` with the reason.
5. Test-only issues: supertest does not persist cookies between requests; the
   WS `hello` frame arrives before a listener is attached (buffered in the test
   helper); jsdom's `WebSocket` breaks if the Node `Event` global is replaced
   (the harness keeps Node's `Event`).

## Known gaps / not verified

* **No real browser was used** (the sandbox has no headless Chrome). The UI is
  verified through jsdom with a stubbed 2D canvas context: DOM wiring, data flow
  and the WebSocket path are exercised, but **visual layout, canvas rendering
  and CSS are not pixel-tested**. Please eyeball it in a browser.
* **`better-sqlite3` was never exercised on this machine.** Its native binding
  could not be downloaded or compiled in the sandbox (no network access to
  `nodejs.org`), so every test ran on the `node:sqlite` fallback. The adapter's
  `better-sqlite3` path is the primary documented driver and shares the same
  SQL; it is pinned in `package.json` and should be smoke-tested on the target
  host. The fallback prints `ExperimentalWarning: SQLite is an experimental
  feature` on Node 22.
* No load/soak test (throughput, memory under many sockets), no fuzzing.
* Email delivery is a dev mailer; no SMTP/API provider was tested.
* Payments are stubs by design — nothing real-money was implemented or tested.
* Admin UI is covered indirectly (API tests + shared component code); the
  admin screens themselves are **not** part of the jsdom test.
* Timezone rendering in the UI uses the browser locale; tests do not assert
  formatted dates.
* SQLite is single-writer; concurrency beyond one process was not tested.

## How to reproduce

```bash
npm install --ignore-scripts   # or plain npm install with a C++ toolchain / prebuilt binaries
npm run typecheck
npm test
```

The suite uses in-memory-equivalent temporary SQLite files, a fake clock, no
background timers and `RATE_*` limits raised for most tests (the rate-limit test
opts back in). No network access is required except when the jsdom test boots a
local server on `127.0.0.1`.
