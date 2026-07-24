const { ipcMain, app } = require('electron');
const { exec } = require('child_process');

function registerAppHandlers() {
  ipcMain.handle('trigger-update', () => {
    const cmd = `curl -fsSL https://raw.githubusercontent.com/toantruyen-ai/diff-app/refs/heads/main/install.sh | bash`;
    exec(cmd, (err) => {
      if (err) console.error('Update script failed:', err);
    });
    return { ok: true };
  });

  ipcMain.handle('get-app-version', () => app.getVersion());
}

module.exports = {
  registerAppHandlers,
};
