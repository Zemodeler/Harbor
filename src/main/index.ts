import { join } from 'node:path';
import { statSync } from 'node:fs';
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { registerIpc } from './ipc';
import { readCodexLimits } from './codexLimits';
import { createHarborService } from './service';
import { instanceStartupAction, shouldHideOnClose, trayMenuModel, trayTooltip } from './tray';

let win: BrowserWindow | undefined;
let quitting = false;

// A hidden-to-tray instance keeps running old code after a repackage; launching the exe again would only focus it.
function builtCodeMtime(): number {
  // noAsar makes fs see app.asar as the plain file it is on disk.
  const proc = process as NodeJS.Process & { noAsar?: boolean };
  const before = proc.noAsar;
  try {
    proc.noAsar = true;
    return statSync(app.isPackaged ? join(process.resourcesPath, 'app.asar') : __filename).mtimeMs;
  } catch { return 0; } finally { proc.noAsar = before; }
}
const startedWithMtime = builtCodeMtime();

function iconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build/icon.ico');
}

function createWindow(hideOnClose: () => boolean): void {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 420, minHeight: 480,
    title: 'Harbor',
    icon: iconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  const window = win;
  window.on('close', event => {
    if (!hideOnClose()) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => { if (win === window) win = undefined; });
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

const startupAction = instanceStartupAction(app.requestSingleInstanceLock());
if (startupAction === 'quit') app.quit();
let openExistingWindow: (() => void) | undefined;
// Registered before readiness; startup itself opens the window if the second launch arrives earlier.
if (startupAction === 'start') app.on('second-instance', () => {
  if (builtCodeMtime() > startedWithMtime) { app.relaunch(); app.quit(); return; }
  openExistingWindow?.();
});
if (startupAction === 'start') app.whenReady().then(() => {
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
  let tray: Tray | undefined;
  const openWindow = (): void => {
    if (!win) createWindow(hideOnClose);
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
  };
  openExistingWindow = openWindow;
  const syncTray = (): void => {
    if (quitting) return;
    if (service.store.getSettings().keepRunningInBackground === true) {
      if (!tray) {
        const icon = nativeImage.createFromPath(iconPath());
        tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
        tray.setContextMenu(Menu.buildFromTemplate(trayMenuModel().map(item => ({
          label: item.label, click: item.action === 'open' ? openWindow : () => app.quit()
        }))));
        tray.on('double-click', openWindow);
      }
      tray.setToolTip(trayTooltip(service.store.allAgentRecords()));
    } else if (tray) {
      // Removing the only way back to a hidden window would strand the user.
      if (win && !win.isVisible()) openWindow();
      tray.destroy();
      tray = undefined;
    }
  };
  const hideOnClose = (): boolean => {
    if (!shouldHideOnClose(service.store.getSettings(), quitting)) return false;
    syncTray();
    return true;
  };
  const setSettings = service.setSettings;
  service.setSettings = async patch => {
    const settings = await setSettings(patch);
    syncTray();
    return settings;
  };
  registerIpc(service, () => win?.webContents);
  // A question must not wait unseen behind other windows: bring Harbor forward (the pop-up itself is in the renderer).
  service.onEvent((e) => {
    if (e.type === 'agent' || e.type === 'conversation') syncTray();
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
  app.on('before-quit', () => {
    quitting = true;
    service.shutdown();
    tray?.destroy();
    tray = undefined;
  });
  createWindow(hideOnClose);
  syncTray();
  app.on('activate', openWindow);
});

if (startupAction === 'start') app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
