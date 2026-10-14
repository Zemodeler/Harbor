import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliStatus, Conversation, HarborEvent, PendingPermission, Project, UsageWindow } from '../../shared/api';
import { RemoteClient } from './client';
import { DEFAULT_REMOTE_HOST, DEFAULT_REMOTE_PORT } from './guard';

export interface CliIo {
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  platform?: NodeJS.Platform;
  home?: string;
  readFile?(path: string): string;
  fileMode?(path: string): number;
  stdin?(): Promise<string>;
  /** Called with a stop function while `watch` runs (the script wires it to Ctrl+C). */
  onStop?(stop: () => void): void;
}

export const USAGE = `harbor <command>
  status                         who you are, CLIs, usage estimate, waiting requests
  projects                       list projects
  conversations <projectId>      list a project's conversations
  send <conversationId> <text>   send a message (text "-" reads stdin); needs a full-scope token
  answer <requestId> <yes|no>    answer a waiting permission request
  answer <requestId> <text>      answer an agent's question
  watch [--json]                 stream events until Ctrl+C

Token: HARBOR_TOKEN, or a file only you can read (HARBOR_TOKEN_FILE, default ~/.harbor/token). Never on the command line.
Server: HARBOR_URL (default http://${DEFAULT_REMOTE_HOST}:${DEFAULT_REMOTE_PORT}).`;

/** The token from the environment or a user-only file; argv is never consulted (it shows up in process lists and history). */
export function loadToken(io: CliIo): string {
  const fromEnv = io.env['HARBOR_TOKEN']?.trim();
  if (fromEnv) return fromEnv;
  const file = io.env['HARBOR_TOKEN_FILE'] || join(io.home ?? homedir(), '.harbor', 'token');
  const platform = io.platform ?? process.platform;
  let text: string;
  try { text = (io.readFile ?? ((p) => readFileSync(p, 'utf8')))(file); } catch { throw new Error(`No token: set HARBOR_TOKEN or put one in ${file}.`); }
  // On Windows the file's ACL decides; a file under the user's profile is user-only by default (not checked here).
  if (platform !== 'win32') {
    const mode = (io.fileMode ?? ((p) => statSync(p).mode))(file);
    if ((mode & 0o077) !== 0) throw new Error(`${file} can be read by other users; run: chmod 600 ${file}`);
  }
  const token = text.trim();
  if (!token) throw new Error(`${file} is empty.`);
  return token;
}

const age = (t?: number): string => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '-');

export function describeEvent(e: HarborEvent): string {
  switch (e.type) {
    case 'message': return `[message] ${e.message.conversationId} ${e.message.role}: ${e.message.text.replace(/\s+/g, ' ').slice(0, 200)}`;
    case 'messageDelta': return `[delta] ${e.conversationId} +${e.text.length} chars`;
    case 'agent': return `[agent] ${e.agent.id} ${e.agent.role} ${e.agent.state}: ${e.agent.title}`;
    case 'conversation': return `[conversation] ${e.conversation.id} ${e.conversation.activity?.state ?? ''} ${e.conversation.title}`;
    case 'usage': return `[usage] ${e.windows.map((w) => `${w.cli} ${w.label} ${Math.round(w.usedPct)}%`).join(', ')}`;
    case 'cli': return `[cli] ${e.cli.id} ${e.cli.installed ? 'installed' : 'missing'}`;
    case 'permission': return `[permission] ${e.requestId} ${e.kind}${e.tool ? ` ${e.tool}` : ''}: ${e.prompt.replace(/\s+/g, ' ').slice(0, 200)}${e.kind === 'freeReset' ? ' (answer in the app)' : ''}`;
    case 'question': return `[question] ${e.requestId} ${e.prompt.replace(/\s+/g, ' ').slice(0, 200)}${e.options?.length ? ` options: ${e.options.join(' | ')}` : ''}`;
    default: return `[${(e as { type?: string }).type ?? 'event'}]`;
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') { io.out(USAGE); return command ? 0 : 1; }
  if (argv.some((a) => /^--?token(?:=|$)/i.test(a) || /^hbt_/.test(a))) { io.err('Tokens are never accepted on the command line. Use HARBOR_TOKEN or a token file.'); return 2; }
  let client: RemoteClient;
  try {
    client = new RemoteClient({
      url: io.env['HARBOR_URL'] || `http://${DEFAULT_REMOTE_HOST}:${DEFAULT_REMOTE_PORT}`,
      token: loadToken(io),
      allowPlainHttp: io.env['HARBOR_ALLOW_PLAIN_HTTP'] === '1'
    });
  } catch (e) { io.err((e as Error).message); return 2; }
  try {
    switch (command) {
      case 'status': {
        const me = await client.whoami();
        io.out(`token: ${me.name} (${me.scope})`);
        for (const c of await client.invoke<CliStatus[]>('listClis')) io.out(`cli: ${c.id} ${c.installed ? (c.version ?? 'installed') : 'not installed'}${c.authState ? ` ${c.authState}` : ''}`);
        for (const w of await client.invoke<UsageWindow[]>('getUsage')) io.out(`usage: ${w.cli} ${w.label} ${Math.round(w.usedPct)}%${w.source === 'estimated' ? ' (estimate)' : ''}`);
        const waiting = await client.invoke<PendingPermission[]>('listPendingPermissions');
        io.out(`waiting permission requests: ${waiting.length}`);
        for (const p of waiting) io.out(`  ${describeEvent(p)}`);
        return 0;
      }
      case 'projects':
        for (const p of await client.invoke<Project[]>('listProjects')) io.out(`${p.id}\t${p.name}\t${p.path}`);
        return 0;
      case 'conversations': {
        if (!rest[0]) { io.err('Usage: harbor conversations <projectId>'); return 2; }
        for (const c of await client.invoke<Conversation[]>('listConversations', rest[0])) io.out(`${c.id}\t${c.activity?.state ?? '-'}\t${age(c.updated)}\t${c.title}`);
        return 0;
      }
      case 'send': {
        const [id, ...words] = rest;
        let text = words.join(' ');
        if (text === '-') text = await (io.stdin?.() ?? Promise.resolve(''));
        if (!id || !text.trim()) { io.err('Usage: harbor send <conversationId> <text>'); return 2; }
        await client.invoke('send', id, text);
        io.out('sent');
        return 0;
      }
      case 'answer': {
        const [id, ...words] = rest;
        const text = words.join(' ').trim();
        if (!id || !text) { io.err('Usage: harbor answer <requestId> <yes|no|text>'); return 2; }
        const permission = (await client.invoke<PendingPermission[]>('listPendingPermissions')).find((p) => p.requestId === id);
        if (permission) {
          const yes = /^(?:y|yes|allow)$/i.test(text), no = /^(?:n|no|deny)$/i.test(text);
          if (!yes && !no) { io.err('Answer a permission request with yes or no.'); return 2; }
          await client.invoke('answerPermission', id, yes);
          io.out(yes ? 'allowed once' : 'denied');
        } else {
          await client.invoke('answerQuestion', id, text);
          io.out('answered');
        }
        return 0;
      }
      case 'watch': {
        const json = rest.includes('--json');
        const w = client.watch((e) => io.out(json ? JSON.stringify(e) : describeEvent(e)));
        io.onStop?.(() => w.close());
        await w.opened;
        io.err('watching (Ctrl+C to stop)');
        await w.closed;
        return 0;
      }
      default:
        io.err(`Unknown command: ${command}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    io.err(`harbor: ${(e as Error).message}`);
    return 1;
  }
}
