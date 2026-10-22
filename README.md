# SimTrade Demo — platform trading biner **simulasi**

Satu server Node.js melayani API, feed WebSocket, dan UI browser. Harga dibuat
oleh server simulasi sendiri, saldo sepenuhnya virtual, dan setiap halaman
trading menampilkan label **SIMULASI / DEMO**.

> **Tidak ada uang sungguhan.**
> Tidak ada akun live, deposit, penarikan, QRIS, transfer bank, maupun payment
> gateway. Modul `payments/` ada sebagai _seam_ arsitektur dan selalu menjawab
> `501 NOT_AVAILABLE` (“belum tersedia”), dengan halaman “Segera hadir”.
> Menjalankan platform derivatif dengan uang nyata memerlukan izin (di Indonesia:
> Bappebti/OJK) — jangan arahkan kode ini ke dana nyata.

- **Stack**: TypeScript, Express, SQLite (WAL, FK, migrasi, seed), `ws`, zod,
  pino (redaksi), canvas chart tanpa dependency.
- **Bahasa**: Indonesia default, English tersedia (i18n dua kamus).
- **Tes**: 166 tes otomatis (unit + integrasi), 8 skenario Playwright (belum
  dijalankan di sandbox ini — lihat `docs/TEST-REPORT.md`).

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

- USD, IDR, USDT; saldo awal diatur admin; kurs demo; setiap konversi tercatat;
  mata uang terkunci saat ada trade terbuka; “Top-up Demo” dan “Reset Saldo
  Demo” dengan batas + cooldown; semua di ledger.

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
- Pembayaran: placeholder “Segera hadir”. Matriks peran: `super_admin`,
  `operator`, `support`, `viewer` — dicek di server pada setiap endpoint.

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
  routes/               auth, account, market, trades, admin, content, payments
  services/             users, wallets, ledger, markets, trades, settlement, …
  ws/                   protokol + server realtime
public/                 index.html, css/app.css, js/{app,router,store,api,ui,ws,chart,i18n}.js, js/pages/*
migrations/sqlite/      001_init.sql, 002_v3.sql
test/                   unit/, integration/, load/
e2e/                    Playwright
docs/                   API, ARCHITECTURE, ADMIN_GUIDE, DECISIONS, CHANGELOG, TEST-REPORT
```

Arsitektur (termasuk diagram tick → candle → chart dan trade → settlement) ada
di `docs/ARCHITECTURE.md`. Kontrak API + WebSocket: `docs/API.md` dan
`docs/openapi.yaml`. Keputusan produk/teknis: `docs/DECISIONS.md`.

---

## 4. Batasan yang disengaja

| Area                                                             | Status                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Akun live, deposit, penarikan, QRIS, bank transfer, kartu        | **tidak diimplementasikan** (`501`, halaman “Segera hadir”)                 |
| Panggilan ke pihak ketiga (bursa, data harga, email, pembayaran) | **tidak ada**; email ditulis ke log/dev link                                |
| Uang sungguhan                                                   | **tidak ada**, semua saldo virtual                                          |
| Admin mengubah hasil trade                                       | **tidak bisa**; hanya parameter simulasi, semuanya audited + riwayat publik |
| Multi-instance                                                   | tidak didukung (SQLite + settlement in-process); jalankan 1 instance        |

Fase berikutnya (di luar §0) didokumentasikan di `docs/DECISIONS.md`.

---

## 5. Hasil pengujian (ringkas)

- `npm run typecheck` — bersih.
- `npm run lint` — bersih.
- `npm test` — **166 tes lulus** (15 file).
- `npm run build` — sukses.
- WebSocket load: **500 klien tersambung, 0 error**, ±9 900 pesan/detik,
  delay tick p50 36 ms / p95 67 ms (lihat `docs/TEST-REPORT.md`).
- Playwright E2E: spesifikasi selesai tetapi **belum dijalankan** karena unduhan
  browser diblokir di sandbox; hal ini dilaporkan apa adanya.

Detail lengkap dan catatan kejujuran ada di `docs/TEST-REPORT.md`.

## Lisensi

MIT. Proyek demo/edukasi; bukan layanan investasi.
