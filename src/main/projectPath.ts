import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse, resolve } from 'node:path';
import { normPath } from './store';

/** Why a folder cannot be a Harbor project, or undefined when it can. A drive root or the home folder would put a whole machine in scope. */
export function projectPathRefusal(path: string, home: string = homedir()): string | undefined {
  if (typeof path !== 'string' || !path.trim() || path.length > 1024 || path.includes('\0')) return 'Choose a project folder.';
  const full = resolve(path);
  if (normPath(parse(full).root) === normPath(full)) return `Harbor will not use a drive root (${full}) as a project. Choose a project folder inside it.`;
  if (home && normPath(resolve(home)) === normPath(full)) return 'Harbor will not use your whole home folder as a project. Choose a folder inside it.';
  if (!existsSync(full)) return `This folder does not exist: ${path}`;
  try { if (!statSync(full).isDirectory()) return `Not a folder: ${path}`; } catch { return `This folder cannot be read: ${path}`; }
  return undefined;
}
