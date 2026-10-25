// ─── Discord Rich Presence ────────────────────────────────────────────────
// Shows "Using TryDesk" (with a clickable "Download TryDesk" button → trydesk.ai.id) on the user's
// Discord profile while the app runs — free word-of-mouth promotion. Everything here is best-effort and
// SILENT: if Discord isn't running, the Client ID isn't configured, or the IPC pipe is missing, it simply
// does nothing and never affects the app. The Client ID is PUBLIC (not a secret), so it ships in source.
//
// SETUP (one-time, by the maintainer):
//   1. https://discord.com/developers/applications → New Application → name it "TryDesk".
//   2. Copy the Application ID (= Client ID) into CLIENT_ID below (or set env TRYDESK_DISCORD_CLIENT_ID).
//   3. Rich Presence → Art Assets → upload the TryDesk logo, name it exactly  trydesk_logo .
// Until a real ID is set, this module stays dormant.

let DiscordRPC = null;
try { DiscordRPC = require("discord-rpc"); } catch { /* dependency missing — stay dormant */ }

const CLIENT_ID = process.env.TRYDESK_DISCORD_CLIENT_ID || "1563218800206155776";
const DOWNLOAD_URL = "https://trydesk.ai.id";

let rpc = null;
let ready = false;
let started = false;
let startTimestamp = Date.now();
let pendingState = "idle";
let retryTimer = null;
let log = () => {};

function activityFor(state) {
  const base = {
    startTimestamp,
    largeImageKey: "trydesk_logo",
    largeImageText: "TryDesk — Remote Desktop gratis",
    instance: false,
    buttons: [{ label: "Unduh TryDesk", url: DOWNLOAD_URL }],
  };
  if (state === "hosting") return { ...base, details: "Membagikan layar", state: "Dikontrol dari jarak jauh" };
  if (state === "viewing") return { ...base, details: "Mengontrol PC jarak jauh", state: "Sesi remote aktif" };
  return { ...base, details: "Remote Desktop gratis", state: "Sedang idle" };
}

// discord-rpc returns promises that can reject ASYNCHRONOUSLY (e.g. closing a client whose IPC socket is
// null when Discord isn't running → "Cannot read properties of null (reading 'write')"). Every call below
// swallows both sync throws AND async rejections so nothing ever bubbles to process 'unhandledRejection'.
function quiet(p) { try { if (p && typeof p.catch === "function") p.catch(() => {}); } catch {} }
function safeDestroy(client) { if (!client) return; try { quiet(client.destroy && client.destroy()); } catch {} }

function push() {
  if (!rpc || !ready) return;
  try { quiet(rpc.setActivity(activityFor(pendingState))); } catch (e) { log("discord setActivity failed: " + e.message); }
}

// state: "idle" | "hosting" | "viewing"
function setActivity(state) {
  pendingState = state || "idle";
  push();
}

function connect() {
  if (!DiscordRPC || rpc) return;
  if (!CLIENT_ID || CLIENT_ID === "YOUR_DISCORD_CLIENT_ID") return;   // not configured yet
  let client;
  try { client = new DiscordRPC.Client({ transport: "ipc" }); }
  catch (e) { log("discord RPC init error: " + e.message); return; }
  rpc = client;
  client.on("ready", () => { ready = true; log("discord RPC connected"); push(); });
  client.on("disconnected", () => { ready = false; if (rpc === client) rpc = null; });   // let retry reconnect
  // login() rejects when Discord isn't running (common!). Swallow it and just DROP the reference — do NOT
  // call destroy() on a never-connected client (that throws on a null IPC socket). quiet() guards the async reject.
  try {
    quiet(client.login({ clientId: CLIENT_ID }).catch((e) => {
      log("discord RPC login failed (Discord not running?): " + (e && e.message));
      if (rpc === client) { rpc = null; ready = false; }
    }));
  } catch (e) { log("discord RPC login threw: " + e.message); if (rpc === client) rpc = null; }
}

// Start trying to connect; retry quietly every 30s so opening Discord later still lights up the presence.
function init(logger) {
  if (started) return;
  started = true;
  if (typeof logger === "function") log = logger;
  if (!DiscordRPC) { log("discord-rpc dependency not installed — presence disabled"); return; }
  if (!CLIENT_ID || CLIENT_ID === "YOUR_DISCORD_CLIENT_ID") { log("discord RPC: no Client ID set — presence disabled"); return; }
  connect();
  // Retry only when there's no client at all (login failure nulls it). Never destroy here — just reconnect.
  retryTimer = setInterval(() => { if (!rpc) connect(); }, 30000);
}

function shutdown() {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  const client = rpc; rpc = null; ready = false;
  if (client) { try { quiet(client.clearActivity && client.clearActivity()); } catch {} safeDestroy(client); }
}

module.exports = { init, setActivity, shutdown };
