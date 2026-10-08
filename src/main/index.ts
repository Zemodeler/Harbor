import { join } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { registerIpc } from './ipc';
import { readCodexLimits } from './codexLimits';
import { createHarborService } from './service';

let win: BrowserWindow | undefined;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 420, minHeight: 480,
    title: 'Harbor',
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.harbor.desktop');
  const service = createHarborService({
    dataDir: join(app.getPath('appData'), 'Harbor'),
    // Codex logs its real 5h/weekly limits locally. Claude's come from the rate_limit_event in its own stream
    // during Harbor runs (see usage.ts), so they appear after the first Claude run and are estimates before that.
    ledger: { reported: (cli) => (cli === 'codex' ? readCodexLimits() : []) },
    pickFolder: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open project folder' });
      return r.canceled ? undefined : r.filePaths[0];
    }
  });
  registerIpc(service, () => win?.webContents);
  app.on('before-quit', () => service.shutdown());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
