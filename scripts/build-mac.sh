#!/bin/bash
# Builds TryDesk for macOS (viewer: controls Windows PCs) ON A MAC: one .zip per chip, each holding TryDesk.app,
# ad-hoc signed (no Apple Developer account, so users clear the download quarantine once with `xattr -cr`).
# Run it from the unpacked source folder:   bash scripts/build-mac.sh
# Output: dist/TryDesk-<version>-mac-arm64.zip (Apple Silicon, M1 and newer) and dist/TryDesk-<version>-mac-x64.zip
# (Intel Macs). Copy both into the Windows project's rilis\filezilla-website\downloads\mac\ before buat-rilis.ps1.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$1"; }
fail() { printf '\nGAGAL: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "skrip ini harus dijalankan di Mac (macOS)."

say "Cek Node.js (butuh 22.12 atau lebih baru)"
command -v node >/dev/null || fail "Node.js belum terpasang. Unduh versi LTS dari https://nodejs.org lalu jalankan lagi."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || fail "Node.js $(node -v) terlalu lama. Pasang versi LTS terbaru dari https://nodejs.org."
echo "Node $(node -v), npm $(npm -v), macOS $(sw_vers -productVersion) $(uname -m)"

say "Pasang dependensi (npm ci)"
npm ci --no-audit --no-fund --loglevel=error

say "Build TryDesk untuk Apple Silicon + Intel"
rm -rf dist
npm run build:mac

VER="$(node -p 'require("./package.json").version')"
say "Cek hasil"
# electron-builder unpacks the Apple Silicon app to dist/mac-arm64/ and the Intel one to dist/mac/.
for PAIR in "arm64:dist/mac-arm64/TryDesk.app" "x64:dist/mac/TryDesk.app"; do
  ARCH="${PAIR%%:*}"; APP="${PAIR#*:}"
  Z="dist/TryDesk-$VER-mac-$ARCH.zip"
  [ -f "$Z" ] || fail "$Z tidak terbentuk."
  [ -d "$APP" ] || fail "$APP tidak ditemukan."
  codesign --verify --deep "$APP" || fail "tanda tangan ad-hoc $APP tidak valid (aplikasi tidak akan mau dibuka di Mac)."
  echo "$ARCH: $Z, tanda tangan ad-hoc OK"
done
echo
ls -lh dist/*.zip
echo
shasum -a 256 dist/*.zip
say "Selesai. Salin kedua file .zip di atas ke PC Windows: rilis\\filezilla-website\\downloads\\mac\\"
