#!/bin/bash
# Builds the macOS zips (Apple Silicon + Intel) inside WSL Ubuntu, so a release needs no Mac. buat-rilis.ps1 runs it
# with the project folder as seen from WSL (/mnt/c/...); the zips land in <project>/dist-mac/.
# electron-builder cannot sign on Linux, so the app keeps Electron's own ad-hoc signatures on every binary (enough
# for Apple Silicon to run it); users clear the download quarantine once with `xattr -cr` (docs, "Memasang di Mac").
# On a real Mac, scripts/build-mac.sh builds the same zips with a full ad-hoc signature instead.
set -euo pipefail
SRC="${1:?usage: build-mac-wsl.sh /mnt/c/path/to/project}"
NODE_VER="v22.23.4"
NODE_DIR="$HOME/.local/node"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "-- Node $NODE_VER (nodejs.org) -> $NODE_DIR"
  mkdir -p "$NODE_DIR"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.gz" | tar -xz -C "$NODE_DIR" --strip-components=1
fi
export PATH="$NODE_DIR/bin:$PATH"

B="$HOME/trydesk-build-mac"
rm -rf "$B/src" "$B/assets" "$B/scripts" "$B/dist"
mkdir -p "$B/scripts"
cp -r "$SRC/src" "$SRC/assets" "$B/"
cp "$SRC/scripts/after-pack.js" "$B/scripts/"
cp "$SRC/package.json" "$SRC/package-lock.json" "$SRC/LICENSE" "$SRC/NOTICE" "$SRC/TRADEMARK.md" "$B/"
cd "$B"
npm ci --no-audit --no-fund --loglevel=error
npx electron-builder --mac zip --arm64 --x64 --publish never

OUT="$SRC/dist-mac"
rm -rf "$OUT"; mkdir -p "$OUT"
cp dist/*-mac-arm64.zip dist/*-mac-x64.zip "$OUT/"
echo "-- macOS zips:"
(cd "$OUT" && ls -la && sha256sum *)
# The build copy is ~900 MB and npm ci reinstalls it anyway next time; Electron's download cache (~/.cache) stays.
cd "$HOME" && rm -rf "$B"
