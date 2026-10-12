import { describe, expect, it } from 'vitest';
import { isGitDestructive } from '../src/main/adapters/claude';
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
