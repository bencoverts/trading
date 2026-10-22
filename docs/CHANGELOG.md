# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/id/1.1.0/); versi
mengikuti `package.json`. Proyek ini demo-only — tidak pernah ada rilis yang
menangani uang nyata.

## [3.0.0] — 2026-10-22

Rilis “lengkap” pertama: platform demo end-to-end (API, realtime, UI, admin,
operasi). Semua perubahan di bawah ini adalah bagian dari rilis ini.

### Ditambahkan — backend

- **Market lanjutan**: metadata (nama, deskripsi, kategori, logo, urutan,
  unggulan), jadwal jam trading Asia/Jakarta, min/max stake, payout override,
  status `draft/active/paused/inactive/deleted`, soft delete + restore,
  pratinjau chart sebelum simpan (`POST /admin/markets/preview`) dan saran nama
  per kategori.
- **Kontrol simulasi admin**: tren (1–10), volatilitas (`rendah/sedang/tinggi/
ekstrem`), mood (`sepi/normal/cepat/liar`), pause/resume/reset — berlaku pada
  tick berikutnya, dicatat di `audit_log` + `market_param_history`, dan riwayat
  parameter dapat dibaca **publik**.
- **Bootstrap market baru**: tick + candle awal untuk semua timeframe sehingga
  chart tidak kosong saat market dibuat.
- **Staf & izin**: peran `super_admin/operator/support/viewer`, matriks izin
  (`src/auth/permissions.ts`), pemeriksaan server-side di setiap endpoint admin,
  dan endpoint `GET /admin/permissions`.
- **Sesi lanjutan**: tabel `sessions` dengan perangkat/IP/last-seen, daftar sesi
  pengguna, hapus sesi, “keluarkan perangkat lain”, pencabutan sesi saat blokir.
- **2FA TOTP** + recovery code sekali pakai; setup/enable/disable berbasis
  password + kode.
- **Keamanan akun**: lockout setelah `LOGIN_MAX_ATTEMPTS`, rate limit login,
  token verifikasi/reset sekali pakai dengan masa berlaku, rotasi `token_version`.
- **Dompet multi-mata uang**: USD/IDR/USDT, kurs demo, konversi tercatat,
  top-up demo dengan cap harian + cooldown, reset saldo demo dengan cooldown,
  kunci mata uang saat ada trade terbuka.
- **Ledger double-entry** untuk setiap hold, payout, refund, top-up, reset,
  konversi, dan penyesuaian saldo admin.
- **Idempotency** `POST /trades` (`Idempotency-Key` wajib): replay identik
  mengembalikan trade yang sama, payload berbeda → `409`.
- **Eksposur & limit**: maksimum trade terbuka per pengguna, batas eksposur
  market, batas nominal global (USD), rate limit trade per pengguna.
- **Settlement**: job 250 ms, claim `UPDATE … WHERE status='open'` (tidak dobel
  bayar), close price dari tick tersimpan, refund bila data tidak cukup,
  catch-up saat boot sebelum melayani request, manual settlement admin dengan
  alasan wajib + audit + notifikasi.
- **Konten**: banner terjadwal dan halaman (`faq/terms/privacy/contact`) yang
  dapat diedit admin dengan pratinjau.
- **Sistem**: health `/healthz` kaya (DB, WS, job, versi), `job_runs`, backup
  SQLite berkala + unduh, buffer log dengan redaksi, audit + ekspor CSV,
  statistik trade per market/durasi.
- **Notifikasi** in-app (trade settle, saldo, pengumuman) + badge.
- **Upload gambar** (logo, avatar, branding): ≤ 512 KB, magic bytes
  PNG/JPG/WEBP/SVG, nama acak, folder dari env.
- **Endpoint publik baru**: `/config`, `/markets/:symbol/ticker|candles|ticks|
history`, `/pages`, `/banners`.
- **Migration `002_v3.sql`**: 12 tabel baru (sessions, ledger, conversions,
  market history/favorites, notifications, banners, pages, settings, audit,
  idempotency, job_runs, backups, app_logs) + kolom profil/keamanan.

### Ditambahkan — frontend

- Shell SPA baru: `index.html`, design system `app.css` (tema terang/gelap,
  variabel warna, komponen kartu/tombol/pill/toast/modal/sheet), favicon dan
  meta.
- Halaman: landing, auth (masuk/daftar/lupa/reset/verifikasi), trading, riwayat,
  akun, notifikasi, konten (FAQ/syarat/privasi/kontak), halaman pintasan, 404,
  dan admin.
- Modul inti: `store`, `api` (cookie + CSRF + Idempotency-Key), `ws`
  (reconnect/backoff, subscribe, resume), `i18n` (id/en), `ui` (el, toast,
  modal, skeleton, empty state, format uang/waktu, logo market).
