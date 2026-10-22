# Arsitektur

Platform demo satu proses: satu server Node.js melayani HTTP API, WebSocket
realtime, dan UI statis dari `public/`. Tidak ada layanan eksternal.

```
Browser (vanilla JS, canvas chart)
   │  HTTPS / WSS (same origin)
   ▼
Express app ── Helmet, CORS, rate limit, cookie sesi + CSRF, zod
   │
   ├── /api/v1/{auth,account,market,trades,admin,content,payments}
   ├── /ws      → RealtimeServer (ws)
   └── static   → public/ (SPA fallback ke index.html)
   │
   ▼
AppContext (src/app/context.ts) — satu container dependency
   │
   ├── services/   trades · settlement · wallets · ledger · markets ·
   │               marketData · users · settings · notifications ·
   │               content · uploads · stats · audit · mailer
   ├── price/      PriceEngine + SimulatedPriceFeed (satu per market)
   ├── jobs/       scheduler: settlement, engine health, cleanup, backup
   └── db/         SQLite (WAL, FK, migrasi bernomor, seed)
```

## 1. Kenapa satu proses

SQLite hanya punya satu penulis; settlement, tick, dan ledger harus konsisten
satu sama lain. Menjalankan satu proses membuat `BEGIN IMMEDIATE` cukup untuk
menjaga saldo, tanpa distributed lock. Konsekuensinya didokumentasikan di
`docs/DECISIONS.md` (skala: satu instance, ~2 000 koneksi WS).

## 2. Dependency container

`createRuntime()` di `src/bootstrap.ts` merakit semuanya dan menerima opsi
injectable (`config`, `db`, `clock`, `logger`, `mailer`, flag
`startEngine`/`runSettlementLoop`/`startJobs`/`attachRealtime`). Tes memakai
`dbPath` sementara, jam palsu, dan tick manual — tidak ada timer atau I/O
tersembunyi, jadi tes deterministik dan cepat (~5 s untuk 165 tes).

Urutan boot:

1. `runMigrations()` — `migrations/sqlite/*.sql` berurutan, dicatat di tabel
   `schema_migrations` (idempoten).
2. `SettingsService.load()` — default + override dari tabel `settings`.
3. Market aktif dimuat ke `PriceEngine`; harga terakhir dibaca dari tick
   tersimpan sehingga restart melanjutkan harga (bukan mulai dari harga awal).
4. `MarketDataService` men-_backfill_ candle dari tick yang ada.
5. `SettlementLoop` menyelesaikan trade yang kedaluwarsa **sebelum** server
   menerima request.
6. `RealtimeServer` + scheduler job dimulai, lalu `server.listen()`.

`SIGTERM`/`SIGINT`: berhenti menerima koneksi, hentikan timer engine, flush tick
dan candle, tutup socket WS, tutup DB.

## 3. Aliran harga: tick → candle → chart

```
        SimulatedPriceFeed (per market)
        random walk + mood + trend + volatility
                     │  tick {price, time, seq}
                     ▼
                PriceEngine
        ┌────────────┴───────────────┐
        │ buffer (≤5 000 tick)       │ CandleAggregator (5s…1h)
        │ untuk replay/resume        │ bucket = floor(t / tf) * tf
        ▼                            ▼
   ticks (SQLite, 7 hari)     candle berjalan → WS `candle`
                              bucket tutup    → candle_closed
                                              → INSERT candles (90 hari)
                     │
                     ▼
              RealtimeServer
   fan-out per langganan (market, timeframe), throttle 15/detik/klien
                     │
                     ▼
        public/js/chart.js (canvas, 60 FPS, zoom/pan/crosshair)
```

Aturan yang dijaga kode:

- **Satu sumber harga.** Chart, pratinjau trade, entry price, dan close price
  semuanya membaca `PriceEngine`, bukan angka klien.
- **Waktu monoton.** `time = clock.now()`, dan tick dengan waktu lebih kecil
  dari tick terakhir dibuang. Bucket candle tidak pernah dimutasi setelah
  ditutup (`closedAt` dipersistensikan).
- **Parameter berlaku tick berikutnya.** Admin mengubah tren/mood/volatilitas →
  `engine.applyConfig()` mengganti konfigurasi runtime tanpa me-restart feed;
  tick yang sudah ada tidak diubah.
- **Pause** menghentikan tick baru tetapi tidak menghapus riwayat; status
  dikirim lewat `market_status`.

## 4. Aliran trade: open → hold → settlement

```
POST /api/v1/trades   (Idempotency-Key wajib, sesi + CSRF)
   │
   ├─ zod: market, direction, currency, amount, durationSec
   ├─ cache idempotensi: key sama + payload sama → trade yang sama (200)
   │                     key sama + payload beda → 409
   ▼
BEGIN IMMEDIATE                     ← satu transaksi: cek + hold
   ├─ validasi market (aktif, tidak pause, jam trading, min/max, payout)
   ├─ validasi limit (open trades, eksposur, rate limit)
   ├─ UPDATE wallets SET balance_minor = balance_minor - ?
   │        WHERE user_id = ? AND currency = ? AND balance_minor >= ?
   │        (0 baris → INSUFFICIENT_FUNDS, rollback)
   ├─ INSERT trades (entry_price = harga engine saat ini,
   │                 entry_time = jam server,
   │                 expiry_time = entry_time + duration*1000)
   ├─ INSERT ledger (double entry: debit user, kredit house)
   └─ COMMIT
   │
   ▼
WS `trade:opened` + `balance` ke klien pengguna
```

Settlement (job tiap 250 ms, juga saat boot):

