# API Reference (v3)

Semua endpoint berada di bawah `/api/v1`. Setiap payload pasar/trade memuat
`"simulation": true`; payload publik juga memuat `"label": "SIMULASI"`.

- Base URL (dev): `http://localhost:3000`
- Content type: `application/json` (body ≤ 256 KB, upload ≤ 512 KB)
- Auth: cookie sesi httpOnly (`sim_session`) — `Authorization: Bearer <jwt>`
  hanya untuk klien non-browser/tes
- CSRF: header `x-csrf-token` wajib pada semua mutasi bersesi; nilainya sama
  dengan cookie `sim_csrf` (double submit)
- Idempotency: header `Idempotency-Key` **wajib** pada `POST /trades`
- Waktu: semua timestamp = epoch milidetik **dari server**. Klien tidak pernah
  mengirim harga, waktu, atau hasil.
- Uang: request/response memakai satuan utama (`10.5`) plus field `…Minor`
  (integer) bila presisi penting. Penyimpanan selalu minor unit.
- Format error: `{ "error": { "code": "…", "message": "…", "details"?: … } }`

Kontrak mesin: `docs/openapi.yaml`. Kontrak WebSocket: bagian 9.

---

## 1. Health & konfigurasi publik

### `GET /healthz`

Tanpa auth. `200` sehat / `503` DB bermasalah.

```json
{
  "status": "ok",
  "simulation": true,
  "label": "SIMULASI",
  "serverTime": 1792682410476,
  "uptimeSec": 42,
  "db": "ok",
  "dbDriver": "node:sqlite",
  "markets": [{ "symbol": "DOGE", "lastPrice": 0.41592, "lastSeq": 70, "paused": false }],
  "realtime": { "connections": 2 },
  "jobs": [{ "name": "settlement", "status": "ok", "stale": false }],
  "version": "3.0.0"
}
```

### `GET /config`

Konfigurasi trading publik.

```json
{
  "simulation": true,
  "label": "SIMULASI",
  "serverTime": 1792682410476,
  "platform": {
    "name": "SimTrade Demo",
    "accent": "#5b8cff",
    "defaultLanguage": "id",
    "defaultTimezone": "Asia/Jakarta",
    "disclaimer": "SIMULASI / DEMO…"
  },
  "payout": { "rate": 0.85, "mode": "profit", "byDuration": {} },
  "durations": {
    "allowed": [5, 10, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800],
    "presets": [5, 10],
    "minSec": 5,
    "maxSec": 28800
  },
  "limits": { "maxOpenTradesPerUser": 20, "globalMaxAmountUsd": 2000, "topupDailyCount": 5 },
  "currencies": [
    { "code": "USD", "decimals": 2 },
    { "code": "IDR", "decimals": 0 },
    { "code": "USDT", "decimals": 2 }
  ],
  "rates": { "USD": 1, "IDR": 16000, "USDT": 1 },
  "timeframes": ["5s", "15s", "30s", "1m", "5m", "15m", "1h"],
  "features": { "deposits": false, "withdrawals": false, "payments": false }
}
```

---

## 2. Pasar (publik)

| Method & path                                  | Keterangan                                                |
| ---------------------------------------------- | --------------------------------------------------------- |
| `GET /markets`                                 | daftar market aktif + ticker (last, 24 h change/high/low) |
| `GET /markets/:symbol`                         | detail market + 180 candle 1m + `current` + `engine`      |
| `GET /markets/:symbol/ticker`                  | ticker tunggal                                            |
| `GET /markets/:symbol/candles?tf&limit&before` | candle tertutup (`limit` ≤ 1000) + candle berjalan        |
| `GET /markets/:symbol/ticks?since&limit`       | tick terakhir (≤ 5000) untuk replay                       |
| `GET /markets/:symbol/history?limit`           | riwayat parameter simulasi — **publik**                   |

Contoh `GET /markets/DOGE/candles?tf=1m&limit=2`:

```json
{
  "market": "DOGE",
  "symbol": "DOGE",
  "simulation": true,
  "label": "SIMULASI",
  "tf": "1m",
  "tfMs": 60000,
  "serverTime": 1792682410476,
  "priceDecimals": 5,
  "candles": [
    { "t": 1792682340000, "o": 0.42871, "h": 0.42902, "l": 0.42843, "c": 0.42888 },
    { "t": 1792682400000, "o": 0.42888, "h": 0.42931, "l": 0.42861, "c": 0.42902 }
  ],
  "current": { "t": 1792682460000, "o": 0.42902, "h": 0.42944, "l": 0.42895, "c": 0.42921 }
}
```

Contoh entri riwayat parameter:

```json
{
  "market": "DOGE",
  "label": "SIMULASI",
  "entries": [
    {
      "id": 12,
      "action": "admin.market_simulated",
      "actorRole": "admin",
      "before": { "trend": "neutral", "volatilityPreset": "ekstrem", "mood": "liar" },
      "after": { "trend": "up", "trendStrength": 7, "volatilityPreset": "tinggi", "mood": "normal" },
      "note": null,
      "createdAt": 1792682410000
    }
  ]
}
```

---

## 3. Autentikasi

| Method & path                    | Body / catatan                                                            |
| -------------------------------- | ------------------------------------------------------------------------- |
| `POST /auth/register`            | `{email, username, password, acceptTerms: true, language}` → `201` + sesi |
| `POST /auth/login`               | `{identifier, password, totpCode?}` → sesi, atau `{totpRequired: true}`   |
| `POST /auth/logout`              | hapus sesi aktif                                                          |
| `POST /auth/logout-all`          | keluarkan semua perangkat lain                                            |
| `GET /auth/sessions`             | daftar sesi (`current`, `device`, `ip`, `lastSeenAt`)                     |
| `DELETE /auth/sessions/:id`      | keluarkan satu sesi milik sendiri                                         |
| `GET /auth/me`                   | sesi + profil + dompet + `csrfToken` + izin                               |
| `GET /auth/csrf`                 | token CSRF untuk klien                                                    |
| `GET /auth/permissions`          | matriks izin publik (dokumentasi)                                         |
| `POST /auth/verify-email`        | `{token}`                                                                 |
| `POST /auth/resend-verification` | sesi wajib                                                                |
| `POST /auth/forgot-password`     | `{email}` — selalu `200` (tidak bocor)                                    |
| `POST /auth/reset-password`      | `{token, password}` — token sekali pakai                                  |
| `POST /auth/2fa/setup`           | secret + otpauth URL                                                      |
| `POST /auth/2fa/enable`          | `{code}` → recovery codes (sekali tampil)                                 |
| `POST /auth/2fa/disable`         | `{password, code}`                                                        |
| `GET /auth/dev/link?email`       | **hanya** saat `DEV_EMAIL_LINKS=true`                                     |

Contoh `POST /auth/login` → `200`:

```json
{
  "user": {
    "id": "u_…",
    "email": "demo@simtrade.local",
    "username": "demo",
    "displayName": "Demo",
    "staffRole": null,
    "emailVerified": true,
    "twoFactorEnabled": false,
    "displayCurrency": "USD"
  },
  "wallets": [{ "currency": "USD", "balance": 1000, "balanceMinor": 100000 }],
  "csrfToken": "8f2c…",
  "permissions": [],
  "simulation": true,
  "label": "SIMULASI"
}
```

Kesalahan umum: `INVALID_CREDENTIALS` (401), `ACCOUNT_LOCKED` (423 setelah
`LOGIN_MAX_ATTEMPTS` gagal), `TOTP_REQUIRED`, `CSRF_FAILED` (403).

---

## 4. Akun & dompet (sesi wajib)

