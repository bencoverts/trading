# Laporan Pengujian

Dijalankan pada **2026-10-22**, Node **22.22.3** (Linux x64), driver SQLite
**`node:sqlite`** (fallback; `better-sqlite3` tidak tersedia di sandbox — lihat
“Keterbatasan”). Semua angka di bawah adalah keluaran nyata dari perintah yang
tertulis, bukan perkiraan.

## Ringkasan

| Pemeriksaan          | Perintah                            | Hasil                                              |
| -------------------- | ----------------------------------- | -------------------------------------------------- |
| Tes unit + integrasi | `npx vitest run`                    | **166 lulus / 166**, 15 file, 0 gagal, ~4,1 s      |
| Typecheck            | `npm run typecheck`                 | bersih (0 diagnostik)                              |
| Lint                 | `npx eslint .`                      | bersih (0 error, 0 warning)                        |
| Build                | `npm run build`                     | sukses (`tsc` → `dist/`)                           |
| Audit produksi       | `npm audit --omit=dev`              | **0 kerentanan**                                   |
| Audit penuh          | `npm audit`                         | 3 (semua dev-only: vitest/tinypool)                |
| E2E Playwright       | `npx playwright test`               | **tidak dijalankan** — browser tidak dapat diunduh |
| Beban WebSocket      | `node test/load/ws-load.mjs 500 12` | 500 klien, 0 error                                 |

```
Test Files  15 passed (15)
     Tests  166 passed (166)
  Duration  3.85s
```

## Rincian per file

| Suite                                      | File                                   |     Tes | Hasil           |
| ------------------------------------------ | -------------------------------------- | ------: | --------------- |
| unit — payout & uang                       | `test/unit/payout.test.ts`             |      12 | lulus           |
| unit — agregasi candle                     | `test/unit/candles.test.ts`            |       7 | lulus           |
| unit — price engine & feed                 | `test/unit/price-engine.test.ts`       |      12 | lulus           |
| unit — validasi zod & jadwal               | `test/unit/validation.test.ts`         |      12 | lulus           |
| unit — keamanan (hash, CSRF, upload, uang) | `test/unit/security.test.ts`           |      12 | lulus           |
| integrasi — auth & sesi                    | `test/integration/auth.test.ts`        |      14 | lulus           |
| integrasi — trade & validasi               | `test/integration/trades.test.ts`      |      13 | lulus           |
| integrasi — konkurensi saldo               | `test/integration/concurrency.test.ts` |       5 | lulus           |
| integrasi — settlement                     | `test/integration/settlement.test.ts`  |       9 | lulus           |
| integrasi — market API publik              | `test/integration/market-api.test.ts`  |      11 | lulus           |
| integrasi — admin, audit, payments         | `test/integration/admin.test.ts`       |      23 | lulus           |
| integrasi — akun & dompet demo             | `test/integration/account.test.ts`     |      14 | lulus           |
| integrasi — akses per peran                | `test/integration/access.test.ts`      |       7 | lulus           |
| integrasi — WebSocket                      | `test/integration/ws.test.ts`          |       7 | lulus           |
| integrasi — UI browser (jsdom)             | `test/integration/frontend.test.ts`    |       8 | lulus           |
| **total**                                  | **15 file**                            | **166** | **semua lulus** |

## Apa yang benar-benar diverifikasi

### Harga, candle, chart data

- Harga selalu berhingga, > 0, dan terkuantisasi ke desimal market; input tidak
  valid (`0`, `NaN`) ditolak.
- Feed deterministik untuk RNG ber-seed; tren `up`/`down` menggeser drift;
  `liar` menghasilkan rentang lebih lebar daripada `sepi`.
- Nomor urut (seq) naik per market secara independen.
- Bucket candle sejajar batas timeframe; satu tick yang melewati batas
  menutup tepat satu candle; batas bersama menutup `5s/15s/30s/1m` sekaligus
  sementara `5m/15m/1h` tetap terbuka.
- Tick terlambat untuk bucket yang sudah ditutup tidak mengubah riwayat.
- Paging (`limit`, `before`) hanya mengembalikan candle tertutup; data yang
  sama tidak terduplikasi saat seeding; pruning menghapus yang lama.
- `priceAt(expiry)` mengembalikan tick terakhir pada/sebelum waktu tertentu dan
  `null` bila tidak ada.

### Payout & settlement

- UP menang di atas entry, DOWN menang di bawah entry, harga sama = seri untuk
  kedua arah (termasuk noise float `0.1 + 0.2`).
- Mode profit: menang = stake + 85 %, kalah = 0, seri = refund; pembulatan ke
  satuan minor. Mode total diperlakukan sebagai total return.
- Integrasi: menang → saldo +85 % profit; kalah → stake hangus; seri → refund
  persis; DOWN menang saat harga turun; tidak ada settlement sebelum
  `expiryTime`.
- Dua putaran settlement berurutan hanya membayar sekali (klaim
  `UPDATE … WHERE status='open'`).
