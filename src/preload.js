const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  confirm: (opts) => ipcRenderer.invoke("confirm-dialog", opts),
  isElevated: () => ipcRenderer.invoke("is-elevated"),
  relaunchAsAdmin: () => ipcRenderer.invoke("relaunch-as-admin"),
  onElevatedRelaunchBlocked: (cb) => ipcRenderer.on("elevated-relaunch-blocked", () => cb()),
  getMonitors: () => ipcRenderer.invoke("get-monitors"),
  // Settings that act on the OS
  getLoginItem: () => ipcRenderer.invoke("get-login-item"),
  setLoginItem: (on) => ipcRenderer.invoke("set-login-item", !!on),
  setPowerSave: (on) => ipcRenderer.send("power-save", !!on),
  lockWorkstation: () => ipcRenderer.send("lock-workstation"),
  getHwAccel: () => ipcRenderer.invoke("get-hw-accel"),
  setHwAccel: (on) => ipcRenderer.invoke("set-hw-accel", !!on),
  openExternal: (url) => ipcRenderer.send("open-external", String(url || "")),
  setDiscordEnabled: (on) => ipcRenderer.send("set-discord-enabled", !!on),
  setHostingState: (on) => ipcRenderer.send("hosting-state", !!on),
  onPrivacyReleased: (cb) => ipcRenderer.on("privacy-released", () => cb()),
  setDisplayMediaSource: (id, displayId) => ipcRenderer.invoke("set-dm-source", id, displayId),
  setCaptureDisplay: (d) => ipcRenderer.send("set-capture-display", d),
  executeInput: (event) => ipcRenderer.send("execute-input", event),
  releaseRemoteInput: () => ipcRenderer.send("release-remote-input"),
  focusWindow: () => ipcRenderer.send("focus-window"),
  minimizeWindow: () => ipcRenderer.send("minimize-window"),
  maximizeWindow: () => ipcRenderer.send("maximize-window"),
  closeWindow: () => ipcRenderer.send("close-window"),
  // System tray: hide the window (TryDesk keeps running), quit for real, and keep the tray's ID line current.
  hideToTray: (firstTime) => ipcRenderer.send("hide-to-tray", !!firstTime),
  quitApp: () => ipcRenderer.send("quit-app"),
  setTrayInfo: (info) => ipcRenderer.send("tray-info", { id: String(info?.id || "") }),
  onCloseRequested: (cb) => ipcRenderer.on("close-requested", () => cb()),
  onQuitRequested: (cb) => ipcRenderer.on("quit-requested", () => cb()),

  clipboardRead: () => ipcRenderer.invoke("clipboard-read"),
  clipboardWrite: (text) => ipcRenderer.invoke("clipboard-write", text),

  filePick: () => ipcRenderer.invoke("file-pick"),
  fileSaveDialog: (name) => ipcRenderer.invoke("file-save-dialog", name),
  fileOpenRead: (p) => ipcRenderer.invoke("file-open-read", p),
  fileReadChunk: (id, length) => ipcRenderer.invoke("file-read-chunk", { id, length }),
  fileCloseRead: (id) => ipcRenderer.invoke("file-close-read", id),
  fileOpenWrite: (p) => ipcRenderer.invoke("file-open-write", p),
  fileOpenWriteIn: (dir, name) => ipcRenderer.invoke("file-open-write-in", { dir, name }),
  fileWriteChunk: (id, chunk) => ipcRenderer.invoke("file-write-chunk", { id, chunk }),
  fileCloseWrite: (id, deleteFile, filePath) => ipcRenderer.invoke("file-close-write", { id, deleteFile, filePath }),

  fsHome: () => ipcRenderer.invoke("fs-home"),
  fsList: (p) => ipcRenderer.invoke("fs-list", p),

  onDisplayChanged: (cb) => ipcRenderer.on("display-changed", () => cb()),
  onHostCursorHidden: (cb) => ipcRenderer.on("host-cursor-hidden", (_e, hidden) => cb(hidden)),
  requestCursorState: () => ipcRenderer.send("request-cursor-state"),
  // An admin window (Task Manager, admin CMD) in front of a non-elevated host: input to it is blocked by Windows.
  onHostAdminWindow: (cb) => ipcRenderer.on("host-admin-window", (_e, on) => cb(!!on)),
  requestAdminWindowState: () => ipcRenderer.send("request-admin-window-state"),
  logInfo: (msg) => ipcRenderer.send("log-info", String(msg)),

  // LAN direct connection ("Sambung lewat IP"): main.js moves JSON lines over TCP, app.js speaks the protocol.
  lanHost: (opts) => ipcRenderer.invoke("lan-host", { on: !!opts?.on, machine: String(opts?.machine || "") }),
  lanOpen: (address) => ipcRenderer.invoke("lan-open", String(address || "")),
  lanWrite: (id, msg) => ipcRenderer.send("lan-write", String(id), msg),
  lanClose: (id) => ipcRenderer.send("lan-close", String(id)),
  lanKeep: (id) => ipcRenderer.send("lan-keep", String(id)),
  lanAddrs: () => ipcRenderer.invoke("lan-addrs"),
  onLanEvent: (cb) => ipcRenderer.on("lan-event", (_e, ev) => cb(ev)),

  // Full keyboard capture: the renderer switches it on while actively controlling a remote PC.
  setKeyCapture: (on) => ipcRenderer.send("set-key-capture", !!on),
  onCapturedKey: (cb) => ipcRenderer.on("captured-key", (_e, d) => cb(d)),
  onReleaseKeys: (cb) => ipcRenderer.on("release-keys", () => cb()),
  onReleaseControl: (cb) => ipcRenderer.on("release-control", () => cb()),

  // Native game-mouse capture (relative motion for games, no pointer-lock gesture needed).
  setMouseCapture: (on) => ipcRenderer.send("set-mouse-capture", !!on),
  onCapturedMouse: (cb) => ipcRenderer.on("captured-mouse", (_e, d) => cb(d)),
  onMouseCaptureResult: (cb) => ipcRenderer.on("mouse-capture-result", (_e, d) => cb(d)),

  // Discord Rich Presence: report session state so the user's profile shows what TryDesk is doing.
  setDiscordActivity: (state) => ipcRenderer.send("discord-activity", String(state || "idle")),
  setUiLanguage: (lang) => ipcRenderer.send("set-ui-language", lang === "en" ? "en" : "id"),

  enableBlackScreen: () => ipcRenderer.invoke("enable-black-screen"),
  disableBlackScreen: () => ipcRenderer.invoke("disable-black-screen"),
  enableInputLock: () => ipcRenderer.invoke("enable-input-lock"),
  disableInputLock: () => ipcRenderer.invoke("disable-input-lock"),
});
