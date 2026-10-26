const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, clipboard, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Properly-capitalised app name → the user-data folder becomes %APPDATA%\TryDesk (not "trydesk").
// MUST run before any app.getPath("userData") call below.
try { app.setName("TryDesk"); } catch {}
// One-time: correct the on-disk case of an older lowercase "trydesk" user-data folder. Windows is
// case-insensitive so all stored data (ID, settings, localStorage) is preserved — this only fixes how the
// folder name is displayed. Done before anything opens a file inside it. A two-step rename forces the
// case change (a direct trydesk→TryDesk rename can be treated as the same path on Windows).
try {
  const _appData = app.getPath("appData");
  const _wrong = fs.readdirSync(_appData).find((n) => n.toLowerCase() === "trydesk" && n !== "TryDesk");
  if (_wrong) {
    const _tmp = path.join(_appData, "TryDesk.tmp-" + Date.now());
    fs.renameSync(path.join(_appData, _wrong), _tmp);
    fs.renameSync(_tmp, path.join(_appData, "TryDesk"));
  }
} catch {}

// GPU fallback: some client PCs (old/VM/RDP GPUs, outdated drivers) fault in the GPU process and show
// a blank window or none at all. Disable hardware acceleration when asked (--no-gpu / TRYDESK_NO_GPU)
// OR when a previous run hit a GPU crash and left the flag below (written automatically, see the
// child-process-gone handler) — so the app self-heals on the next launch without the user doing anything.
let _noGpuFlag = null;
try { _noGpuFlag = path.join(app.getPath("userData"), "disable-gpu.flag"); } catch {}
const _flagExists = () => { try { return !!_noGpuFlag && fs.existsSync(_noGpuFlag); } catch { return false; } };
const _forceNoGpu = process.argv.includes("--no-gpu") || !!process.env.TRYDESK_NO_GPU || _flagExists();
if (_forceNoGpu) { try { app.disableHardwareAcceleration(); } catch {} }

// Screen-capture coverage: on some PCs the default DXGI capturer can't see a monitor (HDR on, or the monitor
// hangs off a different GPU), so getSources lists fewer screens than Windows has and that monitor can't be
// streamed — picking it shows another screen. Windows Graphics Capture (WGC) sees every monitor. It is
// switched on only where that gap was detected (flag written by the startup check / get-monitors), so every
// other PC keeps the default capturer. --wgc forces it for testing.
let _wgcFlag = null;
try { _wgcFlag = path.join(app.getPath("userData"), "wgc-capture.flag"); } catch {}
const _wgcOn = process.argv.includes("--wgc") || (() => { try { return !!_wgcFlag && fs.existsSync(_wgcFlag); } catch { return false; } })();
if (_wgcOn) { try { app.commandLine.appendSwitch("enable-features", "AllowWgcScreenCapturer"); } catch {} }

// Make any startup failure VISIBLE (and logged) instead of a silent no-window exit — so a client PC
// that "shows nothing" gives a real error + a log we can read, rather than just vanishing.
let _logFile;
try { _logFile = path.join(app.getPath("userData"), "trydesk-crash.log"); } catch { _logFile = path.join(os.tmpdir(), "trydesk-crash.log"); }
function logCrash(tag, err) {
  const line = `[${new Date().toISOString()}] ${tag}: ${(err && err.stack) || err}\n`;
  try { fs.appendFileSync(_logFile, line); } catch {}
  try { if (app.isReady()) dialog.showErrorBox("TryDesk bermasalah saat dijalankan", String((err && err.stack) || err).slice(0, 2000) + "\n\nLog: " + _logFile); } catch {}
}
// Quiet breadcrumbs (no dialog) so the log traces how far startup got on a PC where "nothing appears":
// if the file has "boot: module loaded" but not "boot: app ready", Electron never reached our JS.
function logInfo(msg) { try { fs.appendFileSync(_logFile, `[${new Date().toISOString()}] boot: ${msg}\n`); } catch {} }
// Build stamp (packaged app.asar mtime) so a log shows WHICH build a client PC is really running.
const _buildStamp = (() => { try { return require("original-fs").statSync(path.join(process.resourcesPath, "app.asar")).mtime.toISOString(); } catch { return "dev"; } })();
logInfo(`module loaded — electron ${process.versions.electron}, ${process.platform} ${process.arch}, build ${_buildStamp}, no-gpu=${_forceNoGpu}, wgc=${_wgcOn}`);
let _windowReady = false;   // true once the renderer has loaded
// A crash BEFORE the window loads is startup-fatal: show it, then EXIT — so a half-dead process
// doesn't linger holding the single-instance lock (which would make the next open "do nothing").
process.on("uncaughtException", (e) => { logCrash("uncaughtException", e); if (!_windowReady) { try { app.exit(1); } catch {} } });
// A rejected promise is NON-fatal (unlike uncaughtException): log it for diagnosis but DON'T pop a scary
// modal — e.g. discord-rpc rejects when Discord isn't running, which must never block the app from launching.
process.on("unhandledRejection", (e) => { try { fs.appendFileSync(_logFile, `[${new Date().toISOString()}] unhandledRejection (non-fatal): ${(e && e.stack) || e}\n`); } catch {} });