```
SELECT trades WHERE status='open' AND expiry_time <= now
   │
   ▼  per trade
   ├─ closePrice = tick terakhir pada/atau sebelum expiry (priceAt)
   ├─ tanpa tick → refund (data tidak cukup, jangan mengarang hasil)
   ├─ win  : UP & close > entry  | DOWN & close < entry → payout = stake*(1+rate)
   ├─ lose : sebaliknya                                → payout = 0
   ├─ draw : close == entry                            → payout = stake (refund)
   │
   ▼
BEGIN IMMEDIATE
   ├─ UPDATE trades SET status='closed', result=?, close_price=?, settled_by='expiry'
   │        WHERE id=? AND status='open'      ← claim, jadi tidak dobel bayar
   ├─ UPDATE wallets SET balance_minor = balance_minor + payout
   └─ INSERT ledger
   COMMIT
   │
   ▼
WS `trade:settled` + `balance`, notifikasi + toast
```

Settlement manual admin memakai jalur yang sama (`settled_by='admin'`), wajib
alasan ≥ 5 karakter, menulis `audit_log` + `market_param_history` (bila
relevan), dan tetap terlihat di riwayat pengguna. Admin **tidak** bisa memilih
hasil sebelum expiry tanpa alasan tercatat — tetapi secara desain manual
settlement adalah override operasional; lihat `docs/DECISIONS.md` §8.

## 5. Data

`migrations/sqlite/001_init.sql` (v2) + `002_v3.sql` (v3). Inti:

| Tabel                                                        | Isi                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `users`, `sessions`, `email_tokens`, `login_attempts`        | akun, sesi, token sekali pakai, rate limit login                                          |
| `wallets`, `ledger_entries`, `conversions`                   | saldo per mata uang + ledger double-entry                                                 |
| `markets`, `market_param_history`, `market_favorites`        | definisi market + riwayat parameter (publik)                                              |
| `ticks`, `candles`                                           | feed mentah + candle tertutup per timeframe                                               |
| `trades`                                                     | satu baris per trade, termasuk `entry_price`, `close_price`, `payout_minor`, `settled_by` |
| `idempotency_keys`                                           | replay aman untuk `POST /trades`                                                          |
| `settings`, `audit_log`, `notifications`, `banners`, `pages` | konfigurasi runtime, jejak admin, konten                                                  |
| `job_runs`, `backups`, `app_logs`                            | observabilitas                                                                            |

Konvensi:

- Uang selalu integer minor unit (`balance_minor`, `amount_minor`,
  `payout_minor`); desimal hanya di lapisan API/UI (`toMajor`/`formatMoney`).
- Waktu selalu epoch milidetik dari jam server.
- Semua kolom status memakai `CHECK` (mis. `balance_minor >= 0`,
  `status IN ('open','closed')`).
- FK `ON DELETE RESTRICT` untuk data keuangan; penghapusan market bersifat
  _soft delete_ dan ditolak bila ada trade terbuka.

## 6. Frontend

`public/index.html` adalah shell; `public/js/app.js` memuat router, store, WS,
i18n, lalu halaman secara dinamis (`import()`), sehingga bundel admin terpisah.

```
app.js ── router.js ── pages/{home,trading,history,account,notifications,admin,…}
   │         │
   │         └─ ui.js      komponen DOM (el, toast, modal, empty state)
   ├─ store.js   state kecil + subscriber (saldo, market, trade aktif)
   ├─ api.js     fetch wrapper: cookie, CSRF, Idempotency-Key, error normal
   ├─ ws.js      reconnect + backoff, subscribe per market/timeframe, resume
   ├─ chart.js   canvas: candle/line, TF, zoom/pan, crosshair, marker entry
   └─ i18n.js    kamus id/en, `data-i18n` untuk teks statis
```

Prinsip: UI hanya menampilkan. Semua aturan (saldo, min/max, durasi, status
market, limit) divalidasi ulang di server; UI boleh memberi pratinjau lebih
cepat. Tidak ada `innerHTML` untuk data pengguna — selalu `textContent`.

## 7. Realtime

`RealtimeServer` memegang `Map<socket, ClientState>`; langganan disimpan per
`market|timeframe` sehingga fan-out tidak menyentuh semua klien. Fitur:
`hello` (snapshot pasar + seq), `subscribe`/`unsubscribe`, `resume` +`replay`
(tick yang terlewat), `resync` bila seq terlalu tua, heartbeat ping/pong,
batas koneksi dan langganan, verifikasi origin, dan throttle tick per klien.
Push per pengguna (`trade:opened`, `trade:settled`, `balance`, `notification`)
memakai indeks `userId → sockets`.

## 8. Operasi

- **Job**: `settlement` (250 ms), `engine` (health harga, 15 s), `cleanup`
  (retensi tick/candle/sesi/token, 6 jam), `backup` (salinan SQLite, 6 jam).
  Setiap run dicatat di `job_runs` dan bisa dipicu manual dari admin.
- **Health**: `/healthz` melaporkan DB, jumlah koneksi, status job, versi.
- **Log**: pino JSON dengan redaksi (`authorization`, `cookie`, `password`,
  `token`, `secret`); ringkasan terakhir juga tersedia di admin.
- **Backup**: file `*.sqlite` di `BACKUP_DIR`, bisa diunduh admin.

## 9. Pengujian

`test/unit` menguji logika murni (payout, candle, engine, validasi, keamanan);
`test/integration` menjalankan runtime asli di port acak dengan SQLite sementara
untuk auth, trade, konkurensi saldo, settlement, market API, admin, akses per
peran, WS, dan UI jsdom. `e2e/` berisi Playwright (belum dijalankan di sandbox),
`test/load/ws-load.mjs` untuk beban WS.
