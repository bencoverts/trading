# Demo Trading Platform — Backend

Backend lengkap untuk platform trading **mode demo** (gaya Olymptrade) dengan saldo virtual.
Front-end chart yang sudah ada (`chart_pro.html` / chart-kit) sudah disambungkan ke API dan
WebSocket dari repo ini.

> ## ⚠️ Hanya uang virtual
> Repo ini **tidak** memproses pembayaran, deposit, penarikan, KYC, maupun uang sungguhan.
> Semua saldo adalah angka demo di database. Untuk menjalankan platform dengan **uang
> sungguhan** diperlukan izin/lisensi sesuai regulasi negara target (mis. OJK/Bappebti di
> Indonesia, CySEC/FCA/ASIC di yurisdiksi lain), modal minimum, audit, kebijakan KYC/AML,
> serta kepatuhan pada aturan produk (binary option dilarang di banyak yurisdiksi).
> Jangan gunakan kode ini untuk menerima dana tanpa izin tersebut.

---

## 1. Ringkasan

| Area | Isi |
| --- | --- |
| Harga | Satu price engine server-side (random walk + mood `sepi/normal/cepat/liar`, momentum, tren), bisa diganti adapter feed asli |
| Candle | Agregasi OHLC server untuk `5s, 15s, 30s, 1m, 5m`, disimpan ke DB (retensi 48 jam) |
| Realtime | WebSocket `/ws`, throttle tick per client, `candle_closed` tidak pernah hilang, heartbeat, resume via `seq` |
| Auth | Register/login JWT, password argon2id, saldo demo awal, reset saldo |
| Trading | `POST /api/trades` dengan validasi, hold saldo, `Idempotency-Key`, settlement otomatis di server |
| Pemulihan | Trade yang expired saat server mati diselesaikan saat startup |
| Keamanan | Rate limit per user/IP, zod validation, helmet/CSP, CORS allowlist, audit log, constraint saldo ≥ 0 |
| Admin | Payout rate, durasi, batas nominal, mood/volatilitas feed, statistik trade, audit |
| Database | SQLite (dev/test) + PostgreSQL (produksi), migrasi SQL, transaksi atomik |
| Dokumentasi | [`docs/API.md`](docs/API.md) (HTTP + semua pesan WebSocket), [`docs/openapi.yaml`](docs/openapi.yaml) |
| Contoh client | [`examples/client.js`](examples/client.js) (subscribe → tick → BUY → `trade:settled`) |

---

## 2. Arsitektur

```
                 ┌──────────────────────────────┐
   REST clients  │  Express app (src/http/app.ts)│
  (chart + UI) ──┤  helmet/CORS/rate-limit       │
                 │  routes: auth, market,       │
                 │          account, trades,    │
                 │          admin, healthz      │
                 └──────────────┬───────────────┘
                                │
        ┌───────────────────────┼─────────────────────────┐
        │                       │                         │
┌───────▼────────┐   ┌──────────▼─────────┐   ┌───────────▼─────────┐
│ TradeService   │   │ SettingsService    │   │ UserService         │
│ (open/settle)  │   │ (runtime business) │   │ (argon2, balance)   │
└───────┬────────┘   └──────────┬─────────┘   └───────────┬─────────┘
        │                       │                         │
        └───────────────────────┼─────────────────────────┘
                                │  transaksi atomik
                     ┌──────────▼───────────┐
                     │  Db (sqlite/postgres)│
                     └──────────▲───────────┘
                                │
   ┌────────────────────────────┴──────────────────────────────┐
   │ PriceEngine (single source of truth)                       │
   │  PriceSource adapter ──► tick (seq, server time)           │
   │      ├─ SimulatedPriceFeed (mood/momentum/trend)           │
   │      └─ (nanti) feed broker asli: next() atau start(emit)  │
   │  CandleAggregator (5 timeframe) ──► CandleRecorder ──► DB  │
   └───────────────┬───────────────────────────────────────────┘
                   │ events: tick / candle / candle_closed
          ┌────────▼─────────┐     ┌───────────────────────────┐
          │ RealtimeServer   │     │ SettlementLoop (250 ms)   │
          │ /ws + throttle   │     │ expiry → close price → DB │
          └──────────────────┘     └───────────────────────────┘
```

