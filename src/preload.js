const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  confirm: (opts) => ipcRenderer.invoke("confirm-dialog", opts),
  isElevated: () => ipcRenderer.invoke("is-elevated"),
  relaunchAsAdmin: () => ipcRenderer.invoke("relaunch-as-admin"),
  getSources: () => ipcRenderer.invoke("get-sources"),
  getScreenSize: () => ipcRenderer.invoke("get-screen-size"),
  getMonitors: () => ipcRenderer.invoke("get-monitors"),
  setDisplayMediaSource: (id, displayId) => ipcRenderer.invoke("set-dm-source", id, displayId),
  setCaptureDisplay: (d) => ipcRenderer.send("set-capture-display", d),
  executeInput: (event) => ipcRenderer.send("execute-input", event),
  focusWindow: () => ipcRenderer.send("focus-window"),
  minimizeWindow: () => ipcRenderer.send("minimize-window"),
  maximizeWindow: () => ipcRenderer.send("maximize-window"),
  closeWindow: () => ipcRenderer.send("close-window"),

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
  logInfo: (msg) => ipcRenderer.send("log-info", String(msg)),

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

  enableBlackScreen: () => ipcRenderer.invoke("enable-black-screen"),
  disableBlackScreen: () => ipcRenderer.invoke("disable-black-screen"),
  enableInputLock: () => ipcRenderer.invoke("enable-input-lock"),
  disableInputLock: () => ipcRenderer.invoke("disable-input-lock"),
});
