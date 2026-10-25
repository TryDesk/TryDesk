# Contributing to TryDesk

Thanks for your interest in improving TryDesk! Issues and pull requests are welcome.

## Project layout

```
src/            Electron desktop app (main / preload / renderer, native input via koffi)
server/         Node.js + ws signaling server
deploy/         Docker Compose: coturn (TURN) + Caddy (TLS) + signaling
assets/         App icon, logo & UI fonts
```

See [`README.md`](README.md) for the architecture overview.

## Getting started

Requirements: **Node.js 18+** and npm (Windows is needed to build the desktop app).

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
   git clone https://github.com/YOUR-USERNAME/trydesk.git
   cd trydesk
   npm install
   ```
3. **Make a branch** for your change:
   ```bash
   git checkout -b fix-typo-in-settings
   ```
4. **Edit the code.** Not sure where to look? `src/renderer/app.js` is the UI
   logic, `src/renderer/index.html` is the markup, `src/renderer/style.css` is
   the styling. Run `npm run dev` to see your change live.
5. **Commit** with a clear message:
   ```bash
   git add .
   git commit -m "Fix typo in settings panel"
   ```
6. **Push** to your fork and open a **Pull Request** on GitHub:
   ```bash
   git push origin fix-typo-in-settings
   ```

Good first contributions: fixing typos, improving a translation
(`src/renderer/app.js` → the `I18N` object), small UI polish, or clarifying docs. Ask questions in an issue if
you're stuck — beginners are welcome.

## Pull requests

- Keep the UI consistent with the existing design, and **verify your change in the
  running app** (not just in tests) before submitting.
- Keep commits focused; describe what changed and why.
- Match the surrounding code style (no framework churn, minimal dependencies).
- Don't commit secrets, `.env` files, certificates, or build output — see
  [`.gitignore`](.gitignore).

## Reporting bugs

Open an issue with your OS/version, clear reproduction steps, and the crash log if
the app failed to start (`%APPDATA%\TryDesk\trydesk-crash.log` on Windows).

## Security

Please do **not** open public issues for security vulnerabilities — see
[`SECURITY.md`](SECURITY.md).

By contributing, you agree your contributions are licensed under the MIT License.
