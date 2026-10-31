let config = null;
let _gameActive = false;   // native game-mouse capture engaged (declared early — refreshKeyCapture reads it)
let serverUrl = "";
let ws = null;
let myId = null;
let _regenPending = false;   // true while a user-initiated ID regeneration is reconnecting
let _adminTipShown = false;  // one-time "run as admin" hint when hosting without elevation
let serverIceServers = [];
let reconnectTimer = null;

// ─── Host-side state (single session: a host is controlled by exactly one viewer) ───
let hostCaptureHeight = 0;        // host side native capture height
let hostCaptureFps = 60;          // host side current capture frame-rate cap
let hostQuality = { bitrate: 80, fps: 60, resHeight: 0 };
let acceptPending = false;        // an accept dialog is currently open for an incoming request
let acceptTimerHandle = null;
let acceptDlgCancel = null;       // cancels that dialog (resolves it false) if the session ends
let acceptDlgSettle = null;       // settles it either way (a correct password typed meanwhile → true)
let acceptFromId = null;          // who that dialog is for (so their request-cancelled closes it)
let hostingStartTime = null;
let hostingTimerHandle = null;

// ─── App-wide settings (shared across all tabs) ───
let clipboardSync = true;
let autoReconnect = false;
let scaleMode = "fit";            // view scale of the ACTIVE tab (kept in sync with active.scaleMode)

const CHUNK = 64 * 1024;
const BUFFER_HIGH = 8 * 1024 * 1024;

// Quality template — a new viewer tab clones this; editing quality in a tab updates that live
// tab and persists here as the default for the next tab.
const DEFAULT_QUALITY = { bitrate: 80, fps: 60, resHeight: 0, codec: "auto" };
let defaultQuality = { ...DEFAULT_QUALITY };

// ═══════════════════════════════════════════════════════════
//  Per-session state — one Session per remote tab (viewer side)
//  plus one for the host role. Every connection-bound value lives
//  here so multiple remote tabs stay fully independent.
// ═══════════════════════════════════════════════════════════
let sessionSeq = 0;
class Session {
  constructor(peerId, role) {
    this.sid = `s${++sessionSeq}`;
    this.peerId = peerId;
    this.role = role;                 // "viewer" | "host"
    this.pc = null;
    this.dataChannel = null;
    this.fileChannel = null;
    this.localStream = null;          // host only
    this.videoTransceiver = null;     // viewer only
    this.videoTrack = null;           // host only
    this.pendingCandidates = [];
    // display / quality
    this.monitors = [];
    this.currentMonitor = 0;
    this.capChain = Promise.resolve();   // host only: serializes capture swaps (see replaceCaptureTrack)
    this.audioAvailable = false;
    this.audioOn = role === "viewer" && prefGet("autoAudio");          // Settings → Audio → play remote audio automatically
    this.quality = { ...defaultQuality };
    this.scaleMode = role === "viewer" ? prefGet("defScale") : "fit"; // Settings → Tampilan → default scale
    this.viewOnly = false;
    this.blackScreenActive = false;
    this.inputLocked = false;
    // clipboard
    this.clipTimer = null;
    this.lastClipboard = "";
    // stats / timers
    this.statsTimer = null;
    this.statsLast = { bytes: 0, ts: 0 };
    this.disconnectTimer = null;
    this.reconnectAttempts = 0;
    this.sessionTimer = null;
    this.sessionStart = 0;
    this.latencyText = "- ms";
    this.timerText = "00:00";
    // file transfer + file manager (per session)
    this.activeSend = null;
    this.activeRecv = null;
    this.acceptResolver = null;
    this.mgrGetAck = null;
    this.fsPending = new Map();
    this.fsReqSeq = 0;
    this.fm = {
      local:  { path: null, display: "", parent: null, isRoot: false, entries: [], sel: new Set(), sort: { key: "name", asc: true } },
      remote: { path: null, display: "", parent: null, isRoot: false, entries: [], sel: new Set(), sort: { key: "name", asc: true } },
    };
    this.fmQueue = [];
    this.fmQueueSeq = 0;
    this.fmRunning = false;
    // chat (per peer)
    this.chatLog = [];
    this.chatUnread = false;
    // video element (viewer only) — created lazily by ensureVideo()
    this.video = null;
    this.hasFrame = false;
    this.label = peerId;              // tab label (updated to monitor name when known)
  }
}

// Viewer tabs, keyed by peerId (the remote being controlled). Insertion order = tab order.
const sessions = new Map();
let active = null;      // active viewer Session (its UI is shown) or null
let host = null;        // the single host Session (we are being controlled) or null

function viewerSessions() { return [...sessions.values()]; }

const PRESETS = {
  hemat:    { bitrate: 3,   fps: 15, resHeight: 720 },
  seimbang: { bitrate: 20,  fps: 30, resHeight: 0 },
  kualitas: { bitrate: 60,  fps: 60, resHeight: 0 },
  ultra:    { bitrate: 150, fps: 120, resHeight: 0 },
  gaming:   { bitrate: 300, fps: 165, resHeight: 0 },
  maksimal: { bitrate: 500, fps: 240, resHeight: 0 },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const myIdText = $(".id-text");
// Show a 9-digit TryDesk ID as "xxx xxx xxx" so it reads as an ID, not a raw number.
function fmtId(id) {
  // LAN peers ("lan:192.168.1.20", "lan-in:192.168.1.5#3") show their address.
  if (typeof id === "string" && /^lan(-in)?:/.test(id)) return id.replace(/^lan(-in)?:/, "").replace(/#\d+$/, "") + " (LAN)";
  const d = String(id == null ? "" : id).replace(/\s/g, "");
  return /^\d{9}$/.test(d) ? d.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3") : String(id == null ? "" : id);
}
const statusDot = $("#status-dot");
const statusText = $("#status-text");
const remoteIdInput = $("#remote-id");
const remotePasswordInput = $("#remote-password");
const accessPassword = $("#access-password");
const overlaySettings = $("#overlay-settings");
const qualityPanel = $("#quality-panel");
const statsOverlay = $("#stats-overlay");

// The active tab's <video> (per-session). Null on home/hosting screens.
function activeVideo() { return active ? active.video : null; }
// Create (once) the <video> element that renders a viewer session's remote screen.
function ensureVideo(sess) {
  if (sess.video) return sess.video;
  const v = document.createElement("video");
  v.className = "remote-video";
  v.tabIndex = 0;
  v.autoplay = true; v.playsInline = true; v.muted = true;
  v.addEventListener("loadedmetadata", () => { if (sess === active) applyScale(); });
  v.addEventListener("resize", () => {
    if (sess === active) applyScale();
    // NOTE: do NOT dim here. WebRTC continuously adjusts the encoded resolution to match the
    // bandwidth estimate (especially while BWE settles in the first seconds, and under any
    // bitrate cap) — each adjustment fires "resize". Dimming on every one of those produced the
    // periodic flicker users saw even on a fast link. A user-initiated monitor switch is masked by
    // the local monitor-switch handler instead.
  });
  v.addEventListener("playing", () => {
    sess.hasFrame = true; if (sess === active) $("#remote-loading")?.classList.add("hidden");
    // Recent-tile thumbnail: once the picture has settled (refreshed again when the session ends)
    if (sess.role === "viewer" && !sess.thumbTimer) sess.thumbTimer = setTimeout(() => saveThumb(sess), 4000);
  });
  v.addEventListener("loadeddata", () => { if (v.videoWidth) { sess.hasFrame = true; if (sess === active) $("#remote-loading")?.classList.add("hidden"); } });
  $("#video-wrap").appendChild(v);
  sess.video = v;
  return v;
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, val) { try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch {} },
};

// ─── i18n (ID / EN) ───────────────────────────────────────
let lang = "id";
const I18N = {
  id: {
    // dynamic / toasts
    fav_added: "Ditambahkan ke favorit", fav_removed: "Dihapus dari favorit",
    fav_add_tip: "Tambah ke favorit", fav_remove_tip: "Hapus dari favorit",
    connecting_server: "Menghubungkan ke server...", connected_server: "Terhubung ke server",
    server_disconnected: "Terputus dari server", id_copied: "ID disalin!",
    reconnecting: "Koneksi terputus, mencoba sambung ulang...", reconnect_failed: "Gagal menyambung ulang",
    alias_saved: "Alias disimpan", alias_removed: "Alias dihapus",
    lang_changed: "Bahasa diubah ke Indonesia",
    delete_tip: "Hapus dari riwayat",
    time_now: "Baru saja", time_min: "menit lalu", time_hour: "jam lalu", time_day: "hari lalu",
    id_regenerated: "ID baru berhasil dibuat", ui_regen_id_title: "Buat ID baru", regen_failed: "Gagal membuat ID baru",
    regen_confirm_title: "Buat ID baru?", regen_confirm_ok: "Ya, buat ID baru", regen_confirm_cancel: "Batal",
    regen_confirm_msg: "ID lama Anda akan berhenti berlaku.",
    regen_confirm_detail: "Semua orang yang menyimpan ID lama Anda tidak akan bisa terhubung lagi — mereka harus diberi ID yang baru. Sesi yang sedang aktif akan terputus.",
  },
  en: {
    // static UI (data-i18n)
    ui_desktop_this: "This Desktop", ui_your_id: "Your ID",
    ui_id_note: "Share this ID so others can connect to your desktop",
    ui_remote_desktop: "Remote Desktop", ui_remote_id: "Remote ID",
    ui_favorites: "Favorites", ui_recent: "Recent Connections",
    ui_connect: "Connect", ui_settings: "Settings", ui_general: "General",
    ui_connection: "Connection", ui_security: "Security", ui_display: "Display",
    ui_audio: "Audio", ui_advanced: "Advanced", ui_language: "Interface language",
    ui_theme: "Theme", ui_device_alias: "Device alias", ui_save: "Save",
    ui_notifications: "Notifications", ui_cancel: "Cancel", ui_disconnect: "Disconnect",
    ui_quality: "Quality", ui_chat: "Chat", ui_keys: "Keys", ui_viewonly: "View only",
    ui_blackscreen: "Black screen", ui_lockinput: "Lock input", ui_file: "File",
    ui_session_active: "Remote Session Active", ui_being_controlled: "Your desktop is being controlled",
    ui_incoming: "Incoming Connection Request", ui_accept: "Accept", ui_reject: "Reject",
    ui_connecting: "Connecting", ui_send_file: "Send File",
    ui_sort_recent: "Most recent", ui_sort_id: "ID number", ui_clear_all: "Clear all",
    // placeholders
    ph_remote_id: "Enter an ID or IP address", ph_password: "Password (optional)",
    // dynamic / toasts
    fav_added: "Added to favorites", fav_removed: "Removed from favorites",
    fav_add_tip: "Add to favorites", fav_remove_tip: "Remove from favorites",
    connecting_server: "Connecting to server...", connected_server: "Connected to server",
    server_disconnected: "Disconnected from server", id_copied: "ID copied!",
    reconnecting: "Connection lost, reconnecting...", reconnect_failed: "Reconnect failed",
    alias_saved: "Alias saved", alias_removed: "Alias removed",
    lang_changed: "Language changed to English",
    delete_tip: "Remove from history",
    time_now: "Just now", time_min: "min ago", time_hour: "h ago", time_day: "d ago",
    id_regenerated: "New ID generated", ui_regen_id_title: "Generate new ID", regen_failed: "Failed to generate new ID",
    regen_confirm_title: "Generate a new ID?", regen_confirm_ok: "Yes, generate new ID", regen_confirm_cancel: "Cancel",
    regen_confirm_msg: "Your current ID will stop working.",
    regen_confirm_detail: "Anyone who saved your old ID won't be able to connect anymore — you'll need to give them the new one. Any active session will disconnect.",
  },
};
function t(key) {
  const l = I18N[lang] || I18N.id;
  return (key in l) ? l[key] : (I18N.id[key] != null ? I18N.id[key] : key);
}
function applyLanguage(l) {
  lang = (l === "en") ? "en" : "id";
  document.documentElement.setAttribute("lang", lang);
  // ID is the text authored in HTML; capture it once, then toggle to EN from the dictionary.
  $$("[data-i18n]").forEach((el) => {
    if (el._i18nId == null) el._i18nId = el.textContent;
    el.textContent = (lang === "en") ? t(el.getAttribute("data-i18n")) : el._i18nId;
  });
  $$("[data-i18n-ph]").forEach((el) => {
    if (el._i18nPhId == null) el._i18nPhId = el.placeholder;
    el.placeholder = (lang === "en") ? t(el.getAttribute("data-i18n-ph")) : el._i18nPhId;
  });
  $$("[data-i18n-title]").forEach((el) => {
    if (el._i18nTitleId == null) el._i18nTitleId = el.title;
    el.title = (lang === "en") ? t(el.getAttribute("data-i18n-title")) : el._i18nTitleId;
  });
  trTree(document.body);
  // Text built with t() at render time ("1 jam lalu" / "1 h ago" on the tiles) is in the language of that moment;
  // the text map only goes ID → EN, so switching back left it in English. Build the tiles again.
  try { if (typeof renderRecent === "function" && document.querySelector(".recent-tile")) renderRecent(); } catch {}
  try { if (typeof renderUpdateBar === "function") renderUpdateBar(); } catch {}
  // Main process shows its own text (error dialogs, black-screen overlay, Discord presence) — keep it in step.
  try { window.electronAPI.setUiLanguage && window.electronAPI.setUiLanguage(lang); } catch {}
}

// App-wide translation via a text map: the UI is authored in Indonesian, and every text node, placeholder,
// tooltip and aria-label whose text appears here is shown in English when the language is EN — including
// text added later (toasts, menus, transfer cards, status lines) and messages that arrive from a peer or the
// signaling server. Strings with variable parts go in TEXT_EN_PATTERNS. See trTree / trObserver below.
const TEXT_EN = {
  // General
  "Alias perangkat": "Device alias", "Simpan": "Save",
  "Nama ini akan ditampilkan saat meminta koneksi ke perangkat lain.": "This name is shown when requesting a connection to other devices.",
  "Bahasa antarmuka": "Interface language", "Notifikasi": "Notifications",
  "Tampilkan notifikasi koneksi masuk": "Show incoming connection notifications",
  "Suara notifikasi": "Notification sound", "Pembaruan otomatis": "Automatic updates",
  "Periksa pembaruan saat aplikasi dimulai": "Check for updates on startup",
  // Connection
  "Waktu tunggu koneksi": "Connection timeout",
  "30 detik": "30 seconds", "60 detik": "60 seconds", "120 detik": "120 seconds", "5 menit": "5 minutes", "Tanpa batas": "Unlimited",
  "Auto-accept koneksi": "Auto-accept connections",
  "Terima koneksi otomatis jika ada password": "Auto-accept connections when a password is set",
  "Koneksi lewat IP (LAN)": "Connect by IP (LAN)",
  "Izinkan koneksi langsung dari jaringan lokal": "Allow direct connections from the local network",
  "PC lain di jaringan yang sama bisa tersambung dengan mengetik alamat IP PC ini, tanpa internet. Wajib memakai password akses minimal 10 karakter (tab Keamanan). Saat pertama dinyalakan, Windows akan meminta izin firewall.": "Other PCs on the same network can connect by typing this PC's IP address, with no internet. An access password of at least 10 characters is required (Security tab). The first time it is turned on, Windows asks for firewall permission.",
  "PC ini belum tersambung ke jaringan lokal": "This PC is not connected to a local network yet",
  "Masukkan ID atau alamat IP": "Enter an ID or IP address",
  "Masukkan ID 9 digit atau alamat IP": "Enter a 9-digit ID or an IP address",
  "Belum terhubung ke server — untuk PC di jaringan yang sama, ketik alamat IP-nya": "Not connected to the server — for a PC on the same network, type its IP address",
  "Password salah. Coba lagi.": "Wrong password. Try again.",
  "Menunggu password akses": "Waiting for the access password",
  "Koneksi LAN tidak diaktifkan di PC tujuan": "LAN connections are not turned on on the other PC",
  "PC tujuan belum memasang password akses — koneksi lewat IP membutuhkan password": "The other PC has no access password set — connecting by IP requires one",
  "Koneksi LAN hanya bisa dipakai setelah password akses diset (Pengaturan → Keamanan)": "LAN connections only work once an access password is set (Settings → Security)",
  "Tidak bisa membuka port LAN": "Couldn't open the LAN port",
  "Alamat IP tidak valid": "Invalid IP address",
  "Port tidak valid": "Invalid port",
  "Tidak ada TryDesk yang menjawab di alamat ini": "No TryDesk answered at this address",
  "Hanya alamat jaringan lokal (LAN) yang bisa dipakai": "Only local network (LAN) addresses can be used",
  "PC tujuan tidak menerima koneksi LAN (belum diaktifkan di Pengaturan, atau diblokir firewall)": "The other PC doesn't accept LAN connections (not turned on in Settings, or blocked by a firewall)",
  "Nama PC tidak ditemukan di jaringan": "PC name not found on the network",
  "Tidak bisa terhubung ke alamat ini": "Couldn't connect to this address",
  "Alamat ini bukan PC TryDesk": "This address is not a TryDesk PC",
  "Koneksi ke PC tujuan terputus": "The connection to the other PC dropped",
  "Terhubung ke": "Connected to",
  "Pembaruan keamanan wajib": "Security update required",
  "Perbarui TryDesk dulu: versi ini punya celah keamanan yang sudah diperbaiki": "Update TryDesk first: this version has a security issue that has been fixed",
  "PC tujuan memakai versi TryDesk lama yang wajib diperbarui": "The other PC runs an old TryDesk version that must be updated",
  "Salin alamat IP": "Copy IP address",
  "Salin": "Copy", "Sambung lewat IP": "Connect by IP", "Belum diatur": "Not set",
  "Atur": "Set", "Ubah": "Change", "Aktif": "On", "Aktifkan": "Turn on", "Tidak ada jaringan": "No network",
  "Hubungkan dan langsung buka Manajer file": "Connect and open the File Manager right away",
  "Satu jaringan? Sambung lewat IP": "Same network? Connect by IP",
  "Cari ID atau nama": "Search ID or name", "Tidak ada yang cocok dengan pencarian.": "Nothing matches your search.",
  "Belum ada favorit. Klik bintang pada sebuah perangkat untuk menyimpannya di sini.": "No favorites yet. Click the star on a device to keep it here.",
  "Belum ada koneksi. Perangkat yang pernah Anda hubungi muncul di sini.": "No connections yet. Devices you connect to show up here.",
  "Sambung lewat IP (LAN)": "Connect by IP (LAN)", "Buka pengaturan LAN": "Open LAN settings", "Mengerti": "Got it",
  "Cara pakai dan kalau gagal tersambung": "How to use it, and what to do if it fails", "Alamat IP disalin": "IP address copied",
  "Jika password akses diset, koneksi dengan password benar langsung diterima tanpa konfirmasi.": "If an access password is set, connections with the correct password are accepted without confirmation.",
  "Mulai saat startup": "Start on startup", "Jalankan TryDesk saat Windows start": "Run TryDesk when Windows starts",
  "Minimalisasi ke tray": "Minimize to tray", "Sembunyikan ke system tray saat ditutup": "Hide to the system tray when closed",
  "Koneksi langsung": "Direct connection", "Prioritaskan koneksi P2P langsung": "Prefer direct P2P connection",
  "Jika gagal, otomatis fallback ke relay TURN server.": "Falls back to the TURN relay server automatically if it fails.",
  "Coba sambung ulang jika koneksi terputus": "Try to reconnect if the connection drops",
  "Batas bandwidth upload": "Upload bandwidth limit",
  "Batasi bandwidth saat menjadi host agar tidak mengganggu aktivitas internet lain.": "Limit bandwidth while hosting so it doesn't disrupt other internet activity.",
  "Protokol koneksi": "Connection protocol",
  "Otomatis (P2P → TURN)": "Automatic (P2P → TURN)", "P2P saja (tidak menggunakan relay)": "P2P only (no relay)", "Relay saja (selalu gunakan TURN)": "Relay only (always use TURN)",
  "Otomatis akan mencoba koneksi P2P terlebih dahulu, lalu fallback ke TURN relay.": "Automatic tries a direct P2P connection first, then falls back to TURN relay.",
  "Pengaturan keepalive": "Keepalive settings",
  "Kirim sinyal keepalive agar koneksi tidak terputus": "Send keepalive signals to prevent disconnects",
  "Cegah layar mati pada host saat sesi aktif": "Prevent the host screen from sleeping during a session",
  // Security
  "Kontrol penuh (administrator)": "Full control (administrator)",
  "Jendela admin (mis. CMD sebagai administrator) hanya bisa dikontrol dari jarak jauh bila TryDesk dijalankan sebagai administrator. Tanpa ini layar tetap terlihat, tapi klik & ketik tidak berfungsi di jendela admin. Dialog UAC tampil di desktop aman Windows dan tidak bisa dilihat atau dikontrol dari jarak jauh.": "Admin windows (e.g. CMD run as administrator) can only be controlled remotely when TryDesk runs as administrator. Without it the screen still shows, but clicks & keystrokes won't work on admin windows. UAC prompts appear on Windows' secure desktop and can't be seen or controlled remotely.",
  "Jalankan sebagai administrator": "Run as administrator",
  "Password akses tanpa konfirmasi": "Access password (no confirmation)",
  "Jika diset, remote yang memasukkan password ini bisa langsung terhubung tanpa klik Accept.": "If set, a remote entering this password can connect directly without clicking Accept.",
  "Izin akses": "Access permissions", "Izinkan kontrol keyboard & mouse": "Allow keyboard & mouse control",
  "Izinkan transfer file": "Allow file transfer", "Izinkan sinkron clipboard": "Allow clipboard sync",
  "Izinkan remote melihat layar saja (tanpa kontrol)": "Allow remote to view only (no control)",
  "Keamanan sesi": "Session security", "Kunci layar Windows setelah sesi berakhir": "Lock Windows after the session ends",
  "Catat log semua sesi koneksi": "Log all connection sessions",
  "Hanya izinkan koneksi dari IP tertentu. Kosongkan untuk mengizinkan semua IP.": "Only allow connections from specific IPs. Leave empty to allow all.",
  "Batas waktu sesi": "Session time limit",
  "30 menit": "30 minutes", "1 jam": "1 hour", "2 jam": "2 hours", "8 jam": "8 hours",
  "Otomatis putuskan koneksi setelah durasi tertentu.": "Automatically disconnect after a set duration.",
  "Proteksi tambahan": "Extra protection",
  "Konfirmasi ulang untuk fitur sensitif (file, clipboard)": "Re-confirm sensitive features (file, clipboard)",
  "Blokir koneksi setelah 3x password salah (5 menit)": "Block after 3 wrong passwords (5 minutes)",
  // Display
  "Kualitas bawaan": "Default quality",
  "Hemat (3 Mbps / 15 FPS)": "Saver (3 Mbps / 15 FPS)", "Seimbang (20 Mbps / 30 FPS)": "Balanced (20 Mbps / 30 FPS)",
  "Kualitas (60 Mbps / 60 FPS)": "Quality (60 Mbps / 60 FPS)", "Ultra (150 Mbps / 120 FPS)": "Ultra (150 Mbps / 120 FPS)",
  "Gaming (300 Mbps / 165 FPS)": "Gaming (300 Mbps / 165 FPS)", "Maksimal (500 Mbps / 240 FPS)": "Maximum (500 Mbps / 240 FPS)",
  "Codec video bawaan": "Default video codec", "Otomatis": "Automatic",
  "AV1 (paling hemat bandwidth)": "AV1 (most bandwidth-efficient)", "VP9 (keseimbangan)": "VP9 (balanced)",
  "VP8 (kompatibilitas tinggi)": "VP8 (high compatibility)", "H.264 (akselerasi hardware)": "H.264 (hardware acceleration)",
  "Tema": "Theme", "Gelap": "Dark", "Terang": "Light", "Tampilan remote": "Remote display",
  "Otomatis tampilkan panel statistik": "Automatically show the stats panel", "Tampilkan kursor remote": "Show remote cursor",
  "Sembunyikan wallpaper host (hemat bandwidth)": "Hide host wallpaper (saves bandwidth)",
  "Nonaktifkan efek visual host (Aero, animasi)": "Disable host visual effects (Aero, animations)",
  "Skala tampilan bawaan": "Default display scale", "Pas jendela (Fit)": "Fit window", "100% (1:1 piksel)": "100% (1:1 pixels)",
  // Audio
  "Audio remote": "Remote audio", "Aktifkan audio remote secara otomatis": "Enable remote audio automatically",
  "Jika aktif, audio dari komputer remote akan otomatis diputar saat sesi dimulai.": "If enabled, audio from the remote computer plays automatically when the session starts.",
  "Volume audio remote": "Remote audio volume", "Mikrofon": "Microphone",
  "Izinkan pengiriman mikrofon ke remote": "Allow sending microphone to the remote",
  "Fitur ini memerlukan izin mikrofon dari sistem operasi.": "This requires microphone permission from the operating system.",
  "Kualitas audio": "Audio quality", "Rendah (hemat bandwidth)": "Low (saves bandwidth)", "Sedang": "Medium", "Tinggi (lossless-like)": "High (lossless-like)",
  // Advanced
  "Rendering": "Rendering", "Gunakan akselerasi hardware GPU": "Use GPU hardware acceleration",
  "Memanfaatkan GPU untuk decode video. Nonaktifkan jika terjadi masalah tampilan.": "Uses the GPU to decode video. Disable if you see display issues.",
  "Buffer jaringan": "Network buffer",
  "Rendah (latensi minimal, mungkin patah-patah)": "Low (minimal latency, may stutter)", "Sedang (seimbang)": "Medium (balanced)", "Tinggi (halus, latensi lebih tinggi)": "High (smooth, higher latency)",
  "Buffer rendah cocok untuk cloud gaming. Buffer tinggi cocok untuk koneksi tidak stabil.": "Low buffer suits cloud gaming. High buffer suits unstable connections.",
  "Logging": "Logging", "Nonaktif": "Off", "Hanya error": "Errors only", "Informasi": "Info", "Debug (detail penuh)": "Debug (full detail)",
  "Data & pengaturan": "Data & settings", "Ekspor pengaturan": "Export settings", "Impor pengaturan": "Import settings",
  "Reset semua pengaturan ke bawaan": "Reset all settings to default",
  "Tentang": "About", "Versi": "Version", "Lisensi": "License", "Gratis (Freeware)": "Free (Freeware)",
  "Pengaturan": "Settings", "Umum": "General", "Koneksi": "Connection", "Keamanan": "Security", "Tampilan": "Display", "Lanjutan": "Advanced",
  "Mis: PC Kantor, Laptop Rumah": "e.g. Office PC, Home Laptop",
  "Kosong = selalu minta Accept": "Empty = always ask to Accept",
  "Mis: 192.168.1.0/24, 10.0.0.5": "e.g. 192.168.1.0/24, 10.0.0.5",
  "Password minimal 6 karakter": "Password must be at least 6 characters",
  "Password tersimpan (ketik untuk ganti)": "Password saved (type to change)",
  "Password akses disimpan": "Access password saved", "Password akses dihapus": "Access password removed",
  "Password akses": "Access password", "Masuk": "Sign in",
  "Tidak ada jawaban dari pemilik PC": "The PC's owner did not answer",
  "PC remote mengizinkan kontrol lagi": "The remote PC allows control again",
  "Kontrol dilepas — mouse & keyboard kembali ke PC ini. Klik layar remote untuk lanjut.": "Control released — mouse & keyboard are back on this PC. Click the remote screen to carry on.",
  "Tip: teks yang disalin sebelum tersambung tidak ikut dikirim — salin ulang setelah tersambung": "Tip: text copied before connecting is not sent — copy it again once connected",
  "✓ Password akses aktif — koneksi dengan password ini tidak perlu klik Terima.": "✓ Access password is on — connections with this password don't need Accept.",
  "Belum ada password akses — setiap koneksi perlu klik Terima.": "No access password yet — every connection needs Accept.",
  "Hapus password akses": "Remove access password", "Tampilkan / sembunyikan": "Show / hide",
  "Batas waktu sesi di PC remote tercapai — koneksi diputus": "The remote PC's session time limit was reached — disconnected",
  "Koneksi P2P gagal — coba protokol Otomatis (Pengaturan → Koneksi) agar bisa lewat relay": "P2P connection failed — try the Automatic protocol (Settings → Connection) so it can use the relay",
  "Untuk mengirim file, klik tombol Kirim File": "To send a file, click the Send File button",
  "Untuk mengirim file, buka Control Center → Fitur lainnya → Transfer file": "To send a file, open Control Center → More features → File transfer",
  "PC mengirim file, tetapi aplikasi HP belum bisa menerima file": "The PC sent a file, but the phone app can't receive files yet",
  "Ditolak: aplikasi HP belum bisa menerima file": "Declined: the phone app can't receive files yet",
  "Ditolak: PC remote tidak mengizinkan transfer file": "Declined: the remote PC doesn't allow file transfer",
  "Ditolak: masih ada transfer lain": "Declined: another transfer is still running",
  "ID, favorit, riwayat koneksi dan password akses tetap disimpan. TryDesk akan dimuat ulang.": "Your ID, favorites, connection history and access password are kept. TryDesk will reload.",
  "Tutup TryDesk?": "Close TryDesk?", "Tutup": "Close",
  "PC ini sedang dikontrol dari jarak jauh.": "This PC is being controlled remotely.",
  "Masih ada sesi remote yang terbuka.": "There are still remote sessions open.",
  "Menutup TryDesk memutus semua sesi, dan PC ini tidak bisa dihubungi sampai TryDesk dibuka lagi.": "Closing TryDesk ends every session, and this PC can't be reached until TryDesk is opened again.",
  "Kembali ke sesi": "Back to session",
  "Atau tunggu pemilik PC menekan Terima. TryDesk tidak menyimpan password, jadi ketik setiap kali menyambung.": "Or wait for the PC's owner to click Accept. TryDesk doesn't save passwords, so type it each time you connect.",
  "Lewat IP, hanya password yang bisa membuka akses. TryDesk tidak menyimpan password.": "Over IP, only the password opens access. TryDesk doesn't save passwords.",
  "Menunggu password atau persetujuan pemilik PC": "Waiting for the password or the owner's approval", "Memeriksa password…": "Checking password…",
  "Peminta tidak memasukkan password akses. Ia masih bisa mengetiknya — bila benar, koneksi langsung diterima.": "The requester did not enter the access password. They can still type it — if it is right, the connection is accepted at once.",
  "Peminta tidak memasukkan password akses.": "The requester did not enter the access password.",
  "Peminta memasukkan password yang salah dan bisa mencoba lagi.": "The requester entered a wrong password and may try again.",
  "Password benar, tetapi \"Terima koneksi otomatis\" dimatikan di Pengaturan — jadi tetap perlu konfirmasi.": "Correct password, but \"Auto-accept\" is turned off in Settings, so confirmation is still needed.",
  "Password akses dari versi lama perlu diset ulang (Pengaturan → Keamanan)": "The access password from an older version must be set again (Settings → Security)",
  "Saat jendela ditutup": "When the window is closed",
  "Tetap berjalan di system tray (PC tetap bisa dihubungi)": "Keep running in the system tray (this PC stays reachable)",
  "Tombol X menyembunyikan TryDesk ke system tray, seperti AnyDesk. Keluar sepenuhnya lewat klik kanan ikon TryDesk di tray → Keluar. Bila dimatikan, X menutup TryDesk.": "The X button hides TryDesk to the system tray, like AnyDesk. Quit completely by right-clicking the TryDesk icon in the tray → Quit. When off, X closes TryDesk.",
  "Keluar dari TryDesk?": "Quit TryDesk?", "Keluar": "Quit",
  "Jika password akses diset (tab Keamanan), koneksi dengan password benar langsung diterima tanpa konfirmasi. Matikan bila Anda tetap ingin menekan Terima walau password benar.": "If an access password is set (Security tab), connections with the correct password are accepted without confirmation. Turn this off to still click Accept even when the password is right.",
  "Jika diset, orang yang mengontrol PC ini cukup mengetik password ini di kolom Password pada TryDesk mereka (atau saat diminta) — mereka langsung masuk tanpa Anda klik Terima. Tanpa password, Anda tetap diminta Terima.": "If set, whoever controls this PC just types this password in the Password field of their TryDesk (or when asked) and gets in without you clicking Accept. Without the password you are still asked to Accept.",
  "Alias dihapus": "Alias removed",
  "Jalankan sebagai administrator?": "Run as administrator?",
  "TryDesk akan ditutup lalu dibuka lagi dengan izin administrator.": "TryDesk will close and reopen with administrator rights.",
  "Windows akan menampilkan prompt UAC. Sesi yang sedang berjalan akan terputus.": "Windows will show a UAC prompt. Any running session will disconnect.",
  "Batal": "Cancel", "Lanjutkan": "Continue",
  // Home + server status
  "Desktop Ini": "This Desktop", "ID Anda": "Your ID", "Menghubungkan...": "Connecting...",
  "Bagikan ID ini agar orang lain bisa terhubung ke desktop Anda": "Share this ID so others can connect to your desktop",
  "ID Remote": "Remote ID", "Hubungkan": "Connect", "Favorit": "Favorites", "Koneksi Terakhir": "Recent Connections",
  "Terbaru": "Most recent", "Nomor ID": "ID number", "Hapus semua": "Clear all", "Baru saja": "Just now",
  "Menghubungkan ke server...": "Connecting to server...", "Online — siap menerima koneksi": "Online — ready to accept connections",
  "Terputus dari server — mencoba lagi...": "Disconnected from server — retrying...", "Alamat server tidak valid": "Invalid server address",
  "Salin ID": "Copy ID", "Buat ID baru": "Generate new ID", "Masukkan ID remote": "Enter remote ID", "Password (opsional)": "Password (optional)",
  "Tampilan grid": "Grid view", "Tampilan daftar": "List view", "Urutkan": "Sort", "Hapus semua riwayat": "Clear all history",
  "Perkecil": "Minimize", "Perbesar": "Maximize", "Tutup": "Close",
  // Connecting + incoming request
  "Menghubungkan": "Connecting", "Menunggu remote desktop menerima": "Waiting for the remote desktop to accept",
  "Mengirim permintaan": "Sending request", "Menunggu persetujuan": "Waiting for approval", "Membangun koneksi P2P": "Establishing P2P connection",
  "Batalkan": "Cancel", "Membangun koneksi peer-to-peer...": "Establishing peer-to-peer connection...",
  "Permintaan Koneksi Masuk": "Incoming Connection Request", "Dari perangkat": "From device",
  "Dapat melihat layar Anda": "Can see your screen", "Dapat mengontrol keyboard & mouse": "Can control keyboard & mouse",
  "Terima hanya jika Anda mengenal dan mempercayai pengirim.": "Only accept if you know and trust the sender.",
  "Dapat membuka & mengirim file di PC ini": "Can open & send files on this PC", "Berbagi clipboard (teks yang disalin)": "Shares the clipboard (copied text)",
  "Untuk mengirim file, buka Kirim File atau Manajer File": "To send files, use Send File or the File Manager",
  // Settings added/reworded in 1.1.0 + their messages
  "Discord": "Discord", "Tampilkan status TryDesk di profil Discord": "Show TryDesk status on my Discord profile",
  "Teman Discord Anda melihat \"Menggunakan TryDesk\" serta apakah Anda sedang mengontrol atau dikontrol.": "Your Discord friends see \"Using TryDesk\" and whether you're controlling or being controlled.",
  "Otomatis akan mencoba koneksi P2P terlebih dahulu, lalu fallback ke TURN relay. \"Relay saja\" hanya berfungsi bila server menyediakan TURN.": "Automatic tries a direct P2P connection first, then falls back to TURN relay. \"Relay only\" works only when the server provides TURN.",
  "Saat menjadi host": "While hosting", "Blokir peminta setelah 3x password salah (5–20 menit)": "Block a requester after 3 wrong passwords (5–20 minutes)",
  "Bawaan (80 Mbps / 60 FPS)": "Default (80 Mbps / 60 FPS)", "Kustom (diatur di panel Kualitas)": "Custom (set in the Quality panel)",
  "Dipakai untuk tab remote baru. FPS di atas 120 butuh monitor host dengan refresh rate setinggi itu.": "Used for new remote tabs. Above 120 FPS needs a host monitor with that refresh rate.",
  "Memanfaatkan GPU untuk capture, encode & decode video. Nonaktifkan jika terjadi masalah tampilan. Berlaku setelah TryDesk dibuka ulang.": "Uses the GPU to capture, encode & decode video. Disable it if you see display issues. Takes effect after restarting TryDesk.",
  "Mengembalikan semua pengaturan ke bawaan. ID, favorit, dan riwayat koneksi tetap disimpan.": "Restores every setting to its default. Your ID, favorites and connection history are kept.",
  "Kode sumber": "Source code", "Riwayat versi": "Version history", "Fitur per versi": "Features by version","AGPL-3.0 (open source, gratis)": "AGPL-3.0 (open source, free)", "Dibuat oleh": "Made by",
  "© 2026 DrWeabo. TryDesk adalah perangkat lunak bebas di bawah lisensi GNU AGPL-3.0 dan diberikan apa adanya, tanpa garansi. Nama dan logo TryDesk adalah merek DrWeabo; versi modifikasi harus memakai nama lain.":
    "© 2026 DrWeabo. TryDesk is free software under the GNU AGPL-3.0 licence, provided as is, without warranty. The TryDesk name and logo are DrWeabo's trademarks; modified versions must use a different name.",
  "Jendela admin (mis. CMD sebagai administrator) hanya bisa dikontrol dari jarak jauh bila TryDesk dijalankan sebagai administrator. Tanpa ini layar tetap terlihat, tapi klik & ketik tidak berfungsi di jendela admin. Dialog UAC tampil di desktop aman Windows dan tidak bisa dilihat atau dikontrol dari jarak jauh.": "Admin windows (e.g. CMD run as administrator) can only be controlled remotely when TryDesk runs as administrator. Without it the screen still shows, but clicks & keystrokes won't work on admin windows. UAC prompts appear on Windows' secure desktop and can't be seen or controlled remotely.",
  "Permintaan koneksi masuk": "Incoming connection request", "Batas waktu sesi tercapai — koneksi diputus": "Session time limit reached — disconnected",
  "Berlaku setelah TryDesk dibuka ulang": "Takes effect after restarting TryDesk",
  "Reset semua pengaturan?": "Reset all settings?", "Semua pengaturan kembali ke bawaan.": "Every setting goes back to its default.",
  "ID, favorit, dan riwayat koneksi tetap disimpan. TryDesk akan dimuat ulang.": "Your ID, favorites and connection history are kept. TryDesk will reload.",
  "Reset": "Reset", "UAC dibatalkan — TryDesk tetap berjalan tanpa hak administrator": "UAC cancelled — TryDesk keeps running without administrator rights",
  "PC remote hanya mengizinkan melihat layar — klik & ketikan tidak dikirim": "The remote PC only allows viewing — clicks & keystrokes aren't sent",
  "Gagal: file tidak lengkap": "Failed: file incomplete",
  "Kunci input dilepas oleh pengguna di PC remote": "Input lock released by the user on the remote PC",
  "Layar gelap dilepas oleh pengguna di PC remote": "Black screen released by the user on the remote PC",
  "Terima": "Accept", "Tolak": "Reject",
  // Connection results (shown locally, sent by the host, or sent by the signaling server)
  "Koneksi ditolak": "Connection rejected", "Remote desktop memutus koneksi": "The remote desktop ended the connection",
  "Belum terhubung ke server": "Not connected to the server yet", "Masukkan ID 9 digit": "Enter a 9-digit ID",
  "Tidak bisa konek ke diri sendiri": "You can't connect to yourself", "Tab untuk ID ini sudah terbuka": "A tab for this ID is already open",
  "Tidak ada respons dari remote desktop": "No response from the remote desktop", "Remote desktop sedang sibuk": "The remote desktop is busy",
  "Perangkat ini adalah TryDesk untuk HP (hanya mengontrol PC) dan tidak bisa dikontrol": "That device runs TryDesk for phones (it only controls PCs) and can't be controlled",
  "Terlalu banyak percobaan, coba lagi nanti": "Too many attempts, try again later", "Waktu verifikasi habis": "Verification timed out",
  "Password salah": "Wrong password", "Remote gagal membagikan layar": "The remote failed to share its screen",
  "Koneksi gagal — relay TURN tidak terjangkau": "Connection failed — TURN relay unreachable",
  "Koneksi P2P gagal — server belum menyediakan TURN relay": "P2P connection failed — the server has no TURN relay yet",
  "Koneksi terputus": "Connection lost", "ID tidak ditemukan atau sedang offline": "ID not found or offline",
  "Remote desktop sedang dalam sesi lain": "The remote desktop is in another session",
  "Tidak bisa me-remote PC Anda sendiri": "You can't remote into your own PC",
  "Terlalu banyak permintaan, coba lagi sebentar": "Too many requests, try again shortly", "Remote desktop offline": "Remote desktop offline",
  "Tip: agar jendela admin bisa dikontrol, jalankan TryDesk sebagai administrator (Pengaturan → Keamanan)": "Tip: to control admin windows, run TryDesk as administrator (Settings → Security)",
  "Jendela administrator aktif: pengontrol tidak bisa klik atau mengetik di jendela ini. Jalankan TryDesk sebagai administrator (Pengaturan → Keamanan) agar bisa.": "An administrator window is open: the person controlling this PC can't click or type in it. Run TryDesk as administrator (Settings → Security) to allow it.",
  "Jendela administrator (mis. Task Manager) terbuka di PC remote. Windows memblokir klik, ketikan, dan kursor ke jendela itu. Minta pemilik PC menutupnya, atau menjalankan TryDesk sebagai administrator.": "An administrator window (e.g. Task Manager) is open on the remote PC. Windows blocks clicks, typing and the cursor in that window. Ask the PC's owner to close it, or to run TryDesk as administrator.",
  "Gagal tersambung: gambar dari PC remote tidak masuk dalam 30 detik. Coba hubungkan lagi.": "Couldn't connect: no picture arrived from the remote PC within 30 seconds. Try connecting again.",
  "Koneksi dengan pengontrol tidak terbentuk dalam 30 detik, sesi diakhiri.": "The connection with the viewer didn't come up within 30 seconds, so the session was ended.",
  "Koneksi tidak terbentuk dalam 30 detik": "The connection didn't come up within 30 seconds",
  "TryDesk dibuka ulang sebagai administrator": "TryDesk restarted as administrator",
  "TryDesk untuk Linux saat ini hanya bisa mengontrol PC lain. PC ini belum bisa dikontrol dari jarak jauh.": "TryDesk for Linux can control other PCs for now. This PC can't be controlled remotely yet.",
  "PC ini memakai TryDesk untuk Linux, yang saat ini hanya bisa mengontrol PC lain": "This PC runs TryDesk for Linux, which can only control other PCs for now",
  "TryDesk dibuka ulang sebagai administrator. Jendela baru muncul dalam beberapa detik, jangan buka TryDesk lagi sebelum itu.": "TryDesk is restarting as administrator. The new window appears in a few seconds; don't open TryDesk again before then.",
  "TryDesk administrator tidak jadi terbuka karena TryDesk ini sudah berjalan. Klik kanan ikon TryDesk di tray → Keluar, lalu pilih Jalankan sebagai administrator lagi.": "The administrator TryDesk didn't open because this TryDesk was already running. Right-click the TryDesk tray icon → Quit, then choose Run as administrator again.",
  // Hosting screen
  "Sesi Remote Aktif": "Remote Session Active", "Desktop Anda sedang dikontrol": "Your desktop is being controlled",
  "Terhubung dengan": "Connected with", "Layar Anda digelapkan oleh remote": "Your screen has been darkened by the remote",
  "Kirim File": "Send File", "Putuskan": "Disconnect",
  // Remote screen, quality panel, stats, Control Center
  "Terhubung": "Connected", "Pas jendela": "Fit window", "Memuat layar remote…": "Loading remote screen…",
  "Resolusi": "Resolution", "Jalur": "Route", "P2P langsung": "Direct P2P", "P2P lokal": "Local P2P",
  "Pengaturan Kualitas": "Quality Settings", "Hemat": "Saver", "Seimbang": "Balanced", "Kualitas": "Quality", "Maksimal": "Maximum",
  "Kecepatan (bitrate)": "Speed (bitrate)",
  "Geser 1–1000 Mbps. Nilai tinggi = gambar lebih tajam, butuh bandwidth besar.": "Slide 1–1000 Mbps. Higher = sharper picture, needs more bandwidth.",
  "Asli": "Native", "Codec video": "Video codec", "AV1 (paling hemat)": "AV1 (most efficient)", "AV1 (hemat)": "AV1 (efficient)", "H.264 (kompatibel)": "H.264 (compatible)",
  "Ganti codec menyambung ulang video sesaat.": "Changing the codec briefly reconnects the video.",
  "Tampilkan statistik": "Show statistics", "Sinkron clipboard": "Clipboard sync",
  "Sinkron clipboard aktif": "Clipboard sync on", "Sinkron clipboard mati": "Clipboard sync off",
  "Kualitas gambar": "Picture quality", "Suara": "Sound", "Fitur lainnya": "More features", "Layar penuh": "Full screen",
  "Keluar layar penuh": "Exit full screen", "Putuskan koneksi": "Disconnect", "Pengaturan lanjutan…": "Advanced settings…",
  "Hanya 1 monitor terdeteksi": "Only 1 monitor detected", "Pindah monitor": "Switch monitor", "Tutup sesi": "Close session", "Tutup tab": "Close tab",
  "Audio remote": "Remote audio", "Audio tidak tersedia di remote": "Audio isn't available on the remote",
  "Audio remote aktif": "Remote audio on", "Audio remote dimatikan": "Remote audio off",
  "Matikan audio remote": "Mute remote audio", "Aktifkan audio remote": "Enable remote audio",
  "Mode lihat saja": "View only", "Mode lihat saja aktif": "View-only mode on", "Mode lihat saja nonaktif": "View-only mode off",
  "Gelapkan layar host": "Darken host screen", "Kunci input host": "Lock host input",
  "Layar remote digelapkan": "Remote screen darkened", "Layar remote dikembalikan": "Remote screen restored",
  "Input remote dikunci": "Remote input locked", "Input remote dibuka": "Remote input unlocked",
  "Kunci input gagal: TryDesk di PC remote harus dijalankan sebagai administrator": "Input lock failed: TryDesk on the remote PC must run as administrator",
  "Layar gelap gagal: TryDesk di PC remote harus dijalankan sebagai administrator": "Black screen failed: TryDesk on the remote PC must run as administrator",
  "Kunci input ditolak: PC remote hanya mengizinkan mode lihat saja": "Input lock refused: the remote PC only allows view-only mode",
  "Layar gelap ditolak: PC remote hanya mengizinkan mode lihat saja": "Black screen refused: the remote PC only allows view-only mode",
  "Mode game: AKTIF (klik mematikan)": "Game mode: ON (click to turn off)", "Mode game (mouse)": "Game mode (mouse)",
  "Transfer file": "File transfer", "Kombinasi tombol": "Key combinations", "Kombinasi tombol dikirim": "Key combination sent",
  "Tombol Windows": "Windows key", "Ambil screenshot": "Take screenshot", "Belum ada video": "No video yet",
  "Gagal mengambil gambar": "Failed to capture image", "Rekam sesi": "Record session", "Hentikan rekaman": "Stop recording",
  "Berhenti merekam": "Stop recording", "Mulai merekam sesi": "Recording session", "Belum ada video untuk direkam": "No video to record yet",
  "Perekaman tidak didukung": "Recording isn't supported", "Rekaman dibatalkan": "Recording cancelled",
  "Kontrol aktif kembali": "Control active again", "Sambungkan remote baru": "Connect a new remote",
  // Game mode
  "Mode lihat saja aktif — matikan dulu untuk mode game": "View-only mode is on — turn it off for game mode",
  "🎮 Mode game aktif — tekan Pause (atau Ctrl+Alt+Shift+Esc) untuk lepas kontrol": "🎮 Game mode on — press Pause (or Ctrl+Alt+Shift+Esc) to release control",
  "Mode game: klik layar untuk ambil kontrol mouse": "Game mode: click the screen to take mouse control",
  "Mouse tidak bisa dikunci untuk mode game (pointer lock ditolak)": "Couldn't lock the mouse for game mode (pointer lock refused)",
  "Mode game aktif — gerakan mouse relatif. Tekan Esc untuk keluar": "Game mode on — relative mouse movement. Press Esc to exit",
  "Mode game nonaktif": "Game mode off",
  "Kontrol dilepas — mouse & keyboard kembali ke PC ini (buka game lagi untuk lanjut)": "Control released — mouse & keyboard are back on this PC (open the game again to continue)",
  // Chat
  "Chat": "Chat", "Belum ada pesan": "No messages yet", "Pesan baru": "New message", "Anda": "You", "Kirim": "Send", "Ketik pesan...": "Type a message...",
  // File transfer + file manager
  "Belum siap untuk transfer": "Not ready to transfer yet", "Satu transfer dulu, lalu ulangi": "One transfer at a time, then try again",
  "Menunggu persetujuan...": "Waiting for approval...", "Dibatalkan": "Cancelled", "Ditolak": "Rejected", "Terkirim": "Sent",
  "Dibatalkan pengirim": "Cancelled by sender", "Transfer file dinonaktifkan di host": "File transfer is disabled on the host",
  "Manajer File": "File Manager", "Komputer ini": "This computer", "Komputer remote": "Remote computer",
  "Nama": "Name", "Tanggal": "Date", "Tipe": "Type", "Ukuran": "Size", "Unduh": "Download", "Folder": "Folder",
  "Antrean transfer": "Transfer queue", "Bersihkan": "Clear", "Mulai transfer": "Start transfer", "Memuat…": "Loading…",
  "Folder kosong": "Empty folder", "Pilih folder tujuan dulu": "Choose a destination folder first",
  "Belum ada transfer. Pilih file lalu klik Kirim atau Unduh.": "No transfers yet. Select files, then click Send or Download.",
  "Lanjut": "Resume", "Jeda": "Pause", "Hapus dari daftar": "Remove from list", "Menunggu": "Waiting", "Dijeda": "Paused",
  "Selesai": "Done", "Gagal": "Failed", "Sibuk": "Busy", "ditolak": "rejected", "gagal": "failed",
  "Sesi transfer belum siap": "Transfer session not ready", "Transfer file butuh sesi aktif": "File transfer needs an active session",
  "Naik satu tingkat": "Up one level", "Beranda": "Home", "Muat ulang": "Reload",
  "Kirim ke komputer remote": "Send to remote computer", "Unduh ke komputer ini": "Download to this computer",
  // Recent / Favorites tile menu
  "Opsi lainnya": "More options", "Salin ID": "Copy ID", "Ganti nama": "Rename",
};
// Text produced earlier through t() (tile tooltips, toasts) is in the DOM in the language of that moment —
// map the I18N dictionary's Indonesian strings too, so a language switch updates it in place.
for (const [k, v] of Object.entries(I18N.id)) if (I18N.en[k] && !(v in TEXT_EN)) TEXT_EN[v] = I18N.en[k];
// Strings with a variable part (an ID, a path, a count…). A function replacement can translate the inner part too.
const TEXT_EN_PATTERNS = [
  [/^Kembali ke sesi (.+)$/, "Back to session $1"],
  [/^Kembali ke (\d+) sesi berjalan$/, "Back to $1 running sessions"],
  [/^(.+) meminta password akses — buka tab tersebut$/, "$1 asks for its access password — open that tab"],
  [/^Menyambung ulang ke (.+) \((\d+)\/(\d+)\)…$/, "Reconnecting to $1 ($2/$3)…"],
  [/^Meminta akses ke (.+)\.\.\.$/, "Requesting access to $1..."],
  [/^Terhubung ke (.+)$/, "Connected to $1"],
  [/^Alamat PC ini: (.+)$/, "This PC's address: $1"],
  [/^Butuh password (\d+)\+ karakter$/, "Needs a $1+ character password"],
  [/^PC (.+) meminta password akses\.$/, "PC $1 is asking for its access password."],
  [/^PC tujuan perlu password akses minimal (\d+) karakter untuk koneksi lewat IP$/, "The other PC needs an access password of at least $1 characters for connecting by IP"],
  [/^Koneksi LAN hanya bisa dipakai dengan password akses minimal (\d+) karakter \(Pengaturan → Keamanan\)$/, "LAN connections only work with an access password of at least $1 characters (Settings → Security)"],
  [/^TryDesk (\S+) tersedia$/, "TryDesk $1 is available"],
  [/^Anda memakai versi (\S+)\.$/, "You are using version $1."],
  [/^Versi (\S+) punya celah keamanan yang sudah diperbaiki\. Perbarui ke (\S+) untuk bisa terhubung lagi\.$/, "Version $1 has a security issue that has been fixed. Update to $2 to connect again."],
  [/^Port (\d+) sudah dipakai program lain$/, "Port $1 is already used by another program"],
  [/^Tidak bisa membuka port LAN \((.+)\)$/, "Couldn't open the LAN port ($1)"],
  [/^Menghubungkan (.+)…$/, "Connecting $1…"],
  [/^Beralih ke Monitor (\d+)…$/, "Switching to Monitor $1…"],
  [/^Monitor (\d+) · utama$/, "Monitor $1 · primary"],
  [/^Screenshot disimpan: (.+)$/, "Screenshot saved: $1"],
  [/^Rekaman disimpan: (.+)$/, "Recording saved: $1"],
  [/^Tersimpan: (.+)$/, "Saved: $1"],
  [/^Alias disimpan: (.+)$/, "Alias saved: $1"],
  [/^Nama untuk (.+)$/, "Name for $1"],
  [/^(\d+) file ditambahkan ke antrean$/, "$1 file(s) added to the queue"],
  [/^(.+) · ingin dikirim$/, "$1 · wants to send"],
  [/^Tidak bisa membuka folder · (.+)$/, (_, e) => `Can't open folder · ${trCore(e)}`],
  [/^Tidak bisa membuka folder$/, "Can't open folder"],
  [/^Gagal mengunci mouse untuk game: (.+)$/, "Couldn't lock the mouse for game mode: $1"],
  [/^(\d+) menit lalu$/, "$1 min ago"], [/^(\d+) jam lalu$/, "$1 h ago"], [/^(\d+) hari lalu$/, "$1 d ago"],
];

function trCore(core) {
  const k = core.replace(/\s+/g, " ");
  if (TEXT_EN[k] != null) return TEXT_EN[k];
  for (const [re, rep] of TEXT_EN_PATTERNS) if (re.test(k)) return k.replace(re, rep);
  return core;
}
// Translate one string, keeping its surrounding whitespace (text nodes beside icons carry spaces).
function trText(s) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m[2]) return s;
  const out = trCore(m[2]);
  return out === m[2] ? s : m[1] + out + m[3];
}
// For text that never enters the DOM (native notifications, dialogs).
function tr(s) { return lang === "en" ? trText(String(s)) : s; }

