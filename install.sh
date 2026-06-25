#!/bin/bash
set -e

REPO="toantruyen-ai/diff-app"
APP_NAME="Diff-App"
APP_DIR="/Applications/${APP_NAME}.app"

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  DMG_SUFFIX="arm64.dmg"
else
  DMG_SUFFIX="x64.dmg"
fi

# Get latest release tag
echo "Fetching latest release..."
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
  echo "ERROR: Could not fetch latest release tag." >&2
  exit 1
fi

echo "Latest version: $LATEST_TAG"

# Build download URL
DMG_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${APP_NAME// /.}-${LATEST_TAG#v}-${DMG_SUFFIX}"
DMG_FILE="/tmp/${APP_NAME// /-}-${LATEST_TAG}.dmg"

echo "Downloading: $DMG_URL"
curl -fSL --progress-bar -o "$DMG_FILE" "$DMG_URL"

# Mount DMG
echo "Mounting DMG..."
MOUNT_POINT=$(hdiutil attach "$DMG_FILE" -nobrowse -quiet | awk 'END{print $NF}')

# Remove old version if exists
if [ -d "$APP_DIR" ]; then
  echo "Removing old version..."
  rm -rf "$APP_DIR"
fi

# Copy app to /Applications
echo "Installing to /Applications..."
cp -R "$MOUNT_POINT/${APP_NAME}.app" "/Applications/"

# Unmount DMG
hdiutil detach "$MOUNT_POINT" -quiet

# Remove quarantine attribute
echo "Removing quarantine attribute..."
xattr -cr "$APP_DIR"

# Cleanup
rm -f "$DMG_FILE"

echo ""
echo "Done! ${APP_NAME} ${LATEST_TAG} installed successfully."