// Single instance: a second launch focuses the existing window instead of spawning a hidden,
// window-less duplicate process (which looks like "nothing happened").
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) app.quit();
else app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

let config;
try { config = require("./config.json"); } catch (e) { logCrash("config.json gagal dimuat", e); config = { iceServers: [] }; }
const inputSim = require("./input-simulator");
const discordRPC = require("./discord-rpc");

let mainWindow;
let blackScreenWindows = [];
const inputReady = inputSim.init();

// ─── Full keyboard capture (viewer) ───────────────────────
// While the viewer actively controls a remote PC, we install a low-level keyboard hook so EVERY key —
// including system shortcuts the browser can't see outside fullscreen (Alt+Tab, Win, Alt+Esc, Ctrl+Esc) —
// is forwarded to the remote and swallowed locally. We only swallow while the TryDesk window is focused,
// so the user can always click away (or the window blurs) to get their own keyboard back instantly.
let _kbWantCapture = false, _kbFocused = false, _kbNoticeSent = false, _mouseWant = false;
let _hostCursorHidden = false;   // latest debounced host cursor-capture state (for re-emit on channel open)
let _dmSourceId = null;          // which screen the renderer wants getDisplayMedia to capture (monitor select)
// Re-center target for native game-mouse capture: the physical-pixel center of the display the window is on,
// far from any screen edge so relative moves never get clamped. dipToScreenPoint handles HiDPI scaling.
function recenterMouse(moveCursor) {
  try {
    const { screen } = require("electron");
    const d = screen.getDisplayMatching(mainWindow.getBounds());
    const c = screen.dipToScreenPoint({ x: Math.round(d.bounds.x + d.bounds.width / 2), y: Math.round(d.bounds.y + d.bounds.height / 2) });
    inputSim.setMouseCenter(c.x, c.y);
    // On first engage, physically park the cursor at center so the first captured delta is ~0 (no camera jump).
    if (moveCursor) { try { inputSim.moveMouse(c.x, c.y); } catch {} }
  } catch {}
}
const _CTRL_VKS = new Set([0x11, 0xA2, 0xA3]), _ALT_VKS = new Set([0x12, 0xA4, 0xA5]), _SHIFT_VKS = new Set([0x10, 0xA0, 0xA1]);
let _downVks = new Set(), _escArmed = false;
function _anyDown(set) { for (const v of set) if (_downVks.has(v)) return true; return false; }
// Release control NOW: free the mouse immediately in the main process (don't wait on the renderer round-trip)
// AND tell the renderer so the UI/game-mode state syncs. The guaranteed "give me my PC back".
function releaseControlNow() {
  try { if (_mouseWant) { _mouseWant = false; inputSim.stopMouseHook && inputSim.stopMouseHook(); } } catch {}
  try { mainWindow && mainWindow.webContents.send("release-control"); } catch {}
}
function refreshKeyHook() {
  if (!inputReady || !inputSim.startKeyHook) return;
  if (_kbWantCapture) {
    inputSim.startKeyHook((vk, down) => {
      if (!(_kbWantCapture && _kbFocused)) return false;   // not focused → pass through to the local OS
      if (down) _downVks.add(vk); else _downVks.delete(vk);
      // ESCAPE HATCH 1 — Ctrl+Alt+Shift+Esc releases control (mouse + keyboard) so the user can ALWAYS get
      // back to their own PC, even mid-game. It REQUIRES Esc on purpose: a bare Ctrl+Alt+Shift used to fire
      // this, which clashed with the many app/game shortcuts that hold Ctrl+Alt+Shift — now those pass
      // through to the remote, and only the full +Esc combo escapes.
      if (vk === 0x1B && down && _anyDown(_CTRL_VKS) && _anyDown(_ALT_VKS) && _anyDown(_SHIFT_VKS)) {
        releaseControlNow();
        return false;
      }
      // ESCAPE HATCH 2 — Pause/Break, the dedicated "give me my PC back" key (never forwarded/swallowed).
      if (vk === 0x13) { if (down) releaseControlNow(); return false; }
      try { mainWindow && mainWindow.webContents.send("captured-key", { vk, down }); } catch {}
      return true;                                         // swallow locally → key only reaches the remote
    });
  } else {
    inputSim.stopKeyHook();
    _downVks.clear(); _escArmed = false;
    _kbNoticeSent = false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    backgroundColor: "#0a0a0f",
    icon: path.join(__dirname, "..", "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => { _windowReady = true; logInfo("renderer loaded"); try { mainWindow.show(); mainWindow.focus(); } catch {} });
  // Only swallow keys while focused; on blur, stop swallowing AND release any held keys on the host so a
  // modifier can't get stuck down when the user clicks away mid-combo.
  mainWindow.on("focus", () => { _kbFocused = true; });
  mainWindow.on("blur", () => { _kbFocused = false; _downVks.clear(); _escArmed = false; try { mainWindow.webContents.send("release-keys"); } catch {} });
  // Keep the game-mouse re-center point correct if the window moves to another monitor / resizes.
  mainWindow.on("move", () => { if (_mouseWant) recenterMouse(); });
  mainWindow.on("resize", () => { if (_mouseWant) recenterMouse(); });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => { if (code !== -3) logCrash("did-fail-load", code + " " + desc + " " + url); });
  // Recover once from a renderer/GPU crash (a blank window) by reloading instead of leaving it dead.
  let _reloaded = false;
  mainWindow.webContents.on("render-process-gone", (_e, d) => {
    logCrash("render-process-gone", d && d.reason);
    if (!_reloaded) { _reloaded = true; try { mainWindow.reload(); } catch {} }
  });
  // Lock navigation down: the app is a single local page. Block opening child windows and block
  // any attempt to navigate the window away from the bundled file (defense if the renderer is abused).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockNav = (e, url) => { if (!url.startsWith("file://")) e.preventDefault(); };
  mainWindow.webContents.on("will-navigate", blockNav);
  mainWindow.webContents.on("will-redirect", blockNav);
  mainWindow.webContents.on("will-attach-webview", (e) => e.preventDefault());
}

// The DXGI coverage gap described at _wgcFlag: Windows reports more displays than the capturer lists.
async function captureCoverageGap() {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  return { gap: screen.getAllDisplays().length > sources.length, sources: sources.length };
}

app.whenReady().then(async () => {
  if (!_gotLock) { logInfo("second instance — quitting"); return; }   // a primary instance already owns the window
  logInfo("app ready");
  // Relaunch ONCE into WGC before any window exists when a monitor is invisible to the default capturer,
  // so the very first session can already stream it. Bounded wait: never delays startup by more than 2s.
  if (!_wgcOn && _wgcFlag) {
    try {
      const r = await Promise.race([captureCoverageGap(), new Promise((res) => setTimeout(() => res(null), 2000))]);
      if (r && r.gap) {
        fs.writeFileSync(_wgcFlag, "1");
        logInfo(`capture gap: ${screen.getAllDisplays().length} displays but ${r.sources} capture sources — relaunching with WGC`);
        app.relaunch(); app.exit(0); return;
      }
    } catch (e) { logInfo("capture coverage check failed: " + e.message); }
  }
  // Windows shows this as the notification's app name; without it toasts read "electron.app.TryDesk".
  try { app.setAppUserModelId("TryDesk"); } catch {}
  // Content-Security-Policy as a response header (defense-in-depth alongside the <meta> in index.html).
  // The renderer loads only local assets; the one remote connection is the signaling WebSocket.
  try {
    const { session } = require("electron");
    const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' wss://desk.trydesk.ai.id; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'self'";
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } });
    });
    // Grant the permissions the app actually uses — crucially pointerLock/keyboardLock so game mode
    // can capture the mouse — and deny everything else. Without this, Electron can refuse pointer lock
    // and the remote mouse won't move inside captured games. (media/display-capture keep screen share working.)
    const ALLOW = new Set(["pointerLock", "keyboardLock", "fullscreen", "media", "mediaKeySystem", "display-capture", "clipboard-read", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(ALLOW.has(p)));
    // getDisplayMedia support: the MODERN screen-capture path. The legacy desktopCapturer mandatory
    // maxFrameRate hard-caps at 120fps (>120 silently falls back to 30), so high-refresh capture
    // (144/165/180/240) must go through getDisplayMedia. This handler feeds it the screen the renderer
    // selected (set-dm-source) with NO system picker, so capture starts silently like before.
    if (session.defaultSession.setDisplayMediaRequestHandler) {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
          // Never silently substitute the first screen for a REQUESTED one — that streamed the wrong monitor
          // ("stuck on the previous monitor"). set-dm-source already verified the id; a miss here means the
          // screen vanished in between → deny, and the renderer falls back to the legacy path.
          const src = sources.find((s) => s.id === _dmSourceId) || (_dmSourceId ? null : sources[0]);
          // audio: "loopback" = capture the host's SYSTEM audio (Windows) so remote audio works. Only
          // materializes into a track when the renderer's getDisplayMedia asks for audio (host start does).
          callback(src ? { video: src, audio: "loopback" } : {});
        }).catch(() => { try { callback({}); } catch {} });
      });
    }
  } catch (e) { logInfo("session setup error: " + e.message); }
  try { createWindow(); logInfo("window created"); } catch (e) { logCrash("createWindow gagal", e); try { app.exit(1); } catch {} return; }
  // Watchdog: if the renderer never finishes loading, leave a breadcrumb (diagnose.ps1 reads it).
  setTimeout(() => { if (!_windowReady) logInfo("WARNING: renderer not loaded after 15s"); }, 15000);
  // On a GPU-process crash, self-heal: remember to disable acceleration and relaunch once, so a bad
  // GPU/driver on a client PC no longer leaves a blank/missing window.
  let _gpuRelaunched = false;
  app.on("child-process-gone", (_e, d) => {
    const info = d && (d.type + " / " + d.reason);
    if (d && d.type === "GPU" && !_forceNoGpu && !_gpuRelaunched && _noGpuFlag) {
      // Auto-recover from a GPU-process crash silently (no scary error dialog): relaunch once without
      // hardware acceleration so the session keeps working.
      logInfo("child-process-gone: " + info + " — auto-recovering (software render)");
      _gpuRelaunched = true;
      try { fs.writeFileSync(_noGpuFlag, "1"); } catch {}
      try { app.relaunch(); app.exit(0); } catch {}
    } else {
      logCrash("child-process-gone", info);   // other child crashes stay visible
    }
  });
  // If we're running software-only because a PAST GPU crash set the flag, clear it after a stable start so
  // the NEXT launch retries hardware acceleration (encode load is now much lower: maintain-resolution +
  // a preset-driven fps cap), instead of staying stuck in slow software mode forever.
  if (_flagExists() && !process.argv.includes("--no-gpu") && !process.env.TRYDESK_NO_GPU) {
    setTimeout(() => { if (_windowReady) { try { fs.unlinkSync(_noGpuFlag); logInfo("cleared disable-gpu.flag — next launch retries GPU"); } catch {} } }, 25000);
  }
  // Watch whether a game/app has captured (hidden) the OS cursor; tell the renderer on change so the
  // viewer can auto-switch to relative mouse (no manual "game mode" toggle). Cheap 250ms poll.
  // Hysteresis: games (esp. with our mouse injection fighting them) make the OS cursor flicker
  // hidden/shown every few hundred ms. Report "hidden" instantly, but only report "shown" after the
  // cursor has stayed visible continuously for 1.5s — so game mode STAYS engaged through the blips
  // instead of spamming on/off (which made the captured mouse unusable).
  let _shownSince = 0;
  setInterval(() => {
    if (!inputReady || !mainWindow) return;
    const raw = inputSim.isCursorHidden();
    const now = Date.now();
    let hidden;
    if (raw) { hidden = true; _shownSince = 0; }
    else { if (!_shownSince) _shownSince = now; hidden = (now - _shownSince) < 1500; }
    if (hidden !== _hostCursorHidden) { _hostCursorHidden = hidden; logInfo("host cursor hidden=" + hidden + " (debounced)"); try { mainWindow.webContents.send("host-cursor-hidden", hidden); } catch {} }
  }, 250);
  // When a viewer's control channel opens, the host re-emits the CURRENT cursor state — so a game that was
  // ALREADY running at connect time (no state change to trigger on) still auto-enables the viewer's game mouse.
  ipcMain.on("request-cursor-state", () => { try { mainWindow.webContents.send("host-cursor-hidden", _hostCursorHidden); } catch {} });
  // Let the renderer append to the same log, so the whole game-mode chain is traceable in one file.
  ipcMain.on("log-info", (_e, m) => logInfo("ui: " + String(m).slice(0, 200)));
  // The renderer turns full keyboard capture on while actively controlling a remote PC (and off while
  // typing in a local field or when the session ends). Pick up the window's current focus immediately.
  try { _kbFocused = mainWindow.isFocused(); } catch {}
  ipcMain.on("set-key-capture", (_e, on) => {
    const want = !!on;
    if (want === _kbWantCapture) return;
    _kbWantCapture = want;
    refreshKeyHook();
    if (!want) { try { mainWindow.webContents.send("release-keys"); } catch {} }
  });
  // Native game-mouse capture: engaged automatically when a game is detected on the remote (no click/gesture).
  let _mouseFirstMove = false;
  ipcMain.on("set-mouse-capture", (_e, on) => {
    const want = !!on;
    if (want === _mouseWant) return;
    _mouseWant = want;
    let ok = true;
    if (!inputSim.startMouseHook) { ok = false; }
    else if (want) {
      recenterMouse(true);
      _mouseFirstMove = false;
      ok = inputSim.startMouseHook((evt) => {
        if (!_mouseFirstMove) { _mouseFirstMove = true; logInfo("mouse-capture: first event forwarded (" + evt.t + ")"); }
        try { mainWindow && mainWindow.webContents.send("captured-mouse", evt); } catch {}
      }, () => _mouseWant && _kbFocused);
    } else inputSim.stopMouseHook();
    logInfo("mouse-capture want=" + want + " hookOk=" + ok + " focused=" + _kbFocused);
    try { mainWindow.webContents.send("mouse-capture-result", { want, ok }); } catch {}
  });
  // When the host's own display resolution/scale changes, tell the renderer to re-capture cleanly
  // (prevents the decoder-garbage flicker and keeps remote input mapping aligned to the new size).
  let displayChangeTimer = null;
  screen.on("display-metrics-changed", (_e, _display, changed) => {
    if (!changed.some((c) => c === "bounds" || c === "scaleFactor" || c === "rotation")) return;
    // Coalesce bursts (games/sandboxes fire these rapidly) — the renderer also no-ops when the captured
    // size is unchanged, so this only ever reaches a real resolution change.
    clearTimeout(displayChangeTimer);
    displayChangeTimer = setTimeout(() => { try { mainWindow && mainWindow.webContents.send("display-changed"); } catch {} }, 600);
  });
  // Persistent panic key: release any host black-screen/input-lock if a session leaves them stuck.
  try { globalShortcut.register("Ctrl+Alt+Shift+Escape", () => { disableBlackScreen(); disableInputLock(); }); } catch {}
  // Discord Rich Presence — "Using TryDesk" on the user's profile (best-effort, silent if unavailable).
  try { discordRPC.init(logInfo); } catch (e) { logInfo("discord RPC init skipped: " + e.message); }
  // The renderer reports session state ("idle" | "hosting" | "viewing") so the presence reflects what's happening.
  ipcMain.on("discord-activity", (_e, state) => { try { discordRPC.setActivity(String(state || "idle")); } catch {} });
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { try { disableBlackScreen(); } catch {} try { disableInputLock(); } catch {} try { inputSim.stopKeyHook && inputSim.stopKeyHook(); } catch {} try { inputSim.stopMouseHook && inputSim.stopMouseHook(); } catch {} try { discordRPC.shutdown(); } catch {} });

