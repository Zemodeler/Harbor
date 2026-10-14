/**
 * Machine paths never leave in a bundle (plan section 6.1): text Harbor writes into one has the project folder rewritten to
 * project-relative paths, a helper worktree to paths relative to that worktree, Harbor's data folder to <harbor-data>, the home
 * folder to ~, and any other absolute path (drive, UNC, /Users, /home) to a placeholder. Pure, so the rule is testable.
 */

export interface PathRoots { project: string; worktrees?: string; data?: string; home?: string }

/** A path as a regex that matches either separator (and doubled backslashes, as in code), case-insensitively. */
function pathPattern(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]+/).filter((x, i) => x || i === 0);
  return parts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
}
// A path ends where text that cannot be part of it starts.
const TAIL = '[^\\s"\'<>|*?`\\])},;]*';
const SEP = '[\\\\/]+';

/** The text with machine paths rewritten; `roots` are the paths of this machine (longest rewritten first). */
export function rewritePaths(text: string, roots: PathRoots): string {
  if (!text) return text;
  let out = text;
  const sub = (root: string | undefined, fn: (re: RegExp) => void) => { if (root && root.replace(/[\\/]+$/, '').length > 3) fn(new RegExp(pathPattern(root), 'gi')); };
  // A worktree lives one level under the worktrees root: `<root>\<slug>\src\a.ts` becomes `src/a.ts`.
  sub(roots.worktrees, (re) => {
    out = out.replace(new RegExp(`${re.source}${SEP}[^\\\\/\\s"'<>|*?\`]+(?:${SEP}(${TAIL}))?`, 'gi'), (_m, rest?: string) => (rest ? toPosix(rest) : '<worktree>'));
    out = out.replace(re, '<harbor-worktrees>');
  });
  sub(roots.project, (re) => {
    out = out.replace(new RegExp(`${re.source}${SEP}(${TAIL})`, 'gi'), (_m, rest: string) => (rest ? toPosix(rest) : '<project>'));
    out = out.replace(new RegExp(`${re.source}(?![A-Za-z0-9_.-])`, 'gi'), '<project>');
  });
  sub(roots.data, (re) => { out = out.replace(new RegExp(`${re.source}(?![A-Za-z0-9_.-])`, 'gi'), '<harbor-data>'); });
  sub(roots.home, (re) => { out = out.replace(new RegExp(`${re.source}(?![A-Za-z0-9_.-])`, 'gi'), '~'); });
  // Whatever absolute path is left names this machine: drive paths, UNC shares, Unix home folders.
  out = out.replace(new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:${SEP}${TAIL}`, 'g'), '<absolute path>');
  out = out.replace(new RegExp(`(?<![\\w:])\\\\\\\\[^\\s\\\\"'<>]+\\\\${TAIL}`, 'g'), '<network path>');
  out = out.replace(/(?<![\w.~-])\/(?:Users|home)\/[^/\s"'<>]+/g, '~');
  return out;
}

const toPosix = (p: string) => p.replace(/\\+/g, '/');

/** True when the text still names an absolute path of this machine (tests and the export check use it). */
export function hasMachinePath(text: string, roots: PathRoots): boolean {
  const all = [roots.project, roots.worktrees, roots.data, roots.home].filter((r): r is string => !!r && r.length > 3);
  return all.some((r) => new RegExp(pathPattern(r), 'i').test(text)) || /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/.test(text);
}
