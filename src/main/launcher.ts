import { spawn } from 'node:child_process';
import type { EditorId } from '../shared/api';

/** Editors that register a URL protocol. Opening through the protocol needs no shell, so a path can never be parsed as a command. */
export const EDITORS: Record<EditorId, { label: string; scheme: string }> = {
  code: { label: 'VS Code', scheme: 'vscode' },
  'code-insiders': { label: 'VS Code Insiders', scheme: 'vscode-insiders' },
  cursor: { label: 'Cursor', scheme: 'cursor' },
  windsurf: { label: 'Windsurf', scheme: 'windsurf' }
};
export const DEFAULT_EDITOR: EditorId = 'code';

export function isEditorId(v: unknown): v is EditorId { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(EDITORS, v); }

/** `vscode://file/C:/a%20b/c.ts`: opens a folder or a file in an already installed editor. */
export function editorUrl(editor: EditorId | undefined, target: string): string {
  const scheme = EDITORS[editor && isEditorId(editor) ? editor : DEFAULT_EDITOR].scheme;
  const path = target.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
  return `${scheme}://file/${path.replace(/^\/+/, '')}`;
}

export interface Launch { command: string; args: string[]; cwd: string }

/**
 * Terminal attempts in order. The folder is passed as an argument or a working directory, never spliced into a command
 * string: Windows Terminal first, then a new PowerShell window started through cmd's `start`.
 */
export function terminalLaunches(dir: string): Launch[] {
  return [
    { command: 'wt.exe', args: ['-d', dir], cwd: dir },
    { command: 'cmd.exe', args: ['/d', '/c', 'start', '', 'powershell.exe', '-NoExit'], cwd: dir }
  ];
}

/** Starts the first terminal that launches. Rejects only when none could be started. */
export async function launchTerminal(dir: string, spawnFn: typeof spawn = spawn): Promise<void> {
  let last: unknown;
  for (const l of terminalLaunches(dir)) {
    try {
      await new Promise<void>((ok, fail) => {
        const child = spawnFn(l.command, l.args, { cwd: l.cwd, detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', fail);
        child.once('spawn', () => { child.unref(); ok(); });
      });
      return;
    } catch (e) { last = e; }
  }
  throw new Error(`Could not open a terminal${last instanceof Error ? `: ${last.message}` : '.'}`);
}
