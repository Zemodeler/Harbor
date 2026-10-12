// Auto-update from GitHub Releases (electron-updater). Electron-free: everything is injected so it can be tested.
// Updates are never installed while agents are running; the restart prompt waits until Harbor is idle.

export const FIRST_CHECK_MS = 30_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60_000;
export const BUSY_RETRY_MS = 60_000;

/** The subset of electron-updater's AppUpdater that Harbor uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterDeps {
  autoUpdater: UpdaterLike;
  isPackaged: boolean;
  env?: Record<string, string | undefined>;
  /** Settings.autoUpdate; undefined means the default (on). */
  isEnabled?: () => boolean | undefined;
  isBusy?: () => boolean;
  ask(message: string, buttons: string[]): Promise<number>;
  log: { info(m: string, ...e: unknown[]): void; warn(m: string, ...e: unknown[]): void; error(m: string, ...e: unknown[]): void };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  clearInterval?: (h: unknown) => void;
}

export interface Updater { started: boolean; stop(): void }

export function createUpdater(deps: UpdaterDeps): Updater {
  const { autoUpdater, log } = deps;
  const env = deps.env ?? {};
  const isBusy = deps.isBusy ?? (() => false);
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));

  if (!deps.isPackaged) return { started: false, stop() {} };
  if (env['HARBOR_NO_UPDATE'] === '1') { log.info('Auto-update disabled by HARBOR_NO_UPDATE'); return { started: false, stop() {} }; }
  if (deps.isEnabled?.() === false) { log.info('Auto-update disabled in settings'); return { started: false, stop() {} }; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  let promptTimer: unknown;
  let prompting = false;
  const handles: unknown[] = [];

  const promptWhenIdle = (version: string): void => {
    if (prompting) return;
    if (isBusy()) {
      // Never interrupt running agents; look again in a minute.
      promptTimer = setT(() => { promptTimer = undefined; promptWhenIdle(version); }, BUSY_RETRY_MS);
      return;
    }
    prompting = true;
    deps.ask(`Harbor ${version} is ready. Restart now to update?`, ['Restart now', 'Later']).then(choice => {
      prompting = false;
      if (choice !== 0) return;   // Later: autoInstallOnAppQuit installs it when Harbor is closed
      if (isBusy()) { promptWhenIdle(version); return; }   // work started while the dialog was open
      autoUpdater.quitAndInstall(true, true);
    }, error => { prompting = false; log.error('Update prompt failed', error); });
  };

  autoUpdater.on('update-downloaded', info => { log.info(`Update ${info.version} downloaded`); promptWhenIdle(info.version); });
  autoUpdater.on('error', error => log.warn('Update error', error));

  const check = (): void => {
    try {
      Promise.resolve(autoUpdater.checkForUpdates()).catch(error => log.warn('Update check failed; will retry later', error));
    } catch (error) { log.warn('Update check failed; will retry later', error); }
  };
  handles.push(setT(() => {
    check();
    handles.push(setI(check, CHECK_INTERVAL_MS));
  }, FIRST_CHECK_MS));

  return {
    started: true,
    stop() {
      for (const h of handles) { clearT(h); clearI(h); }
      if (promptTimer !== undefined) clearT(promptTimer);
    }
  };
}
