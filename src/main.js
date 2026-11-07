const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, clipboard, globalShortcut, shell, powerSaveBlocker, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Security: a PACKAGED build must refuse remote-debugging / inspector switches. Otherwise any other process
// running as the same user could launch TryDesk with --remote-debugging-port and drive the renderer over CDP,
// which means full access to every IPC (file read/write, input injection). Dev builds (not packaged) still
// allow it, so the CDP diagnostics workflow keeps working.
try {
  if (app.isPackaged && ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "inspect-port"]
      .some((s) => app.commandLine.hasSwitch(s))) {
    app.exit(1);
  }
} catch {}

// Properly-capitalised app name → the user-data folder becomes %APPDATA%\TryDesk (not "trydesk").
// MUST run before any app.getPath("userData") call below.
try { app.setName("TryDesk"); } catch {}
// Started by the TryDesk Windows service (trydesk-service.exe) as SYSTEM in the session that owns the screen: an
// unattended host with its own data folder under %ProgramData% (its own ID, apart from the user's TryDesk), no
// window, no tray, and connections only with the access password set for the service (service.json, written by
// an administrator). MUST be set before anything below reads the user-data path.
const _serviceHost = process.platform === "win32" && process.argv.includes("--service-host");
const _serviceDir = path.join(process.env.ProgramData || "C:\\ProgramData", "TryDesk");
if (_serviceHost) { try { app.setPath("userData", path.join(_serviceDir, "service-host")); } catch {} }
function servicePasswordHash() {
  // In service-host (SYSTEM + Administrators only), not the top folder users can read (that was 1.3.1).
  try { const j = JSON.parse(fs.readFileSync(path.join(_serviceDir, "service-host", "service.json"), "utf8")); return /^[0-9a-f]{32}:[0-9a-f]{64}$/.test(j.passwordHash || "") ? j.passwordHash : ""; } catch { return ""; }
}
// One-time: correct the on-disk case of an older lowercase "trydesk" user-data folder. Windows is
// case-insensitive so all stored data (ID, settings, localStorage) is preserved, this only fixes how the
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
// child-process-gone handler), so the app self-heals on the next launch without the user doing anything.
let _noGpuFlag = null;
try { _noGpuFlag = path.join(app.getPath("userData"), "disable-gpu.flag"); } catch {}
const _flagExists = () => { try { return !!_noGpuFlag && fs.existsSync(_noGpuFlag); } catch { return false; } };
// Hyper-V guests (Windows Sandbox, Hyper-V VMs) can expose the host's GPU through GPU-PV. There, GPU-accelerated
// screen capture (DXGI / WGC frames shared with Chromium's GPU process) terminates the WHOLE VM the moment a
// session starts (Sandbox: "virtual machine exited unexpectedly 0x80370106"), measured; GDI and software
// rendering are fine. Such guests run in software mode. --force-gpu overrides.
function _hyperVGuest() {
  if (process.platform !== "win32") return null;
  if ((process.env.USERNAME || "").toUpperCase() === "WDAGUTILITYACCOUNT") return "windows-sandbox";
  try {
    const out = require("child_process").execFileSync("reg", ["query", "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS", "/v", "SystemProductName"], { encoding: "utf8", timeout: 1500, windowsHide: true });
    if (/Virtual Machine/i.test(out)) return "hyper-v";
  } catch {}
  return null;
}
const _vmGuest = process.argv.includes("--force-gpu") ? null : _hyperVGuest();
// The user's own choice (Settings → Lanjutan → GPU acceleration off). Separate from the crash flag above, which
// clears itself after a stable start.
let _userNoGpuFlag = null;
try { _userNoGpuFlag = path.join(app.getPath("userData"), "user-no-gpu.flag"); } catch {}
const _userNoGpu = (() => { try { return !!_userNoGpuFlag && fs.existsSync(_userNoGpuFlag); } catch { return false; } })();
const _forceNoGpu = process.argv.includes("--no-gpu") || !!process.env.TRYDESK_NO_GPU || _flagExists() || !!_vmGuest || _userNoGpu;
if (_forceNoGpu) { try { app.disableHardwareAcceleration(); } catch {} }

// Screen-capture coverage: on some PCs the default DXGI capturer can't see a monitor (HDR on, or the monitor
// hangs off a different GPU), so getSources lists fewer screens than Windows has and that monitor can't be
// streamed, picking it shows another screen. Windows Graphics Capture (WGC) sees every monitor. It is
// switched on only where that gap was detected (flag written by the startup check / get-monitors), so every
// other PC keeps the default capturer. --wgc forces it for testing.
let _wgcFlag = null;
try { _wgcFlag = path.join(app.getPath("userData"), "wgc-capture.flag"); } catch {}
// Inside a Remote Desktop (RDP) session WGC sent only black frames (rented RDP PC, 2026-11-02: black with the
// window full-screen or not), while DXGI capture of the same session showed the desktop. There WGC is switched
// off so Chromium uses DXGI / GDI; in Windows Sandbox (also a remote session) that kept the picture (measured).
// Asked from Windows itself (SM_REMOTESESSION): SESSIONNAME alone missed it in a copy run as administrator, that
// environment has no SESSIONNAME, so WGC stayed on and every capture failed ("Could not start video source", the
// viewer could not connect; rented PC, 2026-11-02).
const _rdpSession = process.platform === "win32" && (() => {
  if (/^RDP-/i.test(process.env.SESSIONNAME || "")) return true;
  try { return !!require("koffi").load("user32.dll").func("int __stdcall GetSystemMetrics(int nIndex)")(0x1000); } catch { return false; }
})();
const _wgcOn = !_rdpSession && (process.argv.includes("--wgc") || (() => { try { return !!_wgcFlag && fs.existsSync(_wgcFlag); } catch { return false; } })());
if (_wgcOn) { try { app.commandLine.appendSwitch("enable-features", "AllowWgcScreenCapturer"); } catch {} }
if (_rdpSession) { try { app.commandLine.appendSwitch("disable-features", "AllowWgcScreenCapturer,AllowWgcWindowCapturer"); } catch {} }

// Language for text the main process shows itself (dialogs, black-screen overlay, Discord presence). The
// renderer reports the user's choice; until then follow Windows, exactly like the renderer's default.
let _uiLang = null;
function uiLang() { if (_uiLang) return _uiLang; try { return /^id\b/i.test(app.getLocale()) ? "id" : "en"; } catch { return "id"; } }
const L = (id, en) => (uiLang() === "en" ? en : id);

// Make any startup failure VISIBLE (and logged) instead of a silent no-window exit, so a client PC
// that "shows nothing" gives a real error + a log we can read, rather than just vanishing.
let _logFile;
try { _logFile = path.join(app.getPath("userData"), "trydesk-crash.log"); } catch { _logFile = path.join(os.tmpdir(), "trydesk-crash.log"); }
// The log only ever grows (session/capture breadcrumbs), so keep it bounded on users' disks: past ~1 MB,
// keep just the newest 512 KB. Checked at startup and every 200 writes while running.
const LOG_MAX = 1024 * 1024, LOG_KEEP = 512 * 1024;
let _logWrites = 0;
function trimLog() {
  try {
    if (fs.statSync(_logFile).size <= LOG_MAX) return;
    const buf = fs.readFileSync(_logFile);
    const tail = buf.subarray(buf.length - LOG_KEEP);
    const nl = tail.indexOf(10);   // start on a whole line
    fs.writeFileSync(_logFile, nl >= 0 ? tail.subarray(nl + 1) : tail);
  } catch {}
}
trimLog();
function appendLog(line) {
  try { fs.appendFileSync(_logFile, line); } catch {}
  if (++_logWrites % 200 === 0) trimLog();
}
function logCrash(tag, err) {
  appendLog(`[${new Date().toISOString()}] ${tag}: ${(err && err.stack) || err}\n`);
  try { if (app.isReady()) dialog.showErrorBox(L("TryDesk bermasalah saat dijalankan", "TryDesk ran into a problem"), String((err && err.stack) || err).slice(0, 2000) + "\n\nLog: " + _logFile); } catch {}
}
// Quiet breadcrumbs (no dialog) so the log traces how far startup got on a PC where "nothing appears":
// if the file has "boot: module loaded" but not "boot: app ready", Electron never reached our JS.
function logInfo(msg) { appendLog(`[${new Date().toISOString()}] boot: ${msg}\n`); }
// Build stamp (packaged app.asar mtime) so a log shows WHICH build a client PC is really running.
const _buildStamp = (() => { try { return require("original-fs").statSync(path.join(process.resourcesPath, "app.asar")).mtime.toISOString(); } catch { return "dev"; } })();
logInfo(`module loaded, electron ${process.versions.electron}, ${process.platform} ${process.arch}, build ${_buildStamp}, no-gpu=${_forceNoGpu}${_vmGuest ? ` (vm: ${_vmGuest})` : ""}, wgc=${_wgcOn}${_rdpSession ? " (rdp session: wgc off)" : ""}`);
let _windowReady = false;   // true once the renderer has loaded
// A crash BEFORE the window loads is startup-fatal: show it, then EXIT, so a half-dead process
// doesn't linger holding the single-instance lock (which would make the next open "do nothing").
process.on("uncaughtException", (e) => { logCrash("uncaughtException", e); if (!_windowReady) { try { app.exit(1); } catch {} } });
// A rejected promise is NON-fatal (unlike uncaughtException): log it for diagnosis but DON'T pop a scary
// modal, e.g. discord-rpc rejects when Discord isn't running, which must never block the app from launching.
process.on("unhandledRejection", (e) => { appendLog(`[${new Date().toISOString()}] unhandledRejection (non-fatal): ${(e && e.stack) || e}\n`); });

// The real exe to relaunch: the portable build runs from a temp-extracted copy that its wrapper may delete once
// the original exits, so relaunches must target the portable file itself.
const _selfExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const relaunchSelf = () => app.relaunch(process.env.PORTABLE_EXECUTABLE_FILE ? { execPath: _selfExe, args: process.argv.slice(1) } : undefined);

// Relaunched elevated ("Run as administrator"): wait for the old instance to exit before taking the single-
// instance lock, or the new one would find it still held and quit, leaving nothing running.
const _waitPid = Number((process.argv.find((a) => a.startsWith("--wait-for-pid=")) || "").split("=")[1]) || 0;
if (_waitPid) {
  const until = Date.now() + 8000, nap = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) { try { process.kill(_waitPid, 0); } catch { break; } Atomics.wait(nap, 0, 0, 100); }
}

