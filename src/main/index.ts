import { join } from 'node:path';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, screen, shell, Tray } from 'electron';
import { HARBOR_FILE_SCHEME, harborFileRequestAllowed, resolveHarborFile } from './images';
import type { Capturer } from './screenshots';
import { registerIpc, type IpcHost } from './ipc';
import { readCodexLimits } from './codexLimits';
import { readCodexModels } from './clis/codexModels';
import { createLogger } from './logger';
import { createHarborService } from './service';
import { editorUrl, launchTerminal } from './launcher';
import { instanceStartupAction, shouldHideOnClose, trayMenuModel, trayTooltip } from './tray';
import { appDocument, hardenContents } from './windowSecurity';
import { autoUpdater } from 'electron-updater';
import { createUpdater } from './updater';
import { acquireInstanceLock } from './instanceLock';
import { NotificationGate } from './notifications';
import { resolveRemoteConfig } from './remote/guard';
import { startRemoteServer, type RemoteServer } from './remote/server';

let win: BrowserWindow | undefined;
let quitting = false;

// HARBOR_DATA_DIR lets a debugging run use its own state and instance lock instead of the real ones.
const dataDir = process.env['HARBOR_DATA_DIR'] ? process.env['HARBOR_DATA_DIR'] : join(app.getPath('appData'), 'Harbor');
if (dataDir !== join(app.getPath('appData'), 'Harbor')) app.setPath('userData', dataDir);
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

// harbor-file://attachments/<conversationId>/<file> shows images Harbor stored (attachments, screenshots) under the CSP's img-src.
// Must be registered before the app is ready. Standard + secure only: no fetch, no CORS, no service workers, no CSP bypass.
protocol.registerSchemesAsPrivileged([{ scheme: HARBOR_FILE_SCHEME, privileges: { standard: true, secure: true } }]);

/**
 * Window and screen capture for HARBOR_SCREENSHOT, kept thin: everything else (asking, preview, rate limit, saving) is in
 * screenshots.ts and tested with a fake. NOT EXERCISED in a real session when written: desktopCapturer in the main process on
 * Windows 11 (Electron 44), capture of windows that are covered or on another monitor, and whether a minimised window gives an
 * empty image (it is then reported as "could not be captured"). The full-size capture asks for a thumbnail as large as the
 * largest display in physical pixels; Electron scales a source to fit inside that size, keeping its aspect ratio.
 */
