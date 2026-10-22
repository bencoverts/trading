# Keputusan (ADR ringkas)

Setiap entri: konteks → keputusan → konsekuensi. Keputusan yang masih terbuka
ada di bagian akhir.

> **PEMBARUAN v4 (2026-10-22) — §0 dan §14 DIGANTIKAN SECARA EKSPLISIT.**
> Permintaan v4 memperluas cakupan: deposit **KlikQRIS (demo)**, penarikan
> dengan saldo tertahan + proses manual admin, live chat, rekonsiliasi, dan
> admin mata uang. §0 dan tabel “fase berikutnya” di §14 **tidak dihapus**
> (riwayat tetap utuh) tetapi **tidak lagi berlaku**. Batasan yang **tetap**
> berlaku: harga & hasil trade tetap ditentukan server simulasi, admin tidak
> boleh mengubah hasil satu trade, label **SIMULASI / DEMO** tetap ada di
> setiap halaman trading dan setiap payload API. Lihat §20–§27 untuk keputusan
> v4, termasuk **celah algoritma signature KlikQRIS** yang membuat callback
> ditolak secara default (fail closed).

---

## 0. Batas produk: simulasi saja — **DIGANTIKAN oleh §20 (v4)**

**Konteks.** Meminta pembangunan platform trading biner “lengkap” berisiko
dibaca sebagai izin membangun layanan beruang nyata.
**Keputusan.** Build ini **demo-only**: tidak ada akun live, deposit,
penarikan, QRIS, transfer bank, kartu, atau payment gateway. `src/payments/`
adalah _seam_ yang menjelaskan maksud arsitektur dan selalu menjawab
`501 NOT_AVAILABLE`; UI menampilkan halaman “Segera hadir”. Tidak ada satu pun
panggilan jaringan ke pihak ketiga (harga, email, pembayaran).
**Konsekuensi.** Semua saldo virtual. Label **SIMULASI / DEMO** ada di halaman
trading, footer, halaman market, dan setiap payload API (`simulation: true`,
`label: "SIMULASI"`). Menjalankan derivatif beruang nyata memerlukan izin
(Bappebti/OJK di Indonesia); fase berikutnya didokumentasikan di §14.

## 1. “Dodge Coin” → **Dogecoin**

**Keputusan.** Market bernama “Dogecoin (simulasi)”, symbol `DOGE`, harga awal
`0.42871`, 5 desimal, tick `0.0001`, volatilitas `ekstrem`, max stake 500 USD.
**Alasan.** “Dodge Coin” bukan nama aset yang dikenal dan berisiko dianggap
typo/peniruan; Dogecoin adalah istilah netral yang jelas.
**Konsekuensi.** Tidak ada data harga nyata yang diambil; pergerakan murni dari
engine simulasi. Nama pasar komposit (`ASIA_COMPOSITE`, `CRYPTO_COMPOSITE`)
sengaja fiktif agar tidak terkesan mereplikasi indeks berlisensi.

## 2. Branding sendiri

Nama **SimTrade Demo**, aksen `#5b8cff`, logo SVG sederhana, tata letak dan
warna dirancang dari nol. Tidak ada peniruan merek, logo, atau copy platform
lain. Aset hanya ikon inline + canvas.

## 3. Satu proses, SQLite, satu instance

**Konteks.** Butuh konsistensi saldo + settlement + tick tanpa infrastruktur
tambahan.
**Keputusan.** Satu proses Node.js; SQLite WAL + `foreign_keys=ON`; migrasi
bernomor; settlement in-process.
**Konsekuensi.** Skala horizontal tidak didukung (didokumentasikan di README).
Trade hold memakai `BEGIN IMMEDIATE` sehingga penulis tunggal justru menjadi
pengunci yang murah dan benar. Untuk multi-instance perlu Postgres + advisory
lock (lihat §14).

## 4. Driver SQLite: `better-sqlite3` primer, `node:sqlite` fallback

**Keputusan.** `src/db/sqlite.ts` mencoba `better-sqlite3`, lalu jatuh ke
`node:sqlite` (Node ≥ 22) dengan antarmuka yang sama (`get/all/run/exec`).
**Alasan.** Instalasi native sering gagal di sandbox/CI (tanpa toolchain atau
tanpa unduhan prebuilt), sementara `node:sqlite` sudah tersedia di Node 22.
**Konsekuensi.** Semua tes di repo ini berjalan di `node:sqlite`; jalur
`better-sqlite3` belum diuji di mesin ini (dicatat di `TEST-REPORT.md`). API
mengembalikan `dbDriver` di `/healthz` supaya operator tahu yang aktif.

