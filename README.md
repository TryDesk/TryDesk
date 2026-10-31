# TryDesk

**Free, open-source remote desktop software.** Control another computer over the
internet — see its screen and use its mouse and keyboard — like TeamViewer or
AnyDesk, but free and self-hostable. It uses a direct peer-to-peer connection
(WebRTC), so your screen and files travel straight between the two computers,
not through a middle server.

Website: [trydesk.ai.id](https://trydesk.ai.id)

> **Status:** early, actively developed by one person. Windows can control and be controlled; Linux (AppImage/deb)
> and Android can control a Windows PC but can't be controlled yet. macOS and iOS are not started. Builds are not
> code-signed yet, so Windows SmartScreen warns on first run; every download's SHA-256 is published on the site.

---

## New to this project? Start here

TryDesk has two parts that work together:

1. **The desktop app** (`src/`) — the program people install and run. It shows
   the screen, sends mouse/keyboard input, and transfers files. Built with
   [Electron](https://www.electronjs.org/) (basically a web app — HTML, CSS,
   JavaScript — wrapped in a desktop window).
2. **The signaling server** (`server/`) — a small Node.js program. When two apps
   want to connect, this server just **introduces them to each other** (exchanges
   their connection details). After that it steps aside — it never sees your
   screen or files.

(The marketing/download site at trydesk.ai.id is maintained separately and isn't
part of this source.)

**How a connection works, in plain terms:** Computer A wants to control
Computer B. Both apps register with the signaling server and get a 9-digit ID.
A enters B's ID, the server passes a few "let's connect" messages between them,
and then A and B talk **directly** to each other (encrypted). If a strict
network blocks the direct path, traffic falls back through a TURN relay server.

If you're new to programming, the friendliest place to read code first is
`src/renderer/app.js` (the app's UI logic) — it's plain JavaScript.

---

## Features

- **Low-latency P2P** — direct WebRTC video + input, no media through the server
- **Instant full resolution** — the remote screen opens sharp, without a ramp-up
- **Game mode** — relative mouse capture so pointer-locking games (Minecraft, FPS) work
- **Full keyboard** — forwards system shortcuts (Alt+Tab, Win) to the remote PC
- **Multi-monitor** — switch between the host's displays mid-session
- **Multi-remote tabs** — control several machines at once, each in its own tab
- **High frame rate** — up to **240 FPS** capture via `getDisplayMedia`; above 120 FPS needs a host monitor that refreshes that fast, and the actual rate depends on the host/viewer hardware and on-screen content
- **Real-time quality control** — bitrate / FPS / resolution + codec (AV1, VP9, VP8, H.264)
- **Two-pane file manager** — browse local & remote folders, transfer both ways
- **Chat** — in-session messaging with in-app and native notifications
- **Clipboard sync & audio** — shared clipboard and remote audio
- **Privacy** — blank the host screen and lock its input during a session
- **Access control** — per-device IDs (regenerate anytime for security), an optional connection password
  (wrong answers are throttled per requester; no password still gets the normal Accept prompt), and host-side
  permissions for control / files / clipboard — view-only also blocks file and clipboard access
- **Session recording** — streamed straight to a .webm file on disk (no RAM build-up on long sessions)
- **Settings that act** — start with Windows, upload bandwidth cap, session time limit, lock Windows after a
  session, keep the display awake while hosting, P2P-only / relay-only, default quality / codec / scale
- **Discord Rich Presence** — shows "Using TryDesk" on your Discord profile (silent if Discord isn't running; can be turned off)
- **Dark & light themes**, full Indonesian / English UI (follows the Windows language until you pick one)
- **Android app (viewer)** — control a Windows PC from your phone: touchpad or direct touch, two-finger
  scroll / right click, pinch zoom, the phone keyboard (autocorrect + emoji) and a special-keys bar. The phone
  controls PCs but can't be controlled itself. ~3 MB APK, Android 7.0+
- **Connect by IP on a LAN** — two devices on one network connect with no internet and no server: off by default,
  local addresses only, and only with an access password of at least 10 characters (see SECURITY.md)
- **Update notice** — the app reads `https://trydesk.ai.id/version.json`: a newer release shows a dismissable notice;
  a version below the published safe minimum refuses connections until it is updated

---

## Architecture

| Piece | Path | Tech |
|-------|------|------|
| Desktop app | `src/` | Electron 45 (main / preload / renderer), `koffi` FFI → `user32.dll` for mouse/keyboard input |
| Android app | `mobile/` | Capacitor 8 wrapping the **same** renderer (`src/renderer`) + a phone layer (touch, keyboard, toolbar) |
| Signaling server | `server/` | Node.js + `ws` WebSocket; relays the handshake, hands out IDs |
| TURN / HTTPS | `deploy/` | Docker Compose: coturn (relay) + Caddy (automatic TLS) + the signaling server |

Media and control data flow **directly between peers** and are end-to-end
encrypted (DTLS-SRTP). The signaling server only brokers the first handshake;
it never sees the screen or files. A TURN relay is used **only** when a direct
peer-to-peer path is impossible.

### Where things live in the code

```
src/                     The desktop app (Electron)
  main.js                  Main process: screen capture, input injection, file IO, window
  preload.js               Safe bridge between the UI and the main process
  input-simulator.js       Native mouse/keyboard + low-level hooks (via koffi)
  discord-rpc.js           Optional Discord Rich Presence (best-effort, silent if unavailable)
  config.json              Which signaling server the app connects to
  renderer/                The UI you see
    index.html               Markup for every screen
    app.js                   All UI logic + WebRTC (the biggest file; start here)
    style.css                Styling + light/dark theme tokens
mobile/                  The Android app (viewer) — see mobile/README.md
  build-www.mjs            Assembles the phone bundle from src/renderer + mobile/web
  web/                     Phone layer: electronAPI shim, touch/keyboard/toolbar, phone CSS
  android/                 Capacitor's Android project (Gradle); native plugins TdScreenPlugin (full screen)
                           and TdLanPlugin (connect by IP)
server/
  signaling-server.js      The "introducer" server
  Dockerfile               How to containerize it
deploy/                    One-command self-hosting (Docker Compose, Caddy, coturn)
  .env.example             Copy to .env and fill in your domain + TURN secret
  setup.sh                 First-time VPS setup helper
assets/                    App icon, logo & UI fonts
scripts/                   Release + build helpers: buat-rilis.ps1 (one-command release), build-linux.sh (WSL),
                           after-pack.js, diagnose.ps1
docs/                      CARA-PAKAI.md: the full setup guide (Bahasa Indonesia)
```

---

## Getting started (run it from source)

**1. Install the tools** (one-time):
- [Node.js](https://nodejs.org/) version 22.12 or newer (this also installs `npm`).
- Building the **desktop app** requires **Windows** (it uses Windows input APIs).

**2. Get the code and its dependencies:** clone the repo from GitHub, or download the source zip from
<https://trydesk.ai.id/source/> (every version is listed there with its SHA-256) and unzip it. Then:

```bash
git clone https://github.com/TryDesk/TryDesk.git
cd TryDesk
npm install          # downloads the libraries listed in package.json
```

You can also read every file online at <https://github.com/TryDesk/TryDesk> or <https://trydesk.ai.id/source/code/>.

**3. Run it in development:**

```bash
npm run dev          # starts the signaling server AND the app together
```

By default the app connects to the public signaling server. To use your own,
edit `src/config.json` and change `signalingServer` to your server's address.

### Build the Windows app (creates the .exe files)

```bash
npm run build            # portable + installer  ->  dist/
npm run build:portable   # portable .exe only
npm run build:installer  # NSIS installer only
```

The finished files appear in the `dist/` folder. Each build also writes its size + SHA-256; users can check a
download with `Get-FileHash .\TryDesk-Portable-<version>.exe` (PowerShell).

### Build the Android app (APK)

Needs JDK 21 and the Android SDK (platform 36). Details in [`mobile/README.md`](mobile/README.md).

```bash
cd mobile
npm install
npm run apk:debug        # -> mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

### Self-host the signaling server

You only need this if you want to run your own server instead of the public one.

```bash
cd deploy
cp .env.example .env      # then open .env and set your domain + a TURN secret
docker compose up -d --build
```

Caddy automatically gets an HTTPS certificate for your domain, and coturn
provides the TURN relay. `deploy/setup.sh` walks through a full first-time
setup on a fresh Ubuntu server.

---

## Troubleshooting

- **`npm install` fails** — make sure Node.js 22.12+ is installed: run `node -v`.
- **App won't start / blank window** — some GPUs need software rendering; launch
  with `--no-gpu`. Startup problems are logged to
  `%APPDATA%\TryDesk\trydesk-crash.log` (see `scripts/diagnose.ps1`).
- **Windows Sandbox / Hyper-V VM shuts down when a session starts** — GPU-accelerated
  screen capture through a virtual GPU (GPU-PV) can terminate the whole VM. TryDesk
  detects Windows Sandbox and Hyper-V guests and runs in software mode there
  (`--force-gpu` overrides).
- **A monitor can't be selected / shows another screen** — on some PCs (HDR on,
  or a monitor on a second GPU) Windows' default capturer can't see that monitor.
  TryDesk detects this at launch and restarts once with Windows Graphics Capture.
  Each capture and re-capture is logged to `%APPDATA%\TryDesk\trydesk-crash.log`.
- **"Unknown publisher" warning on Windows** — the app isn't signed with a paid
  certificate yet. It's safe to run (open-source, you can read every line).
  Code signing is planned.
- **Connection always uses the relay / fails** — a strict firewall is blocking
  the direct path; this is normal on some networks and still works.

---

## Contributing

Issues and pull requests on [GitHub](https://github.com/TryDesk/TryDesk) are welcome — including from first-time
contributors. No GitHub account? Email support@trydesk.ai.id instead.
Please keep the UI consistent with the existing design and test your changes in
the app before submitting. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for a
beginner-friendly walkthrough, and [`SECURITY.md`](SECURITY.md) to report a
vulnerability privately.

## License

Copyright © 2026 DrWeabo. TryDesk is free software under the
**GNU Affero General Public License v3.0** ([`LICENSE`](LICENSE), see also
[`NOTICE`](NOTICE)): you may use, study, modify and share it for free. If you
distribute a modified version — or let people use it over a network — you must
publish its source code under the same licence and keep the copyright notices and
the "Made by DrWeabo" credit.

TryDesk 1.1.1 and earlier were released under the MIT License; 1.2.0 and later
are AGPL-3.0-only.

The **TryDesk name and logo are trademarks** and are not covered by the licence:
modified versions must use their own name. See [`TRADEMARK.md`](TRADEMARK.md).
Official downloads: [trydesk.ai.id](https://trydesk.ai.id).
</content>
