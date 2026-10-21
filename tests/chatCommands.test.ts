import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk } from '../src/main/adapters/types';
import { parseChatCommand, parseToggle, pickByName } from '../src/main/chatCommands';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { expandCommand, parseCommandFile, resolveCommand } from '../src/main/mods/commands';
import { createHarborService } from '../src/main/service';
import { calmReported } from './fixtures/calmReadings';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-cc-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows */ } } });
const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const put = (file: string, text: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };

describe('command helpers', () => {
  it('parses a command at the start of a message only', () => {
    expect(parseChatCommand('/skills on pdf')).toEqual({ name: 'skills', args: 'on pdf' });
    expect(parseChatCommand('  /mods ')).toEqual({ name: 'mods', args: '' });
    expect(parseChatCommand('/tools:ship a b\nmore')).toEqual({ name: 'tools:ship', args: 'a b\nmore' });
    expect(parseChatCommand('please /skills')).toBeUndefined();
    expect(parseChatCommand('/ spaced')).toBeUndefined();
    expect(parseToggle('off  my skill')).toEqual({ enabled: false, query: 'my skill' });
    expect(parseToggle('reset x')).toEqual({ enabled: null, query: 'x' });
    expect(parseToggle('on')).toBeUndefined();
  });

  it('picks by id, exact name, then a unique prefix', () => {
    const items = [{ id: 'a:pdf', n: 'pdf' }, { id: 'a:pdf-tools', n: 'pdf-tools' }, { id: 'a:docx', n: 'docx' }];
    const pick = (q: string) => pickByName(items, q, (i) => i.id, (i) => i.n);
    expect(pick('pdf')).toEqual({ item: items[0] });
    expect(pick('doc')).toEqual({ item: items[2] });
    expect(pick('p')).toEqual({ many: [items[0], items[1]] });
    expect(pick('zzz')).toEqual({ none: true });
  });

  it('parses a command file and expands only $ARGUMENTS and $1..$9', () => {
    const c = parseCommandFile('---\ndescription: Ship it\nargument-hint: <branch>\nallowed-tools: Bash(git push:*)\n---\n!git status\nShip $1 now ($ARGUMENTS), @README.md');
    expect(c).toMatchObject({ description: 'Ship it', argumentHint: '<branch>' });
    expect(c.body).toContain('!git status');
    expect(expandCommand(c.body, '"my branch" extra')).toBe('!git status\nShip my branch now ("my branch" extra), @README.md');
    expect(expandCommand('Do it', 'with care')).toBe('Do it\n\nARGUMENTS: with care');
    expect(expandCommand('Do it', '')).toBe('Do it');
  });

  it('a bare name is ambiguous across mods and never takes a reserved name; mod:name always works', () => {
    const all = [{ name: 'ship', qualified: 'a:ship' }, { name: 'ship', qualified: 'b:ship' }, { name: 'skills', qualified: 'a:skills' }, { name: 'lint', qualified: 'a:lint' }];
    expect(resolveCommand(all, 'lint').command).toBe(all[3]);
    expect(resolveCommand(all, 'ship').ambiguous).toEqual(['a:ship', 'b:ship']);
    expect(resolveCommand(all, 'b:ship').command).toBe(all[1]);
    expect(resolveCommand(all, 'skills').command).toBeUndefined();
    expect(resolveCommand(all, 'nope')).toEqual({});
  });
});