- Trade yang kedaluwarsa saat proses mati diselesaikan saat boot berikutnya
  (`settledBy: "expiry"`).
- Tanpa tick setelah entry → refund, bukan hasil karangan.

### Keselamatan saldo (`BEGIN IMMEDIATE`)

- 25 `POST /trades` paralel sebesar $100 terhadap saldo $1 000 → tepat **10**
  berhasil, 15 gagal `INSUFFICIENT_FUNDS`, saldo akhir 0, dan total stake sama
  dengan debit.
- Burst kedua setelah saldo habis tidak membuat trade (saldo tetap ≥ 0; juga
  dijaga `CHECK (balance_minor >= 0)`).
- Saldo yang diubah manual langsung dihormati request berikutnya (tanpa stale
  read).

### Validasi & aturan trading

- `durationSec` di luar 5–28 800 → `400`; di dalam rentang tetapi tidak ada di
  allow-list (mis. 7) → `422 DURATION_NOT_ALLOWED`.
- Nominal di bawah min / di atas max → `422 AMOUNT_NOT_ALLOWED`; nol/negatif →
  `400`.
- Arah/timeframe tak dikenal → `400`; market tak dikenal → `404`.
- Market dipause → `422 MARKET_PAUSED`; market non-aktif tidak bisa ditradingkan.
- Tanpa sesi → `401`; trade milik pengguna lain → `404`.
- Batas trade terbuka dihormati setelah admin menurunkannya menjadi 1.
- Idempotensi: key sama + payload sama → trade sama, satu debit, `200` +
  `Idempotent-Replayed`; key sama + payload beda → `409`.

### Akun, sesi, keamanan

- Registrasi membuat dompet USD/IDR/USDT dengan saldo awal terkonfigurasi dan
  tautan verifikasi; email/username duplikat → `409` dengan kode berbeda;
  password pendek/email invalid → `400` dengan detail per field.
- Token verifikasi sekali pakai; token reset sekali pakai dan mencabut sesi
  lama (`token_version`); password lama berhenti bekerja.
- Lupa password menjawab identik untuk email tak dikenal (tanpa enumerasi).
- Login lewat email **atau** username; password salah → `401`; pengguna
  diblokir → `403` dan sesinya dicabut.
- Rate limit auth mengembalikan `429` setelah batas; lockout akun berfungsi.
- Logout menghapus cookie (`Max-Age=0`); daftar sesi bisa dilihat dan dicabut;
  “keluarkan perangkat lain” menyisakan sesi saat ini.
- Header Helmet ada (CSP, `nosniff`, tanpa `x-powered-by`); CORS hanya
  menggemakan origin yang diizinkan (plus same-host untuk proxy/preview) dan
  tidak pernah origin sembarang.
- Bearer token berfungsi sebagai alternatif cookie; token sampah → `401`.
- Admin: anonim → `401`, pengguna biasa → `403` di setiap rute admin; JWT dengan
  klaim `role: admin` tetapi tanda tangan salah → `401`; token valid non-admin →
  `403` (database adalah sumber kebenaran).
- Aksi admin (market, pengaturan, saldo, blokir, settlement manual) tercatat di
  audit beserta aktor, target, nilai sebelumnya, dan alasan; settlement manual
  tanpa alasan → `400`, dua kali → `409`.
- Upload: konten non-gambar ditolak, batas 512 KB berlaku, nama file diacak.
- Endpoint pembayaran memvalidasi payload lalu menjawab `501 NOT_AVAILABLE`.

### WebSocket

- `hello` mengumumkan market/timeframe dan `simulation: true`.
- `subscribe` mengirim snapshot lalu `tick`/`candle` live hanya untuk market
  tersebut; `candle_closed` muncul sekali per batas, tidak pernah di-throttle.
- `ping` → `pong`; JSON rusak → `INVALID_JSON` tanpa memutus socket; market/
  timeframe tak dikenal → `MARKET_NOT_FOUND`/`TIMEFRAME_NOT_SUPPORTED`.
- `resume` memutar ulang tick dengan `seq > lastSeq`; seq terlalu tua →
  `resync`.
- Socket terautentikasi menerima `trade:opened` dan push `balance`.
- Origin browser asing ditolak.

### UI browser (jsdom terhadap server nyata)

- Aplikasi boot, mengambil `/config`, `/account`, `/markets`, lalu merender
  layout trading: 3 market, canvas chart, 7 timeframe, BUY/SELL, tombol nominal
  cepat (½, ×2, min, maks), 12 preset durasi, pratinjau payout, dan label
  **SIMULASI**.
- Pindah market + tick server memperbarui harga live via WebSocket.
- Halaman login/daftar/lupa-password dirender dan navigasi tidak melempar error.
- Alur masuk: saldo demo tampil di header, BUY membuka dialog konfirmasi
  (market, harga entry, payout), konfirmasi membuat trade, dan trade muncul di
  daftar trade terbuka.
