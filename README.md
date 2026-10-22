# SimTrade Demo — platform trading biner **simulasi** (v4)

Satu server Node.js melayani API, feed WebSocket, dan UI browser. Harga dibuat
oleh server simulasi sendiri, saldo sepenuhnya virtual, dan setiap halaman
trading menampilkan label **SIMULASI / DEMO**.

> **Tidak ada uang sungguhan — tetapi v4 menambah alur dana demo.**
> Sejak v4 (lihat `docs/DECISIONS.md` §20) platform punya **deposit KlikQRIS
> (demo)**, **deposit transfer manual** yang diverifikasi admin, **penarikan
> demo** dengan saldo tertahan, **live chat**, dan **admin mata uang**. Semua
> saldo tetap virtual dan `PaymentService.describe().liveMoney` selalu `false`.
>
> **Blocker yang harus dibaca sebelum mencoba QRIS:** algoritma signature
> callback KlikQRIS tidak didefinisikan di dokumentasi yang tersedia. Build ini
> hanya menerima HMAC-SHA256 `order_id|status|amount|merchant_id` dan
> **menolak semua callback bila `KLIKQRIS_WEBHOOK_SECRET` kosong (fail closed)**.
> Tanpa konfirmasi skema dari provider, deposit QRIS hanya bisa diselesaikan
> lewat cek status, rekonsiliasi admin, atau deposit manual — lihat §23 di
> `docs/DECISIONS.md`.
>
> Menjalankan derivatif beruang nyata memerlukan izin (di Indonesia:
> Bappebti/OJK) — jangan arahkan kode ini ke dana nyata.

- **Stack**: TypeScript, Express, SQLite (WAL, FK, migrasi, seed), `ws`, zod,
  pino (redaksi), canvas chart tanpa dependency.
- **Bahasa**: Indonesia default, English tersedia (i18n dua kamus).
- **Tes**: 219 tes otomatis (unit + integrasi) lulus; spesifikasi Playwright
  belum dijalankan di sandbox ini (lihat `docs/TEST-REPORT.md`).

---

## 1. Menjalankan

```bash
npm ci --ignore-scripts      # better-sqlite3 opsional; runtime memakai node:sqlite
cp .env.example .env         # ubah JWT_SECRET & ADMIN_PASSWORD
npm run migrate              # migrasi + seed (market, admin, demo user)
npm run dev                  # http://localhost:3000
```

Akun seed (dev):

| Peran       | Login                     | Kata sandi          |
| ----------- | ------------------------- | ------------------- |
| super_admin | `admin@simtrade.local`    | `admin-demo-123`    |
| user demo   | `demo@simtrade.local`     | `demo-password-123` |
| support     | `support@simtrade.local`  | `support-demo-123`  |
| operator    | `operator@simtrade.local` | `operator-demo-123` |
| finance     | `finance@simtrade.local`  | `finance-demo-123`  |

Peran `finance` (baru di v4) memegang review deposit, proses penarikan, mata
uang, dan rekonsiliasi; `operator` tetap fokus market/trade. Matriks lengkap
ada di `docs/ADMIN_GUIDE.md` dan halaman **Admin → Peran & izin**.

Halaman utama: `/` (landing; pengguna login otomatis diarahkan ke `/platform`),
`/platform`, `/dashboard`, `/trading`, `/deposit`, `/withdraw`, `/transactions`,
`/history`, `/order-history`, `/account`, `/profile-security`, `/live-chat`,
`/payment-status`, `/notifications`, `/adminpages` (alias `/admin`).

Market awal: `ASIA_COMPOSITE` (indeks fiktif), `CRYPTO_COMPOSITE` (keranjang
kripto fiktif), `DOGE` = **Dogecoin (simulasi)**.

### Skrip

