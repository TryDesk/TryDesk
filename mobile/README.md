# TryDesk for Android (viewer)

Control a Windows PC from an Android phone. The phone app is a **viewer only**: it connects to PCs running
TryDesk, but it never shares its own screen (incoming requests are refused with a clear message).

## How it is built

One code base: the Android app runs the **desktop renderer unchanged** (`src/renderer/index.html`, `app.js`,
`style.css`) inside a WebView (Capacitor 8). `build-www.mjs` copies it into `mobile/www/` and adds three files
from `mobile/web/`:

| File | What it does |
|------|--------------|
| `mobile-shim.js` | Stands in for Electron's `window.electronAPI` (loaded before `app.js`). Viewer calls work; every host-side call (capture, input injection, local files) answers "not available". |
| `mobile.js` | The phone layer (loaded after `app.js`): touch → mouse (touchpad / direct touch, two-finger scroll and right click, pinch zoom), phone keyboard (text is diffed, so autocorrect and predictions type correctly), special-keys bar with sticky Ctrl/Alt/Shift/Win, floating toolbar, Android Back button, screen wake lock, viewer-only rules. |
| `mobile.css` | Phone layout over the desktop design tokens (bottom-sheet Control Center, full-screen settings). |

Typing from the phone uses the host action `{ action: "type", text }` (Unicode `SendInput` in
`src/input-simulator.js`), so the PC must run TryDesk 1.1.0 or newer.

The app is served from `https://app.trydesk.ai.id` inside the WebView (`capacitor.config.json` →
`server.hostname`); the signaling server accepts exactly that origin besides the desktop app.

## Build

Requirements: Node.js 22.12+, JDK 21, Android SDK with `platforms;android-36`, `build-tools;36.1.0`,
`platform-tools` (set `ANDROID_HOME` or keep the SDK in `%LOCALAPPDATA%\Android\Sdk`).

```bash
cd mobile
npm install
npm run apk:debug      # debug APK (WebView debugging on)  -> android/app/build/outputs/apk/debug/
npm run apk:release    # release APK                       -> android/app/build/outputs/apk/release/
```

`scripts/buat-rilis.ps1` builds the release APK automatically and puts it on the downloads page as
`TryDesk-Android-<version>.apk` (size + SHA-256 stamped like the Windows builds).

### Release signing

The signing key is **never** inside the repo. Gradle reads
`%USERPROFILE%\.trydesk\android-signing.properties` (or the file named by `TRYDESK_ANDROID_SIGNING`):

```properties
storeFile=C:/Users/<you>/.trydesk/trydesk-android-release.jks
storePassword=...
keyAlias=trydesk
keyPassword=...
```

Without that file `assembleRelease` produces an unsigned APK. Back the key up: every update must be signed
with the same key, or Android refuses to install it over the old version.

## Test without a phone

- Debug APK in the Android Emulator: `adb install -r app-debug.apk`, then
  `adb forward tcp:9444 localabstract:webview_devtools_remote_<pid>` and drive it over Chrome DevTools.
- Real phone: enable USB debugging, `adb install`, and inspect it in `chrome://inspect`.
