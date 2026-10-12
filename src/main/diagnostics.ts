import { existsSync, readdirSync } from 'node:fs';
import { homedir, release } from 'node:os';
import type { CliStatus } from '../shared/api';
import type { JournalEntry } from './journal';
import { redactSecrets } from './logger';

export interface DiagnosticsInput {
  appVersion?: string;
  clis: CliStatus[];
  counts: { projects: number; conversations: number; agents: number; agentsByState: Record<string, number> };
  journal: JournalEntry[];
  logTail: string;
  notices: string[];
  now?: number;
}

/** Quarantined state files are the only startup trouble Store leaves behind; surface them without reading them. */
export function startupNotices(dataDir: string | undefined): string[] {
  if (!dataDir || !existsSync(dataDir)) return [];
  try {
    return readdirSync(dataDir).filter((f) => /^state\.json\.corrupt-\d+$/.test(f)).sort()
      .map((f) => `An unreadable state file was set aside as ${f}; Harbor started with empty state.`);
  } catch { return []; }
}

/** Plain text for a bug report. No message text, prompts or file contents; secret-looking strings and the home folder are masked. */
export function buildDiagnostics(d: DiagnosticsInput): string {
  const t = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const lines = [
    'Harbor diagnostics',
    `Generated: ${new Date(d.now ?? Date.now()).toISOString()}`,
    `App version: ${d.appVersion ?? 'unknown'}`,
    `Platform: ${process.platform} ${release()} (${process.arch}), node ${process.versions.node}`,
    '',
    'CLIs:',
    ...(d.clis.length ? d.clis.map((c) => `- ${c.id}: ${c.installed ? `installed${c.version ? ` ${c.version}` : ''}` : 'not installed'}; auth ${c.authState ?? (c.signedIn ? 'signedIn' : 'unknown')}${c.note ? `; ${c.note}` : ''}`) : ['- none detected']),
    '',
    `Projects: ${d.counts.projects}; conversations: ${d.counts.conversations}; agents: ${d.counts.agents}`,
    `Agents by state: ${Object.entries(d.counts.agentsByState).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
    '',
    'Startup notices:',
    ...(d.notices.length ? d.notices.map((n) => `- ${n}`) : ['- none']),
    '',
    `Run journal (last ${d.journal.length}):`,
    ...(d.journal.length ? d.journal.map((e) => `- ${t(e.time)} [${e.kind}] ${e.text}`) : ['- empty']),
    '',
    'Main log (tail):',
    d.logTail || '(empty)'
  ];
  let text = redactSecrets(lines.join('\n'));
  const home = homedir();
  if (home.length > 3) text = text.split(home).join('~').split(home.split('\\').join('/')).join('~');
  return text;
}