| Method & path                                                   | Keterangan                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /account`                                                  | profil, dompet, limit, cooldown, kurs, favorit, sesi aktif                   |
| `PATCH /account`                                                | `{displayName?, language?, timezone?, displayCurrency?}`                     |
| `POST /account/avatar`                                          | multipart `file` (PNG/JPG/WEBP/SVG)                                          |
| `DELETE /account/avatar`                                        | hapus avatar                                                                 |
| `POST /account/password`                                        | `{currentPassword, newPassword}` — sesi lain dicabut, cookie + CSRF dirotasi |
| `POST /account/reset`                                           | reset seluruh saldo demo (cooldown, trade terbuka dibatalkan)                |
| `GET /wallet`                                                   | dompet + kurs + cooldown + `lockedCurrency`                                  |
| `POST /wallet/topup`                                            | `{currency, amount}` — **virtual**, cap harian, cooldown                     |
| `POST /wallet/convert`                                          | `{from, to, amount}` — tercatat di `conversions`                             |
| `GET /wallet/transactions?currency&kind&limit`                  | ledger pengguna                                                              |
| `GET /wallet/conversions`                                       | riwayat konversi                                                             |
| `GET /favorites` / `PUT /favorites` / `POST /favorites/:symbol` | favorit                                                                      |
| `GET /notifications?limit`                                      | `{items, unread}`                                                            |
| `POST /notifications/read`                                      | `{id}` atau `{id:"all"}`                                                     |

`POST /wallet/topup` → `201`:

```json
{
  "wallet": { "currency": "USD", "balance": 1100, "balanceMinor": 110000 },
  "wallets": [ … ],
  "nextAllowedAt": 1792682440000,
  "simulation": true,
  "message": "Saldo demo ditambah (uang virtual)"
}
```

Kesalahan: `INSUFFICIENT_FUNDS` (422/400), `COOLDOWN` (429), `CURRENCY_LOCKED`
(409 saat mengganti mata uang dengan trade terbuka).

---

## 5. Trade

| Method & path                                           | Keterangan                           |
| ------------------------------------------------------- | ------------------------------------ |
| `POST /trades`                                          | buka trade — wajib `Idempotency-Key` |
| `POST /trades/preview`                                  | hitung payout/profit tanpa menyimpan |
| `GET /trades?status&market&result&from&to&limit&offset` | riwayat pengguna                     |
| `GET /trades/active`                                    | trade terbuka + estimasi             |
| `GET /trades/export.csv`                                | CSV riwayat (≤ 200 baris per ekspor) |
| `GET /trades/:id`                                       | satu trade                           |

Request `POST /trades`:

```json
{ "market": "DOGE", "direction": "up", "currency": "USD", "amount": 10, "durationSec": 60 }
```

Response `201` (replay identik → `200` + header `Idempotent-Replayed: true`):

```json
{
  "trade": {
    "id": "7b1d…",
    "market": "DOGE",
    "direction": "up",
    "currency": "USD",
    "amount": 10,
    "amountMinor": 1000,
    "durationSec": 60,
    "entryPrice": 0.42888,
    "entryTime": 1792682411000,
    "expiryTime": 1792682471000,
    "status": "open",
    "result": null,
    "payoutRate": 0.85,
    "estimatedResult": "win",
    "estimatedPayout": 18.5,
    "livePrice": 0.4291,
    "settledBy": null,
    "sim": true
  },
  "wallets": [{ "currency": "USD", "balance": 990, "balanceMinor": 99000 }],
  "simulation": true,
  "label": "SIMULASI"
}
```

Kesalahan:

| Kode                                                       | HTTP    | Penyebab                       |
| ---------------------------------------------------------- | ------- | ------------------------------ |
| `IDEMPOTENCY_KEY_REQUIRED`                                 | 400     | header tidak dikirim           |
| `IDEMPOTENCY_KEY_REUSED`                                   | 409     | key sama, payload berbeda      |
| `AMOUNT_NOT_ALLOWED`                                       | 422     | di luar min/max                |
| `DURATION_NOT_ALLOWED`                                     | 422     | durasi tidak diizinkan         |
| `INSUFFICIENT_FUNDS`                                       | 422     | saldo kurang                   |
| `MARKET_PAUSED` / `MARKET_CLOSED` / `MARKET_OUTSIDE_HOURS` | 409/422 | market tidak bisa ditradingkan |
| `TRADE_LIMIT_REACHED`                                      | 429     | terlalu banyak trade terbuka   |
| `EXPOSURE_LIMIT`                                           | 409     | melebihi eksposur market       |
| `RATE_LIMITED`                                             | 429     | rate limit per user/IP         |

Settlement: `win` bila close > entry (UP) atau close < entry (DOWN), `draw`
bila sama → refund penuh. `closePrice`, `settledBy` (`expiry`/`admin`), dan
`settleReason` disimpan di trade.

---

## 6. Halaman & banner (publik)

| Method & path      | Keterangan                           |
| ------------------ | ------------------------------------ |
| `GET /pages`       | daftar halaman konten                |
| `GET /pages/:slug` | `faq`, `terms`, `privacy`, `contact` |
| `GET /banners`     | banner aktif dalam jadwal            |

## 7. Pembayaran (sengaja mati)

| Method & path             | Hasil                                                  |
| ------------------------- | ------------------------------------------------------ |
| `GET /payments/providers` | `200` daftar provider placeholder (tidak terintegrasi) |
| `GET /payments/methods`   | `200` `{enabled:false, status:"not_available"}`        |
| `POST /payments/deposit`  | `501 NOT_AVAILABLE`                                    |
| `POST /payments/withdraw` | `501 NOT_AVAILABLE`                                    |
| `GET /payments/history`   | `501 NOT_AVAILABLE`                                    |

Body tetap divalidasi zod agar kontrak stabil bila modul diimplementasikan nanti.

---

## 8. Admin (`/admin/*`, sesi staf + izin)

Semua endpoint memeriksa izin server-side; UI hanya mencerminkan.

| Area       | Endpoint                                                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dasbor     | `GET /dashboard`, `GET /permissions`                                                                                                                                                                                                                                                                          |
| Market     | `GET /markets`, `GET /markets/:symbol`, `POST /markets/preview`, `GET /markets/suggestions/:category`, `POST /markets`, `PATCH /markets/:symbol`, `POST /markets/:symbol/simulate`, `POST /markets/:symbol/reset`, `DELETE /markets/:symbol`, `POST /markets/:symbol/restore`, `GET /markets/:symbol/history` |
| Upload     | `POST /uploads/image?folder=markets                                                                                                                                                                                                                                                                           | branding                                                                                                               | admin`                                                 |
| Trade      | `GET /trades`, `GET /trades/export.csv`, `GET /trades/stats`, `GET /trades/:id`, `POST /trades/:id/settle`                                                                                                                                                                                                    |
| Pengguna   | `GET /users`, `GET /users/:id`, `POST /users/:id/block`, `POST /users/:id/logout`, `POST /users/:id/wallet`, `POST                                                                                                                                                                                            | PATCH /users/:id/role`, `GET                                                                                           | POST /users/:id/notes`, `POST /users/:id/send-reset`   |
| Keuangan   | `GET /finance`, `POST /finance/fx`                                                                                                                                                                                                                                                                            |
| Pengaturan | `GET /settings`, `PATCH /settings`                                                                                                                                                                                                                                                                            |
| Konten     | `GET                                                                                                                                                                                                                                                                                                          | POST /banners`, `PATCH                                                                                                 | DELETE /banners/:id`, `GET /pages`, `PUT /pages/:slug` |
| Sistem     | `GET /system`, `GET /jobs`, `POST /jobs/:name/run`, `GET                                                                                                                                                                                                                                                      | POST /backups`, `GET /backups/:id/download`, `DELETE /backups/:id`, `GET /logs`, `GET /audit`, `GET /audit/export.csv` |
| Pembayaran | `GET /payments` (placeholder)                                                                                                                                                                                                                                                                                 |

Contoh settlement manual:

```http
POST /api/v1/admin/trades/7b1d…/settle
x-csrf-token: …
{ "reason": "koreksi data uji", "closePrice": 0.43100 }
```

`reason` minimal 5 karakter, wajib, dicatat ke `audit_log`
(`admin.trade_settled`) dan notifikasi pengguna.

Contoh `POST /admin/markets/:symbol/simulate`:

```json
{ "trend": "up", "trendStrength": 7, "volatilityPreset": "tinggi", "mood": "normal", "paused": false }
```

Response memuat `market`, `engine` (deskripsi feed), dan `history` (20 entri
terakhir) — perubahan parameter selalu terlihat oleh pengguna.

---

## 9. WebSocket `GET /ws`

Pesan klien (JSON, ≤ 8 KB):

```json
{ "type": "subscribe", "symbol": "DOGE", "timeframe": "1m" }
{ "type": "unsubscribe", "symbol": "DOGE", "timeframe": "1m" }
{ "type": "resume", "symbol": "DOGE", "lastSeq": 4312 }
{ "type": "auth", "token": "<jwt>" }
{ "type": "ping", "id": 1 }
```

Pesan server:

| `type`                      | Payload ringkas                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `hello`                     | `serverTime`, `markets[]` + `lastSeq`, `timeframes`, `authenticated`                                                  |
| `subscribed`                | `market`, `timeframe`, `snapshot {lastPrice, candle}`                                                                 |
| `tick`                      | `{price, time, seq}`                                                                                                  |
| `candle`                    | `{tf, t, o, h, l, c, seq}` (candle berjalan)                                                                          |
| `candle_closed`             | `{tf, candle:{t,o,h,l,c}, seq}`                                                                                       |
| `market_status`             | `{status, paused, open, reason, serverTime}`                                                                          |
| `trade:opened`              | `{trade}` (hanya klien pengguna tersebut)                                                                             |
| `trade:settled`             | `{id, result, payout, closePrice, trade}`                                                                             |
| `balance` / `account:reset` | daftar dompet terbaru                                                                                                 |
| `notification`              | `{id, kind, title, body, link, createdAt}`                                                                            |
| `replay`                    | `{fromSeq, seq, ticks[], candles[]}`                                                                                  |
| `resync`                    | `{reason:"seq_too_old", seq}`                                                                                         |
| `pong`                      | `{id, serverTime}`                                                                                                    |
| `error`                     | `{code, message}` — mis. `MARKET_NOT_FOUND`, `INVALID_JSON`, `TOO_MANY_SUBSCRIPTIONS`, `UNAUTHORIZED`, `RATE_LIMITED` |

Ticks/candle digabung per klien pada `WS_TICK_MAX_PER_SEC` (default 15/detik);
`candle_closed`, `trade:*`, dan `market_status` tidak pernah di-throttle.
Koneksi dibatasi `WS_MAX_CONNECTIONS` (default 2000) dan diverifikasi origin.
