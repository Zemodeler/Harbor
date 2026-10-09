import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Journal } from '../src/main/journal';
import { createHarborService } from '../src/main/service';

const dirs: string[] = [];
const tmp = (prefix = 'harbor-journal-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('Journal persistence', () => {
  it('entries survive a new Journal instance on the same file', () => {
    const file = join(tmp(), 'journal.jsonl');
    const j = new Journal(file);
    j.add({ kind: 'protocol', projectId: 'p1', text: 'malformed HARBOR_DELEGATE line' });
    j.add({ kind: 'checks-failed', projectId: 'p1', agentId: 'a1', text: 'npm test failed' });
    const again = new Journal(file);
    expect(again.list('p1').map((e) => e.kind)).toEqual(['protocol', 'checks-failed']);
    expect(again.list('p1')[1]!.agentId).toBe('a1');
  });

  it('entries survive a restart of the whole service', async () => {
    const dir = tmp('harbor-data-');
    const first = createHarborService({ dataDir: dir, discover: async () => [] });
    first.orchestrator.journal.add({ kind: 'helper-failed', projectId: 'p9', text: 'helper crashed' });
    first.shutdown();
    expect(existsSync(join(dir, 'journal.jsonl'))).toBe(true);

    const second = createHarborService({ dataDir: dir, discover: async () => [] });
    expect(second.orchestrator.journal.list('p9').map((e) => e.text)).toEqual(['helper crashed']);
    second.shutdown();
  });

  it('keeps no file when there is no data folder (in-memory, as in tests)', () => {
    const j = new Journal(undefined);
    j.add({ kind: 'triage', projectId: 'p1', text: 'x' });
    expect(j.list('p1')).toHaveLength(1);
  });

  it('caps stored text at 500 characters', () => {
    const file = join(tmp(), 'journal.jsonl');
    new Journal(file).add({ kind: 'protocol', projectId: 'p1', text: 'y'.repeat(2000) });
    const line = JSON.parse(readFileSync(file, 'utf8').trim()) as { text: string };
    expect(line.text).toHaveLength(500);
  });

  it('rotates the file once it passes the size bound, keeping one previous generation', () => {
    const file = join(tmp(), 'journal.jsonl');
    const j = new Journal(file, 1024);
    for (let i = 0; i < 40; i++) j.add({ kind: 'fallback', projectId: 'p1', text: `entry ${i} ${'z'.repeat(100)}` });
    expect(existsSync(`${file}.1`)).toBe(true);
    // The live file stays near the bound instead of growing with every entry.
    expect(statSync(file).size).toBeLessThanOrEqual(1024 + 300);
    // A rotation never leaves the live file empty: the newest entry is always there.
    expect(readFileSync(file, 'utf8')).toContain('entry 39');
  });

  it('a corrupt or foreign line does not break reading and is skipped', () => {
    const file = join(tmp(), 'journal.jsonl');
    const good = { time: 1, kind: 'protocol', projectId: 'p1', text: 'ok' };
    writeFileSync(file, [JSON.stringify(good), '{not json', 'null', '{"kind":5}', JSON.stringify({ ...good, text: 'also ok' })].join('\n') + '\n');
    appendFileSync(file, 'garbage tail without newline');
    const j = new Journal(file);
    expect(j.list('p1').map((e) => e.text)).toEqual(['ok', 'also ok']);
    // Writing after corruption still works.
    j.add({ kind: 'triage', projectId: 'p1', text: 'new' });
    expect(new Journal(file).list('p1').map((e) => e.text)).toEqual(['ok', 'also ok', 'new']);
  });
});