// User / peer content is never translated: chat bodies, chat-notification text, file and transfer names.
const TR_SKIP = ".help-id, .help-en, .chat-msg > div, .cn-text, .fm-name, .tc-name, #accept-alias, #accept-id, .id-text, .tile-id, .tile-sub-id, .tile-menu-head, .rtab-label, script, style, textarea";
const TR_ATTRS = ["title", "placeholder", "aria-label"];
// Each node remembers its Indonesian source, so switching back restores it exactly. A node the app rewrote
// since (data no longer equals what we wrote) takes its new text as the source.
function trTextNode(n) {
  const el = n.parentElement;
  if (!el || el.closest(TR_SKIP)) return;
  if (n._trOut !== undefined && n.data !== n._trOut) n._trSrc = undefined;
  if (n._trSrc === undefined) n._trSrc = n.data;
  const want = lang === "en" ? trText(n._trSrc) : n._trSrc;
  n._trOut = want;
  if (n.data !== want) n.data = want;
}
function trAttrs(el) {
  if (el.closest(TR_SKIP)) return;
  for (const a of TR_ATTRS) {
    const v = el.getAttribute(a);
    if (v == null) continue;
    el._trA = el._trA || {};
    let rec = el._trA[a];
    if (!rec || v !== rec.out) rec = el._trA[a] = { src: v };
    rec.out = lang === "en" ? trText(rec.src) : rec.src;
    if (v !== rec.out) el.setAttribute(a, rec.out);
  }
}
function trTree(root) {
  if (root.nodeType === 3) return trTextNode(root);
  if (root.nodeType !== 1) return;
  trAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) trTextNode(n); else trAttrs(n); }
}
// Text that appears or changes later (toasts, menus, status, transfer cards) is translated as it lands.
// Our own writes are recognised (data === _trOut) and settle without looping.
const trObserver = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "childList") m.addedNodes.forEach(trTree);
    else if (m.type === "characterData") trTextNode(m.target);
    else if (m.type === "attributes") trAttrs(m.target);
  }
});
trObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: TR_ATTRS });

// ─── UI helpers ───────────────────────────────────────────
function showScreen(name) {
  for (const s of ["home", "connecting", "remote", "hosting"]) {
    $(`#screen-${s}`).classList.toggle("hidden", s !== name);
  }
  // Show titlebar for home/connecting, hide for remote (grip bar replaces it)
  $("#titlebar").style.display = (name === "remote") ? "none" : "";
  refreshKeyCapture();
  renderBackPill();
  renderAdminBanner();
}

// Sessions keep running while Home ("＋") or a connecting tab is on screen — always offer the way back to them.
function renderBackPill() {
  const pill = $("#back-to-session"); if (!pill) return;
  const shown = ["home", "connecting", "hosting"].find((n) => !$(`#screen-${n}`).classList.contains("hidden"));
  const live = viewerSessions().filter((s) => s.pc && !(shown === "connecting" && s === active));
  pill.classList.toggle("hidden", !shown || !live.length);
  if (!live.length) return;
  const target = live.includes(active) ? active : live[live.length - 1];
  pill._target = target;
  pill.querySelector("span").textContent = live.length > 1 ? `Kembali ke ${live.length} sesi berjalan` : `Kembali ke sesi ${fmtId(target.peerId)}`;
}

// Full keyboard capture (native hook — forwards Alt+Tab, Win, Alt+Esc etc. to the remote even outside
// fullscreen) is ON only while we're actively controlling a remote PC: off on Home/Hosting, in view-only,
// and while typing in a local field so the user can still use TryDesk's own inputs.
let _kbReleased = false;   // Pause / Ctrl+Alt+Shift+Esc gave the keyboard back; a click on the remote view takes it again
function refreshKeyCapture() {
  const remote = !$("#screen-remote").classList.contains("hidden");
  const a = document.activeElement;
  const typing = a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
  // Also off when the HOST only lets us watch: grabbing Win / Alt+Tab here would just swallow them.
  const on = !!(remote && active && active.role === "viewer" && !active.viewOnly && !active.hostViewOnly && !typing && !_kbReleased);
  try { window.electronAPI && window.electronAPI.setKeyCapture && window.electronAPI.setKeyCapture(on); } catch {}
  // Leaving control (view-only, left the remote screen, session closed) must also drop native game-mouse
  // capture so the user's cursor is never left trapped.
  if (!on && _gameActive) setGameCapture(false);
}

function showToast(message) {
  let toast = $(".toast");
  if (!toast) { toast = document.createElement("div"); toast.className = "toast"; document.body.appendChild(toast); }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove("show"), 3000);
}

function setStatus(state, text) { statusDot.className = `status-dot ${state}`; statusText.textContent = text; }

const _hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function _pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, key, 256);
}
// Access password is stored as a salted, slow PBKDF2 hash ("saltHex:hashHex") so a leaked store
// can't be brute-forced quickly; it is checked through the HMAC challenge below, never compared directly.
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${_hex(salt.buffer)}:${_hex(await _pbkdf2(pw, salt))}`;
}
const _hexToBytes = (h) => Uint8Array.from((String(h).match(/.{2}/g) || []).map((x) => parseInt(x, 16)));
function _constEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// HMAC-SHA256(keyBytes, msg) → hex. Used for the server-blind access-password challenge/response:
// the signaling server relays only the salt, a one-shot nonce and this HMAC — never the password.
async function _hmacHex(keyBytes, msg) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(String(msg)));
  return _hex(sig);
}
// Viewer side: prove knowledge of the access password against the host's challenge, without the
// password ever leaving this machine. Key = PBKDF2(password, salt) — the exact bytes the host stored.
async function answerChallenge(pw, saltHex, nonce) {
  const keyBytes = new Uint8Array(await _pbkdf2(pw || "", _hexToBytes(saltHex)));
  return _hmacHex(keyBytes, nonce);
}
// Host side: recompute the expected HMAC from the stored "saltHex:hashHex" (hashHex IS the key bytes).
async function expectedChallenge(stored, nonce) {
  if (!stored || !stored.includes(":")) return null;      // legacy unsalted hashes can't do HMAC challenge
  const hashHex = stored.split(":")[1];
  return _hmacHex(_hexToBytes(hashHex), nonce);
}
// Viewer side, split in two: derive the key once from the typed password, then answer each nonce with it.
const deriveKeyHex = async (pw, saltHex) => _hex(await _pbkdf2(pw || "", _hexToBytes(saltHex)));
const answerWithKey = (keyHex, nonce) => _hmacHex(_hexToBytes(keyHex), nonce);

// ─── Recent connections & favorites (AnyDesk-style tiles) ──
const STAR_PATH = "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z";
const MONITOR_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`;
let recentSort = "recent";
let recentView = "grid";
function applyRecentView() {
  const list = recentView === "list";
  $("#recent-list")?.classList.toggle("view-list", list);
  $("#favorites-list")?.classList.toggle("view-list", list);
  $("#view-grid")?.classList.toggle("active", !list);
  $("#view-list")?.classList.toggle("active", list);
}

function getRecent() { try { return JSON.parse(store.get("recent") || "[]"); } catch { return []; } }
function addRecent(id) {
  const recent = [{ id, time: Date.now() }, ...getRecent().filter((r) => r.id !== id)].slice(0, 12);
  store.set("recent", JSON.stringify(recent));
  renderRecent();
}
function removeRecent(id) {
  store.set("recent", JSON.stringify(getRecent().filter((r) => r.id !== id)));
  pruneThumbs();
  renderRecent();
}
function clearRecent() { store.set("recent", JSON.stringify([])); pruneThumbs(); renderRecent(); }

// Per-ID custom names ("Rename", as in AnyDesk) and a thumbnail of the remote screen from the last session.
// Both stay on this device only; a thumbnail is dropped as soon as its ID leaves Recent and Favorites.
const getPeerNames = () => { try { return JSON.parse(store.get("peerNames") || "{}") || {}; } catch { return {}; } };
const peerName = (id) => getPeerNames()[id] || "";
function setPeerName(id, name) {
  const m = getPeerNames(); delete m[id];
  name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (name) m[id] = name;
  const ids = Object.keys(m); if (ids.length > 100) delete m[ids[0]];
  store.set("peerNames", Object.keys(m).length ? JSON.stringify(m) : null);
  for (const s of sessions.values()) if (s.role === "viewer" && s.peerId === id) updateSessionLabel(s);
  renderTabs(); renderFavorites(); renderRecent();
}
const getThumbs = () => { try { return JSON.parse(store.get("peerThumbs") || "{}") || {}; } catch { return {}; } };
function pruneThumbs(m = getThumbs()) {
  const keep = new Set([...getRecent(), ...getFavorites()].map((r) => r.id));
  for (const id of Object.keys(m)) if (!keep.has(id)) delete m[id];
  store.set("peerThumbs", Object.keys(m).length ? JSON.stringify(m) : null);
}
function saveThumb(sess) {
  const v = sess && sess.role === "viewer" ? sess.video : null;
  if (!v || !v.videoWidth || !v.videoHeight) return;
  try {
    const c = document.createElement("canvas");
    c.width = 320; c.height = Math.max(1, Math.round(320 * v.videoHeight / v.videoWidth));
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const m = getThumbs(); delete m[sess.peerId]; m[sess.peerId] = c.toDataURL("image/jpeg", 0.72);
    pruneThumbs(m);
    renderFavorites(); renderRecent();
  } catch {}
}

const TILE_ICON = {
  connect: `<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`,
  files: `<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>`,
  copy: `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>`,
  star: `<path d="${STAR_PATH}"/>`,
  rename: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>`,
  remove: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  more: `<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>`,
};
const tileSvg = (inner, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const isPhoneUi = () => document.documentElement.classList.contains("td-mobile");

function connectFromTile(id, { files = false } = {}) {
  remoteIdInput.value = id;
  const s = initiateConnection();
  if (!files || !(s instanceof Session)) return;
  if (s.fileChannel && s.fileChannel.readyState === "open") openFileManager();
  else s.openFilesWhenReady = true;      // opened by setupFileChannel once the session's file channel is up
}

function makeTile(id, time, opts = {}) {
  const name = peerName(id);
  const el = document.createElement("div");
  el.className = "recent-tile";
  el.title = `${t("ui_connect")} ${name ? `${name} (${fmtId(id)})` : fmtId(id)}`;
  const preview = document.createElement("div"); preview.className = "tile-preview";
  const thumb = opts.thumbs && opts.thumbs[id];
  if (thumb) { const img = new Image(); img.alt = ""; img.draggable = false; img.src = thumb; preview.classList.add("has-thumb"); preview.appendChild(img); }
  else preview.innerHTML = MONITOR_SVG;
  const meta = document.createElement("div"); meta.className = "tile-meta";
  // A LAN tile shows the bare address (the "(LAN)" suffix would be cut off) and says LAN on the line below.
  const lanAddr = /^lan:/.test(id) ? id.slice(4) : "";
  const idEl = document.createElement("div"); idEl.className = "tile-id"; idEl.textContent = name || lanAddr || fmtId(id);
  const subEl = document.createElement("div"); subEl.className = "tile-sub";
  if (name) { const pid = document.createElement("span"); pid.className = "tile-sub-id"; pid.textContent = lanAddr || fmtId(id); subEl.append(pid, " · "); }
  if (lanAddr) subEl.append("LAN · ");
  const tm = document.createElement("span"); tm.textContent = time; subEl.appendChild(tm);
  meta.append(idEl, subEl);
  const more = document.createElement("button");
  more.className = "tile-more"; more.title = "Opsi lainnya"; more.setAttribute("aria-haspopup", "menu");
  more.innerHTML = tileSvg(TILE_ICON.more, 16);
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    openTileMenu(id, el, { fav: opts.fav, x: r.right, y: r.bottom + 4, alignRight: true });
  });
  const foot = document.createElement("div"); foot.className = "tile-foot"; foot.append(meta, more);
  el.append(preview, foot, makeStarBtn(id, true));
  el.addEventListener("click", () => {
    if (el._longPressed) { el._longPressed = false; return; }
    if (el.querySelector(".tile-rename")) return;
    connectFromTile(id);
  });
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); openTileMenu(id, el, { fav: opts.fav, x: e.clientX, y: e.clientY }); });
  // Touch: press and hold opens the same menu
  let lp = null, sx = 0, sy = 0;
  const cancelLp = () => { clearTimeout(lp); lp = null; };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || e.target.closest("button, input")) return;
    sx = e.clientX; sy = e.clientY; cancelLp();
    lp = setTimeout(() => { lp = null; el._longPressed = true; openTileMenu(id, el, { fav: opts.fav, x: sx, y: sy }); }, 480);
  });
  el.addEventListener("pointermove", (e) => { if (lp && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancelLp(); });
  el.addEventListener("pointerup", cancelLp);
  el.addEventListener("pointercancel", cancelLp);
  return el;
}
// The sessions card: one tab at a time (Terakhir / Favorit, each with its count), filtered by the search box.
let homeTab = store.get("homeTab") === "fav" ? "fav" : "recent";
const sessMatch = (id, q) => !q || [id, fmtId(id), peerName(id) || ""].some((s) => s.toLowerCase().replace(/\s/g, "").includes(q));
const sessQuery = () => ($("#sess-search")?.value || "").toLowerCase().replace(/\s/g, "");
function renderSessionsView() {
  const recentN = getRecent().length, favN = getFavorites().length, q = sessQuery();
  $("#count-recent").textContent = recentN; $("#count-fav").textContent = favN;
  $$(".sess-tab").forEach((b) => { const on = b.dataset.sess === homeTab; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  $("#recent-section").classList.toggle("hidden", homeTab !== "recent");
  $("#favorites-section").classList.toggle("hidden", homeTab !== "fav");
  $("#recent-clear").classList.toggle("hidden", homeTab !== "recent" || !recentN);
  const shown = $(homeTab === "fav" ? "#favorites-list" : "#recent-list").children.length;
  const empty = $("#sess-empty");
  empty.textContent = shown ? "" : q ? "Tidak ada yang cocok dengan pencarian." : homeTab === "fav" ? "Belum ada favorit. Klik bintang pada sebuah perangkat untuk menyimpannya di sini." : "Belum ada koneksi. Perangkat yang pernah Anda hubungi muncul di sini.";
  empty.classList.toggle("hidden", !!shown);
}
function renderRecent() {
  const q = sessQuery();
  const recent = [...getRecent()].filter((r) => sessMatch(r.id, q)).sort((a, b) => recentSort === "id" ? a.id.localeCompare(b.id) : b.time - a.time);
  const list = $("#recent-list");
  const thumbs = getThumbs();
  list.replaceChildren();
  for (const r of recent) list.appendChild(makeTile(r.id, formatTime(r.time), { fav: false, thumbs }));
  renderSessionsView();
}

// ─── Tile menu (⋮, right-click, long-press): AnyDesk's Recent Sessions menu ───
let tileMenuEl = null;
function closeTileMenu() { if (tileMenuEl) { tileMenuEl.remove(); tileMenuEl = null; } }
function openTileMenu(id, tile, { fav = false, x = 0, y = 0, alignRight = false } = {}) {
  closeTileMenu(); closeAllMenus();
  const phone = isPhoneUi();
  const starred = isFavorite(id);
  // A LAN tile ("lan:192.168.1.20") is shown and copied as its bare address.
  const lanAddr = /^lan:/.test(id) ? id.slice(4) : "";
  const items = [
    ["Hubungkan", TILE_ICON.connect, () => connectFromTile(id)],
    !phone && ["Transfer file", TILE_ICON.files, () => connectFromTile(id, { files: true })],
    [lanAddr ? "Salin alamat IP" : "Salin ID", TILE_ICON.copy, () => navigator.clipboard.writeText(lanAddr || id).then(() => showToast(lanAddr ? "Alamat IP disalin" : t("id_copied")), () => {})],
    "-",
    [starred ? t("fav_remove_tip") : t("fav_add_tip"), TILE_ICON.star, () => toggleFavorite(id)],
    ["Ganti nama", TILE_ICON.rename, () => startRename(id, tile)],
    !fav && ["Hapus dari riwayat", TILE_ICON.remove, () => removeRecent(id)],
  ].filter(Boolean);
  const m = document.createElement("div");
  m.className = "tile-menu"; m.setAttribute("role", "menu");
  const head = document.createElement("div"); head.className = "tile-menu-head";
  const shown = lanAddr ? `${lanAddr} · LAN` : id;
  head.textContent = peerName(id) ? `${peerName(id)} · ${shown}` : shown;
  m.appendChild(head);
  for (const it of items) {
    if (it === "-") { const sep = document.createElement("div"); sep.className = "tile-menu-sep"; m.appendChild(sep); continue; }
    const [label, icon, fn] = it;
    const b = document.createElement("button");
    b.className = "cc-item"; b.setAttribute("role", "menuitem");
    b.innerHTML = tileSvg(icon); b.append(document.createTextNode(label));
    b.addEventListener("click", (e) => { e.stopPropagation(); closeTileMenu(); fn(); });
    m.appendChild(b);
  }
  // Focus sits on the menu itself (no ring on a mouse open); the arrow keys walk the items from there.
  m.tabIndex = -1;
  m.addEventListener("keydown", (e) => {
    const btns = [...m.querySelectorAll("button")], i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = i < 0 ? (e.key === "ArrowDown" ? 0 : btns.length - 1) : (i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length;
      btns[next]?.focus();
    }
  });
  document.body.appendChild(m);
  tileMenuEl = m;
  if (!phone) {        // a phone shows it as a bottom sheet (mobile.css)
    const w = m.offsetWidth, h = m.offsetHeight;
    let left = alignRight ? x - w : x, top = y;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    if (top + h > innerHeight - 8) top = Math.max(8, (alignRight ? y - 8 : y) - h);
    m.style.left = `${left}px`; m.style.top = `${top}px`;
  }
  m.focus({ preventScroll: true });
}
document.addEventListener("pointerdown", (e) => { if (tileMenuEl && !tileMenuEl.contains(e.target)) closeTileMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tileMenuEl) { closeTileMenu(); } });
window.addEventListener("resize", closeTileMenu);
window.addEventListener("blur", closeTileMenu);
document.addEventListener("scroll", closeTileMenu, true);

// Inline rename on the tile itself (Enter / click away saves, Esc cancels, empty = back to the ID)
function startRename(id, tile) {
  const idEl = tile && tile.isConnected ? tile.querySelector(".tile-id") : null;
  if (!idEl) return;
  const inp = document.createElement("input");
  inp.className = "tile-rename"; inp.maxLength = 40; inp.value = peerName(id); inp.placeholder = id;
  inp.setAttribute("aria-label", "Nama untuk " + fmtId(id));
  idEl.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save && inp.value.trim() !== peerName(id)) setPeerName(id, inp.value);
    else { renderFavorites(); renderRecent(); }
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("pointerdown", (e) => e.stopPropagation());
}

function getFavorites() { try { return JSON.parse(store.get("favorites") || "[]"); } catch { return []; } }
function isFavorite(id) { return getFavorites().some((f) => f.id === id); }
function toggleFavorite(id) {
  let favs = getFavorites();
  const was = favs.some((f) => f.id === id);
  favs = was ? favs.filter((f) => f.id !== id) : [{ id, time: Date.now() }, ...favs].slice(0, 20);
  store.set("favorites", JSON.stringify(favs));
  pruneThumbs();
  renderFavorites(); renderRecent();
  showToast(was ? t("fav_removed") : t("fav_added"));
}
function makeStarBtn(id, tile) {
  const star = document.createElement("button");
  star.className = "fav-star" + (tile ? " tile-star" : "") + (isFavorite(id) ? " active" : "");
  star.title = isFavorite(id) ? t("fav_remove_tip") : t("fav_add_tip");
  star.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="${isFavorite(id) ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8"><path d="${STAR_PATH}"/></svg>`;
  star.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(id); });
  return star;
}
function renderFavorites() {
  const q = sessQuery();
  const favs = getFavorites().filter((f) => sessMatch(f.id, q)).sort((a, b) => recentSort === "id" ? a.id.localeCompare(b.id) : 0);
  const list = $("#favorites-list");
  const thumbs = getThumbs();
  list.replaceChildren();
  for (const f of favs) list.appendChild(makeTile(f.id, formatTime(f.time), { fav: true, thumbs }));
  renderSessionsView();
}
function formatTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return t("time_now");
  if (mins < 60) return `${mins} ${t("time_min")}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${t("time_hour")}`;
  return `${Math.floor(hours / 24)} ${t("time_day")}`;
}

