# Panduan Admin

Panduan operasi untuk staf. Semua tindakan di sini hanya menyentuh **parameter
simulasi** dan data demo — tidak ada uang nyata, tidak ada deposit/penarikan,
dan tidak ada cara mengubah hasil trade tanpa jejak.

- URL: `/admin` (butuh sesi staf: `users.staff_role` terisi)
- Akun seed: `admin@simtrade.local` / `admin-demo-123` (super_admin)
- Bahasa antarmuka mengikuti preferensi akun (id default)

## 0. Prinsip yang tidak boleh dilanggar

1. **Hasil trade ditentukan server** dari harga yang sudah terekam. Tidak ada
   tombol “buat user menang”. Satu-satunya override adalah _settlement manual_
   untuk koreksi, dan itu wajib beralasan, tercatat di audit, dan muncul di
   riwayat pengguna.
2. **Semua perubahan parameter diaudit** dan tampil di riwayat market yang
   **publik** (`/api/v1/markets/:symbol/history`). Anggap setiap perubahan
   simulasi akan dibaca pengguna.
3. **Saldo hanya virtual.** “Set saldo” adalah alat demo; selalu isi alasan.
4. **Jangan** menambahkan deposit/penarikan/payment gateway ke build ini.

## 1. Peran & izin

Empat peran staf, dicek di server pada setiap endpoint (UI hanya
menyembunyikan menu):

| Izin                                     | super_admin | operator | support | viewer |
| ---------------------------------------- | :---------: | :------: | :-----: | :----: |
| `dashboard.read`                         |      ✓      |    ✓     |    ✓    |   ✓    |
| `markets.read`                           |      ✓      |    ✓     |    ✓    |   ✓    |
| `markets.write`                          |      ✓      |    ✓     |    —    |   —    |
| `markets.simulate`                       |      ✓      |    ✓     |    —    |   —    |
| `trades.read` / `trades.export`          |      ✓      |    ✓     |    ✓    |   —    |
| `trades.settle`                          |      ✓      |    ✓     |    —    |   —    |
| `users.read`                             |      ✓      |    ✓     |    ✓    |   ✓    |
| `users.support` (blokir, reset, catatan) |      ✓      |    —     |    ✓    |   —    |
| `users.balance`                          |      ✓      |    —     |    ✓    |   —    |
| `users.role`                             |      ✓      |    —     |    —    |   —    |
| `finance.read`                           |      ✓      |    ✓     |    ✓    |   ✓    |
| `finance.write` (FX)                     |      ✓      |    —     |    —    |   —    |
| `settings.read`                          |      ✓      |    ✓     |    ✓    |   ✓    |
| `settings.write`                         |      ✓      |    —     |    —    |   —    |
| `content.read` / `content.write`         |      ✓      |  ✓ / ✓   |  ✓ / —  | ✓ / —  |
| `system.read`                            |      ✓      |    —     |    —    |   ✓    |
| `system.write` (job, backup)             |      ✓      |    —     |    —    |   —    |
| `audit.read`                             |      ✓      |    —     |    ✓    |   ✓    |
| `payments.read`                          |      ✓      |    ✓     |    ✓    |   ✓    |

Matriks hidup ada di **Admin → Peran & izin** dan di
`GET /api/v1/admin/permissions`.

## 2. Dasbor

Kartu: pengguna, trade hari ini, volume, payout, market live, alert sistem.
Grafik batang per jam (jumlah trade) dan per hari (volume). Bagian bawah:
market live dengan harga/pause, aktivitas terbaru (audit), dan alert
(job gagal, market tanpa harga, backup terakhir).

Yang perlu dicek rutin: apakah semua market punya harga (`tanpa harga = 0`),
job `settlement` berstatus `ok`, dan tidak ada alert merah.

## 3. Market

### Membuat market

**Market → Tambah market.** Field:

| Field                   | Aturan                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| Symbol                  | `A–Z 0–9 _`, 2–20 karakter, unik, tidak bisa diubah setelah dibuat |
| Nama / deskripsi        | teks; nama tampil di UI                                            |
| Kategori                | `index`, `crypto`, `forex`, `komoditas`, `lainnya`                 |
| Logo                    | PNG/JPG/WEBP/SVG ≤ 512 KB (divalidasi magic bytes, nama acak)      |
| Harga awal              | > 0                                                                |
| Desimal & tick size     | mis. 5 desimal, tick `0.0001`                                      |
| Volatilitas             | `rendah` (×0.5) · `sedang` (×1) · `tinggi` (×1.8) · `ekstrem` (×3) |
| Mood                    | `sepi` · `normal` · `cepat` · `liar`                               |
| Jam trading             | zona Asia/Jakarta, bisa lintas tengah malam                        |
| Min / max stake (USD)   | min ≥ 0, max ≥ min                                                 |
| Payout override         | 0–3, kosong = default global (85 %)                                |
| Urutan, unggulan, aktif | tampilan di daftar pengguna                                        |

Saat dibuat, server menghasilkan **bootstrap tick + candle** untuk semua
timeframe sehingga chart tidak kosong. “Aktifkan langsung” vs simpan sebagai
draf (`draft`).

Pratinjau: **Market → Pratinjau chart** (`POST /admin/markets/preview`)
mengembalikan deret harga dengan parameter yang dipilih sebelum disimpan.

### Mengubah market

- Nama, deskripsi, logo, limit, payout override, urutan, unggulan, status, jam.
- **Mengubah harga awal tidak mengubah trade yang sedang berjalan**: trade
  memakai `entry_price` yang tersimpan. UI menampilkan peringatan dan aksi
  dicatat di audit + riwayat.
- Soft delete ditolak (`409 MARKET_HAS_OPEN_TRADES`) selama ada trade terbuka;
  market terhapus bisa dipulihkan (`restore`).

### Mengontrol simulasi

**Market → Simulasi** mengirim `POST /admin/markets/:symbol/simulate`:

```
trend: up | down | neutral      trendStrength: 1–10
volatilityPreset: rendah | sedang | tinggi | ekstrem
mood: sepi | normal | cepat | liar
paused: true | false
```

- Perubahan berlaku **pada tick berikutnya**, tidak mengubah riwayat.
- Setiap simpan menulis `audit_log` + `market_param_history` (before/after).
- Tombol **Reset** mengembalikan parameter ke default market dan melanjutkan
  harga dari harga saat ini (bukan mengulang dari harga awal).

## 4. Trade

- Filter: status, market, hasil, rentang tanggal, pengguna.
- Detail trade: harga entry/close, waktu, durasi, payout, siapa yang
  menyelesaikan (`expiry` atau `admin`), alasan bila manual.
- **Ekspor CSV** (izin `trades.export`).
- **Statistik**: per market dan per durasi (jumlah, volume, payout, win rate).
- **Settlement manual** (`trades.settle`): isi alasan ≥ 5 karakter, opsional
  harga close. Akibatnya: saldo disesuaikan dalam satu transaksi + ledger,
  audit `admin.trade_settled`, notifikasi ke pengguna, dan trade terlihat
  “diselesaikan admin” di riwayat pengguna. Tidak bisa dua kali
  (`409 TRADE_ALREADY_SETTLED`).

Gunakan settlement manual hanya untuk koreksi (mis. tick hilang), bukan untuk
mengatur hasil.

## 5. Pengguna

- Pencarian berdasarkan email/username; filter peran/status.
- Detail: profil, dompet + saldo, trade terakhir, riwayat login, sesi aktif,
  catatan internal, audit terkait.
- **Set saldo** (`users.balance`): mode `add`/`set`, mata uang, nominal,
  **alasan wajib**. Masuk ledger + audit.
- **Blokir / buka blokir** (`users.support`): alasan wajib; blokir langsung
  mencabut semua sesi pengguna.
- **Force logout**: cabut semua sesi tanpa memblokir.
- **Kirim reset password**: membuat token sekali pakai (di dev, tautan muncul
  di log).