## 5. Uang sebagai integer minor unit

**Keputusan.** Simpan `*_minor` (USD/USDT 2 desimal, IDR 0); konversi ke desimal
hanya di lapisan API/UI. `CHECK (balance_minor >= 0)` plus `UPDATE … WHERE
balance_minor >= ?` sebagai pertahanan berlapis.
**Konsekuensi.** Tidak ada galat pembulatan float pada saldo/payout; pembulatan
payout dilakukan sekali, ke bawah/terdekat pada minor unit.

## 6. `Idempotency-Key` wajib pada `POST /trades`

**Keputusan.** Header wajib. Key + hash payload disimpan; replay dengan payload
identik mengembalikan trade yang sama (`200` + `Idempotent-Replayed`), payload
berbeda → `409 IDEMPOTENCY_KEY_REUSED`.
**Alasan.** Retry jaringan adalah sumber utama trade ganda; ini lebih murah
daripada rekonsiliasi manual.
**Konsekuensi.** Klien (UI) membuat UUID per percobaan. Key disimpan dengan TTL
dan dibersihkan job cleanup.

## 7. Payout: mode profit, default 85 %

**Keputusan.** `payoutRate = 0.85`, mode `profit` → menang dibayar
`stake × (1 + rate)`, kalah `0`, seri refund penuh. Mode `total` tersedia untuk
admin yang ingin rate sebagai total return. Override per market dan per durasi.
**Alasan.** “85 %” adalah konvensi yang mudah dipahami pengguna demo; perhitungan
tetap di server.
**Konsekuensi.** House edge terlihat transparan di pratinjau (payout % + nominal
profit). Tidak ada “bonus” tersembunyi.

## 8. Settlement manual: ada, tetapi sempit

**Konteks.** Operator butuh jalur koreksi bila tick hilang/rusak.
**Keputusan.** Endpoint admin `POST /admin/trades/:id/settle` dengan alasan
wajib ≥ 5 karakter, opsional harga close, hanya izin `trades.settle`, menulis
`audit_log`, mengirim notifikasi, dan menandai `settled_by: "admin"` +
`settle_reason` yang **terlihat pengguna**.
**Konsekuensi.** Secara teknis admin bisa mengubah hasil satu trade — itu
konsekuensi dari fitur koreksi — tetapi tidak bisa melakukannya diam-diam:
alasan, aktor, waktu, dan harga tercatat dan tampil di riwayat pengguna. Engine
sendiri tidak pernah memakai input admin untuk menentukan hasil trade normal.
Alternatif “tidak ada override sama sekali” ditolak karena meninggalkan trade
macet tanpa penyelesaian.

## 9. Hasil = perbandingan harga terekam

**Keputusan.** UP menang bila `close > entry`, DOWN menang bila `close < entry`,
sama → seri/refund. `close` = tick terakhir pada/atau sebelum `expiry_time`,
diambil dari tick tersimpan (bukan harga live saat job jalan). Tidak ada tick →
refund, bukan hasil karangan.
**Konsekuensi.** Hasil reproducible dari data; bisa diaudit ulang. Jam server
satu-satunya jam.

## 10. Admin hanya boleh menyentuh parameter simulasi

**Keputusan.** `trend` (1–10), `volatilityPreset`, `mood`, `pause` — berlaku
pada tick berikutnya, tidak mengubah riwayat, dicatat di `audit_log` dan
`market_param_history`. Riwayat parameter **publik**.
**Konsekuensi.** Pengguna bisa melihat bahwa tren diubah. Ini disengaja:
transparansi adalah bagian dari desain demo, bukan kebocoran.

## 11. Mata uang terkunci saat ada trade terbuka

**Keputusan.** Mengganti `displayCurrency` atau mengonversi dana ditolak
(`409 CURRENCY_LOCKED`) bila pengguna punya trade terbuka.
**Alasan.** Menghindari kebingungan saldo/hold antar mata uang saat ada posisi
berjalan.
**Konsekuensi.** Pengguna harus menunggu trade selesai; UI menjelaskan alasannya.

## 12. Saldo awal & “Top-up Demo”

USD 1 000 / IDR 15 000 000 / USDT 1 000, kurs demo 1 USD = 16 000 IDR.
Top-up dibatasi `topupDailyCount = 5` per hari dan cooldown 30 detik; reset
saldo punya cooldown 300 detik. Semua masuk ledger. Tidak ada konsep “deposit”.

## 13. Keamanan