Poin desain penting:

- **Harga hanya dari server.** `PriceEngine` memberi timestamp dari jam server; client tidak
  pernah mengirim harga/waktu yang dipakai untuk keputusan apa pun.
- **Satu tick stream** mengisi semua timeframe sekaligus, sehingga candle 15s/1m/5m selalu
  konsisten dengan candle 5s (ada unit test khusus untuk ini).
- **Settlement memakai harga pada detik expiry**, yaitu tick terakhir dengan `time ≤ expiry_time`
  dari ring buffer — bukan harga saat timer kebetulan berjalan.
- **Klaim atomik.** Settlement memakai `UPDATE trades SET status='closed' ... WHERE id=? AND status='open'`,
  jadi dua worker/restart tidak bisa membayar dua kali.
- **Saldo selalu berubah di dalam transaksi DB**, bersama baris trade dan audit; ada
  `CHECK (balance_cents >= 0)` sebagai pertahanan terakhir.

---

## 3. Quick start

Prasyarat: **Node.js ≥ 20** (diuji pada Node 22), npm.

```bash
npm install
cp .env.example .env          # sesuaikan bila perlu
npm run migrate               # buat schema (idempotent)
npm run dev                   # http://localhost:3000  (WS: ws://localhost:3000/ws)
```

Buka `http://localhost:3000` → chart live + panel trading demo. Klik **Sign in**, daftar
email + password (min 8 karakter), saldo awal 10.000 (virtual).

Cek cepat:

```bash
curl -s localhost:3000/healthz | jq
node examples/client.js --url http://localhost:3000 --duration 5 --amount 10
```

### Scripts

| script | fungsi |
| --- | --- |
| `npm run dev` | server dengan auto-reload (`tsx watch`) |
| `npm run build` | compile TypeScript ke `dist/` |
| `npm start` | jalankan hasil build (`node dist/server.js`) |
| `npm run migrate` | jalankan migrasi SQL yang belum diterapkan |
| `npm test` | seluruh unit + integration test (vitest) |
| `npm run test:watch` | vitest watch |
| `npm run typecheck` | `tsc` untuk `src` dan `test` |

### Environment

Semua variabel dibaca dan divalidasi di `src/config.ts` (zod). Lihat `.env.example`.
Yang paling penting:

| variabel | default | catatan |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` mewajibkan `JWT_SECRET` ≥ 32 karakter |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DB_DRIVER` | `sqlite` | `sqlite` \| `postgres` |
| `SQLITE_PATH` | `./data/demo.sqlite` | |
| `DATABASE_URL` | – | wajib bila `DB_DRIVER=postgres` |
| `JWT_SECRET` / `JWT_TTL_SEC` | dev secret / 43200 | **ganti di produksi** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | – | opsional, membuat/menaikkan akun admin saat boot |
| `CORS_ORIGINS` | `localhost:3000,127.0.0.1:3000` | origin lain + same-host otomatis |
| `RATE_TRADE_MAX` / `..._WINDOW_MS` | 10 / 60000 | per user |
| `RATE_AUTH_MAX`, `RATE_GLOBAL_MAX` | 20, 600 | per IP |
| `INITIAL_BALANCE_CENTS` | 1000000 | 10.000,00 |
| `TRADE_MIN_CENTS` / `TRADE_MAX_CENTS` | 100 / 100000 | 1,00 – 1.000,00 |
| `PAYOUT_RATE` / `PAYOUT_MODE` | 0.85 / `profit` | lihat §7 |
| `ALLOWED_DURATIONS` | `5,15,30,60` | detik |
| `MAX_OPEN_TRADES` | 5 | per akun |
| `SYMBOL` / `SYMBOL_NAME` / `INITIAL_PRICE` | `ASIA50` / `ASIA COMPOSITE INDEX` / `6204.5` | satu instrumen aktif |
| `FEED_MOOD` / `FEED_MOOD_AUTO` / `FEED_VOLATILITY` | `normal` / `true` / 1 | mood awal & rotasi otomatis |
| `TICK_INTERVAL_MS` / `TICK_JITTER` / `TICK_SIZE` | 100 / true / 0.1 | ritme & amplitudo feed simulasi |
| `CANDLE_RETENTION_SEC` | 172800 | 48 jam |
| `WS_TICK_MAX_PER_SEC` | 15 | batas kirim tick per client |
| `WS_HEARTBEAT_MS` | 30000 | ping/pong |

