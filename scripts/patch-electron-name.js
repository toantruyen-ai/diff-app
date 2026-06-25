// Patches the local Electron binary's Info.plist so the app shows "Diff-App"
// instead of "Electron" in the macOS dock and Activity Monitor during dev.
// Runs automatically before npm start / npm run dev.
// node_modules is not committed, so this re-applies after every npm install.
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'darwin') process.exit(0);

const electronBin = require('electron');
const plist = path.resolve(path.dirname(electronBin), '..', 'Info.plist');

if (!fs.existsSync(plist)) {
  console.log('[patch] Info.plist not found, skipping');
  process.exit(0);
}

const APP_NAME = 'Diff-App';
const buddy = '/usr/libexec/PlistBuddy';

try {
  execSync(`${buddy} -c "Set :CFBundleName '${APP_NAME}'" "${plist}"`);
  execSync(`${buddy} -c "Set :CFBundleDisplayName '${APP_NAME}'" "${plist}"`);
  console.log(`[patch] Electron renamed to "${APP_NAME}"`);
} catch (e) {
  console.warn('[patch] Could not patch Info.plist:', e.message);
}
