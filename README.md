# TryDesk

**Free, open-source remote desktop software.** Control another computer over the
internet — see its screen and use its mouse and keyboard — like TeamViewer or
AnyDesk, but free and self-hostable. It uses a direct peer-to-peer connection
(WebRTC), so your screen and files travel straight between the two computers,
not through a middle server.

Website: [trydesk.ai.id](https://trydesk.ai.id)

> **Status:** the Windows build is ready to use. macOS, Linux, iOS and Android
> are planned.

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
- **High frame rate** — up to **240 FPS** capture via `getDisplayMedia` (144/165/180/240 for high-refresh displays); the actual rate depends on the host/viewer hardware and on-screen content
- **Real-time quality control** — bitrate / FPS / resolution + codec (AV1, VP9, VP8, H.264)
- **Two-pane file manager** — browse local & remote folders, transfer both ways
- **Chat** — in-session messaging with in-app and native notifications
- **Clipboard sync & audio** — shared clipboard and remote audio
- **Privacy** — blank the host screen and lock its input during a session
- **Access control** — per-device IDs (regenerate anytime for security) with an optional connection password
- **Discord Rich Presence** — shows "Using TryDesk" on your Discord profile (silent if Discord isn't running)
- **Dark & light themes**, Indonesian / English UI

---

## Architecture

| Piece | Path | Tech |
|-------|------|------|
| Desktop app | `src/` | Electron (main / preload / renderer), `koffi` FFI → `user32.dll` for mouse/keyboard input |
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
server/
  signaling-server.js      The "introducer" server
  Dockerfile               How to containerize it
deploy/                    One-command self-hosting (Docker Compose, Caddy, coturn)
  .env.example             Copy to .env and fill in your domain + TURN secret
  setup.sh                 First-time VPS setup helper
assets/                    App icon, logo & UI fonts
.github/workflows/         CI: builds the Windows app (and signs it once signing is set up)
```

---

## Getting started (run it from source)

**1. Install the tools** (one-time):
- [Node.js](https://nodejs.org/) version 18 or newer (this also installs `npm`).
- [Git](https://git-scm.com/) to clone the project.
- Building the **desktop app** requires **Windows** (it uses Windows input APIs).

**2. Get the code and its dependencies:**

```bash
git clone https://github.com/TryDesk/trydesk.git
cd trydesk
npm install          # downloads the libraries listed in package.json
```

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

The finished files appear in the `dist/` folder.

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

- **`npm install` fails** — make sure Node.js 18+ is installed: run `node -v`.
- **App won't start / blank window** — some GPUs need software rendering; launch
  with `--no-gpu`. Startup problems are logged to
  `%APPDATA%\TryDesk\trydesk-crash.log` (see `diagnose.ps1`).
- **"Unknown publisher" warning on Windows** — the app isn't signed with a paid
  certificate yet. It's safe to run (open-source, you can read every line).
  Code signing is planned.
- **Connection always uses the relay / fails** — a strict firewall is blocking
  the direct path; this is normal on some networks and still works.

---

## Contributing

Issues and pull requests are welcome — including from first-time contributors.
Please keep the UI consistent with the existing design and test your changes in
the app before submitting. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for a
beginner-friendly walkthrough, and [`SECURITY.md`](SECURITY.md) to report a
vulnerability privately.

## License

Released under the MIT License — free to use, modify, and share. See
[`LICENSE`](LICENSE).
</content>