---

## 4. Database & migrasi

- **Development/test:** SQLite (`better-sqlite3`), file default `./data/demo.sqlite`,
  test memakai `:memory:`.
- **Production:** PostgreSQL (`pg`). Set `DB_DRIVER=postgres` + `DATABASE_URL`.
- Migrasi ada di `migrations/sqlite/001_init.sql` dan `migrations/postgres/001_init.sql`
  (skema identik, tipe berbeda). Runner: `src/db/migrate.ts`, dijalankan otomatis saat boot
  dan bisa manual via `npm run migrate`. Tabel `schema_migrations` membuatnya idempotent.

Tabel: `users`, `accounts`, `trades`, `candles`, `audit_log`, `settings`, `schema_migrations`.

Constraint penting:

- `accounts.balance_cents >= 0`
- `trades.amount_cents > 0`, `payout_cents >= 0`, `status/result/direction` di-enum
- `UNIQUE (user_id, idempotency_key)` (partial index, hanya bila key diisi)
- `INDEX (status, expiry_time)` untuk settlement, `INDEX (user_id, created_at)`
- `candles PRIMARY KEY (symbol, tf, t)`, retention 48 jam (housekeeping 10 menit)

Catatan operasional: migrasi Postgres memakai `splitStatements()` sederhana (cukup untuk
migrasi tanpa function/trigger). Bila nanti menambah PL/pgSQL, ganti runner dengan `node-pg-migrate`.

---

## 5. Testing

```bash
npm test          # 114 test, 11 file
npm run typecheck # src + test
```

Hasil terakhir di environment ini (jujur, apa adanya):

```
Test Files  11 passed (11)
     Tests  114 passed (114)
  Duration  ~5.4 s
tsc (src)      : OK
tsc (src+test) : OK
```

Cakupan:

| file | isi |
| --- | --- |
| `test/unit/priceEngine.test.ts` | seq, kuantisasi harga, event tick/candle, penutupan candle per timeframe, tick terlambat, `getPriceAt`, resume buffer, pull/push adapter |
| `test/unit/candles.test.ts` | bucket alignment, OHLC per timeframe, penutupan multi-timeframe, limit/history, seed tanpa duplikat, prune |
| `test/unit/payout.test.ts` | payout mode `profit`/`total`, menang/kalah/seri, pembulatan, `decideResult`, konversi uang |
| `test/unit/settlement.test.ts` | settle menang/kalah/seri, hold saldo, settlement dua kali, harga expiry vs harga settle, restart / tidak ada tick di expiry → refund (bukan harga pasca-expiry), 5 trade sekaligus |
| `test/unit/validation.test.ts` | saldo tidak cukup, batas min/max, durasi, simbol, limit trade terbuka, idempotency (replay & key reuse), snapshot payout rate |
| `test/unit/simulatedFeed.test.ts` | determinisme RNG, harga selalu > 0, mood `liar` > `sepi`, multiplier volatilitas, rotasi mood |
| `test/unit/auth.test.ts` | argon2id hash/verify, JWT valid/secret salah/expired, validasi config |
| `test/integration/tradeFlow.test.ts` | register → open → settle via HTTP, idempotency, validasi body, isolasi antar user, reset saldo, malformed/oversized body |
| `test/integration/api.test.ts` | market config, candles semua timeframe & konsistensinya, ticks filter, auth flows, healthz, header keamanan, CORS/preflight, 404, rate limit trade & login, admin settings/stats/audit |
| `test/integration/websocket.test.ts` | hello/subscribe, tick+candle, ping/pong, error code, `candle_closed` tanpa throttle, throttling/coalescing, `trade:opened`/`balance`/`trade:settled`, resume & resync, socket anonim vs terautentikasi |
| `test/integration/restart.test.ts` | trade expired saat downtime diselesaikan saat boot, balance konsisten, migrasi idempotent, candle bertahan setelah restart |

Smoke test manual juga dilakukan: server dijalankan, lalu
`node examples/client.js --duration 5` → login/register, subscribe, tick pertama, BUY,
`trade:opened`, `balance`, candle live, `trade:settled` (hasil LOSE pada run tersebut).

