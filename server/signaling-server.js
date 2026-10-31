const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 9100;
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_HOST = process.env.TURN_HOST || "";
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
const TURN_TTL = 2 * 3600;   // short-lived TURN credentials limit sniff-and-reuse to ~2h
const OWNERS_FILE = process.env.OWNERS_FILE || "";
const OWNERS_CAP = 100000;   // bound the reserved-ID map so churn can't exhaust disk/memory
const MAX_MSG_PER_SEC = 100; // per-socket message flood cap (ICE can burst, so leave headroom)
const MAX_CONNREQ_PER_10S = 5;
const MAX_CONN_PER_IP = 30;

const online = new Map();      // id -> ws
const owners = new Map();      // id -> token (keeps an ID reserved for the device that owns it)
// Multi-session: a client (the viewer) may control several remotes at once, so these track SETS,
// not single values. A host stays single-session (it has at most one pairing).
const pending = new Map();     // requesterId -> Set<targetId>  (outgoing requests awaiting accept)
const pairs = new Map();       // id -> Set<peerId>            (active pairings, both directions)
const hosting = new Map();     // hostId -> viewerId           (who is controlling whom: only hosting makes "busy")
const away = new Map();        // id -> timer                  (socket dropped; pairings kept briefly for a re-register)
const AWAY_GRACE_MS = 30000;

if (OWNERS_FILE && fs.existsSync(OWNERS_FILE)) {
  try {
    for (const [id, token] of Object.entries(JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8")))) owners.set(id, token);
    console.log(`Loaded ${owners.size} reserved IDs`);
  } catch (e) {
    console.error("Cannot read owners file:", e.message);
  }
}

let saveTimer = null;
function saveOwners() {
  if (!OWNERS_FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = `${OWNERS_FILE}.tmp`;
    fs.writeFile(tmp, JSON.stringify(Object.fromEntries(owners)), (err) => {
      if (err) return console.error("Cannot save owners file:", err.message);
      fs.rename(tmp, OWNERS_FILE, () => {});
    });
  }, 1000);
}

// coturn "use-auth-secret" (TURN REST API): short-lived credentials, the secret never leaves the server
function turnServers(id) {
  if (!TURN_SECRET || !TURN_HOST) return [];
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${id.replace(/ /g, "")}`;
  const credential = crypto.createHmac("sha1", TURN_SECRET).update(username).digest("base64");
  return [{
    urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`],
    username,
    credential,
  }];
}