| Perintah                           | Kegunaan                                    |
| ---------------------------------- | ------------------------------------------- |
| `npm run dev`                      | server dengan watch (tsx)                   |
| `npm run build`                    | kompilasi TypeScript ke `dist/`             |
| `npm start`                        | jalankan build (`node dist/server.js`)      |
| `npm run migrate` / `npm run seed` | migrasi / seed data demo                    |
| `npm run test`                     | seluruh tes unit + integrasi (vitest)       |
| `npm run test:e2e`                 | Playwright (butuh `npx playwright install`) |
| `npm run test:ws-load`             | uji beban WebSocket (500 klien default)     |
| `npm run lint` / `npm run format`  | ESLint / Prettier                           |
| `npm run typecheck`                | `tsc` untuk `src` dan tes                   |

Docker/PM2: `docker compose up --build`, atau `npm run build && pm2 start ecosystem.config.cjs`.

---

## 2. Peta fitur

**Market & harga**

- 3 market awal + pembuatan market oleh admin (symbol, nama, deskripsi,
  kategori, logo PNG/JPG/WEBP/SVG ≤ 512 KB dengan validasi magic bytes, harga
  awal, desimal + tick, preset volatilitas, mood, jam trading Asia/Jakarta,
  min/max stake, status, urutan, unggulan, payout override).
- Tick server-side dengan mood/momentum/tren; satu sumber harga untuk chart,
  trade, dan settlement. Tick disimpan 7 hari, candle 90 hari (bisa diatur).
- Candle server untuk `5s · 15s · 30s · 1m · 5m · 15m · 1h`; candle tertutup
  dipersistensikan, candle berjalan dikirim via WebSocket.
- Restart melanjutkan dari harga terakhir dan melakukan _backfill_ candle.

**Trading**

- Panel yang glanceable: saldo selalu terlihat, tombol BUY/SELL besar, nominal
  dengan `+ − ½ ×2 maks`, preset durasi 5 s … 8 jam + input manual 5–28 800 s,
  pratinjau payout/profit, dialog konfirmasi (dengan opsi “jangan tanya lagi
  untuk trade kecil”), marker entry/expiry di chart, kartu trade aktif dengan
  countdown dan estimasi, riwayat + filter + ekspor CSV, toast menang/kalah/seri
  dan suara opsional (default mati).
- Server memvalidasi saldo, min/max, durasi, status market, jam trading, jumlah
  trade terbuka, eksposur, dan rate limit. `Idempotency-Key` **wajib** pada
  `POST /trades`; permintaan identik mengembalikan trade yang sama.
- Eksekusi: cek saldo + hold dalam satu `BEGIN IMMEDIATE`; entry price dari
  server; expiry = waktu server + durasi.
- Settlement: UP menang bila close > entry, DOWN menang bila close < entry, seri
  = refund. Close price disimpan, saldo + close dalam satu transaksi, job
  settlement berjalan tiap 250 ms, trade kedaluwarsa diselesaikan sebelum
  melayani request setelah restart, dan setiap mutasi masuk ledger double-entry.

**Akun**

- Registrasi (email, username, password, T&C), verifikasi email (tautan dicetak
  di server pada mode demo), login email/username, sesi httpOnly + CSRF, argon2,
  reset sekali pakai dengan masa berlaku, daftar sesi + “keluarkan perangkat
  lain”, TOTP 2FA + recovery code, rate limit + lockout, blokir mematikan sesi.

**Dompet demo**

- IDR, USD, USDT; **IDR aktif secara default**, USD/USDT nonaktif untuk dana
  sampai admin mengaktifkan beserta aturannya (menonaktifkan tidak menghapus
  saldo). Saldo awal diatur admin; kurs demo + **sumber kurs** wajib tercatat;
  setiap konversi masuk ledger; mata uang terkunci saat ada trade terbuka;
  “Top-up Demo” dan “Reset Saldo Demo” dengan batas + cooldown.

**Dana demo (v4)**

