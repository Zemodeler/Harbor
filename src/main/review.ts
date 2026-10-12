import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ReviewSnapshot } from '../shared/api';
import { gitEnv, runProcess, type Runner } from './proc';

// Never open credential files while collecting a review, including untracked ones.
const CREDENTIAL_NAME = new RegExp([
  '^\\.env(?:\\.|$)', '^(?:credentials|secrets)(?:\\.|$)',
  '\\.(?:pem|key|p12|pfx|kdbx|tfstate)$', '\\.tfstate\\.', // terraform state (also .tfstate.backup) holds secrets in clear text
  '^id_(?:rsa|dsa|ecdsa|ed25519)', // ssh private keys and their variants
  '^\\.(?:npmrc|netrc|git-credentials)$',
  'service-account.*\\.json$'
].join('|'), 'i');

export function reviewable(path: string): boolean {
  return !path.split(/[\\/]/).some(p => CREDENTIAL_NAME.test(p));
}

/**
 * Git pathspecs that exclude the same credential files `reviewable` hides, for commands that stage or commit
 * (`git add -A -- . <these>`). Approximates the regex with globs, so it errs on the side of excluding.
 */
export const CREDENTIAL_PATHSPECS: readonly string[] = [
  '**/.env', '**/.env.*', '**/credentials', '**/credentials.*', '**/secrets', '**/secrets.*',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.kdbx', '**/*.tfstate', '**/*.tfstate.*',
  '**/id_rsa*', '**/id_dsa*', '**/id_ecdsa*', '**/id_ed25519*',
  '**/.npmrc', '**/.netrc', '**/.git-credentials', '**/*service-account*.json'
].map((g) => `:(top,exclude,glob,icase)${g}`);

/** Past this many changed files only the first ones are returned, with a note entry saying how many were left out. */
export const REVIEW_FILE_LIMIT = 100;
const GIT_TIMEOUT = 60_000;

/** Splits one `git diff --no-renames` output into patches by path (a and b paths are equal without renames). */
export function splitDiffByPath(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = diff.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith('diff --git ')) continue;
    const head = part.slice(11, part.indexOf('\n') < 0 ? undefined : part.indexOf('\n')).replace(/\r$/, '');
    const n = Math.floor((head.length - 5) / 2); // "a/P b/P"
    if (n < 1 || !head.startsWith('a/') || head.slice(2, 2 + n) !== head.slice(5 + n)) continue;
    out.set(head.slice(2, 2 + n), part);
  }
  return out;
}

export async function reviewDirectory(directory: string, source: string, base?: string, run: Runner = runProcess): Promise<ReviewSnapshot['files']> {
  const git = (args: string[], timeoutMs = GIT_TIMEOUT) => run('git', args, { cwd: directory, timeoutMs, env: gitEnv() });
  const check = await git(['rev-parse', '--verify', base || 'HEAD'], 15_000);
  if (check.code !== 0) throw new Error(`No readable Git history in ${source}.`);
  const diffArgs = [base || 'HEAD'];
  const [names, untracked] = await Promise.all([
    git(['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', '-z', ...diffArgs, '--']),
    git(['ls-files', '--others', '--exclude-standard', '-z'], 120_000)
  ]);
  if (names.code !== 0 || untracked.code !== 0) throw new Error(names.timedOut || untracked.timedOut ? `Reading changes in ${source} timed out.` : `Could not read changes in ${source}.`);
  const trackedNames = names.stdout.split('\0').filter(Boolean);
  const trackedSet = new Set(trackedNames);
  const allNames = [...new Set([...trackedNames, ...untracked.stdout.split('\0').filter(Boolean)])].filter(reviewable);
  const shown = allNames.slice(0, REVIEW_FILE_LIMIT);
  const files: ReviewSnapshot['files'] = [];
  // One diff for every tracked file instead of one process per file.
  const wanted = shown.filter((p) => trackedSet.has(p));
  let patches = new Map<string, string>();
  if (wanted.length) {
    const all = await git(['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...diffArgs, '--', ...wanted.map((p) => `:(top,literal)${p}`)]);
    if (all.code !== 0) throw new Error(all.timedOut ? `Reading the diff in ${source} timed out.` : 'Could not read the diff.');
    patches = splitDiffByPath(all.stdout);
  }
  for (const path of shown) {
    const full = resolve(directory, path), rel = relative(directory, full);
    if (isAbsolute(rel) || rel.startsWith('..')) continue;
    if (trackedSet.has(path)) {
      let patch = patches.get(path);
      if (patch === undefined) {
        const result = await git(['diff', '--no-ext-diff', '--no-textconv', ...diffArgs, '--', `:(top,literal)${path}`]);
        if (result.code !== 0) throw new Error(`Could not read diff for ${path}.`);
        patch = result.stdout;
      }
      files.push({ path, source, patch: patch.length > 200000 ? 'Diff exceeds the in-app preview limit. Review this file in your editor.' : patch });
    } else {
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      let patch = 'New file exceeds the in-app preview limit.';
      if (info.size <= 100000 && info.isFile()) {
        const content = await readFile(full);
        patch = content.includes(0) ? 'New binary file. Preview in your editor.' : content.toString('utf8').split('\n').map(line => '+' + line).join('\n');
      }
      files.push({ path, source, patch, untracked: true });
    }
  }
  if (allNames.length > shown.length) {
    const more = allNames.length - shown.length;
    files.push({ path: `(${more} more changed files not shown)`, source, patch: `Harbor shows the first ${REVIEW_FILE_LIMIT} of ${allNames.length} changed files. Review the remaining ${more} in your editor or narrow the change.` });
  }
  return files;
}