function newId() {
  let id;
  do {
    const n = String(crypto.randomInt(100000000, 1000000000));
    id = `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  } while (online.has(id) || owners.has(id));
  return id;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendTo(id, msg) {
  send(online.get(id), msg);
}

function peersOf(id) { return pairs.has(id) ? [...pairs.get(id)] : []; }

function addPair(a, b) {
  if (!pairs.has(a)) pairs.set(a, new Set());
  if (!pairs.has(b)) pairs.set(b, new Set());
  pairs.get(a).add(b); pairs.get(b).add(a);
}
function removePair(a, b) {
  const sa = pairs.get(a); if (sa) { sa.delete(b); if (!sa.size) pairs.delete(a); }
  const sb = pairs.get(b); if (sb) { sb.delete(a); if (!sb.size) pairs.delete(b); }
  if (hosting.get(a) === b) { hosting.delete(a); note("session-end", { host: a, viewer: b }); }
  if (hosting.get(b) === a) { hosting.delete(b); note("session-end", { host: b, viewer: a }); }
}
// A target is busy only while it is being CONTROLLED by someone still around. A PC that is itself controlling
// other PCs (a technician's machine) can still be asked — the client accepts hosting next to its viewer tabs.
function isHostingBusy(target) {
  const viewer = hosting.get(target);
  return !!viewer && (online.has(viewer) || away.has(viewer)) && !!pairs.get(target) && pairs.get(target).has(viewer);
}
function addPending(req, target) {
  if (!pending.has(req)) pending.set(req, new Set());
  pending.get(req).add(target);
}
function removePending(req, target) {
  const s = pending.get(req); if (s) { s.delete(target); if (!s.size) pending.delete(req); }
}

// Drop ONE pairing (id <-> peer) and tell the peer. Leaves the client's OTHER sessions intact. bye = the client
// ended it on purpose (with a short reason), so the peer neither auto-reconnects nor waits for its own timeout.
function unpairPeer(id, peer, bye = null) {
  if (pairs.get(id) && pairs.get(id).has(peer)) {
    removePair(id, peer);
    sendTo(peer, bye ? { type: "peer-disconnected", fromId: id, bye: true, reason: bye.reason } : { type: "peer-disconnected", fromId: id });
  }
}
// Drop ALL of id's pairings and outgoing requests (used on socket close, and for a legacy
// single-session client that sends "disconnect" without a targetId).
function unpairAll(id) {
  for (const peer of peersOf(id)) { removePair(id, peer); sendTo(peer, { type: "peer-disconnected", fromId: id }); }
  if (pending.has(id)) { for (const target of pending.get(id)) sendTo(target, { type: "request-cancelled", fromId: id }); pending.delete(id); }
}

// Evict oldest non-online reserved IDs when the map grows past the cap (Map preserves insert order).
function capOwners() {
  if (owners.size <= OWNERS_CAP) return;
  for (const id of owners.keys()) {
    if (owners.size <= OWNERS_CAP) break;
    if (!online.has(id)) owners.delete(id);
  }
}

// Per-socket flood limiter: a rolling 1s budget for all messages, plus a tighter 10s budget for
// connect-request (stops connection-prompt spam and online password brute-forcing).
function rateOk(ws) {
  const now = Date.now();
  if (now - (ws.rlStart || 0) > 1000) { ws.rlStart = now; ws.rlCount = 0; }
  return (++ws.rlCount) <= MAX_MSG_PER_SEC;
}
function connReqOk(ws) {
  const now = Date.now();
  ws.crTimes = (ws.crTimes || []).filter((t) => now - t < 10000);
  if (ws.crTimes.length >= MAX_CONNREQ_PER_10S) return false;
  ws.crTimes.push(now);
  return true;
}

function register(ws, msg) {
  let id = typeof msg.id === "string" ? msg.id : null;
  const token = typeof msg.token === "string" && msg.token.length >= 16 ? msg.token : null;

  const valid = id && /^\d{3} \d{3} \d{3}$/.test(id) && token;
  const ownedByOther = valid && owners.has(id) && owners.get(id) !== token;
  if (!valid || ownedByOther) id = newId();
  else if (online.has(id) && online.get(id) !== ws) {
    // The SAME device re-registering (same ID + owner token) while its previous socket still looks online:
    // after sleep / a Wi-Fi switch the old half-open socket lingers until the ping sweep notices (25-50s).
    // Handing out a fresh ID here changed the user's ID for good — take the ID over instead. The old socket's
    // close handler ignores it because `online` no longer points at it, so live pairings are kept.
    const old = online.get(id);
    if (owners.get(id) === token) { try { old.terminate(); } catch {} }
    else id = newId();
  }

  const finalToken = token || crypto.randomBytes(16).toString("hex");
  if (owners.get(id) !== finalToken) {
    owners.set(id, finalToken);
    capOwners();
    saveOwners();
  }
  online.set(id, ws);
  ws.clientId = id;
  ws.since = Date.now();
  if (ownerTools) ownerTools.onRegister(ws, msg);
  // Back within the grace period: its pairings are still in place.
  if (away.has(id)) { clearTimeout(away.get(id)); away.delete(id); }
  // Clients from 1.2.1 say which sessions they still have. A pairing the client no longer knows about was left by a
  // previous process (Run as administrator, a crash, quit and reopen): drop it, or it stays "controlling" for good.
  // Older clients send no list and keep the old behaviour.
  if (Array.isArray(msg.live)) {
    const live = new Set(msg.live.filter((p) => typeof p === "string").slice(0, 32));
    for (const peer of peersOf(id)) {
      if (!live.has(peer)) { removePair(id, peer); sendTo(peer, { type: "peer-disconnected", fromId: id }); }
    }
  }
  send(ws, { type: "registered", clientId: id, token: finalToken, iceServers: turnServers(id) });
  console.log(`[+] ${id} (${online.size} online)`);
}

function handle(ws, msg) {
  if (msg.type === "register") {
    if (!ws.clientId) register(ws, msg);
    return;
  }
  const me = ws.clientId;
  if (!me) return;

  switch (msg.type) {
    case "connect-request": {
      // Errors name the request's target so a client with several tabs closes the right one.
      const target = typeof msg.targetId === "string" ? msg.targetId.slice(0, 16) : "";
      if (!connReqOk(ws)) {
        note("ratelimit", { id: me, target });
        send(ws, { type: "error", targetId: target, message: "Terlalu banyak permintaan, coba lagi sebentar" });
        return;
      }
      if (target === me || !online.has(target)) {
        send(ws, { type: "error", targetId: target, message: "ID tidak ditemukan atau sedang offline" });
        return;
      }
      // Block controlling your own PC. A second TryDesk instance on the same device shares the
      // owner token (stored per-machine), so same owner token = same machine even though the two
      // instances have different IDs. Remoting it would cause an infinite screen loop / input bounce.
      const myOwner = owners.get(me);
      if (myOwner && myOwner === owners.get(target)) {
        send(ws, { type: "error", targetId: target, message: "Tidak bisa me-remote PC Anda sendiri" });
        return;
      }
      // Clear stale state before the "busy" check so an abrupt drop never blocks a fresh request,
      // WITHOUT touching this client's other live sessions. Covers: a stale me<->target half-pair,
      // and target pairings to peers that have already gone offline.
      unpairPeer(me, target);
      for (const peer of peersOf(target)) { if (!online.has(peer) && !away.has(peer)) removePair(target, peer); }
      // A host is single-session: busy while someone (still around) is controlling it.
      if (isHostingBusy(target)) {
        send(ws, { type: "error", targetId: target, message: "Remote desktop sedang dalam sesi lain" });
        return;
      }
      addPending(me, target);
      note("request", { from: me, to: target });
      sendTo(target, {
        type: "incoming-connection",
        fromId: me,
        // Only ever a string: String() on a crafted object ({"toString":1}) throws and used to crash the server.
        fromName: (typeof msg.fromName === "string" && msg.fromName.slice(0, 64)) || "TryDesk User",
        // No password here — access-password auth is a server-blind challenge/response (see below).
      });
      break;
    }
    case "cancel-request": {
      // Scoped to a specific target when given (multi-session); legacy clients cancel all.
      if (msg.targetId) {
        if (pending.get(me) && pending.get(me).has(msg.targetId)) {
          removePending(me, msg.targetId);
          sendTo(msg.targetId, { type: "request-cancelled", fromId: me });
        }
      } else if (pending.has(me)) {
        for (const target of pending.get(me)) sendTo(target, { type: "request-cancelled", fromId: me });
        pending.delete(me);
      }
      break;
    }
    case "connection-accepted": {
      const requester = msg.targetId;
      if (!pending.get(requester) || !pending.get(requester).has(me)) return;
      removePending(requester, me);
      unpairPeer(me, requester);          // clear only a stale pairing with this requester
      addPair(me, requester);
      hosting.set(me, requester);         // me (the accepting side) is now being controlled by requester
      note("accepted", { host: me, viewer: requester });
      sendTo(requester, { type: "connection-accepted", fromId: me });
      break;
    }
    case "connection-rejected": {
      const requester = msg.targetId;
      if (!pending.get(requester) || !pending.get(requester).has(me)) return;
      removePending(requester, me);
      const reason = typeof msg.reason === "string" ? msg.reason.slice(0, 160) : "";
      note("rejected", { host: me, viewer: requester, reason });
      sendTo(requester, { type: "connection-rejected", fromId: me, reason });
      break;
    }
    // Server-blind access-password handshake: the server only relays the salt, a one-shot nonce and
    // the viewer's HMAC between a pending pair — it never sees the password. Host → requester.
    case "connection-challenge": {
      const requester = msg.targetId;
      if (!pending.get(requester) || !pending.get(requester).has(me)) return;
      sendTo(requester, {
        type: "connection-challenge", fromId: me,
        salt: typeof msg.salt === "string" ? msg.salt.slice(0, 64) : "",
        nonce: typeof msg.nonce === "string" ? msg.nonce.slice(0, 128) : "",
      });
      break;
    }
    // Requester → host.
    case "connection-response": {
      const targetHost = msg.targetId;
      if (!pending.get(me) || !pending.get(me).has(targetHost)) return;
      sendTo(targetHost, {
        type: "connection-response", fromId: me,
        response: typeof msg.response === "string" ? msg.response.slice(0, 128) : "",
      });
      break;
    }
    case "offer":
    case "answer":
    case "ice-candidate": {
      const peer = msg.targetId;
      if (!peer || !pairs.get(me) || !pairs.get(me).has(peer)) return;
      sendTo(peer, { type: msg.type, fromId: me, offer: msg.offer, answer: msg.answer, candidate: msg.candidate });
      break;
    }
    case "disconnect":
      // Scoped to one peer when given (multi-session); legacy clients drop everything.
      if (msg.targetId) unpairPeer(me, msg.targetId, msg.bye ? { reason: typeof msg.reason === "string" ? msg.reason.slice(0, 120) : "" } : null);
      else unpairAll(me);
      break;
  }
}

// The official TryDesk server loads a few owner-only tools from ./owner-tools (a file or a folder), which is not part
// of the public source. Without it (any self-hosted server) everything here works exactly the same. Only "not there
// at all" is silent: a file missing INSIDE the tools is logged, so a broken install doesn't fail unnoticed.
let ownerTools = null;
try { ownerTools = require("./owner-tools")({ online, hosting, owners }); }
catch (e) {
  const absent = e.code === "MODULE_NOT_FOUND" && !(e.requireStack || []).some((p) => /owner-tools/.test(p));
  if (!absent) console.error("owner-tools:", e.message);
}
function note(type, info) { if (ownerTools) ownerTools.onEvent(type, info); }

// The public page only says the server is up: how many devices are online — let alone which — is nobody's business.
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const noStore = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
  if (ownerTools && ownerTools.handleHttp(req, res, url, noStore)) return;
  res.writeHead(200, noStore);
  res.end("TryDesk signaling server OK\n");
});

// Reject cross-site WebSocket hijacking: the desktop app connects with no browser Origin (or a
// file:// / null origin); a page in someone's browser would send an http(s) Origin — refuse those.
// The Android app (Capacitor) serves its bundle from https://app.trydesk.ai.id inside the WebView; that
// host is ours and never serves a real site, so no third-party page can carry this origin.
const APP_ORIGINS = new Set(["https://app.trydesk.ai.id"]);
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    const ok = !origin || origin === "null" || /^(file|app):\/\//i.test(origin) || APP_ORIGINS.has(origin);
    if (!ok) note("bad-origin", { origin, req });
    return ok;
  },
});

const ipCounts = new Map();

// The client's address. X-Forwarded-For is only believed when the connection itself comes from a local or private
// address (a reverse proxy such as the official Caddy). A server exposed directly would otherwise let any client
// pick its own "IP" and get around the per-IP connection limit.
const PRIVATE_PEER = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;
function clientIp(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || "").replace(/^::ffff:/, "");
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (PRIVATE_PEER.test(peer) && fwd) || peer;
}

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  if (ipCounts.get(ip) > MAX_CONN_PER_IP) {
    ipCounts.set(ip, ipCounts.get(ip) - 1);
    note("ip-limit", { req });
    try { ws.close(1013, "too many connections"); } catch {}
    return;
  }
  ws.isAlive = true;
  if (ownerTools) ownerTools.onConnection(ws, req);
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (data) => {
    if (!rateOk(ws)) return;   // drop floods
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    // One bad message must never take the whole server (and every user's session) down.
    if (msg && typeof msg.type === "string") {
      try { handle(ws, msg); } catch (e) { console.error(`handle(${String(msg.type).slice(0, 32)}) failed: ${e && e.message}`); }
    }
  });

  ws.on("close", () => {
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
    const id = ws.clientId;
    if (!id || online.get(id) !== ws) return;
    // Its own outgoing requests end now. Live PAIRINGS are kept for a short grace period: a Wi-Fi switch or
    // sleep drops only this socket while the peer-to-peer session goes on, and the client re-registers within
    // seconds — dropping the pairing made later renegotiation (codec change) and "disconnect" relays vanish.
    // A client that is really gone loses its P2P link too, so its peer ends the session on its own.
    if (pending.has(id)) { for (const target of pending.get(id)) sendTo(target, { type: "request-cancelled", fromId: id }); pending.delete(id); }
    if (peersOf(id).length) {
      clearTimeout(away.get(id));
      away.set(id, setTimeout(() => { away.delete(id); if (!online.has(id)) unpairAll(id); }, AWAY_GRACE_MS));
    }
    // Tell anyone who was still requesting id that it went offline.
    for (const [req, targets] of pending) {
      if (targets.has(id)) {
        removePending(req, id);
        sendTo(req, { type: "error", targetId: id, message: "Remote desktop offline" });
      }
    }
    online.delete(id);
    note("offline", { id, ws });
    console.log(`[-] ${id} (${online.size} online)`);
  });
});

// Keeps connections alive through proxies (Render/Cloudflare close idle sockets)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`TryDesk signaling server on port ${PORT}`));
