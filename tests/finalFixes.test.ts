import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isGitDestructive } from '../src/main/adapters/claude';
import { isInside } from '../src/main/git';
import { newProtocolNonce, nonceInstruction, parseProtocol } from '../src/main/prompts';

const bash = (command: string) => isGitDestructive('Bash', { command });

describe('isGitDestructive', () => {
  it('does not deny commits and searches whose text mentions a destructive word', () => {
    expect(bash('git commit -m "add config loader and restore defaults"')).toBe(false);
    expect(bash("git commit -m 'push the remote button'")).toBe(false);
    expect(bash('git commit --message="prune old config"')).toBe(false);
    expect(bash('git log --grep "restore" --oneline')).toBe(false);
    expect(bash('git log -S clean --oneline')).toBe(false);
  });

  it('still denies real destructive commands, including ones that carry a message-like option', () => {
    expect(bash('git clean -fd')).toBe(true);
    expect(bash('git restore .')).toBe(true);
    expect(bash('git checkout -- .')).toBe(true);
    expect(bash('git branch -D main')).toBe(true);
    expect(bash('git -C ../other status')).toBe(true);
    expect(bash('git commit -m "ok" && git push --force')).toBe(true);
    expect(bash('git "clean" -fd')).toBe(true);
  });

  it('ignores non-Bash tools', () => {
    expect(isGitDestructive('Edit', { command: 'git clean -fd' })).toBe(false);
  });
});

describe('protocol nonce', () => {
  it('is unpredictable, URL-safe and accepted by the parser', () => {
    const a = newProtocolNonce(), b = newProtocolNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(nonceInstruction(a)).toContain(`[${a}]`);
    const line = `HARBOR_DECISION[${a}]: {"text":"use sqlite"}`;
    expect(parseProtocol(line, { nonce: a }).decision).toEqual(['use sqlite']);
    expect(parseProtocol(line, { nonce: b }).decision).toEqual([]);
  });
});

describe('isInside with Windows short names', () => {
  it('treats the 8.3 and long spelling of one folder as the same folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'harbor-short-'));
    try {
      const child = join(root, 'a', 'b');
      mkdirSync(child, { recursive: true });
      // Plain spellings: the same everywhere.
      expect(isInside(child, root)).toBe(true);
      expect(isInside(join(root, 'a', '..', '..'), root)).toBe(false);
      expect(isInside(join(root, 'not-created-yet', 'x'), root)).toBe(true);
      expect(isInside(root, root)).toBe(false);
      if (process.platform !== 'win32') return;
      // The short spelling of the folder (when the volume has 8.3 names enabled) must compare equal to the long one.
      const ps = '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($args[0]).ShortPath';
      const short = spawnSync('powershell', ['-NoProfile', '-Command', `& { ${ps} }`, root], { encoding: 'utf8' }).stdout.trim();
      if (short && existsSync(short) && short.toLowerCase() !== realpathSync.native(root).toLowerCase()) {
        expect(isInside(child, short)).toBe(true);
        expect(isInside(join(short, 'a', 'b'), root)).toBe(true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
