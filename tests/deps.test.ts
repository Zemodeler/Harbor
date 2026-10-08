import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git } from '../src/main/git';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-deps-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(ignoreNodeModules: boolean) {
  const d = tmp();
  const g = (...a: string[]) => spawnSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'a.txt'), 'a');
  if (ignoreNodeModules) writeFileSync(join(d, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(d, 'node_modules'));
  writeFileSync(join(d, 'node_modules', 'dep.js'), 'dep');
  g('add', '.'); g('commit', '-q', '-m', 'init');
  return d;
}

describe('worktree dependency linking', () => {
  it('links ignored node_modules, keeps it out of checkpoints, and removal never deletes the real folder', async () => {
    const d = repo(true), root = join(tmp(), 'wt');
    const git = new Git();
    const wt = await git.createWorktree(d, root, 'p', 'task', 'abcdef');
    expect(await git.linkDependencies(d, wt.path)).toBe(true);
    expect(readFileSync(join(wt.path, 'node_modules', 'dep.js'), 'utf8')).toBe('dep');
    writeFileSync(join(wt.path, 'new.txt'), 'x');
    await git.checkpoint(wt.path, 'c');
    expect(await git.changedFiles(wt.path, wt.baseCommit)).toEqual(['new.txt']);
    await git.removeWorktree(d, root, wt.path, wt.branch);
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(join(d, 'node_modules', 'dep.js'), 'utf8')).toBe('dep'); // target intact
  });

  it('does not link when node_modules is not git-ignored', async () => {
    const d = repo(false), root = join(tmp(), 'wt');
    const git = new Git();
    const wt = await git.createWorktree(d, root, 'p', 'task', 'abcdef');
    // node_modules was committed in this repo, so the worktree already has its own copy.
    expect(await git.linkDependencies(d, wt.path)).toBe(false);
    expect(lstatSync(join(wt.path, 'node_modules')).isSymbolicLink()).toBe(false);
  });
});
