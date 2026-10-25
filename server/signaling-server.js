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
}
function addPending(req, target) {
  if (!pending.has(req)) pending.set(req, new Set());
  pending.get(req).add(target);
}
function removePending(req, target) {
  const s = pending.get(req); if (s) { s.delete(target); if (!s.size) pending.delete(req); }
}

// Drop ONE pairing (id <-> peer) and tell the peer. Leaves the client's OTHER sessions intact.
function unpairPeer(id, peer) {
  if (pairs.get(id) && pairs.get(id).has(peer)) {
    removePair(id, peer);
    sendTo(peer, { type: "peer-disconnected", fromId: id });
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
  if (!valid || ownedByOther || online.has(id)) id = newId();

  const finalToken = token || crypto.randomBytes(16).toString("hex");
  if (owners.get(id) !== finalToken) {
    owners.set(id, finalToken);
    capOwners();
    saveOwners();
  }
  online.set(id, ws);
  ws.clientId = id;
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
      if (!connReqOk(ws)) { send(ws, { type: "error", message: "Terlalu banyak permintaan, coba lagi sebentar" }); return; }
      const target = msg.targetId;
      if (target === me || !online.has(target)) {
        send(ws, { type: "error", message: "ID tidak ditemukan atau sedang offline" });
        return;
      }
      // Block controlling your own PC. A second TryDesk instance on the same device shares the
      // owner token (stored per-machine), so same owner token = same machine even though the two
      // instances have different IDs. Remoting it would cause an infinite screen loop / input bounce.
      const myOwner = owners.get(me);
      if (myOwner && myOwner === owners.get(target)) {
        send(ws, { type: "error", message: "Tidak bisa me-remote PC Anda sendiri" });
        return;
      }
      // Clear stale state before the "busy" check so an abrupt drop never blocks a fresh request,
      // WITHOUT touching this client's other live sessions. Covers: a stale me<->target half-pair,
      // and target pairings to peers that have already gone offline.
      unpairPeer(me, target);
      for (const peer of peersOf(target)) { if (!online.has(peer)) removePair(target, peer); }
      // A host is single-session: if the target still has any online peer, it's busy.
      if (peersOf(target).some((p) => online.has(p))) {
        send(ws, { type: "error", message: "Remote desktop sedang dalam sesi lain" });
        return;
      }
      addPending(me, target);
      sendTo(target, {
        type: "incoming-connection",
        fromId: me,
        fromName: String(msg.fromName || "TryDesk User").slice(0, 64),
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
      sendTo(requester, { type: "connection-accepted", fromId: me });
      break;
    }
    case "connection-rejected": {
      const requester = msg.targetId;
      if (!pending.get(requester) || !pending.get(requester).has(me)) return;
      removePending(requester, me);
      sendTo(requester, { type: "connection-rejected", fromId: me, reason: msg.reason || "" });
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
      if (msg.targetId) unpairPeer(me, msg.targetId);
      else unpairAll(me);
      break;
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`TryDesk signaling server OK - ${online.size} online\n`);
});

// Reject cross-site WebSocket hijacking: the desktop app connects with no browser Origin (or a
// file:// / null origin); a page in someone's browser would send an http(s) Origin — refuse those.
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
  verifyClient: ({ origin }) => !origin || origin === "null" || /^(file|app):\/\//i.test(origin),
});

const ipCounts = new Map();

wss.on("connection", (ws, req) => {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "";
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  if (ipCounts.get(ip) > MAX_CONN_PER_IP) {
    ipCounts.set(ip, ipCounts.get(ip) - 1);
    try { ws.close(1013, "too many connections"); } catch {}
    return;
  }
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (data) => {
    if (!rateOk(ws)) return;   // drop floods
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg.type === "string") handle(ws, msg);
  });

  ws.on("close", () => {
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
    const id = ws.clientId;
    if (!id || online.get(id) !== ws) return;
    unpairAll(id);   // drop all of id's pairings + its own outgoing requests
    // Tell anyone who was still requesting id that it went offline.
    for (const [req, targets] of pending) {
      if (targets.has(id)) {
        removePending(req, id);
        sendTo(req, { type: "error", message: "Remote desktop offline" });
      }
    }
    online.delete(id);
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