- Halaman staf: login sebagai `super_admin`, lalu `/account` (tab dompet),
  `/history` (filter bar), `/notifications`, dan `/admin` (navigasi dengan
  bagian Pengguna & Sistem) dirender tanpa error.
- Tidak ada error tak tertangani / unhandled rejection selama pengujian.

### Operasional (diverifikasi manual)

- `npm run build` lalu `npm start` dengan `NODE_ENV=production` dan rahasia
  nyata: `/healthz` 200, UI statis 200 (HTML/CSS/JS), registrasi → dompet,
  trade → settle setelah 5 s.
- `SIGTERM` menutup rapi (flush tick/candle, tutup socket) dan restart pada
  database yang sama, termasuk catch-up settlement.
- `npm run migrate` dan `npm run seed` idempoten.
- UI dijalankan lewat dev server (port 3000) dan diperiksa manual di browser;
  tangkapan layar tidak tersedia di sandbox ini.

## Beban WebSocket

`node test/load/ws-load.mjs 500 12` terhadap server lokal
(`PORT=3305`, database sementara, 3 market):

| Metrik                     | Hasil                      |
| -------------------------- | -------------------------- |
| Klien diminta / tersambung | 500 / **500**              |
| Error handshake/pesan      | **0**                      |
| Pesan diterima             | 122 000 (~**9 990/detik**) |
| Delay tick p50 / p95 / max | **36 ms / 67 ms / 71 ms**  |
| Waktu koneksi p50          | 161 ms                     |
| RSS server                 | 86 MB                      |

Server uji dihentikan setelah run; file `data/loadtest.sqlite*` dihapus.

## `npm audit`

```
3 vulnerabilities (1 moderate, 2 critical)
```

| Paket                     | Tingkat  | Jalur                  |
| ------------------------- | -------- | ---------------------- |
| `tinypool` ≤ 2.1.1        | critical | devDependency `vitest` |
| `@vitest/mocker` ≤ 4.1.11 | moderate | devDependency `vitest` |
| `vitest` ≤ 4.1.10         | —        | pembungkus keduanya    |

**Tidak ada kerentanan pada dependensi produksi** (`npm audit --omit=dev` → 0).
Ketiganya hanya aktif saat menjalankan tes, tidak dikirim ke runtime, dan
perbaikannya menuntut `vitest@5` (breaking) — tidak dilakukan di rilis ini agar
rangkaian 166 tes tetap stabil. Rencana: naikkan `vitest` ke 5.x pada rilis
berikutnya dan jalankan ulang seluruh suite.

## E2E Playwright — **belum dijalankan**

`playwright.config.ts` dan `e2e/smoke.spec.ts` selesai dan terdaftar:

```
npx playwright test --list   →  8 tes / 2 proyek (desktop Chrome, Pixel 7)
```

Skenario: (1) registrasi → buka trade → lihat hasil, (2) login akun seed,
(3) admin menambah market + logo lalu market tampil untuk pengguna, (4) trade
panel menjadi bottom sheet di mobile.

Menjalankan tes gagal karena browser tidak tersedia:

```
npx playwright install chromium  →  Download failure (sandbox tanpa akses CDN)
Error: browserType.launch: Executable doesn't exist …
```

Jadi **tidak ada** klaim bahwa E2E lulus. Jalankan di mesin dengan akses
internet:

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

## Keterbatasan & hal yang tidak diverifikasi

- **Tidak ada browser sungguhan** di sandbox. UI diverifikasi via jsdom dengan
  canvas 2D distub: DOM, alur data, dan WebSocket teruji, tetapi **tata letak,
  render canvas, dan CSS tidak diuji piksel**. Mohon dicek manual di browser.
- **`better-sqlite3` tidak pernah dieksekusi** di mesin ini (binding native
  tidak bisa diunduh/dikompilasi). Semua tes memakai `node:sqlite`. Jalur
  primer didokumentasikan dan SQL-nya sama, tetapi perlu smoke test di host
  target.
- **Playwright E2E** dan **tangkapan layar desktop/mobile** belum dijalankan
  (butuh browser).
- Tidak ada fuzzing, uji soak jangka panjang, atau uji multi-proses (SQLite
  satu penulis).
- Email tetap dev mailer (tautan dicetak di log); tidak ada SMTP/API provider.
- Pembayaran adalah stub by design — tidak ada yang diuji karena tidak ada yang
  diimplementasikan.
- Tampilan tanggal mengikuti locale browser; tes tidak mengunci format tanggal.
- Rate limit di sebagian tes dinaikkan agar cepat; tes khusus rate limit
  mengaktifkannya kembali.

## Cara mereproduksi

```bash
npm ci --ignore-scripts
npm run typecheck
npx eslint .
npx vitest run
npm run build
npm audit --omit=dev
node test/load/ws-load.mjs 500 12   # butuh server berjalan di WS_URL
```

Tes memakai file SQLite sementara, jam palsu, tanpa timer latar, dan tanpa
akses jaringan selain loopback.