ipcMain.handle("get-config", () => config);
// Elevation: report whether the host runs as admin (can control admin/UAC windows), and relaunch elevated.
ipcMain.handle("is-elevated", () => { try { return inputSim.isElevated ? inputSim.isElevated() : false; } catch { return false; } });
ipcMain.handle("relaunch-as-admin", () => {
  try {
    const exe = process.execPath;
    // Start-Process -Verb RunAs shows the UAC prompt and relaunches TryDesk elevated. Quit this (non-elevated)
    // instance so it releases the single-instance lock before the elevated one finishes starting.
    require("child_process").spawn("powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs`],
      { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => { try { app.quit(); } catch {} }, 700);
    return true;
  } catch (e) { logInfo("relaunch-as-admin failed: " + e.message); return false; }
});
// Native confirm for destructive actions (e.g. Regenerate ID). Returns true only if the user picks OK.
ipcMain.handle("confirm-dialog", async (_e, opts) => {
  opts = opts || {};
  try {
    const r = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [opts.cancelLabel || "Batal", opts.okLabel || "OK"],
      defaultId: 1, cancelId: 0, noLink: true,
      title: opts.title || "Konfirmasi",
      message: opts.message || "",
      detail: opts.detail || "",
    });
    return r.response === 1;
  } catch { return false; }
});

