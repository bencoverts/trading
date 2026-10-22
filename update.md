# update.md — log rilis

Setiap entri mencatat tanggal, fitur, file penting, migrasi, endpoint,
konfigurasi, tes + hasil, bug yang diperbaiki, isu terbuka, dan langkah
berikutnya. Entri lama **tidak dihapus**.

---

## v4.0.0 — 2026-10-22

**Tema:** perluasan cakupan §0 (disetujui user): deposit KlikQRIS **demo**,
deposit transfer manual, penarikan demo dengan saldo tertahan, live chat,
admin mata uang, feature flag, maintenance, rekonsiliasi. Uang tetap virtual.

### Fitur

**Backend**

- Migrasi `003_v4.sql` (aditif): `wallets.locked_minor`, `currencies`,
  `payment_deposits`, `payment_callbacks`, `withdrawals`, `withdrawal_events`,
  `support_conversations`, `support_messages`, `site_settings`,
  `feature_flags`.
- `src/payments/klikqris.ts` — klien server-side: `create`, `statusOnce`
  (coalesced), `history`, `testConnection`, masking kredensial, transport
  injectable untuk tes, `verifyCallbackSignature` HMAC-SHA256 **fail closed**.
- `src/services/currencies.ts` — aktif/nonaktif (deaktivasi mematikan semua
  flag turunan), limit, biaya flat + bps, kurs + sumber, audit.
- `src/services/deposits.ts` — invoice QRIS dengan `total_amount` + kode unik,
  deposit manual `review`, cek status (cooldown 3 s), callback idempoten,
  `expireStale`, `reconcile`, statistik.
- `src/services/withdrawals.ts` — quote, hold via `lockFunds`, cancel/reject
  melepas hold, transisi admin lengkap, `withdrawal_events`, tujuan disamarkan.
- `src/services/chat.ts` — percakapan per user, `clientId` idempoten, catatan
  internal, status/prioritas/assign, push ke staf.
- `src/services/site.ts` — `site_settings` (branding, landing, SEO, legal,
  maintenance, email) + `feature_flags` (deposits, withdrawals, live_chat,
  demo_topup, registrations), audited.
- `src/services/wallets.ts` — `locked_minor`, `lockFunds`, `releaseFunds`,
  `settleLocked`; available = balance − locked.
- Rute: `finance.ts`, `chat.ts`, `webhooks.ts`, `adminV4.ts`; maintenance gate;
  WS `deposit:updated`, `withdrawal:updated`, `chat:message`, `chat:new`,
  `sendToStaff`.
- Peran baru `finance` + izin `deposits.*`, `withdrawals.*`, `currencies.write`,
  `chat.*`, `payments.write`, `site.write`, `flags.write`.
- Seed: `finance@simtrade.local` / `finance-demo-123`; kata sandi staf lain
  diselaraskan dengan README. Pengguna baru default mata uang **IDR**.

**Frontend**

- `/platform` + `/dashboard`, `/deposit`, `/withdraw`, `/transactions`,
  `/payment-status`, `/live-chat`, alias `/order-history`, `/profile-security`,
  `/market/:symbol`, `/adminpages(/:section)`.
- Panel admin baru: deposit, penarikan, mata uang, live chat, situs & flag;
  panel pembayaran ditulis ulang (status provider masked, tes koneksi,
  rekonsiliasi, callback).
- CSS v4 (dashboard, deposit, chat, tabel) + responsif; navigasi mengikuti
  feature flag; tema gelap default dipertahankan.
- Halaman deposit menampilkan `total_amount` (bukan nominal mentah), payload
  QRIS sebagai teks (tidak menanam gambar/link pihak ketiga di UI), polling
  status, dan riwayat dengan label status Indonesia.
- Penarikan menampilkan biaya/net, hold, dan tombol batal.

### Migrasi

- `migrations/sqlite/003_v4.sql` (baru, aditif; aman untuk DB v3).
- Seed idempoten: menambah staf `finance`, mengisi `currencies` (IDR aktif,
  USD trading-only, USDT nonaktif) dan `site_settings`.

### Endpoint baru (ringkas)

- Publik: `GET /api/v1/site`, `GET /api/v1/currencies`,
  `GET /api/v1/deposits/methods`, `POST /api/webhooks/klikqris`.
- User: `POST/GET /deposits`, `POST /deposits/manual`, `GET /deposits/:id`,
  `POST /deposits/:id/check`, `GET /withdrawals/quote`, `POST/GET /withdrawals`,
  `POST /withdrawals/:id/cancel`, `GET /transactions`, `GET/POST /chat`, chat
  messages/upload/close.
- Admin: `GET /admin/currencies`, `PATCH /admin/currencies/:code`,
  `GET /admin/deposits[/:id]`, `POST /admin/deposits/:id/review`,
  `GET /admin/withdrawals[/:id]`, `GET /admin/withdrawals/export.csv`,
  `POST /admin/withdrawals/:id/transition`, `GET /admin/payments`,
  `POST /admin/payments/test-connection`, `POST /admin/payments/reconcile`,
  `GET /admin/payments/callbacks`, `GET/PATCH /admin/site`,
  `PATCH /admin/site/flags/:key`, `GET /admin/chat[/:id]`,
  `POST /admin/chat/:id/{messages,status,priority,assign}`,
  `GET /admin/ledger[/export.csv]`.