// ─── Connecting steps UI ──────────────────────────────────
function setConnectStep(step) {
  for (let i = 1; i <= 3; i++) {
    const el = $(`#cstep-${i}`);
    el.classList.toggle("active", i === step);
    el.classList.toggle("done", i < step);
  }
}

// ─── Hosting timer ────────────────────────────────────────
// mm:ss, or h:mm:ss once a session passes an hour.
function fmtDuration(totalSec) {
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function startHostingTimer() {
  stopHostingTimer();               // (stop first — it clears the start time)
  hostingStartTime = Date.now();
  hostingTimerHandle = setInterval(() => {
    const el = $("#hosting-timer");
    if (el && hostingStartTime) el.textContent = fmtDuration(Math.floor((Date.now() - hostingStartTime) / 1000));
  }, 1000);
}
function stopHostingTimer() {
  if (hostingTimerHandle) { clearInterval(hostingTimerHandle); hostingTimerHandle = null; }
  hostingStartTime = null;
  const el = $("#hosting-timer");
  if (el) el.textContent = "00:00";
}

// ─── Signaling ────────────────────────────────────────────
function connectSignaling() {
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  setStatus("", t("connecting_server"));
  try { ws = new WebSocket(serverUrl); }
  catch { setStatus("error", "Alamat server tidak valid"); return; }

  // app = version + platform + OS release, told to the server when signing in (the server checks it against the
  // connection). The Android app has no osRelease; its User-Agent already names the Android version and model.
  const app = { v: (config && config.appVersion) || "", p: platformName(), ...(config && config.osRelease ? { os: String(config.osRelease).slice(0, 60) } : {}) };
  // live = peers this process still has a session with. A fresh start (Run as administrator, a crash, Quit and
  // reopen) sends none, so the server drops pairings the old process left behind instead of keeping them for good.
  ws.onopen = () => {
    const live = [...viewerSessions(), ...(host ? [host] : [])].filter((s) => s.pc && !isLanId(s.peerId)).map((s) => s.peerId);
    ws.send(JSON.stringify({ type: "register", id: store.get("myId"), token: store.get("myToken"), app, live }));
  };
  ws.onmessage = (event) => { let msg; try { msg = JSON.parse(event.data); } catch { return; } onSignal(msg); };
  ws.onclose = () => {
    myId = null; myIdText.textContent = "Offline";
    try { window.electronAPI.setTrayInfo?.({ id: "" }); } catch {}
    setStatus("error", "Terputus dari server — mencoba lagi...");
    reconnectTimer = setTimeout(connectSignaling, 3000);
  };
}
// Desktop builds other than Windows (Linux for now) only control other PCs; the phone app has its own layer.
function viewerOnlyDesktop() { return !window.TD_MOBILE && !!config && !!config.platform && config.platform !== "win32"; }
function platformName() { return window.TD_MOBILE ? "android" : config && config.platform === "linux" ? "linux" : config && config.platform === "darwin" ? "macos" : "windows"; }
function sendSignal(data) {
  if (data && isLanId(data.targetId)) { lanSignal(data); return; }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ─── LAN direct connection ("Sambung lewat IP") ───────────
// Two PCs on one network start a session without the signaling server (an office or a warnet PC with no internet,
// like AnyDesk's "direct connection"). main.js (or the phone's TdLan plugin) only carries JSON lines over TCP; this
// part speaks the same messages the server relays, so the rest of the app can't tell the difference. Peer ids:
//   "lan:<address>"     — a PC this one asks (viewer tab), address = what the user typed ("192.168.1.20[:7171]")
//   "lan-in:<ip>#<n>"   — a PC asking this one (host side), one id per socket
// Rules that the server enforces elsewhere are enforced here instead: the host refuses any LAN request unless an
// access password is set, only a correct password gets in (no Accept-dialog fallback for strangers on the network),
// and the offer/answer carry an HMAC under the password key, so someone else on the network can't swap the
// session's DTLS fingerprint (the TCP line itself is not encrypted).
const isLanId = (id) => typeof id === "string" && (id.startsWith("lan:") || id.startsWith("lan-in:"));
const lanIn = (id) => typeof id === "string" && id.startsWith("lan-in:");
// Recognise an IP / IP:port / [IPv6]:port / host name typed in the ID box. A 9-digit ID never matches (no dot/colon).
function parseLanTarget(text) {
  const a = String(text || "").trim().replace(/^lan:/, "");
  if (/^\d{3} ?\d{3} ?\d{3}$/.test(a)) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/.test(a) && a.split(":")[0].split(".").every((n) => Number(n) <= 255)) return a;
  if (/^\[[0-9a-f:.%a-z]+\](:\d{1,5})?$/i.test(a)) return a.toLowerCase();
  if (/^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}(%[\w.-]+)?$/i.test(a)) return a.toLowerCase();   // bare IPv6 (fe80::1)
  if (/^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9-]{1,63})*(:\d{1,5})?$/i.test(a) && /[a-z]/i.test(a.split(":")[0])) return a.toLowerCase();   // a LAN PC name
  return null;
}
const lanLinks = new Map();   // viewer side: "lan:<addr>" -> { ready, queue, paired, machine }
let lanHostOn = false;
// One random value per install, sent in the host's hello: a viewer that sees its own value is talking to itself.
function lanMachine() {
  let m = store.get("lanMachine");
  if (!m) { m = _hex(crypto.getRandomValues(new Uint8Array(12)).buffer); store.set("lanMachine", m); }
  return m;
}
async function lanMac(keyHex, kind, desc) {
  if (!keyHex || !desc || typeof desc.sdp !== "string") return "";
  return _hmacHex(_hexToBytes(keyHex), `trydesk-lan|${kind}|${desc.type}|${desc.sdp}`);
}
async function lanSignal(data) {
  const id = data.targetId;
  // Through JSON: RTCSessionDescription / RTCIceCandidate can't cross the IPC bridge as objects (toJSON flattens them).
  const out = JSON.parse(JSON.stringify(data)); delete out.targetId;
  // Offers and answers are signed with the password key (see above).
  const s = sessionFor(id);
  if ((out.type === "offer" || out.type === "answer") && s && s.lanKey) out.mac = await lanMac(s.lanKey, out.type, out.offer || out.answer);
  if (lanIn(id)) {
    window.electronAPI.lanWrite(id, out);
    // A refusal or a hang-up ends that socket; the requester opens a new one to try again.
    if (out.type === "connection-rejected" || out.type === "disconnect") window.electronAPI.lanClose(id);
    return;
  }
  let link = lanLinks.get(id);
  if (out.type === "connect-request") {
    if (link) { window.electronAPI.lanClose(id); lanLinks.delete(id); }
    link = { ready: false, queue: [out], paired: false };
    lanLinks.set(id, link);
    const r = await window.electronAPI.lanOpen(id.slice(4)).catch(() => null);
    if (lanLinks.get(id) !== link) return;
    if (!r || !r.ok) { lanLinks.delete(id); onSignal({ type: "error", targetId: id, message: (r && r.error) || "Tidak bisa terhubung ke alamat ini" }); return; }
    // The host speaks first (lan-hello); the queued request goes out once it did, or the attempt fails.
    link.helloTimer = setTimeout(() => { if (lanLinks.get(id) === link && !link.ready) { lanDrop(id); onSignal({ type: "error", targetId: id, message: "Alamat ini bukan PC TryDesk" }); } }, 5000);
    return;
  }
  if (!link) return;
  if (link.ready) window.electronAPI.lanWrite(id, out); else link.queue.push(out);
  if (out.type === "disconnect" || out.type === "cancel-request") lanDrop(id);
}
function lanDrop(id) {
  const link = lanLinks.get(id);
  if (link) clearTimeout(link.helloTimer);
  lanLinks.delete(id);
  window.electronAPI.lanClose(id);
}
// Only the fields each message needs, as the server would relay them; anything else on the line is ignored.
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const desc = (d) => (d && typeof d === "object" && typeof d.sdp === "string" && /^(offer|answer)$/.test(d.type) && d.sdp.length < 60000 ? { type: d.type, sdp: d.sdp } : null);
const cand = (c) => (c && typeof c === "object" && typeof c.candidate === "string" ? { candidate: c.candidate.slice(0, 1000), sdpMid: c.sdpMid == null ? null : str(c.sdpMid, 32), sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null } : null);
async function onLanEvent(ev) {
  if (!ev || !isLanId(ev.id)) return;
  const id = ev.id, m = ev.msg || {};
  if (lanIn(id)) {
    if (ev.kind === "close") { lanRequested.delete(id); onSignal({ type: "request-cancelled", fromId: id }); onSignal({ type: "peer-disconnected", fromId: id }); return; }
    if (ev.kind !== "line") return;
    switch (m.type) {
      case "connect-request":
        // A second request on a socket that already has one is ignored (the server allows one per pair too).
        if (lanRequested.has(id)) return;
        lanRequested.add(id);
        return onSignal({ type: "incoming-connection", fromId: id, fromName: str(m.fromName, 64) || "TryDesk User" });
      case "cancel-request": return onSignal({ type: "request-cancelled", fromId: id });
      case "connection-response": return onSignal({ type: "connection-response", fromId: id, response: str(m.response, 128) });
      case "offer": {
        const d = desc(m.offer);
        if (!d || !host || host.peerId !== id || !host.lanKey) return;
        if (!_constEq(str(m.mac, 128), await lanMac(host.lanKey, "offer", d))) { sessLog(host, "LAN offer with a bad signature ignored"); return; }
        return onSignal({ type: "offer", fromId: id, offer: d });
      }
      case "ice-candidate": { const c = cand(m.candidate); if (c && host && host.peerId === id) onSignal({ type: "ice-candidate", fromId: id, candidate: c }); return; }
      case "disconnect": return onSignal({ type: "peer-disconnected", fromId: id, ...(m.bye ? { bye: true, reason: str(m.reason, 120) } : {}) });
    }
    return;
  }
  const link = lanLinks.get(id);
  if (!link) return;
  if (ev.kind === "close") {
    lanDrop(id);
    if (link.paired) onSignal({ type: "peer-disconnected", fromId: id });
    else onSignal({ type: "error", targetId: id, message: link.ready ? "Koneksi ke PC tujuan terputus" : "Alamat ini bukan PC TryDesk" });
    return;
  }
  if (ev.kind !== "line") return;
  if (!link.ready) {
    if (m.type !== "lan-hello") return;
    clearTimeout(link.helloTimer);
    if (str(m.machine, 64) && str(m.machine, 64) === lanMachine()) { lanDrop(id); onSignal({ type: "error", targetId: id, message: "Tidak bisa me-remote PC Anda sendiri" }); return; }
    link.ready = true;
    for (const q of link.queue.splice(0)) window.electronAPI.lanWrite(id, q);
    return;
  }
  switch (m.type) {
    case "connection-challenge": return onSignal({ type: "connection-challenge", fromId: id, salt: str(m.salt, 64), nonce: str(m.nonce, 128) });
    case "connection-accepted": link.paired = true; return onSignal({ type: "connection-accepted", fromId: id });
    case "connection-rejected": lanDrop(id); return onSignal({ type: "connection-rejected", fromId: id, reason: str(m.reason, 160) });
    case "answer": {
      const d = desc(m.answer), s = sessions.get(id);
      if (!d || !s || !s.lanKey) return;
      if (!_constEq(str(m.mac, 128), await lanMac(s.lanKey, "answer", d))) { sessLog(s, "LAN answer with a bad signature ignored"); return; }
      return onSignal({ type: "answer", fromId: id, answer: d });
    }
    case "ice-candidate": { const c = cand(m.candidate); if (c) onSignal({ type: "ice-candidate", fromId: id, candidate: c }); return; }
    case "disconnect": lanDrop(id); return onSignal({ type: "peer-disconnected", fromId: id, ...(m.bye ? { bye: true, reason: str(m.reason, 120) } : {}) });
  }
}
const lanRequested = new Set();
try { window.electronAPI.onLanEvent((ev) => { onLanEvent(ev).catch((e) => console.warn("lan event", e)); }); } catch {}
// Settings → Koneksi → "Izinkan koneksi langsung dari LAN". Shows the addresses others type to reach this PC.
let lanAddrsNow = [];
// The LAN line itself is not encrypted, so someone recording the network could try passwords offline against what
// they captured. A short password falls quickly; connecting by IP therefore needs one of at least LAN_PW_MIN
// characters. Only the length class is kept (accessPwLan), set when the password is saved.
const LAN_PW_MIN = 10;
const lanPwStrong = () => !!store.get("accessPasswordHash") && store.get("accessPwLan") === "1";
// The "Desktop Ini" card: whether an access password is set, and the address(es) others type to connect by IP.
function renderHomeFacts() {
  const box = $("#home-facts"); if (!box) return;
  const hostable = !viewerOnlyDesktop() && !window.TD_MOBILE;
  box.classList.toggle("hidden", !hostable);
  if (!hostable) return;
  const pw = !!store.get("accessPasswordHash");
  const pv = $("#fact-pw-val");
  pv.textContent = pw ? "Aktif" : "Belum diatur"; pv.classList.toggle("on", pw);
  $("#fact-pw-btn").textContent = pw ? "Ubah" : "Atur";
  const lv = $("#fact-lan-val"), lb = $("#fact-lan-btn");
  // LAN on but no (long enough) password: every LAN request is refused, so say that instead of showing an address.
  const needPw = lanHostOn && !lanPwStrong();
  const addr = lanHostOn && !needPw ? (lanAddrsNow[0] || "") : "";
  // (short, so it fits the card at the 700 px minimum window; the hover text says it in full)
  lv.textContent = !lanHostOn ? "Nonaktif" : needPw ? `Password min. ${LAN_PW_MIN}` : addr || "Tidak ada jaringan";
  lv.title = needPw ? `Butuh password ${LAN_PW_MIN}+ karakter` : lanAddrsNow.join(", ");
  lv.classList.toggle("addr", !!addr);
  lv.classList.toggle("warn", needPw);
  lb.textContent = addr ? "Salin" : lanHostOn ? "Atur" : "Aktifkan";
  lb.dataset.go = needPw ? "pw" : "";
}
// Open Settings on one tab and bring one setting into view.
function openSettingsAt(tabId, selector) {
  if (overlaySettings.classList.contains("hidden")) toggleSettings();
  $(`.stab[data-tab="${tabId}"]`)?.click();
  const el = selector && $(selector)?.closest(".setting-group");
  if (el) setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
}
function openLanHelp() {
  const can = !viewerOnlyDesktop() && !window.TD_MOBILE;
  $("#btn-lan-help-settings").classList.toggle("hidden", !can);
  $("#overlay-lan-help").classList.remove("hidden");
  $("#overlay-lan-help .help-body").scrollTop = 0;   // always open at the top (focusing the button scrolled it down)
  $("#btn-lan-help-ok").focus({ preventScroll: true });
}
const closeLanHelp = () => $("#overlay-lan-help").classList.add("hidden");
$("#fact-pw-btn").addEventListener("click", () => openSettingsAt("tab-security", "#access-password"));
$("#fact-lan-btn").addEventListener("click", () => {
  const addr = lanHostOn && lanPwStrong() && lanAddrsNow[0];
  if (addr) navigator.clipboard.writeText(addr).then(() => showToast("Alamat IP disalin"), () => {});
  else if ($("#fact-lan-btn").dataset.go === "pw") openSettingsAt("tab-security", "#access-password");
  else openSettingsAt("tab-connection", "#setting-lan");
});
for (const id of ["#btn-lan-help", "#btn-lan-help-2"]) $(id).addEventListener("click", openLanHelp);
$("#btn-lan-help-close").addEventListener("click", closeLanHelp);
$("#btn-lan-help-ok").addEventListener("click", closeLanHelp);
$("#btn-lan-help-settings").addEventListener("click", () => { closeLanHelp(); openSettingsAt("tab-connection", "#setting-lan"); });
$("#overlay-lan-help").addEventListener("click", (e) => { if (e.target.id === "overlay-lan-help") closeLanHelp(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#overlay-lan-help").classList.contains("hidden")) closeLanHelp(); });
async function applyLanHost(on, boot) {
  const note = $("#setting-lan-addr");
  if (!window.electronAPI.lanHost || viewerOnlyDesktop() || window.TD_MOBILE) { lanHostOn = false; return; }
  const r = await window.electronAPI.lanHost({ on, machine: lanMachine() }).catch(() => null);
  lanHostOn = !!(r && r.ok && r.on);
  lanAddrsNow = lanHostOn ? (r.addrs || []) : [];
  renderHomeFacts();
  if (on && (!r || !r.ok)) { if (!boot) showToast((r && r.error) || "Tidak bisa membuka port LAN"); const cb = $("#setting-lan"); if (cb && !boot) { cb.checked = false; prefSet("lanDirect", false); } }
  if (on && lanHostOn && !lanPwStrong() && !boot) showToast(`Koneksi LAN hanya bisa dipakai dengan password akses minimal ${LAN_PW_MIN} karakter (Pengaturan → Keamanan)`);
  if (note) {
    const addrs = lanHostOn ? (r.addrs || []) : [];
    note.textContent = !lanHostOn ? "" : addrs.length ? `Alamat PC ini: ${addrs.join(", ")}` : "PC ini belum tersambung ke jaringan lokal";
    note.classList.toggle("hidden", !lanHostOn);
  }
}

async function onSignal(msg) {
  switch (msg.type) {
    case "registered":
      myId = msg.clientId;
      store.set("myId", msg.clientId); store.set("myToken", msg.token);
      serverIceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
      myIdText.textContent = fmtId(myId);
      try { window.electronAPI.setTrayInfo?.({ id: fmtId(myId) }); } catch {}
      setStatus("connected", "Online — siap menerima koneksi");
      if (_regenPending) { _regenPending = false; showToast(t("id_regenerated") + ": " + fmtId(myId)); }
      break;
    case "incoming-connection": handleIncoming(msg); break;
    case "request-cancelled": {
      // The requester gave up (Cancel / went offline) while we were still asking. Close the accept dialog or
      // drop the password challenge — accepting a dead request left the host capturing and "busy" for good.
      if (acceptFromId === msg.fromId && acceptDlgCancel) acceptDlgCancel();
      if (pendingChallenge && pendingChallenge.fromId === msg.fromId) { clearTimeout(pendingChallenge._t); pendingChallenge = null; }
      break;
    }
    case "connection-challenge": {
      // Host requires an access password. Prove we know it via HMAC over the host's nonce — the password itself
      // never travels. First round: the typed password, else an "empty" answer (the host
      // then shows its owner the Accept dialog). Another round means the host is still asking (no password, or
      // a wrong one) while its owner sees Accept: let the user type it here — whichever comes first wins.
      const s = sessions.get(msg.fromId);
      if (!s || s.role !== "viewer" || s.pc) return;
      // The host answered — it is now up to its owner (30 s dialog) or to the password; our own "no response"
      // timeout must not close the tab while the user is typing the password.
      clearTimeout(s.requestTimer);
      const salt = String(msg.salt || ""), nonce = String(msg.nonce || "");
      s.pwSalt = salt;
      s.pwRound = (s.pwRound || 0) + 1;
      try {
        let key = null, how = "empty";
        if (s.pendingPassword) { key = await deriveKeyHex(s.pendingPassword, salt); how = "typed"; s.lanKey = key; }
        s.pendingPassword = "";   // one-shot; don't keep the secret around
        if (!key && s.pwRound > 1) { showPwPrompt(s, nonce, s.pwLast); return; }
        s.pwLast = how;
        const response = key ? await answerWithKey(key, nonce) : await answerChallenge("", salt, nonce);
        sendSignal({ type: "connection-response", targetId: msg.fromId, response });
      } catch { sendSignal({ type: "connection-response", targetId: msg.fromId, response: "" }); }
      break;
    }
    case "connection-response": { await handleChallengeResponse(msg); break; }
    case "connection-accepted": {
      const s = sessions.get(msg.fromId);
      if (s) sessLog(s, "accepted by the remote PC");
      if (s && s.role === "viewer" && !s.pc) {
        s.pwPrompt = null; renderPwPrompt();
        if (s === active) setConnectStep(3);
        startViewer(s);
      }
      break;
    }
    case "connection-rejected": {
      const s = sessions.get(msg.fromId);
      if (!s) return;
      // The reason comes from the other side through the server: only ever a short string.
      const reason = (typeof msg.reason === "string" && msg.reason.slice(0, 160)) || "Koneksi ditolak";
      sessLog(s, "rejected: " + reason.slice(0, 80));
      closeSession(s, false); showToast(reason);
      reconnectFailed(s, reason);
      break;
    }
    case "offer":
      if (host && msg.fromId === host.peerId) await onOffer(host, msg.offer);
      break;
    case "answer": {
      const s = sessions.get(msg.fromId);
      if (s && s.pc) { await s.pc.setRemoteDescription(msg.answer); flushCandidates(s); }
      break;
    }
    case "ice-candidate": {
      if (!msg.candidate) return;
      const s = sessionFor(msg.fromId);
      if (!s || !s.pc) return;
      if (s.pc.remoteDescription) s.pc.addIceCandidate(msg.candidate).catch(() => {});
      else s.pendingCandidates.push(msg.candidate);
      break;
    }
    case "peer-disconnected": {
      const s = sessionFor(msg.fromId);
      if (!s) break;
      if (msg.bye) { if (!s.byeReceived) onBye(s, msg.reason); break; }   // ended on purpose (see closeSession)
      // The server also reports this when only the SIGNALING link blipped (or the server restarted) while the
      // P2P session is perfectly healthy. A real hang-up closes the data channel within moments, so with a live
      // link wait briefly and only tear down if it really went away.
      const linkUp = () => s.pc && s.pc.connectionState === "connected" && s.dataChannel && s.dataChannel.readyState === "open";
      const stillOurs = () => (s.role === "host" ? host === s : sessions.get(s.peerId) === s);
      const hangUp = () => {
        const reconnect = s.role === "viewer" && autoReconnect && s.everConnected && !s.byeReceived;
        const fg = s === active;
        closeSession(s, false);
        if (reconnect) tryReconnect(s.peerId, s.savedPassword, fg);
        else showToast("Remote desktop memutus koneksi");
      };
      if (linkUp()) setTimeout(() => { if (stillOurs() && !linkUp()) hangUp(); }, 3000);
      else hangUp();
      break;
    }
    case "error": {
      // Errors (target offline/busy) belong to a tab that is still connecting. Newer servers name it in
      // targetId; otherwise fall back to the active tab.
      const s = msg.targetId ? sessions.get(msg.targetId) : active;
      if (s) sessLog(s, "server: " + String(msg.message || "").slice(0, 80));
      if (s && s.role === "viewer" && s.pc == null) { closeSession(s, false); reconnectFailed(s, ""); }   // offline / busy: try again later
      showToast(msg.message);
      break;
    }
  }
}

// Session bar label: "Terhubung ke" + the peer. The prefix is its own element so a narrow window can drop it and
// keep the address/ID itself readable (it used to be cut to "Connected to 1…"). The full text stays as a tooltip.
function setPeerLabel(prefix, peerId, tail = "") {
  const el = $("#remote-peer-id");
  const pre = document.createElement("span"); pre.className = "sb-peer-pre"; pre.textContent = prefix;
  const who = document.createElement("span"); who.textContent = fmtId(peerId) + tail;
  el.replaceChildren(pre, who);
  el.title = `${tr(prefix)} ${fmtId(peerId)}`;
}
// Resolve a signaling peerId to its session (viewer tab or the single host session).
function sessionFor(peerId) {
  return sessions.get(peerId) || (host && host.peerId === peerId ? host : null);
}

// ─── Viewer side ──────────────────────────────────────────
// From the Connect button (reads the inputs) or from auto-reconnect (own target + password; a background tab's
// reconnect leaves the tab the user is looking at in front).
function initiateConnection(target, password, { background = false } = {}) {
  const fromUi = typeof target !== "string";
  if (updateRequired) return showToast(UPDATE_REFUSED);
  const typed = fromUi ? remoteIdInput.value.trim() : target;
  // An IP address (or a LAN PC name) goes straight to that PC — no server, so no need to be online.
  const lanAddr = parseLanTarget(typed);
  const targetId = lanAddr ? "lan:" + lanAddr : typed;
  if (!lanAddr) {
    if (!myId) return showToast("Belum terhubung ke server — untuk PC di jaringan yang sama, ketik alamat IP-nya");
    if (!/^\d{3} \d{3} \d{3}$/.test(targetId)) return showToast("Masukkan ID 9 digit atau alamat IP");
    if (targetId === myId) return showToast("Tidak bisa konek ke diri sendiri");
  }
  if (sessions.has(targetId)) {
    // Double-click on a tile, Enter + click, a second Enter listener: just bring that tab up — a tab still
    // connecting keeps its Connecting screen (Cancel + password box), it is not "already open".
    const s = sessions.get(targetId);
    if (fromUi || !background) switchTab(s);
    if (s.pc) showToast("Tab untuk ID ini sudah terbuka");
    return s;
  }
  // Open a new viewer tab. Any existing tabs keep running in the background.
  const sess = new Session(targetId, "viewer");
  sessions.set(targetId, sess);
  updateSessionLabel(sess);           // a renamed ID shows its name on the tab right away
  // Hold the typed password locally for the challenge/response — it is NEVER sent to the server. savedPassword
  // stays with the tab so an auto-reconnect can answer the host's challenge again.
  sess.pendingPassword = sess.savedPassword = (fromUi ? remotePasswordInput.value : password) || "";
  // The typed password belongs to THIS PC only — clear it so the next tile or ID doesn't silently reuse it
  // (a wrong answer there counts toward that PC's lock-out).
  if (fromUi) remotePasswordInput.value = "";
  if (!background) active = sess;
  renderTabs();
  if (!background) {
    showScreen("connecting");
    renderPwPrompt();
    setConnectStep(1);
    $("#connecting-title").textContent = "Menghubungkan";
    $("#connecting-text").textContent = `Meminta akses ke ${fmtId(targetId)}...`;
  }
  sendSignal({ type: "connect-request", targetId, fromName: store.get("deviceAlias") || "TryDesk User" });
  sessLog(sess, "request sent");
  setTimeout(() => { if (sessions.get(targetId) === sess && !sess.pc && sess === active) setConnectStep(2); }, 500);
  // Never leave a tab on "connecting" forever (no answer, or an error the server sent without naming the tab).
  // Settings → Koneksi → "Waktu tunggu koneksi" (0 = wait indefinitely).
  const waitS = Number(prefGet("connTimeout")) || 0;
  if (waitS > 0) sess.requestTimer = setTimeout(() => {
    if (sessions.get(targetId) === sess && !sess.pc) {
      closeSession(sess, false); showToast("Tidak ada respons dari remote desktop");
      if (sess.isReconnect) tryReconnect(targetId, sess.savedPassword, sess.wasForeground);
    }
  }, waitS * 1000);
  return sess;
}

// The host asked for its access password again (none typed, or a wrong one). Its owner sees the Accept dialog
// at the same moment; typing the right password here gets in at once. The line under the field is empty until a
// wrong password; the waiting line says what else can happen (users expected a saved device to remember the
// password, it doesn't by the owner's choice, so it says so).
const PW_PROMPT_TEXT = { empty: "", typed: "Password salah. Coba lagi." };
const PW_WAIT = {
  id: "Atau tunggu pemilik PC menekan Terima. TryDesk tidak menyimpan password, jadi ketik setiap kali menyambung.",
  lan: "Lewat IP, hanya password yang bisa membuka akses. TryDesk tidak menyimpan password.",
};
function showPwPrompt(s, nonce, last) {
  s.pwPrompt = { nonce, last: PW_PROMPT_TEXT[last] ? last : "empty" };
  renderPwPrompt();
  // A tab in the background (or an auto-reconnect) can't show its box — point the user at it.
  if (s !== active || $("#screen-connecting").classList.contains("hidden")) showToast(`${fmtId(s.peerId)} meminta password akses — buka tab tersebut`);
}
function renderPwPrompt() {
  const s = active && active.role === "viewer" && !active.pc ? active : null;
  const p = s && s.pwPrompt;
  $("#connect-pw").classList.toggle("hidden", !p);
  if (!p) return;
  const m = $("#connect-pw-msg");
  const lan = isLanId(s.peerId);   // over LAN only the password gets in (no Accept on the other side)
  m.textContent = PW_PROMPT_TEXT[p.last];
  m.classList.toggle("warn", p.last !== "empty");
  $("#connect-pw-peer").textContent = `PC ${fmtId(s.peerId)} meminta password akses.`;
  $("#connect-pw-wait-text").textContent = lan ? PW_WAIT.lan : PW_WAIT.id;
  $("#connect-pw-go").disabled = false;
  $("#connecting-text").textContent = lan ? "Menunggu password akses" : "Menunggu password atau persetujuan pemilik PC";
  const inp = $("#connect-pw-input");
  inp.value = "";
  inp.focus();
}
$("#connect-pw").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = active, p = s && s.pwPrompt;
  const pw = $("#connect-pw-input").value;
  if (!p || !pw) return;
  $("#connect-pw-go").disabled = true;
  try {
    const key = await deriveKeyHex(pw, s.pwSalt);
    if (sessions.get(s.peerId) !== s || s.pc || s.pwPrompt !== p) return;
    s.pwPrompt = null;
    s.pwLast = "typed";
    s.savedPassword = pw;   // an auto-reconnect answers the next challenge with it
    s.lanKey = key;         // a LAN session signs its offers with it
    sendSignal({ type: "connection-response", targetId: s.peerId, response: await answerWithKey(key, p.nonce) });
  } catch {}
  renderPwPrompt();
  if (s === active && !s.pc) $("#connecting-text").textContent = "Memeriksa password…";
});

async function startViewer(sess) {
  addRecent(sess.peerId);
  if (sess === active) $("#connecting-text").textContent = "Membangun koneksi peer-to-peer...";
  createPeer(sess);
  const pc = sess.pc;
  sess.videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  applyCodecPreference(sess);
  sess.dataChannel = pc.createDataChannel("ctrl", { ordered: true });
  sess.dataChannel.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } onCtrlMessage(sess, ev); };
  sess.dataChannel.onopen = () => {
    sendQuality(sess); startClipboardSync(sess);
    // Once: text copied BEFORE connecting is deliberately not sent (privacy) — say so, or "copy, connect, paste" just seems broken.
    if (clipboardSync && store.get("tipClipBaseline") !== "1" && !document.documentElement.classList.contains("td-mobile")) { store.set("tipClipBaseline", "1"); setTimeout(() => showToast("Tip: teks yang disalin sebelum tersambung tidak ikut dikirim — salin ulang setelah tersambung"), 2500); }
  };
  sess.fileChannel = pc.createDataChannel("file", { ordered: true });
  sess.fileChannel.binaryType = "arraybuffer";
  setupFileChannel(sess, sess.fileChannel);

  const video = ensureVideo(sess);
  pc.ontrack = (event) => {
    if (event.streams[0]) video.srcObject = event.streams[0];
    else { const s = video.srcObject || new MediaStream(); s.addTrack(event.track); video.srcObject = s; }
    video.muted = !(sess.audioOn && sess === active);   // a background tab stays silent (see showActiveVideo)
    video.volume = Number(prefGet("audioVolume")) / 100;
    // Start the receive buffer minimal; pollStats() then adapts it to the MEASURED network jitter —
    // near-zero on a clean LAN (feels instant, good for gaming) and larger only when the link is
    // actually jittery (stays smooth for distant users). A fixed 120ms buffer added real lag on LAN.
    if (event.track && event.track.kind === "video" && event.receiver) {
      sess.videoReceiver = event.receiver;
      try { event.receiver.playoutDelayHint = 0.015; } catch {}
      try { if ("jitterBufferTarget" in event.receiver) event.receiver.jitterBufferTarget = 15; } catch {}
    }
    if (sess === active) {
      showScreen("remote");
      renderTabs();
      setPeerLabel("Terhubung ke", sess.peerId);
      if (!sess.hasFrame) $("#remote-loading")?.classList.remove("hidden");
      showActiveVideo();
      video.focus();
      applyScale();
    }
    startStats(sess);
    startSessionTimer(sess);
  };

  await negotiate(sess);
}

// Make the video encoder start near full quality instead of ramping up from a low bandwidth
// estimate (the cause of the first 10–30s showing a tiny, low-res remote screen). We inject
// Google's x-google-*-bitrate hints into the video codecs so it jumps to full resolution at once.
function boostStartBitrate(sdp) {
  const startKbps = 12000;                                  // encoder's initial target — start sharp (HD), not a ramp-up
  const minKbps = 1200;                                     // floor kept low so weak links still adapt down, not choke
  const maxKbps = Math.max(startKbps, Math.round((hostQuality.bitrate || 80) * 1000));
  const extra = `x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`;
  const lines = sdp.split(/\r\n/);
  let vStart = lines.findIndex((l) => l.startsWith("m=video"));
  if (vStart < 0) return sdp;
  let vEnd = lines.length;
  for (let i = vStart + 1; i < lines.length; i++) { if (lines[i].startsWith("m=")) { vEnd = i; break; } }
  const section = lines.slice(vStart, vEnd);
  const codecOf = {};
  for (const l of section) { const m = l.match(/^a=rtpmap:(\d+) ([^/]+)\//); if (m) codecOf[m[1]] = m[2].toUpperCase(); }
  const wanted = new Set(Object.entries(codecOf).filter(([, c]) => ["VP8", "VP9", "H264", "AV1", "AV1X"].includes(c)).map(([pt]) => pt));
  const hasFmtp = new Set();
  for (const l of section) { const m = l.match(/^a=fmtp:(\d+) /); if (m) hasFmtp.add(m[1]); }
  const out = [];
  for (const l of section) {
    const fm = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (fm && wanted.has(fm[1])) {
      out.push(/x-google-start-bitrate/.test(fm[2]) ? l : `a=fmtp:${fm[1]} ${fm[2]};${extra}`);
      continue;
    }
    out.push(l);
    const rm = l.match(/^a=rtpmap:(\d+) /);
    if (rm && wanted.has(rm[1]) && !hasFmtp.has(rm[1])) { out.push(`a=fmtp:${rm[1]} ${extra}`); hasFmtp.add(rm[1]); }
  }
  return lines.slice(0, vStart).concat(out, lines.slice(vEnd)).join("\r\n");
}

async function negotiate(sess) {
  if (!sess.pc || sess.role !== "viewer") return;
  const offer = await sess.pc.createOffer();
  offer.sdp = boostStartBitrate(offer.sdp);
  await sess.pc.setLocalDescription(offer);
  sendSignal({ type: "offer", targetId: sess.peerId, offer: sess.pc.localDescription });
}

function applyCodecPreference(sess) {
  const tr = sess.videoTransceiver;
  if (!tr || !tr.setCodecPreferences) return;
  try {
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (!caps) return;
    // "Otomatis" must really go back to the browser's own order. An empty list is meant to reset it, but this
    // Chromium keeps the earlier choice (VP9…) — so hand it the default order explicitly.
    // "Otomatis" puts H.264 first: it is the codec GPUs encode and decode in hardware (measured: NVIDIA MFT on
    // the host, ~0.6 ms decode), where VP8/VP9/AV1 run in software on the CPU. Without a hardware encoder the
    // host falls back to software H.264 by itself. The rest keeps the browser's own order.
    if (sess.quality.codec === "auto") {
      const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType));
      tr.setCodecPreferences([...h264, ...caps.codecs.filter((c) => !/h264/i.test(c.mimeType))]);
      return;
    }
    const want = `video/${sess.quality.codec}`.toLowerCase();
    const pref = caps.codecs.filter((c) => c.mimeType.toLowerCase() === want);
    const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== want);
    if (pref.length) tr.setCodecPreferences([...pref, ...rest]);
  } catch (e) { console.warn("codec pref failed", e); }
}

