# Contributing to TryDesk

Thanks for your interest in improving TryDesk! Issues and pull requests are welcome on
<https://github.com/TryDesk/TryDesk>. No GitHub account? Email **support@trydesk.ai.id** — the source is also on
<https://trydesk.ai.id/source/> (zip per version) and <https://trydesk.ai.id/source/code/> (read online).

## Project layout

```
src/            Electron desktop app (main / preload / renderer, native input via koffi)
server/         Node.js + ws signaling server
deploy/         Docker Compose: coturn (TURN) + Caddy (TLS) + signaling
assets/         App icon, logo & UI fonts
mobile/         Android viewer app (Capacitor)
scripts/        Build helpers
docs/           Guides
```

See [`README.md`](README.md) for the architecture overview.

## Getting started

Requirements: **Node.js 22.12+** and npm (Windows is needed to build the desktop app).

```bash
npm install
npm run dev        # runs the signaling server + the Electron app together
```

Point the app at your own signaling server in `src/config.json`.

### Build the Windows app

```bash
npm run build            # portable + installer -> dist/
```

### Run the signaling server only

```bash
npm run server
```

## New to open source? The whole flow

Never sent a pull request before? Here's every step:

1. **Fork** this repo (the "Fork" button on GitHub) — this makes your own copy.
2. **Clone** your fork and install dependencies:
   ```bash
   git clone https://github.com/YOUR-USERNAME/TryDesk.git
   cd TryDesk
   npm install
   ```
3. **Make a branch** for your change: `git checkout -b fix-typo-in-settings`
4. **Edit the code.** Not sure where to look? `src/renderer/app.js` is the UI
   logic, `src/renderer/index.html` is the markup, `src/renderer/style.css` is
   the styling. Run `npm run dev` to see your change live.
5. **Commit** with a clear message (`git commit -am "Fix typo in settings panel"`), **push** to your fork
   (`git push origin fix-typo-in-settings`) and open a **Pull Request** on GitHub.

### Without GitHub: send a patch by email

1. **Download** the newest source zip from <https://trydesk.ai.id/source/> and unzip it.
   Keep a second, untouched copy: you'll compare against it at the end.
2. **Install** the dependencies:
   ```bash
   cd TryDesk-Source-<version>
   npm install
   ```
3. **Edit the code.** Not sure where to look? `src/renderer/app.js` is the UI
   logic, `src/renderer/index.html` is the markup, `src/renderer/style.css` is
   the styling. Run `npm run dev` to see your change live.
4. **Make a patch** that holds only your change (Git can compare two folders even outside a repository):
   ```bash
   git diff --no-index TryDesk-Source-<version>-original TryDesk-Source-<version> > my-change.patch
   ```
   No Git? Zip just the files you changed instead.
5. **Email** the patch (or zip) to **support@trydesk.ai.id**, saying which version you started from, what
   you changed and why.

Good first contributions: fixing typos, improving a translation
(`src/renderer/app.js` → the `TEXT_EN` map), small UI polish, or clarifying docs. Ask questions in an issue or by email if
you're stuck — beginners are welcome.

## Sending changes

- Keep the UI consistent with the existing design, and **verify your change in the
  running app** (not just in tests) before submitting.
- Keep commits focused; describe what changed and why.
- Match the surrounding code style (no framework churn, minimal dependencies).
- Don't commit secrets, `.env` files, certificates, or build output — see
  [`.gitignore`](.gitignore).

## Reporting bugs

Open a GitHub issue (or email support@trydesk.ai.id) with your OS/version, clear reproduction steps, and the crash log if
the app failed to start (`%APPDATA%\TryDesk\trydesk-crash.log` on Windows).

## Security

Please do **not** open public issues for security vulnerabilities — see
[`SECURITY.md`](SECURITY.md).

## Licence of your contribution

By contributing, you agree that your contribution is licensed under the GNU
AGPL-3.0 (the project's licence), and that DrWeabo may also distribute it under
other licence terms in future versions of TryDesk. You keep the copyright of your
own work, and you confirm you have the right to submit it.

Forks are welcome under the AGPL — please read [`TRADEMARK.md`](TRADEMARK.md):
a modified version needs its own name and logo.
