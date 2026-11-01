# Build & uji TryDesk untuk macOS

TryDesk untuk macOS hanya untuk **mengontrol PC Windows** (sama seperti versi Linux dan Android), butuh macOS 13 Ventura atau lebih baru. Tidak perlu akun Apple Developer: pengguna menjalankan satu perintah Terminal sebelum membukanya.

**Sejak 1 Nov 2026 rilis tidak butuh Mac:** `scripts\buat-rilis.ps1` membuat kedua zip Mac di WSL (`scripts/build-mac-wsl.sh`), sama seperti versi Linux. Panduan di bawah tetap berguna untuk membuat zip di Mac sungguhan (tanda tangan ad-hoc penuh) dan untuk daftar uji bila ada Mac yang bisa dipinjam.

## 1. Siapkan kode (di PC Windows)

1. Pastikan versi di `package.json` sudah benar (mis. `1.3.0`).
2. Buat zip source:
   ```
   powershell -ExecutionPolicy Bypass -File .\scripts\pack-source.ps1
   ```
   Hasilnya `rilis\filezilla-website\source\TryDesk-Source-<versi>.zip`.
3. Kirim zip itu ke Mac (AirDrop, Google Drive, flashdisk).

## 2. Build (di Mac)

1. Pasang **Node.js LTS** dari <https://nodejs.org> (pilih *macOS Installer .pkg*). Cukup sekali.
2. Klik dua kali zip source di Finder supaya terekstrak.
3. Buka **Terminal** (Launchpad → ketik Terminal), lalu:
   ```
   cd ~/Downloads/TryDesk-Source-1.3.0
   bash scripts/build-mac.sh
   ```
   Sesuaikan nama folder bila berbeda. Butuh internet dan ±5–10 menit.
4. Bila berhasil, baris terakhir menulis "Selesai" dan menampilkan dua file:
   - `dist/TryDesk-<versi>-mac-arm64.zip`: Mac Apple Silicon (M1 dan lebih baru)
   - `dist/TryDesk-<versi>-mac-x64.zip`: Mac Intel

   Bila muncul tulisan **GAGAL**, kirim seluruh isi Terminal ke Claude.

## 3. Pasang seperti pengguna biasa (di Mac)

1. Buka zip yang sesuai chip Mac itu (Menu Apple → Tentang Mac Ini: "Chip Apple M…" = arm64, "Prosesor Intel" = x64).
2. Seret **TryDesk.app** ke folder **Applications**.
3. Di Terminal: `xattr -cr /Applications/TryDesk.app`
4. Buka TryDesk dari Applications. Bila masih ditolak atau disebut "rusak": `codesign --force --deep --sign - /Applications/TryDesk.app`, lalu buka lagi.

## 4. Daftar uji

Uji keyboard **langsung di Mac** (bukan lewat remote ke Mac itu): tombol yang melewati dua lapis remote tidak bisa dipercaya hasilnya.

| # | Langkah | Hasil yang benar | ✓ |
|---|---|---|---|
| 1 | Buka TryDesk | Jendela terbuka, ID tampil, ada tulisan "TryDesk untuk macOS hanya bisa mengontrol PC Windows" | |
| 2 | Salin sebuah ID, klik kolom ID Remote, tekan Cmd+V | ID tertempel (menu Edit Mac bekerja) | |
| 3 | Sambung ke PC Windows dengan ID + password akses | Layar PC tampil, tanpa perlu klik Terima | |
| 4 | Gerakkan mouse, klik, seret jendela, scroll dua jari di trackpad | Semua sesuai di PC | |
| 5 | Buka Notepad di PC, ketik beberapa kalimat | Huruf muncul benar, termasuk spasi dan Enter | |
| 6 | Pilih teks di Notepad, Cmd+C lalu Cmd+V | Teks tersalin dan tertempel (Cmd dikirim sebagai Ctrl) | |
| 7 | Setelah Cmd+C, ketik "abc" | Muncul "abc" biasa: tidak ada huruf C yang tertahan | |
| 8 | Cmd+Z di Notepad | Batal ketik (undo) | |
| 9 | Option+F4 (atau Control Center → Fitur lainnya → Kombinasi tombol → Alt+F4) | Jendela Notepad tertutup | |
| 10 | Salin teks di Mac, tempel di PC (dan sebaliknya) | Clipboard tersinkron | |
| 11 | Control Center → Fitur lainnya → Transfer file: kirim file Mac → PC dan PC → Mac | File sampai utuh | |
| 12 | Control Center → Layar penuh, lalu keluar lagi | Layar penuh dan kembali normal | |
| 13 | Saat sesi berjalan tekan Cmd+Q | TryDesk bertanya dulu sebelum keluar | |
| 14 | Klik tombol tutup jendela, lalu klik ikon TryDesk di Dock | Jendela muncul kembali | |
| 15 | Pengaturan → Bahasa → English | Semua teks jadi bahasa Inggris | |
| 16 | Sambung lewat IP (PC tujuan di jaringan yang sama) | macOS meminta izin jaringan lokal; setelah diizinkan, tersambung | |
| 17 | Coba sambung DARI PC lain KE Mac ini | Ditolak dengan pesan "memakai TryDesk untuk macOS, yang hanya bisa mengontrol PC Windows" | |

Catat nomor yang gagal beserta apa yang terjadi, lalu kirim ke Claude sebelum rilis.

## 5. Kembalikan hasil build ke PC Windows

Salin kedua file `.zip` ke folder `rilis\filezilla-website\downloads\mac\` di PC Windows, lalu jalankan `scripts\buat-rilis.ps1` seperti biasa. Rilis berhenti di awal bila kedua file itu belum ada, dan audit akhir (`scripts\audit-rilis.mjs`) memeriksa link, SHA-256, dan versinya sebelum Anda upload.