// Single instance: a second launch focuses the existing window instead of spawning a hidden,
// window-less duplicate process (which looks like "nothing happened").
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) app.quit();
else app.on("second-instance", (_e, argv) => {
  showMainWindow();
  // An elevated copy from "Run as administrator" lost the race: this copy was started by hand while the portable
  // build was still unpacking the new one. Say so here, or the user just gets a non-admin TryDesk without a word.
  if ((argv || []).some((a) => String(a).startsWith("--wait-for-pid="))) {
    logInfo("relaunch-as-admin: elevated copy found this one already running and quit");
    try { mainWindow.webContents.send("elevated-relaunch-blocked"); } catch {}
  }
});

// Taskbar identity. Packaged builds use "TryDesk" (notifications show that name). A dev run (plain electron.exe)
// gets its own ID, sharing one made Windows show the Electron icon for the real app on a developer's PC.
const AUMID = app.isPackaged ? "TryDesk" : "TryDesk.Dev";
// Windows takes the taskbar and notification icon for an AUMID from the Start Menu shortcut that carries it. A
// "TryDesk.lnk" can end up pointing at an exe that is gone: the portable build's temp copy (a fresh %TEMP% folder
// every launch, deleted on exit) or a removed build folder. From then on every TryDesk window showed a blank icon.
// Point such a shortcut at the exe that stays (the installed TryDesk.exe or the portable file itself). A working
// shortcut (e.g. the installer's) is left alone, and none is created where there was none.
function repairStartMenuShortcut() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const lnk = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "TryDesk.lnk");
  let cur;
  try { cur = shell.readShortcutLink(lnk); } catch { return; }
  // Compare real long paths: %TEMP% can be an 8.3 short name (C:\Users\JOHNSM~1\...) while the shortcut has the long one.
  const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
  const tmp = real(os.tmpdir()) + path.sep;
  const broken = !cur.target || !fs.existsSync(cur.target) || real(cur.target).startsWith(tmp);
  if (!broken || real(_selfExe).startsWith(tmp)) return;
  try {
    shell.writeShortcutLink(lnk, "replace", { target: _selfExe, icon: _selfExe, iconIndex: 0, appUserModelId: AUMID, description: "TryDesk" });
    logInfo(`start-menu shortcut repaired (was ${cur.target || "empty"})`);
  } catch (e) { logInfo("start-menu shortcut repair failed: " + e.message); }
}
// Started by Windows at login ("Mulai saat startup"): come up quietly in the system tray, like AnyDesk.
const _startInTray = process.argv.includes("--tray");

