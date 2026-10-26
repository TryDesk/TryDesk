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
    this.audioOn = false;
    this.quality = { ...defaultQuality };
    this.scaleMode = "fit";
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
    // periodic flicker users saw even on a fast link. Genuine host-side resolution/monitor
    // changes (which really do drop corrupt frames) are masked explicitly via the "res-change"
    // control signal and the local monitor-switch handler instead.
  });
  v.addEventListener("playing", () => { sess.hasFrame = true; if (sess === active) $("#remote-loading")?.classList.add("hidden"); });
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
    ph_remote_id: "Enter remote ID", ph_password: "Password (optional)",
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
  applySettingsLang();
}

// Full settings-panel translation via a text map (covers every label/toggle/note/option
// without tagging each element). Leaf text only; mixed-content buttons are tagged in HTML.
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
  "Jendela admin & dialog UAC hanya bisa dikontrol dari jarak jauh bila TryDesk dijalankan sebagai administrator. Tanpa ini layar tetap terlihat, tapi klik & ketik tidak berfungsi di jendela admin.": "Admin windows & UAC dialogs can only be controlled remotely when TryDesk runs as administrator. Without it the screen still shows, but clicks & keystrokes won't work on admin windows.",
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
};
const TEXT_PH_EN = {
  "Mis: PC Kantor, Laptop Rumah": "e.g. Office PC, Home Laptop",
  "Kosong = selalu minta Accept": "Empty = always ask to Accept",
  "Mis: 192.168.1.0/24, 10.0.0.5": "e.g. 192.168.1.0/24, 10.0.0.5",
};
function applySettingsLang() {
  const panel = $("#overlay-settings");
  if (!panel) return;
  panel.querySelectorAll("label, .setting-row-toggle > span, .setting-note, option, .btn-apply, .about-row > span, .about-row > b, [data-i18n-text]").forEach((el) => {
    if (el.children.length) return; // leaf text only
    if (el._sid === undefined) el._sid = el.textContent;
    const key = el._sid.trim();
    el.textContent = (lang === "en" && TEXT_EN[key]) ? TEXT_EN[key] : el._sid;
  });
  panel.querySelectorAll("input[placeholder]").forEach((el) => {
    if (el._sph === undefined) el._sph = el.placeholder;
    el.placeholder = (lang === "en" && TEXT_PH_EN[el._sph]) ? TEXT_PH_EN[el._sph] : el._sph;
  });
}

// ─── UI helpers ───────────────────────────────────────────
function showScreen(name) {
  for (const s of ["home", "connecting", "remote", "hosting"]) {
    $(`#screen-${s}`).classList.toggle("hidden", s !== name);
  }
  // Show titlebar for home/connecting, hide for remote (grip bar replaces it)
  $("#titlebar").style.display = (name === "remote") ? "none" : "";
  refreshKeyCapture();
}