// ─── Host side ────────────────────────────────────────────
// One outstanding access-password challenge at a time, plus a brute-force cool-down PER REQUESTER: a global
// counter let any stranger who knew the ID lock everyone out (including people with the right password).
let pendingChallenge = null;      // { fromId, fromName, nonce, expires, _t }
const pwFail = new Map();         // requester id -> { count, until }
let autoAcceptWithPassword = true, bruteForceGuard = true;   // Settings → Koneksi / Keamanan
// A LAN requester gets a new id per socket ("lan-in:<ip>#n"): count its wrong answers per address, not per socket.
const pwKey = (id) => String(id).replace(/#\d+$/, "");
const pwBlocked = (id) => { const f = pwFail.get(pwKey(id)); return !!f && f.until > Date.now(); };
// A SECOND, requester-independent budget. The per-id cool-down above is defeated by an attacker who
// rotates its requester ID (the signaling server hands any token-less socket a fresh ID), so wrong
// answers also count toward one global tally. Once it trips, the password challenge is withheld and
// the host falls back to manual Accept — a person at the PC can still let someone in, but automated
// guessing gets no HMAC oracle at all. Verified: rotating-ID guessing no longer bypasses the limit.
const PW_GLOBAL_MAX = 12;                      // total wrong answers (any requester) before withholding the challenge
const PW_GLOBAL_WINDOW = 10 * 60 * 1000;
// One budget per path: wrong answers over the LAN must not switch off password auto-accept for ID callers, and an
// internet attacker who knows the ID must not lock the owner out of LAN connections.
let pwGlobalFail = { id: { count: 0, until: 0, first: 0 }, lan: { count: 0, until: 0, first: 0 } };
const pwPath = (id) => (lanIn(id) ? "lan" : "id");
const pwGlobalBlocked = (id) => bruteForceGuard && pwGlobalFail[pwPath(id)].until > Date.now();
function pwGlobalReset() { pwGlobalFail = { id: { count: 0, until: 0, first: 0 }, lan: { count: 0, until: 0, first: 0 } }; }
function pwFailed(id) {
  if (!bruteForceGuard) return;
  id = pwKey(id);
  const f = pwFail.get(id) || { count: 0, until: 0 };
  f.count++;
  // 3rd wrong answer: 5 minutes; every further one adds 5 more (capped at 20).
  if (f.count >= 3) f.until = Date.now() + Math.min(20, 5 * (f.count - 2)) * 60 * 1000;
  pwFail.set(id, f);
  if (pwFail.size > 500) pwFail.delete(pwFail.keys().next().value);
  // Global tally (rolling window): withhold the challenge for 10 min once too many wrong answers pile up.
  const now = Date.now();
  const g = pwGlobalFail[pwPath(id)];
  if (now - g.first > PW_GLOBAL_WINDOW) { g.count = 0; g.until = 0; g.first = now; }
  g.count++;
  if (g.count >= PW_GLOBAL_MAX) g.until = now + PW_GLOBAL_WINDOW;
}

async function handleIncoming(msg) {
  if (updateRequired) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "PC tujuan memakai versi TryDesk lama yang wajib diperbarui" }); return; }
  // The Linux build can control other PCs but can't be controlled yet (screen capture + input are Windows code).
  if (viewerOnlyDesktop()) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "PC ini memakai TryDesk untuk Linux, yang saat ini hanya bisa mengontrol PC lain" }); return; }
  // An accept dialog or password challenge is already in flight for another requester — reject this
  // one instead of stacking (which would corrupt state and double-start a session).
  // Exception: a LAN password round in progress never makes the PC "busy" for someone asking by ID — a stranger on
  // the network could otherwise keep it busy for everyone. The LAN requester gives way and can try again.
  if (pendingChallenge && lanIn(pendingChallenge.fromId) && !lanIn(msg.fromId) && !pendingChallenge.settle && !acceptPending) {
    const pc = pendingChallenge; clearTimeout(pc._t); pendingChallenge = null;
    sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Remote desktop sedang sibuk" });
  }
  if (acceptPending || pendingChallenge) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Remote desktop sedang sibuk" }); return; }
  if (host) {
    // Only truly busy if the existing peer connection is still alive. Otherwise it's a stale
    // session left over from an abrupt drop — clear it and accept the new request (no restart needed).
    // No pc yet = the previous accept is still setting up capture: that is busy, not stale.
    const alive = !host.pc || ["new", "connecting", "connected"].includes(host.pc.connectionState);
    if (alive) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Remote desktop sedang sibuk" }); return; }
    closeSession(host, false);
  }
  // Brute-force cool-down after repeated wrong passwords.
  if (pwBlocked(msg.fromId)) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Terlalu banyak percobaan, coba lagi nanti" }); return; }

  const savedHash = store.get("accessPasswordHash");
  // Over LAN nobody vouches for the requester (no server, no ID): only the access password lets it in.
  if (lanIn(msg.fromId)) {
    const why = !lanHostOn ? "Koneksi LAN tidak diaktifkan di PC tujuan"
      : !(savedHash && savedHash.includes(":")) ? "PC tujuan belum memasang password akses — koneksi lewat IP membutuhkan password"
      : !lanPwStrong() ? `PC tujuan perlu password akses minimal ${LAN_PW_MIN} karakter untuk koneksi lewat IP`
      : pwGlobalBlocked(msg.fromId) ? "Terlalu banyak percobaan, coba lagi nanti" : "";
    if (why) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: why }); return; }
  }
  if (savedHash && savedHash.includes(":") && !pwGlobalBlocked(msg.fromId)) {
    // Password set → server-blind challenge. Relay only the salt + a one-shot nonce; we accept only
    // once the viewer returns a valid HMAC (proving it knows the password) — the password never travels.
    const nonce = _hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const salt = savedHash.split(":")[0];
    pendingChallenge = { fromId: msg.fromId, fromName: msg.fromName, nonce, salt, round: 0, settle: null, started: Date.now() };
    pendingChallenge._t = setTimeout(() => {
      if (pendingChallenge && pendingChallenge.fromId === msg.fromId) {
        sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Waktu verifikasi habis" });
        pendingChallenge = null;
      }
    }, 30000);
    sendSignal({ type: "connection-challenge", targetId: msg.fromId, salt, nonce });
    return;
  }
  // No password (or a legacy unsalted hash that can't do HMAC) → ask the user to accept manually.
  const accepted = await askAccept(msg.fromId, msg.fromName);
  if (!accepted) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: declineReason() }); return; }
  await finishAccept(msg.fromId);
}

// Verify the viewer's HMAC answer to our challenge (AnyDesk-style flow):
//  · right password → straight in (or it answers the Accept dialog if that is already up);
//  · no password / wrong one → the owner gets the Accept dialog AND the requester is asked again, so they can
//    still type the password on their side — whichever comes first wins. Wrong answers count toward the
//    per-requester cool-down; once that trips, the request is refused.
const PW_HINT = {
  empty: "Peminta tidak memasukkan password akses. Ia masih bisa mengetiknya — bila benar, koneksi langsung diterima.",
  emptyManual: "Peminta tidak memasukkan password akses.",
  wrong: "Peminta memasukkan password yang salah dan bisa mencoba lagi.",
  okManual: "Password benar, tetapi \"Terima koneksi otomatis\" dimatikan di Pengaturan — jadi tetap perlu konfirmasi.",
};
async function handleChallengeResponse(msg) {
  const pc = pendingChallenge;
  if (!pc || pc.fromId !== msg.fromId || !pc.nonce) return;   // no challenge outstanding for this peer
  clearTimeout(pc._t);
  const nonce = pc.nonce;
  pc.nonce = null; pc.round++;                                  // one answer per nonce
  const response = typeof msg.response === "string" ? msg.response : "";
  const expected = await expectedChallenge(store.get("accessPasswordHash"), nonce);
  const empty = !response || _constEq(response, await answerChallenge("", pc.salt, nonce));
  if (pendingChallenge !== pc) return;                          // cancelled / hosting stopped meanwhile
  // LAN switched off (or the password weakened) while this request was in its password rounds: it ends here.
  if (lanIn(pc.fromId) && (!lanHostOn || !lanPwStrong())) {
    pendingChallenge = null;
    sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Koneksi LAN tidak diaktifkan di PC tujuan" });
    return;
  }
  if (!empty && expected && _constEq(response, expected)) {
    pwFail.delete(pwKey(pc.fromId));
    if (!autoAcceptWithPassword) { if (!pc.settle) askOwner(pc, PW_HINT.okManual); return; }
    if (pc.settle) pc.settle(true);
    else { pendingChallenge = null; await finishAccept(pc.fromId); }
    return;
  }
  if (!empty) {
    await sleep(1000);                         // throttle: a wrong answer costs a fixed second, capping guess rate
    if (pendingChallenge !== pc) return;       // cancelled / hosting stopped during the delay
    pwFailed(pc.fromId);
    if (pwBlocked(pc.fromId) || pwGlobalBlocked(pc.fromId)) {
      const why = "Terlalu banyak percobaan, coba lagi nanti";
      if (pc.settle) pc.settle(false, why);
      else { pendingChallenge = null; sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: why }); }
      return;
    }
  }
  // LAN: no Accept dialog for a stranger on the network — the requester simply gets asked for the password again.
  // An empty answer after the first round counts as a wrong one too (an idle requester must not hold the PC), and
  // the whole exchange ends after 90 s or 8 rounds, matching the socket's own 90 s limit in main.js.
  if (lanIn(pc.fromId)) {
    if (empty && pc.round > 1) {
      pwFailed(pc.fromId);
      if (pwBlocked(pc.fromId) || pwGlobalBlocked(pc.fromId)) { pendingChallenge = null; sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Terlalu banyak percobaan, coba lagi nanti" }); return; }
    }
    const left = 90000 - (Date.now() - (pc.started || Date.now()));
    if (pc.round >= 8 || left <= 0) { pendingChallenge = null; sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: pc.round >= 8 ? "Terlalu banyak percobaan, coba lagi nanti" : "Waktu verifikasi habis" }); return; }
    pc.nonce = _hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    pc._t = setTimeout(() => { if (pendingChallenge === pc) { pendingChallenge = null; sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Waktu verifikasi habis" }); } }, left);
    sendSignal({ type: "connection-challenge", targetId: pc.fromId, salt: pc.salt, nonce: pc.nonce });
    return;
  }
  const hint = !empty ? PW_HINT.wrong : autoAcceptWithPassword ? PW_HINT.empty : PW_HINT.emptyManual;
  if (!pc.settle) askOwner(pc, hint); else if (!empty) setAcceptHint(hint);
  // Ask the requester again only when a password would still get them in. After an empty answer only on the
  // first round: an older TryDesk answers every challenge "empty" by itself, which would ping-pong forever.
  if (autoAcceptWithPassword && (!empty || pc.round === 1) && pc.round < 8) {
    pc.nonce = _hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    sendSignal({ type: "connection-challenge", targetId: pc.fromId, salt: pc.salt, nonce: pc.nonce });
  }
}

// The owner's Accept dialog for a password-protected request. A correct password typed meanwhile settles it.
async function askOwner(pc, hint) {
  let reason = "";
  const asked = askAccept(pc.fromId, pc.fromName, hint);
  pc.settle = (ok, why) => { if (why) reason = why; if (acceptDlgSettle) acceptDlgSettle(ok); };
  const ok = await asked;
  if (!reason) reason = declineReason();
  if (pendingChallenge === pc) pendingChallenge = null;
  if (ok) await finishAccept(pc.fromId);
  else sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason });
}

// Build the host session + capture + peer once a requester is authorized (manual accept or challenge).
async function finishAccept(fromId) {
  const sess = new Session(fromId, "host");
  host = sess;
  // A LAN session checks the viewer's offers against the password key (the requester proved it knows it), and its
  // socket now outlives main.js's 90 s limit for requests that never became a session.
  if (lanIn(fromId)) { sess.lanKey = String(store.get("accessPasswordHash") || "").split(":")[1] || ""; try { window.electronAPI.lanKeep(fromId); } catch {} }
  sessLog(sess, "accepted here, starting screen capture");
  try {
    sess.monitors = await window.electronAPI.getMonitors();
    sess.currentMonitor = Math.max(0, sess.monitors.findIndex((m) => m.primary));
    const { stream, m } = await hostCapture(sess, sess.currentMonitor, true);
    // Hosting was stopped while capture was starting — release the screen instead of streaming it to nobody.
    if (host !== sess) { stream.getTracks().forEach((t) => t.stop()); return; }
    sess.localStream = stream;
    sess.videoTrack = stream.getVideoTracks()[0];
    sess.audioAvailable = stream.getAudioTracks().length > 0;
    hostCaptureHeight = sess.videoTrack.getSettings().height || Math.round(m.height * m.scaleFactor);
    window.electronAPI.setCaptureDisplay(m);
    // One-time hint: an un-elevated host can't control admin/UAC windows (they "freeze" remote control).
    if (!_adminTipShown) { _adminTipShown = true; try { window.electronAPI.isElevated().then((el) => { if (!el) showToast("Tip: agar jendela admin bisa dikontrol, jalankan TryDesk sebagai administrator (Pengaturan → Keamanan)"); }).catch(() => {}); } catch {} }
  } catch (err) {
    console.error(err);
    sendSignal({ type: "connection-rejected", targetId: fromId, reason: "Remote gagal membagikan layar" });
    closeSession(sess, false); return;
  }

  createPeer(sess);
  const pc = sess.pc;
  sess.localStream.getTracks().forEach((t) => pc.addTrack(t, sess.localStream));
  // Configure the encoder up-front (maintain-resolution + full bitrate) so the first frames are
  // already full native resolution, instead of waiting for the viewer's quality message to arrive.
  applyQualityToSender(sess, hostQuality);
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    if (ch.label === "file") {
      sess.fileChannel = ch;
      sess.fileChannel.binaryType = "arraybuffer";
      setupFileChannel(sess, sess.fileChannel);
    } else if (ch.label === "move") {
      // Pointer position only, unordered and never resent: a lost or late move is just skipped (the next one
      // carries the newer position), so one dropped packet no longer stalls every move behind it.
      sess.moveChannel = ch;
      ch.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } if (ev && ev.action === "mousemove") onHostMove(sess, ev); };
    } else {
      sess.dataChannel = ch;
      sess.dataChannel.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } onCtrlMessage(sess, ev); };
      // caps: tells a 1.2.3+ viewer this host takes pointer moves on the separate "move" channel. An older
      // viewer ignores it; an older host never sends it, so a new viewer keeps everything on this channel.
      const onCtrlOpen = () => { try { sess.dataChannel.send(JSON.stringify({ __ctrl: "caps", move: 1 })); } catch {} startClipboardSync(sess); sendMonitors(sess); try { window.electronAPI.requestCursorState && window.electronAPI.requestCursorState(); } catch {} try { window.electronAPI.requestAdminWindowState?.(); } catch {} };
      sess.dataChannel.onopen = onCtrlOpen;
      if (sess.dataChannel.readyState === "open") onCtrlOpen();
    }
  };

  $("#hosting-text").textContent = "Desktop Anda sedang dikontrol";
  $("#hosting-peer-id").textContent = fmtId(sess.peerId);
  showScreen("hosting");
  startHostingTimer();
  sendSignal({ type: "connection-accepted", targetId: sess.peerId });
  // If the viewer never sets up the call (it vanished between asking and our accept), don't stay "being
  // controlled" — capturing the screen and turning everyone else away as busy. Only for a call that never
  // connected: a live one that is briefly "disconnected" at 30 s gets the normal 5 s grace instead.
  setTimeout(() => { if (host === sess && !sess.everConnected && (!sess.pc || sess.pc.connectionState !== "connected")) closeSession(sess, false); }, 30000);
  window.electronAPI.setHostingState(true);
  // Settings: keep the display awake while being controlled; end the session after the chosen time limit.
  if (prefGet("preventSleep")) window.electronAPI.setPowerSave(true);
  sess.hostStart = Date.now();
  armSessionLimit(sess);
  // Upload too thin for the full picture: "maintain-resolution" then sheds frame rate and the viewer sees a
  // choppy screen. The encoder itself reports it (qualityLimitationReason "bandwidth"): after ~4 s of that, go
  // "balanced" (a little resolution for steady motion); back to sharp after ~16 s without it.
  clearInterval(sess._qlTimer);
  sess._qlTimer = setInterval(async () => {
    if (host !== sess || !sess.pc) { clearInterval(sess._qlTimer); return; }
    let out = null;
    try { (await sess.pc.getStats()).forEach((s) => { if (s.type === "outbound-rtp" && s.kind === "video") out = s; }); } catch { return; }
    if (!out) return;
    const bw = out.qualityLimitationReason === "bandwidth";
    sess._bwStreak = bw ? (sess._bwStreak || 0) + 1 : 0;
    sess._okStreak = bw ? 0 : (sess._okStreak || 0) + 1;
    const want = sess._bwLimited ? sess._okStreak < 8 : sess._bwStreak >= 2;
    if (want !== !!sess._bwLimited) { sess._bwLimited = want; capLog(`upload-limited=${want}`); applyQualityToSender(sess, hostQuality); }
  }, 2000);
}
// Settings → Keamanan → session time limit, counted from the start of the session; changing it while a session
// runs re-arms it. The viewer is told why it was cut off.
function armSessionLimit(sess) {
  if (!sess || sess.role !== "host") return;
  clearTimeout(sess.limitTimer);
  const limitMin = Number(prefGet("sessionLimit")) || 0;
  if (limitMin <= 0) return;
  const left = Math.max(1000, (sess.hostStart || Date.now()) + limitMin * 60 * 1000 - Date.now());
  sess.limitTimer = setTimeout(() => {
    if (host === sess) { showToast("Batas waktu sesi tercapai — koneksi diputus"); closeSession(sess, true, "Batas waktu sesi di PC remote tercapai — koneksi diputus"); }
  }, left);
}

async function onOffer(sess, offer) {
  await sess.pc.setRemoteDescription(offer);
  flushCandidates(sess);
  const answer = await sess.pc.createAnswer();
  answer.sdp = boostStartBitrate(answer.sdp);   // host is the video sender — jump to full res immediately
  await sess.pc.setLocalDescription(answer);
  sendSignal({ type: "answer", targetId: sess.peerId, answer: sess.pc.localDescription });
}

// Host-side access permissions — what an incoming remote may do to THIS machine. These are the
// authoritative gates (the viewer's own toggles can be bypassed by a modified client), loaded from
// Settings → Keamanan → Izin akses. See applyAccessSettings().
let allowInput = true, allowFileTransfer = true, allowClipboardPref = true, forceViewOnly = false;

// Control channel router (runs on both sides); bound per session at channel setup.
function onCtrlMessage(sess, ev) {
  if (!ev || typeof ev !== "object") return;   // reject null / non-object payloads
  if (ev.__ctrl === "quality") { if (sess.role === "host") applyQualityToSender(sess, ev); }
  else if (ev.__ctrl === "net-mode") { if (sess.role === "host" && !!ev.degraded !== !!sess._netDegraded) { sess._netDegraded = !!ev.degraded; capLog(`net-mode degraded=${sess._netDegraded}`); applyQualityToSender(sess, hostQuality); } }
  else if (ev.__ctrl === "clipboard") { applyRemoteClipboard(sess, ev.text); }
  else if (ev.__ctrl === "monitors") { if (sess.role === "viewer") showMonitors(sess, ev); }
  else if (ev.__ctrl === "select-monitor") { if (sess.role === "host") switchMonitor(sess, ev.index); }
  else if (ev.__ctrl === "game-auto") { if (sess.role === "viewer") setAutoGame(sess, !!ev.on); }
  else if (ev.__ctrl === "admin-window") { if (sess.role === "viewer") { sess.adminWindow = !!ev.on; renderAdminBanner(); } }
  else if (ev.__ctrl === "chat") { onChatReceived(sess, ev.text); }
  else if (ev.__ctrl === "black-screen") { if (sess.role === "host") handleBlackScreen(sess, ev.enabled); }
  else if (ev.__ctrl === "lock-input") { if (sess.role === "host") handleLockInput(sess, ev.enabled); }
  else if (ev.__ctrl === "privacy-result") { if (sess.role === "viewer") onPrivacyResult(sess, ev); }
  else if (ev.__ctrl === "fs-req") { handleFsRequest(sess, ev); }
  else if (ev.__ctrl === "fs-res") { handleFsResponse(sess, ev); }
  else if (ev.__ctrl === "bye") { onBye(sess, ev.reason); }
  else if (ev.__ctrl === "caps") {
    // The host takes pointer moves on an unordered, never-resent channel (see onHostMove).
    if (sess.role === "viewer" && ev.move && !sess.moveChannel && sess.pc) {
      try { sess.moveChannel = sess.pc.createDataChannel("move", { ordered: false, maxRetransmits: 0 }); } catch (e) { console.warn("move channel", e); }
    }
  }
  else if (ev.action === "mousemove" && sess.role === "host") onHostMove(sess, ev);
  // Anything else is a remote input event — only execute it when WE are the host AND control is
  // permitted. A modified viewer cannot force input past this host-side gate.
  else if (sess.role === "host" && allowInput && !forceViewOnly) window.electronAPI.executeInput(ev);
}

// Absolute pointer moves arrive on two channels (hover moves on "move", the move just before a click on "ctrl")
// and "move" may reorder them: each carries a sequence number, and anything older than the newest seen is
// dropped, so a late packet can never pull the cursor back to where it was.
function onHostMove(sess, ev) {
  if (sess.role !== "host" || !allowInput || forceViewOnly) return;
  if (Number.isSafeInteger(ev.s)) {
    if (ev.s <= (sess._moveSeq ?? -1)) return;
    sess._moveSeq = ev.s;
  }
  window.electronAPI.executeInput(ev);
}

// ─── Remote filesystem browsing (serves the peer's file manager) ───
// Only the HOST (the machine being controlled) serves its filesystem, and only when file transfer
// is permitted — a machine must never expose its own files to a host it connected OUT to.
async function handleFsRequest(sess, ev) {
  if (sess.role !== "host") return;
  if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  if (!hostFilesAllowed()) { try { sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-res", reqId: ev.reqId, res: { ok: false, error: "Transfer file dinonaktifkan di host", path: ev.path, display: ev.path || "" } })); } catch {} return; }
  let res;
  try {
    const target = ev.home ? await window.electronAPI.fsHome() : ev.path;
    res = await window.electronAPI.fsList(target);
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e), path: ev.path, display: ev.path || "" };
  }
  // A data-channel message is capped at 256 KB, so a big folder (System32, a full Downloads) failed to send
  // and the viewer just timed out. Send it in parts the viewer stitches back together.
  const one = JSON.stringify({ __ctrl: "fs-res", reqId: ev.reqId, res });
  if (new Blob([one]).size <= FS_PART_BYTES || !res.ok || !Array.isArray(res.entries)) { try { sess.dataChannel.send(one); } catch {} return; }
  const parts = [];
  let cur = [], curBytes = 0;
  for (const e of res.entries) {
    const b = new Blob([JSON.stringify(e)]).size + 1;
    if (cur.length && curBytes + b > FS_PART_BYTES - 4096) { parts.push(cur); cur = []; curBytes = 0; }
    cur.push(e); curBytes += b;
  }
  if (cur.length) parts.push(cur);
  for (let i = 0; i < parts.length; i++) {
    while (sess.dataChannel && sess.dataChannel.bufferedAmount > BUFFER_HIGH) await sleep(20);
    try { sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-res", reqId: ev.reqId, part: i, parts: parts.length, res: { ...res, entries: parts[i] } })); } catch { return; }
  }
}
const FS_PART_BYTES = 200_000;

function requestRemoteList(sess, { path = null, home = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return reject(new Error("no-channel"));
    const reqId = `fs${++sess.fsReqSeq}`;
    const timer = setTimeout(() => { sess.fsPending.delete(reqId); reject(new Error("timeout")); }, 15000);
    sess.fsPending.set(reqId, { resolve, reject, timer });
    sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-req", reqId, path, home }));
  });
}

function handleFsResponse(sess, ev) {
  const reqId = ev.reqId;
  const p = sess.fsPending.get(reqId);
  if (!p) return;
  let res = ev.res;
  // Multi-part listing (big folder): collect every part, then resolve with all entries in order.
  const parts = Number(ev.parts);
  if (Number.isInteger(parts) && parts > 1 && parts <= 1000 && Number.isInteger(ev.part) && ev.part >= 0 && ev.part < parts && res) {
    p.got = p.got || new Array(parts);
    p.got[ev.part] = Array.isArray(res.entries) ? res.entries : [];
    p.head = p.head || res;
    if (p.got.filter(Boolean).length < parts) return;
    res = { ...p.head, entries: p.got.flat() };
  }
  clearTimeout(p.timer);
  sess.fsPending.delete(reqId);
  p.resolve(res);
}

// ─── Host: multi-monitor capture ──────────────────────────
// Capture breadcrumbs in the app log (%APPDATA%\TryDesk\trydesk-crash.log): which monitor/source/path was
// grabbed and why each re-capture happened — how a client PC's monitor-switch or flicker report is diagnosed.
function capLog(msg) { try { window.electronAPI.logInfo("capture " + msg); } catch {} }
// Session steps in the local log (no passwords, no screen content), so a failed connection can be traced later.
function sessLog(sess, msg) { try { window.electronAPI.logInfo(`session ${sess.role} ${sess.peerId}: ${msg}`); } catch {} }

// getDisplayMedia with a deadline: capture swaps run one at a time, so a request main never answers must
// not stall every later swap. A stream that shows up after the deadline is stopped, not leaked.
function displayMediaWithTimeout(constraints, ms = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(new Error("getDisplayMedia timeout")); }, ms);
    navigator.mediaDevices.getDisplayMedia(constraints).then(
      (s) => { if (done) { s.getTracks().forEach((t) => t.stop()); return; } done = true; clearTimeout(timer); resolve(s); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
  });
}

async function hostCapture(sess, index, withAudio) {
  const m = sess.monitors[index] || sess.monitors[0];
  // Capture at the frame rate the CHOSEN PRESET needs (not always max), so GPU/encode load tracks the
  // user's quality choice. HIGH-REFRESH (144/165/180/240) is possible ONLY via getDisplayMedia (the modern
  // capture path). The legacy desktopCapturer mandatory maxFrameRate hard-caps at 120 (>120 silently falls
  // back to 30fps, measured), so getDisplayMedia is primary and desktopCapturer is the fallback (≤120).
  const CAPTURE_FPS_MAX = 240;
  const IDLE_MIN_FPS = 12;   // keep a static screen fresh (cheap repeat frames) → no stale frame / resume stutter
  const wantFps = Math.max(30, Math.min(CAPTURE_FPS_MAX, Math.round(hostQuality.fps || 60)));
  const W = Math.round(m.width * m.scaleFactor), H = Math.round(m.height * m.scaleFactor);
  let stream, via = "gdm";
  try {
    // Tell main which screen to hand getDisplayMedia (awaited, so it's set before the request), then grab it.
    // getDisplayMedia honors frameRate up to the display refresh — this is what unlocks >120 fps.
    if (!(await window.electronAPI.setDisplayMediaSource(m.sourceId, m.displayId))) throw new Error("monitor not exposed as a capture source");
    // NOTE: getDisplayMedia does NOT support frameRate.min ("min constraints are not supported") — only
    // ideal/max. (The idle-freshness min stays on the legacy fallback below, which does support it.)
    const videoC = { width: { ideal: W }, height: { ideal: H }, frameRate: { ideal: wantFps, max: wantFps } };
    // Audio is best-effort: if loopback audio capture is unsupported, keep the HIGH-FPS video instead of
    // falling all the way back to the ≤120fps legacy path.
    try { stream = await displayMediaWithTimeout({ video: videoC, audio: !!withAudio }); }
    catch (eA) { if (withAudio) { stream = await displayMediaWithTimeout({ video: videoC, audio: false }); } else { throw eA; } }
  } catch (e) {
    console.warn("getDisplayMedia failed, falling back to legacy desktopCapturer (<=120fps):", e.message);
    via = "legacy"; capLog(`gdm failed (${e.message}) -> legacy`);
    const legacyFps = Math.min(120, wantFps);   // legacy ceiling
    const base = { chromeMediaSource: "desktop", chromeMediaSourceId: m.sourceId, maxWidth: W, maxHeight: H, maxFrameRate: legacyFps };
    const mkVideo = (withMin) => ({ mandatory: withMin ? { ...base, minFrameRate: IDLE_MIN_FPS } : { ...base } });
    const tryGet = async (withMin) => {
      if (withAudio) {
        try { return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "desktop" } }, video: mkVideo(withMin) }); }
        catch (e2) { console.warn("audio capture gagal, video saja:", e2.message); }
      }
      return navigator.mediaDevices.getUserMedia({ audio: false, video: mkVideo(withMin) });
    };
    try { stream = await tryGet(true); }
    catch (e3) { console.warn("capture with minFrameRate failed, retrying without:", e3.message); stream = await tryGet(false); }
  }
  // "motion" tells the encoder to favor smooth frame rate over static sharpness —
  // essential for responsive control, video and gaming (default treats desktop as "detail").
  const vt = stream.getVideoTracks()[0];
  if (vt) vt.contentHint = "motion";
  // The ceiling we ASKED for drives the re-capture decision. Not the negotiated rate: that stays below the
  // preset whenever the display refreshes slower (240 on a 165Hz screen), which made every quality/net-mode
  // message trigger yet another re-capture.
  hostCaptureFps = wantFps;
  const got = (vt && vt.getSettings()) || {};
  capLog(`mon=${index} ${m.label || ""} src=${m.sourceId} via=${via} want=${W}x${H}@${wantFps} got=${got.width}x${got.height}@${Math.round(got.frameRate || 0)}`);
  return { stream, m };
}

function sendMonitors(sess) {
  if (sess.role !== "host" || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.dataChannel.send(JSON.stringify({
    __ctrl: "monitors",
    list: sess.monitors.map((m) => ({ index: m.index, label: m.label, primary: m.primary })),
    current: sess.currentMonitor,
    audio: sess.audioAvailable,
    // What this host really permits, so the viewer can say so instead of silently dropping clicks and keys.
    perms: { control: hostControlAllowed(), files: hostFilesAllowed() },
  }));
}

// Re-grab the host screen (new monitor or higher capture fps) and swap the video sender track.
// Swaps are SERIALIZED per session: overlapping re-captures (a monitor switch while a quality message
// re-captures for fps) raced on main's single getDisplayMedia source, and the older one could finish last
// and swap the PREVIOUS monitor back in. index null = whatever monitor is current when the swap runs;
// onlyIfChanged skips a swap to the monitor already streaming (checked in order, after earlier swaps land).
// reason is logged: repeated swaps are a stream reset each, so the log shows what caused a flicker.
function replaceCaptureTrack(sess, index, onlyIfChanged = false, reason = "") {
  const run = sess.capChain.then(() => {
    const i = index == null ? Math.min(sess.currentMonitor, Math.max(0, sess.monitors.length - 1)) : index;
    if (onlyIfChanged && i === sess.currentMonitor) return;
    capLog(`swap (${reason}) mon ${sess.currentMonitor} -> ${i}`);
    return swapCaptureTrack(sess, i);
  });
  sess.capChain = run.catch(() => {});
  return run;
}

async function swapCaptureTrack(sess, index) {
  const sender = sess.pc && sess.pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  const { stream, m } = await hostCapture(sess, index, false);
  const newVideo = stream.getVideoTracks()[0];
  // The session may have closed while this swap waited its turn — release the screen instead of leaking it.
  if (!sess.pc || sess.pc.connectionState === "closed") { stream.getTracks().forEach((t) => t.stop()); return; }
  await sender.replaceTrack(newVideo);
  if (sess.videoTrack) sess.videoTrack.stop();
  sess.videoTrack = newVideo;
  // Keep localStream's video in sync (audio track preserved) so later applyConstraints target the live track
  if (sess.localStream) { sess.localStream.getVideoTracks().forEach((t) => sess.localStream.removeTrack(t)); sess.localStream.addTrack(newVideo); }
  sess.currentMonitor = index;
  hostCaptureHeight = newVideo.getSettings().height || Math.round(m.height * m.scaleFactor);
  // Remember exactly what we're capturing so a spurious display-metrics event (same size) doesn't trigger
  // a needless re-capture — each re-capture is a real video reset the viewer sees as a flicker.
  sess._capW = m.width; sess._capH = m.height; sess._capSF = m.scaleFactor;
  window.electronAPI.setCaptureDisplay(m);
}

async function switchMonitor(sess, index) {
  if (!Number.isInteger(index) || index < 0 || index >= sess.monitors.length || !sess.pc) return;
  try { await replaceCaptureTrack(sess, index, true, "switch"); applyQualityToSender(sess, hostQuality); }
  catch (e) { console.error("switchMonitor gagal", e); }
  // Report the monitor actually being streamed, so the viewer's picker never claims a switch that failed.
  sendMonitors(sess);
}

// Clamp a peer-supplied quality field to a sane range (a view-only viewer must not be able to poison the
// global hostQuality with fps:1e400 and force an endless re-capture storm). NaN / non-number → keep current.
const _clampNum = (v, lo, hi, cur) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : cur; };
async function applyQualityToSender(sess, q) {
  q = q || {};
  hostQuality = {
    bitrate: _clampNum(q.bitrate, 0.1, 200, hostQuality.bitrate),
    fps: Math.round(_clampNum(q.fps, 1, 240, hostQuality.fps)),
    resHeight: _clampNum(q.resHeight, 0, 4320, hostQuality.resHeight),
  };
  const sender = sess.pc && sess.pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  // If a higher frame rate than the current capture cap is requested, re-capture — the
  // mandatory maxFrameRate set at getUserMedia time is a hard ceiling that applyConstraints can't raise.
  if (hostQuality.fps > hostCaptureFps) {
    try { await replaceCaptureTrack(sess, null, false, `fps ${hostQuality.fps}`); } catch (e) { console.warn("recapture for fps failed", e); }
  }
  const setEncoder = () => {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    // Good network → keep the remote screen SHARP at native resolution (drop FPS, not resolution). Unstable
    // network (high loss/RTT, the viewer signals it via the "net-mode" control) → switch to "balanced" so
    // WebRTC can shed RESOLUTION and keep the picture MOVING instead of freezing at full res @ ~6fps — far
    // friendlier on bad/relay links. (maintain-framerate downscaled to 640x360 on connect, so we avoid it.)
    params.degradationPreference = sess._netDegraded || sess._bwLimited ? "balanced" : "maintain-resolution";
    const enc = params.encodings[0];
    // Settings → Koneksi → upload bandwidth limit caps whatever the viewer asks for.
    const capMbps = Number(prefGet("bwLimit")) || 0;
    const mbps = capMbps > 0 ? Math.min(hostQuality.bitrate, capMbps) : q.bitrate;
    if (mbps != null) enc.maxBitrate = Math.round(mbps * 1_000_000);
    if (q.fps != null) enc.maxFramerate = q.fps;
    enc.networkPriority = "high";
    if (q.resHeight != null) {
      enc.scaleResolutionDownBy = (q.resHeight > 0 && hostCaptureHeight > q.resHeight)
        ? +(hostCaptureHeight / q.resHeight).toFixed(3) : 1;
    }
    return sender.setParameters(params);
  };
  // Overlapping quality updates (connect + the viewer's first quality message, net-mode flips) can invalidate
  // the parameters this call read ("getParameters() has never been called"), silently dropping the bitrate/fps/
  // degradation settings. Re-read and apply once more so the encoder never keeps stale settings.
  try { await setEncoder(); }
  catch (e) { try { await setEncoder(); } catch (e2) { console.warn("setParameters failed", e2); capLog("setParameters failed: " + e2.message); } }
  if (q.fps != null) {
    const vt = sess.localStream && sess.localStream.getVideoTracks()[0];
    if (vt) vt.applyConstraints({ frameRate: { ideal: q.fps, max: q.fps } }).catch(() => {});
  }
}

// Host display resolution/scale changed → refresh the monitor list and re-capture the current
// screen so the stream resets at the new size (clean keyframe) and input mapping stays correct.
let displayRecapturing = false;
if (window.electronAPI && window.electronAPI.onDisplayChanged) {
  window.electronAPI.onDisplayChanged(async () => {
    const sess = host;
    if (!sess || sess.role !== "host" || !sess.pc || displayRecapturing) return;
    displayRecapturing = true;
    try {
      sess.monitors = await window.electronAPI.getMonitors();
      const idx = Math.min(sess.currentMonitor, Math.max(0, sess.monitors.length - 1));
      const mon = sess.monitors[idx];
      // Only re-capture when the monitor we're streaming actually changed resolution/scale. Fullscreen games
      // and sandboxes fire display-metrics repeatedly with NO real size change — re-capturing on those was
      // the main cause of the "berkedip-kedip" flicker during gameplay. Skip the no-op events.
      if (mon && sess._capW === mon.width && sess._capH === mon.height && sess._capSF === mon.scaleFactor) {
        sendMonitors(sess);   // keep the list fresh, but don't reset the stream
      } else {
        await replaceCaptureTrack(sess, null, false, "display changed");
        applyQualityToSender(sess, hostQuality);
        sendMonitors(sess);
      }
    } catch (e) { console.warn("display-changed recapture failed", e); }
    finally { displayRecapturing = false; }
  });
}

