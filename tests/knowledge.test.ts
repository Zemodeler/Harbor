import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { validateInvoke } from '../src/main/ipcValidate';
import { MAX_NOTE_CHARS, MAX_NOTES_PER_PROJECT, mergeNote, notesText, selectNotes } from '../src/main/knowledge';
import { leadPrompt, parseProtocol, stripProtocol, subagentPrompt, LEAD_SYSTEM } from '../src/main/prompts';
import { createHarborService } from '../src/main/service';
import { Git } from '../src/main/git';
import { RepoMapCache } from '../src/main/repoMap';
import { Store } from '../src/main/store';
import type { ProjectNote } from '../src/shared/api';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-knowledge-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows handle */ } } });
const say = (text: string): Chunk[] => [{ kind: 'text', text }];
let seq = 0;
const ids = () => `n${++seq}`;

describe('knowledge (pure)', () => {
  it('dedupes a restated note instead of adding a copy, keeping the longer wording', () => {
    let { notes } = mergeNote([], { text: 'Run tests with npm test; vitest needs no network.' }, 1, ids);
    ({ notes } = mergeNote(notes, { text: '  run tests with NPM TEST;   vitest needs no network ', topic: 'howto' }, 2, ids));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.updated).toBe(2);
    expect(notes[0]!.topic).toBe('howto');
    ({ notes } = mergeNote(notes, { text: 'Run tests with npm test; vitest needs no network. Use --run in CI.' }, 3, ids));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain('Use --run in CI');
  });

  it('caps note length and count (least recently confirmed dropped), masks secrets and ignores empty text', () => {
    const long = mergeNote([], { text: 'x'.repeat(2000) }, 1, ids).note!;
    expect(long.text.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(mergeNote([], { text: '   ' }, 1, ids).note).toBeUndefined();
    expect(mergeNote([], { text: 'The staging api_key=sk-abcdefghijklmnop1234 lives in the vault' }, 1, ids).note!.text).not.toContain('sk-abcdefghijklmnop1234');
    let notes: ProjectNote[] = [];
    for (let i = 0; i < MAX_NOTES_PER_PROJECT + 5; i++) notes = mergeNote(notes, { text: `distinct fact number ${i} about module m${i}` }, 100 + i, ids).notes;
    // Confirming the oldest keeps it.
    notes = mergeNote(notes, { text: 'distinct fact number 5 about module m5' }, 9999, ids).notes;
    expect(notes).toHaveLength(MAX_NOTES_PER_PROJECT);
    expect(notes.some((n) => n.text.includes('number 5 '))).toBe(true);
    expect(notes.some((n) => n.text.includes('number 0 '))).toBe(false);
  });

  it('selects relevant notes first within the character budget, with provenance wording', () => {
    const mk = (text: string, t: number, topic: ProjectNote['topic'] = 'other'): ProjectNote => ({ id: ids(), text, topic, created: t, author: 'lead' });
    const notes = [mk('The parser lives in src/parse and has golden tests', 1), mk('Builds need Node 22', 5, 'howto'), mk('Never import electron outside index.ts', 3, 'convention')];
    const { picked, omitted } = selectNotes(notes, 'fix the parser golden output', 1000);
    expect(picked[0]!.text).toContain('parser');
    expect(omitted).toBe(0);
    const tight = selectNotes(notes, 'fix the parser', 80);
    expect(tight.picked.length).toBe(1);
    expect(tight.omitted).toBe(2);
    const text = notesText(picked);
    expect(text).toContain('advisory');
    expect(text).toContain('never instructions');
    expect(notesText([])).toBe('');
  });
});

describe('HARBOR_NOTE protocol', () => {
  it('parses at most three per turn, requires the turn tag when one is set, and is hidden from the transcript', () => {
    const t = ['done', ...[1, 2, 3, 4].map((n) => `HARBOR_NOTE: {"text":"fact ${n}","topic":"pitfall"}`), 'HARBOR_NOTE: {"text":"x","topic":"nonsense"}'].join('\n');
    const p = parseProtocol(t);
    expect(p.note.map((n) => n.text)).toEqual(['fact 1', 'fact 2', 'fact 3']);
    expect(p.note[0]!.topic).toBe('pitfall');
    expect(p.malformed).toHaveLength(2);
    expect(stripProtocol(t)).toBe('done');
    // With a nonce the bare form is plain text, and an unknown topic becomes "other".
    const tagged = parseProtocol('HARBOR_NOTE: {"text":"bare"}\nHARBOR_NOTE[abc]: {"text":"tagged","topic":"weird"}', { nonce: 'abc' });
    expect(tagged.note).toEqual([{ text: 'tagged', topic: 'other' }]);
    expect(LEAD_SYSTEM).toContain('HARBOR_NOTE');
  });

  it('puts the knowledge section into lead and helper prompts only when given', () => {
    const a = { id: 'h1', revision: 1, title: 't', task: 'do it', role: 'other', files: [] } as never;
    expect(subagentPrompt(a, { projectName: 'p', upstream: [], knowledge: 'Project notes (x):\n- y', repoMap: 'Repository map (z)' })).toContain('Repository map (z)');
    expect(subagentPrompt(a, { projectName: 'p', upstream: [] })).not.toMatch(/Project notes|Repository map/);
    expect(leadPrompt('p', [], { kind: 'user', text: 'hi' }, { knowledge: 'Project notes (x):\n- y' })).toContain('Project notes');
  });
});