ipcMain.handle("get-sources", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

ipcMain.handle("get-screen-size", () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor };
});

let _lastMonitorMap = "";
ipcMain.handle("get-monitors", async () => {
  // Enumerate by OS DISPLAY — screen.getAllDisplays() is the authoritative monitor count/geometry,
  // so every physical monitor is always listed even when desktopCapturer.getSources() under-reports
  // (some Windows GPU/driver setups return fewer "screen" sources than there are displays).
  // Each display gets its own capture id: the exact source matched by display_id when present,
  // otherwise the next unused source positionally, and as a last resort the synthesized Windows
  // source id "screen:<i>:0" (confirmed format) so even an unreported monitor stays capturable.
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  if (!displays.length) {
    // No display info at all — fall back to whatever sources exist (or a single synthesized one).
    const list = sources.length ? sources : [{ id: "screen:0:0", name: "Monitor 1" }];
    return list.map((src, i) => ({ sourceId: src.id, index: i, label: src.name || `Monitor ${i + 1}`, boundsX: 0, boundsY: 0, width: 1920, height: 1080, scaleFactor: 1, primary: i === 0 }));
  }
  const usedSrc = new Set();
  // Pass 1: exact match each display to its source by display_id.
  const srcForDisplay = new Map();
  for (const d of displays) {
    const match = sources.find((s) => s.display_id && String(s.display_id) === String(d.id) && !usedSrc.has(s.id));
    if (match) { srcForDisplay.set(d.id, match); usedSrc.add(match.id); }
  }
  // Pass 2: give any still-unmatched display the next unused source (positional fallback).
  const remaining = sources.filter((s) => !usedSrc.has(s.id));
  let ri = 0;
  for (const d of displays) {
    if (!srcForDisplay.has(d.id) && ri < remaining.length) { srcForDisplay.set(d.id, remaining[ri]); usedSrc.add(remaining[ri].id); ri++; }
  }
  // A monitor plugged in mid-run can open the coverage gap too: remember it so the NEXT launch uses WGC.
  if (!_wgcOn && _wgcFlag && sources.length < displays.length) { try { fs.writeFileSync(_wgcFlag, "1"); } catch {} }
  // Log the display↔source mapping when it changes — the first thing to read when a monitor won't switch.
  const _map = `wgc=${_wgcOn} displays=[${displays.map((d) => `${d.id}:${d.label || "?"} ${d.size.width}x${d.size.height}@${d.scaleFactor}`).join(", ")}] sources=[${sources.map((s) => `${s.id}/${s.display_id || "-"}`).join(", ")}]`;
  if (_map !== _lastMonitorMap) { _lastMonitorMap = _map; logInfo("monitors " + _map); }
  return displays.map((d, i) => {
    const src = srcForDisplay.get(d.id) || null;
    return {
      sourceId: src ? src.id : `screen:${i}:0`,   // synthesized last-resort id keeps the monitor capturable
      displayId: String(d.id),
      index: i,
      label: (src && src.name) || d.label || `Monitor ${i + 1}`,
      boundsX: d.bounds.x, boundsY: d.bounds.y,
      width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor,
      primary: d.id === primaryId,
    };
  });
});

