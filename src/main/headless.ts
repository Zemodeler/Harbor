import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RemoteScope, RemoteSettings } from '../shared/api';
import { readCodexModels } from './clis/codexModels';
import { readCodexLimits } from './codexLimits';
import { acquireInstanceLock } from './instanceLock';
import { createLogger, type Logger } from './logger';
import { resolveRemoteConfig } from './remote/guard';
import { startRemoteServer, type RemoteServer } from './remote/server';
import { RemoteTokens, REMOTE_SCOPES } from './remote/tokens';
import { createHarborService, type HarborService } from './service';
import { Store } from './store';

/**
 * Harbor without Electron: the same service (store, orchestrator, adapters) plus the remote API, for a PC without a desktop
 * session or for scripting. No window, tray, dialogs or updater; methods that act on the desktop (open a folder, a terminal,
 * a sign-in) report that they need the app.
 */
export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env['HARBOR_DATA_DIR']) return env['HARBOR_DATA_DIR'];
  // Electron's app.getPath('appData') + 'Harbor', so the headless service and the app share one data folder.
  const appData = env['APPDATA'] ?? join(homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config');
  return join(appData, 'Harbor');
}

export const HEADLESS_USAGE = `npm run headless -- [serve] [--data-dir <dir>] [--host <addr>] [--port <n>] [--no-remote]
npm run headless -- token create <name> <read-only|answer-permissions|full>
npm run headless -- token list
npm run headless -- token revoke <id>
npm run headless -- remote-config [set '<json>']     e.g. set '{"enabled":true,"allowFullScope":false}'
Token and config commands need Harbor (app or headless) to be stopped: they change files a running Harbor owns.`;

interface Io { out(line: string): void; err(line: string): void }

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Token and settings maintenance while no Harbor runs (there is no token UI yet; see BACKLOG). */
function offline(dataDir: string, io: Io, work: () => void): number {
  const lock = acquireInstanceLock(dataDir, 'headless');
  if (!lock.ok) { io.err(lock.refusal); return 1; }
  try { work(); return 0; } catch (e) { io.err((e as Error).message); return 1; } finally { lock.release(); }
}

export interface Running { service: HarborService; server?: RemoteServer; stop(): Promise<void> }

/** Starts the service and, unless disabled, the remote server. Throws when the lock or the remote config refuses. */
export async function startHeadless(opts: { dataDir: string; remote?: boolean; host?: string; port?: number; logger?: Logger; service?: HarborService }): Promise<Running> {
  const lock = acquireInstanceLock(opts.dataDir, 'headless');
  if (!lock.ok) throw new Error(lock.refusal);
  const logger = opts.logger ?? createLogger(join(opts.dataDir, 'logs'));
  let service: HarborService | undefined;
  try {
    service = opts.service ?? createHarborService({
      dataDir: opts.dataDir,
      appVersion: 'headless',
      ledger: { reported: (cli) => (cli === 'codex' ? readCodexLimits() : []) },
      codexModels: () => readCodexModels()
    });
    let server: RemoteServer | undefined;
    if (opts.remote !== false) {
      const settings: RemoteSettings = { ...(service.store.getSettings().remote ?? {}) };
      if (opts.host !== undefined) settings.host = opts.host;
      if (opts.port !== undefined) settings.port = opts.port;
      server = await startRemoteServer({ service, tokens: service.remoteTokens, config: resolveRemoteConfig(settings), log: (m) => logger.info(m) });
    }
    const running = service;
    let stopped = false;
    return {
      service: running, server,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await server?.close();
        await running.shutdown().catch((e) => logger.error('Shutdown failed', e));
        lock.release();
      }
    };
  } catch (e) {
    await service?.shutdown().catch(() => undefined);
    lock.release();
    throw e;
  }
}

export async function runHeadless(argv: string[], io: Io, env: Record<string, string | undefined> = process.env): Promise<number | Running> {
  const dataDir = flag(argv, '--data-dir') ?? defaultDataDir(env);
  const [command, sub, ...rest] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--data-dir', '--host', '--port'].includes(argv[i - 1]!)));
  if (command === 'help' || argv.includes('--help')) { io.out(HEADLESS_USAGE); return 0; }
  if (command === 'token') {
    const tokens = new RemoteTokens(join(dataDir, 'remote-tokens.json'));
    if (sub === 'list') return offline(dataDir, io, () => { for (const t of tokens.list()) io.out(`${t.id}\t${t.scope}\t${t.name}\tlast used ${t.lastUsed ? new Date(t.lastUsed).toISOString() : 'never'}`); });
    if (sub === 'revoke' && rest[0]) return offline(dataDir, io, () => { tokens.revoke(rest[0]!); io.out('revoked'); });
    if (sub === 'create' && rest[0] && rest[1]) {
      const scope = rest[1] as RemoteScope;
      return offline(dataDir, io, () => {
        if (!REMOTE_SCOPES.includes(scope)) throw new Error(`Scope must be one of: ${REMOTE_SCOPES.join(', ')}.`);
        if (scope === 'full' && new Store(dataDir).getSettings().remote?.allowFullScope !== true) throw new Error('Full remote access is off. Run: npm run headless -- remote-config set \'{"allowFullScope":true}\' first.');
        const { token, info } = tokens.create(rest[0]!, scope);
        // Shown once, here only. Store it in a file only you can read (or HARBOR_TOKEN) for the harbor CLI.
        io.out(token);
        io.err(`Created ${info.scope} token "${info.name}" (${info.id}). It is shown only now.`);
      });
    }
    io.err(HEADLESS_USAGE); return 2;
  }
  if (command === 'remote-config') {
    return offline(dataDir, io, () => {
      const store = new Store(dataDir);
      if (sub === 'set') {
        let patch: unknown;
        try { patch = JSON.parse(rest.join(' ')); } catch { throw new Error('remote-config set takes one JSON object.'); }
        store.setSettings({ remote: { ...(store.getSettings().remote ?? {}), ...(patch as RemoteSettings) } });
        store.flush();
      }
      io.out(JSON.stringify(store.getSettings().remote ?? {}, null, 2));
    });
  }
  if (command !== undefined && command !== 'serve') { io.err(HEADLESS_USAGE); return 2; }
  const port = flag(argv, '--port');
  const running = await startHeadless({ dataDir, remote: !argv.includes('--no-remote'), host: flag(argv, '--host'), port: port === undefined ? undefined : Number(port) });
  io.err(`Harbor headless is running on ${dataDir}${running.server ? `; remote API at ${running.server.url}` : ''}. Ctrl+C stops it.`);
  return running;
}
