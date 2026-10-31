#!/bin/bash
# Builds TryDesk for Linux (AppImage + .deb, x64) inside WSL Ubuntu, without sudo. buat-rilis.ps1 runs it with the
# project folder as seen from WSL (/mnt/c/...); the packages land in <project>/dist-linux/.
# Uses a portable Node in ~/.local/node and a clean copy of the app sources in ~/trydesk-build, so the Windows
# node_modules (with Windows-only native files) are never mixed in.
set -euo pipefail
SRC="${1:?usage: build-linux.sh /mnt/c/path/to/project}"
NODE_VER="v22.23.4"
NODE_DIR="$HOME/.local/node"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "-- Node $NODE_VER (nodejs.org) -> $NODE_DIR"
  mkdir -p "$NODE_DIR"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.gz" | tar -xz -C "$NODE_DIR" --strip-components=1
fi
export PATH="$NODE_DIR/bin:$PATH"

B="$HOME/trydesk-build"
rm -rf "$B/src" "$B/assets" "$B/scripts" "$B/dist"
mkdir -p "$B/scripts"
cp -r "$SRC/src" "$SRC/assets" "$B/"
cp "$SRC/scripts/after-pack.js" "$B/scripts/"
cp "$SRC/package.json" "$SRC/package-lock.json" "$SRC/LICENSE" "$SRC/NOTICE" "$SRC/TRADEMARK.md" "$B/"
cd "$B"
npm ci --no-audit --no-fund --loglevel=error
npx electron-builder --linux AppImage deb --x64 --publish never

OUT="$SRC/dist-linux"
rm -rf "$OUT"; mkdir -p "$OUT"
cp dist/*.AppImage dist/*.deb "$OUT/"
echo "-- Linux packages:"
(cd "$OUT" && ls -la && sha256sum *)