let captureDisplay = null;
ipcMain.on("set-capture-display", (_e, d) => { captureDisplay = d; });
// Which screen getDisplayMedia should feed (monitor select). Awaitable so the renderer sets it BEFORE
// calling getDisplayMedia — avoids a race where the handler picks the wrong/first screen.
// Resolves the monitor to a LIVE source now (exact id, else its OS display id) and returns whether one exists;
// false tells the renderer to use the legacy capture path instead of letting getDisplayMedia grab another screen.
ipcMain.handle("set-dm-source", async (_e, id, displayId) => {
  let src = null;
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
    src = sources.find((s) => s.id === id) || (displayId ? sources.find((s) => String(s.display_id) === String(displayId)) : null) || null;
  } catch {}
  _dmSourceId = src ? src.id : null;
  return !!src;
});

ipcMain.on("focus-window", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
ipcMain.on("minimize-window", () => mainWindow?.minimize());
ipcMain.on("maximize-window", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on("close-window", () => mainWindow?.close());

ipcMain.on("execute-input", (_e, event) => {
  if (!inputReady || !event) return;
  try {
    switch (event.action) {
      case "mousemove": {
        // Viewer sends coordinates normalized to 0..1 of the captured monitor
        let d = captureDisplay;
        if (!d) { const p = screen.getPrimaryDisplay(); d = { boundsX: 0, boundsY: 0, width: p.size.width, height: p.size.height, scaleFactor: p.scaleFactor }; }
        const x = (d.boundsX + event.x * d.width) * d.scaleFactor;
        const y = (d.boundsY + event.y * d.height) * d.scaleFactor;
        inputSim.moveMouse(x, y);
        break;
      }
      case "mousemove-rel": {
        // Game mode: relative motion so pointer-locked / raw-input games (Minecraft, FPS) move.
        inputSim.moveMouseRelative(event.dx, event.dy);
        break;
      }
      case "mousedown": inputSim.mouseDown(event.button); break;
      case "mouseup": inputSim.mouseUp(event.button); break;
      case "scroll": inputSim.mouseScroll(event.deltaX || 0, event.deltaY || 0); break;
      case "keydown": inputSim.keyDown(event.vk); break;
      case "keyup": inputSim.keyUp(event.vk); break;
    }
  } catch (err) {
    console.error("Input execution error:", err.message);
  }
});

// ─── Clipboard ────────────────────────────────────────────
ipcMain.handle("clipboard-read", () => clipboard.readText());
ipcMain.handle("clipboard-write", (_e, text) => { clipboard.writeText(String(text ?? "")); });

// ─── File transfer (streaming) ────────────────────────────
const readHandles = new Map();   // id -> { fd, size }
const writeHandles = new Map();  // id -> { fd }
let handleSeq = 0;

ipcMain.handle("file-pick", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openFile", "multiSelections"] });
  if (res.canceled) return [];
  return res.filePaths.map((p) => {
    const st = fs.statSync(p);
    return { path: p, name: path.basename(p), size: st.size };
  });
});

ipcMain.handle("file-save-dialog", async (_e, name) => {
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: name });
  return res.canceled ? null : res.filePath;
});

