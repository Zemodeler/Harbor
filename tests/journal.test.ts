import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadChecks, runShellCheck } from '../src/main/checks';
import { Journal, journalDigest } from '../src/main/journal';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-journal-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('run journal', () => {
  it('persists entries as JSONL, survives a corrupt line, and filters by project', () => {
    const file = join(tmp(), 'journal.jsonl');
    const j = new Journal(file);
    j.add({ kind: 'protocol', projectId: 'p1', text: 'bad line' });
    j.add({ kind: 'helper-failed', projectId: 'p2', text: 'boom' });
    writeFileSync(file, '{not json\n', { flag: 'a' });
    const again = new Journal(file);
    expect(again.list('p1').map((e) => e.text)).toEqual(['bad line']);
    expect(again.list('p2')).toHaveLength(1);
  });

  it('digests counts by kind and the most recent entries', () => {
    const j = new Journal();
    for (const kind of ['protocol', 'protocol', 'fallback'] as const) j.add({ kind, projectId: 'p', text: `${kind} happened` });
    const d = journalDigest(j.list('p'));
    expect(d).toMatch(/Run journal: 3 entries/);
    expect(d).toContain('By kind: protocol 2, fallback 1.');
    expect(d).toContain('[fallback] fallback happened');
    expect(journalDigest([])).toMatch(/empty/);
  });
});

describe('project checks', () => {
  it('reads .harbor/checks.json and ignores missing or malformed files', () => {
    const p = tmp();
    expect(loadChecks(p)).toEqual([]);
    mkdirSync(join(p, '.harbor'));
    writeFileSync(join(p, '.harbor', 'checks.json'), JSON.stringify({ checks: ['npm test', '', 3, 'npm run build'] }));
    expect(loadChecks(p)).toEqual(['npm test', 'npm run build']);
    writeFileSync(join(p, '.harbor', 'checks.json'), '{oops');
    expect(loadChecks(p)).toEqual([]);
  });

  it('runs a command in the given folder and reports exit code and output', async () => {
    const p = tmp();
    const ok = await runShellCheck('node -e "console.log(process.cwd())"', p);
    expect(ok).toMatchObject({ ok: true, exitCode: 0 });
    expect(ok.output.toLowerCase()).toContain(p.toLowerCase());
    const bad = await runShellCheck('node -e "console.error(\'nope\'); process.exit(3)"', p);
    expect(bad).toMatchObject({ ok: false, exitCode: 3 });
    expect(bad.output).toContain('nope');
  });

  it('stops a running check when aborted', async () => {
    const ctl = new AbortController();
    const run = runShellCheck('node -e "setTimeout(() => {}, 60000)"', tmp(), ctl.signal);
    setTimeout(() => ctl.abort(), 200);
    const r = await run;
    expect(r.ok).toBe(false);
    expect(r.durationMs).toBeLessThan(20000);
  });
});
