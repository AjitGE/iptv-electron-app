#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  Install Custom Electron with AC-3 + HEVC codecs            ║
# ║                                                              ║
# ║  Run this AFTER you have dist.zip from the build process     ║
# ║  or from a CI/CD pipeline.                                   ║
# ╚══════════════════════════════════════════════════════════════╝
set -euo pipefail

DIST_ZIP="${1:-}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "$DIST_ZIP" ]; then
    echo "Usage: $0 <path-to-dist.zip>"
    echo ""
    echo "This replaces the stock Electron in node_modules with a"
    echo "custom build that supports HEVC, AC-3, and E-AC-3 codecs."
    echo ""
    echo "Get dist.zip by:"
    echo "  1. Running build-electron-ac3.sh on a powerful machine"
    echo "  2. Or from the GitHub Actions build artifact"
    exit 1
fi

if [ ! -f "$DIST_ZIP" ]; then
    echo "Error: File not found: $DIST_ZIP"
    exit 1
fi

ELECTRON_DIST="$APP_DIR/node_modules/electron/dist"

if [ ! -d "$ELECTRON_DIST" ]; then
    echo "Error: Electron not installed. Run 'npm install' first."
    exit 1
fi

echo "═══════════════════════════════════════════════════════════"
echo " Installing Custom Electron (HEVC + AC3 + E-AC3)"
echo " Source: $DIST_ZIP"
echo " Target: $ELECTRON_DIST"
echo "═══════════════════════════════════════════════════════════"

# Backup the original
BACKUP="$ELECTRON_DIST.backup"
if [ ! -d "$BACKUP" ]; then
    echo "▸ Backing up original Electron to $BACKUP..."
    cp -r "$ELECTRON_DIST" "$BACKUP"
fi

# Clear dist and extract new
echo "▸ Extracting custom Electron..."
rm -rf "$ELECTRON_DIST"/*
unzip -q "$DIST_ZIP" -d "$ELECTRON_DIST"

# On macOS, remove quarantine
if [ "$(uname)" = "Darwin" ]; then
    echo "▸ Removing macOS quarantine flag..."
    xattr -cr "$ELECTRON_DIST" 2>/dev/null || true
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " DONE! Custom Electron installed."
echo ""
echo " Run your app:  cd '$APP_DIR' && npm start"
echo ""
echo " To restore stock Electron:"
echo "   rm -rf '$ELECTRON_DIST'"
echo "   mv '$BACKUP' '$ELECTRON_DIST'"
echo "═══════════════════════════════════════════════════════════"