const desktopCapturerAdapter: Capturer = {
  async list(size) {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: size, fetchWindowIcons: false });
    return sources.map(s => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen:') ? 'screen' as const : 'window' as const,
      ...(size.width > 0 && !s.thumbnail.isEmpty() ? { thumbnail: s.thumbnail.toDataURL() } : {}) }));
  },
  async capture(sourceId) {
    const kind = sourceId.startsWith('screen:') ? 'screen' : 'window';
    const max = screen.getAllDisplays().reduce((m, d) => ({ width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)), height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)) }), { width: 1280, height: 720 });
    const sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize: max, fetchWindowIcons: false });
    const s = sources.find(x => x.id === sourceId);
    return s && !s.thumbnail.isEmpty() ? s.thumbnail.toPNG() : undefined;
  }
};

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
  // The headless service (npm run headless) may own this data folder; two Harbors would both write state.json.
  const instance = acquireInstanceLock(dataDir, 'desktop');
  if (!instance.ok) { dialog.showErrorBox('Harbor is already running', instance.refusal); app.exit(1); return; }
  const service = createHarborService({
    dataDir,
    appVersion: app.getVersion(),
    appRoots: [app.getAppPath()],
    trashItem: path => shell.trashItem(path),
    openFolder: async path => { const error = await shell.openPath(path); if (error) throw new Error(error); },
    launch: async (kind, target, editor) => {
      if (kind === 'editor') { await shell.openExternal(editorUrl(editor, target.file ? join(target.dir, target.file) : target.dir)); return; }
      await launchTerminal(target.dir);
    },
    // Codex logs its real 5h/weekly limits locally. Claude's come from the rate_limit_event in its own stream
    // during Harbor runs (see usage.ts), so they appear after the first Claude run and are estimates before that.
    ledger: { reported: (cli) => (cli === 'codex' ? readCodexLimits() : []) },
    // Codex caches the account's model list locally; only that file is read (never auth files).
    codexModels: () => readCodexModels(),
    pickFolder: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open project folder' });
      return r.canceled ? undefined : r.filePaths[0];
    },
    pickFile: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openFile'], title: 'Choose the CLI executable', filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat', 'com'] }, { name: 'All files', extensions: ['*'] }] });
      return r.canceled ? undefined : r.filePaths[0];
    },
    pickSkillSource: async (kind) => {
      const r = kind === 'folder'
        ? await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Choose a skill folder (or a folder of skills)' })
        : await dialog.showOpenDialog({ properties: ['openFile'], title: 'Choose a skill .zip file', filters: [{ name: 'Zip archives', extensions: ['zip'] }] });
      return r.canceled ? undefined : r.filePaths[0];
    },
    // Skills already in the CLIs' own folders are listed read-only (only SKILL.md files and file names are read there).
    skillHomes: { claude: join(app.getPath('home'), '.claude'), codex: process.env['CODEX_HOME'] || join(app.getPath('home'), '.codex') },
    // GitHub skill import only, and only after the user's explicit click (skills/github.ts).
    fetch: (url, init) => fetch(url, init),
    // Testing an http/sse MCP server, only when the user clicks Test in Settings > MCP servers (mcp/probe.ts).
    mcpFetch: (url, init) => fetch(url, init),
    // Screenshots: only ever after the user's yes in the card (screenshots.ts); a window allowed for a conversation is captured
    // only while Harbor's window is visible, never in the background.
    capturer: desktopCapturerAdapter,
    foreground: () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
    // Document viewer: a file outside the project is viewable only when the user picks it here; reveal never opens the file.
    pickDocument: async () => {
      const r = win ? await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Open a file in Harbor\'s viewer' }) : await dialog.showOpenDialog({ properties: ['openFile'], title: 'Open a file in Harbor\'s viewer' });
      return r.canceled ? undefined : r.filePaths[0];
    },
    revealPath: (path) => shell.showItemInFolder(path),
    // Chat import (plan 6.2): these folders are listed only when the user opens the import dialog, and a transcript is read only
    // when the user picked it there.
    chatHomes: { claude: join(app.getPath('home'), '.claude'), codex: process.env['CODEX_HOME'] || join(app.getPath('home'), '.codex'), home: app.getPath('home') },
    pickBundleSave: async (defaultName) => {
      const o = { title: 'Save the Harbor bundle', defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'Harbor bundle', extensions: ['zip'] }] };
      const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
      return r.canceled ? undefined : r.filePath;
    },
    pickImportFile: async (kind) => {
      const o = kind === 'bundle'
        ? { properties: ['openFile' as const], title: 'Choose a Harbor bundle', filters: [{ name: 'Harbor bundle', extensions: ['zip'] }] }
        : { properties: ['openFile' as const], title: 'Choose an account export (conversations.json or the export .zip)', filters: [{ name: 'Export', extensions: ['json', 'zip'] }] };
      const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o);
      return r.canceled ? undefined : r.filePaths[0];
    }
  });
  // Only files Harbor wrote under <data>\attachments are served, and only to Harbor's own document (images.ts has the guards).
  protocol.handle(HARBOR_FILE_SCHEME, async (request) => {
    const initiator = (request as Request & { initiatorOrigin?: string }).initiatorOrigin;
    if (request.method !== 'GET' || !harborFileRequestAllowed(initiator, appDoc)) return new Response(null, { status: 403 });
    const file = resolveHarborFile(dataDir, request.url);
    if (!file) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file.path), { headers: { 'content-type': file.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch { return new Response(null, { status: 404 }); }
  });
  // The remote API is off unless Settings.remote.enabled; its config is read once, at startup.
  let remote: RemoteServer | undefined;
  if (service.store.getSettings().remote?.enabled === true) {
    try {
      void startRemoteServer({ service, tokens: service.remoteTokens, config: resolveRemoteConfig(service.store.getSettings().remote), log: (m) => logger.info(m) })
        .then((s) => { remote = s; }, (error) => logger.error('Remote API did not start', error));
    } catch (error) { logger.error('Remote API did not start', error); }
  }
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
  // Desktop notifications only on a real transition to done/failed (a rename, pin or deadline change re-emits the same state) and on asks.
  const notifications = new NotificationGate();
  notifications.seed(service.store.listProjects().flatMap(p => service.store.listConversations(p.id)));
  // A question must not wait unseen behind other windows: bring Harbor forward (the pop-up itself is in the renderer).
  service.onEvent((e) => {
    if (e.type === 'agent' || e.type === 'conversation') syncTray();
    const conversation = e.type === 'conversation' ? e.conversation : undefined;
    const helpersBusy = () => !!conversation && service.store.listAgentRecords(conversation.projectId).some(a => a.parentConversationId === conversation.id && ['queued', 'working', 'waiting'].includes(a.state));
    const kind = notifications.check(e, helpersBusy); // checked for every event, so the gate sees every state change
    if (!win) return;
    if (kind && service.store.getSettings().desktopNotifications && !win.isFocused() && Notification.isSupported()) {
      const notification = new Notification({ title: kind === 'attention' ? 'Harbor needs your attention' : 'Harbor finished a session', body: conversation?.title || 'Open Harbor to continue.', silent: true });
      notification.on('click', () => { if (win?.isMinimized()) win.restore(); win?.show(); win?.focus(); });
      notification.show();
    }
    // A screenshot request is answered in a card with a preview: it must be seen, never approved from the background.
    if (e.type !== 'question' && !(e.type === 'permission' && e.kind === 'screenshot')) return;
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
    void Promise.all([service.shutdown(), remote?.close()]).catch((error) => logger.error('Shutdown failed', error)).finally(() => { instance.release(); shutdownDone = true; app.quit(); });
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