// Full keyboard capture (native hook — forwards Alt+Tab, Win, Alt+Esc etc. to the remote even outside
// fullscreen) is ON only while we're actively controlling a remote PC: off on Home/Hosting, in view-only,
// and while typing in a local field so the user can still use TryDesk's own inputs.
function refreshKeyCapture() {
  const remote = !$("#screen-remote").classList.contains("hidden");
  const a = document.activeElement;
  const typing = a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
  const on = !!(remote && active && active.role === "viewer" && !active.viewOnly && !typing);
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

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const _hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function _pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, key, 256);
}
// Access password is stored as a salted, slow PBKDF2 hash ("saltHex:hashHex") so a leaked store
// can't be brute-forced quickly. Legacy unsalted SHA-256 hashes (no colon) still verify, for migration.
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${_hex(salt.buffer)}:${_hex(await _pbkdf2(pw, salt))}`;
}
async function verifyPassword(pw, stored) {
  if (!stored || !pw) return false;
  if (!stored.includes(":")) return (await sha256(pw)) === stored;
  const [saltHex, hashHex] = stored.split(":");
  const salt = _hexToBytes(saltHex);
  const hex = _hex(await _pbkdf2(pw, salt));
  return _constEq(hex, hashHex);
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
  renderRecent();
}
function clearRecent() { store.set("recent", JSON.stringify([])); renderRecent(); }

function makeTile(id, sub, opts = {}) {
  const el = document.createElement("div");
  el.className = "recent-tile";
  el.title = `${t("ui_connect")} ${id}`;
  const preview = document.createElement("div"); preview.className = "tile-preview"; preview.innerHTML = MONITOR_SVG;
  const idEl = document.createElement("div"); idEl.className = "tile-id"; idEl.textContent = id;
  const subEl = document.createElement("div"); subEl.className = "tile-sub"; subEl.textContent = sub;
  el.append(preview, idEl, subEl, makeStarBtn(id, true));
  if (!opts.fav) {
    const del = document.createElement("button");
    del.className = "tile-del"; del.title = t("delete_tip");
    del.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    del.addEventListener("click", (e) => { e.stopPropagation(); removeRecent(id); });
    el.appendChild(del);
  }
  el.addEventListener("click", () => { remoteIdInput.value = id; initiateConnection(); });
  return el;
}
function renderRecent() {
  let recent = getRecent();
  $("#recent-section").style.display = recent.length ? "" : "none";
  recent = [...recent].sort((a, b) => recentSort === "id" ? a.id.localeCompare(b.id) : b.time - a.time);
  const list = $("#recent-list");
  list.replaceChildren();
  for (const r of recent) list.appendChild(makeTile(r.id, formatTime(r.time), { fav: false }));
}

function getFavorites() { try { return JSON.parse(store.get("favorites") || "[]"); } catch { return []; } }
function isFavorite(id) { return getFavorites().some((f) => f.id === id); }
function toggleFavorite(id) {
  let favs = getFavorites();
  const was = favs.some((f) => f.id === id);
  favs = was ? favs.filter((f) => f.id !== id) : [{ id, time: Date.now() }, ...favs].slice(0, 20);
  store.set("favorites", JSON.stringify(favs));
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
  const favs = getFavorites();
  $("#favorites-section").style.display = favs.length ? "" : "none";
  const list = $("#favorites-list");
  list.replaceChildren();
  for (const f of favs) list.appendChild(makeTile(f.id, formatTime(f.time), { fav: true }));
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
function startHostingTimer() {
  hostingStartTime = Date.now();
  stopHostingTimer();
  hostingTimerHandle = setInterval(() => {
    const elapsed = Math.floor((Date.now() - hostingStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    const el = $("#hosting-timer");
    if (el) el.textContent = `${m}:${s}`;
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

  ws.onopen = () => ws.send(JSON.stringify({ type: "register", id: store.get("myId"), token: store.get("myToken") }));
  ws.onmessage = (event) => { let msg; try { msg = JSON.parse(event.data); } catch { return; } onSignal(msg); };
  ws.onclose = () => {
    myId = null; myIdText.textContent = "Offline";
    setStatus("error", "Terputus dari server — mencoba lagi...");
    reconnectTimer = setTimeout(connectSignaling, 3000);
  };
}
function sendSignal(data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }

async function onSignal(msg) {
  switch (msg.type) {
    case "registered":
      myId = msg.clientId;
      store.set("myId", msg.clientId); store.set("myToken", msg.token);
      serverIceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
      myIdText.textContent = fmtId(myId);
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
      // Host requires an access password. Prove we know it via HMAC over the host's nonce —
      // the password itself never travels. Garbage/empty response simply gets rejected by the host.
      const s = sessions.get(msg.fromId);
      if (!s || s.role !== "viewer") return;
      try {
        const response = await answerChallenge(s.pendingPassword || "", msg.salt || "", msg.nonce || "");
        sendSignal({ type: "connection-response", targetId: msg.fromId, response });
      } catch { sendSignal({ type: "connection-response", targetId: msg.fromId, response: "" }); }
      s.pendingPassword = "";   // one-shot; don't keep the secret around
      break;
    }
    case "connection-response": { await handleChallengeResponse(msg); break; }
    case "connection-accepted": {
      const s = sessions.get(msg.fromId);
      if (s && s.role === "viewer" && !s.pc) { if (s === active) setConnectStep(3); startViewer(s); }
      break;
    }
    case "connection-rejected": {
      const s = sessions.get(msg.fromId);
      if (!s) return;
      closeSession(s, false); showToast(msg.reason || "Koneksi ditolak");
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
      // The server also reports this when only the SIGNALING link blipped (or the server restarted) while the
      // P2P session is perfectly healthy. A real hang-up closes the data channel within moments, so with a live
      // link wait briefly and only tear down if it really went away.
      const linkUp = () => s.pc && s.pc.connectionState === "connected" && s.dataChannel && s.dataChannel.readyState === "open";
      const stillOurs = () => (s.role === "host" ? host === s : sessions.get(s.peerId) === s);
      const hangUp = () => { closeSession(s, false); showToast("Remote desktop memutus koneksi"); };
      if (linkUp()) setTimeout(() => { if (stillOurs() && !linkUp()) hangUp(); }, 3000);
      else hangUp();
      break;
    }
    case "error": {
      // Errors (target offline/busy) belong to a tab that is still connecting. Newer servers name it in
      // targetId; otherwise fall back to the active tab.
      const s = msg.targetId ? sessions.get(msg.targetId) : active;
      if (s && s.role === "viewer" && s.pc == null) closeSession(s, false);
      showToast(msg.message);
      break;
    }
  }
}

// Resolve a signaling peerId to its session (viewer tab or the single host session).
function sessionFor(peerId) {
  return sessions.get(peerId) || (host && host.peerId === peerId ? host : null);
}

// ─── Viewer side ──────────────────────────────────────────
function initiateConnection() {
  const targetId = remoteIdInput.value.trim();
  if (!myId) return showToast("Belum terhubung ke server");
  if (!/^\d{3} \d{3} \d{3}$/.test(targetId)) return showToast("Masukkan ID 9 digit");
  if (targetId === myId) return showToast("Tidak bisa konek ke diri sendiri");
  if (sessions.has(targetId)) { switchTab(sessions.get(targetId)); return showToast("Tab untuk ID ini sudah terbuka"); }
  // Open a new viewer tab. Any existing tabs keep running in the background.
  const sess = new Session(targetId, "viewer");
  sessions.set(targetId, sess);
  // Hold the typed password locally for the challenge/response — it is NEVER sent to the server.
  sess.pendingPassword = remotePasswordInput.value || "";
  active = sess;
  renderTabs();
  showScreen("connecting");
  setConnectStep(1);
  $("#connecting-title").textContent = "Menghubungkan";
  $("#connecting-text").textContent = `Meminta akses ke ${targetId}...`;
  sendSignal({ type: "connect-request", targetId, fromName: store.get("deviceAlias") || "TryDesk User" });
  setTimeout(() => { if (sessions.get(targetId) === sess && !sess.pc && sess === active) setConnectStep(2); }, 500);
  // Never leave a tab on "connecting" forever (no answer, or an error the server sent without naming the tab).
  // The host's accept dialog / password challenge time out at 30s, so 45s means nobody is answering.
  sess.requestTimer = setTimeout(() => {
    if (sessions.get(targetId) === sess && !sess.pc) { closeSession(sess, true); showToast("Tidak ada respons dari remote desktop"); }
  }, 45000);
}

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
  sess.dataChannel.onopen = () => { sendQuality(sess); startClipboardSync(sess); };
  sess.fileChannel = pc.createDataChannel("file", { ordered: true });
  sess.fileChannel.binaryType = "arraybuffer";
  setupFileChannel(sess, sess.fileChannel);

  const video = ensureVideo(sess);
  pc.ontrack = (event) => {
    if (event.streams[0]) video.srcObject = event.streams[0];
    else { const s = video.srcObject || new MediaStream(); s.addTrack(event.track); video.srcObject = s; }
    video.muted = !sess.audioOn;
    // Start the receive buffer minimal; pollStats() then adapts it to the MEASURED network jitter —
    // near-zero on a clean LAN (feels instant, good for gaming) and larger only when the link is
    // actually jittery (stays smooth for distant users). A fixed 120ms buffer added real lag on LAN.
    if (event.track && event.track.kind === "video" && event.receiver) {
      sess.videoReceiver = event.receiver;
      try { event.receiver.playoutDelayHint = 0.05; } catch {}
      try { if ("jitterBufferTarget" in event.receiver) event.receiver.jitterBufferTarget = 50; } catch {}
    }
    if (sess === active) {
      showScreen("remote");
      renderTabs();
      $("#remote-peer-id").textContent = `Terhubung ke ${fmtId(sess.peerId)}`;
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
  if (!tr || sess.quality.codec === "auto" || !tr.setCodecPreferences) return;
  try {
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (!caps) return;
    const want = `video/${sess.quality.codec}`.toLowerCase();
    const pref = caps.codecs.filter((c) => c.mimeType.toLowerCase() === want);
    const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== want);
    if (pref.length) tr.setCodecPreferences([...pref, ...rest]);
  } catch (e) { console.warn("codec pref failed", e); }
}

// ─── Host side ────────────────────────────────────────────
// One outstanding access-password challenge at a time, plus a simple brute-force cool-down.
let pendingChallenge = null;      // { fromId, fromName, nonce, expires, _t }
let pwFailures = { count: 0, until: 0 };

async function handleIncoming(msg) {
  // An accept dialog or password challenge is already in flight for another requester — reject this
  // one instead of stacking (which would corrupt state and double-start a session).
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
  if (pwFailures.until > Date.now()) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Terlalu banyak percobaan, coba lagi nanti" }); return; }

  const savedHash = store.get("accessPasswordHash");
  if (savedHash && savedHash.includes(":")) {
    // Password set → server-blind challenge. Relay only the salt + a one-shot nonce; we accept only
    // once the viewer returns a valid HMAC (proving it knows the password) — the password never travels.
    const nonce = _hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const salt = savedHash.split(":")[0];
    pendingChallenge = { fromId: msg.fromId, fromName: msg.fromName, nonce, expires: Date.now() + 30000 };
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
  if (!accepted) { sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Koneksi ditolak" }); return; }
  await finishAccept(msg.fromId);
}

// Verify the viewer's HMAC answer to our challenge; accept or reject (with brute-force counting).
async function handleChallengeResponse(msg) {
  const pc = pendingChallenge;
  if (!pc || pc.fromId !== msg.fromId) return;   // no challenge outstanding for this peer
  clearTimeout(pc._t); pendingChallenge = null;
  const expected = await expectedChallenge(store.get("accessPasswordHash"), pc.nonce);
  if (expected && typeof msg.response === "string" && _constEq(msg.response, expected)) {
    pwFailures = { count: 0, until: 0 };
    await finishAccept(pc.fromId);
  } else {
    pwFailures.count++;
    if (pwFailures.count >= 3) { pwFailures.until = Date.now() + 5 * 60 * 1000; pwFailures.count = 0; }
    sendSignal({ type: "connection-rejected", targetId: pc.fromId, reason: "Password salah" });
  }
}

// Build the host session + capture + peer once a requester is authorized (manual accept or challenge).
async function finishAccept(fromId) {
  const sess = new Session(fromId, "host");
  host = sess;
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
    if (!_adminTipShown) { _adminTipShown = true; try { window.electronAPI.isElevated().then((el) => { if (!el) showToast("Tip: agar jendela admin/UAC bisa dikontrol, jalankan TryDesk sebagai administrator (Pengaturan → Keamanan)"); }).catch(() => {}); } catch {} }
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
    } else {
      sess.dataChannel = ch;
      sess.dataChannel.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } onCtrlMessage(sess, ev); };
      const onCtrlOpen = () => { startClipboardSync(sess); sendMonitors(sess); try { window.electronAPI.requestCursorState && window.electronAPI.requestCursorState(); } catch {} };
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
  // controlled" — capturing the screen and turning everyone else away as busy.
  setTimeout(() => { if (host === sess && sess.pc && sess.pc.connectionState !== "connected") closeSession(sess, false); }, 30000);
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
  else if (ev.__ctrl === "res-change") { /* decoder handles the size change itself; dimming here caused visible flicker */ }
  else if (ev.__ctrl === "game-auto") { if (sess.role === "viewer") setAutoGame(sess, !!ev.on); }
  else if (ev.__ctrl === "chat") { onChatReceived(sess, ev.text); }
  else if (ev.__ctrl === "black-screen") { if (sess.role === "host") handleBlackScreen(sess, ev.enabled); }
  else if (ev.__ctrl === "lock-input") { if (sess.role === "host") handleLockInput(sess, ev.enabled); }
  else if (ev.__ctrl === "privacy-result") { if (sess.role === "viewer") onPrivacyResult(sess, ev); }
  else if (ev.__ctrl === "fs-req") { handleFsRequest(sess, ev); }
  else if (ev.__ctrl === "fs-res") { handleFsResponse(sess, ev); }
  // Anything else is a remote input event — only execute it when WE are the host AND control is
  // permitted. A modified viewer cannot force input past this host-side gate.
  else if (sess.role === "host" && allowInput && !forceViewOnly) window.electronAPI.executeInput(ev);
}

// ─── Remote filesystem browsing (serves the peer's file manager) ───
// Only the HOST (the machine being controlled) serves its filesystem, and only when file transfer
// is permitted — a machine must never expose its own files to a host it connected OUT to.
async function handleFsRequest(sess, ev) {
  if (sess.role !== "host") return;
  if (!sess.dataChannel || sess.dataChannel.readyState !== "open") return;
  if (!allowFileTransfer) { try { sess.dataChannel.send(JSON.stringify({ __ctrl: "fs-res", reqId: ev.reqId, res: { ok: false, error: "Transfer file dinonaktifkan di host", path: ev.path, display: ev.path || "" } })); } catch {} return; }
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
  // Genuine capture swap (monitor switch / host display change) → tell the viewer to dim briefly so
  // it masks the decoder's corrupt frames during the real resolution change (not adaptive resizes).
  if (sess.dataChannel && sess.dataChannel.readyState === "open") {
    try { sess.dataChannel.send(JSON.stringify({ __ctrl: "res-change" })); } catch {}
  }
}

async function switchMonitor(sess, index) {
  if (!sess.monitors[index] || !sess.pc) return;
  try { await replaceCaptureTrack(sess, index, true, "switch"); applyQualityToSender(sess, hostQuality); }
  catch (e) { console.error("switchMonitor gagal", e); }
  // Report the monitor actually being streamed, so the viewer's picker never claims a switch that failed.
  sendMonitors(sess);
}

async function applyQualityToSender(sess, q) {
  hostQuality = { bitrate: q.bitrate ?? hostQuality.bitrate, fps: q.fps ?? hostQuality.fps, resHeight: q.resHeight ?? hostQuality.resHeight };
  const sender = sess.pc && sess.pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  // If a higher frame rate than the current capture cap is requested, re-capture — the
  // mandatory maxFrameRate set at getUserMedia time is a hard ceiling that applyConstraints can't raise.
  if (q.fps != null && q.fps > hostCaptureFps) {
    try { await replaceCaptureTrack(sess, null, false, `fps ${q.fps}`); } catch (e) { console.warn("recapture for fps failed", e); }
  }
  const setEncoder = () => {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    // Good network → keep the remote screen SHARP at native resolution (drop FPS, not resolution). Unstable
    // network (high loss/RTT, the viewer signals it via the "net-mode" control) → switch to "balanced" so
    // WebRTC can shed RESOLUTION and keep the picture MOVING instead of freezing at full res @ ~6fps — far
    // friendlier on bad/relay links. (maintain-framerate downscaled to 640x360 on connect, so we avoid it.)
    params.degradationPreference = sess._netDegraded ? "balanced" : "maintain-resolution";
    const enc = params.encodings[0];
    if (q.bitrate != null) enc.maxBitrate = Math.round(q.bitrate * 1_000_000);
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
  const pc = new RTCPeerConnection({ iceServers: [...config.iceServers, ...serverIceServers] });
  sess.pc = pc;
  sess.pendingCandidates = [];
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: "ice-candidate", targetId: sess.peerId, candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (sess.pc !== pc) return;   // a newer pc replaced this one — ignore stale events
    if (pc.connectionState === "connected") { sess.reconnectAttempts = 0; if (sess.role === "viewer") reconnectAttempts = 0; updateDiscordPresence(); }
    else if (pc.connectionState === "failed") {
      const target = sess.role === "viewer" ? sess.peerId : null;
      const wasActive = sess === active || sess.role === "host";
      closeSession(sess, false);
      if (target && autoReconnect) tryReconnect(target);
      else if (wasActive) showToast(serverIceServers.length ? "Koneksi gagal — relay TURN tidak terjangkau" : "Koneksi P2P gagal — server belum menyediakan TURN relay");
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
          if (target && autoReconnect) tryReconnect(target);
          else if (wasActive) showToast("Koneksi terputus");
        }
      }, 5000);
    }
  };
}

// Session auto-reconnect (viewer side): retry the same peer on unexpected drop
let reconnectAttempts = 0;
function tryReconnect(target) {
  if (reconnectAttempts >= 3) { reconnectAttempts = 0; showToast(t("reconnect_failed")); return; }
  reconnectAttempts++;
  showToast(t("reconnecting"));
  remoteIdInput.value = target;
  setTimeout(() => { if (remoteIdInput.value === target && !sessions.has(target)) initiateConnection(); }, 2000);
}
function flushCandidates(sess) { for (const c of sess.pendingCandidates) sess.pc.addIceCandidate(c).catch(() => {}); sess.pendingCandidates = []; }

// Tear down ONE session (a viewer tab, or the single host session) and update the UI.
// Other tabs are left untouched.
function closeSession(sess, notify = true) {
  if (!sess) return;
  const isViewer = sess.role === "viewer";
  const wasActive = sess === active;
  if (isViewer && recordingActive && recordingSess === sess) stopRecording();   // flush & save THIS tab's recording
  // Tell the server to drop THIS specific pairing (targetId scopes it to the right peer so other
  // tabs survive). On an old single-session server, targetId is simply ignored.
  if (sess.peerId) sendSignal({ type: (isViewer && !sess.pc) ? "cancel-request" : "disconnect", targetId: sess.peerId });

  clearTimeout(sess.disconnectTimer); sess.disconnectTimer = null;
  clearTimeout(sess.requestTimer);
  stopStats(sess);
  stopClipboardSync(sess);
  cleanupTransfers(sess);
  for (const [, p] of sess.fsPending) { clearTimeout(p.timer); try { p.reject(new Error("closed")); } catch {} }
  sess.fsPending.clear();
  if (sess.dataChannel) { try { sess.dataChannel.close(); } catch {} sess.dataChannel = null; }
  if (sess.fileChannel) { try { sess.fileChannel.close(); } catch {} sess.fileChannel = null; }
  if (sess.pc) { sess.pc.onconnectionstatechange = null; sess.pc.close(); sess.pc = null; }
  if (sess.localStream) { sess.localStream.getTracks().forEach((t) => t.stop()); sess.localStream = null; }
  stopSessionTimer(sess);
  if (sess.video) { try { sess.video.srcObject = null; } catch {} sess.video.remove(); sess.video = null; }
  sess.pendingCandidates = [];
  updateDiscordPresence();   // session ended → refresh (likely back to "idle")

  if (sess.role === "host") {
    // Only the CURRENT host session owns the shared host state (privacy overlays, held input, UI) — a late
    // teardown of an older, already-replaced one must not undo the live session's.
    if (host !== sess) return;
    // Host teardown — release privacy features defensively and reset host UI.
    try { window.electronAPI.releaseRemoteInput(); } catch {}
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
  scaleMode = sess.scaleMode;
  showScreen("remote");
  renderTabs();
  showActiveVideo();
  $("#remote-peer-id").textContent = sess.pc ? `Terhubung ke ${fmtId(sess.peerId)}` : `Menghubungkan ${fmtId(sess.peerId)}…`;
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
function showActiveVideo() {
  for (const s of viewerSessions()) if (s.video) s.video.classList.toggle("active", s === active);
}

// ─── Accept request (AnyDesk-style with countdown) ────────
const ACCEPT_TIMEOUT = 30; // seconds

function askAccept(fromId, fromName) {
  return new Promise((resolve) => {
    try { window.electronAPI.focusWindow(); } catch {}
    $("#accept-id").textContent = fromId;
    const aliasEl = $("#accept-alias");
    aliasEl.textContent = fromName && fromName !== "TryDesk User" ? fromName : "";
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
      if (remaining <= 0) done(false);
    }, 1000);

    const acc = $("#btn-accept"), rej = $("#btn-reject");
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      acceptPending = false;
      acceptFromId = null;
      acceptDlgCancel = null;
      if (acceptTimerHandle) { clearInterval(acceptTimerHandle); acceptTimerHandle = null; }
      ov.classList.add("hidden");
      acc.removeEventListener("click", onAcc);
      rej.removeEventListener("click", onRej);
      resolve(val);
    };
    acceptDlgCancel = () => done(false);
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

// Tab label follows the active monitor's name when known (AnyDesk-style), else the peer ID.
function updateSessionLabel(sess) {
  const m = sess.monitors[sess.currentMonitor];
  sess.label = (m && m.label) ? `Monitor ${sess.currentMonitor + 1} (${m.label})` : sess.peerId;
}

function toggleAudio() {
  const sess = active; if (!sess || !sess.audioAvailable) return;
  sess.audioOn = !sess.audioOn;
  if (sess.video) { sess.video.muted = !sess.audioOn; if (sess.audioOn) sess.video.play().catch(() => {}); }
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
  if (!document.hasFocus()) {
    try {
      const n = new Notification("Pesan baru", { body: text.slice(0, 160), silent: false });
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

// Viewer: the host refused or couldn't apply black screen / input lock — undo the optimistic toggle and say why.
function onPrivacyResult(sess, ev) {
  if (ev.ok) return;
  if (ev.feature === "lock-input") { sess.inputLocked = false; if (sess === active) $("#btn-lock-input").classList.remove("active"); }
  else if (ev.feature === "black-screen") { sess.blackScreenActive = false; if (sess === active) $("#btn-blackscreen").classList.remove("active"); }
  else return;
  const what = ev.feature === "lock-input" ? "Kunci input" : "Layar gelap";
  showToast(ev.reason === "admin"
    ? `${what} gagal: TryDesk di PC remote harus dijalankan sebagai administrator`
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
let mediaRecorder = null, recordChunks = [], recordingActive = false, recordingSess = null;   // the tab being recorded
function isRecording() { return recordingActive; }
function toggleRecording() { recordingActive ? stopRecording() : startRecording(); }

function startRecording() {
  const video = activeVideo();
  const stream = video && video.srcObject;
  if (!stream) return showToast("Belum ada video untuk direkam");
  let mime = "";
  for (const t of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
  }
  try { mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined); }
  catch { return showToast("Perekaman tidak didukung"); }
  recordChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordChunks.push(e.data); };
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

async function saveRecording() {
  const chunks = recordChunks; recordChunks = []; mediaRecorder = null;
  const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || "video/webm" });
  if (!blob.size) return;
  const name = `TryDesk-rekaman-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.webm`;
  const savePath = await window.electronAPI.fileSaveDialog(name);
  if (!savePath) return showToast("Rekaman dibatalkan");
  const id = await window.electronAPI.fileOpenWrite(savePath);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const CH = 1 << 20;
  for (let o = 0; o < buf.length; o += CH) await window.electronAPI.fileWriteChunk(id, buf.subarray(o, Math.min(o + CH, buf.length)));
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
function startClipboardSync(sess) {
  stopClipboardSync(sess);
  if (!clipboardSync) return;
  sess.lastClipboard = null;
  sess.clipTimer = setInterval(async () => {
    if (!clipboardSync || !sess.dataChannel || sess.dataChannel.readyState !== "open") return;
    // The host's "allow clipboard" permission covers BOTH directions — never hand this PC's clipboard
    // (passwords, tokens…) to a viewer when the host switched clipboard sharing off.
    if (sess.role === "host" && !allowClipboardPref) return;
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
  if (!clipboardSync || !allowClipboardPref) return;
  if (typeof text !== "string" || text.length > 2_000_000) return;   // reject non-string / oversized peer payloads
  sess.lastClipboard = text;
  try { await window.electronAPI.clipboardWrite(text); } catch {}
}
// Start/stop clipboard polling across every live session (used by the global toggle).
function restartClipboardAll() {
  for (const s of [...viewerSessions(), host].filter(Boolean)) {
    if (clipboardSync) startClipboardSync(s); else stopClipboardSync(s);
  }
}

// ─── File transfer ────────────────────────────────────────
function setupFileChannel(sess, ch) {
  ch.onmessage = (m) => {
    if (typeof m.data === "string") { let ev; try { ev = JSON.parse(m.data); } catch { return; } onFileControl(sess, ev); }
    else onFileChunk(sess, m.data);
  };
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
      card.setSub(accepted ? "Dibatalkan" : "Ditolak"); card.finish(false);
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
    if (fileBusy(sess)) { ch.send(JSON.stringify({ t: "reject", id: ev.id })); return; }
    const card = createCard(sess, ev.id, { dir: "recv", name: ev.name, size: ev.size, incoming: true });
    card.onAccept = async () => {
      const savePath = await chooseSavePath(ev.name);
      if (!card.el.isConnected) return;   // the sender withdrew the offer while the save dialog was open
      if (!savePath) { ch.send(JSON.stringify({ t: "reject", id: ev.id })); card.remove(); return; }
      const writeId = await window.electronAPI.fileOpenWrite(savePath);
      sess.activeRecv = { id: ev.id, size: ev.size, received: 0, writeId, filePath: savePath, canceled: false, card };
      card.toProgress();
      ch.send(JSON.stringify({ t: "accept", id: ev.id }));
    };
    card.onReject = () => { ch.send(JSON.stringify({ t: "reject", id: ev.id })); card.remove(); };
  } else if (ev.t === "accept") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.acceptResolver) sess.acceptResolver(true);
  } else if (ev.t === "reject") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.acceptResolver) sess.acceptResolver(false);
  } else if (ev.t === "done") {
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      await window.electronAPI.fileCloseWrite(sess.activeRecv.writeId, false);
      sess.activeRecv.card.setSub(`Tersimpan: ${sess.activeRecv.filePath}`); sess.activeRecv.card.finish(true);
      sess.activeRecv = null;
    }
  } else if (ev.t === "cancel") {
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      await window.electronAPI.fileCloseWrite(sess.activeRecv.writeId, true, sess.activeRecv.filePath);
      sess.activeRecv.card.setSub("Dibatalkan pengirim"); sess.activeRecv.card.finish(false);
      sess.activeRecv = null;
    } else if (sess.activeSend && sess.activeSend.id === ev.id) { sess.activeSend.canceled = true; }
    else if (typeof ev.id === "string") {   // the sender withdrew an offer we hadn't answered yet
      $(`#transfer-stack .transfer-card[data-sid="${sess.sid}"][data-id="${CSS.escape(ev.id)}"]`)?.remove();
    }
  }
  // ── File manager protocol (dual-pane queue; no save dialogs) ──
  else if (ev.t === "m-put") {
    // Peer wants to upload ev.name into our ev.destDir. Only the host serves the file manager,
    // and only when file transfer is permitted — never expose a machine we connected OUT to.
    if (sess.role !== "host" || !allowFileTransfer) { ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: "ditolak" })); return; }
    if (fileBusy(sess)) { ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: "busy" })); return; }
    try {
      const { id: writeId, path: filePath } = await window.electronAPI.fileOpenWriteIn(ev.destDir, ev.name);
      sess.activeRecv = { id: ev.id, size: ev.size, received: 0, writeId, filePath, mgr: true };
      ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: true }));
    } catch (e) {
      ch.send(JSON.stringify({ t: "m-putok", id: ev.id, ok: false, err: String(e && e.message || e) }));
    }
  } else if (ev.t === "m-putok") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.activeSend.onAck) sess.activeSend.onAck(ev);
  } else if (ev.t === "m-done") {
    // We are the receiver; sender finished streaming.
    if (sess.activeRecv && sess.activeRecv.id === ev.id) {
      await window.electronAPI.fileCloseWrite(sess.activeRecv.writeId, false);
      const rec = sess.activeRecv; const filePath = rec.filePath; sess.activeRecv = null;
      if (rec.onDone) rec.onDone(filePath);               // download (we received): let the queue finish the item
      else ch.send(JSON.stringify({ t: "m-complete", id: ev.id, ok: true, path: filePath }));
    }
  } else if (ev.t === "m-complete") {
    if (sess.activeSend && sess.activeSend.id === ev.id && sess.activeSend.onDone) sess.activeSend.onDone(ev);
  } else if (ev.t === "m-get") {
    // Peer wants to download ev.remotePath from us. Host-only + permission-gated (see m-put).
    if (sess.role !== "host" || !allowFileTransfer) { ch.send(JSON.stringify({ t: "m-got", id: ev.id, ok: false, err: "ditolak" })); return; }
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
      await window.electronAPI.fileCloseWrite(sess.activeRecv.writeId, true, sess.activeRecv.filePath);
      sess.activeRecv = null;
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

async function onFileChunk(sess, buf) {
  const rec = sess.activeRecv;
  if (!rec) return;
  // Enforce the advertised size: never write more bytes than declared (disk-fill DoS guard).
  if (rec.size != null && rec.received >= rec.size) return;
  let u8 = new Uint8Array(buf);
  if (rec.size != null && rec.received + u8.byteLength > rec.size) u8 = u8.subarray(0, Math.max(0, rec.size - rec.received));
  if (!u8.byteLength) return;
  await window.electronAPI.fileWriteChunk(rec.writeId, u8);
  rec.received += u8.byteLength;
  if (rec.card) rec.card.progress(rec.received, rec.size);
}

function cleanupTransfers(sess) {
  if (sess.activeSend) sess.activeSend.canceled = true;
  if (sess.activeRecv) { window.electronAPI.fileCloseWrite(sess.activeRecv.writeId, true, sess.activeRecv.filePath); sess.activeRecv = null; }
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
    if (dir === "recv" && sess.activeRecv && sess.activeRecv.id === id) { sess.fileChannel.send(JSON.stringify({ t: "cancel", id })); window.electronAPI.fileCloseWrite(sess.activeRecv.writeId, true, sess.activeRecv.filePath); sess.activeRecv = null; }
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
      await fmWait(item, (r) => doneP.then(r));
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
      const gotP = fmWait(item, (r) => { sess.mgrGetAck = { id: item.id, resolve: r }; });
      sess.fileChannel.send(JSON.stringify({ t: "m-get", id: item.id, remotePath: item.srcPath, name: item.name, size: item.size }));
      const got = await gotP; sess.mgrGetAck = null;
      if (!got.ok) throw new Error(got.err === "busy" ? "Sibuk" : (got.err || "gagal"));
      const { id: writeId, path: filePath } = await window.electronAPI.fileOpenWriteIn(item.destDir, item.name);
      const doneP = fmWait(item, (r) => { item._dlDone = r; });
      sess.activeRecv = {
        id: item.id, size: item.size, received: 0, writeId, filePath, mgr: true,
        onDone: () => item._dlDone && item._dlDone(),
        card: { progress: (done) => fmProgress(item, done), setSub() {}, finish() {}, remove() {} },
      };
      sess.fileChannel.send(JSON.stringify({ t: "m-ready", id: item.id }));
      await doneP;
      if (fmSess === sess) fmRefreshSide("local");
      resolve();
    } catch (e) {
      if (sess.activeRecv && sess.activeRecv.id === item.id) { try { await window.electronAPI.fileCloseWrite(sess.activeRecv.writeId, true, sess.activeRecv.filePath); } catch {} sess.activeRecv = null; }
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
    // FRAME-AWARE floor (~2.5 frames), not a fixed ms value. The decoder underruns when it has fewer than a
    // couple of FRAMES queued — so the safe buffer is measured in frames, not milliseconds. At high FPS that
    // is only a few ms (≈10ms at 240fps → near-zero latency on a clean fast LAN); at low FPS it stays large
    // in time (≈83ms at 30fps) so bursty delivery never starves the decoder (underrun was the old flicker).
    const fpsNow = inbound && inbound.framesPerSecond ? inbound.framesPerSecond : 60;
    const frameMs = 1000 / Math.max(15, fpsNow);
    const floor = Math.max(16, Math.round(frameMs * 2.5));
    // On a bad/unstable link (flagged last tick) allow a much deeper buffer so bursty delivery stays smooth
    // (trades a little latency for no stutter — the right call on a jittery/relay link); clean links stay low.
    const jbCap = sess._netDegradedV ? 350 : 180;
    const target = Math.max(floor, Math.min(jbCap, Math.round(sess._jitterAvg * 2.5) + floor));
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
  const flushMove = () => { moveTimer = null; lastSentAt = performance.now(); if (lastMove) sendInput({ action: "mousemove", ...lastMove }); };
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
    const wait = 16 - (performance.now() - lastSentAt);
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
    sendInput({ action: "mousemove", ...p });
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
      showToast("Kontrol dilepas — mouse & keyboard kembali ke PC ini (buka game lagi untuk lanjut)");
    });
  }
  // Pause capture while a local text field is focused (so the user can type in TryDesk's own UI), resume after.
  document.addEventListener("focusin", refreshKeyCapture);
  document.addEventListener("focusout", () => setTimeout(refreshKeyCapture, 0));
}

