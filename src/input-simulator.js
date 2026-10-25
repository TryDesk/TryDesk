let SetCursorPos, mouse_event, keybd_event, MapVirtualKeyW, _SetWindowDisplayAffinity, _BlockInput, GetCursorInfo;
let IsUserAnAdmin;   // shell32 — true when the host process is elevated (can inject input into admin/UAC windows)
// Low-level keyboard + mouse hooks (so system shortcuts reach the remote even outside fullscreen, and so
// games get true relative mouse motion without the browser's pointer-lock gesture).
let _koffi, _HookProc, _KBD, _MSLL, SetWindowsHookExW, UnhookWindowsHookEx, CallNextHookEx, GetModuleHandleW;

const MOUSE_FLAGS = {
  left: [0x0002, 0x0004],
  right: [0x0008, 0x0010],
  middle: [0x0020, 0x0040],
};
const MOUSEEVENTF_MOVE = 0x0001;   // relative motion — what raw-input/pointer-locked games read
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x01000;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;

// Keys that must be sent with the extended flag or Windows treats them as numpad keys
const EXTENDED_VK = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90]);

function init() {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    SetCursorPos = user32.func("bool SetCursorPos(int x, int y)");
    // dx/dy are signed (int32) so relative moves can be negative (left/up).
    mouse_event = user32.func("void mouse_event(uint32_t dwFlags, int32_t dx, int32_t dy, int32_t dwData, uintptr_t dwExtraInfo)");
    keybd_event = user32.func("void keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)");
    MapVirtualKeyW = user32.func("uint32_t MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)");
    _SetWindowDisplayAffinity = user32.func("bool SetWindowDisplayAffinity(uintptr_t hWnd, uint32_t dwAffinity)");
    // Win32 BlockInput takes a BOOL (4-byte int); binding as `int` avoids a width mismatch
    // that could leave input permanently blocked when unblocking.
    _BlockInput = user32.func("int BlockInput(int fBlockIt)");
    // Detect when a game/app has captured (hidden) the OS cursor, so the viewer can switch to
    // relative-mouse mode automatically. Isolated so a koffi/struct hiccup never disables core input.
    try {
      koffi.struct("CURSORINFO", { cbSize: "uint32", flags: "uint32", hCursor: "uintptr", ptX: "int32", ptY: "int32" });
      GetCursorInfo = user32.func("bool GetCursorInfo(_Inout_ CURSORINFO *pci)");
    } catch (e) { console.warn("GetCursorInfo unavailable:", e.message); GetCursorInfo = null; }
    // Elevation check — a non-elevated host can't inject input into elevated windows (admin CMD, UAC prompt):
    // UIPI silently drops it, so the remote "freezes" (video keeps working, control stops). Lets the UI offer
    // "run as administrator" so the user can control those windows too.
    try { const shell32 = koffi.load("shell32.dll"); IsUserAnAdmin = shell32.func("bool IsUserAnAdmin()"); }
    catch (e) { console.warn("IsUserAnAdmin unavailable:", e.message); IsUserAnAdmin = null; }
    // Low-level keyboard hook — lets the viewer capture + forward system shortcuts (Alt+Tab, Win,
    // Alt+Esc, Ctrl+Esc) to the remote even when NOT fullscreen (the browser's keyboard.lock is
    // fullscreen-only). Isolated so a koffi hiccup never disables core input.
    try {
      _koffi = koffi;
      const kernel32 = koffi.load("kernel32.dll");
      _KBD = koffi.struct("KBDLLHOOKSTRUCT", { vkCode: "uint32", scanCode: "uint32", flags: "uint32", time: "uint32", dwExtraInfo: "uintptr" });
      _MSLL = koffi.struct("MSLLHOOKSTRUCT", { ptX: "int32", ptY: "int32", mouseData: "int32", flags: "uint32", time: "uint32", dwExtraInfo: "uintptr" });
      _HookProc = koffi.proto("intptr_t __stdcall _TD_HookProc(int nCode, uintptr_t wParam, void *lParam)");
      SetWindowsHookExW = user32.func("intptr_t __stdcall SetWindowsHookExW(int idHook, void *lpfn, intptr_t hmod, uint32_t tid)");
      UnhookWindowsHookEx = user32.func("bool __stdcall UnhookWindowsHookEx(intptr_t hhk)");
      CallNextHookEx = user32.func("intptr_t __stdcall CallNextHookEx(intptr_t hhk, int nCode, uintptr_t wParam, void *lParam)");
      GetModuleHandleW = kernel32.func("intptr_t __stdcall GetModuleHandleW(void *name)");
    } catch (e) { console.warn("keyboard hook unavailable:", e.message); SetWindowsHookExW = null; }
    return true;
  } catch (err) {
    console.error("Failed to init input simulator:", err.message);
    return false;
  }
}

