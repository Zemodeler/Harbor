import { join } from 'node:path';
import { app, BrowserWindow, dialog, Notification, shell } from 'electron';
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
    openFolder: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    // Codex logs its real 5h/weekly limits locally. Claude's come from the rate_limit_event in its own stream
    // during Harbor runs (see usage.ts), so they appear after the first Claude run and are estimates before that.
    ledger: { reported: (cli) => (cli === 'codex' ? readCodexLimits() : []) },
    pickFolder: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open project folder' });
      return r.canceled ? undefined : r.filePaths[0];
    }
  });
  registerIpc(service, () => win?.webContents);
  // A question must not wait unseen behind other windows: bring Harbor forward (the pop-up itself is in the renderer).
  service.onEvent((e) => {
    if (!win) return;
    if (service.store.getSettings().desktopNotifications && !win.isFocused() && Notification.isSupported()) {
      const conversation = e.type === 'conversation' ? e.conversation : undefined;
      const helpers = conversation ? service.store.listAgentRecords(conversation.projectId).filter(a => a.parentConversationId === conversation.id) : [];
      const completed = conversation?.activity?.state === 'done' && !helpers.some(a => ['queued', 'working', 'waiting'].includes(a.state));
      const attention = e.type === 'question' || e.type === 'permission' || conversation?.activity?.state === 'failed';
      if (completed || attention) {
        const notification = new Notification({ title: attention ? 'Harbor needs your attention' : 'Harbor finished a session', body: conversation?.title || 'Open Harbor to continue.', silent: true });
        notification.on('click', () => { if (win?.isMinimized()) win.restore(); win?.show(); win?.focus(); });
        notification.show();
      }
    }
    if (e.type !== 'question') return;
    if (win.isMinimized()) win.restore();
    if (!win.isFocused()) { win.show(); win.flashFrame(true); win.once('focus', () => win?.flashFrame(false)); }
  });
  app.on('before-quit', () => service.shutdown());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