- Trading: chart canvas (candle/line, 7 timeframe, zoom/pan/crosshair, marker
  entry/expiry), tombol BUY/SELL besar, nominal (+/−/½/×2/maks), preset durasi
  5 s…8 jam + input manual, pratinjau payout, dialog konfirmasi dengan
  “jangan tanya lagi untuk trade kecil”, trade aktif dengan countdown + estimasi,
  toast menang/kalah/seri, suara opsional (default mati), pemilih market dengan
  pencarian/kategori/favorit.
- Riwayat: filter status/market/hasil/rentang, pagination, ekspor CSV.
- Akun: profil, keamanan (password, 2FA, sesi), dompet (top-up, konversi,
  reset, transaksi), preferensi (bahasa, tema, mata uang, suara).
- Admin: 10 bagian (dasbor, market, trade, pengguna, keuangan, pengaturan,
  konten, sistem, peran & izin, pembayaran) dengan grafik, filter, modal aksi,
  dan pemisahan bundel via dynamic import.
- Halaman Deposit/Withdraw → “Segera hadir”.
- Label **SIMULASI / DEMO** di header trading, footer, setiap kartu market, dan
  polaritas disclaimer.

### Ditambahkan — operasi & tooling

- `Dockerfile` multi-stage (non-root, healthcheck), `docker-compose.yml`
  (volume data), `ecosystem.config.cjs` (PM2 satu instance).
- ESLint flat config + Prettier + `lint`/`format`/`typecheck` script.
- `playwright.config.ts` + `e2e/smoke.spec.ts` (desktop & Pixel 7):
  registrasi → trade → hasil, login seed, admin menambah market + logo,
  bottom sheet mobile.
- `test/load/ws-load.mjs` (500 klien) + script `test:ws-load`.
- Dokumentasi: `README.md` (Indonesia), `docs/API.md`, `docs/openapi.yaml`,
  `docs/ARCHITECTURE.md`, `docs/ADMIN_GUIDE.md`, `docs/DECISIONS.md`,
  `docs/CHANGELOG.md`, dan laporan tes yang jujur.
- `.env.example` diperluas (upload/backup/CSRF/TOTP/lockout) tanpa nilai
  rahasia; `.gitignore` mencakup data upload/backup dan artefak tes.

### Diperbaiki

- Paging candle tidak lagi mengembalikan candle yang sedang berjalan.
- Buffering tick tidak lagi bergantung pada `start()` (tick awal tidak hilang).
- Fan-out tick WebSocket memakai kunci langganan yang benar.
- Validasi lintas field pengaturan mengembalikan `400 VALIDATION_ERROR`, bukan
  `500`.
- CSP/CORS menerima host preview/proxy yang sama tanpa melonggarkan allow-list.
- Settlement tidak lagi bisa membayar dua kali pada dua putaran berurutan.
- Ledger tidak lagi mencatat hold dua kali saat retry idempoten.
- `/api/v1/payments/*` mengembalikan `501` (bukan `403`) sebelum autentikasi,
  sesuai kontrak “belum tersedia”.
- SQLite `:memory:` tidak lagi membuat file bernama `:memory:` di direktori
  kerja (path khusus dipertahankan apa adanya).

### Keamanan

- Helmet + CSP ketat, HSTS di produksi, CORS allow-list + same-host.
- Cookie sesi httpOnly/SameSite/Secure (produksi) + CSRF double-submit HMAC.
- zod pada body/query/path; escape output (`textContent`), tanpa `innerHTML`
  untuk data pengguna; upload divalidasi magic bytes.
- Rahasia hanya dari env; log diredaksi; `npm audit` dilaporkan di
  `docs/TEST-REPORT.md`.

### Catatan

- **Tidak** ada deposit, penarikan, QRIS, transfer bank, payment gateway, akun
  live, atau panggilan pihak ketiga. Lihat `docs/DECISIONS.md` §0 dan §14.
- E2E Playwright belum dijalankan di sandbox ini (unduhan browser diblokir);
  dilaporkan apa adanya.

## [2.0.0] — 2026-10-20

- Backend inti: Express + SQLite + `ws`, migrasi `001_init.sql`, price engine
  simulasi, candle, trade + settlement berbasis tick, auth sesi, dompet demo.
- Frontend awal: trading, akun, admin dasar, chart canvas.
- Tes unit + integrasi awal dan `docs/API.md` versi 2.

## [1.0.0] — 2026-10-19

- Kerangka proyek: TypeScript, konfigurasi env zod, logger pino, struktur
  `src/{domain,services,routes,ws}`, `public/` statis, seed data demo.
