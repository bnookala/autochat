#!/usr/bin/env bash
# Assembles macos/build/LolChat.app from the SwiftPM release binary, Info.plist and a
# generated icon, then ad-hoc codesigns it.
#
#   macos/scripts/build-app.sh            build macos/build/LolChat.app
#   macos/scripts/build-app.sh --install  …and copy it to ~/Applications
set -euo pipefail

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
APP="$BUILD/LolChat.app"
cd "$ROOT"

echo "==> swift build -c release"
swift build -c release --product LolChat
BIN="$(swift build -c release --show-bin-path)/LolChat"

echo "==> assembling $APP"
rm -rf "$APP" "$BUILD/AppIcon.iconset"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/LolChat"
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> rendering icon"
if "$BIN" --render-icon "$BUILD/AppIcon.iconset" && iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"; then
  rm -rf "$BUILD/AppIcon.iconset"
else
  echo "warning: couldn't render the app icon; continuing without it" >&2
fi

echo "==> codesign (ad-hoc)"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict --verbose=1 "$APP"

if [[ "$INSTALL" == 1 ]]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  if pgrep -x LolChat >/dev/null; then
    echo "note: LolChat is running; quit it to pick up the new build" >&2
  fi
  rm -rf "$DEST/LolChat.app"
  cp -R "$APP" "$DEST/"
  echo "==> installed $DEST/LolChat.app"
fi

echo "done: $APP"