// ─── System tray (installer AND portable) ─────────────────
// TryDesk lives in the tray while it runs: the X button only hides the window (unless the user turned that off),
// so this PC stays reachable; "Keluar" in the tray menu really quits.
let tray = null, _trayId = "", _trayHosting = false, _quitting = false;
function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function trayImage() {
  // PNGs (an .ico inside app.asar can't be read by Windows' icon loader); one representation per DPI scale.
  const img = nativeImage.createEmpty();
  for (const [px, scale] of [[16, 1], [20, 1.25], [24, 1.5], [32, 2]]) {
    try { img.addRepresentation({ scaleFactor: scale, buffer: fs.readFileSync(path.join(__dirname, "..", "assets", `tray-${px}.png`)) }); } catch {}
  }
  return img;
}
function refreshTray() {
  if (!tray) return;
  const idLine = _trayId ? `ID ${_trayId}` : L("Belum terhubung ke server", "Not connected to the server");
  tray.setToolTip(`TryDesk, ${_trayHosting ? L("PC ini sedang dikontrol", "This PC is being controlled") : idLine}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `TryDesk · ${idLine}`, enabled: false },
    { type: "separator" },
    { label: L("Buka TryDesk", "Open TryDesk"), click: showMainWindow },
    { label: L("Salin ID", "Copy ID"), enabled: !!_trayId, click: () => clipboard.writeText(_trayId) },
    { type: "separator" },
    { label: L("Keluar", "Quit"), click: requestQuit },
  ]));
}
function createTray() {
  try {
    tray = new Tray(trayImage());
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
    refreshTray();
  } catch (e) { logInfo("tray failed: " + e.message); tray = null; }
}
// ─── macOS menu bar ───────────────────────────────────────
// On a Mac, Cmd+C/V/X/A/Z only work in text fields when the app menu has an Edit menu, so it is there while you
// type. While a remote PC is being controlled the menu drops every shortcut: Cmd+C must reach the remote PC (the
// page sends it as Ctrl+C), not copy on this Mac. Cmd+Q asks first when a session is live, like "Keluar" in the tray.
function setMacMenu(controlling) {
  if (process.platform !== "darwin") return;
  const quit = { label: L("Keluar dari TryDesk", "Quit TryDesk"), click: requestQuit };
  if (!controlling) quit.accelerator = "Cmd+Q";
  const appMenu = { label: "TryDesk", submenu: [
    { role: "about", label: L("Tentang TryDesk", "About TryDesk") },
    { type: "separator" },
    controlling ? { label: L("Sembunyikan TryDesk", "Hide TryDesk"), click: () => app.hide() } : { role: "hide", label: L("Sembunyikan TryDesk", "Hide TryDesk") },
    { type: "separator" },
    quit,
  ] };
  const template = controlling ? [appMenu] : [appMenu, { role: "editMenu", label: L("Edit", "Edit") }, { role: "windowMenu", label: L("Jendela", "Window") }];
  try { Menu.setApplicationMenu(Menu.buildFromTemplate(template)); } catch (e) { logInfo("mac menu failed: " + e.message); }
}

// "Keluar": the page asks first when a session is live (same question as before), then calls quit-app.
function requestQuit() {
  if (!mainWindow || !_windowReady) { _quitting = true; app.quit(); return; }
  try { mainWindow.webContents.send("quit-requested"); } catch { _quitting = true; app.quit(); }
}
ipcMain.on("quit-app", () => { _quitting = true; app.quit(); });
ipcMain.on("hide-to-tray", (_e, firstTime) => {
  if (!mainWindow) return;
  if (!tray) { _quitting = true; app.quit(); return; }   // no tray → hiding would leave the app unreachable
  mainWindow.hide();
  if (firstTime) {
    try {
      tray.displayBalloon({
        iconType: "info", title: L("TryDesk tetap berjalan", "TryDesk is still running"),
        content: L("PC ini tetap bisa dihubungi. Klik ikon TryDesk di system tray untuk membuka, atau klik kanan → Keluar.",
                   "This PC can still be reached. Click the TryDesk icon in the system tray to open it, or right-click → Quit."),
      });
    } catch {}
  }
});
ipcMain.on("tray-info", (_e, info) => {
  _trayId = typeof info?.id === "string" ? info.id.slice(0, 20) : "";
  refreshTray();
});

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
      // ESCAPE HATCH 1, Ctrl+Alt+Shift+Esc releases control (mouse + keyboard) so the user can ALWAYS get
      // back to their own PC, even mid-game. It REQUIRES Esc on purpose: a bare Ctrl+Alt+Shift used to fire
      // this, which clashed with the many app/game shortcuts that hold Ctrl+Alt+Shift, now those pass
      // through to the remote, and only the full +Esc combo escapes.
      if (vk === 0x1B && down && _anyDown(_CTRL_VKS) && _anyDown(_ALT_VKS) && _anyDown(_SHIFT_VKS)) {
        releaseControlNow();
        return false;
      }
      // ESCAPE HATCH 2, Pause/Break, the dedicated "give me my PC back" key (never forwarded/swallowed).
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
    height: 600,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    // Shown once the page has loaded (did-finish-load): the service's host must never show an empty window on the
    // user's desktop, and a --tray start stays in the tray.
    show: false,
    backgroundColor: "#0a0a0f",
    icon: path.join(__dirname, "..", "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,   // a released build has no DevTools at all (the service's host runs as SYSTEM)
    },
  });
  // No default menu on Windows/Linux: the window is frameless and the default one only brought Electron's own
  // shortcuts (Ctrl+Shift+I, Ctrl+R) into a window that may belong to the SYSTEM service.
  if (process.platform !== "darwin") { try { Menu.setApplicationMenu(null); } catch {} }
  if (_serviceHost) mainWindow.webContents.on("before-input-event", (ev, input) => {
    const k = String(input.key || "").toLowerCase();
    if (k === "f12" || (input.control && input.shift && (k === "i" || k === "j" || k === "c")) || (input.control && k === "r") || k === "f5") ev.preventDefault();
  });
  // The taskbar button takes its icon and "pin" target from these window properties, the TryDesk exe itself
  // (for the portable build: the portable file, not its temp-extracted copy).
  try {
    mainWindow.setAppDetails({ appId: AUMID, appIconPath: _selfExe, appIconIndex: 0, relaunchCommand: `"${_selfExe}"`, relaunchDisplayName: "TryDesk" });
  } catch {}
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => {
    _windowReady = true; logInfo("renderer loaded" + (_serviceHost ? " (service host)" : ""));
    if (_serviceHost) return;                             // the service's host never shows a window
    if (_startInTray && tray) return;                     // Windows login start: stay in the tray
    try { mainWindow.show(); mainWindow.focus(); } catch {}
  });
  // Alt+F4 / the taskbar's "Close window": same as the X button, hide to the tray, unless really quitting.
  mainWindow.on("close", (e) => {
    // The service's host only shows its window for a request or a running session: closing it just hides it.
    if (_serviceHost && !_quitting) { e.preventDefault(); mainWindow.hide(); return; }
    if (_quitting || !tray) return;
    e.preventDefault();
    try { mainWindow.webContents.send("close-requested"); } catch { mainWindow.hide(); }
  });
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
    // The page that owned them is gone: drop every native effect it had switched on, or the black screen,
    // BlockInput, game-mode mouse trap and held keys would outlive it (and the reloaded page knows nothing).
    try { disableBlackScreen(); } catch {}
    try { disableInputLock(); } catch {}
    try { if (inputReady) inputSim.releaseAll(); } catch {}
    try { _kbWantCapture = false; refreshKeyHook(); setMacMenu(false); } catch {}
    try { _mouseWant = false; inputSim.stopMouseHook && inputSim.stopMouseHook(); } catch {}
    if (!_reloaded) { _reloaded = true; try { mainWindow.reload(); } catch {} }
  });
  // Lock navigation down: the app is a single local page. Block opening child windows and block
  // any attempt to navigate the window away from the bundled file (defense if the renderer is abused).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Only the app's own page may load. "Any file://" let a file dropped on the window replace the app, every
  // session died and the native keyboard/mouse hooks stayed engaged with no page left to release them.
  const appPage = require("url").pathToFileURL(path.join(__dirname, "renderer", "index.html")).href.toLowerCase();
  const blockNav = (e, url) => { if (String(url).split(/[?#]/)[0].toLowerCase() !== appPage) e.preventDefault(); };
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
  if (!_gotLock) { logInfo("second instance, quitting"); return; }   // a primary instance already owns the window
  logInfo("app ready" + (inputReady && inputSim.isElevated() ? " (administrator)" : ""));
  // Relaunch ONCE into WGC before any window exists when a monitor is invisible to the default capturer,
  // so the very first session can already stream it. Bounded wait: never delays startup by more than 2s.
  if (!_wgcOn && _wgcFlag && !_rdpSession) {   // in RDP WGC stays off, so relaunching into it would loop
    try {
      const r = await Promise.race([captureCoverageGap(), new Promise((res) => setTimeout(() => res(null), 2000))]);
      if (r && r.gap) {
        fs.writeFileSync(_wgcFlag, "1");
        logInfo(`capture gap: ${screen.getAllDisplays().length} displays but ${r.sources} capture sources, relaunching with WGC`);
        relaunchSelf(); app.exit(0); return;
      }
    } catch (e) { logInfo("capture coverage check failed: " + e.message); }
  }
  // Windows shows this as the notification's app name; without it toasts read "electron.app.TryDesk".
  try { app.setAppUserModelId(AUMID); } catch {}
  repairStartMenuShortcut();
  // A notification during this run can create the shortcut pointing at the portable's temp copy; fix it before
  // that copy is deleted.
  app.on("will-quit", repairStartMenuShortcut);
  // The page's Content-Security-Policy is the <meta> in index.html (a response-header CSP never applies to the
  // file:// page, so none is set here).
  try {
    const { session } = require("electron");
    // Grant the permissions the app actually uses, crucially pointerLock/keyboardLock so game mode
    // can capture the mouse, and deny everything else. Without this, Electron can refuse pointer lock
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
          // Never silently substitute the first screen for a REQUESTED one, that streamed the wrong monitor
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
  if (!_serviceHost) createTray();
  setMacMenu(false);
  // macOS: clicking the Dock icon brings back a window that was closed to the menu bar.
  app.on("activate", showMainWindow);
  try { createWindow(); logInfo("window created"); } catch (e) { logCrash("createWindow gagal", e); try { app.exit(1); } catch {} return; }
  // Watchdog: if the renderer never finishes loading, leave a breadcrumb (diagnose.ps1 reads it).
  // The window waits for the page (show: false), so a page that never loads would leave nothing on screen: show it anyway.
  setTimeout(() => {
    if (_windowReady) return;
    logInfo("WARNING: renderer not loaded after 15s");
    if (!_serviceHost && !(_startInTray && tray)) { try { mainWindow.show(); } catch {} }
  }, 15000);
  // On a GPU-process crash, self-heal: remember to disable acceleration and relaunch once, so a bad
  // GPU/driver on a client PC no longer leaves a blank/missing window.
  let _gpuRelaunched = false;
  app.on("child-process-gone", (_e, d) => {
    const info = d && (d.type + " / " + d.reason);
    if (d && d.type === "GPU" && !_forceNoGpu && !_gpuRelaunched && _noGpuFlag) {
      // Auto-recover from a GPU-process crash silently (no scary error dialog): relaunch once without
      // hardware acceleration so the session keeps working.
      logInfo("child-process-gone: " + info + ", auto-recovering (software render)");
      _gpuRelaunched = true;
      try { fs.writeFileSync(_noGpuFlag, "1"); } catch {}
      try { relaunchSelf(); app.exit(0); } catch {}
    } else {
      logCrash("child-process-gone", info);   // other child crashes stay visible
    }
  });
  // If we're running software-only because a PAST GPU crash set the flag, clear it after a stable start so
  // the NEXT launch retries hardware acceleration (encode load is now much lower: maintain-resolution +
  // a preset-driven fps cap), instead of staying stuck in slow software mode forever.
  if (_flagExists() && !process.argv.includes("--no-gpu") && !process.env.TRYDESK_NO_GPU) {
    setTimeout(() => { if (_windowReady) { try { fs.unlinkSync(_noGpuFlag); logInfo("cleared disable-gpu.flag, next launch retries GPU"); } catch {} } }, 25000);
  }
  // Watch whether a game/app has captured (hidden) the OS cursor; tell the renderer on change so the
  // viewer can auto-switch to relative mouse (no manual "game mode" toggle). Cheap 250ms poll.
  // Hysteresis: games (esp. with our mouse injection fighting them) make the OS cursor flicker
  // hidden/shown every few hundred ms. Report "hidden" instantly, but only report "shown" after the
  // cursor has stayed visible continuously for 1.5s, so game mode STAYS engaged through the blips
  // instead of spamming on/off (which made the captured mouse unusable).
  let _shownSince = 0;
  // Only matters while someone controls this PC, no 4×/s cursor polling (or log lines) when idle or viewing.
  let _hosting = false;
  ipcMain.on("hosting-state", (_e, on) => {
    _hosting = !!on; _trayHosting = _hosting; refreshTray();
    if (!_hosting && _adminWindow) { _adminWindow = false; try { mainWindow.webContents.send("host-admin-window", false); } catch {} }
  });
  // An admin window in front (Task Manager, admin CMD) blocks a non-elevated host's input and hides its cursor.
  // Tell the renderer on change, so the viewer sees why control stopped instead of a "frozen" session.
  const _selfElevated = inputReady && inputSim.isElevated();
  let _adminWindow = false;
  setInterval(() => {
    if (!inputReady || !mainWindow || !_hosting || _selfElevated) return;
    const on = inputSim.isForegroundElevated();
    if (on !== _adminWindow) {
      _adminWindow = on; logInfo("admin window in front: " + on);
      try { mainWindow.webContents.send("host-admin-window", on); } catch {}
    }
  }, 500);
  ipcMain.on("request-admin-window-state", () => { try { mainWindow.webContents.send("host-admin-window", _adminWindow); } catch {} });
  setInterval(() => {
    if (!inputReady || !mainWindow || !_hosting) return;
    const raw = inputSim.isCursorHidden();
    const now = Date.now();
    let hidden;
    if (raw) { hidden = true; _shownSince = 0; }
    else { if (!_shownSince) _shownSince = now; hidden = (now - _shownSince) < 1500; }
    if (hidden !== _hostCursorHidden) { _hostCursorHidden = hidden; try { mainWindow.webContents.send("host-cursor-hidden", hidden); } catch {} }
  }, 250);
  // When a viewer's control channel opens, the host re-emits the CURRENT cursor state, so a game that was
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
    setMacMenu(want);
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
  let displayChangeTimer = null, displayForce = false;
  const sendDisplayChanged = (force) => {
    displayForce = displayForce || force;
    // Coalesce bursts (games/sandboxes fire these rapidly), the renderer also no-ops when the captured
    // size is unchanged, so this only ever reaches a real resolution change (or a display that was replaced).
    clearTimeout(displayChangeTimer);
    displayChangeTimer = setTimeout(() => { const f = displayForce; displayForce = false; try { mainWindow && mainWindow.webContents.send("display-changed", f); } catch {} }, 600);
  };
  screen.on("display-metrics-changed", (_e, _display, changed) => {
    if (!changed.some((c) => c === "bounds" || c === "scaleFactor" || c === "rotation")) return;
    sendDisplayChanged(false);
  });
  // A display that is replaced keeps the old capture pointing at nothing: black picture. In a Remote Desktop
  // session that happens on every reconnect / move to the console, often at the SAME size, so the size check
  // above never fires (rented RDP PC, 2026-11-02). New or removed displays force a fresh capture, and a slow
  // poll of the display ids catches the changes Windows doesn't report as events.
  screen.on("display-added", () => sendDisplayChanged(true));
  screen.on("display-removed", () => sendDisplayChanged(true));
  let displayIds = screen.getAllDisplays().map((d) => d.id).join(",");
  setInterval(() => {
    const ids = screen.getAllDisplays().map((d) => d.id).join(",");
    if (ids !== displayIds) { displayIds = ids; logInfo("displays replaced: " + ids); sendDisplayChanged(true); }
  }, 3000);
  // Persistent panic key: release any host black-screen/input-lock if a session leaves them stuck.
  // (BlockInput swallows physical keys, so while input is locked only Ctrl+Alt+Del breaks it, Windows' rule.)
  // Tell the renderer so the host UI and the viewer's toggles show the truth afterwards.
  // A hotkey belongs to whichever process registers it first. With the Windows service, the service's host and the
  // user's own app both run on this desktop; only the service's host darkens the screen then, so the app yields
  // the key (panic-key-yield) and the service keeps retrying until it holds it.
  ensurePanicKey();
  if (_serviceHost) setInterval(ensurePanicKey, 5000);
  // Discord Rich Presence, "Using TryDesk" on the user's profile (best-effort, silent if unavailable).
  if (!_serviceHost) { try { discordRPC.init(logInfo); } catch (e) { logInfo("discord RPC init skipped: " + e.message); } }
  // The renderer reports session state ("idle" | "hosting" | "viewing") so the presence reflects what's happening.
  ipcMain.on("discord-activity", (_e, state) => { try { discordRPC.setActivity(String(state || "idle")); } catch {} });
  ipcMain.on("set-ui-language", (_e, l) => { _uiLang = l === "en" ? "en" : "id"; try { discordRPC.setLanguage(_uiLang); } catch {} refreshTray(); setMacMenu(_kbWantCapture); });
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { _quitting = true; try { tray && tray.destroy(); } catch {} tray = null; });
app.on("before-quit", () => { try { disableBlackScreen(); } catch {} try { disableInputLock(); } catch {} try { inputSim.stopKeyHook && inputSim.stopKeyHook(); } catch {} try { inputSim.stopMouseHook && inputSim.stopMouseHook(); } catch {} try { discordRPC.shutdown(); } catch {} });

// platform: the page turns Windows-only parts off elsewhere (Linux and macOS are viewer-only builds).
// osRelease: the device's OS, sent along when the app signs in to the server. Windows 10 and 11 share one User-Agent, so
// the build number ("10.0.22631") is the only way to tell them apart; on Linux the distro name is more useful, and on
// a Mac the macOS version ("macOS 26.1"), since os.release() there is the Darwin kernel number.
function osRelease() {
  if (process.platform === "linux") {
    try { const m = fs.readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)"?/m); if (m) return m[1].slice(0, 60); } catch {}
  }
  if (process.platform === "darwin") { try { return `macOS ${process.getSystemVersion()}`; } catch {} }
  return os.release();
}
ipcMain.handle("get-config", () => ({ ...config, appVersion: app.getVersion(), platform: process.platform, osRelease: osRelease(), rdpSession: _rdpSession, serviceHost: _serviceHost, servicePwHash: _serviceHost ? servicePasswordHash() : "",
  testNoChromiumCapture: !app.isPackaged && process.env.TRYDESK_TEST_NO_CHROMIUM_CAPTURE === "1" }));

// Update check: https://trydesk.ai.id/update/version.json says the newest version and the oldest one still considered
// safe ({ latest, minimum, url, notes: { id, en } }). Fetched here (not in the page) so the page's CSP stays as tight
// as it is. Only well-formed fields go back; anything else,offline, a bad answer,is null and blocks nothing.
// TRYDESK_UPDATE_URL lets a local test point the check at http://127.0.0.1 (nothing else is accepted).
const UPDATE_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w./-]*$/.test(process.env.TRYDESK_UPDATE_URL || "") ? process.env.TRYDESK_UPDATE_URL : "https://trydesk.ai.id/update/version.json";
ipcMain.handle("check-update", async () => {
  try {
    const { net } = require("electron");
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    const r = await net.fetch(UPDATE_URL, { signal: ctl.signal, cache: "no-store" }).finally(() => clearTimeout(tm));
    if (!r.ok) return null;
    const j = JSON.parse((await r.text()).slice(0, 8192));
    const ver = (v) => (typeof v === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : null);
    const note = (v) => (typeof v === "string" ? v.slice(0, 300) : "");
    const url = typeof j.url === "string" && /^https:\/\/(www\.)?trydesk\.ai\.id\//.test(j.url) ? j.url : "https://trydesk.ai.id/downloads/";
    if (!ver(j.latest)) return null;
    const out = { latest: ver(j.latest), minimum: ver(j.minimum), url, notes: { id: note(j.notes && j.notes.id), en: note(j.notes && j.notes.en) } };
    // The file is signed (scripts/sign-version.mjs, key kept off the website) and checked here: whoever gets into the
    // web hosting can change the page, but can't make every TryDesk refuse to connect ("minimum") or point it at
    // another download. Unsigned or badly signed = no update news at all, never a forced update.
    if (!versionJsonSigned(out, j.sig)) { logInfo("update check: version.json signature missing or invalid, ignored"); return null; }
    const num = (v) => v.split(".").map(Number).reduce((a, b) => a * 1000 + b, 0);
    if (out.minimum && num(out.minimum) > num(out.latest)) out.minimum = null;   // never require what is not released
    return out;
  } catch { return null; }
});
const VERSION_JSON_PUBKEY = "MCowBQYDK2VwAyEALmgxboidf3mbPwbQKUYPidxLPlSdMvgjQle1fXxJu6E=";   // Ed25519, SPKI
// The signed bytes: the five fields in a fixed order (scripts/sign-version.mjs builds the same string).
function versionJsonCanonical(v) { return JSON.stringify({ latest: v.latest, minimum: v.minimum || "", url: v.url, notes: { id: v.notes.id, en: v.notes.en } }); }
function versionJsonSigned(v, sig) {
  try {
    if (typeof sig !== "string" || !/^[A-Za-z0-9+/=]{80,100}$/.test(sig)) return false;
    const crypto = require("crypto");
    const key = crypto.createPublicKey({ key: Buffer.from(VERSION_JSON_PUBKEY, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(versionJsonCanonical(v), "utf8"), key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

// ─── LAN direct connection ───────────────────────────────
// "Sambung lewat IP": two PCs on the same network can start a session with no internet and no signaling server.
// The signaling messages travel as one JSON object per line over a plain TCP socket; the session itself is the same
// WebRTC peer connection as always. This file only moves lines: the page decides what a line means (see app.js
// "LAN direct connection"). Off by default; the host only listens while Settings → Koneksi turns it on, only
// accepts private/local addresses, and the page refuses any LAN request unless an access password is set.
const net = require("net");
const LAN_PORT = 7171;
const LAN_MAX_LINE = 64 * 1024, LAN_MAX_IN = 6, LAN_MAX_PER_IP = 2, LAN_MAX_MSG_PER_SEC = 100;
let lanServer = null, lanSeq = 0;
const lanConns = new Map();   // "lan-in:<ip>#n" (someone asking this PC) / "lan:<address>" (this PC asking) -> socket
const lanIp = (a) => String(a || "").replace(/^::ffff:/i, "");
// 10/8, 172.16/12, 192.168/16, loopback, link-local, 100.64/10 (CGNAT, Tailscale/ZeroTier style VPNs), IPv6 ULA/link-local.
const CGNAT_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
// 100.64/10 counts as "local" only when this PC itself has such an address (a Tailscale/ZeroTier style VPN). On a
// mobile/ISP connection that range is the carrier's shared network, where other subscribers are not neighbours.
let _cgnatLocal = null;
function cgnatLocal() {
  if (_cgnatLocal === null || Date.now() - _cgnatLocal.at > 60000) {
    let has = false;
    try { for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && CGNAT_RE.test(a.address)) has = true; } catch {}
    _cgnatLocal = { has, at: Date.now() };
  }
  return _cgnatLocal.has;
}
function lanPrivate(ip) {
  ip = lanIp(ip);
  if (CGNAT_RE.test(ip)) return cgnatLocal();
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^(::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(ip);
}
function lanAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal && lanPrivate(a.address)) out.push(a.address);
  return out;
}
function lanEmit(ev) { try { mainWindow && mainWindow.webContents.send("lan-event", ev); } catch {} }
// Line framing + limits for one socket, either direction.
function lanWire(id, sock) {
  const incoming = id.startsWith("lan-in:");
  lanConns.set(id, sock);
  sock.setEncoding("utf8");
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 15000);   // a PC that vanished (cable, sleep) is noticed instead of lingering for good
  let buf = "", rlStart = 0, rlCount = 0;
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const now = Date.now();
      if (now - rlStart > 1000) { rlStart = now; rlCount = 0; }
      if (++rlCount > LAN_MAX_MSG_PER_SEC || line.length > LAN_MAX_LINE) continue;
      let msg; try { msg = JSON.parse(line); } catch { msg = null; }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") { if (incoming && !sock._tdAsked) { sock.destroy(); return; } continue; }
      // Someone asking this PC must start with a connect-request; a scanner or junk sender is dropped right away.
      if (incoming && !sock._tdAsked) { if (msg.type !== "connect-request") { sock.destroy(); return; } sock._tdAsked = true; }
      lanEmit({ id, kind: "line", msg });
    }
    if (buf.length > LAN_MAX_LINE) sock.destroy();   // a line that never ends
  });
  sock.on("error", () => {});
  sock.on("close", () => { if (lanConns.get(id) === sock) { lanConns.delete(id); lanEmit({ id, kind: "close" }); } });
}
function lanWrite(id, msg) {
  const s = lanConns.get(id);
  if (!s || s.destroyed) return false;
  try { s.write(JSON.stringify(msg) + "\n"); return true; } catch { return false; }
}
// Calls are serialised: a quick on/off/on ends in the state of the last call, never with two listeners or with a
// listener that an "off" sent mid-start missed.
let lanHostChain = Promise.resolve();
ipcMain.handle("lan-host", (_e, opts) => (lanHostChain = lanHostChain.then(() => lanHostSet(opts), () => lanHostSet(opts))));
// The page marks a socket that became a real session; until then it lives at most 90 s (enough for the password rounds).
ipcMain.on("lan-keep", (_e, id) => { const s = lanConns.get(String(id)); if (s) s._tdKept = true; });
const lanHostSet = (opts) => new Promise((resolve) => {
  const on = !!(opts && opts.on);
  const hello = { type: "lan-hello", v: 1, machine: String((opts && opts.machine) || "").slice(0, 64) };
  if (!on) {
    // Stop listening and drop every request still in progress; a session already set up keeps its socket (a codec
    // change still needs it).
    if (lanServer) { try { lanServer.close(); } catch {} lanServer = null; }
    for (const [k, s] of lanConns) if (k.startsWith("lan-in:") && !s._tdKept) { try { s.destroy(); } catch {} }
    return resolve({ ok: true, on: false });
  }
  if (lanServer) { lanServer._hello = hello; return resolve({ ok: true, on: true, port: LAN_PORT, addrs: lanAddrs() }); }
  const srv = net.createServer((sock) => {
    const ip = lanIp(sock.remoteAddress);
    const ins = [...lanConns.keys()].filter((k) => k.startsWith("lan-in:"));
    if (!lanPrivate(ip) || ins.length >= LAN_MAX_IN || ins.filter((k) => k.startsWith(`lan-in:${ip}#`)).length >= LAN_MAX_PER_IP) {
      logInfo(`lan: refused ${ip}`); sock.destroy(); return;
    }
    const id = `lan-in:${ip}#${++lanSeq}`;
    lanWire(id, sock);
    lanWrite(id, srv._hello);
    // No connect-request within 15 s (a port scanner, a half-open attempt), or no accepted session within 90 s: dropped.
    setTimeout(() => { if (!sock._tdAsked && !sock.destroyed) sock.destroy(); }, 15000);
    setTimeout(() => { if (!sock._tdKept && !sock.destroyed) sock.destroy(); }, 90000);
    logInfo(`lan: connection from ${ip}`);
  });
  srv._hello = hello;
  // "::" takes IPv4 and IPv6 on a dual-stack PC; a PC without IPv6 falls back to IPv4 only.
  let host = "::";
  srv.on("error", (err) => {
    if (host === "::" && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL")) { host = "0.0.0.0"; listen(); return; }
    if (lanServer === srv) lanServer = null;
    logInfo("lan: listen failed: " + err.code);
    resolve({ ok: false, error: err.code === "EADDRINUSE" ? `Port ${LAN_PORT} sudah dipakai program lain` : "Tidak bisa membuka port LAN (" + (err.code || err.message) + ")" });
  });
  const listen = () => srv.listen({ port: LAN_PORT, host, exclusive: true }, () => {
    lanServer = srv;
    logInfo(`lan: listening on ${host}:${LAN_PORT}`);
    resolve({ ok: true, on: true, port: LAN_PORT, addrs: lanAddrs() });
  });
  listen();
});
// This PC asks another one. address = "192.168.1.20", "192.168.1.20:7171", "[fe80::1]:7171" or a LAN host name.
ipcMain.handle("lan-open", (_e, address) => new Promise((resolve) => {
  const a = String(address || "").trim().slice(0, 255);
  const m = a.match(/^\[([0-9a-f:.%a-z]+)\](?::(\d{1,5}))?$/i) || a.match(/^([^:\s]+)(?::(\d{1,5}))?$/) || a.match(/^([0-9a-f:]+)$/i);
  if (!m) return resolve({ ok: false, error: "Alamat IP tidak valid" });
  const host = m[1], port = Number(m[2]) || LAN_PORT;
  if (port < 1 || port > 65535) return resolve({ ok: false, error: "Port tidak valid" });
  const id = "lan:" + a;
  const old = lanConns.get(id); if (old) { lanConns.delete(id); try { old.destroy(); } catch {} }
  const sock = net.connect({ host, port });
  let done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
  const timer = setTimeout(() => { sock.destroy(); finish({ ok: false, error: "Tidak ada TryDesk yang menjawab di alamat ini" }); }, 6000);
  sock.once("connect", () => {
    // Host names are resolved by the OS: whatever they resolve to must still be a local address.
    if (!lanPrivate(sock.remoteAddress)) { sock.destroy(); return finish({ ok: false, error: "Hanya alamat jaringan lokal (LAN) yang bisa dipakai" }); }
    lanWire(id, sock);
    finish({ ok: true, id });
  });
  sock.once("error", (err) => finish({ ok: false, error: err.code === "ECONNREFUSED" ? "PC tujuan tidak menerima koneksi LAN (belum diaktifkan di Pengaturan, atau diblokir firewall)" : err.code === "ENOTFOUND" ? "Nama PC tidak ditemukan di jaringan" : "Tidak bisa terhubung ke alamat ini" }));
}));
ipcMain.on("lan-write", (_e, id, msg) => { if (msg && typeof msg === "object") lanWrite(String(id), msg); });
ipcMain.on("lan-close", (_e, id) => { const s = lanConns.get(String(id)); if (s) { try { s.end(); } catch {} setTimeout(() => { try { s.destroy(); } catch {} }, 1000); } });
// Elevation: report whether the host runs as admin (can control admin windows), and relaunch elevated.
ipcMain.handle("is-elevated", () => { try { return inputSim.isElevated ? inputSim.isElevated() : false; } catch { return false; } });
// Start-Process -Verb RunAs shows the UAC prompt. Quit ONLY once the elevated copy really started (exit code 0):
// declining UAC used to close TryDesk with nothing reopening. The new copy waits for this PID before locking.
// The quit waits a moment so the page can end its sessions properly first (peers told, server pairing dropped)
// and the user can read that the new window takes a few seconds (the portable build unpacks itself first).
ipcMain.handle("relaunch-as-admin", () => new Promise((resolve) => {
  try {
    // The exe path goes in through the environment, never into the command text: PowerShell also treats the
    // curly quotes ‘ ’ ‚ ‛ as string delimiters, so a folder like "Bob’s" broke (or could inject into) a quoted path.
    const ps = require("child_process").spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
      `try { Start-Process -FilePath $env:TD_SELF_EXE -ArgumentList '--wait-for-pid=${process.pid}' -Verb RunAs -ErrorAction Stop; exit 0 } catch { exit 1 }`],
      { stdio: "ignore", windowsHide: true, env: { ...process.env, TD_SELF_EXE: _selfExe } });
    ps.on("exit", (code) => {
      if (code === 0) { logInfo("relaunch-as-admin: elevated copy started, quitting this one"); resolve(true); setTimeout(() => { _quitting = true; try { app.quit(); } catch {} }, 2500); }
      else { logInfo("relaunch-as-admin: UAC declined or failed (code " + code + ")"); resolve(false); }
    });
    ps.on("error", (e) => { logInfo("relaunch-as-admin failed: " + e.message); resolve(false); });
  } catch (e) { logInfo("relaunch-as-admin failed: " + e.message); resolve(false); }
}));