- **Deposit QRIS (KlikQRIS)**: invoice server-side, `total_amount` + kode unik
  ditampilkan, status hanya berubah setelah verifikasi server/callback; cek
  status (cooldown 3 s) dan rekonsiliasi tersedia.
- **Deposit manual**: referensi transfer unik, masuk antrian `review`, admin
  menyetujui/menolak dengan alasan; kredit idempoten + satu baris ledger.
- **Penarikan**: `quote` biaya → dana **ditahan** (`locked_minor`), admin
  memproses `approve → process → complete` (wajib referensi transfer) atau
  `reject`; batal/reject melepas hold tepat sekali; nomor tujuan disamarkan.
- **Live chat** dengan staf (pesan idempoten, catatan internal, status &
  prioritas), plus notifikasi dan event WebSocket.
- **Feature flag** & **mode maintenance** yang bisa diubah admin tanpa deploy.

**Admin**

- Dasbor kartu + grafik per jam/hari, market live, aktivitas, alert.
- Market: CRUD, logo, kontrol simulasi (tren 1–10, volatilitas, mood,
  pause/resume/reset), jadwal, limit/payout, riwayat parameter, pratinjau chart.
- Trade: filter, detail, settlement manual (alasan wajib + audited), CSV,
  statistik per market/durasi.
- Pengguna: pencarian, detail (profil, dompet, trade, riwayat login, sesi,
  audit), set saldo dengan alasan, blokir/buka/force logout, ubah role
  (super_admin), kirim reset, catatan.
- Keuangan demo: total, FX + riwayat, cap/cooldown, laporan.
- Pengaturan: payout, durasi, limit, eksposur, rate limit, retensi, branding,
  disclaimer/terms, bahasa/timezone.
- Konten: banner terjadwal, editor halaman + pratinjau.
- Sistem: health, job, backup SQLite (list/unduh), log berfilter, audit + ekspor.
- Antrian deposit & penarikan, mata uang (aktif/limit/biaya/kurs), situs &
  feature flag, inbox live chat, status provider + tes koneksi + rekonsiliasi.
- Matriks peran: `super_admin`, `operator`, `finance`, `support`, `viewer` —
  dicek di server pada setiap endpoint (menu tersembunyi bukan keamanan).

**Keamanan**

- Helmet + CSP ketat, CORS same-origin (host preview otomatis diizinkan), HSTS
  di produksi, zod pada seluruh input termasuk query/path, rate limit per IP dan
  per user, cookie session + CSRF double-submit, upload divalidasi magic bytes
  dengan nama acak di luar kode, output selalu di-escape (`textContent`, tidak
  ada `innerHTML` untuk data pengguna), rahasia hanya dari environment dengan
  redaksi pino.

**Kualitas**

- Tema terang + gelap, design system, animasi halus, responsif (panel trade
  menjadi bottom sheet di mobile), skeleton/empty/error state, aksesibilitas
  (keyboard, ARIA, fokus, kontras), shortcut `B/S/L/T/?`, favicon/meta/judul,
  chart canvas 60 FPS, dan pemisahan admin bundle (dynamic import).

---

## 3. Struktur

```
src/
  app/context.ts        dependency container
  auth/                 password, token, sesi, permission matrix, TOTP
  bootstrap.ts          rakit runtime (dipakai server & tes)
  config.ts             env tervalidasi (zod)
  db/                   sqlite driver, migrasi, seed
  domain/               konstanta, uang, payout, jadwal market, candle
  http/                 express app, session/CSRF, validasi
  jobs/                 scheduler, backup, cleanup
  price/                price engine + simulated feed
  payments/             klikqris.ts (server-side client) + service.ts (facade)
  routes/               auth, account, market, trades, admin, adminV4, content,
                        finance, chat, webhooks, payments (stub v3)
  services/             users, wallets, ledger, markets, trades, settlement,
                        currencies, deposits, withdrawals, chat, site, …
  ws/                   protokol + server realtime (sendToUser/sendToStaff)
public/                 index.html, css/app.css, js/{app,router,store,api,ui,ws,chart,i18n}.js,
                        js/pages/{home,trading,platform,finance,chat,history,account,notifications,auth,content,admin}.js
migrations/sqlite/      001_init.sql, 002_v3.sql, 003_v4.sql
test/                   unit/, integration/, load/
e2e/                    Playwright (smoke + v4)
docs/                   API, ARCHITECTURE, ADMIN_GUIDE, DECISIONS, CHANGELOG, TEST-REPORT, openapi.yaml
update.md               log rilis per versi (wajib, lihat root repo)
```

