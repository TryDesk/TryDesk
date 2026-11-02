// Signs website/update/version.json with the owner's Ed25519 key (%USERPROFILE%\.trydesk\version-signing.pem, never
// in the project or on the website). TryDesk 1.3.3+ checks the signature (main.js: versionJsonSigned) and ignores an
// unsigned or altered file, so a break-in at the web hosting can't force an update or disable every app.
// Run by buat-rilis.ps1 after it sets "latest"; run it by hand after editing the notes or "minimum".
//   node scripts/sign-version.mjs            signs website/update/version.json (and the release copy if present)
//   node scripts/sign-version.mjs --check    only verifies
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = path.join(os.homedir(), ".trydesk", "version-signing.pem");
const PUB = "MCowBQYDK2VwAyEALmgxboidf3mbPwbQKUYPidxLPlSdMvgjQle1fXxJu6E=";   // must match VERSION_JSON_PUBKEY in src/main.js
const files = ["website/update/version.json", "rilis/filezilla-website/update/version.json"].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));
if (!files.length) { console.error("version.json not found under " + ROOT); process.exit(1); }
const canonical = (j) => JSON.stringify({ latest: j.latest, minimum: j.minimum || "", url: j.url, notes: { id: j.notes.id, en: j.notes.en } });
const check = process.argv.includes("--check");
const pub = crypto.createPublicKey({ key: Buffer.from(PUB, "base64"), format: "der", type: "spki" });
let bad = 0;
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!check) {
    if (!fs.existsSync(KEY)) { console.error("signing key not found: " + KEY); process.exit(1); }
    const priv = crypto.createPrivateKey(fs.readFileSync(KEY, "utf8"));
    j.sig = crypto.sign(null, Buffer.from(canonical(j), "utf8"), priv).toString("base64");
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", "utf8");
  }
  const ok = typeof j.sig === "string" && crypto.verify(null, Buffer.from(canonical(j), "utf8"), pub, Buffer.from(j.sig, "base64"));
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BAD "} ${path.relative(ROOT, f)}  latest ${j.latest}, minimum ${j.minimum || "-"}`);
}
if (bad) process.exit(1);