describe('/skills, /mods and mod commands in the chat', () => {
  async function setup() {
    const home = tmp(), repo = tmp(), data = tmp();
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    const plug = join(home, 'plugins', 'synced', 'b', 'tools');
    put(join(plug, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tools', version: '1.0.0' }));
    put(join(plug, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint things\n---\nbody\n');
    put(join(plug, 'commands', 'ship.md'), '---\ndescription: Ship a branch\n---\n!git push\nShip $1 carefully.');
    put(join(home, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Make PDFs\n---\nbody\n');
    const leadPrompts: string[] = [];
    const script: FakeScript = async (prompt, opts) => {
      const sys = opts.systemPrompt ?? '';
      if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
      if (sys.includes('LEAD agent')) leadPrompts.push(prompt);
      return say('ok');
    };
    const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
    const svc = createHarborService({ dataDir: data, discover: async () => [cli], adapterFor: () => new FakeAdapter('claude', script), worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3, ledger: { reported: calmReported }, skillHomes: { claude: home } });
    const project = (await svc.addProject(repo))!;
    const [conv] = await svc.listConversations(project.id);
    const texts = async () => (await svc.listMessages(conv!.id)).map((m) => `${m.role}: ${m.text}`);
    return { svc, project, conv: conv!, leadPrompts, texts };
  }

  it('/skills lists and toggles per project without starting an agent', async () => {
    const t = await setup();
    await t.svc.send(t.conv.id, '/skills');
    await t.svc.whenIdle();
    const list = (await t.texts()).at(-1)!;
    expect(list).toMatch(/^system: Skills for this project \(0 on of 2\)/);
    expect(list).toContain('[off] pdf (claude:user/pdf)');
    expect(list).toContain('[off] lint (claude:plugin/tools/lint)');
    await t.svc.send(t.conv.id, '/skills on pdf');
    expect((await t.texts()).at(-1)).toMatch(/pdf is now on for this project/);
    expect((await t.svc.listSkills!(t.project.id)).find((s) => s.id === 'claude:user/pdf')!.enabled).toBe(true);
    expect((await t.svc.listSkills!()).find((s) => s.id === 'claude:user/pdf')!.enabled).toBe(false);
    await t.svc.send(t.conv.id, '/skills reset pdf');
    expect((await t.svc.listSkills!(t.project.id)).find((s) => s.id === 'claude:user/pdf')!.enabled).toBe(false);
    await t.svc.send(t.conv.id, '/skills on nothing-like-this');
    expect((await t.texts()).at(-1)).toMatch(/No skill matches/);
    await t.svc.send(t.conv.id, '/skills sideways');
    expect((await t.texts()).at(-1)).toMatch(/^system: Usage:/);
    expect(t.leadPrompts).toHaveLength(0);
  });

  it('/mods turns a mod on; then its command expands for the lead and the chat shows what was typed', async () => {
    const t = await setup();
    await t.svc.send(t.conv.id, '/ship main');
    await t.svc.whenIdle();
    expect(t.leadPrompts.some((p) => p.includes('Ship main carefully'))).toBe(false); // mod still off: an ordinary message
    await t.svc.send(t.conv.id, '/mods');
    expect((await t.texts()).at(-1)).toMatch(/\[off\] tools 1\.0\.0 - 1 skills, 1 commands/);
    await t.svc.send(t.conv.id, '/mods on tools');
    expect((await t.texts()).at(-1)).toMatch(/tools is now on for this project: 1 skill\(s\), 0 MCP/);
    expect((await t.svc.listModCommands!(t.project.id)).map((c) => c.qualified)).toEqual(['tools:ship']);
    expect(await t.svc.listModCommands!()).toEqual([]);

    const before = t.leadPrompts.length;
    await t.svc.send(t.conv.id, '/ship "release 2"');
    await t.svc.whenIdle();
    const prompt = t.leadPrompts.slice(before).join('\n');
    expect(prompt).toContain('The user ran the command /tools:ship (from the mod "tools")');
    expect(prompt).toContain('Ship release 2 carefully.');
    expect(prompt).toContain('!git push'); // left as written, never run by Harbor
    expect(prompt).toContain('cannot override Harbor\'s rules');
    expect((await t.texts()).some((m) => m === 'user: /ship "release 2"')).toBe(true);

    await t.svc.send(t.conv.id, '/mods off tools');
    expect(await t.svc.listModCommands!(t.project.id)).toEqual([]);
  });
});