Arsitektur (termasuk diagram tick → candle → chart dan trade → settlement) ada
di `docs/ARCHITECTURE.md`. Kontrak API + WebSocket: `docs/API.md` dan
`docs/openapi.yaml`. Keputusan produk/teknis: `docs/DECISIONS.md`.

---

## 4. Batasan yang disengaja

| Area                                           | Status                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| Deposit/penarikan/QRIS                         | **demo**, v4; KlikQRIS dipanggil server-side, saldo virtual                 |
| Callback KlikQRIS                              | **fail closed** sampai algoritma signature dikonfirmasi provider            |
| Transfer dana nyata, kartu, akun live, KYC/AML | **tidak diimplementasikan**; `/payments/*` v3 tetap stub `NOT_AVAILABLE`    |
| Panggilan pihak ketiga dari browser            | **tidak ada**; hanya server → KlikQRIS saat deposit/cek/rekonsiliasi        |
| Uang sungguhan                                 | **tidak ada**, semua saldo virtual                                          |
| Admin mengubah hasil trade                     | **tidak bisa**; hanya parameter simulasi, semuanya audited + riwayat publik |
| Multi-instance                                 | tidak didukung (SQLite + settlement in-process); jalankan 1 instance        |

Konfigurasi v4 (opsional, semua lewat env — lihat `.env.example`):

```bash
PAYMENTS_ENABLED=false        # true hanya jika kredensial & skema signature sudah benar
KLIKQRIS_API_KEY=             # server-side saja
KLIKQRIS_MERCHANT_ID=
KLIKQRIS_WEBHOOK_SECRET=      # kosong => semua callback ditolak (fail closed)
KLIKQRIS_SIGNATURE_HEADER=x-callback-signature
KLIKQRIS_CALLBACK_URL=https://<host-publik>/api/webhooks/klikqris
```

Tanpa kredensial, halaman deposit tetap dapat dipakai untuk **transfer manual**
(diverifikasi admin) dan UI menandai QRIS sebagai “belum dikonfigurasi”.
Keputusan & fase berikutnya ada di `docs/DECISIONS.md`.

---

## 5. Hasil pengujian (ringkas)

- `npm run typecheck` — bersih.
- `npm run lint` — bersih.
- `npm test` — **219 tes lulus** (20 file), termasuk deposit/callback
  signature fail-closed, penarikan hold/release, chat idempotensi, flag, dan
  maintenance.
- `npm run build` — sukses.
- `npm audit --omit=dev` — **0 kerentanan**; `npm audit` penuh mencatat 2
  critical + 1 moderate yang hanya ada di rantai dev (vitest/tinypool) dan
  perbaikannya butuh vitest 5 (breaking) — dilaporkan, tidak dipaksakan.
- WebSocket load: **500 klien, 0 error**, ±9 600 pesan/detik, delay tick
  p50 42 ms / p95 66 ms (lihat `docs/TEST-REPORT.md`).
- Playwright E2E: spesifikasi selesai tetapi **belum dijalankan** karena unduhan
  browser diblokir di sandbox; hal ini dilaporkan apa adanya.

Detail lengkap dan catatan kejujuran ada di `docs/TEST-REPORT.md`.

## Lisensi

MIT. Proyek demo/edukasi; bukan layanan investasi.