// Reflect the current session state on the user's Discord profile (hosting / viewing / idle).
function updateDiscordPresence() {
  try {
    const live = (s) => s && s.pc && ["new", "connecting", "connected"].includes(s.pc.connectionState);
    let st = "idle";
    if (live(host)) st = "hosting";                                  // someone is controlling THIS pc
    for (const s of sessions.values()) { if (live(s)) { st = "viewing"; break; } }  // we're controlling a pc (takes precedence)
    window.electronAPI && window.electronAPI.setDiscordActivity && window.electronAPI.setDiscordActivity(st);
  } catch {}
}

// ─── Shared WebRTC ────────────────────────────────────────
function createPeer(sess) {
  // Settings → Koneksi → Protokol: "p2p" never uses a relay (TURN entries dropped); "relay" forces every packet
  // through TURN (only works when the server hands out TURN credentials).
  const proto = prefGet("protocol");
  const allServers = [...config.iceServers, ...serverIceServers];
  const iceServers = proto === "p2p" ? allServers.filter((s) => ![].concat(s.urls || []).some((u) => /^turns?:/i.test(u))) : allServers;
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: proto === "relay" ? "relay" : "all" });
  sess.pc = pc;
  sess.pendingCandidates = [];
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: "ice-candidate", targetId: sess.peerId, candidate: e.candidate }); };
  // Accepted but the peer-to-peer link never comes up (the other side stuck or gone): end it on both sides after
  // 30 s with a clear message. Before, the tab waited forever and the server kept showing the pair as "controlling".
  clearTimeout(sess.p2pTimer);
  if (!sess.everConnected) sess.p2pTimer = setTimeout(() => {
    if (sess.pc !== pc || sess.everConnected) return;
    sessLog(sess, `no P2P link after 30 s (state ${pc.connectionState}, ice ${pc.iceConnectionState}) — ending`);
    const fg = sess === active || sess.role === "host";
    // An auto-reconnect attempt that doesn't come up just counts as a failed try: no "bye" (that would stop
    // the retries on both ends), the next attempt follows.
    if (sess.isReconnect && sess.role === "viewer") { closeSession(sess, false); reconnectFailed(sess, "no p2p"); return; }
    closeSession(sess, true, "Koneksi tidak terbentuk dalam 30 detik");
    if (fg) showToast(sess.role === "viewer" ? "Gagal tersambung: gambar dari PC remote tidak masuk dalam 30 detik. Coba hubungkan lagi."
      : "Koneksi dengan pengontrol tidak terbentuk dalam 30 detik, sesi diakhiri.");
  }, 30000);
  pc.onconnectionstatechange = () => {
    if (sess.pc !== pc) return;   // a newer pc replaced this one — ignore stale events
    sessLog(sess, "P2P " + pc.connectionState);
    if (pc.connectionState === "connected") {
      clearTimeout(sess.p2pTimer);
      sess.everConnected = true; sess.reconnectAttempts = 0;
      if (sess.role === "viewer") stopReconnect(sess.peerId);
      else clearTimeout(lockGraceTimer);   // the viewer came back within the grace period: don't lock
      updateDiscordPresence();
    }
    else if (pc.connectionState === "failed") {
      const target = sess.role === "viewer" ? sess.peerId : null;
      const wasActive = sess === active || sess.role === "host";
      closeSession(sess, false);
      if (target && autoReconnect && (sess.everConnected || sess.isReconnect)) tryReconnect(target, sess.savedPassword, wasActive);
      else if (wasActive) showToast(prefGet("protocol") === "p2p" ? "Koneksi P2P gagal — coba protokol Otomatis (Pengaturan → Koneksi) agar bisa lewat relay"
        : serverIceServers.length ? "Koneksi gagal — relay TURN tidak terjangkau" : "Koneksi P2P gagal — server belum menyediakan TURN relay");
    } else if (pc.connectionState === "disconnected") {
      // Host: the viewer can't send key/button "up" events while the link is down — don't leave them held
      // here for the 5s grace period (or forever, if it never comes back).
      if (sess.role === "host") { try { window.electronAPI.releaseRemoteInput(); } catch {} }
      clearTimeout(sess.disconnectTimer);
      sess.disconnectTimer = setTimeout(() => {
        // Only act if this is still the same live connection (avoid tearing down a new session)
        if (sess.pc === pc && pc.connectionState === "disconnected") {
          const target = sess.role === "viewer" ? sess.peerId : null;
          const wasActive = sess === active || sess.role === "host";
          closeSession(sess, false);
          if (target && autoReconnect) tryReconnect(target, sess.savedPassword, wasActive);
          else if (wasActive) showToast("Koneksi terputus");
        }
      }, 5000);
    }
  };
}

// Session auto-reconnect (viewer side): after an UNEXPECTED drop, keep trying the same PC — with THAT tab's own
// password, without pulling the user away from another tab. Per PC, with growing pauses;
// each try first waits for our own server link (after sleep / a Wi-Fi switch it is reconnecting too), and a try
// that fails (offline, busy, no answer) schedules the next. A deliberate end (bye) never reconnects.
const RECONNECT_DELAYS = [2, 4, 8, 15, 30];   // seconds before try 1..5
const reconnectState = new Map();              // peerId -> { n, password, foreground, timer }
function tryReconnect(target, password = "", foreground = true) {
  if (!autoReconnect) return;
  const st = reconnectState.get(target) || { n: 0 };
  clearTimeout(st.timer);
  if (st.n >= RECONNECT_DELAYS.length) { reconnectState.delete(target); showToast(t("reconnect_failed")); return; }
  if (password) st.password = password;
  st.foreground = foreground;
  const delay = RECONNECT_DELAYS[st.n++] * 1000;
  reconnectState.set(target, st);
  showToast(`Menyambung ulang ke ${fmtId(target)} (${st.n}/${RECONNECT_DELAYS.length})…`);
  const attempt = () => {
    if (reconnectState.get(target) !== st || sessions.has(target)) return;
    if (!myId) { st.timer = setTimeout(attempt, 1000); return; }   // our own server link isn't back yet
    const s = initiateConnection(target, st.password || "", { background: !st.foreground || (!!active && active.peerId !== target) });
    if (s && typeof s === "object") { s.isReconnect = true; s.wasForeground = st.foreground; }
  };
  st.timer = setTimeout(attempt, delay);
}
function stopReconnect(target) { const st = reconnectState.get(target); if (st) { clearTimeout(st.timer); reconnectState.delete(target); } }
// A failed reconnect try: decide whether another one makes sense.
function reconnectFailed(s, reason = "") {
  if (!s.isReconnect) return;
  // The owner said no, or the password is wrong / locked out: retrying would only nag them.
  if (/ditolak|Password salah|percobaan/i.test(reason)) { stopReconnect(s.peerId); return; }
  tryReconnect(s.peerId, s.savedPassword, s.wasForeground);
}

// "bye" on the control channel = this end was DELIBERATE (Putuskan, tab closed, session time limit), with the
// reason to show. It also ends the other side at once even when the signaling link is down, and it is how
// the other side knows not to auto-reconnect / to lock Windows right away rather than after a grace period.
function sendBye(sess, reason = "") {
  try {
    if (sess.dataChannel && sess.dataChannel.readyState === "open") { sess.dataChannel.send(JSON.stringify({ __ctrl: "bye", reason })); return true; }
  } catch {}
  return false;
}
function onBye(sess, reason) {
  sess.byeReceived = true;
  const r = typeof reason === "string" ? reason.slice(0, 120) : "";
  if (sess.role === "viewer") stopReconnect(sess.peerId);
  closeSession(sess, false);
  showToast(r || "Remote desktop memutus koneksi");
}

// Settings → Keamanan → lock Windows after a session. A deliberate end locks right away; an unexpected drop
// (Wi-Fi blip, the viewer's PC crashed) waits a minute so a reconnect doesn't land on the lock screen.
let lockGraceTimer = null;
function lockAfterSession(sess, deliberate) {
  if (!prefGet("lockAfter") || !sess.everConnected) return;
  clearTimeout(lockGraceTimer);
  const lock = () => { try { window.electronAPI.lockWorkstation(); } catch {} };
  if (deliberate) lock();
  else lockGraceTimer = setTimeout(() => { if (!host || !host.everConnected) lock(); }, 60000);
}
function flushCandidates(sess) { for (const c of sess.pendingCandidates) sess.pc.addIceCandidate(c).catch(() => {}); sess.pendingCandidates = []; }

// Tear down ONE session (a viewer tab, or the single host session) and update the UI.
// Other tabs are left untouched. notify = the user (or a time limit) ended it on purpose: the peer gets a "bye"
// with the reason, and no auto-reconnect follows.
function closeSession(sess, notify = true, reason = "") {
  if (!sess) return;
  const isViewer = sess.role === "viewer";
  const wasActive = sess === active;
  let byeSent = false;
  sessLog(sess, `closed (${notify ? "on purpose" : "dropped"}${reason ? ": " + reason : ""}, was ${sess.everConnected ? "connected" : "never connected"})`);
  clearTimeout(sess.p2pTimer);
  if (notify) { byeSent = sendBye(sess, reason); if (isViewer) stopReconnect(sess.peerId); }
  if (isViewer) { clearTimeout(sess.thumbTimer); if (sess.hasFrame) saveThumb(sess); }
  if (isViewer && recordingActive && recordingSess === sess) stopRecording();   // flush & save THIS tab's recording
  // Tell the server to drop THIS specific pairing (targetId scopes it to the right peer so other
  // tabs survive). On an old single-session server, targetId is simply ignored.
  // A deliberate end also says so through the server (bye + reason): the P2P "bye" can't go out when the control
  // channel isn't open (yet), and the peer must still know not to reconnect.
  if (sess.peerId) {
    if (isViewer && !sess.pc) sendSignal({ type: "cancel-request", targetId: sess.peerId });
    else sendSignal(notify ? { type: "disconnect", targetId: sess.peerId, bye: true, reason } : { type: "disconnect", targetId: sess.peerId });
  }

  clearTimeout(sess.disconnectTimer); sess.disconnectTimer = null;
  clearTimeout(sess.requestTimer);
  stopStats(sess);
  stopClipboardSync(sess);
  cleanupTransfers(sess);
  for (const [, p] of sess.fsPending) { clearTimeout(p.timer); try { p.reject(new Error("closed")); } catch {} }
  sess.fsPending.clear();
  // Closing the connection right after the "bye" would drop it in flight — give it a moment to arrive.
  {
    const dc = sess.dataChannel, fc = sess.fileChannel, pc = sess.pc;
    sess.dataChannel = null; sess.fileChannel = null; sess.pc = null;
    if (pc) pc.onconnectionstatechange = null;
    if (dc) dc.onmessage = null;
    const shut = () => { try { dc && dc.close(); } catch {} try { fc && fc.close(); } catch {} try { pc && pc.close(); } catch {} };
    if (byeSent) setTimeout(shut, 300); else shut();
  }
  if (sess.localStream) { sess.localStream.getTracks().forEach((t) => t.stop()); sess.localStream = null; }
  stopSessionTimer(sess);
  if (sess.video) { try { sess.video.srcObject = null; } catch {} sess.video.remove(); sess.video = null; }
  sess.pendingCandidates = [];
  sess.pwPrompt = null;
  updateDiscordPresence();   // session ended → refresh (likely back to "idle")

  if (sess.role === "host") {
    // Only the CURRENT host session owns the shared host state (privacy overlays, held input, UI) — a late
    // teardown of an older, already-replaced one must not undo the live session's.
    if (host !== sess) return;
    // Host teardown — release privacy features defensively and reset host UI.
    try { window.electronAPI.releaseRemoteInput(); } catch {}
    clearTimeout(sess.limitTimer);
    try { window.electronAPI.setPowerSave(false); window.electronAPI.setHostingState(false); } catch {}
    // Settings → Keamanan: lock Windows once a session that really ran has ended (see lockAfterSession).
    lockAfterSession(sess, notify || !!sess.byeReceived);
    if (acceptDlgCancel) acceptDlgCancel();
    if (acceptTimerHandle) { clearInterval(acceptTimerHandle); acceptTimerHandle = null; }
    try { window.electronAPI.disableBlackScreen(); } catch {}
    try { window.electronAPI.disableInputLock(); } catch {}
    stopHostingTimer();
    $("#overlay-accept").classList.add("hidden");
    hostCaptureHeight = 0;
    $("#blackscreen-notice")?.classList.add("hidden");
    host = null;
    showScreen(viewerSessions().length ? "remote" : "home");
    if (viewerSessions().length && active) switchTab(active);
    return;
  }

  // Viewer tab teardown
  sessions.delete(sess.peerId);
  if (wasActive) active = null;
  const remaining = viewerSessions();
  if (remaining.length) {
    renderTabs();
    if (wasActive) switchTab(remaining[remaining.length - 1]);
  } else {
    // Last viewer tab closed — reset the shared remote UI and leave the remote screen.
    resetRemoteUI();
    renderTabs();
    showScreen(host ? "hosting" : "home");
  }
}

// Reset the shared remote-screen widgets to defaults (used when the last viewer tab closes).
function resetRemoteUI() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  scaleMode = "fit"; $("#scale-select").value = "fit";
  $("#remote-loading")?.classList.add("hidden");
  qualityPanel.classList.add("hidden");
  $("#monitor-picker").style.display = "none";
  closeAllMenus();
  $("#btn-audio").classList.remove("active"); $("#btn-audio").disabled = true;
  $("#chat-panel").classList.add("hidden");
  $("#key-menu").classList.add("hidden");
  $("#btn-blackscreen")?.classList.remove("active");
  $("#btn-lock-input")?.classList.remove("active");
  $("#btn-viewonly")?.classList.remove("active");
  $("#remote-canvas-container")?.classList.remove("viewonly");
  $("#chat-messages").replaceChildren(Object.assign(document.createElement("div"), { className: "chat-empty", textContent: "Belum ada pesan" }));
  clearChatUnread();
}

// ═══════════════════════════════════════════════════════════
//  Remote tabs (AnyDesk-style): one tab per viewer session + "＋"
// ═══════════════════════════════════════════════════════════
function renderTabs() {
  const bar = $("#remote-tabs");
  if (!bar) return;
  const list = viewerSessions();
  bar.classList.toggle("has-tabs", list.length > 0);
  bar.replaceChildren();
  for (const s of list) {
    const tab = document.createElement("button");
    tab.className = "rtab" + (s === active ? " active" : "") + (s.chatUnread ? " unread" : "");
    tab.dataset.sid = s.sid;
    tab.title = `${s.label} · ${s.peerId}`;
    const dot = s.pc ? (s.hasFrame ? "live" : "wait") : "wait";
    tab.innerHTML =
      `<span class="rtab-dot ${dot}"></span>` +
      `<span class="rtab-label"></span>` +
      `<span class="rtab-close" title="Tutup tab"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>`;
    tab.querySelector(".rtab-label").textContent = s.label;
    tab.addEventListener("click", (e) => {
      if (e.target.closest(".rtab-close")) { e.stopPropagation(); closeSession(s, true); return; }
      if (s !== active) switchTab(s);
    });
    bar.appendChild(tab);
  }
  const add = document.createElement("button");
  add.className = "rtab-add"; add.title = "Sambungkan remote baru";
  add.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  add.addEventListener("click", () => openNewConnection());
  bar.appendChild(add);
  renderBackPill();
}

// The "＋" button: show the home screen to start another remote WITHOUT dropping existing tabs.
function openNewConnection() {
  remoteIdInput.value = "";
  remotePasswordInput.value = "";
  closeAllMenus();
  showScreen("home");
  remoteIdInput.focus();
}

// Switch which viewer tab is shown; restore all shared UI from that session.
function switchTab(sess) {
  if (!sess || sess.role !== "viewer") return;
  active = sess;
  renderAdminBanner();
  scaleMode = sess.scaleMode;
  // A tab that is still connecting shows the Connecting screen (Cancel, and the password box if its PC asked).
  if (!sess.pc) {
    showScreen("connecting");
    $("#connecting-title").textContent = "Menghubungkan";
    $("#connecting-text").textContent = sess.pwPrompt ? "Menunggu password atau persetujuan pemilik PC" : `Meminta akses ke ${fmtId(sess.peerId)}...`;
    setConnectStep(2);
    renderTabs(); showActiveVideo(); renderPwPrompt();
    return;
  }
  showScreen("remote");
  renderTabs();
  showActiveVideo();
  setPeerLabel(sess.pc ? "Terhubung ke" : "Menghubungkan", sess.peerId, sess.pc ? "" : "…");
  $("#rt-latency-badge").textContent = sess.latencyText || "- ms";
  $("#rt-latency-badge").className = `sb-badge sb-lat ${sess.latencyClass || ""}`;
  $("#session-timer").textContent = sess.timerText;
  $("#scale-select").value = sess.scaleMode;
  applyScale();
  $("#btn-viewonly").classList.toggle("active", sess.viewOnly);
  $("#remote-canvas-container").classList.toggle("viewonly", sess.viewOnly);
  $("#btn-blackscreen").classList.toggle("active", sess.blackScreenActive);
  $("#btn-lock-input").classList.toggle("active", sess.inputLocked);
  const ab = $("#btn-audio"); ab.disabled = !sess.audioAvailable; ab.classList.toggle("active", sess.audioOn);
  renderMonitorPicker(sess);
  $("#remote-loading")?.classList.toggle("hidden", sess.hasFrame);
  renderChat(sess);
  syncQualityUI();
  closeAllMenus();
  if (sess.video) sess.video.focus();
}

// Show the active session's <video>, hide the rest (all stay live & decoding).
// Only the tab on screen is heard (each tab keeps its own audio on/off for when it is shown again).
function showActiveVideo() {
  for (const s of viewerSessions()) {
    if (!s.video) continue;
    s.video.classList.toggle("active", s === active);
    s.video.muted = !(s === active && s.audioOn);
  }
}

// ─── Accept request (AnyDesk-style with countdown) ────────
const ACCEPT_TIMEOUT = 30; // seconds
// Why the last Accept dialog ended without a yes: nobody answered (timed out) vs. the owner clicked Tolak.
let lastAcceptTimedOut = false;
const declineReason = () => (lastAcceptTimedOut ? "Tidak ada jawaban dari pemilik PC" : "Koneksi ditolak");

function setAcceptHint(text) {
  const el = $("#accept-pw-hint");
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function askAccept(fromId, fromName, hint = "") {
  return new Promise((resolve) => {
    try { window.electronAPI.focusWindow(); } catch {}
    $("#accept-id").textContent = fromId;
    setAcceptHint(hint);
    const aliasEl = $("#accept-alias");
    aliasEl.textContent = fromName && fromName !== "TryDesk User" ? fromName : "";
    // Settings → Umum → Notifikasi: tell the user even when TryDesk is behind other windows.
    if (!document.hasFocus() && prefGet("notifyIncoming")) {
      try { new Notification(tr("Permintaan koneksi masuk"), { body: (fromName && fromName !== "TryDesk User" ? fromName + " · " : "") + fmtId(fromId), silent: !prefGet("notifySound") }); } catch {}
    } else if (prefGet("notifySound")) chime();
    // List only what this remote will REALLY be able to do, from the host's current permissions.
    $("#accept-perm-control").classList.toggle("hidden", !hostControlAllowed());
    $("#accept-perm-files").classList.toggle("hidden", !hostFilesAllowed());
    $("#accept-perm-clipboard").classList.toggle("hidden", !(allowClipboardPref && hostControlAllowed()));
    const ov = $("#overlay-accept");
    ov.classList.remove("hidden");
    const timerBar = $("#accept-timer-bar");
    let remaining = ACCEPT_TIMEOUT;
    timerBar.style.width = "100%";
    acceptPending = true;
    acceptFromId = fromId;

    if (acceptTimerHandle) clearInterval(acceptTimerHandle);
    acceptTimerHandle = setInterval(() => {
      remaining--;
      timerBar.style.width = `${(remaining / ACCEPT_TIMEOUT) * 100}%`;
      if (remaining <= 0) done(false, true);
    }, 1000);

    const acc = $("#btn-accept"), rej = $("#btn-reject");
    let settled = false;
    const done = (val, timedOut = false) => {
      if (settled) return;
      settled = true;
      lastAcceptTimedOut = timedOut;
      acceptPending = false;
      acceptFromId = null;
      acceptDlgCancel = null;
      acceptDlgSettle = null;
      if (acceptTimerHandle) { clearInterval(acceptTimerHandle); acceptTimerHandle = null; }
      ov.classList.add("hidden");
      acc.removeEventListener("click", onAcc);
      rej.removeEventListener("click", onRej);
      resolve(val);
    };
    acceptDlgCancel = () => done(false);
    acceptDlgSettle = done;
    const onAcc = () => done(true);
    const onRej = () => done(false);
    acc.addEventListener("click", onAcc);
    rej.addEventListener("click", onRej);
  });
}

// Dim the video briefly while the decoder recovers from a host resolution change, so the
// viewer sees a short clean fade rather than corrupt macroblocks.
function maskResChange(sess) {
  const v = sess.video; if (!v) return;
  v.classList.add("res-switching");
  clearTimeout(sess.resMaskTimer);
  sess.resMaskTimer = setTimeout(() => v.classList.remove("res-switching"), 380);
}

// ─── View scale & pan (viewer) — operates on the active tab's video ───
function applyScale() {
  const video = activeVideo();
  const c = $("#remote-canvas-container");
  if (!video) return;
  if (scaleMode === "fit") {
    // Skip redundant repaints (resize/loadedmetadata call this too) — re-applying the same state
    // re-rasterizes the video layer and causes a visible flicker on every scale switch.
    if (c.classList.contains("fit") && !video.style.width) return;
    c.classList.add("fit"); c.classList.remove("scaled");
    video.style.width = ""; video.style.height = "";
  } else {
    const f = parseFloat(scaleMode) || 1;
    if (video.videoWidth) {
      const w = Math.round(video.videoWidth * f) + "px";
      const h = Math.round(video.videoHeight * f) + "px";
      if (c.classList.contains("scaled") && video.style.width === w && video.style.height === h) return;
      c.classList.remove("fit"); c.classList.add("scaled");
      video.style.width = w; video.style.height = h;
    } else {
      c.classList.remove("fit"); c.classList.add("scaled");
    }
  }
}

// ─── Viewer: monitors & audio ─────────────────────────────
// A monitor list arrived for a session — store it; render the picker only for the active tab.
function showMonitors(sess, ev) {
  // Sanitize peer-supplied monitor metadata: coerce index to a real integer and label to a string
  // so it can never carry markup into the picker / Control Center labels.
  sess.monitors = (Array.isArray(ev.list) ? ev.list : []).map((m, i) => ({
    index: Number.isInteger(Number(m && m.index)) ? Number(m.index) : i,
    label: typeof (m && m.label) === "string" ? m.label : "",
    primary: !!(m && m.primary),
  }));
  sess.currentMonitor = Number.isInteger(Number(ev.current)) ? Number(ev.current) : 0;
  sess.audioAvailable = !!ev.audio;
  // The host's permissions can change mid-session: say so each time they flip, not only the first time.
  if (ev.perms) {
    const viewOnly = ev.perms.control === false;
    if (viewOnly !== !!sess.hostViewOnly && (viewOnly || sess.hostViewOnly !== undefined)) {
      showToast(viewOnly ? "PC remote hanya mengizinkan melihat layar — klik & ketikan tidak dikirim" : "PC remote mengizinkan kontrol lagi");
    }
    sess.hostViewOnly = viewOnly;
    sess.hostFiles = ev.perms.files !== false;
    if (sess === active) refreshKeyCapture();
  }
  updateSessionLabel(sess);
  if (sess === active) { renderMonitorPicker(sess); }
  renderTabs();
}

function renderMonitorPicker(sess) {
  const wrap = $("#monitor-picker");
  const menu = $("#monitor-menu");
  wrap.style.display = sess.monitors.length >= 1 ? "" : "none";   // show whenever monitors are known
  const setLabel = () => { const el = $("#monitor-label"); if (el) el.textContent = `Monitor ${sess.currentMonitor + 1}`; };
  setLabel();
  menu.replaceChildren();
  for (const m of sess.monitors) {
    const item = document.createElement("button");
    item.className = "monitor-menu-item" + (m.index === sess.currentMonitor ? " active" : "");
    item.dataset.index = m.index;
    item.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span>Monitor ${m.index + 1}${m.primary ? " · utama" : ""}</span>`;
    item.addEventListener("click", () => {
      if (m.index !== sess.currentMonitor && sess.dataChannel && sess.dataChannel.readyState === "open") {
        sess.dataChannel.send(JSON.stringify({ __ctrl: "select-monitor", index: m.index }));
        sess.currentMonitor = m.index;
        updateSessionLabel(sess); renderTabs();
        menu.querySelectorAll(".monitor-menu-item").forEach((b) => b.classList.toggle("active", +b.dataset.index === m.index));
        setLabel();
      }
      closeAllMenus();
    });
    menu.appendChild(item);
  }
  const audioBtn = $("#btn-audio");
  audioBtn.disabled = !sess.audioAvailable;
  audioBtn.title = sess.audioAvailable ? "Audio remote" : "Audio tidak tersedia di remote";
}

// Tab label: the name given to this ID (Rename on a Recent tile), else the active monitor's name when known
// (AnyDesk-style), else the peer ID.
function updateSessionLabel(sess) {
  const m = sess.monitors[sess.currentMonitor];
  sess.label = peerName(sess.peerId) || ((m && m.label) ? `Monitor ${sess.currentMonitor + 1} (${m.label})` : fmtId(sess.peerId));
}

function toggleAudio() {
  const sess = active; if (!sess || !sess.audioAvailable) return;
  sess.audioOn = !sess.audioOn;
  if (sess.video) { sess.video.muted = !sess.audioOn; if (sess.audioOn) sess.video.play().catch(() => {}); }   // sess is the active tab
  $("#btn-audio").classList.toggle("active", sess.audioOn);
  showToast(sess.audioOn ? "Audio remote aktif" : "Audio remote dimatikan");
}

// ─── Chat (per session: the active viewer tab, or the host session) ───
// The session the user is looking at: on the "being controlled" screen that is the host session, even when a
// viewer tab is also open — otherwise chat replies / sent files went to the wrong person.
function onHostingScreen() { return !!host && !$("#screen-hosting").classList.contains("hidden"); }
function curChatSess() { return onHostingScreen() ? host : (active || host); }
function chatOpen() { return !$("#chat-panel").classList.contains("hidden"); }
function openChat() {
  const sess = curChatSess(); if (!sess) return;
  $("#chat-panel").classList.remove("hidden");
  sess.chatUnread = false;
  renderChat(sess);
  renderTabs();
  $("#chat-input").focus();
}
function closeChat() {
  $("#chat-panel").classList.add("hidden");
}
function toggleChat() { chatOpen() ? closeChat() : openChat(); }
function clearChatUnread() { $("#chat-unread").classList.add("hidden"); $("#chat-unread-host").classList.add("hidden"); }
function showChatUnread() { $("#chat-unread").classList.remove("hidden"); $("#chat-unread-host").classList.remove("hidden"); }

// Rebuild the chat panel from a session's log and sync its unread badge.
function renderChat(sess) {
  const box = $("#chat-messages");
  if (!sess || !sess.chatLog.length) {
    box.replaceChildren(Object.assign(document.createElement("div"), { className: "chat-empty", textContent: "Belum ada pesan" }));
  } else {
    box.replaceChildren();
    for (const m of sess.chatLog) appendChatBubble(m.mine, m.text);
    box.scrollTop = box.scrollHeight;
  }
  (sess && sess.chatUnread) ? showChatUnread() : clearChatUnread();
}

function appendChatBubble(mine, text) {
  const box = $("#chat-messages");
  const empty = box.querySelector(".chat-empty"); if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = `chat-msg ${mine ? "me" : "them"}`;
  const who = document.createElement("span"); who.className = "who"; who.textContent = mine ? "Anda" : "Remote";
  const body = document.createElement("div"); body.textContent = text;
  el.append(who, body);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function addChatMessage(sess, mine, text) {
  sess.chatLog.push({ mine, text });
  if (sess.chatLog.length > 300) sess.chatLog.shift();
  if (sess === curChatSess() && chatOpen()) appendChatBubble(mine, text);
}

function sendChat() {
  const sess = curChatSess(); if (!sess) return;
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.dataChannel.send(JSON.stringify({ __ctrl: "chat", text }));
  addChatMessage(sess, true, text);
  input.value = "";
}

function onChatReceived(sess, text) {
  if (typeof text !== "string" || !text) return;
  // A peer flooding chat must not bury the app in cards and Windows notifications: cap the length, and
  // drop messages beyond 20 per 10 s from one session.
  const now = Date.now();
  sess.chatTimes = (sess.chatTimes || []).filter((t) => now - t < 10000);
  if (sess.chatTimes.length >= 20) return;
  sess.chatTimes.push(now);
  text = text.slice(0, 4000);
  addChatMessage(sess, false, text);
  const viewing = sess === curChatSess() && chatOpen();
  if (!viewing) { sess.chatUnread = true; if (sess === curChatSess()) showChatUnread(); renderTabs(); }
  // Notify unless the chat is already open AND the window is focused (user is actively reading).
  if (!(viewing && document.hasFocus())) showChatNotification(sess, text);
}

// Slick in-app chat toast + native Windows notification when the app isn't focused.
function showChatNotification(sess, text) {
  const focusSession = () => {
    if (sess.role === "viewer" && sessions.has(sess.peerId)) switchTab(sess);
    else if (sess.role === "host") showScreen("hosting");
    openChat();
  };
  if (!(sess === curChatSess() && chatOpen())) {
    let stack = $("#chat-notif-stack");
    if (!stack) { stack = document.createElement("div"); stack.id = "chat-notif-stack"; document.body.appendChild(stack); }
    const card = document.createElement("div");
    card.className = "chat-notif";
    card.innerHTML = `
      <div class="cn-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></div>
      <div class="cn-body"><div class="cn-title">Pesan baru</div><div class="cn-text"></div></div>
      <button class="cn-close" aria-label="Tutup"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
    card.querySelector(".cn-text").textContent = text;
    let timer;
    const remove = () => { clearTimeout(timer); card.classList.remove("show"); setTimeout(() => card.remove(), 240); };
    const arm = () => { timer = setTimeout(remove, 6000); };
    card.addEventListener("click", (e) => {
      if (e.target.closest(".cn-close")) { e.stopPropagation(); return remove(); }
      try { window.electronAPI.focusWindow(); } catch {}
      focusSession(); remove();
    });
    card.addEventListener("mouseenter", () => clearTimeout(timer));
    card.addEventListener("mouseleave", arm);
    stack.appendChild(card);
    requestAnimationFrame(() => card.classList.add("show"));
    arm();
  }
  // One Windows notification per session every 5 s at most; the in-app cards and the chat still show everything.
  if (!document.hasFocus() && Date.now() - (sess.lastChatNotify || 0) > 5000) {
    sess.lastChatNotify = Date.now();
    try {
      const n = new Notification(tr("Pesan baru"), { body: text.slice(0, 160), silent: false });
      n.onclick = () => { try { window.electronAPI.focusWindow(); } catch {} focusSession(); };
    } catch {}
  }
}

// ─── Black screen (privacy mode) ──────────────────────────
// handleBlackScreen runs on the HOST side (sess = host). toggleBlackScreen is the viewer control.
// Black screen and input lock act on THIS machine, so they obey the same host-side permission as input: a
// viewer the host limited to view-only (or with control switched off) may not darken or lock it. The host
// reports the real outcome so the viewer's toggle never claims something that didn't happen.
const hostControlAllowed = () => allowInput && !forceViewOnly;
// Files and clipboard are control too: dropping an .exe into the Startup folder or replacing the clipboard is
// taking over the PC. A view-only / no-control host serves neither, whatever the file-transfer toggle says.
const hostFilesAllowed = () => allowFileTransfer && hostControlAllowed();
// A file name sent by the peer becomes a bare base name — never a path that pre-points the save dialog or the
// file manager at another folder (e.g. "..\..\Startup\update.exe").
const safeFileName = (n) => {
  let s = String(n || "").split(/[\\/]/).pop().replace(/[:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+$/, "").replace(/[ .]+$/, "").slice(0, 200);
  // Windows reserved device names (CON, NUL, COM1…) would make the write hang or misbehave — prefix them.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = "_" + s;
  return s || "file";
};
// A peer-declared transfer size → a safe non-negative integer, or null ("unknown"). Rejects NaN/Infinity so the
// disk-fill guard in onFileChunk (taken >= rec.size) can never be defeated by a non-numeric size.
const _safeSize = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
function sendPrivacyResult(sess, feature, enabled, ok, reason) {
  if (sess.dataChannel && sess.dataChannel.readyState === "open") {
    try { sess.dataChannel.send(JSON.stringify({ __ctrl: "privacy-result", feature, enabled, ok, reason })); } catch {}
  }
}

async function handleBlackScreen(sess, enabled) {
  if (enabled && !hostControlAllowed()) { sendPrivacyResult(sess, "black-screen", true, false, "denied"); return; }
  sess.blackScreenActive = !!enabled;
  if (enabled) await window.electronAPI.enableBlackScreen();
  else await window.electronAPI.disableBlackScreen();
  $("#blackscreen-notice").classList.toggle("hidden", !enabled);
}

function toggleBlackScreen() {
  const sess = active; if (!sess || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.blackScreenActive = !sess.blackScreenActive;
  sess.dataChannel.send(JSON.stringify({ __ctrl: "black-screen", enabled: sess.blackScreenActive }));
  $("#btn-blackscreen").classList.toggle("active", sess.blackScreenActive);
  showToast(sess.blackScreenActive ? "Layar remote digelapkan" : "Layar remote dikembalikan");
}

// ─── Lock host input ──────────────────────────────────────
async function handleLockInput(sess, enabled) {
  if (!enabled) { sess.inputLocked = false; window.electronAPI.disableInputLock(); return; }
  if (!hostControlAllowed()) { sendPrivacyResult(sess, "lock-input", true, false, "denied"); return; }
  let ok = false;
  try { ok = !!(await window.electronAPI.enableInputLock()); } catch {}
  sess.inputLocked = ok;
  if (!ok) sendPrivacyResult(sess, "lock-input", true, false, "admin");
}

// Host: the local panic key (Ctrl+Alt+Shift+Esc) dropped the black screen / input lock — update this UI and tell the viewer.
if (window.electronAPI && window.electronAPI.onPrivacyReleased) {
  window.electronAPI.onPrivacyReleased(() => {
    const sess = host; if (!sess) return;
    $("#blackscreen-notice")?.classList.add("hidden");
    if (sess.blackScreenActive) { sess.blackScreenActive = false; sendPrivacyResult(sess, "black-screen", true, false, "released"); }
    if (sess.inputLocked) { sess.inputLocked = false; sendPrivacyResult(sess, "lock-input", true, false, "released"); }
  });
}

// Viewer: the host refused or couldn't apply black screen / input lock — undo the optimistic toggle and say why.
function onPrivacyResult(sess, ev) {
  if (ev.ok) return;
  if (ev.feature === "lock-input") { sess.inputLocked = false; if (sess === active) $("#btn-lock-input").classList.remove("active"); }
  else if (ev.feature === "black-screen") { sess.blackScreenActive = false; if (sess === active) $("#btn-blackscreen").classList.remove("active"); }
  else return;
  const what = ev.feature === "lock-input" ? "Kunci input" : "Layar gelap";
  showToast(ev.reason === "admin" ? `${what} gagal: TryDesk di PC remote harus dijalankan sebagai administrator`
    : ev.reason === "released" ? `${what} dilepas oleh pengguna di PC remote`
    : `${what} ditolak: PC remote hanya mengizinkan mode lihat saja`);
}

function toggleLockInput() {
  const sess = active; if (!sess || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  sess.inputLocked = !sess.inputLocked;
  sess.dataChannel.send(JSON.stringify({ __ctrl: "lock-input", enabled: sess.inputLocked }));
  $("#btn-lock-input").classList.toggle("active", sess.inputLocked);
  showToast(sess.inputLocked ? "Input remote dikunci" : "Input remote dibuka");
}

// ─── Shortcut keys ────────────────────────────────────────
function sendCombo(vks) {
  const sess = active; if (!sess) return;
  if (sess.viewOnly) return showToast("Mode lihat saja aktif");
  if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  for (const vk of vks) sendInput({ action: "keydown", vk });
  for (let i = vks.length - 1; i >= 0; i--) sendInput({ action: "keyup", vk: vks[i] });
  showToast("Kombinasi tombol dikirim");
}

function toggleKeyMenu() {
  const menu = $("#key-menu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  const btn = $("#btn-keys").getBoundingClientRect();
  menu.classList.remove("hidden");
  menu.style.top = `${btn.bottom + 8}px`;
  menu.style.left = `${Math.max(8, Math.min(btn.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}

// ─── Screenshot ───────────────────────────────────────────
async function chooseScreenshotPath(name) { return window.electronAPI.fileSaveDialog(name); }

async function takeScreenshot() {
  const video = activeVideo();
  if (!video || !video.videoWidth) return showToast("Belum ada video");
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  if (!blob) return showToast("Gagal mengambil gambar");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const name = `TryDesk-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
  const savePath = await chooseScreenshotPath(name);
  if (!savePath) return;
  const id = await window.electronAPI.fileOpenWrite(savePath);
  await window.electronAPI.fileWriteChunk(id, bytes);
  await window.electronAPI.fileCloseWrite(id, false);
  showToast(`Screenshot disimpan: ${savePath}`);
}

// ─── Session recording (viewer) ───────────────────────────
let mediaRecorder = null, recordingActive = false, recordingSess = null;   // recordingSess = the tab being recorded
let recWriteId = null, recPath = "", recChain = Promise.resolve();
function isRecording() { return recordingActive; }
function toggleRecording() { recordingActive ? stopRecording() : startRecording(); }

// Ask WHERE first, then stream each 1-second chunk straight into that file. Holding the whole recording in RAM
// (~3.6 GB per hour at 8 Mbps, then copied again to save) crashed the renderer and lost long recordings.
async function startRecording() {
  const video = activeVideo();
  const stream = video && video.srcObject;
  if (!stream) return showToast("Belum ada video untuk direkam");
  let mime = "";
  for (const t of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
  }
  const name = `TryDesk-rekaman-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.webm`;
  const savePath = await window.electronAPI.fileSaveDialog(name);
  if (!savePath) return showToast("Rekaman dibatalkan");
  try { mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined); }
  catch { return showToast("Perekaman tidak didukung"); }
  const id = recWriteId = await window.electronAPI.fileOpenWrite(savePath);
  recPath = savePath; recChain = Promise.resolve();
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const d = e.data;
    recChain = recChain.then(async () => window.electronAPI.fileWriteChunk(id, new Uint8Array(await d.arrayBuffer()))).catch(() => {});
  };
  mediaRecorder.onstop = saveRecording;
  mediaRecorder.start(1000);
  recordingActive = true;
  recordingSess = active;
  showRecordingIndicator(true);
  showToast("Mulai merekam sesi");
}

function stopRecording() {
  recordingSess = null;
  if (!mediaRecorder) { recordingActive = false; showRecordingIndicator(false); return; }
  recordingActive = false;
  showRecordingIndicator(false);
  try { mediaRecorder.stop(); } catch {}
}

// Recorder stopped: let the last queued chunk land, then close the file.
async function saveRecording() {
  mediaRecorder = null;
  const id = recWriteId, savePath = recPath; recWriteId = null;
  await recChain;
  if (!id) return;
  await window.electronAPI.fileCloseWrite(id, false);
  showToast(`Rekaman disimpan: ${savePath}`);
}

function showRecordingIndicator(on) {
  let el = $("#rec-indicator");
  if (on && !el) {
    el = document.createElement("div");
    el.id = "rec-indicator";
    el.innerHTML = `<span class="rec-dot"></span>REC`;
    el.title = "Berhenti merekam";
    el.addEventListener("click", stopRecording);
    document.body.appendChild(el);
  } else if (!on && el) el.remove();
}

// ─── Clipboard sync (per session) ─────────────────────────
// Two separate switches: the viewer's "Sinkron clipboard" (Control Center) governs the tabs WE control; the
// host permission "Izinkan sinkron clipboard" (plus control being allowed at all) governs the session in
// which someone controls THIS PC. Neither one silently switches off the other role.
const clipAllowed = (sess) => (sess.role === "host" ? allowClipboardPref && hostControlAllowed() : clipboardSync);
function startClipboardSync(sess) {
  stopClipboardSync(sess);
  if (sess.role !== "host" && !clipboardSync) return;
  // Only text copied DURING the session is shared: whatever already sat in the clipboard (a password copied an
  // hour ago) is the baseline, never sent to a peer the moment the connection opens.
  sess.lastClipboard = undefined;
  window.electronAPI.clipboardRead().then((t) => { if (sess.lastClipboard === undefined) sess.lastClipboard = t; }, () => { sess.lastClipboard = ""; });
  sess.clipTimer = setInterval(async () => {
    if (sess.lastClipboard === undefined) return;   // baseline not read yet
    if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return;
    // The host's permission covers BOTH directions — never hand this PC's clipboard (passwords, tokens…) to a
    // viewer when the host switched clipboard sharing off or only lets them watch.
    if (!clipAllowed(sess)) return;
    // Only the tab on screen shares: a background tab (another customer) must not receive what was just
    // copied from this one. Switching to that tab shares the current clipboard then — a deliberate paste.
    // Also require window focus and not view-only, so a copy made elsewhere (a password manager) isn't
    // forwarded to the remote while the user isn't actively pasting into this session.
    if (sess.role === "viewer" && (sess !== active || !document.hasFocus() || sess.viewOnly || sess.hostViewOnly)) return;
    let text; try { text = await window.electronAPI.clipboardRead(); } catch { return; }
    // A data-channel message tops out at 256 KB; bigger text would throw on every tick, so skip it.
    if (text != null && text !== sess.lastClipboard && new Blob([text]).size <= 250_000) {
      sess.lastClipboard = text;
      try { sess.dataChannel.send(JSON.stringify({ __ctrl: "clipboard", text })); } catch {}
    }
  }, 1200);
}
function stopClipboardSync(sess) { if (sess && sess.clipTimer) { clearInterval(sess.clipTimer); sess.clipTimer = null; } }
async function applyRemoteClipboard(sess, text) {
  if (!clipAllowed(sess)) return;   // includes: a view-only remote may not rewrite this PC's clipboard
  // Extra guard for the viewer side: a PC we control must not silently rewrite THIS machine's clipboard
  // (e.g. swap in a different payment address) from a background tab, while unfocused, or when that remote
  // only reported view-only. Clipboard sharing is a deliberate foreground act.
  if (sess.role === "viewer" && (sess !== active || !document.hasFocus() || sess.viewOnly || sess.hostViewOnly)) return;
  if (typeof text !== "string" || text.length > 2_000_000) return;   // reject non-string / oversized peer payloads
  sess.lastClipboard = text;
  // Text that came from a PC we control must not travel on to whoever is controlling THIS PC.
  if (host && host !== sess) host.lastClipboard = text;
  try { await window.electronAPI.clipboardWrite(text); } catch {}
}
// Start/stop clipboard polling across the viewer tabs (the Control Center toggle; the host side has its own permission).
function restartClipboardAll() {
  for (const s of viewerSessions()) {
    if (clipboardSync) startClipboardSync(s); else stopClipboardSync(s);
  }
}

// ─── File transfer ────────────────────────────────────────
function setupFileChannel(sess, ch) {
  ch.onmessage = (m) => {
    if (typeof m.data === "string") { let ev; try { ev = JSON.parse(m.data); } catch { return; } onFileControl(sess, ev); }
    else onFileChunk(sess, m.data);
  };
  // "Transfer file" from a Recent tile: open the file manager as soon as this session can carry files
  ch.addEventListener("open", () => {
    if (!sess.openFilesWhenReady) return;
    sess.openFilesWhenReady = false;
    setTimeout(() => { if (sess === active && sess.fileChannel === ch && ch.readyState === "open") openFileManager(); }, 400);
  });
}

function fileBusy(sess) { return !!(sess.activeSend || sess.activeRecv); }

async function chooseSavePath(name) { return window.electronAPI.fileSaveDialog(name); }

async function startSendFiles() {
  const sess = curChatSess();
  if (!sess || !sess.fileChannel || sess.fileChannel.readyState !== "open") return showToast("Belum siap untuk transfer");
  const files = await window.electronAPI.filePick();
  for (const f of files) {
    if (fileBusy(sess)) { showToast("Satu transfer dulu, lalu ulangi"); break; }
    await sendOneFile(sess, f);
  }
}

function sendOneFile(sess, file) {
  return new Promise(async (resolve) => {
    const ch = sess.fileChannel;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    sess.activeSend = { id, canceled: false, resolve };
    const card = createCard(sess, id, { dir: "send", name: file.name, size: file.size });
    card.setSub("Menunggu persetujuan...");
    sess.acceptResolver = null;
    ch.send(JSON.stringify({ t: "offer", id, name: file.name, size: file.size }));

    const accepted = await new Promise((r) => { sess.acceptResolver = r; });
    sess.acceptResolver = null;
    if (!accepted || sess.activeSend?.canceled) {
      const why = sess.activeSend?.rejectReason;
      card.setSub(accepted ? "Dibatalkan" : why === "phone" ? "Ditolak: aplikasi HP belum bisa menerima file" : why === "denied" ? "Ditolak: PC remote tidak mengizinkan transfer file" : why === "busy" ? "Ditolak: masih ada transfer lain" : "Ditolak");
      card.finish(false);
      sess.activeSend = null; resolve(); return;
    }

    let readId;
    try {
      readId = await window.electronAPI.fileOpenRead(file.path);
      let sent = 0;
      while (true) {
        if (sess.activeSend?.canceled) throw new Error("canceled");
        const { done, chunk } = await window.electronAPI.fileReadChunk(readId, CHUNK);
        if (done) break;
        while (ch.bufferedAmount > BUFFER_HIGH) await sleep(20);
        ch.send(chunk);
        sent += chunk.byteLength || chunk.length;
        card.progress(sent, file.size);
      }
      await window.electronAPI.fileCloseRead(readId);
      ch.send(JSON.stringify({ t: "done", id }));
      card.setSub("Terkirim"); card.finish(true);
    } catch (e) {
      if (readId) window.electronAPI.fileCloseRead(readId);
      ch.send(JSON.stringify({ t: "cancel", id }));
      card.setSub("Dibatalkan"); card.finish(false);
    }
    sess.activeSend = null; resolve();
  });
}

async function onFileControl(sess, ev) {
  const ch = sess.fileChannel;
  if (ev.t === "offer") {
    if (fileBusy(sess) || (sess.role === "host" && !hostFilesAllowed())) { ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: fileBusy(sess) ? "busy" : "denied" })); return; }
    // The phone app has no file storage yet: say so on both sides instead of a silent "Ditolak".
    if (document.documentElement.classList.contains("td-mobile")) {
      ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: "phone" }));
      showToast("PC mengirim file, tetapi aplikasi HP belum bisa menerima file");
      return;
    }
    // Without a real size the disk-fill guard in onFileChunk can't cap the write: refuse instead of trusting it.
    if (_safeSize(ev.size) === null) { ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: "denied" })); return; }
    const name = safeFileName(ev.name);
    const card = createCard(sess, ev.id, { dir: "recv", name, size: ev.size, incoming: true });
    card.onAccept = async () => {
      const savePath = await chooseSavePath(name);
      if (!card.el.isConnected) return;   // the sender withdrew the offer while the save dialog was open
      if (!savePath) { ch.send(JSON.stringify({ t: "reject", id: ev.id })); card.remove(); return; }
      // A second offer accepted while the first is still being written would orphan the first file handle.
      if (fileBusy(sess)) { ch.send(JSON.stringify({ t: "reject", id: ev.id, reason: "busy" })); card.remove(); showToast("Tunggu transfer yang sedang berjalan selesai"); return; }
      const writeId = await window.electronAPI.fileOpenWrite(savePath);
      sess.activeRecv = { id: ev.id, size: _safeSize(ev.size), received: 0, writeId, filePath: savePath, canceled: false, card };
      card.toProgress();
      ch.send(JSON.stringify({ t: "accept", id: ev.id }));
    };
    card.onReject = () => { ch.send(JSON.stringify({ t: "reject", id: ev.id })); card.remove(); };
  } else if (ev.t === "accept") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.acceptResolver) sess.acceptResolver(true);
  } else if (ev.t === "reject") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.acceptResolver) { sess.activeSend.rejectReason = ev.reason || ""; sess.acceptResolver(false); }
  } else if (ev.t === "done") {
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      const rec = sess.activeRecv; sess.activeRecv = null;
      await writtenAll(rec);
      // A transfer that ended short is not "saved": drop the partial file and say so.
      const complete = !rec.writeFailed && (!(rec.size > 0) || rec.received === rec.size);
      rec.closed = true;
      await window.electronAPI.fileCloseWrite(rec.writeId, !complete);
      rec.card.setSub(complete ? `Tersimpan: ${rec.filePath}` : "Gagal: file tidak lengkap"); rec.card.finish(complete);
    }
  } else if (ev.t === "cancel") {
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      const rec = sess.activeRecv; sess.activeRecv = null;
      await discardRecv(rec);
      rec.card.setSub("Dibatalkan pengirim"); rec.card.finish(false);
    } else if (sess.activeSend && sess.activeSend.id === ev.id) { sess.activeSend.canceled = true; }
    else if (typeof ev.id === "string") {   // the sender withdrew an offer we hadn't answered yet
      $(`#transfer-stack .transfer-card[data-sid="${sess.sid}"][data-id="${CSS.escape(ev.id)}"]`)?.remove();
    }
  }
  // ── File manager protocol (dual-pane queue; no save dialogs) ──
  else if (ev.t === "m-put") {
    // Peer wants to upload ev.name into our ev.destDir. Only the host serves the file manager,
    // and only when file transfer is permitted — never expose a machine we connected OUT to.
    if (sess.role !== "host" || !hostFilesAllowed() || !(Number.isSafeInteger(ev.size) && ev.size >= 0)) { ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: "ditolak" })); return; }
    if (fileBusy(sess)) { ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: "busy" })); return; }
    try {
      const { id: writeId, path: filePath } = await window.electronAPI.fileOpenWriteIn(ev.destDir, safeFileName(ev.name));
      sess.activeRecv = { id: ev.id, size: _safeSize(ev.size), received: 0, writeId, filePath, mgr: true };
      ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: true }));
    } catch (e) {
      ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: String(e && e.message || e) }));
    }
  } else if (ev.t === "m-putok") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.activeSend.onAck) sess.activeSend.onAck(ev);
  } else if (ev.t === "m-done") {
    // We are the receiver; sender finished streaming.
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      const rec = sess.activeRecv; const filePath = rec.filePath; sess.activeRecv = null;
      await writtenAll(rec);
      const complete = !rec.writeFailed && (!(rec.size > 0) || rec.received === rec.size);
      rec.closed = true;
      await window.electronAPI.fileCloseWrite(rec.writeId, !complete);   // a short file is removed, not kept
      if (rec.onDone) { if (complete) rec.onDone(filePath); else if (rec.item && rec.item._wake) rec.item._wake(); }
      else ch.send(JSON.stringify({ t: "m-complete", id: ev.id, ok: complete, path: filePath }));
    }
  } else if (ev.t === "m-complete") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.activeSend.onDone) sess.activeSend.onDone(ev);
  } else if (ev.t === "m-get") {
    // Peer wants to download ev.remotePath from us. Host-only + permission-gated (see m-put).
    if (sess.role !== "host" || !hostFilesAllowed()) { ch.send(JSON.stringify({ t: "m-got", id: ev.id, ok: false, err: "ditolak" })); return; }
    if (fileBusy(sess)) { ch.send(JSON.stringify({ t: "m-got", id: ev.id, ok: false, err: "busy" })); return; }
    try {
      const readId = await window.electronAPI.fileOpenRead(ev.remotePath);
      sess.activeSend = { id: ev.id, canceled: false, paused: false, readId, mgr: true, size: ev.size };
      ch.send(JSON.stringify({ t: "m-got", id: ev.id, ok: true }));
    } catch (e) {
      ch.send(JSON.stringify({ t: "m-got", id: ev.id, ok: false, err: String(e && e.message || e) }));
    }
  } else if (ev.t === "m-got") {
    if (sess.mgrGetAck && sess.mgrGetAck.id === ev.id) sess.mgrGetAck.resolve(ev);
  } else if (ev.t === "m-ready") {
    // We are the sender for a download; receiver is ready — stream now.
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.activeSend.mgr) streamManagerChunks(sess, sess.activeSend);
  } else if (ev.t === "m-pause") {
    if (sess.activeSend && sess.activeSend.id === ev.id) sess.activeSend.paused = !!ev.paused;
  } else if (ev.t === "m-cancel") {
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      const rec = sess.activeRecv; sess.activeRecv = null;
      await discardRecv(rec);
    }
    if (sess.activeSend && sess.activeSend.id === ev.id) {
      sess.activeSend.canceled = true;
      if (!sess.activeSend.streaming) {   // stream never started (or legacy) — clear it here so we don't stay busy
        if (sess.activeSend.readId) { try { await window.electronAPI.fileCloseRead(sess.activeSend.readId); } catch {} }
        if (sess.activeSend.mgr) sess.activeSend = null;
      }
    }
  }
}