**Yang belum diuji / risiko yang jujur:**

- **Adapter PostgreSQL belum dijalankan terhadap server Postgres sungguhan** (tidak tersedia di
  environment ini). SQL ditulis portabel dan placeholder `?` diterjemahkan ke `$n`, tetapi
  jalankan test integrasi terhadap Postgres sebelum produksi.
- Rate limit memakai memory store in-process → pada multi-instance perlu Redis/shared store.
- Test throttling WebSocket memakai timing nyata (bukan fake timers); sangat toleran, tetapi
  bisa flaky di mesin yang sangat lambat.
- Belum ada test browser end-to-end (Playwright) untuk UI demo.

---

## 6. Dokumentasi API & WebSocket

- [`docs/API.md`](docs/API.md) — semua endpoint HTTP, kode error, limit, **semua pesan
  WebSocket** beserta contoh JSON, aturan throttle/heartbeat/resume, model data.
- [`docs/openapi.yaml`](docs/openapi.yaml) — OpenAPI 3.1 untuk endpoint HTTP.
- [`examples/client.js`](examples/client.js) — contoh client Node: subscribe, terima tick,
  buka trade BUY, terima `trade:settled`.

Ringkas pesan WebSocket (detail di API.md):

| arah | type |
| --- | --- |
| client → server | `subscribe`, `unsubscribe`, `ping`, `auth`, `resume` |
| server → client | `hello`, `subscribed`, `tick`, `candle`, `candle_closed`, `trade:opened`, `trade:settled`, `balance`, `pong`, `replay`, `resync`, `error` |

### Kenapa riwayat chart memakai `/api/candles` (bukan `/api/ticks`)?

Keduanya tersedia, tetapi chart memakai **`/api/candles`** sebagai sumber riwayat resmi karena:

1. Agregasi dilakukan server → semua client melihat OHLC identik; client tidak bisa
   "menciptakan" candle sendiri.
2. Chart 5m butuh berjam-jam data. Sebagai tick (10/detik) itu ratusan ribu objek JSON;
   sebagai candle hanya beberapa kB.
3. Ganti timeframe cukup satu request kecil, bukan menghitung ulang buffer tick besar.

`/api/ticks` tetap ada untuk replay tick-level/jendela pendek (dan dipakai contoh client untuk
harga awal), dengan catatan buffer tick in-memory (~33 menit) dan tidak dipersistensi.

---

## 7. Perubahan pada front-end (dan alasannya)

Visual chart **tidak diubah**. File HTML asli dipecah menjadi modul agar memenuhi CSP ketat
(tanpa inline script/style) dan disambungkan ke backend:

| file baru | asal / fungsi |
| --- | --- |
| `public/index.html` | struktur dari `chart_pro.html` + panel trading + modal login |
| `public/styles.css` | CSS asli dipindah ke file eksternal (CSP `style-src 'self'`), ditambah style panel |
| `public/chart.js` | renderer canvas asli (toolbar, zoom, drag, crosshair, label, countdown) dipindah apa adanya menjadi modul `createChart()` |
| `public/app.js` | lapisan koneksi: REST + WebSocket, auth, trading |

Perubahan perilaku yang **memang diperlukan**:

1. **`createRandomFeed` / `simStep` / seed loop lokal dihapus.** Tidak ada lagi harga acak di
   browser. Harga 100% dari server.
2. **`chart.setData(ticks)` → `chart.setData(candles)`.** Riwayat diambil dari
   `GET /api/candles?tf=...` (alasan di §6). Saat ganti timeframe, client melakukan satu request
   lalu `setData()` — bukan `rebuild()` dari tick lokal.
3. **`chart.push(price, time)` dipertahankan** persis seperti kontrak lama dan dipanggil dari
   pesan `tick`, sehingga garis harga/titik pulse/countdown tetap animatif. Selain itu
   `chart.applyCandle()` dan `chart.closeCandle()` menimpa OHLC dengan nilai otoritatif server
   (pesan `candle` / `candle_closed`).
4. **Countdown candle memakai jam server** (`serverTime` dari REST/`hello` → offset), bukan
   `Date.now()` mentah, agar countdown tidak melenceng bila jam client salah.