| Keputusan                                                               | Alasan                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Cookie sesi `httpOnly`, `SameSite=Lax`, `Secure` bila produksi          | mencegah XSS mencuri sesi                                       |
| CSRF double-submit (`sim_csrf` + header `x-csrf-token`, HMAC hex)       | aman untuk SPA same-origin tanpa state server tambahan          |
| argon2id (fallback scrypt pada `node:crypto`)                           | hash modern; fallback agar build tetap jalan tanpa modul native |
| Token verifikasi/reset sekali pakai + `token_version`                   | reset mencabut semua sesi lama                                  |
| Rate limit per IP (login, API) + per pengguna (trade)                   | mengurangi brute force dan spam trade                           |
| zod untuk body/query/path                                               | validasi server-side wajib, error terstruktur                   |
| Upload: batas 512 KB, magic bytes, nama acak, folder di luar kode       | mencegah path traversal & SVG berbahaya                         |
| `textContent` (bukan `innerHTML`) untuk data pengguna                   | mencegah XSS                                                    |
| Helmet + CSP ketat, CORS allow-list + same-host                         | aman sekaligus tetap bisa diakses lewat preview/proxy           |
| pino redaksi (`authorization`, `cookie`, `password`, `token`, `secret`) | tidak ada rahasia di log                                        |
| Rahasia hanya dari env + `.env.example` tanpa nilai nyata               | tidak ada kredensial di repo                                    |
| `npm audit` dilaporkan apa adanya                                       | lihat `TEST-REPORT.md`                                          |

**Konsekuensi.** Bearer token tetap didukung untuk klien non-browser, tetapi
jalur utama adalah cookie + CSRF. CSP memblokir skrip inline; semua JS dimuat
dari `/js/*`.

## 14. Fase berikutnya (di luar §0, sengaja belum dibuat) — **DIGANTIKAN oleh §20 (v4)**

> Catatan v4: deposit, penarikan, QRIS, live chat, rekonsiliasi dan admin mata
> uang **sudah dikerjakan** sebagai alur demo (§20–§27). Yang masih belum:
> dana nyata, KYC/AML, harga bursa, multi-instance, SMTP nyata, antrian job
> terpisah, dan penyimpanan audit WORM.

| Item                                                           | Alasan belum dibuat                                    |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| Deposit/penarikan, QRIS, transfer bank, kartu, payment gateway | butuh izin, kepatuhan, dan rekonsiliasi keuangan nyata |
| KYC/AML, verifikasi identitas, limit per akun                  | hanya relevan untuk dana nyata                         |
| Harga dari bursa/pihak ketiga, akun live                       | §0 melarang panggilan pihak ketiga                     |
| Multi-instance / Postgres / Redis pub-sub                      | SQLite satu penulis; butuh desain ulang settlement     |
| Email SMTP nyata, push notification                            | saat ini dev mailer + log; tidak ada kredensial        |
| Antrian job terpisah (BullMQ dsb.)                             | scheduler in-process cukup untuk satu instance         |
| Audit trail immutable (append-only store/WORM)                 | saat ini tabel + ekspor CSV                            |

## 15. Frontend tanpa framework

**Keputusan.** Vanilla JS ES modules, satu `app.css`, chart canvas buatan
sendiri, `import()` untuk halaman admin.
**Alasan.** Tanpa build step untuk frontend → `npm start` langsung melayani UI;
lebih mudah diaudit; tidak ada supply chain tambahan.
**Konsekuensi.** Tidak ada hidrasi/reaktivitas otomatis; `store.js` kecil +
fungsi render manual. Bundel admin terpisah secara alami (dynamic import).

## 16. i18n Indonesia default

Kamus `id` + `en` di `public/js/i18n.js`, `data-i18n` untuk teks statis,
`t()` untuk teks dinamis, preferensi tersimpan di profil. Tanggal memakai
locale browser + zona waktu akun (default `Asia/Jakarta`). Teks server
(pesan error) berbahasa Indonesia agar konsisten walau UI bahasa Inggris —
kode error tetap bahasa mesin agar bisa dipetakan klien.

## 17. Seed data realistis

`npm run seed` idempoten: 3 market (dengan tick & candle bootstrap), staf
(`super_admin`, `operator`, `support`), pengguna demo (`demo`, `siti`, terverifikasi;
`budi` belum verifikasi), dompet, dan 5 trade contoh (`seed-demo-0..4`) dengan
berbagai hasil. Password seed hanya untuk demo dan tercantum di README.

## 18. Job in-process, bukan worker terpisah

Settlement tiap 250 ms, health engine 15 s, cleanup 6 jam, backup 6 jam. Setiap
run dicatat di `job_runs`, bisa dipicu manual dari admin, dan trade kedaluwarsa
diselesaikan saat boot **sebelum** melayani request. Konsekuensi: satu proses
mati = tidak ada settlement sampai hidup lagi (lalu catch-up).