// ─── Windows service (unattended access): src/native/trydesk-service.exe ───
// Install/uninstall run the helper elevated (one UAC prompt). Install copies this TryDesk folder to Program Files
// (the service runs only that copy) and stores the access password hash where only administrators can write.
const _serviceExe = path.join(__dirname, "native", "trydesk-service.exe").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const _serviceIdFile = path.join(_serviceDir, "service-id.txt");
// mode: install (app, optional hash) | uninstall | set-password (hash, or "none" to remove it).
function runServiceElevated(mode, args = {}) {
  return new Promise((resolve) => {
    // Paths and the hash go in through the environment, never into the command text (see relaunch-as-admin).
    const ps = require("child_process").spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
      "try { $a = switch ($env:TD_SVC_MODE) { 'install' { 'install \"' + $env:TD_SVC_APP + '\" ' + $env:TD_SVC_HASH } 'set-password' { 'set-password ' + $env:TD_SVC_HASH } default { 'uninstall' } }; " +
      "$p = Start-Process -FilePath $env:TD_SVC_EXE -ArgumentList $a.Trim() -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode } catch { exit 1223 }"],
      { stdio: "ignore", windowsHide: true, env: { ...process.env, TD_SVC_EXE: _serviceExe, TD_SVC_MODE: mode, TD_SVC_APP: args.app || "", TD_SVC_HASH: args.hash || "" } });
    ps.on("exit", (code) => resolve(code));
    ps.on("error", () => resolve(1));
  });
}
const PW_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{64}$/;
ipcMain.handle("service-status", () => new Promise((resolve) => {
  if (process.platform !== "win32" || _serviceHost) return resolve({ supported: false });
  let id = ""; try { id = fs.readFileSync(_serviceIdFile, "utf8").trim().replace(/\D/g, "").slice(0, 12); } catch {}
  require("child_process").execFile("sc.exe", ["query", "TryDeskService"], { windowsHide: true }, (err, out) => {
    const m = /STATE\s*:\s*\d+\s+(\w+)/.exec(String(out || ""));
    resolve({ supported: app.isPackaged && fs.existsSync(_serviceExe), installed: !!m, state: m ? m[1] : "", id });
  });
}));
ipcMain.handle("service-install", async (_e, hash) => {
  if (process.platform !== "win32" || _serviceHost || !app.isPackaged || !fs.existsSync(_serviceExe)) return { ok: false, code: -1 };
  hash = String(hash || "");   // optional: without one, requests get the Accept dialog
  if (hash && !PW_HASH_RE.test(hash)) return { ok: false, code: -2 };
  const code = await runServiceElevated("install", { app: process.execPath, hash });
  logInfo("service install exit " + code);
  return { ok: code === 0, code };
});
ipcMain.handle("service-uninstall", async () => {
  if (process.platform !== "win32" || _serviceHost || !fs.existsSync(_serviceExe)) return { ok: false, code: -1 };
  const code = await runServiceElevated("uninstall");
  logInfo("service uninstall exit " + code);
  return { ok: code === 0, code };
});
// The access password, set or cleared in the app, goes to the service too (admin-only file: one UAC prompt).
ipcMain.handle("service-set-password", async (_e, hash) => {
  if (process.platform !== "win32" || _serviceHost || !fs.existsSync(_serviceExe)) return { ok: false, code: -1 };
  hash = String(hash || "");
  if (hash && !PW_HASH_RE.test(hash)) return { ok: false, code: -2 };
  const code = await runServiceElevated("set-password", { hash: hash || "none" });
  logInfo("service set-password exit " + code);
  return { ok: code === 0, code };
});
// One ID, as with AnyDesk: the app writes the ID it has been using, and the service's host takes it over the first
// time it starts (the app then signs in with a second ID of its own, used only to control other PCs).
const _identityFile = path.join(app.getPath("userData"), "identity.json");
const ID_RE = /^\d{3} \d{3} \d{3}$/, TOKEN_RE = /^[0-9a-f]{16,128}$/i;
ipcMain.on("export-identity", (_e, v) => {
  if (_serviceHost || !v || !ID_RE.test(v.id) || !TOKEN_RE.test(v.token)) return;
  try { fs.writeFileSync(_identityFile, JSON.stringify({ id: v.id, token: v.token })); } catch {}
});
// The service's host reads it from the profile of the user in its session (passed by the service: --user-profile=).
ipcMain.handle("service-user-identity", () => {
  if (!_serviceHost) return null;
  const arg = process.argv.find((a) => a.startsWith("--user-profile="));
  if (!arg) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(arg.slice(15), "AppData", "Roaming", "TryDesk", "identity.json"), "utf8"));
    return ID_RE.test(j.id) && TOKEN_RE.test(j.token) ? { id: j.id, token: j.token } : null;
  } catch { return null; }
});
// A disconnected session (RDP window closed / disconnected) has no screen at all: Windows draws nothing, so there is
// nothing to capture. The service's host (SYSTEM) moves its own session to the console, as `tscon <id> /dest:console`
// does: the desktop is drawn again and stays unlocked. Only for a connection that already passed the password, and
// never when someone else is logged on at the console (that would throw them off).
ipcMain.handle("service-attach-console", () => {
  if (!_serviceHost) return { ok: false, why: "not the service host" };
  try {
    const koffi = require("koffi"), k32 = koffi.load("kernel32.dll"), wts = koffi.load("wtsapi32.dll");
    const consoleId = k32.func("uint32 __stdcall WTSGetActiveConsoleSessionId()")();
    const pidToSid = k32.func("int __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *sid)");
    const query = wts.func("int __stdcall WTSQuerySessionInformationW(void *h, uint32 sid, int cls, _Out_ void **buf, _Out_ uint32 *bytes)");
    const free = wts.func("void __stdcall WTSFreeMemory(void *p)");
    const info = (sid, cls, type) => { const b = [null], n = [0]; if (!query(null, sid, cls, b, n) || !b[0]) return null; try { return type === "str" ? koffi.decode(b[0], "char16_t", -1) : koffi.decode(b[0], "int32"); } finally { free(b[0]); } };
    const own = [0]; if (!pidToSid(process.pid, own)) return { ok: false, why: "session unknown" };
    if (consoleId === 0xFFFFFFFF) return { ok: false, why: "no console session" };
    if (own[0] === consoleId) return { ok: false, why: "already on the console" };
    if (info(own[0], 8, "int") !== 4) return { ok: false, why: "session not disconnected" };     // 8 = WTSConnectState, 4 = WTSDisconnected
    if (info(consoleId, 5, "str")) return { ok: false, why: "another user is on the console" };   // 5 = WTSUserName
    const ok = wts.func("int __stdcall WTSConnectSessionW(uint32 logonId, uint32 targetId, const char16_t *pwd, int wait)")(own[0], consoleId, "", 0);
    const err = ok ? 0 : k32.func("uint32 __stdcall GetLastError()")();
    logInfo(`service host: session ${own[0]} -> console ${consoleId}: ${ok ? "moved" : "failed " + err}`);
    return { ok: !!ok, why: ok ? "" : "WTSConnectSession failed " + err };
  } catch (e) { return { ok: false, why: e.message }; }
});
// The service's host reports its TryDesk ID so the normal app can show it (the folder is admin-only; SYSTEM writes).
ipcMain.on("service-id", (_e, id) => {
  if (!_serviceHost) return;
  try { fs.writeFileSync(_serviceIdFile, String(id || "").replace(/\D/g, "").slice(0, 12)); } catch {}
});