function moveMouse(x, y) {
  SetCursorPos(Math.round(x), Math.round(y));
}

// Relative motion for games that capture the pointer (Minecraft, FPS, etc.). Absolute SetCursorPos
// is ignored by raw-input/DirectInput cameras; an injected relative MOUSEEVENTF_MOVE is not.
function moveMouseRelative(dx, dy) {
  dx = Math.round(dx || 0); dy = Math.round(dy || 0);
  if (dx || dy) mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, 0);
}

function mouseDown(button) {
  mouse_event((MOUSE_FLAGS[button] || MOUSE_FLAGS.left)[0], 0, 0, 0, 0);
}

function mouseUp(button) {
  mouse_event((MOUSE_FLAGS[button] || MOUSE_FLAGS.left)[1], 0, 0, 0, 0);
}

function mouseScroll(deltaX, deltaY) {
  if (deltaY) mouse_event(MOUSEEVENTF_WHEEL, 0, 0, -deltaY * 120, 0);
  if (deltaX) mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, deltaX * 120, 0);
}

function sendKey(vk, up) {
  vk = Number(vk);
  if (!Number.isInteger(vk) || vk <= 0 || vk > 0xFE) return;
  const scan = MapVirtualKeyW(vk, 0) & 0xFF;
  let flags = up ? KEYEVENTF_KEYUP : 0;
  if (EXTENDED_VK.has(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
  keybd_event(vk, scan, flags, 0);
}

const keyDown = (vk) => sendKey(vk, false);
const keyUp = (vk) => sendKey(vk, true);

function setWindowDisplayAffinity(hwnd, affinity) {
  if (_SetWindowDisplayAffinity) return _SetWindowDisplayAffinity(hwnd, affinity);
  return false;
}

function blockInput(block) {
  if (_BlockInput) { try { return _BlockInput(block ? 1 : 0); } catch { return false; } }
  return false;
}

// ─── Low-level keyboard hook ──────────────────────────────
// WH_KEYBOARD_LL=13. While installed, every key goes through onKey(vk, down); returning true SUPPRESSES
// it locally (so Alt+Tab/Win switch the REMOTE, not the local machine) and the caller forwards it.
// Installed only during an active controlling session; the caller only suppresses while focused, so the
// user can always click away to regain their own keyboard.
const WH_KEYBOARD_LL = 13;
let _keyCb = null, _keyHook = 0, _onKey = null;
function startKeyHook(onKey) {
  if (_keyHook) { _onKey = onKey; return true; }
  if (!SetWindowsHookExW) return false;
  _onKey = onKey;
  try {
    _keyCb = _koffi.register((nCode, wParam, lParam) => {
      try {
        if (nCode === 0 && _onKey) {
          const ks = _koffi.decode(lParam, _KBD);
          const down = (wParam === 0x100 || wParam === 0x104);   // WM_KEYDOWN / WM_SYSKEYDOWN
          const up = (wParam === 0x101 || wParam === 0x105);     // WM_KEYUP / WM_SYSKEYUP
          if ((down || up) && _onKey(ks.vkCode, down)) return 1; // 1 = swallow the key locally
        }
      } catch {}
      return CallNextHookEx(0, nCode, wParam, lParam);
    }, _koffi.pointer(_HookProc));
    _keyHook = SetWindowsHookExW(WH_KEYBOARD_LL, _keyCb, GetModuleHandleW(null), 0);
    if (!_keyHook) { try { _koffi.unregister(_keyCb); } catch {} _keyCb = null; return false; }
    return true;
  } catch (e) { console.warn("startKeyHook failed:", e.message); _keyHook = 0; _keyCb = null; return false; }
}
function stopKeyHook() {
  try { if (_keyHook) UnhookWindowsHookEx(_keyHook); } catch {}
  try { if (_keyCb) _koffi.unregister(_keyCb); } catch {}
  _keyHook = 0; _keyCb = null; _onKey = null;
}

// ─── Low-level mouse hook (game mode) ─────────────────────
// WH_MOUSE_LL=14. While a game is detected we capture ALL mouse input natively, compute relative motion by
// re-centering the OS cursor to a fixed point each move (so it never hits a screen edge), forward it, and
// swallow it locally. This gives pointer-capturing games (Minecraft, FPS) proper 360° mouse-look WITHOUT the
// browser's pointer-lock gesture. onMouse({t,dx,dy,b}) forwards; shouldCapture() gates on focus.
const WH_MOUSE_LL = 14;
let _mouseCb = null, _mouseHook = 0, _onMouse = null, _shouldMouse = null, _mcx = 0, _mcy = 0;
function setMouseCenter(x, y) { _mcx = Math.round(x); _mcy = Math.round(y); }
function startMouseHook(onMouse, shouldCapture) {
  if (_mouseHook) { _onMouse = onMouse; _shouldMouse = shouldCapture; return true; }
  if (!SetWindowsHookExW) return false;
  _onMouse = onMouse; _shouldMouse = shouldCapture;
  try {
    _mouseCb = _koffi.register((nCode, wParam, lParam) => {
      try {
        if (nCode === 0 && _onMouse && (!_shouldMouse || _shouldMouse())) {
          const w = wParam;
          const ms = _koffi.decode(lParam, _MSLL);
          if (w === 0x200) {                                   // WM_MOUSEMOVE
            const dx = ms.ptX - _mcx, dy = ms.ptY - _mcy;
            if (dx || dy) { _onMouse({ t: "move", dx, dy }); try { SetCursorPos(_mcx, _mcy); } catch {} }
            return 1;
          }
          if (w === 0x201 || w === 0x204 || w === 0x207) { _onMouse({ t: "down", b: w === 0x201 ? "left" : w === 0x204 ? "right" : "middle" }); return 1; }
          if (w === 0x202 || w === 0x205 || w === 0x208) { _onMouse({ t: "up", b: w === 0x202 ? "left" : w === 0x205 ? "right" : "middle" }); return 1; }
          if (w === 0x20A) { _onMouse({ t: "wheel", d: (ms.mouseData >> 16) }); return 1; }      // WM_MOUSEWHEEL
          if (w === 0x20E) { _onMouse({ t: "hwheel", d: (ms.mouseData >> 16) }); return 1; }     // WM_MOUSEHWHEEL
        }
      } catch {}
      return CallNextHookEx(0, nCode, wParam, lParam);
    }, _koffi.pointer(_HookProc));
    _mouseHook = SetWindowsHookExW(WH_MOUSE_LL, _mouseCb, GetModuleHandleW(null), 0);
    if (!_mouseHook) { try { _koffi.unregister(_mouseCb); } catch {} _mouseCb = null; return false; }
    return true;
  } catch (e) { console.warn("startMouseHook failed:", e.message); _mouseHook = 0; _mouseCb = null; return false; }
}
function stopMouseHook() {
  try { if (_mouseHook) UnhookWindowsHookEx(_mouseHook); } catch {}
  try { if (_mouseCb) _koffi.unregister(_mouseCb); } catch {}
  _mouseHook = 0; _mouseCb = null; _onMouse = null; _shouldMouse = null;
}

// True when the OS cursor is hidden — i.e. a game/app has captured the pointer (reads relative motion).
function isCursorHidden() {
  if (!GetCursorInfo) return false;
  try { const ci = { cbSize: 24, flags: 0, hCursor: 0, ptX: 0, ptY: 0 }; GetCursorInfo(ci); return (ci.flags & 1) === 0; }
  catch { return false; }
}

function isElevated() { try { return IsUserAnAdmin ? !!IsUserAnAdmin() : false; } catch { return false; } }
module.exports = { init, moveMouse, moveMouseRelative, mouseDown, mouseUp, mouseScroll, keyDown, keyUp, setWindowDisplayAffinity, blockInput, isCursorHidden, startKeyHook, stopKeyHook, startMouseHook, stopMouseHook, setMouseCenter, isElevated };