// Reject non-string / empty / NUL-byte paths before any fs call (hardening for the file IPC).
function cleanPath(p) {
  if (typeof p !== "string" || !p || p.indexOf("\0") !== -1) throw new Error("invalid path");
  return p;
}

ipcMain.handle("file-open-read", (_e, filePath) => {
  const id = `r${++handleSeq}`;
  const fd = fs.openSync(cleanPath(filePath), "r");
  readHandles.set(id, { fd, size: fs.fstatSync(fd).size });
  return id;
});

ipcMain.handle("file-read-chunk", (_e, { id, length }) => {
  const h = readHandles.get(id);
  if (!h) return null;
  const buf = Buffer.alloc(length);
  const n = fs.readSync(h.fd, buf, 0, length, null);
  if (n <= 0) return { done: true, chunk: new Uint8Array(0) };
  return { done: false, chunk: new Uint8Array(buf.buffer, buf.byteOffset, n) };
});

ipcMain.handle("file-close-read", (_e, id) => {
  const h = readHandles.get(id);
  if (h) { try { fs.closeSync(h.fd); } catch {} readHandles.delete(id); }
});

ipcMain.handle("file-open-write", (_e, filePath) => {
  const id = `w${++handleSeq}`;
  writeHandles.set(id, { fd: fs.openSync(cleanPath(filePath), "w") });
  return id;
});

