import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { editorUrl, launchTerminal, terminalLaunches } from '../src/main/launcher';

describe('editorUrl', () => {
  it('builds a protocol URL with encoded path segments', () => {
    expect(editorUrl('code', 'C:\\Users\\me\\My Project')).toBe('vscode://file/C:/Users/me/My%20Project');
    expect(editorUrl('cursor', 'C:\\a\\b.ts')).toBe('cursor://file/C:/a/b.ts');
  });
  it('falls back to VS Code for an unknown editor and encodes shell characters', () => {
    expect(editorUrl('nope' as never, 'C:\\a')).toBe('vscode://file/C:/a');
    expect(editorUrl('code', 'C:\\a & calc\\x')).toContain('%26');
  });
});

describe('launchTerminal', () => {
  const fakeSpawn = (failing: string[]) => vi.fn((command: string) => {
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    setImmediate(() => child.emit(failing.includes(command) ? 'error' : 'spawn', new Error(`${command} missing`)));
    return child;
  }) as never;

  it('passes the folder as an argument or cwd, never in a command string', () => {
    const dir = 'C:\\a b & c';
    const [wt, fallback] = terminalLaunches(dir);
    expect(wt!.args).toEqual(['-d', dir]);
    expect(fallback!.args.join(' ')).not.toContain('a b & c');
    expect([wt, fallback].every(l => l!.cwd === dir)).toBe(true);
  });
  it('uses the first terminal that starts', async () => {
    const spawnFn = fakeSpawn([]);
    await launchTerminal('C:\\p', spawnFn);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
  it('falls back when Windows Terminal is missing and fails when nothing starts', async () => {
    const spawnFn = fakeSpawn(['wt.exe']);
    await launchTerminal('C:\\p', spawnFn);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    await expect(launchTerminal('C:\\p', fakeSpawn(['wt.exe', 'cmd.exe']))).rejects.toThrow(/Could not open a terminal/);
  });
});