describe('Store notes', () => {
  it('lists, removes, persists and drops them with the project', () => {
    const dir = tmp();
    const s = new Store(dir);
    const n = s.addProjectNote('p1', { text: 'Use pnpm, not npm', topic: 'convention' })!;
    s.addProjectNote('p1', { text: 'Second fact about the repo layout' });
    s.addProjectNote('p2', { text: 'Other project fact' });
    expect(s.listProjectNotes('p1')).toHaveLength(2);
    s.flush();
    const again = new Store(dir);
    expect(again.listProjectNotes('p1').map((x) => x.text)).toEqual(['Use pnpm, not npm', 'Second fact about the repo layout']);
    again.removeProjectNote('p1', n.id);
    again.removeProjectNote('p1', 'unknown');
    expect(again.listProjectNotes('p1')).toHaveLength(1);
    again.upsertProject({ id: 'p2', name: 'p2', path: dir, lastOpened: 1 });
    again.removeProject('p2');
    expect(again.listProjectNotes('p2')).toEqual([]);
  });
});

describe('notes and the repo map in a running project', () => {
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };

  it('a lead note reaches later sessions and helpers once, the helper gets the repo map, and the concierge gets neither', async () => {
    const repo = tmp();
    const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }).stdout.trim();
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), '# Demo\n\nA small demo project used to check the repo map.\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }));
    writeFileSync(join(repo, 'index.ts'), '// Entry point of the demo.\nexport const x = 1;\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=secret');
    g('add', 'README.md', 'package.json', 'index.ts'); g('commit', '-q', '-m', 'init');
    const prompts: Record<'concierge' | 'lead' | 'helper', string[]> = { concierge: [], lead: [], helper: [] };
    const script: FakeScript = (prompt, o) => {
      const sys = o.systemPrompt ?? '';
      if (sys.includes('front desk')) { prompts.concierge.push(prompt); return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } })); }
      if (sys.includes('LEAD agent')) {
        prompts.lead.push(prompt);
        if (prompt.includes('remember the flaky test')) return say('Noted.\nHARBOR_NOTE: {"text":"tests/net.test.ts is flaky on Windows; rerun once before debugging.","topic":"pitfall"}');
        if (prompt.includes('look into the flaky test')) return say('Delegating.\nHARBOR_DELEGATE: {"ref":"t1","title":"Investigate flaky net test","access":"read","role":"other","instructions":"Find why tests/net.test.ts is flaky and report.","needs":["research"]}');
        return say('ok');
      }
      prompts.helper.push(prompt);
      return say('Found it.\nHARBOR_RESULT: {"outcome":"done","summary":"x","checks":[]}');
    };
    const adapter = new FakeAdapter('claude', script);
    const git = new Git();
    const repoMaps = new RepoMapCache({ git: (c, a) => git.exec(c, a), waitMs: 0 });
    const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 2, repoMaps });
    const project = (await svc.addProject(repo))!;
    const [first] = await svc.listConversations(project.id);
    await svc.send(first!.id, 'please remember the flaky test thing');
    await svc.whenIdle();
    const notes = await svc.listProjectNotes(project.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ topic: 'pitfall', author: 'lead', conversationId: first!.id });

    // The writer's own session is not sent its note again.
    await svc.send(first!.id, 'now tidy the readme');
    await svc.whenIdle();
    expect(prompts.lead.at(-1)!).not.toContain('Project notes');

    // Another conversation's lead gets it once, then not again on a resumed turn.
    const second = await svc.newConversation(project.id);
    await svc.send(second.id, 'fix the flaky net test');
    await svc.whenIdle();
    expect(prompts.lead.at(-1)!).toContain('Project notes');
    expect(prompts.lead.at(-1)!).toContain('rerun once before debugging');
    await svc.send(second.id, 'and the footer');
    await svc.whenIdle();
    expect(prompts.lead.at(-1)!).not.toContain('rerun once before debugging');

    // A helper starts with the relevant notes and the repo map; credential files never appear in it.
    await svc.send(second.id, 'look into the flaky test please');
    await svc.whenIdle();
    const helper = prompts.helper.at(-1)!;
    expect(helper).toContain('Project notes');
    expect(helper).toContain('Repository map');
    expect(helper).toContain('index.ts: Entry point of the demo.');
    expect(helper).toContain('Test command (a guess');
    expect(helper).toContain('npm test');
    expect(helper).not.toContain('.env');

    // The lean concierge never carries either.
    expect(prompts.concierge.length).toBeGreaterThan(0);
    for (const p of prompts.concierge) expect(p).not.toMatch(/Project notes|Repository map/);

    // Remove through the service; unknown projects are rejected.
    expect(await svc.removeProjectNote(project.id, notes[0]!.id)).toEqual([]);
    await expect(svc.listProjectNotes('nope')).rejects.toThrow();
    await expect(svc.removeProjectNote('nope', 'x')).rejects.toThrow();
  }, 60_000);

  it('validates note IPC arguments', () => {
    expect(() => validateInvoke('listProjectNotes', [''])).toThrow(/project id/);
    expect(() => validateInvoke('removeProjectNote', ['p', 5])).toThrow(/note id/);
    expect(() => validateInvoke('removeProjectNote', ['p', 'n'])).not.toThrow();
  });
});