## 19. Pilihan yang masih terbuka (perlu keputusan bisnis)

1. **Durasi maksimum** — sekarang 8 jam. Apakah perlu 24 jam/1 minggu?
2. **Payout per durasi** — struktur rate bertingkat (durasi pendek lebih mahal)
   belum diaktifkan; tabelnya sudah ada.
3. **Eksposur** — batas eksposur per market saat ini sederhana (total stake
   terbuka). Perlu model risk limit per arah/pengguna?
4. **Retensi** — tick 7 hari, candle 90 hari. Apakah data trade/ledger perlu
   retensi lebih panjang untuk audit?
5. **Verifikasi email** — saat ini opsional untuk trading (mode demo). Aktifkan
   wajib?
6. **Market libur** — jam trading per market ada, hari libur belum.
7. **PWA/offline** — belum ada service worker.
8. **Screenshot** — belum diambil di sesi ini (sandbox tanpa browser); lihat
   `TEST-REPORT.md`.

---

# Bagian v4 (mulai 2026-10-22)

## 20. Cakupan v4: deposit/penarikan/live chat **demo** menggantikan §0

**Konteks.** User meminta deposit KlikQRIS, penarikan, verifikasi manual,
live chat, admin mata uang, dan rekonsiliasi — hal yang dilarang §0 v3.
**Keputusan.** Fitur tersebut dibangun, tetapi tetap **demo**:

- KlikQRIS hanya dipanggil **server-side** (`src/payments/klikqris.ts`), dengan
  kredensial dari env. Browser tidak pernah memanggil provider.
- Tidak ada saldo yang bertambah sebelum verifikasi server; “sukses” di UI
  hanya muncul setelah status dari provider atau persetujuan admin.
- `PaymentService.describe().liveMoney` selalu `false` dan ditampilkan di UI.
- Label **SIMULASI** ada di halaman deposit, penarikan, status pembayaran, chat,
  dan setiap respons API terkait uang.
  **Konsekuensi.** §0 dan §14 tidak lagi berlaku. Risiko hukum/izin tetap ada
  jika kode ini diarahkan ke dana nyata; README memperingatkan hal ini.

## 21. Mata uang: IDR aktif, USD/USDT nonaktif, kurs tidak boleh ditebak

**Keputusan.** `003_v4.sql` mengaktifkan **IDR** untuk deposit/penarikan/trading.
**USD** tetap `trading_enabled = 1` karena engine simulasi dan riwayat harga
berbasis USD, tetapi `deposit_enabled = withdrawal_enabled = 0` (tidak bisa
diisi/ditarik). **USDT** sepenuhnya nonaktif. Setiap mata uang punya
`fx_rate_to_idr` + `fx_source` (default `demo:static`), dan admin wajib mengisi
sumber saat mengubah kurs.
**Alasan.** Melarang semua penggunaan USD akan memaksa migrasi ulang data
simulasi dan menghapus fitur yang sudah bekerja; yang penting adalah **tidak
ada aliran uang** ke/dari USD. Menonaktifkan mata uang **tidak menghapus
saldo**; trade baru pada mata uang nonaktif ditolak server
(`CURRENCY_NOT_AVAILABLE`).
**Konsekuensi.** Konversi memakai kurs yang tersimpan, bukan kurs yang diasumsikan;
UI menampilkan sumber kurs.

## 22. Peran: tambah `finance`, jangan ganti nama peran lama

**Konteks.** v4 meminta `super_admin, admin, finance, support, user`. Build ini
sudah punya `super_admin, operator, support, viewer` (dan `user` = tanpa peran staf).
**Keputusan.** Tambah **`finance`**; `operator` dipertahankan sebagai admin
market/trade; `viewer` dipertahankan read-only. Pemetaan:

| Diminta                                                                         | Di build ini                        | Catatan                                            |
| ------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| super_admin                                                                     | `super_admin`                       | semua izin, satu-satunya yang bisa ubah peran      |
| admin                                                                           | `operator` (+ `finance` untuk uang) | sengaja dipisah agar market ≠ keuangan             |
| finance                                                                         | `finance` (baru)                    | deposit review, penarikan, mata uang, rekonsiliasi |
| support                                                                         | `support`                           | chat, baca user/trade, tidak bisa uang             |
| user                                                                            | tanpa `staff_role`                  | pengguna biasa                                     |
| **Konsekuensi.** Izin baru: `deposits.read/review`, `withdrawals.read/process`, |
| `currencies.write`, `chat.read/write`, `payments.write`, `site.write`,          |
| `flags.write`. Matriks di `src/auth/permissions.ts` ditegakkan **server-side**; |
| menu yang disembunyikan bukan keamanan.                                         |

