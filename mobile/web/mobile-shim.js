// TryDesk for Android — stand-in for Electron's preload API (window.electronAPI).
// The phone app runs the desktop renderer unchanged (app.js / index.html). It is a VIEWER only: it controls
// a Windows PC but never shares its own screen, so every host-side call (capture, input injection, black
// screen, files on this device…) is answered with "not available" and the matching UI is hidden by mobile.js.
// Loaded BEFORE app.js.
(() => {
  const noop = () => {};
  const value = (v) => () => Promise.resolve(v);
  const unavailable = { ok: false, error: "Tidak tersedia di aplikasi HP" };

  // version.json is signed with the owner's Ed25519 key (scripts/sign-version.mjs; same public key as main.js).
  // true = good signature, false = missing or wrong, null = this WebView can't check Ed25519 (older Chrome).
  const VERSION_JSON_PUBKEY = "MCowBQYDK2VwAyEALmgxboidf3mbPwbQKUYPidxLPlSdMvgjQle1fXxJu6E=";
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function verifyVersionJson(v, sig) {
    if (typeof sig !== "string" || !/^[A-Za-z0-9+/=]{80,100}$/.test(sig)) return false;
    let key;
    try { key = await crypto.subtle.importKey("spki", b64(VERSION_JSON_PUBKEY), { name: "Ed25519" }, false, ["verify"]); } catch { return null; }
    try {
      const data = new TextEncoder().encode(JSON.stringify({ latest: v.latest, minimum: v.minimum || "", url: v.url, notes: { id: v.notes.id, en: v.notes.en } }));
      return await crypto.subtle.verify({ name: "Ed25519" }, key, b64(sig), data);
    } catch { return false; }
  }

  const api = {
    async getConfig() {
      const r = await fetch("config.json", { cache: "no-store" });
      const c = await r.json();
      return { ...c, appVersion: (window.TD_MOBILE && window.TD_MOBILE.version) || "" };
    },
    async confirm(opts = {}) {
      const text = [opts.title, opts.message, opts.detail].filter(Boolean).join("\n\n");
      return window.confirm(text);
    },
    // The phone never polls its own clipboard (that would read whatever the user copied, at any time).
    // Text copied on the PC still lands on the phone through clipboardWrite.
    clipboardRead: value(""),
    async clipboardWrite(text) { try { await navigator.clipboard.writeText(String(text ?? "")); } catch {} },
    openExternal(url) { try { window.open(String(url || ""), "_blank", "noopener"); } catch {} },
    logInfo(msg) { try { console.log("[trydesk]", String(msg)); } catch {} },
    getMonitors: value([]),
    isElevated: value(false),
    getLoginItem: value(false),
    setLoginItem: value(false),
    getHwAccel: value(true),
    setHwAccel: value(true),
    setDisplayMediaSource: value(false),
    // Screenshots and session recordings go to the phone's gallery through the native TdFile plugin; app.js
    // writes them with the same calls as on the desktop (a "save as" name, then open / write / close).
    async fileSaveDialog(name) {
      const F = plugin("TdFile"); if (!F) return null;
      try { const r = await F.target({ name: String(name || "") }); return (r && r.path) || null; } catch { return null; }
    },
    async fileOpenWrite(p) {
      const F = plugin("TdFile"); if (!F) throw new Error(unavailable.error);
      return (await F.open({ path: String(p || "") })).id;
    },
    // Sent in pieces of at most 512 KB: a 4K screenshot in one go would be a 10 MB+ string over the bridge.
    async fileWriteChunk(id, chunk) {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      for (let off = 0; off < u8.length; off += 0x80000) {
        const part = u8.subarray(off, off + 0x80000);
        let s = ""; for (let i = 0; i < part.length; i += 0x8000) s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
        await plugin("TdFile").write({ id: String(id), data: btoa(s) });
      }
    },
    async fileCloseWrite(id, deleteFile) { await plugin("TdFile").close({ id: String(id), cancel: !!deleteFile }); },
    filePick: value([]),
    fsHome: value(unavailable),
    fsList: value(unavailable),
    fileOpenRead: () => Promise.reject(new Error(unavailable.error)),
    fileOpenWriteIn: () => Promise.reject(new Error(unavailable.error)),
    enableBlackScreen: value(false),
    enableInputLock: value(false),
    relaunchAsAdmin: value(false),

    // Update check: the same version.json the desktop reads (main.js check-update), same validation. The website
    // allows this app's origin to read it (.htaccess); a failure is null and blocks nothing.
    async checkUpdate() {
      try {
        const r = await fetch("https://trydesk.ai.id/update/version.json", { cache: "no-store" });
        if (!r.ok) return null;
        const j = JSON.parse((await r.text()).slice(0, 8192));
        const ver = (v) => (typeof v === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : null);
        const note = (v) => (typeof v === "string" ? v.slice(0, 300) : "");
        if (!ver(j.latest)) return null;
        const out = { latest: ver(j.latest), minimum: ver(j.minimum), url: "https://trydesk.ai.id/downloads/", notes: { id: note(j.notes && j.notes.id), en: note(j.notes && j.notes.en) } };
        // Signed by the owner's key (scripts/sign-version.mjs), checked like the desktop does. A WebView without
        // Ed25519 in WebCrypto can't check it: it then shows the news but never enforces "minimum" from an
        // unverified file.
        const signed = await verifyVersionJson({ ...out, url: typeof j.url === "string" ? j.url : out.url }, j.sig);
        if (signed === false) return null;
        if (signed === null) out.minimum = null;
        return out;
      } catch { return null; }
    },

    // Connect by IP ("Sambung lewat IP") through the native TdLan plugin — the same calls main.js answers on the
    // desktop. The phone only asks; it never listens (lanHost stays "not available").
    async lanOpen(address) {
      const Lan = lanPlugin();
      if (!Lan) return { ok: false, error: "Tidak tersedia di aplikasi HP" };
      const a = String(address || "").trim();
      const m = a.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/) || a.match(/^([^:\s]+)(?::(\d{1,5}))?$/);
      if (!m) return { ok: false, error: "Alamat IP tidak valid" };
      try { return await Lan.open({ id: "lan:" + a, host: m[1], port: Number(m[2]) || 7171 }); }
      catch (e) { return { ok: false, error: (e && e.message) || "Tidak bisa terhubung ke alamat ini" }; }
    },
    lanWrite(id, msg) { const Lan = lanPlugin(); if (Lan) Lan.write({ id: String(id), line: JSON.stringify(msg) }).catch(noop); },
    lanClose(id) { const Lan = lanPlugin(); if (Lan) Lan.close({ id: String(id) }).catch(noop); },
    onLanEvent(cb) {
      const Lan = lanPlugin(); if (!Lan) return;
      Lan.addListener("lan", (ev) => {
        if (!ev || typeof ev.id !== "string") return;
        if (ev.kind === "close") return cb({ id: ev.id, kind: "close" });
        let msg; try { msg = JSON.parse(ev.line); } catch { return; }
        if (msg && typeof msg === "object" && typeof msg.type === "string") cb({ id: ev.id, kind: "line", msg });
      });
    },
  };
  const _plugins = {};
  function plugin(name) {
    const Cap = window.Capacitor;
    if (!_plugins[name] && Cap) _plugins[name] = Cap.registerPlugin ? Cap.registerPlugin(name) : Cap.Plugins && Cap.Plugins[name];
    return _plugins[name] || null;
  }
  let _lan = null;
  function lanPlugin() {
    const Cap = window.Capacitor;
    if (!_lan && Cap) _lan = Cap.registerPlugin ? Cap.registerPlugin("TdLan") : Cap.Plugins && Cap.Plugins.TdLan;
    return _lan || null;
  }

  // Anything not listed: event subscriptions (on…) do nothing, every other call resolves to null —
  // the same "feature off" answer the desktop gives when a native piece is missing.
  window.electronAPI = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === "string" && key.startsWith("on")) return noop;
      return value(null);
    },
  });
})();