// Open a write handle targeting a directory + name (used by the file manager).
// Returns the resolved path, de-duplicated so an incoming file never silently clobbers an existing one.
ipcMain.handle("file-open-write-in", (_e, { dir, name }) => {
  cleanPath(dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("invalid directory");
  const safeName = path.basename(String(name || "file"));
  let target = path.join(dir, safeName);
  if (fs.existsSync(target)) {
    const ext = path.extname(safeName);
    const base = safeName.slice(0, safeName.length - ext.length);
    let n = 1;
    do { target = path.join(dir, `${base} (${n})${ext}`); n++; } while (fs.existsSync(target));
  }
  const id = `w${++handleSeq}`;
  writeHandles.set(id, { fd: fs.openSync(target, "w") });
  return { id, path: target };
});

ipcMain.handle("file-write-chunk", (_e, { id, chunk }) => {
  const h = writeHandles.get(id);
  if (!h) return false;
  const buf = Buffer.from(chunk);
  fs.writeSync(h.fd, buf, 0, buf.length, null);
  return true;
});

ipcMain.handle("file-close-write", (_e, { id, deleteFile, filePath }) => {
  const h = writeHandles.get(id);
  if (h) { try { fs.closeSync(h.fd); } catch {} writeHandles.delete(id); }
  if (deleteFile && filePath) { try { fs.unlinkSync(filePath); } catch {} }
});

// ─── Filesystem browsing (file manager) ──────────────────
function listDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ":\\";
    try { if (fs.existsSync(d)) drives.push(d); } catch {}
  }
  return drives;
}