- Detail kontrak: `docs/API.md` §10–§17.

### Konfigurasi

- Baru: `PAYMENTS_ENABLED` (default `false`), `KLIKQRIS_BASE_URL`,
  `KLIKQRIS_API_KEY`, `KLIKQRIS_MERCHANT_ID`, `KLIKQRIS_CALLBACK_URL`,
  `KLIKQRIS_WEBHOOK_SECRET`, `KLIKQRIS_SIGNATURE_HEADER`,
  `KLIKQRIS_TIMEOUT_MS`.
- `.env.example` diperbarui dengan peringatan signature. Tidak ada rahasia di
  repo; admin hanya melihat ID masked + status “terpasang/belum”.

### Tes & hasil

- `npm test` → **219 lulus / 219** (20 file). Baru:
  `test/unit/klikqris.test.ts` (10), `test/integration/deposits.test.ts` (13),
  `test/integration/withdrawals.test.ts` (11), `test/integration/chat.test.ts`
  (6), `test/integration/site.test.ts` (8), plus perluasan
  `test/integration/access.test.ts` (10) untuk pemisahan peran market vs
  keuangan.
- `npm run typecheck` → bersih. `npm run lint` → bersih (0 error/warning).
  `npm run build` → sukses.
- `npm audit --omit=dev` → 0 kerentanan. `npm audit` penuh → 2 critical + 1
  moderate di rantai dev vitest/tinypool; perbaikan butuh vitest 5 (breaking),
  **tidak** dipaksakan.
- WebSocket load (`node test/load/ws-load.mjs 500 12`): 500/500 tersambung,
  0 error, 9 601 pesan/detik, delay tick p50 42 ms / p95 66 ms.
- Playwright (`e2e/smoke.spec.ts` + `e2e/v4.spec.ts`): spesifikasi lengkap,
  **belum dijalankan** (unduhan browser diblokir di sandbox) — dilaporkan apa
  adanya.
- Uji manual end-to-end via HTTP (server `tsx` nyata): register → trade +
  idempoten → deposit manual → approve admin → penarikan approve/process/
  complete → chat user/staf → `/admin/payments`, `/admin/site`,
  `/admin/currencies` semuanya 2xx sesuai harapan.

### Bug yang diperbaiki selama v4

- `migrations/sqlite/003_v4.sql` memakai komentar `/** */` yang membuat
  `exec()` gagal di `node:sqlite` → diganti `--`.
- Rute chat ter-mount ganda (`/chat/chat/...`) → dipasang sekali di `/chat`.
- `/admin/payments` v3 (placeholder) menutupi implementasi v4 → urutan mount
  dibalik.
- `SiteService.flags()` mengembalikan array padahal UI/API memakai objek →
  dipisah `flags()` (objek) dan `flagDetails()` (array); flag tak dikenal kini
  `400`, bukan `500`.
- Deaktivasi mata uang meninggalkan `trading_enabled=1` sehingga patch ditolak →
  deaktivasi kini mematikan semua flag turunan.
- `GET /wallet` tidak mengembalikan `locked/available` → ditambahkan.
- Daftar admin deposit/penarikan tidak memuat `userEmail` → join ditambahkan.
- Halaman trading memakai kurs hard-coded 16 000 → memakai `config.rates`.
- Seed password staf tidak cocok dengan README → diselaraskan
  (`support-demo-123`, `operator-demo-123`).

### Isu terbuka / blocker

1. **Signature callback KlikQRIS belum terverifikasi** (tidak ada di dokumen
   yang tersedia). Callback ditolak (fail closed) sampai skema dikonfirmasi.
   Jalur yang aman: cek status, rekonsiliasi, deposit manual.
2. Playwright E2E belum dijalankan di sandbox (browser tidak dapat diunduh).
3. Tidak ada uji ke provider KlikQRIS nyata (sandbox tanpa jaringan); klien
   diuji dengan transport stub.
4. USD/USDT tidak dapat dipakai untuk deposit/penarikan sampai admin
   mengaktifkan + mengisi sumber kurs.
5. Screenshot desktop/mobile belum diambil (butuh browser).

### Langkah berikutnya (saran)

- Konfirmasi skema signature KlikQRIS → sesuaikan `verifyCallbackSignature`
  - tes vektor resmi.
- Jalankan Playwright di CI dengan browser terpasang; tambah skenario callback
  palsu + antrian admin.
- Pertimbangkan rate limit per-token untuk webhook dan alert jika callback
  ditolak berulang.
- Audit retensi `payment_callbacks` (mis. 90 hari) dan ekspor CSV rekonsiliasi.

---

## v3.0.0 — 2026-10-22 (ringkas)

Fondasi platform simulasi: engine harga, candle server + WS, trade dengan
idempotensi & settlement, akun + 2FA, dompet virtual, admin lengkap, keamanan,
i18n, 166 tes. Detail: `docs/CHANGELOG.md`.

## v2.0.0 — 2026-10-20 (ringkas)

Market admin + chart, panel trade, riwayat, admin dasar.

## v1.0.0 — 2026-10-19 (ringkas)

Kerangka awal: Express + SQLite + auth + engine harga.