## 23. Signature callback KlikQRIS: **fail closed**, tidak menebak

**Konteks.** Dokumentasi yang tersedia menyebut `signature` pada respons
`/qris/create` tetapi **tidak** mendefinisikan algoritma signature callback.
**Keputusan.** Implementasi hanya menerima HMAC-SHA256 atas
`order_id|status|amount|merchant_id` dengan secret `KLIKQRIS_WEBHOOK_SECRET`,
dikirim pada header `KLIKQRIS_SIGNATURE_HEADER` (default
`x-callback-signature`, fallback `x-signature`/`signature`). Jika secret tidak
diset → **semua callback ditolak 401**. Tidak ada “mode percaya” tersembunyi.
Perbandingan memakai `timingSafeEqual`. Setiap callback (valid/invalid) dicatat
di `payment_callbacks` dengan `accepted` + `reason`.
**Konsekuensi.** Tanpa konfirmasi skema dari KlikQRIS, **callback pembayaran
tidak akan pernah diterima**. Alur yang tetap aman: cek status manual
(`POST /deposits/:id/check`, dibatasi 3 detik), rekonsiliasi admin
(`POST /admin/payments/reconcile`), atau **verifikasi manual admin** untuk
deposit transfer manual. Celah ini tercatat sebagai blocker #1 di README dan
`update.md`.

## 24. Deposit: `total_amount`, kode unik, dan idempotensi

- `POST /deposits` membuat invoice server-side dengan `Idempotency-Key` opsional
  namun **disarankan**; replay mengembalikan invoice yang sama (`reused: true`).
- Yang ditampilkan ke pengguna adalah **`total_amount`** dari provider (termasuk
  `amount_uniq`), bukan nominal yang diminta. UI menampilkan keduanya.
- Callback `paid` mengkredit **`total_amount`** (bukan `amount`) dan hanya bila
  nominal cocok dengan invoice (`AMOUNT_MISMATCH` → 409, tanpa kredit).
- Kredit terjadi di dalam satu transaksi, idempoten (unique
  `payment_deposits.provider_order_id` + status guard), dan menulis **satu**
  baris ledger `kind='deposit'`.
- Deposit manual (`POST /deposits/manual`) masuk status `review`; saldo hanya
  bertambah setelah admin `approve` (wajib alasan saat `reject`).
- Expiry 15 menit; `expireStale` menutup invoice kedaluwarsa.

## 25. Penarikan: saldo tertahan, bukan langsung didebit

**Keputusan.** `POST /withdrawals` memindahkan dana ke `wallets.locked_minor`
(`lockFunds`, `BEGIN IMMEDIATE` + cek `balance − locked`), status `pending`,
dan **tidak** mengurangi saldo total. Debit nyata terjadi saat admin
menyelesaikan (`completed`), yang memakai `settleLocked`. `reject` dan
`cancel` memanggil `releaseFunds` **tepat sekali** (status guard).
Transisi yang diizinkan: `pending → approved|review|rejected|cancelled`,
`approved → processing|rejected`, `processing → completed|rejected`.
Setiap transisi menulis `withdrawal_events` + audit (aktor, aksi, objek,
alasan, hasil). Nomor rekening **disamarkan** di semua respons (`••••7890`)
dan hash-nya disimpan terpisah; data mentah tidak pernah masuk log.
**Konsekuensi.** Tidak ada kemungkinan saldo negatif; uji konkurensi menahan
tiga penarikan paralel dengan saldo terbatas.

## 26. Live chat: pesan dipersist sebelum di-stream

- Percakapan milik user ditegakkan di service (`CHAT_FORBIDDEN`), bukan di UI.
- `clientId` unik per percakapan → pengiriman ulang tidak menggandakan pesan.
- Catatan internal (`internal: true`) disimpan pada thread yang sama tetapi
  **disaring** dari respons user.
- Staf menerima `chat:new` / `chat:message` lewat `sendToStaff` (role staf).
- Fitur dapat dimatikan via flag `live_chat` → 503, bukan error 500.

## 27. Rekonsiliasi & job

`DepositService.expireStale()` (job 5 menit) menutup invoice kedaluwarsa.
`reconcile()` mengambil riwayat provider, memeriksa invoice lokal yang masih
`pending`, dan melaporkan transaksi yang **hanya ada di provider** tanpa
mengarang kredit. Semua panggilan provider memiliki timeout dan tidak
menghentikan request lain saat gagal.
