// TryDesk for Android — the phone layer on top of the unchanged desktop renderer (loaded AFTER app.js).
// app.js keeps doing signaling, WebRTC, quality, monitors, chat and i18n. This file only:
//   • makes the phone a viewer (incoming requests are refused, host-only UI is hidden),
//   • turns touch into mouse input (touchpad or direct-touch mode, pinch zoom, two-finger scroll / right click),
//   • adds the on-screen keyboard + special-keys bar and a compact floating toolbar,
//   • handles the Android back button, screen wake lock and the phone-sized Control Center.
(() => {
  document.documentElement.classList.add("td-mobile");
  const Cap = window.Capacitor;
  const AppPlugin = Cap && Cap.Plugins && Cap.Plugins.App;
  // Native full screen + landscape during a session (TdScreenPlugin.java). Absent in a browser: calls are no-ops.
  const ScreenPlugin = Cap && (Cap.registerPlugin ? Cap.registerPlugin("TdScreen") : Cap.Plugins && Cap.Plugins.TdScreen);
  const setScreen = (opts) => { try { const p = ScreenPlugin && ScreenPlugin.set(opts); if (p && p.catch) p.catch(() => {}); } catch {} };

  // ── English for the strings this layer adds (the desktop i18n observer translates DOM text) ──
  Object.assign(TEXT_EN, {
    "Online — siap menghubungkan ke PC": "Online — ready to connect to a PC",
    "Keyboard": "Keyboard", "Tombol khusus": "Special keys", "Mode sentuh": "Touch mode", "Menu": "Menu",
    "Mode sentuh: touchpad": "Touch mode: touchpad", "Mode sentuh: sentuh langsung": "Touch mode: direct touch",
    "Touchpad — geser untuk menggerakkan kursor, ketuk untuk klik": "Touchpad — slide to move the cursor, tap to click",
    "Sentuh langsung — ketuk tepat di tempat yang mau diklik": "Direct touch — tap exactly where you want to click",
    "Pas layar (reset zoom)": "Fit screen (reset zoom)", "Sembunyikan toolbar": "Hide toolbar", "Tampilkan toolbar": "Show toolbar",
    "Putar HP ke landscape untuk tampilan lebih besar": "Rotate your phone to landscape for a bigger view",
    "Putar layar": "Rotate screen", "Layar dikunci landscape": "Screen locked to landscape", "Layar mengikuti posisi HP": "Screen follows the phone's position",
    "Putuskan koneksi ke PC ini?": "Disconnect from this PC?",
    "Ketuk = klik · tahan lalu geser = seret · 2 jari = scroll · ketuk 2 jari = klik kanan · cubit = zoom":
      "Tap = click · hold then slide = drag · 2 fingers = scroll · 2-finger tap = right click · pinch = zoom",
    "Hubungkan ke PC Windows yang menjalankan TryDesk": "Connect to a Windows PC running TryDesk",
    "Aplikasi HP ini hanya untuk mengontrol PC. Untuk dikontrol dari jauh, pasang TryDesk di PC Windows.":
      "This phone app only controls PCs. To be controlled remotely, install TryDesk on a Windows PC.",
    "Runtime": "Runtime",
    "Perangkat": "Devices", "Navigasi": "Navigation",
    "Mode game": "Game mode", "Mode game mati": "Game mode off", "Klik kiri": "Left click", "Klik kanan": "Right click",
    "Mode game: geser = arahkan kamera · ketuk = klik · tahan = tahan klik · ketuk 2 jari = klik kanan":
      "Game mode: slide = look around · tap = click · hold = hold click · 2-finger tap = right click",
  });

  // ── Viewer only: a phone never shares its own screen ──
  handleIncoming = async (msg) => {
    sendSignal({ type: "connection-rejected", targetId: msg.fromId, reason: "Perangkat ini adalah TryDesk untuk HP (hanya mengontrol PC) dan tidak bisa dikontrol" });
  };
  const _setStatus = setStatus;
  setStatus = (state, text) => _setStatus(state, text === "Online — siap menerima koneksi" ? "Online — siap menghubungkan ke PC" : text);

  // Pinch zoom replaces the desktop scale presets: the remote always starts fitted to the phone.
  const _prefGet = prefGet;
  prefGet = (name) => (name === "defScale" ? "fit" : _prefGet(name));
  scaleMode = "fit";

  // Requests from the phone say who is asking (the PC shows it in its Accept dialog).
  if (!store.get("deviceAlias")) { store.set("deviceAlias", "TryDesk Android"); const a = $("#device-alias"); if (a) a.value = "TryDesk Android"; }

  // ── Hide what a phone viewer can't do (hosting, OS integration, local files) ──
  const HIDE_GROUPS = ["#setting-notify-incoming", "#setting-discord", "#setting-autoaccept", "#setting-startup", "#setting-close-to-tray",
    "#setting-bw-limit", "#setting-prevent-sleep", "#setting-default-scale", "#setting-hw-accel"];
  for (const sel of HIDE_GROUPS) { const g = $(sel)?.closest(".setting-group"); if (g) g.classList.add("m-hide"); }
  $('.stab[data-tab="tab-security"]')?.classList.add("m-hide");
  $$(".about-row").forEach((r) => { const b = r.querySelector("b"); if (b && /Electron/.test(b.textContent)) b.textContent = "Android WebView + WebRTC"; });
  const note = $(".connect-section");
  if (note) {
    const lead = document.createElement("p"); lead.className = "m-lead"; lead.textContent = "Hubungkan ke PC Windows yang menjalankan TryDesk";
    note.prepend(lead);
    const foot = document.createElement("p"); foot.className = "m-foot"; foot.textContent = "Aplikasi HP ini hanya untuk mengontrol PC. Untuk dikontrol dari jauh, pasang TryDesk di PC Windows.";
    note.append(foot);   // inside the connect card, under the LAN link
    // The version, where people look (the desktop shows it in the bottom bar, which a phone hides).
    const ver = (window.TD_MOBILE && window.TD_MOBILE.version) || "";
    if (ver) { const v = document.createElement("p"); v.className = "m-foot m-ver"; v.textContent = `TryDesk v${ver}`; note.append(v); }
  }
  // Connection state in the top bar (the bottom status bar is hidden on a phone): a short label that follows the
  // status dot, the full message on tap.
  const tbBtns = $(".titlebar-buttons"), sDot = $("#status-dot"), sText = $("#status-text");
  if (tbBtns && sDot && sText) {
    const pill = document.createElement("button"); pill.type = "button"; pill.className = "m-status";
    const dot = document.createElement("span"), lab = document.createElement("span");
    pill.append(dot, lab);
    tbBtns.insertBefore(pill, $("#btn-settings"));
    const sync = () => {
      const c = sDot.className;
      dot.className = c;
      lab.textContent = /\bconnected\b/.test(c) ? "Online" : /\berror\b/.test(c) ? "Offline" : "Menghubungkan";
      pill.title = sText.textContent; pill.setAttribute("aria-label", sText.textContent);
    };
    new MutationObserver(sync).observe(sDot, { attributes: true, attributeFilter: ["class"] });
    new MutationObserver(sync).observe(sText, { childList: true, characterData: true, subtree: true });
    sync();
    pill.addEventListener("click", () => showToast(sText.textContent));
  }
  // ── Floating tab bar at the bottom (iOS-style capsule): Hubungkan / Perangkat / Pengaturan ──
  // The home screen shows one card per tab (connect, or recent + favorite PCs); Pengaturan opens the settings sheet
  // and the bar stays above it, so the other tabs are one tap away. Hidden whenever Home isn't the screen (connecting,
  // a remote session).
  const TAB_ICON = {
    connect: '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
    devices: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  };
  const tabBar = document.createElement("nav");
  tabBar.className = "m-tabbar"; tabBar.setAttribute("aria-label", "Navigasi");
  for (const [key, label] of [["connect", "Hubungkan"], ["devices", "Perangkat"], ["settings", "Pengaturan"]]) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "m-tab"; b.dataset.tab = key;
    b.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TAB_ICON[key]}</svg>`;
    const s = document.createElement("span"); s.textContent = label; b.appendChild(s);
    tabBar.appendChild(b);
  }
  document.body.appendChild(tabBar);
  let homeTabM = store.get("m.tab") === "devices" ? "devices" : "connect";
  const settingsOpen = () => !$("#overlay-settings").classList.contains("hidden");
  function paintTabs() {
    const cur = settingsOpen() ? "settings" : homeTabM;
    tabBar.querySelectorAll(".m-tab").forEach((b) => { const on = b.dataset.tab === cur; b.classList.toggle("active", on); b.setAttribute("aria-current", on ? "page" : "false"); });
    document.documentElement.dataset.mtab = homeTabM;
    tabBar.classList.toggle("hidden", $("#screen-home").classList.contains("hidden"));
  }
  tabBar.addEventListener("click", (e) => {
    const b = e.target.closest(".m-tab"); if (!b) return;
    const key = b.dataset.tab;
    if (key === "settings") { if (!settingsOpen()) toggleSettings(); }
    else {
      if (settingsOpen()) toggleSettings();
      if (homeTabM === key) $(".home")?.scrollTo({ top: 0, behavior: "smooth" });   // tapping the current tab: back to the top
      homeTabM = key; store.set("m.tab", key);
    }
    paintTabs();
  });
  new MutationObserver(paintTabs).observe($("#overlay-settings"), { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(paintTabs).observe($("#screen-home"), { attributes: true, attributeFilter: ["class"] });
  paintTabs();

  const idField = $("#remote-id");
  // "decimal": digits plus a separator key, so an IP address ("192.168.1.20") can be typed too.
  if (idField) { idField.setAttribute("inputmode", "decimal"); idField.setAttribute("enterkeyhint", "go"); }
  // Format the ID as it is typed ("123456789" → "123 456 789") — initiateConnection expects the spaced form.
  // With a separator it is an IP address: keep it, turning the comma an Indonesian keypad shows into a dot.
  idField?.addEventListener("input", () => {
    if (/[.,:]/.test(idField.value)) { const ip = idField.value.replace(/,/g, ".").replace(/[^0-9.:]/g, "").slice(0, 21); if (ip !== idField.value) idField.value = ip; return; }
    const d = idField.value.replace(/\D/g, "").slice(0, 9);
    const f = d.replace(/(\d{3})(?=\d)/g, "$1 ");
    if (f !== idField.value) idField.value = f;
  });
  // Enter / the keyboard's "Go" key is handled by app.js itself — a second listener here started the same
  // connection twice, which threw the user off the Connecting screen (and its password box).

  // ── Control Center on a phone: no file transfer / screenshots / recording / game mouse / clipboard polling ──
  const MOBILE_OFF = /^(Transfer file|Ambil screenshot|Rekam sesi|Hentikan rekaman|Mode game|Sinkron clipboard)/;
  const _ccItems = ccItems;
  ccItems = (cat) => {
    if (cat === "window") {
      return [
        { label: "Pas layar (reset zoom)", active: zoom.s === 1, close: true, run: resetZoom },
        { divider: true },
        { label: "Mode sentuh: touchpad", active: mode === "touchpad", run: () => setMode("touchpad") },
        { label: "Mode sentuh: sentuh langsung", active: mode === "direct", run: () => setMode("direct") },
      ];
    }
    const items = _ccItems(cat);
    return cat === "more" ? items.filter((it) => !MOBILE_OFF.test(it.label || "")) : items;
  };
  const _ccRender = ccRender;
  ccRender = () => {
    _ccRender();
    // drop "Layar penuh" (the app is already full-screen on a phone); keep "Putuskan koneksi"
    $$("#control-center > .cc-leaf:not(.danger)").forEach((l) => l.remove());
  };
  // On a phone the sub-menu opens as a sheet over the Control Center, so it needs its own way back.
  const _ccOpenFlyout = ccOpenFlyout;
  ccOpenFlyout = (cat, rowEl) => {
    _ccOpenFlyout(cat, rowEl);
    const fly = $("#cc-flyout"), c = CC_CATS.find((x) => x.key === cat);
    const back = document.createElement("button");
    back.className = "cc-leaf m-back";
    back.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 18 9 12 15 6"/></svg><span>${c ? c.label : ""}</span>`;
    back.addEventListener("click", (e) => {
      e.stopPropagation();
      fly.classList.add("hidden"); ccFlyoutCat = null; ccFlyoutRow = null;
      $$("#control-center .cc-cat").forEach((r) => r.classList.remove("open"));
    });
    fly.prepend(back);
  };

  // ── Helpers ──
  const VK = { BACK: 8, TAB: 9, ENTER: 13, SHIFT: 16, CTRL: 17, ALT: 18, ESC: 27, PGUP: 33, PGDN: 34, END: 35, HOME: 36,
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, DEL: 46, WIN: 91 };
  const send = (ev) => sendInput(ev);
  const buzz = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
  const svg = (inner) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  // The remote picture's on-screen box (letterboxing removed, zoom included).
  function contentBox() {
    const v = activeVideo(); if (!v || !v.videoWidth) return null;
    const r = v.getBoundingClientRect();
    const sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * sc, h = v.videoHeight * sc;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
  }
  const clamp01 = (v) => Math.min(0.9999, Math.max(0, v));
  function pointAt(clientX, clientY) {
    const b = contentBox(); if (!b) return null;
    return { x: clamp01((clientX - b.left) / b.w), y: clamp01((clientY - b.top) / b.h) };
  }

  // ── Modifier latch (special-keys bar): tap Ctrl / Alt / Shift / Win, then the next key gets them ──
  const latched = new Set();
  function tapVk(vk) {
    const mods = [...latched];
    for (const m of mods) send({ action: "keydown", vk: m });
    send({ action: "keydown", vk }); send({ action: "keyup", vk });
    for (const m of mods.reverse()) send({ action: "keyup", vk: m });
    if (mods.length) { latched.clear(); renderLatch(); }
  }
  function typeOut(text) {
    if (!text) return;
    // With a modifier latched, a letter/digit must travel as its key code (Ctrl+C, Alt+F4…), not as text.
    if (latched.size && /^[a-z0-9 ]$/i.test(text)) { tapVk(text === " " ? 0x20 : text.toUpperCase().charCodeAt(0)); return; }
    send({ action: "type", text });
  }

  // ── Touch → mouse ──
  const container = $("#remote-canvas-container"), wrap = $("#video-wrap");
  let mode = store.get("m.touchMode") === "direct" ? "direct" : "touchpad";
  let gameOn = false;                            // game mode (see "Game mode" below)
  const cur = { x: 0.5, y: 0.5 };                // touchpad cursor, normalized to the remote screen
  const zoom = { s: 1, tx: 0, ty: 0 };
  const cursorEl = document.createElement("div"); cursorEl.id = "m-cursor"; $("#remote-stage").appendChild(cursorEl);

  function applyZoom() {
    const W = container.clientWidth, H = container.clientHeight;
    zoom.s = Math.min(5, Math.max(1, zoom.s));
    zoom.tx = Math.min(0, Math.max(W - W * zoom.s, zoom.tx));
    zoom.ty = Math.min(0, Math.max(H - H * zoom.s, zoom.ty));
    if (zoom.s < 1.01) { zoom.s = 1; zoom.tx = 0; zoom.ty = 0; }
    wrap.style.transformOrigin = "0 0";
    wrap.style.transform = zoom.s === 1 ? "" : `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.s})`;
    drawCursor();
  }
  function resetZoom() { zoom.s = 1; zoom.tx = 0; zoom.ty = 0; applyZoom(); }
  function drawCursor() {
    const b = mode === "touchpad" && !gameOn && contentBox();   // a game draws its own crosshair
    if (!b || !active) { cursorEl.style.display = "none"; return; }
    const cr = container.getBoundingClientRect();
    cursorEl.style.display = "block";
    cursorEl.style.transform = `translate(${b.left - cr.left + cur.x * b.w}px, ${b.top - cr.top + cur.y * b.h}px)`;
  }
  // Zoomed in: keep the touchpad cursor on screen by sliding the view after it.
  function followCursor() {
    if (zoom.s === 1) return;
    const b = contentBox(); if (!b) return;
    const cr = container.getBoundingClientRect(), m = 40;
    const px = b.left + cur.x * b.w, py = b.top + cur.y * b.h;
    if (px < cr.left + m) zoom.tx += cr.left + m - px; else if (px > cr.right - m) zoom.tx -= px - (cr.right - m);
    if (py < cr.top + m) zoom.ty += cr.top + m - py; else if (py > cr.bottom - m) zoom.ty -= py - (cr.bottom - m);
    applyZoom();
  }
  function setMode(m) {
    mode = m; store.set("m.touchMode", m); renderModeBtn(); drawCursor();
    showToast(m === "touchpad" ? "Touchpad — geser untuk menggerakkan kursor, ketuk untuk klik" : "Sentuh langsung — ketuk tepat di tempat yang mau diklik");
  }

  let moveTimer = null, pendingMove = null, lastMoveAt = 0;
  // Every move also becomes the touchpad cursor, so switching from direct touch to touchpad
  // carries on from where the PC cursor really is instead of jumping back to the middle.
  function moveTo(p) {                            // throttled absolute move (~60/s), same pacing as the desktop
    cur.x = p.x; cur.y = p.y;
    pendingMove = p; if (moveTimer) return;
    const wait = Math.max(0, 16 - (performance.now() - lastMoveAt));
    moveTimer = setTimeout(() => { moveTimer = null; lastMoveAt = performance.now(); if (pendingMove) send({ action: "mousemove", ...pendingMove }); }, wait);
  }
  function flushMove(p) { cur.x = p.x; cur.y = p.y; clearTimeout(moveTimer); moveTimer = null; pendingMove = null; lastMoveAt = performance.now(); send({ action: "mousemove", ...p }); }
  function click(p, button = "left") { flushMove(p); send({ action: "mousedown", button }); send({ action: "mouseup", button }); }

  const TAP_MS = 280, HOLD_MS = 450, SLOP = 9, SCROLL_STEP = 26, TP_SPEED = 1.6;
  let g = null;   // the gesture in progress
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

  container.addEventListener("touchstart", (e) => {
    e.preventDefault();   // no emulated mouse events: touch is translated here, not by app.js's mouse handlers
    closeAllMenus(); $("#key-menu")?.classList.add("hidden");
    if (!active) return;
    const t = e.touches;
    if (gameOn) { gameTouchStart(t); return; }
    if (t.length === 1 && !g) {
      const p = t[0];
      g = { n: 1, x0: p.clientX, y0: p.clientY, lx: p.clientX, ly: p.clientY, t0: performance.now(), moved: false, drag: false, down: false, done: false };
      if (mode === "direct") { const q = pointAt(p.clientX, p.clientY); if (q) moveTo(q); }
      g.hold = setTimeout(() => {
        if (!g || g.n !== 1 || g.moved) return;
        buzz(18);
        if (mode === "touchpad") { g.drag = true; flushMove(cur); send({ action: "mousedown", button: "left" }); }
        else { const q = pointAt(g.x0, g.y0); if (q) click(q, "right"); g.done = true; }
      }, HOLD_MS);
    } else if (t.length === 2) {
      if (g && g.n === 1) {
        clearTimeout(g.hold);
        if (g.drag || g.down) send({ action: "mouseup", button: "left" });
      }
      const m0 = mid(t[0], t[1]);
      g = { n: 2, d0: dist(t[0], t[1]), m0, lm: m0, s0: zoom.s, t0: performance.now(), moved: false, pinch: false, ax: 0, ay: 0,
            // content point under the fingers when the gesture started (for zoom around the pinch centre)
            cx: (m0.x - container.getBoundingClientRect().left - zoom.tx) / zoom.s, cy: (m0.y - container.getBoundingClientRect().top - zoom.ty) / zoom.s };
    } else if (t.length > 2 && g) { clearTimeout(g.hold); g.n = 0; }   // 3+ fingers: ignore until all lift
  }, { passive: false });

  container.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (!g || !active) return;
    const t = e.touches;
    if (g.game) { gameTouchMove(t); return; }
    if (g.n === 1 && t.length === 1) {
      const p = t[0], dx = p.clientX - g.lx, dy = p.clientY - g.ly;
      g.lx = p.clientX; g.ly = p.clientY;
      if (!g.moved && Math.hypot(p.clientX - g.x0, p.clientY - g.y0) > SLOP) { g.moved = true; if (!g.drag) clearTimeout(g.hold); }
      if (!g.moved && !g.drag) return;
      if (mode === "touchpad") {
        const b = contentBox(); if (!b) return;
        cur.x = clamp01(cur.x + (dx / b.w) * TP_SPEED); cur.y = clamp01(cur.y + (dy / b.h) * TP_SPEED);
        moveTo({ ...cur }); drawCursor(); followCursor();
      } else if (!g.done) {
        if (!g.down) { const q0 = pointAt(g.x0, g.y0); if (q0) { flushMove(q0); send({ action: "mousedown", button: "left" }); g.down = true; } }
        const q = pointAt(p.clientX, p.clientY); if (q) moveTo(q);
      }
    } else if (g.n === 2 && t.length === 2) {
      const d = dist(t[0], t[1]), m = mid(t[0], t[1]);
      if (!g.moved && (Math.abs(d - g.d0) > 10 || Math.hypot(m.x - g.m0.x, m.y - g.m0.y) > 10)) g.moved = true;
      if (!g.pinch && Math.abs(d - g.d0) > 28) g.pinch = true;
      if (g.pinch || zoom.s > 1) {
        // pinch zooms around the fingers' centre; moving both fingers pans the zoomed view
        const cr = container.getBoundingClientRect();
        zoom.s = Math.min(5, Math.max(1, g.s0 * (d / g.d0)));
        zoom.tx = m.x - cr.left - g.cx * zoom.s; zoom.ty = m.y - cr.top - g.cy * zoom.s;
        applyZoom();
      } else {
        // two-finger drag = scroll wheel (natural direction: fingers up → page down)
        g.ay += m.y - g.lm.y; g.ax += m.x - g.lm.x;
        while (Math.abs(g.ay) >= SCROLL_STEP) { const s = Math.sign(g.ay); send({ action: "scroll", deltaX: 0, deltaY: -s }); g.ay -= s * SCROLL_STEP; }
        while (Math.abs(g.ax) >= SCROLL_STEP) { const s = Math.sign(g.ax); send({ action: "scroll", deltaX: -s, deltaY: 0 }); g.ax -= s * SCROLL_STEP; }
      }
      g.lm = m;
    }
  }, { passive: false });

  function endGesture(e) {
    e.preventDefault();
    if (!g) return;
    if (e.touches.length) return;   // wait until every finger has lifted
    const dur = performance.now() - g.t0;
    clearTimeout(g.hold);
    if (g.game) { gameTouchEnd(dur); g = null; return; }
    if (g.n === 1) {
      if (mode === "touchpad") {
        if (g.drag) send({ action: "mouseup", button: "left" });
        else if (!g.moved && dur < TAP_MS) click({ ...cur });
      } else if (!g.done) {
        if (g.down) { const q = pointAt(g.lx, g.ly); if (q) flushMove(q); send({ action: "mouseup", button: "left" }); }
        else if (!g.moved && dur < HOLD_MS) { const q = pointAt(g.x0, g.y0); if (q) click(q); }
      }
    } else if (g.n === 2 && !g.moved && !g.pinch && dur < 350) {
      buzz();
      const q = mode === "touchpad" ? { ...cur } : pointAt(g.m0.x, g.m0.y);
      if (q) click(q, "right");
    }
    g = null;
  }
  container.addEventListener("touchend", endGesture, { passive: false });
  container.addEventListener("touchcancel", endGesture, { passive: false });
  window.addEventListener("resize", () => { applyZoom(); });

  // ── Game mode ──
  // Games such as Minecraft read RAW mouse motion while they hold the cursor, so the absolute positions the touchpad
  // sends never turn the camera (the cursor is set, but no motion is reported). In game mode:
  //   • one-finger drag = relative mouse motion (looks around), tap = left click where the game's crosshair is,
  //     press and hold = hold the left button (mine / attack) while still looking around;
  //   • two-finger tap = right click, two-finger drag = scroll wheel (hotbar in many games);
  //   • L / R buttons on the screen can be held for long presses (place, aim) — and give a right click to a single
  //     pointer, e.g. a mouse in an emulator;
  //   • a real mouse (Bluetooth, or a PC emulator) sends its movement relatively too, with its own buttons.
  // The host already takes this ("mousemove-rel", the desktop's game mode). Off again when the session ends.
  let relX = 0, relY = 0, relTimer = null;
  const GAME_SENS_TOUCH = 2.4, GAME_SENS_MOUSE = 1;
  const gameHeld = new Set();
  function sendRel(dx, dy, sens) {
    relX += dx * sens; relY += dy * sens;
    if (relTimer) return;
    relTimer = setTimeout(() => {
      relTimer = null;
      const x = Math.trunc(relX), y = Math.trunc(relY); relX -= x; relY -= y;
      if (x || y) send({ action: "mousemove-rel", dx: x, dy: y });
    }, 8);
  }
  const gDown = (b) => { if (gameHeld.has(b)) return; gameHeld.add(b); send({ action: "mousedown", button: b }); };
  const gUp = (b) => { if (!gameHeld.has(b)) return; gameHeld.delete(b); send({ action: "mouseup", button: b }); };
  const gClick = (b) => { gDown(b); gUp(b); };   // down + up back to back (a timer could be delayed in the background)
  function gameTouchStart(t) {
    if (t.length === 1 && !g) {
      const p = t[0];
      g = { game: true, n: 1, x0: p.clientX, y0: p.clientY, lx: p.clientX, ly: p.clientY, t0: performance.now(), moved: false, drag: false };
      g.hold = setTimeout(() => { if (g && g.game && g.n === 1 && !g.moved) { buzz(18); g.drag = true; gDown("left"); } }, HOLD_MS);
    } else if (t.length === 2) {
      if (g && g.game && g.n === 1) clearTimeout(g.hold);
      const m0 = mid(t[0], t[1]);
      g = { game: true, n: 2, m0, lm: m0, t0: performance.now(), moved: false, ay: 0, drag: g && g.drag };
    }
  }
  function gameTouchMove(t) {
    if (g.n === 1 && t.length === 1) {
      const p = t[0], dx = p.clientX - g.lx, dy = p.clientY - g.ly;
      g.lx = p.clientX; g.ly = p.clientY;
      if (!g.moved && Math.hypot(p.clientX - g.x0, p.clientY - g.y0) > SLOP) { g.moved = true; if (!g.drag) clearTimeout(g.hold); }
      if (g.moved || g.drag) sendRel(dx, dy, GAME_SENS_TOUCH);
    } else if (g.n === 2 && t.length === 2) {
      const m = mid(t[0], t[1]);
      if (!g.moved && Math.hypot(m.x - g.m0.x, m.y - g.m0.y) > 10) g.moved = true;
      g.ay += m.y - g.lm.y; g.lm = m;
      while (Math.abs(g.ay) >= SCROLL_STEP) { const s = Math.sign(g.ay); send({ action: "scroll", deltaX: 0, deltaY: -s }); g.ay -= s * SCROLL_STEP; }
    }
  }
  function gameTouchEnd(dur) {
    if (g.n === 1) {
      if (g.drag) gUp("left");
      else if (!g.moved && dur < TAP_MS) gClick("left");
    } else if (g.n === 2) {
      if (g.drag) gUp("left");
      if (!g.moved && dur < 350) { buzz(); gClick("right"); }
    }
  }
  // A real mouse: movement as deltas (pointer lock when the WebView offers it), buttons as they are. Capture phase,
  // so the desktop page's own absolute-position handlers never see these while game mode is on.
  const MB = ["left", "middle", "right"];
  const isMouse = (e) => e.pointerType === "mouse" || (e.type.startsWith("mouse") && !e.sourceCapabilities?.firesTouchEvents);
  for (const type of ["mousemove", "mousedown", "mouseup", "contextmenu", "pointermove", "pointerdown", "pointerup"]) {
    container.addEventListener(type, (e) => {
      if (!gameOn || !active || (type.startsWith("pointer") && e.pointerType !== "mouse") || (type.startsWith("mouse") && !isMouse(e))) return;
      e.preventDefault(); e.stopPropagation();
      if (type === "pointermove") sendRel(e.movementX || 0, e.movementY || 0, GAME_SENS_MOUSE);
      else if (type === "pointerdown") {
        gDown(MB[e.button] || "left");
        // Pointer lock keeps a mouse from hitting the screen edge; not every WebView offers it (then the deltas
        // still work until the edge). Newer engines return a promise that rejects when it is refused.
        try { if (!document.pointerLockElement) { const pr = container.requestPointerLock(); if (pr && pr.catch) pr.catch(() => {}); } } catch {}
      }
      else if (type === "pointerup") gUp(MB[e.button] || "left");
    }, true);
  }
  // L / R buttons for long presses (and a right click when there is only one pointer).
  const gamePad = document.createElement("div");
  gamePad.id = "m-gamepad"; gamePad.className = "hidden";
  for (const [b, label] of [["left", "L"], ["right", "R"]]) {
    const k = document.createElement("button"); k.type = "button"; k.className = "m-gbtn"; k.textContent = label;
    k.setAttribute("aria-label", b === "left" ? "Klik kiri" : "Klik kanan");
    k.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); buzz(10); k.classList.add("on"); gDown(b); try { k.setPointerCapture(e.pointerId); } catch {} });
    const up = (e) => { e.stopPropagation(); k.classList.remove("on"); gUp(b); };
    k.addEventListener("pointerup", up); k.addEventListener("pointercancel", up);
    k.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    gamePad.appendChild(k);
  }
  $("#remote-stage").appendChild(gamePad);
  function setGame(on) {
    gameOn = !!on;
    for (const b of [...gameHeld]) gUp(b);
    relX = relY = 0; g = null;
    if (!gameOn && document.pointerLockElement) { try { document.exitPointerLock(); } catch {} }
    gamePad.classList.toggle("hidden", !gameOn);
    if (gameOn) resetZoom();
    renderGameBtn(); drawCursor();
  }
  function renderGameBtn() { const b = $("#m-btn-game"); if (b) b.classList.toggle("on", gameOn); }

  // ── On-screen keyboard (hidden textarea; text is diffed so autocorrect / predictions type correctly) ──
  const kbd = document.createElement("textarea");
  kbd.id = "m-kbd";
  for (const [k, v] of Object.entries({ autocapitalize: "off", autocomplete: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "enter", "aria-label": "Keyboard" })) kbd.setAttribute(k, v);
  document.body.appendChild(kbd);
  let kPrev = "", composing = false;
  kbd.addEventListener("compositionstart", () => { composing = true; });
  kbd.addEventListener("compositionend", () => { composing = false; trimKbd(); });
  kbd.addEventListener("input", () => {
    const now = kbd.value;
    let p = 0; while (p < kPrev.length && p < now.length && kPrev[p] === now[p]) p++;
    for (let i = kPrev.length - p; i > 0; i--) tapVk(VK.BACK);
    typeOut(now.slice(p));
    kPrev = now;
    if (!composing) trimKbd();
  });
  function trimKbd() { if (kbd.value.length > 48) { kbd.value = ""; kPrev = ""; } }
  const KEY_VK = { ArrowLeft: VK.LEFT, ArrowRight: VK.RIGHT, ArrowUp: VK.UP, ArrowDown: VK.DOWN, Escape: VK.ESC, Tab: VK.TAB, Delete: VK.DEL, Home: VK.HOME, End: VK.END, PageUp: VK.PGUP, PageDown: VK.PGDN };
  kbd.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && kbd.value === "") { e.preventDefault(); tapVk(VK.BACK); return; }   // nothing left to diff
    const vk = KEY_VK[e.key];
    if (vk) { e.preventDefault(); tapVk(vk); }
  });
  kbd.addEventListener("blur", () => { kbd.value = ""; kPrev = ""; renderKbdBtn(); });
  kbd.addEventListener("focus", renderKbdBtn);
  // Android hides the keyboard on Back by itself (the page never hears it) while our field stays focused.
  // The window shrinks while the keyboard is up (adjustResize), so a return to full height means it closed.
  let fullH = innerHeight, kbdUp = false;
  window.addEventListener("resize", () => {
    if (document.activeElement !== kbd) { fullH = Math.max(fullH, innerHeight); return; }
    if (innerHeight < fullH - 120) kbdUp = true;
    else if (kbdUp) { kbdUp = false; kbd.blur(); }
  });
  window.addEventListener("orientationchange", () => { fullH = 0; setTimeout(() => { fullH = innerHeight; }, 400); });
  function toggleKeyboard() {
    if (document.activeElement === kbd) kbd.blur();
    else { kbd.value = ""; kPrev = ""; kbd.focus({ preventScroll: true }); }
  }

  // ── Special-keys bar ──
  const keysBar = document.createElement("div");
  keysBar.id = "m-keys"; keysBar.className = "hidden";
  const KEYS = [["Esc", VK.ESC], ["Tab", VK.TAB], ["Ctrl", VK.CTRL, 1], ["Alt", VK.ALT, 1], ["Shift", VK.SHIFT, 1], ["Win", VK.WIN, 1],
    ["←", VK.LEFT], ["↑", VK.UP], ["↓", VK.DOWN], ["→", VK.RIGHT], ["Home", VK.HOME], ["End", VK.END], ["PgUp", VK.PGUP], ["PgDn", VK.PGDN],
    ["Del", VK.DEL], ["⌫", VK.BACK], ["Enter", VK.ENTER], ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i])];
  for (const [label, vk, mod] of KEYS) {
    const b = document.createElement("button"); b.className = "m-key" + (mod ? " m-mod" : ""); b.textContent = label; b.dataset.vk = vk;
    b.addEventListener("click", (e) => {
      e.stopPropagation(); buzz(8);
      if (mod) { latched.has(vk) ? latched.delete(vk) : latched.add(vk); renderLatch(); }
      else tapVk(vk);
    });
    keysBar.appendChild(b);
  }
  // keep the soft keyboard open while tapping the bar
  keysBar.addEventListener("pointerdown", (e) => e.preventDefault());
  function renderLatch() { $$("#m-keys .m-mod").forEach((b) => b.classList.toggle("on", latched.has(+b.dataset.vk))); }

  // ── Floating toolbar ──
  const bar = document.createElement("div");
  bar.id = "m-toolbar";
  const tb = (id, title, icon) => `<button class="m-tb" id="${id}" title="${title}" aria-label="${title}">${svg(icon)}</button>`;
  bar.innerHTML =
    tb("m-btn-kbd", "Keyboard", `<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>`) +
    tb("m-btn-keys", "Tombol khusus", `<path d="M4 7V5h16v2M9 19h6M12 5v14"/>`) +
    tb("m-btn-mode", "Mode sentuh", "") +
    tb("m-btn-game", "Mode game", `<rect x="2" y="7" width="20" height="11" rx="4"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="15.5" cy="11.5" r=".9"/><circle cx="18" cy="14" r=".9"/>`) +
    tb("m-btn-rotate", "Putar layar", `<rect x="3" y="7" width="18" height="11" rx="2"/><path d="M8 3.5a9 9 0 0 1 9 1.5"/><polyline points="17 2 17 5 14 5"/>`) +
    tb("m-btn-menu", "Menu", `<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>`) +
    `<span class="m-lat" id="m-lat">- ms</span>` +
    tb("m-btn-close", "Putuskan", `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`) +
    tb("m-btn-hide", "Sembunyikan toolbar", `<polyline points="6 9 12 15 18 9"/>`);
  const peek = document.createElement("button");
  peek.id = "m-peek"; peek.className = "hidden"; peek.title = "Tampilkan toolbar"; peek.setAttribute("aria-label", "Tampilkan toolbar");
  peek.innerHTML = svg(`<polyline points="18 15 12 9 6 15"/>`);
  const remote = $("#screen-remote");
  remote.append(keysBar, bar, peek);
  // Taps on the toolbar must not reach the document listener that closes the Control Center.
  bar.addEventListener("click", (e) => e.stopPropagation());
  bar.addEventListener("pointerdown", (e) => { if (e.target.closest("#m-btn-kbd, #m-btn-keys")) e.preventDefault(); });   // keep keyboard focus

  const MODE_ICON = {
    touchpad: `<rect x="4" y="3" width="16" height="18" rx="3"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="12" y1="15" x2="12" y2="21"/>`,
    direct: `<path d="M9 11V5a2 2 0 014 0v6"/><path d="M13 9.5a2 2 0 014 0V12"/><path d="M17 11a2 2 0 014 0v3a7 7 0 01-7 7h-1a7 7 0 01-6-3.4L4.3 13a2 2 0 013.4-2L9 13"/>`,
  };
  function renderModeBtn() { const b = $("#m-btn-mode"); b.innerHTML = svg(MODE_ICON[mode]); b.classList.toggle("on", mode === "direct"); }
  function renderKbdBtn() { $("#m-btn-kbd").classList.toggle("on", document.activeElement === kbd); }
  renderModeBtn();
  $("#m-btn-kbd").addEventListener("click", toggleKeyboard);
  $("#m-btn-keys").addEventListener("click", () => { keysBar.classList.toggle("hidden"); $("#m-btn-keys").classList.toggle("on", !keysBar.classList.contains("hidden")); });
  $("#m-btn-mode").addEventListener("click", () => setMode(mode === "touchpad" ? "direct" : "touchpad"));
  $("#m-btn-game").addEventListener("click", () => {
    setGame(!gameOn);
    showToast(gameOn ? "Mode game: geser = arahkan kamera · ketuk = klik · tahan = tahan klik · ketuk 2 jari = klik kanan" : "Mode game mati");
  });
  $("#m-btn-menu").addEventListener("click", () => $("#btn-control-center").click());
  // Landscape lock (default on): the PC picture is wide, so a session turns the phone sideways. The button
  // lets the screen follow the phone again; the choice is remembered.
  const landscapeOn = () => store.get("m.landscape") !== "0";
  const applyScreen = () => setScreen({ immersive: true, orientation: landscapeOn() ? "landscape" : "auto" });
  const renderRotateBtn = () => $("#m-btn-rotate").classList.toggle("on", landscapeOn());
  renderRotateBtn();
  $("#m-btn-rotate").addEventListener("click", () => {
    store.set("m.landscape", landscapeOn() ? "0" : "1"); renderRotateBtn(); applyScreen();
    showToast(landscapeOn() ? "Layar dikunci landscape" : "Layar mengikuti posisi HP");
  });
  $("#m-btn-close").addEventListener("click", () => { if (active) closeSession(active, true); });
  $("#m-btn-hide").addEventListener("click", () => { bar.classList.add("hidden"); keysBar.classList.add("hidden"); $("#m-btn-keys").classList.remove("on"); peek.classList.remove("hidden"); });
  peek.addEventListener("click", (e) => { e.stopPropagation(); peek.classList.add("hidden"); bar.classList.remove("hidden"); });

  // Latency badge mirrors the desktop session bar (pollStats writes #rt-latency-badge).
  const lat = $("#rt-latency-badge");
  if (lat) new MutationObserver(() => { const m = $("#m-lat"); m.textContent = lat.textContent; m.className = "m-lat " + [...lat.classList].filter((c) => c.startsWith("lat-")).join(" "); })
    .observe(lat, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });

  // ── Session lifecycle: wake lock, first-time hints, reset per session ──
  let wakeLock = null, hinted = store.get("m.hinted") === "1";
  async function onRemoteVisible(on) {
    if (on) {
      resetZoom(); cur.x = 0.5; cur.y = 0.5; drawCursor();
      applyScreen();   // full screen, and landscape unless the user turned that off
      try { if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch {}
      if (!hinted) { hinted = true; store.set("m.hinted", "1"); setTimeout(() => showToast("Ketuk = klik · tahan lalu geser = seret · 2 jari = scroll · ketuk 2 jari = klik kanan · cubit = zoom"), 1200); }
      else if (!ScreenPlugin && innerHeight > innerWidth) setTimeout(() => showToast("Putar HP ke landscape untuk tampilan lebih besar"), 1200);
    } else {
      setScreen({ immersive: false, orientation: "auto" });
      try { await wakeLock?.release(); } catch {} wakeLock = null;
      kbd.blur(); latched.clear(); renderLatch();
      setGame(false);   // never leave a mouse button held, or game mode on, for the next PC
    }
  }
  let remoteShown = !remote.classList.contains("hidden");
  new MutationObserver(() => {
    const on = !remote.classList.contains("hidden");
    if (on !== remoteShown) { remoteShown = on; onRemoteVisible(on); }
  }).observe(remote, { attributes: true, attributeFilter: ["class"] });
  // A remote picture that changes size (monitor switch, rotation) re-fits the zoom and the cursor.
  new MutationObserver(() => { const v = activeVideo(); if (v && !v._mBound) { v._mBound = true; v.addEventListener("resize", () => { resetZoom(); }); } })
    .observe(wrap, { childList: true });
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden && remoteShown && !wakeLock && navigator.wakeLock) { try { wakeLock = await navigator.wakeLock.request("screen"); } catch {} }
  });

  // ── Server socket check: phones switch networks (Wi-Fi ↔ mobile data) under the app ──
  // The old socket can then stay "open" but dead for 30-45 s: the status still says Online, and a connect
  // request sent into it is lost, leaving the Connecting screen waiting forever. The server answers a
  // connect-request for an ID that can't exist with an "error" naming it, so that request proves the socket
  // is alive. No answer → open a fresh socket, and once registered, send the lost requests again.
  const PROBE_ID = "td-probe", PROBE_MS = 3500, FRESH_MS = 15000;
  let lastHeard = Date.now(), probe = null, resendAfterRegister = false;
  const _onSignal = onSignal;
  onSignal = (msg) => {
    lastHeard = Date.now();
    if (msg && msg.type === "error" && msg.targetId === PROBE_ID) { if (probe) probe.ok(); return; }
    if (msg && msg.type === "registered" && resendAfterRegister) {
      resendAfterRegister = false;
      setTimeout(() => {
        for (const s of viewerSessions()) {
          if (s.role === "viewer" && !s.pc && sessions.get(s.peerId) === s) sendSignal({ type: "connect-request", targetId: s.peerId, fromName: store.get("deviceAlias") || "TryDesk User" });
        }
      }, 0);
    }
    return _onSignal(msg);
  };
  function checkServer({ resend = false } = {}) {
    if (probe || !ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastHeard < FRESH_MS) return;
    const timer = setTimeout(() => {
      probe = null;
      logInfoSafe("server socket silent — reconnecting");
      if (resend) resendAfterRegister = true;
      connectSignaling();
    }, PROBE_MS);
    probe = { ok: () => { clearTimeout(timer); probe = null; } };
    sendSignal({ type: "connect-request", targetId: PROBE_ID });
  }
  const logInfoSafe = (m) => { try { window.electronAPI.logInfo(m); } catch {} };
  const _initiate = initiateConnection;
  initiateConnection = (...args) => {
    const s = _initiate(...args);
    if (s instanceof Session && !s.pc) checkServer({ resend: true });
    return s;
  };
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 5000) checkServer({ resend: true });
  });

  // ── Android back button: close what's open, else confirm disconnect, else go to the background ──
  if (AppPlugin && AppPlugin.addListener) {
    AppPlugin.addListener("backButton", async () => {
      const open = (sel) => { const el = $(sel); return el && !el.classList.contains("hidden"); };
      if (tileMenuEl) return closeTileMenu();       // a Recent tile's press-and-hold menu
      if (open("#cc-flyout") || open("#control-center")) return closeAllMenus();
      if (open("#key-menu")) return $("#key-menu").classList.add("hidden");
      if (open("#quality-panel")) return $("#btn-quality-close").click();
      if (open("#chat-panel")) return closeChat();
      if (open("#overlay-settings")) return toggleSettings();
      if (document.activeElement === kbd) return kbd.blur();
      if (!keysBar.classList.contains("hidden")) return $("#m-btn-keys").click();
      if (open("#screen-connecting") && active) { stopReconnect(active.peerId); return closeSession(active, false); }
      if (remoteShown && active) { if (await window.electronAPI.confirm({ message: tr("Putuskan koneksi ke PC ini?") })) closeSession(active, true); return; }
      // On Home with a session still running (after "＋"): Back returns to it instead of leaving the app.
      const live = viewerSessions().filter((s) => s.pc);
      if (open("#screen-home") && live.length) return switchTab(live.includes(active) ? active : live[live.length - 1]);
      try { AppPlugin.minimizeApp(); } catch {}
    });
  }
})();
