import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, readLogTail, redactSecrets } from '../src/main/logger';
import { createHarborService } from '../src/main/service';
import { projectPathRefusal } from '../src/main/projectPath';
import { Journal } from '../src/main/journal';

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'harbor-platform-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('logger', () => {
  it('redacts secret-looking strings', () => {
    const t = redactSecrets('key sk-ant-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuv and Authorization: Bearer abcdefghijklmnop12345 password=hunter2hunter2 {"apiKey":"abcd1234efgh"}');
    expect(t).not.toMatch(/sk-ant|ghp_|abcdefghijklmnop12345|hunter2|abcd1234efgh/);
    expect(t).toContain('[redacted');
  });

  it('writes redacted lines and keeps at most three files', () => {
    const dir = tmp();
    const log = createLogger(dir, { maxBytes: 300, files: 3 });
    for (let i = 0; i < 40; i++) log.error(`failure ${i} token=supersecretvalue${i}`, new Error('boom'));
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['main.log', 'main.log.1', 'main.log.2']);
    const all = names.map((n) => readFileSync(join(dir, n), 'utf8')).join('');
    expect(all).not.toContain('supersecretvalue');
    expect(all).toContain('ERROR failure 39');
    expect(readLogTail(dir, 2).split('\n').length).toBeLessThanOrEqual(2);
  });

  it('never throws when the folder is unusable', () => {
    const dir = tmp();
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    expect(() => createLogger(join(blocker, 'logs')).info('hello')).not.toThrow();
  });
});

describe('journal kinds', () => {
  it('accepts permission and rollback entries', () => {
    const j = new Journal();
    j.add({ kind: 'permission', projectId: 'p', text: 'Bash: asked' });
    j.add({ kind: 'rollback', projectId: 'p', text: 'rolled back' });
    expect(j.list('p').map((e) => e.kind)).toEqual(['permission', 'rollback']);
  });
});

describe('addProject path guard', () => {
  it('refuses roots, home, missing paths and files, with readable errors', async () => {
    const svc = createHarborService({ discover: async () => [] });
    const file = join(tmp(), 'a.txt');
    writeFileSync(file, 'x');
    await expect(svc.addProject(parse(process.cwd()).root)).rejects.toThrow(/drive root/);
    await expect(svc.addProject(homedir())).rejects.toThrow(/home folder/);
    await expect(svc.addProject(join(tmp(), 'nope'))).rejects.toThrow(/does not exist/);
    await expect(svc.addProject(file)).rejects.toThrow(/Not a folder/);
    const ok = await svc.addProject(tmp());
    expect(ok?.path).toBeTruthy();
    expect(projectPathRefusal(tmp())).toBeUndefined();
    svc.shutdown();
  });
});

describe('exportDiagnostics', () => {
  it('returns a redacted bundle with counts, journal and log tail, and a quarantine notice', async () => {
    const dataDir = tmp();
    const logs = join(dataDir, 'logs');
    mkdirSync(logs, { recursive: true });
    appendFileSync(join(logs, 'main.log'), '2026-01-01T00:00:00.000Z ERROR something token=abcdefabcdef123456\n');
    writeFileSync(join(dataDir, 'state.json.corrupt-123'), '{');
    const cli = { id: 'claude', name: 'Claude Code', installed: true, version: '9.9.9', path: 'claude', signedIn: false, authState: 'signedOut', models: [] };
    const svc = createHarborService({ dataDir, discover: async () => [cli as never], appVersion: '1.2.3' });
    const project = (await svc.addProject(tmp()))!;
    svc.orchestrator.journal.add({ kind: 'permission', projectId: project.id, text: 'Bash: allowed by a project rule' });
    const text = await svc.exportDiagnostics();
    svc.shutdown();
    expect(text).toContain('App version: 1.2.3');
    expect(text).toMatch(/claude: installed 9\.9\.9; auth signedOut/);
    expect(text).toContain('Projects: 1');
    expect(text).toContain('[permission] Bash: allowed by a project rule');
    expect(text).toContain('ERROR something');
    expect(text).not.toContain('abcdefabcdef123456');
    expect(text).toContain('state.json.corrupt-123');
  });
});
