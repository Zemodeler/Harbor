import { join } from 'node:path';
import { statSync } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, shell, Tray } from 'electron';
import { registerIpc, type IpcHost } from './ipc';
import { readCodexLimits } from './codexLimits';
import { createLogger } from './logger';
import { createHarborService } from './service';
import { editorUrl, launchTerminal } from './launcher';
import { instanceStartupAction, shouldHideOnClose, trayMenuModel, trayTooltip } from './tray';
import { appDocument, hardenContents } from './windowSecurity';
import { autoUpdater } from 'electron-updater';
import { createUpdater } from './updater';

let win: BrowserWindow | undefined;
let quitting = false;

const dataDir = join(app.getPath('appData'), 'Harbor');
const logger = createLogger(join(dataDir, 'logs'));
// A stray error in one run should not take every running agent down with the window: log it and carry on.
// A burst means state is likely broken, so stop instead of looping.
const recentFaults: number[] = [];
function fault(kind: string, error: unknown): void {
  logger.error(kind, error);
  const now = Date.now();
  recentFaults.push(now);
  while (recentFaults.length && now - recentFaults[0]! > 10_000) recentFaults.shift();
  if (recentFaults.length >= 10) { logger.error('Too many unhandled errors in 10 seconds; exiting.'); app.exit(1); }
}
process.on('uncaughtException', (error) => fault('uncaughtException', error));
process.on('unhandledRejection', (reason) => fault('unhandledRejection', reason));
logger.info(`Harbor ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'dev'}, ${process.platform})`);

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

// A packaged build always shows its bundled renderer; only an unpackaged dev run may point at the dev server.
const devRendererUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(__dirname, '../renderer/index.html');
const appDoc = appDocument(rendererFile, devRendererUrl);

// Every WebContents (including any a compromised page might try to create) gets the window policy before it loads.
app.on('web-contents-created', (_event, contents) => hardenContents(contents, appDoc, url => { void shell.openExternal(url); }));

function createWindow(hideOnClose: () => boolean): void {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 420, minHeight: 480,
    title: 'Harbor',
    icon: iconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  const window = win;
  window.on('close', event => {
    if (!hideOnClose()) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => { if (win === window) win = undefined; });
  if (devRendererUrl) void win.loadURL(devRendererUrl);
  else void win.loadFile(rendererFile);
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
    dataDir,
    appVersion: app.getVersion(),
    openFolder: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    launch: async (kind, target, editor) => {
      if (kind === 'editor') { await shell.openExternal(editorUrl(editor, target.file ? join(target.dir, target.file) : target.dir)); return; }
      await launchTerminal(target.dir);
    },
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
  // ipcMain is reached lazily so ipc.ts stays Electron-free and testable.
  const ipcHost: IpcHost = {
    handle: (name, listener) => ipcMain.handle(name, listener),
    removeHandler: name => ipcMain.removeHandler(name)
  };
  registerIpc(service, ipcHost, () => win?.webContents, appDoc);
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
  let shutdownDone = false;
  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    // Quitting stops every run; ask first when something is still working (its work so far stays in the worktrees and can be resumed).
    const active = service.activeRuns();
    if (active > 0) {
      const options = { type: 'question' as const, buttons: ['Quit anyway', 'Cancel'], defaultId: 1, cancelId: 1, message: `${active} run${active === 1 ? ' is' : 's are'} active; quit anyway?`, detail: 'Running agents are stopped. Their work so far stays in their worktrees and can be resumed.' };
      const answer = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
      if (answer !== 0) { event.preventDefault(); return; }
    }
    quitting = true;
    logger.info('Harbor quitting');
    // The runs' process trees are killed and state is saved first; the quit then continues.
    event.preventDefault();
    tray?.destroy();
    tray = undefined;
    void service.shutdown().catch((error) => logger.error('Shutdown failed', error)).finally(() => { shutdownDone = true; app.quit(); });
  });
  // Timers can stall while the machine sleeps: permission requests are re-checked against their wall-clock deadlines on wake.
  powerMonitor.on('resume', () => service.onResume());
  createWindow(hideOnClose);
  syncTray();
  try { createUpdater({
    autoUpdater, isPackaged: app.isPackaged, env: process.env, log: logger,
    isEnabled: () => (service.store.getSettings() as { autoUpdate?: boolean }).autoUpdate,
    isBusy: () => service.store.allAgentRecords().some(a => a.state === 'working' || a.state === 'queued'),
    ask: async (message, buttons) => (await dialog.showMessageBox(win ?? undefined as never, { type: 'question', message, buttons, defaultId: 0, cancelId: 1 })).response
  }); } catch (error) { logger.error('Updater failed to start', error); }
  app.on('activate', openWindow);
});

if (startupAction === 'start') app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
