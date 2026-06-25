#!/bin/bash
set -e

REPO="toantruyen-ai/diff-app"
APP_NAME="Diff-App"

# Detect OS
OS=$(uname -s)

# Fetch latest release JSON once
echo "Fetching latest release..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
LATEST_TAG=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
  echo "ERROR: Could not fetch latest release tag." >&2
  exit 1
fi

echo "Latest version: $LATEST_TAG"

# Helper: extract browser_download_url matching a pattern
get_asset_url() {
  echo "$RELEASE_JSON" | grep '"browser_download_url"' | grep "$1" | \
    sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/' | head -1
}

# ── macOS ──────────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then
  ARCH=$(uname -m)
  [ "$ARCH" = "arm64" ] && DMG_PATTERN="arm64\.dmg" || DMG_PATTERN="x64\.dmg"
  APP_DIR="/Applications/${APP_NAME}.app"

  ASSET_URL=$(get_asset_url "$DMG_PATTERN")
  if [ -z "$ASSET_URL" ]; then
    echo "ERROR: No DMG found for arch ${ARCH} in release ${LATEST_TAG}." >&2
    exit 1
  fi

  DMG_FILE="/tmp/${APP_NAME}-${LATEST_TAG}.dmg"
  echo "Downloading: $ASSET_URL"
  curl -fSL --progress-bar -o "$DMG_FILE" "$ASSET_URL"

  echo "Mounting DMG..."
  MOUNT_POINT=$(hdiutil attach "$DMG_FILE" -nobrowse | grep '/Volumes' | awk -F'\t' '{print $NF}' | sed 's/[[:space:]]*$//')

  # Quit app if running
  if pgrep -x "$APP_NAME" > /dev/null 2>&1; then
    echo "Quitting running app..."
    osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || pkill -x "$APP_NAME" || true
    sleep 2
  fi

  [ -d "$APP_DIR" ] && rm -rf "$APP_DIR"

  echo "Installing to /Applications..."
  cp -R "$MOUNT_POINT/${APP_NAME}.app" "/Applications/"

  hdiutil detach "$MOUNT_POINT" -quiet
  xattr -cr "$APP_DIR"
  rm -f "$DMG_FILE"

  echo ""
  echo "Done! ${APP_NAME} ${LATEST_TAG} installed."
  open "$APP_DIR"

# ── Linux ──────────────────────────────────────────────────────────────────────
elif [ "$OS" = "Linux" ]; then
  if command -v dpkg > /dev/null 2>&1; then
    # Ubuntu / Debian — install .deb
    ASSET_URL=$(get_asset_url '\.deb"')
    if [ -z "$ASSET_URL" ]; then
      echo "ERROR: No .deb package found in release ${LATEST_TAG}." >&2
      exit 1
    fi

    DEB_FILE="/tmp/${APP_NAME}-${LATEST_TAG}.deb"
    echo "Downloading: $ASSET_URL"
    curl -fSL --progress-bar -o "$DEB_FILE" "$ASSET_URL"

    pkill -f "$APP_NAME" 2>/dev/null || true

    echo "Installing..."
    sudo apt install -y "$DEB_FILE"
    rm -f "$DEB_FILE"

    echo ""
    echo "Done! ${APP_NAME} ${LATEST_TAG} installed."
  else
    # Other Linux — install AppImage
    ASSET_URL=$(get_asset_url '\.AppImage"')
    if [ -z "$ASSET_URL" ]; then
      echo "ERROR: No AppImage found in release ${LATEST_TAG}." >&2
      exit 1
    fi

    APPIMAGE_FILE="$HOME/${APP_NAME}.AppImage"
    echo "Downloading: $ASSET_URL"
    curl -fSL --progress-bar -o "$APPIMAGE_FILE" "$ASSET_URL"
    chmod +x "$APPIMAGE_FILE"

    echo ""
    echo "Done! ${APP_NAME} ${LATEST_TAG} installed to ${APPIMAGE_FILE}."
  fi

else
  echo "ERROR: Unsupported OS: $OS" >&2
  exit 1
fi