// Stream an already-open read handle (download, sender side) to the file channel.
async function streamManagerChunks(sess, send) {
  const ch = sess.fileChannel;
  send.streaming = true;
  try {
    while (true) {
      if (send.canceled) throw new Error("canceled");
      while (send.paused && !send.canceled) await sleep(120);
      const { done, chunk } = await window.electronAPI.fileReadChunk(send.readId, CHUNK);
      if (done) break;
      while (ch.bufferedAmount > BUFFER_HIGH) await sleep(20);
      ch.send(chunk);
    }
    await window.electronAPI.fileCloseRead(send.readId);
    ch.send(JSON.stringify({ t: "m-done", id: send.id }));
  } catch {
    try { await window.electronAPI.fileCloseRead(send.readId); } catch {}
  }
  if (sess.activeSend && sess.activeSend.id === send.id) sess.activeSend = null;
}

// Chunks arrive faster than the disk IPC answers, so writes are CHAINED per transfer (in order, one at a time)
// and "done" waits for the chain (writtenAll) before checking the size. Checking right away — while the last
// chunks were still in flight — called complete files short and deleted them.
function onFileChunk(sess, buf) {
  const rec = sess.activeRecv;
  if (!rec) return;
  // Enforce the advertised size: never write more bytes than declared (disk-fill DoS guard).
  const taken = rec.taken || 0;
  if (rec.size != null && taken >= rec.size) return;
  let u8 = new Uint8Array(buf);
  if (rec.size != null && taken + u8.byteLength > rec.size) u8 = u8.subarray(0, Math.max(0, rec.size - taken));
  if (!u8.byteLength) return;
  rec.taken = taken + u8.byteLength;
  rec.chain = (rec.chain || Promise.resolve()).then(async () => {
    if (rec.closed) return;
    await window.electronAPI.fileWriteChunk(rec.writeId, u8);
    rec.received += u8.byteLength;
    if (rec.card) rec.card.progress(rec.received, rec.size);
  }).catch(() => { rec.writeFailed = true; });
}
// Wait until every chunk received so far is on disk.
const writtenAll = (rec) => (rec && rec.chain ? rec.chain : Promise.resolve());
// Stop writing and remove the partial file (cancel / disconnect), after any write already under way.
function discardRecv(rec) {
  if (!rec || rec.closed) return Promise.resolve();
  rec.closed = true;
  return writtenAll(rec).then(() => window.electronAPI.fileCloseWrite(rec.writeId, true, rec.filePath)).catch(() => {});
}

function cleanupTransfers(sess) {
  if (sess.activeSend) sess.activeSend.canceled = true;
  // A download the peer asked for (m-get) but never started streaming still holds its file open.
  const s = sess.activeSend;
  if (s && s.mgr && s.readId && !s.streaming) { s.streaming = true; window.electronAPI.fileCloseRead(s.readId).catch(() => {}); }
  if (sess.activeRecv) { discardRecv(sess.activeRecv); sess.activeRecv = null; }
  sess.activeSend = null; sess.acceptResolver = null;
  sess.mgrGetAck = null;
  $$(`#transfer-stack .transfer-card[data-sid="${sess.sid}"]`).forEach((el) => el.remove());
  fmResetAll(sess);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function createCard(sess, id, { dir, name, size, incoming }) {
  const el = document.createElement("div");
  el.className = "transfer-card";
  el.dataset.id = id;
  el.dataset.sid = sess.sid;
  const arrow = dir === "send" ? "↑" : "↓";
  el.innerHTML = `
    <div class="tc-top">
      <span class="tc-icon">${arrow}</span>
      <div class="tc-meta"><div class="tc-name"></div><div class="tc-sub"></div></div>
      <button class="tc-close" title="Tutup">✕</button>
    </div>
    <div class="tc-progress" style="display:none"><div class="tc-bar"></div></div>
    <div class="tc-actions" style="display:none"></div>`;
  el.querySelector(".tc-name").textContent = name;
  el.querySelector(".tc-sub").textContent = fmtBytes(size);
  $("#transfer-stack").appendChild(el);

  const bar = el.querySelector(".tc-bar");
  const sub = el.querySelector(".tc-sub");
  const prog = el.querySelector(".tc-progress");
  const actions = el.querySelector(".tc-actions");

  const ctrl = {
    el,
    onAccept: null, onReject: null,
    setSub(t) { sub.textContent = t; },
    progress(done, total) { prog.style.display = ""; bar.style.width = `${total ? (done / total * 100).toFixed(1) : 0}%`; sub.textContent = `${fmtBytes(done)} / ${fmtBytes(total)}`; },
    toProgress() { actions.style.display = "none"; prog.style.display = ""; },
    finish(ok) { prog.style.display = ""; bar.style.width = "100%"; bar.classList.toggle("done", ok); setTimeout(() => ctrl.remove(), 6000); },
    remove() { el.remove(); },
  };

  let answered = false;   // incoming offer: Accept/Reject already chosen
  el.querySelector(".tc-close").addEventListener("click", () => {
    if (dir === "send" && sess.activeSend && sess.activeSend.id === id) {
      sess.activeSend.canceled = true;
      // Still waiting for the receiver: withdraw the offer and stop waiting — otherwise the send never ends
      // and the session stays "busy" for every later transfer.
      if (sess.acceptResolver) { try { sess.fileChannel.send(JSON.stringify({ t: "cancel", id })); } catch {} sess.acceptResolver(false); }
    }
    if (dir === "recv" && sess.activeRecv && sess.activeRecv.id === id) { sess.fileChannel.send(JSON.stringify({ t: "cancel", id })); discardRecv(sess.activeRecv); sess.activeRecv = null; }
    else if (incoming && !answered && ctrl.onReject) { answered = true; ctrl.onReject(); return; }   // closing an unanswered offer = reject it
    ctrl.remove();
  });

  if (incoming) {
    actions.style.display = "";
    const acc = document.createElement("button"); acc.className = "tc-btn accept"; acc.textContent = "Terima";
    const rej = document.createElement("button"); rej.className = "tc-btn"; rej.textContent = "Tolak";
    acc.addEventListener("click", () => { if (answered) return; answered = true; ctrl.onAccept && ctrl.onAccept(); });
    rej.addEventListener("click", () => { if (answered) return; answered = true; ctrl.onReject && ctrl.onReject(); });
    actions.append(acc, rej);
    sub.textContent = `${fmtBytes(size)} · ingin dikirim`;
  }
  return ctrl;
}

// ═══════════════════════════════════════════════════════════
//  File Manager — dual-pane browser + two-way transfer queue
// ═══════════════════════════════════════════════════════════
// The file-manager overlay is modal and bound to ONE session at a time (fmSess) — the session
// whose remote filesystem it browses and whose fileChannel it transfers over. Per-session fm
// state lives on the Session (sess.fm / sess.fmQueue / sess.mgrGetAck / ...).
let fmSess = null;
let fmOpen = false;

function fmIcon(dir) {
  return dir
    ? `<svg class="fm-ic fm-ic-dir" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`
    : `<svg class="fm-ic fm-ic-file" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>`;
}

function fmFileType(e) {
  if (e.isDir) return "Folder";
  const ext = (e.name.includes(".") ? e.name.split(".").pop() : "").toUpperCase();
  return ext ? `${ext} File` : "File";
}

function fmFmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmSortEntries(entries, sort) {
  const dirMul = sort.asc ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;   // folders first, always
    let r = 0;
    switch (sort.key) {
      case "mtime": r = (a.mtime || 0) - (b.mtime || 0); break;
      case "size":  r = (a.size || 0) - (b.size || 0); break;
      case "type":  r = fmFileType(a).localeCompare(fmFileType(b)); break;
      default:      r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    }
    if (r === 0) r = a.name.localeCompare(b.name, undefined, { numeric: true });
    return r * dirMul;
  });
}

async function fmLoad(side, pathArg, { home = false } = {}) {
  if (!fmSess) return;
  const st = fmSess.fm[side];
  const listEl = $(`#fm-${side}-list`);
  listEl.innerHTML = `<div class="fm-empty">Memuat…</div>`;
  let res;
  try {
    res = side === "local"
      ? (home ? await window.electronAPI.fsList(await window.electronAPI.fsHome()) : await window.electronAPI.fsList(pathArg))
      : await requestRemoteList(fmSess, { path: pathArg, home });
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e), path: pathArg, display: pathArg || "" };
  }
  if (!res || !res.ok) {
    listEl.innerHTML = `<div class="fm-empty fm-error">Tidak bisa membuka folder${res && res.error ? ` · ${escapeHtml(res.error)}` : ""}</div>`;
    st.sel.clear();
    return;
  }
  st.path = res.path; st.display = res.display; st.parent = res.parent; st.isRoot = res.isRoot;
  st.entries = res.entries || [];
  st.sel.clear();
  fmRenderPane(side);
}

function fmRenderPane(side) {
  const st = fmSess.fm[side];
  $(`#fm-${side}-path`).value = st.isRoot ? "Komputer ini" : st.display;
  const listEl = $(`#fm-${side}-list`);
  $$(`#fm-${side} .fm-col[data-key]`).forEach((c) => {
    c.classList.toggle("sorted", c.dataset.key === st.sort.key);
    c.dataset.dir = c.dataset.key === st.sort.key ? (st.sort.asc ? "asc" : "desc") : "";
  });
  const rows = fmSortEntries(st.entries, st.sort);
  if (!rows.length) { listEl.innerHTML = `<div class="fm-empty">Folder kosong</div>`; return; }
  const frag = document.createDocumentFragment();
  for (const e of rows) {
    const row = document.createElement("div");
    row.className = "fm-row" + (e.isDir ? " is-dir" : "") + (st.sel.has(e.path) ? " selected" : "");
    row.dataset.path = e.path;
    row.innerHTML =
      `<div class="fm-cell fm-c-name">${fmIcon(e.isDir)}<span class="fm-name" title="${escapeAttr(e.name)}">${escapeHtml(e.name)}</span></div>` +
      `<div class="fm-cell fm-c-date">${e.isDir && e.kind ? "" : fmFmtDate(e.mtime)}</div>` +
      `<div class="fm-cell fm-c-type">${escapeHtml(fmFileType(e))}</div>` +
      `<div class="fm-cell fm-c-size">${e.isDir ? "" : fmBytes(e.size)}</div>`;
    row.addEventListener("click", () => {
      if (e.isDir) return;
      if (st.sel.has(e.path)) st.sel.delete(e.path); else st.sel.add(e.path);
      row.classList.toggle("selected");
      fmUpdateActionBar();
    });
    row.addEventListener("dblclick", () => { if (e.isDir) fmLoad(side, e.path); });
    frag.appendChild(row);
  }
  listEl.replaceChildren(frag);
  fmUpdateActionBar();
}

function fmUpdateActionBar() {
  const upN = fmSess.fm.local.sel.size, downN = fmSess.fm.remote.sel.size;
  const up = $("#fm-send-btn"), down = $("#fm-recv-btn");
  up.disabled = upN === 0;
  down.disabled = downN === 0;
  up.querySelector(".fm-x-count").textContent = upN ? ` (${upN})` : "";
  down.querySelector(".fm-x-count").textContent = downN ? ` (${downN})` : "";
}

const fmBytes = fmtBytes;
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

// ── Queue ──────────────────────────────────────────────────
function fmEnqueue(dir) {
  const fromSide = dir === "up" ? "local" : "remote";
  const toSt = dir === "up" ? fmSess.fm.remote : fmSess.fm.local;
  if (!toSt.path || toSt.isRoot) { showToast("Pilih folder tujuan dulu"); return; }
  const fromSt = fmSess.fm[fromSide];
  const picked = fromSt.entries.filter((e) => !e.isDir && fromSt.sel.has(e.path));
  if (!picked.length) return;
  for (const e of picked) {
    const id = `m${Date.now()}-${++fmSess.fmQueueSeq}`;
    fmSess.fmQueue.push({ id, dir, name: e.name, size: e.size, srcPath: e.path, destDir: toSt.path, status: "queued", sent: 0, paused: false, canceled: false });
  }
  fromSt.sel.clear();
  $$(`#fm-${fromSide}-list .fm-row.selected`).forEach((r) => r.classList.remove("selected"));
  fmUpdateActionBar();
  fmRenderQueue();
  showToast(`${picked.length} file ditambahkan ke antrean`);
}

function fmRenderQueue() {
  const list = $("#fm-queue-list");
  const visible = fmSess.fmQueue.filter((i) => i.status !== "removed");
  $("#fm-queue-count").textContent = visible.length ? `${visible.length}` : "0";
  const pending = fmSess.fmQueue.some((i) => i.status === "queued");
  $("#fm-start-btn").disabled = !pending || fmSess.fmRunning;
  if (!visible.length) { list.innerHTML = `<div class="fm-queue-empty">Belum ada transfer. Pilih file lalu klik Kirim atau Unduh.</div>`; return; }
  const frag = document.createDocumentFragment();
  for (const i of visible) {
    const row = document.createElement("div");
    row.className = `fm-qrow st-${i.status}`;
    row.dataset.id = i.id;
    const arrow = i.dir === "up"
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="18 13 12 19 6 13"/></svg>`;
    const pct = i.size ? Math.min(100, i.sent / i.size * 100) : (i.status === "done" ? 100 : 0);
    row.innerHTML =
      `<span class="fm-q-arrow" title="${i.dir === "up" ? "Kirim ke remote" : "Unduh ke lokal"}">${arrow}</span>` +
      `<div class="fm-q-main">` +
        `<div class="fm-q-top"><span class="fm-q-name" title="${escapeAttr(i.name)}">${escapeHtml(i.name)}</span><span class="fm-q-stat">${escapeHtml(fmQStatus(i))}</span></div>` +
        `<div class="fm-q-bar"><div class="fm-q-fill" style="width:${pct}%"></div></div>` +
      `</div>` +
      `<div class="fm-q-actions"></div>`;
    const acts = row.querySelector(".fm-q-actions");
    if (i.status === "active") {
      const pz = document.createElement("button"); pz.className = "fm-q-btn"; pz.title = i.paused ? "Lanjut" : "Jeda";
      pz.innerHTML = i.paused
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>`;
      pz.addEventListener("click", () => fmTogglePause(i));
      acts.appendChild(pz);
    }
    if (i.status === "active" || i.status === "queued") {
      const cx = document.createElement("button"); cx.className = "fm-q-btn"; cx.title = "Batalkan";
      cx.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      cx.addEventListener("click", () => fmCancelItem(i));
      acts.appendChild(cx);
    } else {
      const rm = document.createElement("button"); rm.className = "fm-q-btn"; rm.title = "Hapus dari daftar";
      rm.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      rm.addEventListener("click", () => { i.status = "removed"; fmRenderQueue(); });
      acts.appendChild(rm);
    }
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
}

function fmQStatus(i) {
  switch (i.status) {
    case "queued": return "Menunggu";
    case "active": {
      const sp = i.speed ? ` · ${fmBytes(i.speed)}/s` : "";
      return i.paused ? "Dijeda" : `${i.size ? Math.round(i.sent / i.size * 100) : 0}%${sp}`;
    }
    case "done": return "Selesai";
    case "error": return i.err || "Gagal";
    case "canceled": return "Dibatalkan";
    default: return "";
  }
}

function fmUpdateQRow(i) {
  const row = $(`#fm-queue-list .fm-qrow[data-id="${i.id}"]`);
  if (!row) return;
  const pct = i.size ? Math.min(100, i.sent / i.size * 100) : 0;
  const fill = row.querySelector(".fm-q-fill"); if (fill) fill.style.width = `${pct}%`;
  const stat = row.querySelector(".fm-q-stat"); if (stat) stat.textContent = fmQStatus(i);
}

function fmProgress(i, sent) {
  const now = performance.now();
  i.sent = sent;
  if (i._lastTs != null) {
    const dt = (now - i._lastTs) / 1000;
    if (dt >= 0.4) {
      i.speed = Math.max(0, (sent - i._lastBytes) / dt);
      i._lastTs = now; i._lastBytes = sent;
    }
  } else { i._lastTs = now; i._lastBytes = sent; }
  fmUpdateQRow(i);
}

function fmTogglePause(i) {
  i.paused = !i.paused;
  if (i.dir === "down") { try { fmSess.fileChannel.send(JSON.stringify({ t: "m-pause", id: i.id, paused: i.paused })); } catch {} }
  fmRenderQueue();
}

function fmCancelItem(i) {
  i.canceled = true;
  if (i.status === "active") {
    try { fmSess.fileChannel.send(JSON.stringify({ t: "m-cancel", id: i.id })); } catch {}
    if (fmSess.activeSend && fmSess.activeSend.id === i.id) fmSess.activeSend.canceled = true;
    if (i._wake) i._wake();   // end whatever the transfer is waiting on, so its cleanup runs
    return;                   // fmStartQueue's catch will mark it canceled and re-render
  }
  i.status = "canceled";
  fmRenderQueue();
}

// The queue belongs to the session it was started on — captured once, because fmSess changes when the user
// opens the file manager on another tab while this queue is still running.
async function fmStartQueue() {
  const sess = fmSess;
  if (!sess || sess.fmRunning) return;
  if (!sess.fileChannel || sess.fileChannel.readyState !== "open") { showToast("Sesi transfer belum siap"); return; }
  sess.fmRunning = true;
  $("#fm-start-btn").disabled = true;
  const render = () => { if (fmSess === sess) fmRenderQueue(); };
  try {
    while (true) {
      const item = sess.fmQueue.find((i) => i.status === "queued");
      if (!item) break;
      if (item.canceled) { item.status = "canceled"; continue; }
      item.status = "active"; item.sent = 0; item._lastTs = null; item.speed = 0;
      render();
      try {
        if (item.dir === "up") await fmUpload(item, sess);
        else await fmDownload(item, sess);
        if (!item.canceled) { item.status = "done"; item.sent = item.size; }
      } catch (e) {
        if (item.canceled) item.status = "canceled";
        else { item.status = "error"; item.err = String(e && e.message || e).slice(0, 40); }
      }
      render();
    }
  } finally {
    sess.fmRunning = false;
    render();
  }
}

// Each wait inside a transfer is registered as item._wake so a cancel can end it: the transfer then throws
// "canceled" through its own catch, which closes the file, deletes a partial download and frees the session.
// (Rejecting the outer promise directly left those cleanups — and the session's busy flag — hanging.)
function fmWait(item, setup) {
  return new Promise((resolve, reject) => {
    item._wake = () => reject(new Error("canceled"));
    setup(resolve);
  }).finally(() => { item._wake = null; });
}

function fmUpload(item, sess) {
  return new Promise(async (resolve, reject) => {
    sess.activeSend = { id: item.id, canceled: false, paused: false, mgr: true };
    let readId;
    try {
      const ackP = fmWait(item, (r) => { sess.activeSend.onAck = r; });
      sess.fileChannel.send(JSON.stringify({ t: "m-put", id: item.id, name: item.name, size: item.size, destDir: item.destDir }));
      const ack = await ackP;
      if (!ack.ok) throw new Error(ack.err === "busy" ? "Sibuk" : (ack.err || "ditolak"));
      readId = await window.electronAPI.fileOpenRead(item.srcPath);
      let sent = 0;
      const doneP = new Promise((r) => { sess.activeSend.onDone = r; });
      while (true) {
        if (item.canceled || sess.activeSend.canceled) throw new Error("canceled");
        while (item.paused && !item.canceled) await sleep(120);
        const { done, chunk } = await window.electronAPI.fileReadChunk(readId, CHUNK);
        if (done) break;
        while (sess.fileChannel.bufferedAmount > BUFFER_HIGH) await sleep(20);
        sess.fileChannel.send(chunk);
        sent += chunk.byteLength || chunk.length;
        fmProgress(item, sent);
      }
      await window.electronAPI.fileCloseRead(readId); readId = null;
      sess.fileChannel.send(JSON.stringify({ t: "m-done", id: item.id }));
      const fin = await fmWait(item, (r) => doneP.then(r));
      if (fin && fin.ok === false) throw new Error("gagal");   // the receiver got a short file and discarded it
      sess.activeSend = null;
      if (fmSess === sess) fmRefreshSide("remote");
      resolve();
    } catch (e) {
      if (readId) { try { await window.electronAPI.fileCloseRead(readId); } catch {} }
      try { sess.fileChannel.send(JSON.stringify({ t: "m-cancel", id: item.id })); } catch {}
      if (sess.activeSend && sess.activeSend.id === item.id) sess.activeSend = null;
      reject(e);
    }
  });
}

