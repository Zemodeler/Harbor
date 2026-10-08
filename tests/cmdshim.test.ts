import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { streamLines } from '../src/main/adapters/stream';
import { runProcess } from '../src/main/proc';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

// npm-installed CLIs (codex, gemini) are .cmd shims on Windows; Node needs a shell for them.
describe.skipIf(process.platform !== 'win32')('Windows .cmd shims', () => {
  function shim() {
    const d = mkdtempSync(join(tmpdir(), 'harbor shim '));   // space in the path on purpose
    dirs.push(d);
    writeFileSync(join(d, 'echo.js'), "process.stdout.write(process.argv.slice(2).join('|') + '\\n'); process.stdin.pipe(process.stdout);");
    const p = join(d, 'fakecli.cmd');
    writeFileSync(p, `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    return p;
  }

  it('runProcess passes args and stdin through a .cmd with spaces in its path', async () => {
    const r = await runProcess(shim(), ['--version', 'a b'], { input: 'from-stdin', timeoutMs: 20000 });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--version|a b');
    expect(r.stdout).toContain('from-stdin');
  });

  it('streamLines works through a .cmd shim and rejects unsafe arguments', async () => {
    const gen = streamLines(shim(), ['exec', '-'], { cwd: process.cwd(), input: 'hello\n' });
    const lines: string[] = [];
    let r = await gen.next();
    while (!r.done) { lines.push(r.value.line); r = await gen.next(); }
    expect(lines).toContain('exec|-');
    expect(lines).toContain('hello');

    // Shell metacharacters stay literal inside the quotes (tool allow-list patterns need this).
    const meta = await runProcess(shim(), ['Bash(git *)', 'a & b'], { timeoutMs: 20000 });
    expect(meta.stdout).toContain('Bash(git *)|a & b');

    const bad = streamLines(shim(), ['%PATH%'], { cwd: process.cwd(), input: '' });
    let b = await bad.next();
    while (!b.done) b = await bad.next();
    expect(b.value.spawnError).toMatch(/Unsafe argument/);
  });
});