// ─── Settings that act on the OS (Settings panel) ───
// Start with Windows: launched with --tray so it comes up in the system tray, not as a window. An entry made by
// an older build (no --tray) still counts as "on" and is replaced when the switch is next changed.
const LOGIN_ARGS = ["--tray"];
const loginOn = (args) => { try { return !!app.getLoginItemSettings({ path: _selfExe, args }).openAtLogin; } catch { return false; } };
ipcMain.handle("get-login-item", () => loginOn(LOGIN_ARGS) || loginOn([]));
ipcMain.handle("set-login-item", (_e, on) => {
  try {
    app.setLoginItemSettings({ openAtLogin: false, path: _selfExe });
    app.setLoginItemSettings({ openAtLogin: !!on, path: _selfExe, args: LOGIN_ARGS });
    return true;
  } catch { return false; }
});
let _powerBlock = null;   // keeps the host's display awake during a session (Settings → "Cegah layar mati")
ipcMain.on("power-save", (_e, on) => {
  try {
    if (on && _powerBlock == null) _powerBlock = powerSaveBlocker.start("prevent-display-sleep");
    else if (!on && _powerBlock != null) { powerSaveBlocker.stop(_powerBlock); _powerBlock = null; }
  } catch {}
});
ipcMain.on("lock-workstation", () => { try { inputSim.lockWorkStation && inputSim.lockWorkStation(); } catch {} });
ipcMain.handle("set-hw-accel", (_e, on) => {
  try { if (on) { if (fs.existsSync(_userNoGpuFlag)) fs.unlinkSync(_userNoGpuFlag); } else fs.writeFileSync(_userNoGpuFlag, "1"); return true; } catch { return false; }
});
ipcMain.handle("get-hw-accel", () => !_userNoGpu);
// External links only to TryDesk's own sites; everything else in the window stays blocked.
//
// Linux AppImage (owner's report 7 Nov, XFCE: "Failed to execute default Web Browser. Input/output error." on the
// update notice's Download): the AppImage launcher (electron-builder's AppRun) prepends TryDesk's own folders to
// LD_LIBRARY_PATH, XDG_DATA_DIRS, PATH and GSETTINGS_SCHEMA_DIR. shell.openExternal hands the link to xdg-open, the
// browser inherits those variables, loads TryDesk's bundled old libraries / missing schemas and fails to start. So on
// Linux the browser is started by us with the AppImage additions removed, trying the common openers in turn; if none
// starts, the user gets the address with a Copy button instead of a dead button. Windows and macOS keep openExternal.
function linuxCleanEnv() {
  const env = { ...process.env };
  const appdir = env.APPDIR;
  if (appdir) {
    const strip = (v) => String(v || "").split(":").filter((p) => p && !p.startsWith(appdir)).join(":");
    for (const k of ["LD_LIBRARY_PATH", "LD_PRELOAD", "XDG_DATA_DIRS", "PATH", "GSETTINGS_SCHEMA_DIR", "GIO_MODULE_DIR", "GDK_PIXBUF_MODULE_FILE", "GTK_PATH", "QT_PLUGIN_PATH", "PYTHONPATH"]) {
      if (!(k in env)) continue;
      const v = strip(env[k]);
      if (v) env[k] = v; else delete env[k];
    }
    for (const k of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete env[k];
  }
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return env;
}
// Starts one opener. Resolves true when it exits with 0, or is still running after 4 s (a browser started directly
// stays open); false when it is missing or exits with an error.
function linuxTry(cmd, args, env) {
  return new Promise((resolve) => {
    let done = false;
    const end = (ok) => { if (!done) { done = true; resolve(ok); } };
    let p;
    try { p = require("child_process").spawn(cmd, args, { env, detached: true, stdio: "ignore" }); } catch { return end(false); }
    p.on("error", () => end(false));
    p.on("exit", (code) => end(code === 0));
    setTimeout(() => { try { p.unref(); } catch {} end(true); }, 4000);
  });
}
async function linuxOpenUrl(url) {
  const env = linuxCleanEnv();
  const tries = [["xdg-open", [url]], ["gio", ["open", url]], ["sensible-browser", [url]], ["x-www-browser", [url]],
    ["firefox", [url]], ["chromium", [url]], ["chromium-browser", [url]], ["google-chrome", [url]], ["brave-browser", [url]]];
  for (const [cmd, args] of tries) if (await linuxTry(cmd, args, env)) return true;
  return false;
}
async function openLink(url) {
  let ok;
  if (process.platform === "linux") ok = await linuxOpenUrl(url);
  else ok = await shell.openExternal(url).then(() => true, () => false);
  if (ok) return true;
  try {
    const r = await dialog.showMessageBox(mainWindow, {
      type: "info", noLink: true, defaultId: 0, cancelId: 1,
      buttons: [L("Salin tautan", "Copy link"), L("Tutup", "Close")],
      title: "TryDesk",
      message: L("Browser tidak bisa dibuka dari TryDesk.", "TryDesk couldn't open your browser."),
      detail: L("Buka alamat ini di browser Anda:\n", "Open this address in your browser:\n") + url,
    });
    if (r.response === 0) clipboard.writeText(url);
  } catch {}
  return false;
}
ipcMain.on("open-external", (_e, href) => {
  try {
    const u = new URL(String(href));
    if (u.protocol === "https:" && /^(trydesk\.ai\.id|www\.trydesk\.ai\.id|github\.com)$/.test(u.hostname)) openLink(u.href);
  } catch {}
});
ipcMain.on("set-discord-enabled", (_e, on) => { try { discordRPC.setEnabled(!!on); } catch {} });
// Native confirm for destructive actions (e.g. Regenerate ID). Returns true only if the user picks OK.
ipcMain.handle("confirm-dialog", async (_e, opts) => {
  opts = opts || {};
  try {
    const r = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [opts.cancelLabel || L("Batal", "Cancel"), opts.okLabel || "OK"],
      defaultId: 1, cancelId: 0, noLink: true,
      title: opts.title || L("Konfirmasi", "Confirm"),
      message: opts.message || "",
      detail: opts.detail || "",
    });
    return r.response === 1;
  } catch { return false; }
});



