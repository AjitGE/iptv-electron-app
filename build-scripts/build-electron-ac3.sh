#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  Build Custom Electron with HEVC + AC-3 + E-AC-3 Codecs    ║
# ║                                                              ║
# ║  Based on: 5rahim/electron-media-patch (v36.2.1)            ║
# ║  Supports: macOS, Linux, Windows                            ║
# ║                                                              ║
# ║  Requirements:                                               ║
# ║    - 100GB+ free disk space                                  ║
# ║    - 16GB+ RAM (32GB recommended)                            ║
# ║    - 4-8 hours build time                                    ║
# ║    - Python 3, git, node (v20+)                              ║
# ╚══════════════════════════════════════════════════════════════╝
set -euo pipefail

ELECTRON_VERSION="${ELECTRON_VERSION:-v40.4.1}"
PATCH_REPO="https://github.com/5rahim/electron-media-patch.git"
HEVC_SCRIPT_URL="https://raw.githubusercontent.com/StaZhu/enable-chromium-hevc-hardware-decoding/main/add-hevc-ffmpeg-decoder-parser.js"
BUILD_DIR="${BUILD_DIR:-$HOME/electron-build}"

echo "═══════════════════════════════════════════════════════════"
echo " Custom Electron Build: HEVC + AC3 + E-AC3"
echo " Target: Electron $ELECTRON_VERSION"
echo " Build dir: $BUILD_DIR"
echo "═══════════════════════════════════════════════════════════"

# ─── Preflight checks ────────────────────────────────────────
echo ""
echo "▸ Preflight: Checking host requirements..."
if ! command -v git >/dev/null; then
    echo "Error: git is not installed."
    exit 1
fi
if ! command -v python3 >/dev/null; then
    echo "Error: python3 is not installed."
    exit 1
fi
if ! command -v node >/dev/null; then
    echo "Error: node is not installed (need Node 20+)."
    exit 1
fi

if [ "$(uname)" = "Darwin" ]; then
    if ! xcode-select -p >/dev/null 2>&1; then
        echo "Error: Xcode Command Line Tools not installed."
        echo "Run: xcode-select --install"
        exit 1
    fi
fi

# Check free disk (warn if under 100GB)
FREE_KB=$(df -k "$BUILD_DIR" | tail -1 | awk '{print $4}')
FREE_GB=$((FREE_KB / 1024 / 1024))
if [ "$FREE_GB" -lt 100 ]; then
    echo "Warning: Only ${FREE_GB}GB free. Build may fail (<100GB)."
fi

# ─── Step 1: Install depot_tools ──────────────────────────────
echo ""
echo "▸ Step 1/8: Installing depot_tools..."
if [ ! -d "$BUILD_DIR/depot_tools" ]; then
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
else
    echo "  depot_tools already exists, skipping."
fi
export PATH="$BUILD_DIR/depot_tools:$PATH"

# ─── Step 2: Get Electron source ─────────────────────────────
echo ""
echo "▸ Step 2/8: Getting Electron source (this takes a LONG time)..."
mkdir -p "$BUILD_DIR/electron"
cd "$BUILD_DIR/electron"

if [ ! -d "src/electron" ]; then
    gclient config --name "src/electron" --unmanaged https://github.com/electron/electron
    gclient sync --with_branch_heads --with_tags
else
    echo "  Electron source already exists."
fi

# ─── Step 3: Checkout target version ─────────────────────────
echo ""
echo "▸ Step 3/8: Checking out Electron $ELECTRON_VERSION..."
cd "$BUILD_DIR/electron/src/electron"
git remote set-url origin https://github.com/electron/electron || true
git fetch origin --tags
if [[ "$ELECTRON_VERSION" == *"-x-y" ]]; then
    git fetch origin "$ELECTRON_VERSION"
    git checkout "origin/$ELECTRON_VERSION" -f
else
    git checkout "tags/$ELECTRON_VERSION" -f || git checkout "$ELECTRON_VERSION" -f
fi
cd "$BUILD_DIR/electron"
gclient sync -f

# ─── Step 4: Download patches ────────────────────────────────
echo ""
echo "▸ Step 4/8: Downloading codec patches..."
PATCH_DIR="$BUILD_DIR/patches"
if [ ! -d "$PATCH_DIR" ]; then
    git clone "$PATCH_REPO" "$PATCH_DIR"
else
    cd "$PATCH_DIR" && git pull
fi

# Copy patches to correct locations
cp "$PATCH_DIR/patches/media_hevc_ac3_chromium.patch" "$BUILD_DIR/electron/src/"
cp "$PATCH_DIR/patches/media_hevc_ac3_electron.patch" "$BUILD_DIR/electron/src/electron/"
cp "$PATCH_DIR/patches/media_hevc_ac3_ffmpeg.patch" "$BUILD_DIR/electron/src/third_party/ffmpeg/"

# ─── Step 5: Apply patches ───────────────────────────────────
echo ""
echo "▸ Step 5/8: Applying codec patches..."
cd "$BUILD_DIR/electron/src"
git apply media_hevc_ac3_chromium.patch || echo "  Chromium patch may already be applied"

cd "$BUILD_DIR/electron/src/electron"
git apply media_hevc_ac3_electron.patch || echo "  Electron patch may already be applied"

cd "$BUILD_DIR/electron/src/third_party/ffmpeg"
git apply media_hevc_ac3_ffmpeg.patch || echo "  FFmpeg patch may already be applied"

# Download and run the HEVC FFmpeg decoder/parser script
echo "  Downloading add-hevc-ffmpeg-decoder-parser.js..."
curl -sL "$HEVC_SCRIPT_URL" -o add-hevc-ffmpeg-decoder-parser.js
node ./add-hevc-ffmpeg-decoder-parser.js

# ─── Step 6: Generate build config ───────────────────────────
echo ""
echo "▸ Step 6/8: Generating build config..."
cd "$BUILD_DIR/electron/src"
export CHROMIUM_BUILDTOOLS_PATH="$(pwd)/buildtools"

gn gen out/Release --args='import("//electron/build/args/release.gn")'

# ─── Step 7: Build ───────────────────────────────────────────
echo ""
echo "▸ Step 7/8: Building Electron (this will take several hours)..."
ninja -C out/Release electron

# ─── Step 8: Package ─────────────────────────────────────────
echo ""
echo "▸ Step 8/8: Packaging dist.zip..."

# Strip on Linux only
if [ "$(uname)" = "Linux" ]; then
    electron/script/strip-binaries.py -d out/Release
fi

ninja -C out/Release electron:electron_dist_zip

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " BUILD COMPLETE!"
echo " Output: $BUILD_DIR/electron/src/out/Release/dist.zip"
echo ""
echo " To use in your IPTV app:"
echo "   1. Extract dist.zip"
echo "   2. Set ELECTRON_OVERRIDE_DIST_PATH to the extracted dir"
echo "   3. Or replace node_modules/electron/dist/ contents"
echo "═══════════════════════════════════════════════════════════"