// ─── Settings overlay ─────────────────────────────────────
function toggleSettings() { overlaySettings.classList.toggle("hidden"); }

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

// ─── Event listeners ──────────────────────────────────────
$("#btn-connect").addEventListener("click", initiateConnection);
$("#recent-sort").addEventListener("change", (e) => { recentSort = e.target.value; renderRecent(); });
$("#recent-clear").addEventListener("click", clearRecent);
$("#view-grid").addEventListener("click", () => { recentView = "grid"; store.set("recentView", "grid"); applyRecentView(); });
$("#view-list").addEventListener("click", () => { recentView = "list"; store.set("recentView", "list"); applyRecentView(); });
$("#btn-cancel-connect").addEventListener("click", () => { if (active) closeSession(active, false); });
$("#btn-disconnect").addEventListener("click", () => { if (active) closeSession(active, true); });
$("#btn-stop-hosting").addEventListener("click", () => { if (host) closeSession(host, true); });

// Grip bar buttons (mini titlebar during remote)
$("#grip-minimize").addEventListener("click", () => window.electronAPI.minimizeWindow());
$("#grip-maximize").addEventListener("click", () => window.electronAPI.maximizeWindow());
$("#grip-close").addEventListener("click", () => { if (active) closeSession(active, true); });

$("#btn-fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#screen-remote").requestFullscreen();
});

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
  // End any live sessions first — they belong to the OLD id.
  try { for (const s of [...sessions.values()]) closeSession(s, true); } catch {}
  try { if (host) closeSession(host, true); } catch {}
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
    const el = await window.electronAPI.isElevated();
    const g = $("#admin-group"); if (g) g.style.display = el ? "none" : "";
    return el;
  } catch { return true; }
}
$("#btn-run-admin")?.addEventListener("click", async () => {
  let ok = true;
  try {
    if (window.electronAPI.confirm) ok = await window.electronAPI.confirm({
      title: "Jalankan sebagai administrator?",
      message: "TryDesk akan ditutup lalu dibuka lagi dengan izin administrator.",
      detail: "Windows akan menampilkan prompt UAC. Sesi yang sedang berjalan akan terputus.",
      okLabel: "Lanjut", cancelLabel: "Batal",
    });
  } catch {}
  if (ok) { try { await window.electronAPI.relaunchAsAdmin(); } catch {} }
});
refreshElevationUI();
$("#btn-toggle-pass").addEventListener("click", () => { accessPassword.type = accessPassword.type === "password" ? "text" : "password"; });
accessPassword.addEventListener("change", async () => {
  const value = accessPassword.value;
  if (value && value.length < 6) return showToast("Password minimal 6 karakter");
  store.set("accessPasswordHash", value ? await hashPassword(value) : null);
  accessPassword.value = "";
  accessPassword.placeholder = value ? "Password tersimpan (ketik untuk ganti)" : "Kosong = selalu minta Accept";
  showToast(value ? "Password akses disimpan" : "Password akses dihapus");
});