let _lastMonitorMap = "";
ipcMain.handle("get-monitors", async () => {
  // Enumerate by OS DISPLAY, screen.getAllDisplays() is the authoritative monitor count/geometry,
  // so every physical monitor is always listed even when desktopCapturer.getSources() under-reports
  // (some Windows GPU/driver setups return fewer "screen" sources than there are displays).
  // Each display gets its own capture id: the exact source matched by display_id when present,
  // otherwise the next unused source positionally, and as a last resort the synthesized Windows
  // source id "screen:<i>:0" (confirmed format) so even an unreported monitor stays capturable.
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  if (!displays.length) {
    // No display info at all, fall back to whatever sources exist (or a single synthesized one).
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
  if (!_wgcOn && _wgcFlag && !_rdpSession && sources.length < displays.length) { try { fs.writeFileSync(_wgcFlag, "1"); } catch {} }
  // Log the display↔source mapping when it changes, the first thing to read when a monitor won't switch.
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

// ─── Fast capture path (Windows, host side): src/native/trydesk-capture.exe ───
// Chromium's screen capture tops out near 60 frames a second and adds ~35 ms (measured 2026-11-02); this helper
// captures with DXGI and encodes on the GPU (up to 240 fps, ~2.5 ms from capture to here). It runs as its own process,
// so a driver problem there never takes TryDesk down; when it is missing or exits, the session stays on WebRTC
// capture. Packets go to the renderer as they arrive; the renderer sends them to the viewer.
const _fastExe = path.join(__dirname, "native", "trydesk-capture.exe").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
let _fast = null;   // host end: { proc }
let _fastRecv = null;   // viewer end of the UDP link (the same exe with --recv): { proc }
function fastAvailable() { return process.platform === "win32" && !_forceNoGpu && fs.existsSync(_fastExe); }
function stopHelper(ref) {
  const h = ref(); if (!h) return;
  const p = h.proc; h.proc = null;
  try { p.stdin.write('{"cmd":"stop"}\n'); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 1000);
}
function stopFast() { if (_fast) { const h = _fast; _fast = null; stopHelper(() => h); } }
function stopFastRecv() { if (_fastRecv) { const h = _fastRecv; _fastRecv = null; stopHelper(() => h); } }
const fromMain = (e) => mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents;
const udpKeyOk = (k) => typeof k === "string" && /^[0-9a-f]{64}$/i.test(k);
// Addresses the UDP link may be pointed at: this LAN (or a VPN's private range) and this PC itself.
const udpIpOk = (ip) => typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && (lanPrivate(ip) || ip.startsWith("127."));
// The helper's stdout: u32 length, u8 type, u8 flags, u16 0, f64 time, payload. Whole packets only, so a frame of
// 500 KB arriving in 64 KB pipe pieces is joined once, not on every piece (at 1 Gbps that copying added up).
function packetReader(proc, onPacket) {
  let parts = [], have = 0;
  proc.stdout.on("data", (chunk) => {
    parts.push(chunk); have += chunk.length;
    for (;;) {
      if (have < 16) return;
      if (parts.length > 1) { parts = [Buffer.concat(parts)]; }
      const buf = parts[0];
      const len = buf.readUInt32LE(0);
      if (len > 64 * 1024 * 1024) { try { proc.kill(); } catch {} return; }   // not our helper talking
      if (have < 16 + len) return;
      onPacket(buf[4], buf[5], buf.readDoubleLE(8), buf.subarray(16, 16 + len));
      const rest = buf.subarray(16 + len); parts = rest.length ? [rest] : []; have = rest.length;
    }
  });
}
ipcMain.handle("fast-capture-available", () => fastAvailable());
ipcMain.handle("fast-capture-start", (e, opts) => {
  if (!fromMain(e) || !fastAvailable()) return { ok: false };
  stopFast();
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(opts && opts.displayId)) || screen.getPrimaryDisplay();
  // DXGI works in physical pixels; Electron's display bounds are DIP.
  const r = process.platform === "win32" ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
  const fps = Math.max(1, Math.min(240, Math.round(Number(opts && opts.fps) || 60)));
  const mbps = Math.max(1, Math.min(1000, Math.round(Number(opts && opts.mbps) || 50)));
  const udp = udpKeyOk(opts && opts.udp) ? opts.udp : null;   // session key for the UDP link, handed to the helper on stdin (never on the command line)
  let proc;
  try { proc = require("child_process").spawn(_fastExe, ["--rect", `${r.x},${r.y},${r.width},${r.height}`, "--fps", String(fps), "--mbps", String(mbps), ...(udp ? ["--udp"] : [])], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
  catch (err) { logInfo("fast capture spawn failed: " + err.message); return { ok: false }; }
  const me = { proc };
  _fast = me;
  const send = (ch, payload) => { if (_fast === me && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); };
  packetReader(proc, (type, flags, t, payload) => {
    if (type === 1) send("fast-capture-packet", { key: !!(flags & 1), t, data: new Uint8Array(payload) });
    else if (type === 2) { const s = payload.toString("utf8"); logInfo("fast capture " + s); send("fast-capture-info", s); }
  });
  proc.on("exit", (code) => { logInfo(`fast capture exited ${code}`); send("fast-capture-ended", { code }); if (_fast === me) _fast = null; });
  proc.on("error", (err) => { logInfo("fast capture error: " + err.message); send("fast-capture-ended", { code: -1 }); if (_fast === me) _fast = null; });
  if (udp) { try { proc.stdin.write(JSON.stringify({ cmd: "udpkey", hex: udp }) + "\n"); } catch {} }
  logInfo(`fast capture start ${r.width}x${r.height}@${r.x},${r.y} fps=${fps} mbps=${mbps}${udp ? " udp" : ""}`);
  return { ok: true, ips: udp ? lanAddrs() : [] };
});
// Only the commands the helper knows, with clamped numbers and checked addresses.
ipcMain.on("fast-capture-cmd", (e, cmd) => {
  if (!fromMain(e) || !_fast || !_fast.proc || !cmd) return;
  let line = null;
  if (cmd.cmd === "key") line = '{"cmd":"key"}';
  else if (cmd.cmd === "rate") line = JSON.stringify({ cmd: "rate", mbps: Math.max(1, Math.min(1000, Math.round(Number(cmd.mbps) || 50))), fps: Math.max(1, Math.min(240, Math.round(Number(cmd.fps) || 60))) });
  else if (cmd.cmd === "peer") { const port = Math.round(Number(cmd.port)); if (udpIpOk(cmd.ip) && port > 0 && port < 65536) line = JSON.stringify({ cmd: "peer", ip: cmd.ip, port }); }
  else if (cmd.cmd === "udp") line = JSON.stringify({ cmd: "udp", on: cmd.on ? 1 : 0 });
  if (line) { try { _fast.proc.stdin.write(line + "\n"); } catch {} }
});
ipcMain.on("fast-capture-stop", (e) => { if (fromMain(e)) stopFast(); });
// Viewer end of the UDP link: the host told us its key, port and LAN addresses; our receiver sends hellos there and
// hands whole frames to the renderer. Returns our own port and addresses so the host can send hellos back too.
ipcMain.handle("fast-udp-recv-start", (e, opts) => {
  if (!fromMain(e) || !fastAvailable() || !opts || !udpKeyOk(opts.key)) return { ok: false };
  stopFastRecv();
  const port = Math.round(Number(opts.port)); if (!(port > 0 && port < 65536)) return { ok: false };
  const ips = (Array.isArray(opts.ips) ? opts.ips : []).filter(udpIpOk).slice(0, 8);
  if (!ips.length) return { ok: false };
  let proc;
  try { proc = require("child_process").spawn(_fastExe, ["--recv", "--port", "0"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
  catch (err) { logInfo("fast udp recv spawn failed: " + err.message); return { ok: false }; }
  const me = { proc };
  _fastRecv = me;
  const send = (ch, payload) => { if (_fastRecv === me && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); };
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    packetReader(proc, (type, flags, t, payload) => {
      if (type === 1) send("fast-udp-packet", { key: !!(flags & 1), gap: !!(flags & 2), t, data: new Uint8Array(payload) });
      else if (type === 2) {
        const s = payload.toString("utf8"); logInfo("fast udp recv " + s); send("fast-udp-info", s);
        let j = null; try { j = JSON.parse(s); } catch {}
        if (j && j.udpPort > 0) {
          try { proc.stdin.write(JSON.stringify({ cmd: "udpkey", hex: opts.key }) + "\n"); for (const ip of ips) proc.stdin.write(JSON.stringify({ cmd: "peer", ip, port }) + "\n"); } catch {}
          done({ ok: true, port: j.udpPort, ips: lanAddrs() });
        }
      }
    });
    proc.on("exit", (code) => { logInfo(`fast udp recv exited ${code}`); send("fast-udp-ended", { code }); if (_fastRecv === me) _fastRecv = null; done({ ok: false }); });
    proc.on("error", (err) => { logInfo("fast udp recv error: " + err.message); send("fast-udp-ended", { code: -1 }); if (_fastRecv === me) _fastRecv = null; done({ ok: false }); });
    setTimeout(() => done({ ok: false }), 5000);
  });
});
ipcMain.on("fast-udp-recv-stop", (e) => { if (fromMain(e)) stopFastRecv(); });
app.on("will-quit", () => { stopFast(); stopFastRecv(); });

let captureDisplay = null;
ipcMain.on("set-capture-display", (_e, d) => { captureDisplay = d; });
// Which screen getDisplayMedia should feed (monitor select). Awaitable so the renderer sets it BEFORE
// calling getDisplayMedia, avoids a race where the handler picks the wrong/first screen.
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

// pin = true: an incoming-connection request. Windows won't let an app take the foreground on its own, so the window
// went up BEHIND whatever was open and the request ran out unseen ("Tidak ada jawaban", rented PC 2026-11-02): keep
// it on top and flash the taskbar button until the request is answered (pin = false).
ipcMain.on("focus-window", (_e, pin) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
  if (pin === true) { try { mainWindow.setAlwaysOnTop(true, "floating"); mainWindow.moveTop(); mainWindow.flashFrame(true); } catch {} }
  else if (pin === false) { try { mainWindow.setAlwaysOnTop(false); mainWindow.flashFrame(false); } catch {} }
});
ipcMain.on("minimize-window", () => mainWindow?.minimize());
ipcMain.on("maximize-window", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on("close-window", () => { _quitting = true; mainWindow?.close(); });

ipcMain.on("execute-input", (_e, event) => {
  if (!inputReady || !event) return;
  try {
    switch (event.action) {
      case "mousemove": {
        // Viewer sends coordinates normalized to 0..1 of the captured monitor
        let d = captureDisplay;
        if (!d) { const p = screen.getPrimaryDisplay(); d = { boundsX: 0, boundsY: 0, width: p.size.width, height: p.size.height, scaleFactor: p.scaleFactor }; }
        // Clamp just inside the monitor so the far edge doesn't resolve to the neighbouring display.
        const nx = Math.min(Math.max(Number(event.x) || 0, 0), 0.9999), ny = Math.min(Math.max(Number(event.y) || 0, 0), 0.9999);
        const dip = { x: d.boundsX + nx * d.width, y: d.boundsY + ny * d.height };
        // DIP → physical pixels. Multiplying by ONE display's scale is only right when every monitor shares
        // it; with mixed DPI (e.g. 4K@200% next to 1080p@100%) clicks landed on the wrong monitor.
        // dipToScreenPoint (Windows) resolves the point against the display it actually lies on.
        const p = screen.dipToScreenPoint ? screen.dipToScreenPoint(dip) : { x: dip.x * d.scaleFactor, y: dip.y * d.scaleFactor };
        inputSim.moveMouse(p.x, p.y);
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
      case "type": inputSim.typeText(event.text); break;   // phone viewer's on-screen keyboard
    }
  } catch (err) {
    console.error("Input execution error:", err.message);
  }
});

// Session ended or the link dropped: let go of every key/button the remote still holds on this PC.
ipcMain.on("release-remote-input", () => { if (inputReady) { try { inputSim.releaseAll(); } catch {} } });

// ─── Clipboard ────────────────────────────────────────────
ipcMain.handle("clipboard-read", () => clipboard.readText());
// Electron 44+ made clipboard read/write async (Promise); returning it works on both old and new.
ipcMain.handle("clipboard-write", (_e, text) => clipboard.writeText(String(text ?? "")));

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

// Every file handle below answers TryDesk's own window only (as the fast-capture handlers do).
ipcMain.handle("file-open-read", (e, filePath) => {
  if (!fromMain(e)) throw new Error("not allowed");
  const id = `r${++handleSeq}`;
  const fd = fs.openSync(cleanPath(filePath), "r");
  readHandles.set(id, { fd, size: fs.fstatSync(fd).size });
  return id;
});

ipcMain.handle("file-read-chunk", (e, { id, length }) => {
  const h = fromMain(e) ? readHandles.get(id) : null;
  if (!h) return null;
  const len = Math.max(1, Math.min(Number(length) || 0, 1024 * 1024));   // never allocate what the caller asks blindly
  const buf = Buffer.alloc(len);
  const n = fs.readSync(h.fd, buf, 0, len, null);
  if (n <= 0) return { done: true, chunk: new Uint8Array(0) };
  return { done: false, chunk: new Uint8Array(buf.buffer, buf.byteOffset, n) };
});

ipcMain.handle("file-close-read", (e, id) => {
  const h = fromMain(e) ? readHandles.get(id) : null;
  if (h) { try { fs.closeSync(h.fd); } catch {} readHandles.delete(id); }
});

ipcMain.handle("file-open-write", (e, filePath) => {
  if (!fromMain(e)) throw new Error("not allowed");
  const id = `w${++handleSeq}`;
  const p = cleanPath(filePath);
  writeHandles.set(id, { fd: fs.openSync(p, "w"), path: p });
  return id;
});

// Open a write handle targeting a directory + name (used by the file manager).
// Returns the resolved path, de-duplicated so an incoming file never silently clobbers an existing one.
ipcMain.handle("file-open-write-in", (e, { dir, name }) => {
  if (!fromMain(e)) throw new Error("not allowed");
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
  writeHandles.set(id, { fd: fs.openSync(target, "w"), path: target });
  return { id, path: target };
});

ipcMain.handle("file-write-chunk", (e, { id, chunk }) => {
  const h = fromMain(e) ? writeHandles.get(id) : null;
  if (!h) return false;
  const buf = Buffer.from(chunk);
  fs.writeSync(h.fd, buf, 0, buf.length, null);
  return true;
});

// Deleting a cancelled partial file only ever touches the file THIS handle created, never a path the caller names.
ipcMain.handle("file-close-write", (e, { id, deleteFile }) => {
  const h = fromMain(e) ? writeHandles.get(id) : null;
  if (!h) return;
  try { fs.closeSync(h.fd); } catch {}
  writeHandles.delete(id);
  if (deleteFile && h.path) { try { fs.unlinkSync(h.path); } catch {} return; }
  // Mark a successfully received file as coming from the Internet (Zone 3) so Windows SmartScreen and
  // Office Protected View still warn before it is run/opened, a file pushed over TryDesk is untrusted.
  if (h.path && process.platform === "win32") {
    try { fs.writeFileSync(`${h.path}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n"); } catch {}
  }
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
    const entries = [{ name: `Home, ${path.basename(home) || home}`, path: home, isDir: true, size: 0, mtime: 0, kind: "home" }];
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

ipcMain.handle("fs-home", (e) => (fromMain(e) ? os.homedir() : ""));
ipcMain.handle("fs-list", (e, dirPath) => (fromMain(e) ? listDirectory(dirPath) : { ok: false, error: "not allowed", path: "", display: "" }));

// ─── Black screen (privacy mode) ─────────────────────────
const WDA_EXCLUDEFROMCAPTURE = 0x11;

// One cover per display, excluded from capture before it turns opaque (see below). Returns null (and covers nothing)
// when Windows refuses the exclusion: koffi missing, or Windows 10 before 2004, where the flag means "black in
// captures". The viewer would then see a black screen, so the host must say "failed" instead of pretending.
function buildBlackScreenWindow(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
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
  // Click-through: the remote's injected clicks and wheel must reach the apps under the dark cover.
  try { win.setIgnoreMouseEvents(true); } catch {}
  win.loadURL("data:text/html,<body style=\"background:#000;margin:0;cursor:none;overflow:hidden\"><div style=\"display:flex;align-items:center;justify-content:center;height:100vh;color:%23333;font-family:sans-serif;font-size:14px\">" + L("TryDesk - Layar digelapkan", "TryDesk - Screen darkened") + "</div></body>");
  // The exclusion only sticks on a shown window (set before the first show, Windows reports success and the cover
  // still appears in captures: the viewer got a black picture). So: show it fully transparent, exclude it, and only
  // then make it opaque. Neither the viewer nor the person at the PC sees an in-between frame.
  win.setOpacity(0);
  win.showInactive();
  let excluded = false;
  try {
    const hwnd = win.getNativeWindowHandle().readUInt32LE(0);
    excluded = !!inputSim.setWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
  } catch (e) { logInfo("black screen: SetWindowDisplayAffinity threw " + e.message); }
  if (!excluded) { try { win.destroy(); } catch {} return null; }
  win.setOpacity(1);
  // Windows clamps a new window to the size limits of the display it starts on, so a portrait monitor's
  // overlay came out 1080x1080 and left the lower part of the screen visible. Re-apply the exact bounds now
  // that the window sits on its own display.
  try { win.setBounds(display.bounds); } catch {}
  win._tdDisplay = display.id;
  return win;
}

let blackScreenTick = null;
function enableBlackScreen() {
  // Already dark: keep the same covers (closing and re-opening them showed the desktop for a moment).
  if (blackScreenWindows.length) { syncBlackScreen(); return true; }
  // Before Windows 10 2004 (build 19041) the exclude flag silently acts as "show black in captures" instead.
  const build = Number(String(os.release()).split(".")[2] || 0);
  if (process.platform === "win32" && build && build < 19041) { logInfo("black screen: Windows build " + build + " cannot exclude windows from capture"); return false; }
  for (const display of screen.getAllDisplays()) {
    const win = buildBlackScreenWindow(display);
    if (!win) { disableBlackScreen(); logInfo("black screen: capture exclusion refused, not darkening"); return false; }
    blackScreenWindows.push(win);
  }
  // Keep the covers on top and on their displays: a window raised later (Task Manager "always on top", TryDesk's
  // own pinned window) would otherwise sit above them, and mixed-DPI monitors can resize a cover after it opens.
  // The raise itself never moves or resizes a cover (SetWindowPos with NOMOVE | NOSIZE, input-simulator.js).
  clearInterval(blackScreenTick);
  blackScreenTick = setInterval(syncBlackScreen, 1000);
  return true;
}

// Display added, removed, resized, rotated or rescaled while dark: the new area must be covered too.
function syncBlackScreen() {
  if (!blackScreenWindows.length) return;
  const displays = screen.getAllDisplays();
  const live = blackScreenWindows.filter((w) => !w.isDestroyed());
  const byId = new Map(live.map((w) => [w._tdDisplay, w]));
  const keep = [];
  for (const d of displays) {
    let w = byId.get(d.id);
    if (w) byId.delete(d.id);
    else {
      w = buildBlackScreenWindow(d);
      if (!w) {
        // A display we can't cover without blacking out the viewer's picture: half a dark screen is no privacy, so
        // all covers go and the viewer is told it failed (the renderer turns this into privacy-result "failed").
        logInfo("black screen: new display could not be excluded from capture, lifting all covers");
        for (const x of keep.concat([...byId.values()])) { try { x.destroy(); } catch {} }
        blackScreenWindows = [];
        disableBlackScreen();
        try { mainWindow && mainWindow.webContents.send("privacy-released", "failed"); } catch {}
        return;
      }
    }
    const b = w.getBounds();
    if (b.x !== d.bounds.x || b.y !== d.bounds.y || b.width !== d.bounds.width || b.height !== d.bounds.height) { try { w.setBounds(d.bounds); } catch {} }
    try { inputSim.raiseTopmost(w.getNativeWindowHandle().readUInt32LE(0)); } catch {}
    keep.push(w);
  }
  for (const w of byId.values()) { try { w.destroy(); } catch {} }   // its display is gone
  blackScreenWindows = keep;
}

function disableBlackScreen() {
  clearInterval(blackScreenTick); blackScreenTick = null;
  for (const w of blackScreenWindows) { try { w.destroy(); } catch {} }
  blackScreenWindows = [];
}

const PANIC_KEY = "Ctrl+Alt+Shift+Escape";
let panicKeyYielded = false;
function ensurePanicKey() {
  if (panicKeyYielded) return;
  try {
    if (globalShortcut.isRegistered(PANIC_KEY)) return;
    const ok = globalShortcut.register(PANIC_KEY, () => {
      logInfo("panic key: releasing black screen and input lock");
      disableBlackScreen(); disableInputLock();
      try { mainWindow && mainWindow.webContents.send("privacy-released"); } catch {}
    });
    if (!ok && _serviceHost) return;   // the user's app still holds it; retried
    logInfo("panic key " + PANIC_KEY + (ok ? " registered" : " NOT registered (another program holds it)"));
  } catch {}
}
ipcMain.on("panic-key-yield", (_e, yieldIt) => {
  if (_serviceHost) return;
  panicKeyYielded = !!yieldIt;
  try { if (panicKeyYielded) globalShortcut.unregister(PANIC_KEY); else ensurePanicKey(); } catch {}
});

ipcMain.handle("enable-black-screen", () => ({ ok: enableBlackScreen() }));
ipcMain.handle("disable-black-screen", () => { disableBlackScreen(); return true; });

// ─── Lock host input ──────────────────────────────────────
let inputLockActive = false;

// Returns whether the lock really took: Win32 BlockInput fails without administrator rights, and the viewer
// must not be told the host is locked when it isn't.
function enableInputLock() {
  if (inputLockActive) return true;
  inputLockActive = !!inputSim.blockInput(true);
  return inputLockActive;
}

function disableInputLock() {
  // Always attempt to unblock, even if the flag drifted, so input can never stay stuck.
  inputLockActive = false;
  try { inputSim.blockInput(false); } catch {}
}

ipcMain.handle("enable-input-lock", () => enableInputLock());
ipcMain.handle("disable-input-lock", () => { disableInputLock(); return true; });

// ─── The service's host runs as SYSTEM, and its window sits on the user's desktop ───
// Anything there that opens a file dialog, a browser or a file by path would hand SYSTEM to whoever sits at the PC
// (a Save dialog can start any program; a link opens a browser as SYSTEM), and file transfer would read or write
// any file on the PC. All of that is switched off here, after every handler above is registered.
if (_serviceHost) {
  const DENY_HANDLE = ["file-pick", "file-save-dialog", "file-open-read", "file-read-chunk", "file-close-read", "file-open-write",
    "file-open-write-in", "file-write-chunk", "file-close-write", "fs-home", "fs-list", "relaunch-as-admin", "set-login-item",
    "set-hw-accel", "check-update", "lan-host", "lan-open"];
  for (const ch of DENY_HANDLE) { ipcMain.removeHandler(ch); ipcMain.handle(ch, () => { throw new Error("not available in the TryDesk service"); }); }
  for (const ch of ["open-external", "lock-workstation", "set-discord-enabled", "discord-activity"]) ipcMain.removeAllListeners(ch);
  // Hidden again once nothing needs it (no request waiting, no session).
  ipcMain.on("service-hide-window", () => { try { mainWindow && mainWindow.setAlwaysOnTop(false); mainWindow && mainWindow.hide(); } catch {} });
  ipcMain.on("service-show-window", () => { try { if (mainWindow && !mainWindow.isVisible()) mainWindow.showInactive(); } catch {} });
}

app.on("will-quit", () => { disableBlackScreen(); disableInputLock(); });