function fmDownload(item, sess) {
  return new Promise(async (resolve, reject) => {
    try {
      // The size from the host's listing caps what we write (disk-fill guard); without one, don't download.
      if (_safeSize(item.size) === null) throw new Error("ukuran file tidak diketahui");
      const gotP = fmWait(item, (r) => { sess.mgrGetAck = { id: item.id, resolve: r }; });
      sess.fileChannel.send(JSON.stringify({ t: "m-get", id: item.id, remotePath: item.srcPath, name: item.name, size: item.size }));
      const got = await gotP; sess.mgrGetAck = null;
      if (!got.ok) throw new Error(got.err === "busy" ? "Sibuk" : (got.err || "gagal"));
      const { id: writeId, path: filePath } = await window.electronAPI.fileOpenWriteIn(item.destDir, safeFileName(item.name));
      const doneP = fmWait(item, (r) => { item._dlDone = r; });
      sess.activeRecv = {
        id: item.id, size: _safeSize(item.size), received: 0, writeId, filePath, mgr: true, item,
        onDone: () => item._dlDone && item._dlDone(),
        card: { progress: (done) => fmProgress(item, done), setSub() {}, finish() {}, remove() {} },
      };
      sess.fileChannel.send(JSON.stringify({ t: "m-ready", id: item.id }));
      await doneP;
      if (fmSess === sess) fmRefreshSide("local");
      resolve();
    } catch (e) {
      if (sess.activeRecv && sess.activeRecv.id === item.id) { const rec = sess.activeRecv; sess.activeRecv = null; await discardRecv(rec); }
      try { sess.fileChannel.send(JSON.stringify({ t: "m-cancel", id: item.id })); } catch {}
      sess.mgrGetAck = null;
      reject(e);
    }
  });
}

function fmRefreshSide(side) {
  const st = fmSess.fm[side];
  if (st.path != null && !st.isRoot) fmLoad(side, st.path);
}

// ── Open / close ───────────────────────────────────────────
function openFileManager() {
  const sess = curChatSess();
  if (!sess || !sess.fileChannel || sess.fileChannel.readyState !== "open") { showToast("Transfer file butuh sesi aktif"); return; }
  fmSess = sess;
  closeAllMenus();
  fmOpen = true;
  $("#overlay-files").classList.remove("hidden");
  fmLoad("local", null, { home: true });
  fmLoad("remote", null, { home: true });
  fmRenderQueue();
}

function closeFileManager() {
  fmOpen = false;
  $("#overlay-files").classList.add("hidden");
}

// Reset one session's file-manager state; close the overlay if it's the one being shown.
function fmResetAll(sess) {
  if (!sess) return;
  sess.fmQueue.length = 0;
  sess.fmRunning = false;
  sess.fm.local.sel.clear(); sess.fm.remote.sel.clear();
  if (fmSess === sess && fmOpen) { closeFileManager(); fmSess = null; }
}

function fmInit() {
  $("#fm-close").addEventListener("click", closeFileManager);
  $("#fm-send-btn").addEventListener("click", () => fmEnqueue("up"));
  $("#fm-recv-btn").addEventListener("click", () => fmEnqueue("down"));
  $("#fm-start-btn").addEventListener("click", fmStartQueue);
  $("#fm-queue-clear").addEventListener("click", () => {
    if (!fmSess) return;
    for (let k = fmSess.fmQueue.length - 1; k >= 0; k--) { if (fmSess.fmQueue[k].status !== "active") fmSess.fmQueue.splice(k, 1); }
    fmRenderQueue();
  });
  for (const side of ["local", "remote"]) {
    $(`#fm-${side}-up`).addEventListener("click", () => { if (!fmSess) return; const p = fmSess.fm[side].parent; if (p != null) fmLoad(side, p || null); });
    $(`#fm-${side}-home`).addEventListener("click", () => fmLoad(side, null, { home: true }));
    $(`#fm-${side}-refresh`).addEventListener("click", () => { if (fmSess) fmLoad(side, fmSess.fm[side].path); });
    $(`#fm-${side}-path`).addEventListener("keydown", (e) => { if (e.key === "Enter") fmLoad(side, e.target.value.trim() || null); });
    $$(`#fm-${side} .fm-col[data-key]`).forEach((c) => c.addEventListener("click", () => {
      if (!fmSess) return;
      const st = fmSess.fm[side];
      if (st.sort.key === c.dataset.key) st.sort.asc = !st.sort.asc;
      else { st.sort.key = c.dataset.key; st.sort.asc = true; }
      fmRenderPane(side);
    }));
  }
}

// ─── Quality control (viewer) ─────────────────────────────
// Quality is edited for the active tab (or the default template on the home screen).
function qualityOf() { return active ? active.quality : defaultQuality; }
function sendQuality(sess) {
  if (sess && sess.dataChannel && sess.dataChannel.readyState === "open") {
    sess.dataChannel.send(JSON.stringify({ __ctrl: "quality", bitrate: sess.quality.bitrate, fps: sess.quality.fps, resHeight: sess.quality.resHeight }));
  }
}

function syncQualityUI() {
  const q = qualityOf();
  $("#bitrate-slider").value = q.bitrate;
  $("#bitrate-number").value = q.bitrate;
  $$("#fps-row .chip").forEach((c) => c.classList.toggle("active", +c.dataset.fps === q.fps));
  $$("#res-row .chip").forEach((c) => c.classList.toggle("active", +c.dataset.scale === q.resHeight));
  $("#codec-select").value = q.codec;
  const match = Object.entries(PRESETS).find(([, p]) => p.bitrate === q.bitrate && p.fps === q.fps && p.resHeight === q.resHeight);
  $$(".preset-btn").forEach((b) => b.classList.toggle("active", match && b.dataset.preset === match[0]));
}

function saveQuality() { store.set("quality", JSON.stringify(defaultQuality)); }

function setQuality(patch, { reconnectCodec = false } = {}) {
  const q = qualityOf();
  Object.assign(q, patch);
  Object.assign(defaultQuality, q);   // remember as the default for the next tab
  saveQuality();
  syncQualityUI();
  if (active) sendQuality(active);
  if (reconnectCodec && active && active.pc && active.role === "viewer") { applyCodecPreference(active); negotiate(active); }
}

// ─── Stats (viewer, per session) ──────────────────────────
function startStats(sess) {
  stopStats(sess);
  sess.statsLast = { bytes: 0, ts: 0 };
  sess.statsTimer = setInterval(() => pollStats(sess), 1000);
}
function stopStats(sess) { if (sess && sess.statsTimer) { clearInterval(sess.statsTimer); sess.statsTimer = null; } }

async function pollStats(sess) {
  if (!sess.pc) return;
  const show = sess === active;      // only the active tab writes to the shared stats widgets
  let inbound, pair, codecMime;
  const stats = await sess.pc.getStats();
  let selectedPairId;
  stats.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) selectedPairId = s.selectedCandidatePairId; });
  stats.forEach((s) => {
    if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
    if (s.type === "candidate-pair" && (s.id === selectedPairId || (!pair && s.nominated && s.state === "succeeded"))) pair = s;
  });
  if (inbound) {
    const now = performance.now();
    if (sess.statsLast.ts && show) {
      const dt = (now - sess.statsLast.ts) / 1000;
      const mbps = ((inbound.bytesReceived - sess.statsLast.bytes) * 8) / dt / 1_000_000;
      $("#stat-bitrate").textContent = `${mbps.toFixed(1)} Mbps`;
    }
    sess.statsLast = { bytes: inbound.bytesReceived, ts: now };
    if (show) {
      $("#stat-fps").textContent = inbound.framesPerSecond != null ? `${Math.round(inbound.framesPerSecond)}` : "-";
      const total = (inbound.packetsReceived || 0) + (inbound.packetsLost || 0);
      $("#stat-loss").textContent = total ? `${((inbound.packetsLost || 0) / total * 100).toFixed(1)}%` : "0%";
    }
    if (inbound.codecId) { const c = stats.get(inbound.codecId); if (c) codecMime = c.mimeType.replace("video/", ""); }
  }
  // Adaptive low-latency receive buffer: size it to the measured jitter instead of a fixed value.
  // Clean LAN (jitter ~0) → ~6ms (feels instant); jittery/distant link → grows up to ~160ms to stay smooth.
  if (sess.videoReceiver) {
    // Smooth the measurement (EMA) and only retune when it moves meaningfully — constantly resizing the
    // jitter buffer each tick caused its own playout stutter that read as flicker.
    const jitterMs = inbound && inbound.jitter != null ? inbound.jitter * 1000 : 0;
    sess._jitterAvg = sess._jitterAvg == null ? jitterMs : sess._jitterAvg * 0.8 + jitterMs * 0.2;
    // Sized from the network jitter only. The old floor of ~2.5 frames at the MEASURED fps was the main mouse
    // lag: an ordinary desktop is mostly still (≈10 fps sent), so the buffer grew to 110–170 ms on a clean link
    // (measured 130 ms at RTT 0). WebRTC's own jitter buffer still holds what bursty delivery needs on top.
    // A bad link (flagged last tick) may go deeper to stay smooth; a clean one stays at ~10–20 ms.
    const jbCap = sess._netDegradedV ? 250 : 120;
    const target = Math.max(12, Math.min(jbCap, Math.round(sess._jitterAvg * 2) + 10));
    if (sess._jbTarget == null || Math.abs(target - sess._jbTarget) >= 10) {
      sess._jbTarget = target;
      try { sess.videoReceiver.jitterBufferTarget = target; } catch {}
      try { sess.videoReceiver.playoutDelayHint = target / 1000; } catch {}
    }
  }
  if (show) {
    const v = sess.video;
    $("#stat-res").textContent = (v && v.videoWidth) ? `${v.videoWidth}×${v.videoHeight}` : "-";
    $("#stat-codec").textContent = codecMime || "-";
  }
  if (pair) {
    const rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
    sess.latencyText = rtt != null ? `${rtt} ms` : "- ms";
    sess.latencyClass = rtt == null ? "" : rtt < 60 ? "lat-good" : rtt < 160 ? "lat-ok" : "lat-bad";
    if (show) {
      $("#stat-latency").textContent = rtt != null ? `${rtt} ms` : "-";
      const latBadge = $("#rt-latency-badge");
      latBadge.textContent = sess.latencyText;
      latBadge.className = `sb-badge sb-lat ${sess.latencyClass}`;
      const local = stats.get(pair.localCandidateId);
      const type = local ? local.candidateType : "";
      $("#stat-route").textContent = type === "relay" ? "Relay (TURN)" : type === "host" ? "P2P lokal" : "P2P langsung";
    }
  }
  // ─── Network-health adaptation (viewer → host) ────────────
  // Trade resolution for smoothness on an unstable link: measure per-tick packet loss + RTT, and when the
  // link is clearly bad, tell the host to switch degradationPreference to "balanced" (shed resolution, keep
  // the picture MOVING). Recover to sharp HD only when the link is clearly good again. Hysteresis = no flapping.
  if (inbound && sess.role === "viewer" && sess.dataChannel && sess.dataChannel.readyState === "open") {
    const recv = inbound.packetsReceived || 0, lost = inbound.packetsLost || 0;
    const dRecv = recv - (sess._lastRecv || 0), dLost = lost - (sess._lastLost || 0);
    sess._lastRecv = recv; sess._lastLost = lost;
    const lossPct = (dRecv + dLost) > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
    sess._lossAvg = sess._lossAvg == null ? lossPct : sess._lossAvg * 0.7 + lossPct * 0.3;
    const rttMs = pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : 0;
    sess._rttAvg = sess._rttAvg == null ? rttMs : sess._rttAvg * 0.7 + rttMs * 0.3;
    const bad = sess._lossAvg > 4 || sess._rttAvg > 250;      // clearly bad link
    const good = sess._lossAvg < 1.2 && sess._rttAvg < 150;   // clearly good link
    const want = sess._netDegradedV ? !good : bad;            // sticky both ways → no flapping
    if (want !== !!sess._netDegradedV) {
      sess._netDegradedV = want;
      try { sess.dataChannel.send(JSON.stringify({ __ctrl: "net-mode", degraded: want })); } catch {}
    }
  }
}

// ─── Input capture (viewer) ───────────────────────────────
function sendInput(ev) {
  const sess = active; if (!sess || sess.viewOnly) return;
  if (sess.role === "viewer" && sess.dataChannel && sess.dataChannel.readyState === "open") sess.dataChannel.send(JSON.stringify(ev));
}
// Pointer position. With a 1.2.3+ host it goes on the unordered "move" channel at up to 125 Hz; otherwise (or
// when ordering matters, i.e. right before a click) on the ordered control channel at 60 Hz as before. The
// sequence number lets the host drop moves that arrive late (onHostMove).
const moveChannelOpen = (s) => !!(s && s.moveChannel && s.moveChannel.readyState === "open");
const moveIntervalMs = () => (moveChannelOpen(active) ? 8 : 16);
function sendMove(p, ordered = false) {
  const sess = active; if (!sess || sess.viewOnly || sess.role !== "viewer") return;
  sess._moveSeqOut = (sess._moveSeqOut || 0) + 1;
  const msg = JSON.stringify({ action: "mousemove", x: p.x, y: p.y, s: sess._moveSeqOut });
  if (!ordered && moveChannelOpen(sess)) { try { sess.moveChannel.send(msg); return; } catch {} }
  if (sess.dataChannel && sess.dataChannel.readyState === "open") sess.dataChannel.send(msg);
}
function normalizedPoint(e) {
  const video = activeVideo();
  if (!video) return null;
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const w = vw * scale, h = vh * scale;
  const left = rect.left + (rect.width - w) / 2, top = rect.top + (rect.height - h) / 2;
  const x = (e.clientX - left) / w, y = (e.clientY - top) / h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y };
}
const BUTTONS = ["left", "middle", "right"];
const remoteButtonsDown = new Set();   // buttons pressed on the remote screen and not yet released there
let panning = false, panStart = null;

// ── Game mode: pointer-lock + relative mouse (for Minecraft/FPS and any pointer-capturing game) ──
let gameMode = false, gameSens = 1, accDx = 0, accDy = 0, relTimer = null;
// Host px per displayed CSS px — so a relative move maps 1:1 to the remote screen.
function videoScale() {
  const video = activeVideo(); if (!video) return 1;
  const rect = video.getBoundingClientRect(); const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || !rect.width) return 1;
  return Math.max(0.0001, Math.min(rect.width / vw, rect.height / vh));
}
function flushRel() {
  relTimer = null; const dx = accDx, dy = accDy; accDx = accDy = 0;
  if (Math.round(dx) || Math.round(dy)) sendInput({ action: "mousemove-rel", dx, dy });
}
function toggleGameMode() {
  const sess = active;
  if (!sess || sess.role !== "viewer") return;
  if (sess.viewOnly) { showToast("Mode lihat saja aktif — matikan dulu untuk mode game"); return; }
  setGameCapture(!_gameActive);   // native capture (same path auto uses); reliable because the window is focused
}

// Write a line to the app's crash log (traces the game-mode chain for diagnosis).
const dlog = (m) => { try { window.electronAPI && window.electronAPI.logInfo && window.electronAPI.logInfo(m); } catch {} };
// Lock the pointer SYNCHRONOUSLY so the user's click still counts as the activation gesture.
// (A promise-based requestPointerLock({unadjustedMovement}) fallback ran in an async callback where
// the gesture is already gone, so Chromium refused the lock — that broke game capture. Keep it plain.)
function lockPointer(el) {
  try { el.requestPointerLock(); } catch (e) { try { showToast("Gagal mengunci mouse untuk game: " + e.message); } catch {} }
}

// Automatic game mode: the host tells us when a game/app captures its cursor; the viewer switches to
// NATIVE relative-mouse capture (main-process low-level hook) with NO user action — no toggle, no click, no
// pointer-lock gesture. The game gets true 360° mouse-look; Pause/Break releases it.
let _pendingGame = false;   // pointer-lock fallback is armed when native capture can't install
function setGameCapture(on) {
  if (on === _gameActive) return;
  _gameActive = on;
  const c = $("#remote-canvas-container");
  if (c) c.classList.toggle("game-mode", on);
  dlog("setGameCapture " + (on ? "ON" : "OFF"));
  try { window.electronAPI && window.electronAPI.setMouseCapture && window.electronAPI.setMouseCapture(on); } catch {}
  if (on) {
    // Force keyboard capture ON too, so the ESCAPE keys (Pause, Ctrl+Alt+Shift+Esc) are always caught — otherwise
    // the mouse could be locked to the remote with no way back.
    try { window.electronAPI && window.electronAPI.setKeyCapture && window.electronAPI.setKeyCapture(true); } catch {}
    showGameBanner(true);
  } else {
    _pendingGame = false;
    showGameBanner(false);
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch {}
  }
}
// Persistent on-screen reminder of how to get the mouse/keyboard back while game mode holds them captive.
function showGameBanner(on) {
  let b = $("#game-banner");
  if (on) {
    if (!b) {
      b = document.createElement("div");
      b.id = "game-banner";
      b.textContent = "🎮 Mode game aktif — tekan Pause (atau Ctrl+Alt+Shift+Esc) untuk lepas kontrol";
      document.body.appendChild(b);
    }
    b.style.display = "";
  } else if (b) b.style.display = "none";
}
// Main reports whether the native mouse hook installed. If it couldn't, fall back to the proven
// pointer-lock path so game mouse still works (engages on the next click).
if (window.electronAPI && window.electronAPI.onMouseCaptureResult) {
  window.electronAPI.onMouseCaptureResult(({ want, ok }) => {
    dlog("mouse-capture-result want=" + want + " ok=" + ok);
    if (want && !ok && _gameActive) { _pendingGame = true; showToast("Mode game: klik layar untuk ambil kontrol mouse"); lockPointer($("#remote-canvas-container")); }
  });
}
function setAutoGame(sess, on) {
  // AUTO game-mouse DISABLED. The host "cursor hidden" signal false-positives during normal use (many
  // apps hide the cursor while typing/idle), which wrongly locked + re-centered the viewer's mouse
  // ("cursor jumps to center"), blocked clicking the UI ("can't change FPS"), and looked like flicker.
  // Game mouse is now MANUAL only: Control Center -> Fitur lainnya -> "Mode game (mouse)".
  dlog("game-auto received on=" + on + " (ignored — game mouse is manual only)");
}
// An admin window (Task Manager, admin CMD) in front of a non-elevated host: Windows drops our clicks and keys and
// hides the cursor over it. Host: tell the viewer, and say once here how to allow it. Viewer: show why, until it closes.
let _adminHintShown = false;
window.electronAPI?.onHostAdminWindow?.((on) => {
  if (!host || host.role !== "host") return;
  if (host.dataChannel && host.dataChannel.readyState === "open") {
    try { host.dataChannel.send(JSON.stringify({ __ctrl: "admin-window", on })); } catch {}
  }
  if (on && !_adminHintShown) {
    _adminHintShown = true;
    showToast("Jendela administrator aktif: pengontrol tidak bisa klik atau mengetik di jendela ini. Jalankan TryDesk sebagai administrator (Pengaturan → Keamanan) agar bisa.");
  }
});
function renderAdminBanner() {
  let b = $("#admin-banner");
  const on = !!(active && active.adminWindow && !$("#screen-remote").classList.contains("hidden"));
  if (!on) { if (b) b.style.display = "none"; return; }
  if (!b) {
    b = document.createElement("div");
    b.id = "admin-banner";
    b.setAttribute("role", "status");
    document.body.appendChild(b);
  }
  b.textContent = tr("Jendela administrator (mis. Task Manager) terbuka di PC remote. Windows memblokir klik, ketikan, dan kursor ke jendela itu. Minta pemilik PC menutupnya, atau menjalankan TryDesk sebagai administrator.");
  b.style.display = "";
}

// Host side: relay the host cursor-capture state to the connected viewer.
if (window.electronAPI && window.electronAPI.onHostCursorHidden) {
  window.electronAPI.onHostCursorHidden((hidden) => {
    const dc = host && host.dataChannel && host.dataChannel.readyState;
    dlog("host-cursor-hidden=" + hidden + " host=" + !!host + " role=" + (host && host.role) + " dc=" + dc);
    if (host && host.role === "host" && host.dataChannel && host.dataChannel.readyState === "open") {
      try { host.dataChannel.send(JSON.stringify({ __ctrl: "game-auto", on: !!hidden })); dlog("sent game-auto on=" + !!hidden); } catch (e) { dlog("send game-auto failed: " + e.message); }
    }
  });
}

function setupInputCapture() {
  const container = $("#remote-canvas-container");
  document.addEventListener("pointerlockerror", () => { dlog("pointerlock ERROR (refused)"); showToast("Mouse tidak bisa dikunci untuk mode game (pointer lock ditolak)"); });
  document.addEventListener("pointerlockchange", () => {
    gameMode = document.pointerLockElement === container;
    dlog("pointerlockchange gameMode=" + gameMode);
    container.classList.toggle("game-mode", gameMode);
    if (!gameMode) { accDx = accDy = 0; if (relTimer) { clearTimeout(relTimer); relTimer = null; } }
    showToast(gameMode ? "Mode game aktif — gerakan mouse relatif. Tekan Esc untuk keluar" : "Mode game nonaktif");
  });
  let lastMove = null, lastSentAt = 0, moveTimer = null;
  const flushMove = () => { moveTimer = null; lastSentAt = performance.now(); if (lastMove) sendMove(lastMove); };
  const canPan = () => scaleMode !== "fit";
  container.addEventListener("mousemove", (e) => {
    if (gameMode && document.pointerLockElement === container) {
      const sc = videoScale();
      accDx += (e.movementX || 0) / sc * gameSens;
      accDy += (e.movementY || 0) / sc * gameSens;
      if (!relTimer) relTimer = setTimeout(flushRel, 8);
      return;
    }
    if (panning) {
      container.scrollLeft = panStart.sl - (e.clientX - panStart.x);
      container.scrollTop = panStart.st - (e.clientY - panStart.y);
      return;
    }
    lastMove = normalizedPoint(e);
    if (!lastMove || moveTimer) return;
    const wait = moveIntervalMs() - (performance.now() - lastSentAt);
    if (wait <= 0) flushMove(); else moveTimer = setTimeout(flushMove, wait);
  });
  container.addEventListener("mousedown", (e) => {
    if (_pendingGame && !gameMode && document.pointerLockElement !== container) {
      lockPointer(container);
      e.preventDefault(); return;   // this click engages game control; game gets the next clicks
    }
    if (gameMode && document.pointerLockElement === container) {
      e.preventDefault();
      sendInput({ action: "mousedown", button: BUTTONS[e.button] || "left" });
      return;
    }
    if (canPan() && e.button === 1) {   // pan with middle-mouse drag only — never hijack Space
      panning = true;
      container.classList.add("panning");
      panStart = { x: e.clientX, y: e.clientY, sl: container.scrollLeft, st: container.scrollTop };
      e.preventDefault();
      return;
    }
    const p = normalizedPoint(e); if (!p) return;
    sendMove(p, true);   // on the ordered channel, so it is applied before the click that follows
    const b = BUTTONS[e.button] || "left";
    remoteButtonsDown.add(b);
    sendInput({ action: "mousedown", button: b });
  });
  const endPan = () => { if (panning) { panning = false; container.classList.remove("panning"); } };
  container.addEventListener("mouseup", (e) => {
    if (gameMode && document.pointerLockElement === container) { sendInput({ action: "mouseup", button: BUTTONS[e.button] || "left" }); return; }
    if (panning) return endPan();
    const b = BUTTONS[e.button] || "left";
    remoteButtonsDown.delete(b);
    sendInput({ action: "mouseup", button: b });
  });
  // A drag that started on the remote screen but is released over the tab strip / session bar (outside the
  // video) must still release the button on the host, or it stays held and every later move drags.
  window.addEventListener("mouseup", (e) => {
    endPan();
    const b = BUTTONS[e.button] || "left";
    if (remoteButtonsDown.has(b) && !container.contains(e.target)) { remoteButtonsDown.delete(b); sendInput({ action: "mouseup", button: b }); }
  });
  window.addEventListener("blur", () => {
    for (const b of remoteButtonsDown) sendInput({ action: "mouseup", button: b });
    remoteButtonsDown.clear();
  });
  container.addEventListener("contextmenu", (e) => e.preventDefault());
  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    // Scale the wheel delta into notch-sized ticks so fast wheels/trackpads scroll at a natural speed
    const toTicks = (d) => d === 0 ? 0 : Math.max(1, Math.min(10, Math.round(Math.abs(d) / 40))) * Math.sign(d);
    sendInput({ action: "scroll", deltaX: toTicks(e.deltaX), deltaY: toTicks(e.deltaY) });
  }, { passive: false });
  const pressedKeys = new Set();
  for (const type of ["keydown", "keyup"]) {
    document.addEventListener(type, (e) => {
      if (!active || active.role !== "viewer" || $("#screen-remote").classList.contains("hidden")) return;
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) return;
      // Forward every key to the remote (Space included). preventDefault stops the browser from
      // scrolling the page or triggering its own shortcuts so the keystroke only goes to the host.
      e.preventDefault();
      if (type === "keydown") pressedKeys.add(e.keyCode); else pressedKeys.delete(e.keyCode);
      sendInput({ action: type, vk: e.keyCode });
    });
  }
  // Release every still-held key when the viewer loses focus (Alt+Tab, click away, minimize). Without
  // this a lost keyup leaves Ctrl/Alt/Shift "stuck down" on the host — breaking typing, copy/paste and
  // shortcuts afterwards. Covers the #1 cause of "keyboard tidak sinkron".
  function releaseAllKeys() {
    if (!pressedKeys.size) return;
    for (const vk of pressedKeys) sendInput({ action: "keyup", vk });
    pressedKeys.clear();
  }
  window.addEventListener("blur", releaseAllKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAllKeys(); });

  // Keys captured natively in the main process (system shortcuts like Alt+Tab/Win that the browser never
  // sees outside fullscreen) arrive here and are forwarded to the host exactly like local keys.
  if (window.electronAPI && window.electronAPI.onCapturedKey) {
    window.electronAPI.onCapturedKey(({ vk, down }) => {
      if (!active || active.role !== "viewer" || $("#screen-remote").classList.contains("hidden")) return;
      if (down) pressedKeys.add(vk); else pressedKeys.delete(vk);
      sendInput({ action: down ? "keydown" : "keyup", vk });
    });
  }
  // Main process asks us to release all held keys (window lost focus, capture turned off) so no modifier
  // sticks down on the host.
  if (window.electronAPI && window.electronAPI.onReleaseKeys) window.electronAPI.onReleaseKeys(releaseAllKeys);
  // Mouse captured natively in the main process (game mode) → forward to the host exactly like local input.
  if (window.electronAPI && window.electronAPI.onCapturedMouse) {
    window.electronAPI.onCapturedMouse((m) => {
      if (!active || active.role !== "viewer" || active.viewOnly || $("#screen-remote").classList.contains("hidden")) return;
      // Batch moves into the 8ms accumulator (flushRel) so a high-polling-rate mouse doesn't flood the
      // data channel with 1000 messages/sec (which would congest it and add stutter).
      if (m.t === "move") { const sc = videoScale(); accDx += m.dx / sc * gameSens; accDy += m.dy / sc * gameSens; if (!relTimer) relTimer = setTimeout(flushRel, 8); }
      else if (m.t === "down") sendInput({ action: "mousedown", button: m.b });
      else if (m.t === "up") sendInput({ action: "mouseup", button: m.b });
      else if (m.t === "wheel") sendInput({ action: "scroll", deltaX: 0, deltaY: -Math.sign(m.d) });   // notch per event, matching local wheel direction
      else if (m.t === "hwheel") sendInput({ action: "scroll", deltaX: Math.sign(m.d), deltaY: 0 });
    });
  }
  // Pause/Break pressed locally → release native game capture (frees the mouse) so the user can click away.
  if (window.electronAPI && window.electronAPI.onReleaseControl) {
    window.electronAPI.onReleaseControl(() => {
      setGameCapture(false);
      releaseAllKeys();
      // Really hand the keyboard back too (until the user clicks into the remote view again), and leave
      // fullscreen — Esc itself goes to the remote, so this is the way out.
      _kbReleased = true;
      refreshKeyCapture();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      showToast("Kontrol dilepas — mouse & keyboard kembali ke PC ini. Klik layar remote untuk lanjut.");
    });
  }
  // Pause capture while a local text field is focused (so the user can type in TryDesk's own UI), resume after.
  document.addEventListener("focusin", refreshKeyCapture);
  document.addEventListener("focusout", () => setTimeout(refreshKeyCapture, 0));
}

// ─── Settings overlay ─────────────────────────────────────
function toggleSettings() { if (overlaySettings.classList.toggle("hidden") === false) syncDefaultQualityUI(); }

// Settings tabs
$$(".stab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".stab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $$(".settings-tab-content").forEach((c) => c.classList.add("hidden"));
    const target = tab.dataset.tab;
    $(`#${target}`).classList.remove("hidden");
  });
});

// Device alias
$("#btn-save-alias").addEventListener("click", () => {
  const alias = $("#device-alias").value.trim();
  store.set("deviceAlias", alias || null);
  showToast(alias ? `Alias disimpan: ${alias}` : "Alias dihapus");
});

// Theme
function applyTheme(theme) {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}
$("#setting-theme").addEventListener("change", (e) => {
  applyTheme(e.target.value);
  store.set("theme", e.target.value);
});

// Language
$("#setting-language").addEventListener("change", (e) => {
  applyLanguage(e.target.value);
  store.set("lang", lang);
  showToast(t("lang_changed"));
});

// Auto-reconnect
$("#setting-auto-reconnect").addEventListener("change", (e) => {
  autoReconnect = e.target.checked;
  store.set("autoReconnect", autoReconnect ? "1" : "0");
});

// ─── Preferences (Settings panel) ─────────────────────────
// Every control in the panel is saved under its key and APPLIED where it matters — nothing there is decoration.
// Booleans persist as "1"/"0". apply(value, atStartup) runs on load and on every change.
const PREFS = {
  notifyIncoming: { el: "#setting-notify-incoming", def: true },
  notifySound:    { el: "#setting-notify-sound", def: true },
  closeToTray:    { el: "#setting-close-to-tray", def: true },
  discord:        { el: "#setting-discord", def: true, apply: (v) => window.electronAPI.setDiscordEnabled(v) },
  connTimeout:    { el: "#setting-timeout", def: "60" },
  autoAcceptPw:   { el: "#setting-autoaccept", def: true, apply: (v) => { autoAcceptWithPassword = v; } },
  lanDirect:      { el: "#setting-lan", def: false, apply: (v, boot) => { applyLanHost(v, boot); } },
  bwLimit:        { el: "#setting-bw-limit", def: "0", apply: (_v, boot) => { if (!boot && host && host.pc) applyQualityToSender(host, hostQuality); } },
  protocol:       { el: "#setting-connection-protocol", def: "auto" },
  preventSleep:   { el: "#setting-prevent-sleep", def: false, apply: (v, boot) => { if (!boot && host && host.pc) window.electronAPI.setPowerSave(v); } },
  lockAfter:      { el: "#setting-lock-after-session", def: false },
  sessionLimit:   { el: "#setting-session-timeout", def: "0", apply: (_v, boot) => { if (!boot && host) armSessionLimit(host); } },
  bruteForce:     { el: "#setting-brute-force", def: true, apply: (v) => { bruteForceGuard = v; } },
  defScale:       { el: "#setting-default-scale", def: "fit" },
  autoStats:      { el: "#setting-autostats", def: false, key: "showStats",
                    apply: (v) => { statsOverlay.classList.toggle("hidden", !v); const cb = $("#stats-toggle"); if (cb) cb.checked = v; } },
  autoAudio:      { el: "#setting-auto-audio", def: false },
  audioVolume:    { el: "#setting-audio-volume", def: "100",
                    apply: (v) => { $("#setting-audio-volume-num").value = v; for (const s of viewerSessions()) if (s.video) s.video.volume = v / 100; } },
};
function prefGet(name) {
  const p = PREFS[name];
  const raw = store.get(p.key || "pref." + name);
  if (raw == null) return p.def;
  return typeof p.def === "boolean" ? raw === "1" : raw;
}
function prefSet(name, v) {
  const p = PREFS[name];
  store.set(p.key || "pref." + name, typeof p.def === "boolean" ? (v ? "1" : "0") : String(v));
  if (p.apply) p.apply(v, false);
}
function initPrefs() {
  for (const [name, p] of Object.entries(PREFS)) {
    const el = $(p.el); if (!el) continue;
    const v = prefGet(name);
    if (el.type === "checkbox") el.checked = v; else el.value = v;
    if (p.apply) p.apply(v, true);
    el.addEventListener(el.type === "range" ? "input" : "change", () => prefSet(name, el.type === "checkbox" ? el.checked : el.value));
  }
  $("#setting-audio-volume-num").addEventListener("change", (e) => {
    const v = String(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))));
    $("#setting-audio-volume").value = v; prefSet("audioVolume", v);
  });
  // The stats toggle on the remote screen and this setting are the same preference.
  $("#stats-toggle").addEventListener("change", (e) => { const s = $("#setting-autostats"); if (s) s.checked = e.target.checked; });
  // OS-level settings: Windows is the source of truth.
  window.electronAPI.getLoginItem().then((on) => { $("#setting-startup").checked = !!on; }).catch(() => {});
  $("#setting-startup").addEventListener("change", (e) => window.electronAPI.setLoginItem(e.target.checked));
  window.electronAPI.getHwAccel().then((on) => { $("#setting-hw-accel").checked = !!on; }).catch(() => {});
  $("#setting-hw-accel").addEventListener("change", async (e) => {
    await window.electronAPI.setHwAccel(e.target.checked);
    showToast("Berlaku setelah TryDesk dibuka ulang");
  });
  // Default quality / codec for NEW tabs (the per-tab quality panel also updates this default).
  $("#setting-default-quality").addEventListener("change", (e) => {
    const p = e.target.value === "default" ? DEFAULT_QUALITY : PRESETS[e.target.value];
    if (!p) return;
    defaultQuality = { ...defaultQuality, bitrate: p.bitrate, fps: p.fps, resHeight: p.resHeight };
    store.set("quality", JSON.stringify(defaultQuality));
  });
  $("#setting-default-codec").addEventListener("change", (e) => {
    defaultQuality = { ...defaultQuality, codec: e.target.value };
    store.set("quality", JSON.stringify(defaultQuality));
  });
  $("#btn-reset-settings").addEventListener("click", resetSettings);
  // About: real version + links that open in the browser (navigation inside the window is blocked).
  const ver = `TryDesk v${config.appVersion || ""}`.trim();
  $("#about-version").textContent = ver; $("#status-version").textContent = ver;
  $$("[data-external]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.electronAPI.openExternal(a.href); }));
}
// Reflect the CURRENT default quality/codec whenever Settings opens (the quality panel may have changed them).
function syncDefaultQualityUI() {
  const q = defaultQuality;
  const match = Object.entries({ default: DEFAULT_QUALITY, ...PRESETS }).find(([, p]) => p.bitrate === q.bitrate && p.fps === q.fps && (p.resHeight || 0) === (q.resHeight || 0));
  $("#setting-default-quality").value = match ? match[0] : "custom";
  $("#setting-default-codec").value = q.codec || "auto";
}
async function resetSettings() {
  const ok = await window.electronAPI.confirm({
    title: tr("Reset semua pengaturan?"), message: tr("Semua pengaturan kembali ke bawaan."),
    detail: tr("ID, favorit, riwayat koneksi dan password akses tetap disimpan. TryDesk akan dimuat ulang."),
    okLabel: tr("Reset"), cancelLabel: tr("Batal"),
  });
  if (!ok) return;
  // Credentials are not "settings": wiping the access password would silently make an unattended PC ask
  // for Accept on every connection.
  const KEEP = new Set(["myId", "myToken", "favorites", "recent", "recentConnections", "accessPasswordHash", "peerNames", "peerThumbs", "lang"]);
  try { for (const k of Object.keys(localStorage)) if (!KEEP.has(k)) localStorage.removeItem(k); } catch {}
  try { await window.electronAPI.setLoginItem(false); await window.electronAPI.setHwAccel(true); } catch {}
  location.reload();
}
// Short two-tone chime for an incoming request (WebAudio — no sound file to ship).
function chime() {
  try {
    const ctx = new AudioContext(), g = ctx.createGain(); g.connect(ctx.destination); g.gain.value = 0.08;
    [880, 1175].forEach((f, i) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.13); });
    setTimeout(() => ctx.close(), 600);
  } catch {}
}

