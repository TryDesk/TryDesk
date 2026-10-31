# TryDesk

Remote desktop P2P: buka app, bagikan ID 9 digit, pihak lain masukkan ID → Connect.

## Cara kerja

```
 PC A (dikontrol)              VPS (trydesk.ai.id)                  PC B (mengontrol)
 TryDesk ──────wss──────►  desk.trydesk.ai.id  (daftar ID, jabat tangan) ◄──wss── TryDesk
        │                  turn.trydesk.ai.id  (relay cadangan)                  │
        └────────── WebRTC terenkripsi: layar + mouse/keyboard ──────────────────┘
                    langsung P2P, atau lewat TURN jika jaringan memblokir
```

Server hanya mempertemukan ID; data mengalir langsung antar PC, dan memakai relay hanya bila perlu.

## Deploy server ke VPS (Ubuntu)

### 1. DNS (zona trydesk.ai.id)
Tambahkan dua record **A** yang mengarah ke IP publik VPS, dengan **Proxy status = DNS only (awan abu-abu)** bila memakai Cloudflare:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `desk` | IP VPS | DNS only |
| A | `turn` | IP VPS | DNS only |

Kenapa tidak di-proxy? Cloudflare tidak meneruskan UDP (TURN wajib UDP), dan sertifikat HTTPS dibuat otomatis oleh Caddy di VPS.

### 2. Upload ke VPS (dari PowerShell di folder project)
```powershell
scp -r server deploy root@IP_VPS:/opt/trydesk/
```

### 3. Jalankan setup di VPS
```bash
ssh root@IP_VPS
cd /opt/trydesk/deploy && sudo -E bash setup.sh
```
Script ini: install Docker → cek DNS → buat secret TURN → firewall (port SSH tetap dibuka) → jalankan Caddy (HTTPS) + signaling server + coturn.
Berhasil jika muncul `SELESAI. Server online: wss://desk.trydesk.ai.id`.

Jika firewall di panel provider diaktifkan, buka juga: TCP 80, 443, 8443 dan UDP 8443, 49160–49260.

TURN memakai port **8443** (bukan standar 3478), karena banyak ISP di Indonesia memblokir 3478–3479.
Port bisa diganti: `TURN_PORT=xxxx sudo -E bash setup.sh`. App tidak perlu di-build ulang, karena alamat TURN dikirim oleh server.

### Perintah berguna di VPS
```bash
cd /opt/trydesk/deploy
docker compose ps              # status
docker compose logs -f         # log semua layanan
docker compose restart         # restart
docker compose up -d --build   # setelah update file server/
```

### Migrasi ke VPS lain
1. Di VPS lama: `docker run --rm -v deploy_signaling_data:/d -v /opt/trydesk:/b alpine cp /d/owners.json /b/` (cadangan daftar ID).
2. Salin folder `/opt/trydesk` (termasuk `deploy/.env` agar secret sama) ke VPS baru.
3. Ganti IP record `desk` dan `turn` ke IP VPS baru, lalu jalankan `sudo -E bash setup.sh`.
4. Kembalikan daftar ID: `docker compose cp ../owners.json signaling:/data/owners.json && docker compose restart signaling`.

App client **tidak perlu di-build ulang**, karena tetap memakai `desk.trydesk.ai.id`.

## Pemakaian

| Mau apa | Langkah |
|---|---|
| Dikontrol (diawasi) | Bagikan ID kamu. Saat ada permintaan, klik **Accept**. |
| Dikontrol tanpa ditunggui | Isi **Password akses tanpa konfirmasi** (min. 6 karakter). Yang tahu password bisa langsung masuk. |
| Mengontrol PC lain | Masukkan ID remote (+ password jika ada) → **Connect**. |
| Sambung lewat IP (LAN, tanpa internet) | Di PC tujuan: **Pengaturan → Koneksi → Izinkan koneksi langsung dari jaringan lokal** + password akses (wajib). Di PC/HP yang mengontrol: ketik IP-nya (mis. `192.168.1.20`) di kolom ID → **Connect**. Port TCP 7171; Windows meminta izin firewall sekali. |

- ID tersimpan permanen per perangkat. Butuh ID baru (mis. ID lama bocor)? Klik tombol **refresh** di samping ID untuk **membuat ID baru** — ID lama langsung tidak berlaku, jadi kontak yang menyimpannya perlu diberi ID baru.
- Selama dikontrol, PC host menampilkan "Sesi remote aktif" + tombol **Putuskan**.
- Alamat server sudah tetap (`wss://desk.trydesk.ai.id`) dan tidak bisa diubah dari UI, demi keamanan.
- Bahasa aplikasi (Indonesia / English) mengikuti bahasa Windows sampai kamu memilihnya di **Pengaturan → Umum → Bahasa antarmuka**. Pesan dari PC remote dan server ikut tampil dalam bahasa pilihanmu.

