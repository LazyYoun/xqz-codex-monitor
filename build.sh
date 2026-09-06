#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
cd "$ROOT"
ARCH="$(uname -m)"

# 1. 编译 USB helper（发送 show 心跳，识别 XQZ 外接屏）
clang -std=c11 -O2 \
  -I/opt/homebrew/include/libusb-1.0 \
  "$ROOT/helper/xqz-usb-helper.c" \
  /opt/homebrew/lib/libusb-1.0.a \
  -framework IOKit -framework CoreFoundation -framework Security \
  -o "$ROOT/helper/xqz-usb-helper"

# 2. 首次安装依赖并在错过时补齐 Electron 二进制
if [ ! -d node_modules ]; then npm install; fi
if [ ! -f node_modules/electron/path.txt ]; then
  echo "正在修复缺失的 node_modules/electron/path.txt ..."
  ZIPS=("$HOME/Library/Caches/electron/"*/electron-v*-darwin-$ARCH.zip)
  ZIP="${ZIPS[1]}"
  rm -rf node_modules/electron/dist
  if [ -n "$ZIP" ] && [ -f "$ZIP" ]; then
    unzip -q -o "$ZIP" -d node_modules/electron/dist
  else
    (cd node_modules/electron && node install.js)
  fi
  printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
fi

# 3. 手动组装 .app（规避 electron-packager 在本机的 extract-zip 缺陷）
echo "Electron: $(node -p "require('electron/package.json').version")"
APP="$ROOT/dist/XQZ Codex Monitor.app"
rm -rf "$ROOT/dist"
mkdir -p "$ROOT/dist"
cp -R "$ROOT/node_modules/electron/dist/Electron.app" "$APP"

rm -f "$APP/Contents/Resources/"default_app.asar
mkdir -p "$APP/Contents/Resources/app" "$APP/Contents/Resources/helper"
cp "$ROOT/package.json" "$ROOT/main.js" "$ROOT/preload.js" "$APP/Contents/Resources/app/"
cp -R "$ROOT/renderer" "$APP/Contents/Resources/app/renderer"
cp -R "$ROOT/iconTemplate.png" "$APP/Contents/Resources/app/"
cp "$ROOT/helper/xqz-usb-helper" "$APP/Contents/Resources/helper/"

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier xyz.lazyyoun.xqz-codex-monitor" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleName XQZ Codex Monitor" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName XQZ Codex Monitor" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 1.0.0" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 1.0.0" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST"

codesign --force --deep --sign - "$APP"
echo "$APP"