// ─── Event listeners ──────────────────────────────────────
$("#btn-connect").addEventListener("click", initiateConnection);
$("#recent-sort").addEventListener("change", (e) => { recentSort = e.target.value; renderRecent(); renderFavorites(); });
$$(".sess-tab").forEach((b) => b.addEventListener("click", () => { homeTab = b.dataset.sess; store.set("homeTab", homeTab); renderSessionsView(); }));
$("#sess-search").addEventListener("input", () => { renderRecent(); renderFavorites(); });
$("#sess-search").addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.value) { e.stopPropagation(); e.target.value = ""; renderRecent(); renderFavorites(); } });
// Connect and open the File Manager as soon as the session's file channel is up (as "Transfer file" on a tile).
$("#btn-connect-files").addEventListener("click", () => {
  const s = initiateConnection();
  if (!(s instanceof Session)) return;
  if (s.fileChannel && s.fileChannel.readyState === "open") openFileManager();
  else s.openFilesWhenReady = true;
});
$("#recent-clear").addEventListener("click", clearRecent);
$("#view-grid").addEventListener("click", () => { recentView = "grid"; store.set("recentView", "grid"); applyRecentView(); });
$("#view-list").addEventListener("click", () => { recentView = "list"; store.set("recentView", "list"); applyRecentView(); });
$("#btn-cancel-connect").addEventListener("click", () => { if (active) { stopReconnect(active.peerId); closeSession(active, false); } });
$("#btn-disconnect").addEventListener("click", () => { if (active) closeSession(active, true); });
$("#btn-stop-hosting").addEventListener("click", () => { if (host) closeSession(host, true); });

// Grip bar buttons (mini titlebar during remote)
$("#grip-minimize").addEventListener("click", () => window.electronAPI.minimizeWindow());
$("#grip-maximize").addEventListener("click", () => window.electronAPI.maximizeWindow());
$("#grip-close").addEventListener("click", () => { if (active) closeSession(active, true); });

// The whole page goes fullscreen, not just the remote view: chat, file manager, transfer cards, key combos and
// toasts are page-level layers and would otherwise be invisible (while chat still took the keyboard).
$("#btn-fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

$("#remote-canvas-container").addEventListener("mousedown", () => { if (_kbReleased) { _kbReleased = false; refreshKeyCapture(); } }, true);
$("#back-to-session").addEventListener("click", (e) => { const s = e.currentTarget._target; if (s && sessions.get(s.peerId) === s) switchTab(s); });

// ─── Remote toolbar: Control Center + monitor dropdowns ───
function positionMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 8) + "px";
  // right-align under the trigger, clamped to the viewport
  const left = Math.min(Math.max(8, r.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
  menu.style.left = Math.round(left) + "px";
}
let ccFlyoutCat = null, ccFlyoutRow = null;
function closeAllMenus() {
  $("#control-center")?.classList.add("hidden");
  $("#cc-flyout")?.classList.add("hidden");
  $("#monitor-menu")?.classList.add("hidden");
  $("#btn-control-center")?.classList.remove("open");
  $("#btn-monitor")?.classList.remove("open");
  ccFlyoutCat = null; ccFlyoutRow = null;
}

// ─── Nested Control Center (StarDesk-style categories + flyouts) ───
const ccSvg = (inner, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${inner}</svg>`;
const CC_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;
const CC_ICON = {
  monitor: `<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>`,
  quality: `<path d="M3 12h4l3-9 4 18 3-9h4"/>`,
  window: `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`,
  sound: `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"/>`,
  security: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`,
  more: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
  x: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
};
const CC_PRESET_LABELS = { hemat: "Hemat", seimbang: "Seimbang", kualitas: "Kualitas", ultra: "Ultra", gaming: "Gaming", maksimal: "Maksimal" };
const CC_SCALES = [["fit", "Pas jendela"], ["1", "100%"], ["0.75", "75%"], ["0.5", "50%"], ["1.5", "150%"], ["2", "200%"]];
const CC_CATS = [
  { key: "monitor", label: "Monitor", value: () => active ? `Monitor ${active.currentMonitor + 1}` : "" },
  { key: "quality", label: "Kualitas gambar", value: () => { const m = ccPresetMatch(); return m ? CC_PRESET_LABELS[m] : `${qualityOf().fps} FPS`; } },
  { key: "window", label: "Tampilan", value: () => { const s = CC_SCALES.find(([v]) => v === scaleMode); return s ? s[1] : ""; } },
  { key: "sound", label: "Suara" },
  { key: "security", label: "Keamanan" },
  { key: "more", label: "Fitur lainnya" },
];
function ccPresetMatch() { const q = qualityOf(); const e = Object.entries(PRESETS).find(([, p]) => p.bitrate === q.bitrate && p.fps === q.fps && p.resHeight === q.resHeight); return e ? e[0] : null; }
function ccStatsShown() { return !statsOverlay.classList.contains("hidden"); }
function ccShowKeyMenu() {
  const menu = $("#key-menu"); const a = $("#btn-control-center").getBoundingClientRect();
  menu.classList.remove("hidden");
  menu.style.top = `${a.bottom + 8}px`;
  menu.style.left = `${Math.max(8, Math.min(a.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
}
function ccToggleStats() {
  const on = !ccStatsShown();
  statsOverlay.classList.toggle("hidden", !on);
  const cb = $("#stats-toggle"); if (cb) cb.checked = on;
  store.set("showStats", on ? "1" : "0");
}
function ccToggleClipboard() {
  clipboardSync = !clipboardSync;
  const cb = $("#clipboard-toggle"); if (cb) cb.checked = clipboardSync;
  store.set("clipboardSync", clipboardSync ? "1" : "0");
  restartClipboardAll();
  showToast(clipboardSync ? "Sinkron clipboard aktif" : "Sinkron clipboard mati");
}

function ccItems(cat) {
  const sess = active;
  switch (cat) {
    case "monitor":
      if (!sess || !sess.monitors.length) return [{ label: "Hanya 1 monitor terdeteksi", disabled: true }];
      return sess.monitors.map((m) => ({
        label: `Monitor ${m.index + 1}${m.primary ? " · utama" : ""}`,
        active: m.index === sess.currentMonitor,
        run: () => {
          if (m.index !== sess.currentMonitor && sess.dataChannel && sess.dataChannel.readyState === "open") {
            sess.dataChannel.send(JSON.stringify({ __ctrl: "select-monitor", index: m.index }));
            sess.currentMonitor = m.index;
            updateSessionLabel(sess); renderTabs();
            const el = $("#monitor-label"); if (el) el.textContent = `Monitor ${m.index + 1}`;
            if (sess.video) maskResChange(sess);   // cover the switch transition cleanly
            showToast(`Beralih ke Monitor ${m.index + 1}…`);
          }
        },
      }));
    case "quality": {
      const q = qualityOf();
      const out = [{ header: "Preset" }];
      const pm = ccPresetMatch();
      for (const [k, label] of Object.entries(CC_PRESET_LABELS)) out.push({ label, active: pm === k, run: () => setQuality(PRESETS[k]) });
      out.push({ divider: true }, { header: "Frame rate" });
      for (const f of [30, 60, 120, 144, 165, 180, 240]) out.push({ label: `${f} FPS`, active: q.fps === f, run: () => setQuality({ fps: f }) });
      out.push({ divider: true }, { header: "Resolusi" });
      for (const [v, label] of [[0, "Asli"], [1080, "1080p"], [720, "720p"], [480, "480p"]]) out.push({ label, active: q.resHeight === v, run: () => setQuality({ resHeight: v }) });
      out.push({ divider: true }, { header: "Codec" });
      for (const [v, label] of [["auto", "Otomatis"], ["AV1", "AV1 (hemat)"], ["VP9", "VP9"], ["VP8", "VP8"], ["H264", "H.264"]]) out.push({ label, active: q.codec === v, run: () => setQuality({ codec: v }, { reconnectCodec: true }) });
      out.push({ divider: true }, { label: "Pengaturan lanjutan…", close: true, run: () => $("#btn-quality").click() });
      return out;
    }
    case "window":
      return CC_SCALES.map(([v, label]) => ({ label, active: scaleMode === v, run: () => { scaleMode = v; if (active) active.scaleMode = v; const s = $("#scale-select"); if (s) s.value = v; applyScale(); } }));
    case "sound":
      if (!sess || !sess.audioAvailable) return [{ label: "Audio tidak tersedia di remote", disabled: true }];
      return [
        { label: sess.audioOn ? "Matikan audio remote" : "Aktifkan audio remote", active: sess.audioOn, run: toggleAudio },
        { slider: true },
      ];
    case "security":
      return [
        { label: "Mode lihat saja", active: !!sess && sess.viewOnly, run: () => $("#btn-viewonly").click() },
        { label: "Gelapkan layar host", active: !!sess && sess.blackScreenActive, run: toggleBlackScreen },
        { label: "Kunci input host", active: !!sess && sess.inputLocked, run: toggleLockInput },
      ];
    case "more":
      return [
        { label: _gameActive ? "Mode game: AKTIF (klik mematikan)" : "Mode game (mouse)", active: _gameActive, close: true, run: toggleGameMode },
        { label: "Transfer file", close: true, run: openFileManager },
        { label: "Chat", close: true, run: toggleChat },
        { label: "Kombinasi tombol", close: true, run: ccShowKeyMenu },
        { label: "Ambil screenshot", close: true, run: takeScreenshot },
        { label: isRecording() ? "Hentikan rekaman" : "Rekam sesi", active: isRecording(), run: toggleRecording },
        { divider: true },
        { label: "Tampilkan statistik", active: ccStatsShown(), run: ccToggleStats },
        { label: "Sinkron clipboard", active: clipboardSync, run: ccToggleClipboard },
      ];
  }
  return [];
}

function ccRender() {
  const cc = $("#control-center");
  cc.replaceChildren();
  for (const c of CC_CATS) {
    const row = document.createElement("button");
    row.className = "cc-cat"; row.dataset.cat = c.key;
    const v = c.value ? c.value() : "";
    row.innerHTML = `${ccSvg(CC_ICON[c.key])}<span class="cc-cat-label">${c.label}</span>${v ? `<span class="cc-cat-val">${v}</span>` : ""}<svg class="cc-cat-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"/></svg>`;
    cc.appendChild(row);
  }
  const divider = document.createElement("div"); divider.className = "cc-divider"; cc.appendChild(divider);
  const fs = document.createElement("button"); fs.className = "cc-leaf";
  fs.innerHTML = `${ccSvg(CC_ICON.window, 15)}<span>${document.fullscreenElement ? "Keluar layar penuh" : "Layar penuh"}</span>`;
  fs.addEventListener("click", (e) => { e.stopPropagation(); $("#btn-fullscreen").click(); ccClose(); });
  cc.appendChild(fs);
  const dc = document.createElement("button"); dc.className = "cc-leaf danger";
  dc.innerHTML = `${ccSvg(CC_ICON.x, 15)}<span>Putuskan koneksi</span>`;
  dc.addEventListener("click", (e) => { e.stopPropagation(); ccClose(); $("#btn-disconnect").click(); });
  cc.appendChild(dc);
}

function ccOpenFlyout(cat, rowEl) {
  ccFlyoutCat = cat; ccFlyoutRow = rowEl;
  const fly = $("#cc-flyout");
  fly.replaceChildren();
  for (const it of ccItems(cat)) {
    if (it.divider) { const d = document.createElement("div"); d.className = "cc-divider"; fly.appendChild(d); continue; }
    if (it.header) { const h = document.createElement("div"); h.className = "cc-flyout-header"; h.textContent = it.header; fly.appendChild(h); continue; }
    if (it.slider) {
      const w = document.createElement("div"); w.className = "cc-flyout-slider";
      const lab = document.createElement("span"); lab.textContent = "Volume";
      const r = document.createElement("input"); r.type = "range"; r.min = "0"; r.max = "100"; r.value = String(Math.round(((activeVideo()?.volume) ?? 1) * 100));
      r.addEventListener("input", () => { const v = activeVideo(); if (v) v.volume = r.value / 100; });
      r.addEventListener("click", (e) => e.stopPropagation());
      w.append(lab, r); fly.appendChild(w); continue;
    }
    const b = document.createElement("button"); b.className = "cc-leaf" + (it.active ? " active" : "");
    if (it.disabled) b.disabled = true;
    b.innerHTML = `<span class="cc-leaf-check">${it.active ? CC_CHECK : ""}</span><span>${it.label}</span>`;
    if (!it.disabled) b.addEventListener("click", (e) => { e.stopPropagation(); if (it.run) it.run(); if (it.close) ccClose(); else ccOpenFlyout(cat, rowEl); });
    fly.appendChild(b);
  }
  fly.classList.remove("hidden");
  ccPositionFlyout(fly, rowEl);
  $$("#control-center .cc-cat").forEach((r) => r.classList.toggle("open", r.dataset.cat === cat));
}

function ccPositionFlyout(fly, rowEl) {
  const panel = $("#control-center").getBoundingClientRect();
  const row = rowEl.getBoundingClientRect();
  const fw = fly.offsetWidth, fh = fly.offsetHeight;
  let left = panel.left - fw - 6;
  if (left < 8) left = Math.min(panel.right + 6, window.innerWidth - fw - 8);
  left = Math.max(8, Math.min(left, window.innerWidth - fw - 8));
  const top = Math.max(8, Math.min(row.top, window.innerHeight - fh - 8));
  fly.style.left = Math.round(left) + "px";
  fly.style.top = Math.round(top) + "px";
}

function ccClose() { closeAllMenus(); }

$("#btn-control-center").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#control-center"), btn = $("#btn-control-center");
  const open = menu.classList.contains("hidden");
  closeAllMenus();
  if (open) { ccRender(); menu.classList.remove("hidden"); btn.classList.add("open"); positionMenu(menu, btn); }
});
$("#control-center").addEventListener("click", (e) => {
  const cat = e.target.closest(".cc-cat");
  e.stopPropagation();
  if (!cat) return;
  if (ccFlyoutCat === cat.dataset.cat) {
    $("#cc-flyout").classList.add("hidden");
    $$("#control-center .cc-cat").forEach((r) => r.classList.remove("open"));
    ccFlyoutCat = null; ccFlyoutRow = null;
  } else ccOpenFlyout(cat.dataset.cat, cat);
});
document.addEventListener("click", (e) => { if (!e.target.closest(".cc-wrap")) closeAllMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllMenus(); });
document.addEventListener("fullscreenchange", () => {
  const fs = !!document.fullscreenElement;
  $("#btn-fullscreen")?.classList.toggle("active", fs);
  // Keyboard Lock (fullscreen-only, browser limit) lets the remote view capture system shortcuts like
  // Alt+Tab, the Win key and Esc so they reach the host instead of the local OS. Outside fullscreen the
  // OS always grabs them — so system shortcuts forward only in fullscreen.
  try {
    if (fs && navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock();
    else if (!fs && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  } catch {}
});

// Session timer (per session; only the active tab writes to #session-timer)
function startSessionTimer(sess) {
  sess.sessionStart = Date.now();
  clearInterval(sess.sessionTimer);
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - sess.sessionStart) / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const txt = (hh ? String(hh).padStart(2, "0") + ":" : "") + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
    sess.timerText = txt;
    if (sess === active) { const el = $("#session-timer"); if (el) el.textContent = txt; }
  };
  tick(); sess.sessionTimer = setInterval(tick, 1000);
}
function stopSessionTimer(sess) {
  if (sess && sess.sessionTimer) { clearInterval(sess.sessionTimer); sess.sessionTimer = null; }
  if (sess) sess.timerText = "00:00";
  if (!active) { const el = $("#session-timer"); if (el) el.textContent = "00:00"; }
}

$("#btn-viewonly").addEventListener("click", () => {
  const sess = active; if (!sess) return;
  sess.viewOnly = !sess.viewOnly;
  $("#btn-viewonly").classList.toggle("active", sess.viewOnly);
  $("#remote-canvas-container").classList.toggle("viewonly", sess.viewOnly);
  showToast(sess.viewOnly ? "Mode lihat saja aktif" : "Kontrol aktif kembali");
  refreshKeyCapture();
});

// Quality panel open/close
$("#btn-quality").addEventListener("click", () => {
  const open = qualityPanel.classList.toggle("hidden");
  $("#btn-quality").classList.toggle("active", !open);
  if (!open) syncQualityUI();
});
$("#btn-quality-close").addEventListener("click", () => {
  qualityPanel.classList.add("hidden");
  $("#btn-quality").classList.remove("active");
});

// View scale (applies to the active tab; each session's <video> binds its own resize listeners)
$("#scale-select").addEventListener("change", (e) => { scaleMode = e.target.value; if (active) active.scaleMode = scaleMode; applyScale(); });

// Presets
$$(".preset-btn").forEach((b) => b.addEventListener("click", () => setQuality(PRESETS[b.dataset.preset])));

// Bitrate slider + number
$("#bitrate-slider").addEventListener("input", (e) => { $("#bitrate-number").value = e.target.value; });
$("#bitrate-slider").addEventListener("change", (e) => setQuality({ bitrate: clampBitrate(e.target.value) }));
$("#bitrate-number").addEventListener("change", (e) => { const v = clampBitrate(e.target.value); e.target.value = v; $("#bitrate-slider").value = v; setQuality({ bitrate: v }); });
function clampBitrate(v) { return Math.min(1000, Math.max(1, Math.round(+v) || 1)); }

// FPS + resolution chips
$$("#fps-row .chip").forEach((c) => c.addEventListener("click", () => setQuality({ fps: +c.dataset.fps })));
$$("#res-row .chip").forEach((c) => c.addEventListener("click", () => setQuality({ resHeight: +c.dataset.scale })));

// Codec
$("#codec-select").addEventListener("change", (e) => setQuality({ codec: e.target.value }, { reconnectCodec: true }));

// Stats toggle
$("#stats-toggle").addEventListener("change", (e) => {
  statsOverlay.classList.toggle("hidden", !e.target.checked);
  store.set("showStats", e.target.checked ? "1" : "0");
});

// Clipboard toggle
$("#clipboard-toggle").addEventListener("change", (e) => {
  clipboardSync = e.target.checked;
  store.set("clipboardSync", clipboardSync ? "1" : "0");
  restartClipboardAll();
  showToast(clipboardSync ? "Sinkron clipboard aktif" : "Sinkron clipboard mati");
});

// File transfer buttons
$("#btn-send-file").addEventListener("click", startSendFiles);
$("#btn-host-send-file").addEventListener("click", startSendFiles);

// Audio + monitor
$("#btn-audio").addEventListener("click", toggleAudio);
// Monitor switcher dropdown
$("#btn-monitor").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#monitor-menu"), btn = $("#btn-monitor");
  const open = menu.classList.contains("hidden");
  closeAllMenus();
  if (open) { menu.classList.remove("hidden"); btn.classList.add("open"); positionMenu(menu, btn); }
});

// Chat
$("#btn-chat").addEventListener("click", toggleChat);
$("#btn-host-chat").addEventListener("click", toggleChat);
$("#btn-chat-close").addEventListener("click", closeChat);
$("#btn-chat-send").addEventListener("click", sendChat);
$("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

// Shortcut keys
$("#btn-keys").addEventListener("click", (e) => { e.stopPropagation(); toggleKeyMenu(); });
$$("#key-menu button").forEach((b) => b.addEventListener("click", () => {
  sendCombo(b.dataset.keys.split(",").map(Number));
  $("#key-menu").classList.add("hidden");
}));
document.addEventListener("click", (e) => {
  if (!$("#key-menu").classList.contains("hidden") && !$("#key-menu").contains(e.target) && e.target.closest("#btn-keys") === null) $("#key-menu").classList.add("hidden");
});

// Screenshot
$("#btn-screenshot").addEventListener("click", takeScreenshot);

// Black screen + lock input
$("#btn-blackscreen").addEventListener("click", toggleBlackScreen);
$("#btn-lock-input").addEventListener("click", toggleLockInput);

$("#btn-copy").addEventListener("click", () => { if (myId) navigator.clipboard.writeText(myId).then(() => showToast(t("id_copied"))); });

// Opt-in ID rotation: drop the stored identity and reconnect so the server issues a FRESH id+token.
// The persistent-by-default ID is preserved; this is a deliberate, confirmed security action.
async function regenerateId() {
  let ok = false;
  try {
    if (window.electronAPI && window.electronAPI.confirm) {
      ok = await window.electronAPI.confirm({
        title: t("regen_confirm_title"), message: t("regen_confirm_msg"), detail: t("regen_confirm_detail"),
        okLabel: t("regen_confirm_ok"), cancelLabel: t("regen_confirm_cancel"),
      });
    } else { ok = window.confirm(t("regen_confirm_msg") + "\n\n" + t("regen_confirm_detail")); }
  } catch { ok = false; }
  if (!ok) return;
  // End any live sessions first — they belong to the OLD id — and any request still being answered.
  try { for (const s of [...sessions.values()]) closeSession(s, true); } catch {}
  try { if (host) closeSession(host, true); } catch {}
  try { if (acceptDlgCancel) acceptDlgCancel(); } catch {}
  if (pendingChallenge) { clearTimeout(pendingChallenge._t); pendingChallenge = null; }
  // Forget the identity; a fresh WebSocket has no clientId, so register() assigns a new id+token.
  store.set("myId", null); store.set("myToken", null);
  myId = null; _regenPending = true;
  myIdText.textContent = "…";
  setStatus("", t("connecting_server"));
  connectSignaling();
}
$("#btn-regen-id")?.addEventListener("click", regenerateId);

// Elevation: show "Run as administrator" in Security settings only when the host isn't elevated (so admin/UAC
// windows — which otherwise freeze remote control — can be controlled too).
async function refreshElevationUI() {
  try {
    const cfg = config || await window.electronAPI.getConfig();
    const el = cfg && cfg.platform && cfg.platform !== "win32" ? true : await window.electronAPI.isElevated();   // Windows-only setting
    const g = $("#admin-group"); if (g) g.style.display = el ? "none" : "";
    return el;
  } catch { return true; }
}
$("#btn-run-admin")?.addEventListener("click", async () => {
  let ok = true;
  try {
    if (window.electronAPI.confirm) ok = await window.electronAPI.confirm({
      title: tr("Jalankan sebagai administrator?"),
      message: tr("TryDesk akan ditutup lalu dibuka lagi dengan izin administrator."),
      detail: tr("Windows akan menampilkan prompt UAC. Sesi yang sedang berjalan akan terputus."),
      okLabel: tr("Lanjutkan"), cancelLabel: tr("Batal"),
    });
  } catch {}
  if (ok) {
    let started = false;
    try { started = await window.electronAPI.relaunchAsAdmin(); } catch {}
    if (!started) { showToast("UAC dibatalkan — TryDesk tetap berjalan tanpa hak administrator"); return; }
    // The elevated copy is starting and this one quits in a moment: end every session properly first, so the
    // other side is told why and the server drops the pairing (it used to stay "controlling" after the restart).
    const why = "TryDesk dibuka ulang sebagai administrator";
    try { for (const s of viewerSessions()) closeSession(s, true, why); if (host) closeSession(host, true, why); } catch {}
    showToast("TryDesk dibuka ulang sebagai administrator. Jendela baru muncul dalam beberapa detik, jangan buka TryDesk lagi sebelum itu.");
  }
});
window.electronAPI?.onElevatedRelaunchBlocked?.(() => showToast("TryDesk administrator tidak jadi terbuka karena TryDesk ini sudah berjalan. Klik kanan ikon TryDesk di tray → Keluar, lalu pilih Jalankan sebagai administrator lagi."));
refreshElevationUI();
// Access password: type → saved (as a salted hash) when the field is left or Enter is pressed; the trash button
// removes it. The eye button keeps focus in the field, so what you typed can be checked before it is saved.
function updateAccessPwUI() {
  const set = !!store.get("accessPasswordHash");
  accessPassword.placeholder = set ? "Password tersimpan (ketik untuk ganti)" : "Kosong = selalu minta Accept";
  $("#btn-clear-pass").classList.toggle("hidden", !set);
  const st = $("#access-pw-state");
  st.textContent = set ? "✓ Password akses aktif — koneksi dengan password ini tidak perlu klik Terima." : "Belum ada password akses — setiap koneksi perlu klik Terima.";
  st.classList.toggle("on", set);
  renderHomeFacts();
}
$("#btn-toggle-pass").addEventListener("mousedown", (e) => e.preventDefault());
$("#btn-toggle-pass").addEventListener("click", () => { accessPassword.type = accessPassword.type === "password" ? "text" : "password"; accessPassword.focus(); });
$("#btn-clear-pass").addEventListener("click", () => {
  store.set("accessPasswordHash", null); store.set("accessPwLan", null);
  accessPassword.value = "";
  updateAccessPwUI();
  showToast("Password akses dihapus");
});
accessPassword.addEventListener("keydown", (e) => { if (e.key === "Enter") accessPassword.blur(); });
accessPassword.addEventListener("change", async () => {
  const value = accessPassword.value;
  if (!value) return;   // an empty field leaves the saved password alone (the trash button removes it)
  if (value.length < 6) return showToast("Password minimal 6 karakter");
  store.set("accessPasswordHash", await hashPassword(value));
  store.set("accessPwLan", value.length >= LAN_PW_MIN ? "1" : "0");
  accessPassword.value = "";
  accessPassword.type = "password";
  updateAccessPwUI();
  showToast("Password akses disimpan");
});

// Digits are grouped as an ID ("123 456 789"); anything with a dot, colon or letter is left alone — an IP address
// or a LAN PC name (see parseLanTarget).
remoteIdInput.addEventListener("input", (e) => {
  const v = e.target.value;
  if (/[.,:\[\]a-z]/i.test(v)) { e.target.value = v.replace(/\s/g, "").replace(/,/g, ".").slice(0, 64); return; }   // (a phone keypad may offer "," for ".")
  const d = v.replace(/\D/g, "").slice(0, 9); e.target.value = d.match(/.{1,3}/g)?.join(" ") || "";
});
remoteIdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") initiateConnection(); });
remotePasswordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") initiateConnection(); });
// Eye button inside the password fields the viewer types into (home card and the Connecting screen's prompt), so a
// typed password can be checked before connecting. Like the settings one it keeps focus in the field.
const EYE_ON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
function addPwEye(input) {
  const wrap = document.createElement("div"); wrap.className = "pw-field";
  input.replaceWith(wrap); wrap.appendChild(input);
  const b = document.createElement("button"); b.type = "button"; b.className = "pw-eye"; b.title = "Tampilkan / sembunyikan";
  b.setAttribute("aria-pressed", "false"); b.innerHTML = EYE_ON;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password"; b.innerHTML = show ? EYE_OFF : EYE_ON; b.setAttribute("aria-pressed", String(show));
    input.focus();
  });
  wrap.appendChild(b);
}
addPwEye(remotePasswordInput);
addPwEye($("#connect-pw-input"));

$("#btn-minimize").addEventListener("click", () => window.electronAPI.minimizeWindow());
$("#btn-maximize").addEventListener("click", () => window.electronAPI.maximizeWindow());
// Quitting TryDesk ends every session and makes this PC unreachable until it is started again — ask first
// when something is running (a helper on the host's desktop could otherwise cut themselves off by accident).
async function confirmQuit(fromTray) {
  const live = !!host || viewerSessions().length > 0;
  if (!live) return true;
  if (fromTray) { try { window.electronAPI.focusWindow(); } catch {} }   // the question needs its context
  let ok = false;
  try {
    ok = await window.electronAPI.confirm({
      title: tr(fromTray ? "Keluar dari TryDesk?" : "Tutup TryDesk?"),
      message: tr(host ? "PC ini sedang dikontrol dari jarak jauh." : "Masih ada sesi remote yang terbuka."),
      detail: tr("Menutup TryDesk memutus semua sesi, dan PC ini tidak bisa dihubungi sampai TryDesk dibuka lagi."),
      okLabel: tr(fromTray ? "Keluar" : "Tutup"), cancelLabel: tr("Batal"),
    });
  } catch { ok = true; }
  if (ok) { try { for (const s of viewerSessions()) closeSession(s, true); if (host) closeSession(host, true); } catch {} }
  return ok;
}
// X (and Alt+F4 / the taskbar's Close): to the system tray like AnyDesk — sessions keep running, the PC stays
// reachable. With that setting off, X quits as before. The phone app has no tray (and no X).
async function onCloseButton() {
  if (prefGet("closeToTray") && window.electronAPI.hideToTray) {
    const first = store.get("tipTray") !== "1";
    if (first) store.set("tipTray", "1");
    window.electronAPI.hideToTray(first);
    return;
  }
  if (await confirmQuit(false)) window.electronAPI.closeWindow();
}
$("#btn-close").addEventListener("click", onCloseButton);
window.electronAPI.onCloseRequested?.(onCloseButton);
window.electronAPI.onQuitRequested?.(async () => { if (await confirmQuit(true)) window.electronAPI.quitApp(); });

$("#btn-settings").addEventListener("click", toggleSettings);
$("#btn-settings-close").addEventListener("click", toggleSettings);
overlaySettings.addEventListener("click", (e) => { if (e.target === overlaySettings) toggleSettings(); });

// ─── Host access permissions (Settings → Keamanan → Izin akses) ───
function applyAccessSettings() {
  allowInput = store.get("allowInput") !== "0";
  allowFileTransfer = store.get("allowFile") !== "0";
  allowClipboardPref = store.get("allowClipboard") !== "0";
  forceViewOnly = store.get("forceViewOnly") === "1";
  const set = (id, val) => { const el = $(id); if (el) el.checked = val; };
  set("#setting-allow-input", allowInput);
  set("#setting-allow-file", allowFileTransfer);
  set("#setting-allow-clipboard", allowClipboardPref);
  set("#setting-allow-viewonly", forceViewOnly);
}
// Changed while someone is connected: tell them right away, and if control was just taken away, let go of any
// key or mouse button they were holding (its "up" would now be dropped by the gate and stay stuck).
function hostPermsChanged() {
  if (!host) return;
  if (!hostControlAllowed()) {
    try { window.electronAPI.releaseRemoteInput(); } catch {}
    try { window.electronAPI.disableInputLock(); } catch {}
    // A viewer who darkened this screen must not keep it dark after control is revoked — restore it too.
    if (host.blackScreenActive) { try { window.electronAPI.disableBlackScreen(); } catch {} host.blackScreenActive = false; }
  }
  if (!hostFilesAllowed()) {
    if (host.activeRecv) { discardRecv(host.activeRecv); host.activeRecv = null; }
    if (host.activeSend) host.activeSend.canceled = true;
  }
  sendMonitors(host);
}
$("#setting-allow-input")?.addEventListener("change", (e) => { allowInput = e.target.checked; store.set("allowInput", allowInput ? "1" : "0"); hostPermsChanged(); });
$("#setting-allow-file")?.addEventListener("change", (e) => { allowFileTransfer = e.target.checked; store.set("allowFile", allowFileTransfer ? "1" : "0"); hostPermsChanged(); });
$("#setting-allow-clipboard")?.addEventListener("change", (e) => { allowClipboardPref = e.target.checked; store.set("allowClipboard", allowClipboardPref ? "1" : "0"); hostPermsChanged(); });
$("#setting-allow-viewonly")?.addEventListener("change", (e) => { forceViewOnly = e.target.checked; store.set("forceViewOnly", forceViewOnly ? "1" : "0"); hostPermsChanged(); });

// A file dropped on the window must never navigate it away (main blocks that too); point at the real way to send.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === "drop" && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      showToast(onHostingScreen() ? "Untuk mengirim file, klik tombol Kirim File" : "Untuk mengirim file, buka Control Center → Fitur lainnya → Transfer file");
    }
  });
}

// ─── Update check ─────────────────────────────────────────
// version.json on the website (see main.js check-update): a newer release gets a dismissable notice on the home
// screen; a version below "minimum" (raised only after a security fix) gets a red notice and refuses to open or accept
// connections until updated. A failed check (offline, LAN without internet) changes nothing.
let updateInfo = null, updateRequired = false;
function verCmp(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
const appVer = () => (config && /^\d+\.\d+\.\d+$/.test(config.appVersion || "") ? config.appVersion : "");
async function checkUpdate() {
  if (!appVer() || !window.electronAPI.checkUpdate) return;
  let info = null;
  try { info = await window.electronAPI.checkUpdate(); } catch {}
  if (!info || !info.latest) return;
  updateInfo = info;
  updateRequired = !!info.minimum && verCmp(appVer(), info.minimum) < 0;
  renderUpdateBar();
}
function renderUpdateBar() {
  const bar = $("#update-bar"), i = updateInfo, cur = appVer();
  if (!bar) return;
  const newer = !!i && !!cur && verCmp(cur, i.latest) < 0;
  const show = updateRequired || (newer && store.get("updateDismissed") !== i.latest);
  bar.classList.toggle("hidden", !show);
  bar.classList.toggle("required", updateRequired);
  if (!show) return;
  const note = (i.notes && (lang === "en" ? i.notes.en : i.notes.id)) || "";
  $("#update-title").textContent = updateRequired ? "Pembaruan keamanan wajib" : `TryDesk ${i.latest} tersedia`;
  $("#update-text").textContent = updateRequired
    ? `Versi ${cur} punya celah keamanan yang sudah diperbaiki. Perbarui ke ${i.latest} untuk bisa terhubung lagi.`
    : note || `Anda memakai versi ${cur}.`;
  $("#update-dismiss").classList.toggle("hidden", updateRequired);
}
const UPDATE_REFUSED = "Perbarui TryDesk dulu: versi ini punya celah keamanan yang sudah diperbaiki";
$("#update-download").addEventListener("click", () => window.electronAPI.openExternal((updateInfo && updateInfo.url) || "https://trydesk.ai.id/downloads/"));
$("#update-dismiss").addEventListener("click", () => { if (updateInfo) store.set("updateDismissed", updateInfo.latest); renderUpdateBar(); });

// ─── Init ─────────────────────────────────────────────────
(async () => {
  config = await window.electronAPI.getConfig();
  serverUrl = config.signalingServer;
  if (viewerOnlyDesktop()) {
    // Say what this build does instead of offering an ID nobody can connect to; hide Windows-only settings.
    const note = $(".id-note"); if (note) { note.removeAttribute("data-i18n"); note.textContent = tr("TryDesk untuk Linux saat ini hanya bisa mengontrol PC lain. PC ini belum bisa dikontrol dari jarak jauh."); }
    $("#setting-startup")?.closest(".setting-group")?.style.setProperty("display", "none");
  }
  // Only a PC that can be controlled listens for LAN requests; the Linux and phone builds still connect BY IP.
  if (viewerOnlyDesktop() || window.TD_MOBILE) $("#setting-lan")?.closest(".setting-group")?.style.setProperty("display", "none");
  try { const saved = JSON.parse(store.get("quality")); if (saved) defaultQuality = { ...DEFAULT_QUALITY, ...saved }; } catch {}
  clipboardSync = store.get("clipboardSync") !== "0";
  $("#clipboard-toggle").checked = clipboardSync;
  applyAccessSettings();
  initPrefs();
  checkUpdate(); setInterval(checkUpdate, 6 * 3600 * 1000);   // at start, then every 6 hours
  syncDefaultQualityUI();
  // A pre-1.0 unsalted hash can't do the challenge, so it silently meant "always ask Accept" — drop it and say so.
  const pwHash = store.get("accessPasswordHash");
  if (pwHash && !pwHash.includes(":")) { store.set("accessPasswordHash", null); setTimeout(() => showToast("Password akses dari versi lama perlu diset ulang (Pengaturan → Keamanan)"), 1500); }
  updateAccessPwUI();
  store.set("pwKeys", null);   // left by 1.1.0 test builds' "remember password" (feature removed)
  // Restore device alias
  const savedAlias = store.get("deviceAlias");
  if (savedAlias) $("#device-alias").value = savedAlias;
  // Restore theme (only dark/light supported now; normalize older values)
  const savedTheme = store.get("theme") === "light" ? "light" : "dark";
  applyTheme(savedTheme);
  $("#setting-theme").value = savedTheme;
  if (store.get("theme") && store.get("theme") !== savedTheme) store.set("theme", savedTheme);
  // Restore language
  // Until the user picks a language, follow Windows: Indonesian systems get ID, every other system EN.
  const savedLang = store.get("lang") || (/^id\b/i.test(navigator.language || "") ? "id" : "en");
  $("#setting-language").value = savedLang;
  applyLanguage(savedLang);
  // Restore auto-reconnect
  autoReconnect = store.get("autoReconnect") === "1";
  $("#setting-auto-reconnect").checked = autoReconnect;
  recentView = store.get("recentView") === "list" ? "list" : "grid";
  syncQualityUI();
  renderFavorites();
  renderRecent();
  applyRecentView();
  setupInputCapture();
  fmInit();
  renderTabs();
  connectSignaling();
})();