- **Ubah peran** (`users.role`, hanya `super_admin`): `viewer → support →
operator → super_admin` atau kembali ke pengguna biasa. Tidak bisa menurunkan
  super_admin terakhir.
- **Catatan** internal (tidak terlihat pengguna).

## 6. Keuangan demo

- Total saldo per mata uang, total hold trade terbuka, payout hari ini.
- **FX**: ubah kurs demo (`finance.write`); setiap perubahan tercatat di
  riwayat FX dan audit. Perubahan kurs tidak mengubah trade yang sudah dibuka.
- Cap top-up harian & cooldown reset saldo (mengikuti `settings`).
- Laporan ringkas: top-up, konversi, reset saldo per hari.

Ingat: semua angka ini virtual. Tidak ada rekonsiliasi dengan uang nyata.

## 7. Pengaturan

`settings.write` (super_admin). Grup:

| Grup       | Isi                                                                   |
| ---------- | --------------------------------------------------------------------- |
| Payout     | rate default 0–1, mode `profit`/`total`, override per durasi          |
| Durasi     | daftar durasi diizinkan, min/max (5–28 800 detik)                     |
| Limit      | maksimum trade terbuka per pengguna, nominal global (USD), cap top-up |
| Eksposur   | batas eksposur per market                                             |
| Rate limit | percobaan login, permintaan trade per menit                           |
| Retensi    | hari penyimpanan tick & candle                                        |
| Branding   | nama platform, warna aksen, logo                                      |
| Legal      | teks disclaimer, syarat & ketentuan                                   |
| Lokal      | bahasa default (`id`/`en`), zona waktu                                |

Validasi lintas field: `min ≤ max`, durasi pada daftar, payout 0–1; pelanggaran
→ `400 VALIDATION_ERROR` dengan alasan (bukan 500).

## 8. Konten

- **Banner** terjadwal: judul, isi, tautan, warna, `startAt`/`endAt`, aktif.
  Muncul di halaman pengguna selama jadwal.
- **Halaman** (`faq`, `terms`, `privacy`, `contact`): editor teks + pratinjau.
  Konten di-escape saat dirender; jangan menempel HTML mentah.

## 9. Sistem

- **Health**: DB, koneksi WS, status job, versi, uptime.
- **Job**: lihat `job_runs` (terakhir/sukses/gagal) dan jalankan manual
  (`settlement`, `engine`, `cleanup`, `backup`).
- **Backup**: daftar file SQLite, unduh, hapus; buat backup sekarang. Backup
  dijalankan otomatis tiap 6 jam (dapat diatur).
- **Log**: filter level/waktu/kata kunci (buffer memori, sudah diredaksi).
- **Audit**: filter aktor/aksi/target/waktu, ekspor CSV. Setiap perubahan
  admin muncul di sini — ini sumber kebenaran saat investigasi.

## 10. Pembayaran

Halaman placeholder: “belum tersedia / Segera hadir”. Tidak ada provider,
kredensial, atau endpoint aktif. `POST /payments/deposit|withdraw` selalu
`501 NOT_AVAILABLE`. Jangan mengaktifkan tanpa keputusan bisnis + izin hukum.

## 11. Runbook singkat

| Gejala                    | Tindakan                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Chart market kosong       | Cek job `engine` & log; jalankan `engine` manual; cek `paused`                                        |
| Trade tidak settle        | Cek job `settlement`, `SETTLE_INTERVAL_MS`, jam server; trade kedaluwarsa akan diselesaikan saat boot |
| Pengguna “saldo hilang”   | Lihat ledger + trade terbuka; hold memang mengurangi saldo sampai settle                              |
| Perlu koreksi hasil       | Settlement manual + alasan jelas; catat di tiket                                                      |
| Backup gagal              | Cek `BACKUP_DIR` & izin tulis; jalankan backup manual                                                 |
| Market harus berhenti     | `paused: true` (bukan hapus) agar riwayat tetap                                                       |
| Kecurigaan penyalahgunaan | Blokir pengguna (mencabut sesi) + catatan + audit                                                     |