// List a directory into { name, path, isDir, size, mtime } rows.
// An empty/null path yields the "This PC" root: a Home shortcut followed by the available drives.
function listDirectory(dirPath) {
  if (!dirPath) {
    const home = os.homedir();
    const entries = [{ name: `Home — ${path.basename(home) || home}`, path: home, isDir: true, size: 0, mtime: 0, kind: "home" }];
    for (const d of listDrives()) entries.push({ name: d, path: d, isDir: true, size: 0, mtime: 0, kind: "drive" });
    return { ok: true, path: "", display: "Komputer ini", parent: null, isRoot: true, entries };
  }
  let items;
  try { items = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: e.code || e.message, path: dirPath, display: dirPath }; }
  const entries = [];
  for (const it of items) {
    const full = path.join(dirPath, it.name);
    let isDir = false, size = 0, mtime = 0;
    try {
      const st = fs.statSync(full);
      isDir = st.isDirectory(); size = st.size; mtime = st.mtimeMs;
    } catch {
      try { const ls = fs.lstatSync(full); isDir = ls.isDirectory(); size = ls.size; mtime = ls.mtimeMs; }
      catch { isDir = it.isDirectory(); }
    }
    entries.push({ name: it.name, path: full, isDir, size, mtime });
  }
  const parent = path.dirname(dirPath);
  const atRoot = parent === dirPath; // drive root like "C:\" → go up to This PC
  return { ok: true, path: dirPath, display: dirPath, parent: atRoot ? "" : parent, isRoot: false, entries };
}

ipcMain.handle("fs-home", () => os.homedir());
ipcMain.handle("fs-list", (_e, dirPath) => listDirectory(dirPath));

// ─── Black screen (privacy mode) ─────────────────────────
const WDA_EXCLUDEFROMCAPTURE = 0x11;

function enableBlackScreen() {
  disableBlackScreen();
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      transparent: false,
      backgroundColor: "#000000",
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.loadURL("data:text/html,<body style=\"background:#000;margin:0;cursor:none;overflow:hidden\"><div style=\"display:flex;align-items:center;justify-content:center;height:100vh;color:%23333;font-family:sans-serif;font-size:14px\">TryDesk - Layar digelapkan</div></body>");
    try {
      const hwndBuf = win.getNativeWindowHandle();
      const hwnd = hwndBuf.readUInt32LE(0);
      inputSim.setWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    } catch (e) {
      console.warn("SetWindowDisplayAffinity failed:", e.message);
    }
    blackScreenWindows.push(win);
  }
}

function disableBlackScreen() {
  for (const w of blackScreenWindows) { try { w.close(); } catch {} }
  blackScreenWindows = [];
}

ipcMain.handle("enable-black-screen", () => { enableBlackScreen(); return true; });
ipcMain.handle("disable-black-screen", () => { disableBlackScreen(); return true; });

// ─── Lock host input ──────────────────────────────────────
let inputLockActive = false;

function enableInputLock() {
  if (inputLockActive) return;
  inputLockActive = true;
  inputSim.blockInput(true);
}

function disableInputLock() {
  // Always attempt to unblock, even if the flag drifted, so input can never stay stuck.
  inputLockActive = false;
  try { inputSim.blockInput(false); } catch {}
}

ipcMain.handle("enable-input-lock", () => { enableInputLock(); return true; });
ipcMain.handle("disable-input-lock", () => { disableInputLock(); return true; });

app.on("will-quit", () => { disableBlackScreen(); disableInputLock(); });
