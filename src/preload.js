const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  confirm: (opts) => ipcRenderer.invoke("confirm-dialog", opts),
  isElevated: () => ipcRenderer.invoke("is-elevated"),
  relaunchAsAdmin: () => ipcRenderer.invoke("relaunch-as-admin"),
  onElevatedRelaunchBlocked: (cb) => ipcRenderer.on("elevated-relaunch-blocked", () => cb()),
  // Windows service (unattended access)
  serviceStatus: () => ipcRenderer.invoke("service-status"),
  serviceInstall: (hash) => ipcRenderer.invoke("service-install", String(hash || "")),
  serviceUninstall: () => ipcRenderer.invoke("service-uninstall"),
  setServiceId: (id) => ipcRenderer.send("service-id", String(id || "")),
  serviceAttachConsole: () => ipcRenderer.invoke("service-attach-console"),
  serviceHideWindow: () => ipcRenderer.send("service-hide-window"),
  serviceShowWindow: () => ipcRenderer.send("service-show-window"),
  serviceUserIdentity: () => ipcRenderer.invoke("service-user-identity"),
  serviceSetPassword: (hash) => ipcRenderer.invoke("service-set-password", String(hash || "")),
  exportIdentity: (id, token) => ipcRenderer.send("export-identity", { id: String(id || ""), token: String(token || "") }),
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
  onPrivacyReleased: (cb) => ipcRenderer.on("privacy-released", (_e, why) => cb(why === "failed" ? "failed" : "")),
  setDisplayMediaSource: (id, displayId) => ipcRenderer.invoke("set-dm-source", id, displayId),
  // Fast capture path (Windows host): native capture + GPU encode in a helper process; H.264 frames come back here.
  fastCaptureAvailable: () => ipcRenderer.invoke("fast-capture-available"),
  fastCaptureStart: (opts) => ipcRenderer.invoke("fast-capture-start", { displayId: String(opts?.displayId || ""), fps: Number(opts?.fps) || 60, mbps: Number(opts?.mbps) || 50, udp: opts?.udp ? String(opts.udp) : "" }),
  fastCaptureCmd: (cmd) => ipcRenderer.send("fast-capture-cmd", { cmd: String(cmd?.cmd || ""), mbps: Number(cmd?.mbps) || 0, fps: Number(cmd?.fps) || 0, ip: String(cmd?.ip || ""), port: Number(cmd?.port) || 0, on: !!cmd?.on }),
  fastCaptureStop: () => ipcRenderer.send("fast-capture-stop"),
  onFastCapturePacket: (cb) => ipcRenderer.on("fast-capture-packet", (_e, p) => cb(p)),
  onFastCaptureInfo: (cb) => ipcRenderer.on("fast-capture-info", (_e, s) => cb(String(s))),
  onFastCaptureEnded: (cb) => ipcRenderer.on("fast-capture-ended", (_e, d) => cb(d)),
  // Viewer end of the fast path's UDP link (Windows): frames arrive whole from the receiver helper.
  fastUdpRecvStart: (opts) => ipcRenderer.invoke("fast-udp-recv-start", { key: String(opts?.key || ""), port: Number(opts?.port) || 0, ips: Array.isArray(opts?.ips) ? opts.ips.map(String).slice(0, 8) : [] }),
  fastUdpRecvStop: () => ipcRenderer.send("fast-udp-recv-stop"),
  onFastUdpPacket: (cb) => ipcRenderer.on("fast-udp-packet", (_e, p) => cb(p)),
  onFastUdpInfo: (cb) => ipcRenderer.on("fast-udp-info", (_e, s) => cb(String(s))),
  onFastUdpEnded: (cb) => ipcRenderer.on("fast-udp-ended", (_e, d) => cb(d)),
  setCaptureDisplay: (d) => ipcRenderer.send("set-capture-display", d),
  executeInput: (event) => ipcRenderer.send("execute-input", event),
  releaseRemoteInput: () => ipcRenderer.send("release-remote-input"),
  focusWindow: (pin) => ipcRenderer.send("focus-window", typeof pin === "boolean" ? pin : null),
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
  fileCloseWrite: (id, deleteFile) => ipcRenderer.invoke("file-close-write", { id, deleteFile }),

  fsHome: () => ipcRenderer.invoke("fs-home"),
  fsList: (p) => ipcRenderer.invoke("fs-list", p),

  onDisplayChanged: (cb) => ipcRenderer.on("display-changed", (_e, force) => cb(!!force)),
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
  panicKeyYield: (yieldIt) => ipcRenderer.send("panic-key-yield", !!yieldIt),
  enableInputLock: () => ipcRenderer.invoke("enable-input-lock"),
  disableInputLock: () => ipcRenderer.invoke("disable-input-lock"),
});