**Dari HP (Android):** pasang `TryDesk-Android-<versi>.apk` (Android 7.0+), masukkan ID PC → **Hubungkan**. HP hanya bisa mengontrol PC, tidak bisa dikontrol. Gerakan: geser = gerakkan kursor (mode touchpad) · ketuk = klik · tahan lalu geser = seret · 2 jari geser = scroll · ketuk 2 jari = klik kanan · cubit = zoom. Tombol keyboard membuka keyboard HP; tombol **T** membuka Esc/Tab/Ctrl/Alt/Win/panah/F1–F12 (Ctrl/Alt/Shift/Win menempel ke tombol berikutnya). Tombol tangan mengganti ke mode **sentuh langsung**. Tombol Kembali Android menutup menu, lalu menawarkan putus koneksi.

Di Windows Sandbox dan VM Hyper-V, TryDesk otomatis berjalan tanpa akselerasi GPU: capture layar lewat GPU virtual (GPU-PV) bisa mematikan seluruh VM. Pada PC biasa GPU tetap dipakai. Paksa GPU dengan argumen `--force-gpu`.

## Fitur saat sesi berjalan (Control Center)

- **Kualitas** (panel kanan):
  - Preset: Hemat / Seimbang / Kualitas / Ultra / Gaming / Maksimal
  - Slider **bitrate 1–1000 Mbps** (berubah langsung, tanpa sambung ulang)
  - Frame rate 30/60/120/144/165/180/240 (sampai 240 FPS; tergantung spek & refresh-rate PC), Resolusi Asli/1080p/720p/480p
  - Codec AV1/VP9/VP8/H.264 (ganti = renegosiasi sesaat)
  - Overlay statistik: bitrate, FPS, latency, packet loss, resolusi, jalur (P2P/relay), codec
- **File**: kirim file dua arah, streaming + progress, penerima klik Terima/Tolak dan pilih lokasi simpan.
- **Clipboard**: teks tersinkron otomatis dua arah (bisa dimatikan di panel Kualitas).
- **Monitor**: pemilih muncul bila remote punya >1 layar; ganti monitor tanpa putus. Bila sebuah monitor tak terbaca oleh capturer bawaan Windows (mis. HDR aktif / monitor di GPU lain), TryDesk otomatis restart sekali memakai Windows Graphics Capture.
- **Audio**: dengarkan suara sistem PC remote (jika tersedia).
- **Chat**: obrolan teks dua arah dalam sesi (juga dari layar host).
- **Tombol**: kirim kombinasi — Alt+Tab, Win, Win+D, Win+E, Ctrl+Esc, Alt+F4, PrintScreen.*
- **Screenshot**: ambil frame remote → simpan PNG.
- **Lihat saja**: nonaktifkan kontrol (hanya menonton).
- **Layar hitam** & **Kunci input**: privasi host saat maintenance. Kunci input butuh TryDesk host berjalan sebagai administrator dan selalu bisa dilepas dengan Ctrl+Alt+Del; keduanya ditolak bila host memakai mode lihat saja.
- **Rekam sesi**: pilih lokasi file dulu, lalu rekaman ditulis langsung ke disk (.webm) selama sesi berjalan.

\* Ctrl+Alt+Del tidak ada di daftar: Windows menolak Ctrl+Alt+Del yang disuntik aplikasi (secure attention sequence).

## Izin & pengaturan host (Pengaturan)
- **Izin akses**: kontrol keyboard & mouse, transfer file, clipboard, atau lihat saja. Mode lihat saja / kontrol mati juga menutup akses file & clipboard; dialog Terima menampilkan izin yang berlaku, dan viewer diberi tahu.
- **Password akses**: yang tahu password langsung masuk (kecuali "Auto-accept" dimatikan); tanpa password tetap muncul dialog Terima; 3x salah memblokir peminta itu 5–20 menit.
- **Koneksi**: waktu tunggu, mulai saat Windows start, batas bandwidth upload, protokol (otomatis / P2P saja / relay saja), cegah layar mati saat dikontrol.
- **Keamanan sesi**: kunci Windows setelah sesi berakhir, batas waktu sesi.
- **Tampilan & audio**: kualitas / codec / skala bawaan untuk tab baru, statistik otomatis, audio otomatis & volume.
- **Lanjutan**: akselerasi GPU (berlaku setelah restart), reset pengaturan (ID, favorit, riwayat tetap).
- **Discord**: status di profil Discord bisa dimatikan di Umum.

## Development
```bash
npm install
npm run server          # server lokal ws://localhost:9100
npm start
npm run build:portable  # dist/TryDesk-Portable.exe
```