5. **Ditambah:** panel saldo, input nominal, pilih durasi, tombol BUY/SELL, daftar open trade
   dengan countdown, riwayat hasil, toast hasil, modal register/login, tombol reset saldo,
   indikator koneksi, reconnect exponential backoff + `resume` via `seq`, dan ping aplikasi.
6. Token disimpan di `localStorage` dan dikirim sebagai `Authorization: Bearer`; WebSocket
   memakai `?token=` (browser tidak bisa set header di WS) atau pesan `auth`.

Semua transaksi tetap `POST /api/trades` dengan `Idempotency-Key: crypto.randomUUID()`;
client tidak pernah menghitung hasil atau harga close.

---

## 8. Keputusan bisnis (default yang dipilih — **harus dikonfirmasi pemilik produk**)

| # | Keputusan | Default di repo | Alasan / catatan |
| --- | --- | --- | --- |
| 1 | Saldo awal | 10.000,00 (`INITIAL_BALANCE_CENTS=1000000`) | cukup untuk mencoba, mudah diubah |
| 2 | Payout rate | 0,85 mode `profit` (menang = modal + 85% modal) | setara house edge 15% pada trade adil; mudah diubah admin |
| 3 | Mode payout | `profit` (bukan `total`) | tidak ambigu untuk front-end; `total` didukung |
| 4 | Durasi | 5, 15, 30, 60 detik | sesuai brief; admin bisa ubah |
| 5 | Batas nominal | min 1,00 / max 1.000,00 per trade | melindungi saldo demo & eksperimen |
| 6 | Maks trade terbuka | 5 per akun | mencegah spam dan eksposur tak terbatas |
| 7 | Hasil seri | refund penuh (draw) | paling adil dan sederhana |
| 8 | Harga close | tick terakhir dengan `time ≤ expiry_time` | deterministik; tidak tergantung kapan loop berjalan |
| 9 | Trade expired saat server mati | diselesaikan saat startup; bila harga expiry tak diketahui → `draw` + refund | tidak mungkin tahu harga saat downtime; refund adalah pilihan aman |
| 10 | Reset saldo | saldo kembali ke awal; open trade di-void sebagai `draw` (refund tercatat), lalu saldo di-reset | keadaan selalu bersih & prediktif |
| 11 | Perubahan payout rate oleh admin | hanya untuk trade **baru** (rate di-snapshot saat open) | trade yang sudah berjalan tidak boleh berubah hasilnya |
| 12 | Simbol | satu instrumen aktif (`ASIA50`) | arsitektur siap multi-simbol, tetapi belum diekspos |
| 13 | Settlement otomatis | loop 250 ms di proses yang sama | cukup untuk satu instance; multi-instance aman karena klaim atomik |

---

## 9. Asumsi yang diambil

1. **Satu simbol aktif** pada satu waktu; `symbol` lain ditolak `SYMBOL_INACTIVE`.
2. **Satu server instance** untuk price engine & fan-out. Multi-instance butuh pub/sub
   (Redis) agar semua node melihat tick yang sama; belum diimplementasikan.
3. Feed awal adalah **simulasi** (random walk). Untuk feed asli, implementasikan `PriceSource`
   (`next()` pull atau `start({emit})` push) lalu daftarkan di `src/bootstrap.ts` —
   tidak ada perubahan pada engine, WS, atau trading.
4. Harga disimpan sebagai `DOUBLE PRECISION`/`REAL` dan dibulatkan ke `PRICE_DECIMALS`
   (default 2) sebelum keluar dari engine. Uang **selalu** integer sen.
5. Riwayat candle di-synthesise 4 jam saat database masih kosong agar chart tidak kosong;
   setelah itu data nyata dari feed yang dipakai.
6. Candle yang masih berjalan ikut di-flush tiap 2 detik dan saat shutdown, sehingga setelah
   restart candle parsial terakhir bisa terlihat "tertutup" pada nilai flush terakhir.
7. `seq` adalah urutan per proses (reset saat restart). Karena itu resume hanya berlaku untuk
   gap dalam masa hidup proses; selain itu client menerima `resync` dan mengambil ulang candle.
8. Tick tidak dipersistensi (hanya ring buffer di memori); candle yang dipersistensi.
9. Client mengirim `amount` dalam satuan mayor (10.5 = 10,50), maksimum 2 desimal;
   response menyertakan `amountCents`.
