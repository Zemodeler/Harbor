import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ReviewSnapshot } from '../shared/api';
import { runProcess, type Runner } from './proc';

// Never open credential files while collecting a review, including untracked ones.
export function reviewable(path: string): boolean {
  return !path.split(/[\\/]/).some(p => /^\.env(?:\.|$)|^(?:credentials|secrets)(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(p));
}
export async function reviewDirectory(directory: string, source: string, base?: string, run: Runner = runProcess): Promise<ReviewSnapshot['files']> {
  const git = (args: string[]) => run('git', args, { cwd: directory, timeoutMs: 10000 });
  const check = await git(['rev-parse', '--verify', base || 'HEAD']);
  if (check.code !== 0) throw new Error(`No readable Git history in ${source}.`);
  const diffArgs = [base || 'HEAD'];
  const names = await git(['diff', '--name-only', '-z', ...diffArgs, '--']);
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (names.code !== 0 || untracked.code !== 0) throw new Error(`Could not read changes in ${source}.`);
  const trackedNames = names.stdout.split('\0').filter(Boolean);
  const allNames = [...new Set([...trackedNames, ...untracked.stdout.split('\0').filter(Boolean)])].filter(reviewable);
  if (allNames.length > 100) throw new Error('This workspace has over 100 changed files. Narrow the changes before reviewing in Harbor.');
  const files: ReviewSnapshot['files'] = [];
  for (const path of allNames) {
    const full = resolve(directory, path), rel = relative(directory, full);
    if (isAbsolute(rel) || rel.startsWith('..')) continue;
    if (trackedNames.includes(path)) {
      const result = await git(['diff', '--no-ext-diff', '--no-textconv', ...diffArgs, '--', path]);
      if (result.code !== 0) throw new Error(`Could not read diff for ${path}.`);
      files.push({ path, source, patch: result.stdout.length > 200000 ? 'Diff exceeds the in-app preview limit. Review this file in your editor.' : result.stdout });
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
  return files;
}