remoteIdInput.addEventListener("input", (e) => { const d = e.target.value.replace(/\D/g, "").slice(0, 9); e.target.value = d.match(/.{1,3}/g)?.join(" ") || ""; });
remoteIdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") initiateConnection(); });
remotePasswordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") initiateConnection(); });

$("#btn-minimize").addEventListener("click", () => window.electronAPI.minimizeWindow());
$("#btn-maximize").addEventListener("click", () => window.electronAPI.maximizeWindow());
$("#btn-close").addEventListener("click", () => window.electronAPI.closeWindow());

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
$("#setting-allow-input")?.addEventListener("change", (e) => { allowInput = e.target.checked; store.set("allowInput", allowInput ? "1" : "0"); });
$("#setting-allow-file")?.addEventListener("change", (e) => { allowFileTransfer = e.target.checked; store.set("allowFile", allowFileTransfer ? "1" : "0"); });
$("#setting-allow-clipboard")?.addEventListener("change", (e) => { allowClipboardPref = e.target.checked; store.set("allowClipboard", allowClipboardPref ? "1" : "0"); });
$("#setting-allow-viewonly")?.addEventListener("change", (e) => { forceViewOnly = e.target.checked; store.set("forceViewOnly", forceViewOnly ? "1" : "0"); });

// ─── Init ─────────────────────────────────────────────────
(async () => {
  config = await window.electronAPI.getConfig();
  serverUrl = config.signalingServer;
  try { const saved = JSON.parse(store.get("quality")); if (saved) defaultQuality = { ...DEFAULT_QUALITY, ...saved }; } catch {}
  if (store.get("showStats") === "1") { $("#stats-toggle").checked = true; statsOverlay.classList.remove("hidden"); }
  clipboardSync = store.get("clipboardSync") !== "0";
  $("#clipboard-toggle").checked = clipboardSync;
  applyAccessSettings();
  if (store.get("accessPasswordHash")) accessPassword.placeholder = "Password tersimpan (ketik untuk ganti)";
  // Restore device alias
  const savedAlias = store.get("deviceAlias");
  if (savedAlias) $("#device-alias").value = savedAlias;
  // Restore theme (only dark/light supported now; normalize older values)
  const savedTheme = store.get("theme") === "light" ? "light" : "dark";
  applyTheme(savedTheme);
  $("#setting-theme").value = savedTheme;
  if (store.get("theme") && store.get("theme") !== savedTheme) store.set("theme", savedTheme);
  // Restore language
  const savedLang = store.get("lang");
  if (savedLang) { $("#setting-language").value = savedLang; applyLanguage(savedLang); }
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