10. Email dianggap unik case-insensitive (disimpan `email_normalized`), tanpa verifikasi email.
11. Tidak ada 2FA, refresh token, atau pencabutan token; JWT berlaku sampai `exp`.
12. Admin dibuat lewat env (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) atau promosi manual di DB.
13. Waktu server diasumsikan benar (NTP); semua expiry dan candle mengikuti jam server.
14. Zona waktu tidak memengaruhi apa pun — semua timestamp epoch ms (UTC).

---

## 10. Keamanan & keandalan

- **Input validation** dengan zod di setiap endpoint (body, query, path, header), plus batas
  ukuran body 32 kB.
- **Password** argon2id (`ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`), hash unik per user.
  Login user tak dikenal tetap melakukan hash dummy untuk mengurangi user enumeration.
- **JWT** HS256, `issuer` dicek, algoritma dibatasi, secret wajib ≥ 32 karakter di produksi.
- **Rate limit**: trade per user (default 10/menit), auth per IP, global per IP.
- **CORS** allowlist eksplisit + same-host; **helmet** dengan CSP ketat, `nosniff`,
  referrer policy, HSTS di produksi. `X-Frame-Options` sengaja tidak dipasang agar UI bisa
  di-embed di preview/dashboard.
- **Tidak mempercayai client**: harga entry, waktu, expiry, dan close price semuanya dari server;
  client tidak bisa mengirim harga/waktu/hasil.
- **Idempotency** trade: unique index + fingerprint payload → tidak ada double trade.
- **Saldo** hanya berubah lewat transaksi DB; ada CHECK ≥ 0; hold & credit bersifat atomik.
- **Settlement** memakai klaim kondisional (`WHERE status='open'`) → idempotent terhadap
  restart/duplikasi.
- **Audit log** untuk register, buka trade, settle, reset saldo, ubah settings, void trade.
- **Logging terstruktur** (pino) dengan redaksi `authorization`, `cookie`, `password`, `token`;
  `/healthz` untuk probe.
- **Graceful shutdown** (SIGINT/SIGTERM): hentikan timer, flush candle, tutup WS & DB.

Catatan produksi yang belum ditangani: TLS termination, secret manager, rotasi JWT,
backup DB, observability (metrics/tracing), WAF, dan pembatasan registrasi (captcha/email).

---

## 11. Struktur proyek

```
src/
  config.ts                 env + validasi + daftar timeframe
  bootstrap.ts              rakit runtime (db, engine, services, app, ws, lifecycle)
  server.ts                 entrypoint + graceful shutdown
  app/context.ts            dependency container
  auth/                     argon2, JWT, middleware
  db/                       interface Db, adapter sqlite & postgres, migrasi
  domain/                   candle, payout, uang
  price/                    engine, adapter simulasi, backfill, tipe PriceSource
  services/                 users, trades, settings, candleRecorder, settlementLoop, audit
  routes/                   auth, account, market, trades, admin
  http/                     express app, validasi
  ws/                       protokol + server realtime
  lib/                      clock, emitter, errors, logger
migrations/{sqlite,postgres}/001_init.sql
public/                     UI demo (chart + panel trading)
examples/client.js          contoh client Node
test/{unit,integration}/    114 test
docs/API.md, docs/openapi.yaml
```

---

## 12. Keterbatasan / roadmap

- [ ] Adapter Postgres diuji terhadap Postgres nyata (sekarang hanya SQLite yang dieksekusi).
- [ ] Multi-instance: pub/sub tick + shared rate-limit store.
- [ ] Multi-simbol dan feed harga asli (antarmuka `PriceSource` sudah siap).
- [ ] Admin UI (saat ini hanya API) dan manajemen user/role.
- [ ] Verifikasi email, 2FA, refresh token, pencabutan sesi.
- [ ] Mode "real money" (butuh lisensi, KYC/AML, payment gateway, audit keuangan) —
      di luar cakupan repo ini.
- [ ] Persistensi tick (mis. Redis/CH) bila butuh audit harga level-tick.

## 13. Lisensi

MIT untuk kode. Penggunaan komersial sebagai platform trading, terutama dengan uang
sungguhan, **tidak** tercakup izin ini dan sepenuhnya tanggung jawab operator.
