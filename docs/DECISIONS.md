# Keputusan (ADR ringkas)

Setiap entri: konteks → keputusan → konsekuensi. Keputusan yang masih terbuka
ada di bagian akhir.

---

## 0. Batas produk: simulasi saja

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

## 14. Fase berikutnya (di luar §0, sengaja belum dibuat)

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
