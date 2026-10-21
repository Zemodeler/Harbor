import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { findPluginDirs, scanMods } from '../src/main/mods/scan';
import { createHarborService } from '../src/main/service';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-mods-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const put = (file: string, text: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
function plugin(dir: string, manifest: object, parts: { skills?: string[]; commands?: string[]; agents?: string[]; mcp?: object; hooks?: object } = {}) {
  put(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
  for (const s of parts.skills ?? []) put(join(dir, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: d\n---\n`);
  for (const c of parts.commands ?? []) put(join(dir, 'commands', `${c}.md`), 'x');
  for (const a of parts.agents ?? []) put(join(dir, 'agents', `${a}.md`), 'x');
  if (parts.mcp) put(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: parts.mcp }));
  if (parts.hooks) put(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: parts.hooks }));
}

describe('mod scanner (Claude Code plugins, read-only)', () => {
  it('lists plugins from the synced layout with their parts and what Harbor does with each', () => {
    const home = tmp();
    plugin(join(home, 'plugins', 'synced', 'bucket', 'data'), { name: 'data', version: '1.1.0', description: 'SQL\nhelp', author: { name: 'Anthropic' } },
      { skills: ['analyze', 'sql-queries'], mcp: { bigquery: { type: 'http', url: 'https://x' } } });
    plugin(join(home, 'plugins', 'cache', 'mk', 'tools', '2.0.0'), { name: 'tools' }, { commands: ['ship'], agents: ['reviewer'], hooks: { PreToolUse: [] } });
    put(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'data@mk': true, 'tools@mk': false } }));
    const mods = scanMods({ claudeHome: home });
    expect(mods.map((m) => m.id)).toEqual(['claude:data', 'claude:tools']);
    const data = mods[0]!;
    expect(data).toMatchObject({ version: '1.1.0', author: 'Anthropic', description: 'SQL help', enabledInClaude: true, source: 'claude' });
    expect(data.parts.map((p) => [p.kind, p.count, p.status])).toEqual([['skills', 2, 'ready'], ['mcp', 1, 'ready']]);
    const tools = mods[1]!;
    expect(tools.enabledInClaude).toBe(false);
    expect(tools.parts.map((p) => [p.kind, p.status])).toEqual([['commands', 'planned'], ['hooks', 'claude-only'], ['agents', 'unused']]);
  });

  it('adds the project\'s own plugins, drops duplicates and broken manifests, and does not look inside a plugin', () => {
    const home = tmp(), project = tmp();
    plugin(join(home, 'plugins', 'synced', 'b', 'dup'), { name: 'dup' });
    plugin(join(home, 'plugins', 'cache', 'm', 'dup', '1'), { name: 'dup' });
    put(join(home, 'plugins', 'synced', 'b', 'broken', '.claude-plugin', 'plugin.json'), '{ nope');
    plugin(join(home, 'plugins', 'synced', 'b', 'outer'), { name: 'outer' });
    plugin(join(home, 'plugins', 'synced', 'b', 'outer', 'nested'), { name: 'nested' });
    plugin(join(project, '.claude', 'plugins', 'mine'), { name: 'mine' }, { skills: ['s'] });
    expect(findPluginDirs(join(home, 'plugins')).some((d) => d.endsWith('nested'))).toBe(false);
    const mods = scanMods({ claudeHome: home, projectPath: project });
    expect(mods.map((m) => m.id)).toEqual(['claude:dup', 'project:mine', 'claude:outer']);
    expect(scanMods({ claudeHome: join(home, 'missing') })).toEqual([]);
    expect(scanMods({})).toEqual([]);
  });

  it('is a read-only service method', async () => {
    const home = tmp();
    plugin(join(home, 'plugins', 'synced', 'b', 'p'), { name: 'p' }, { skills: ['a'] });
    expect(INVOKE_METHODS).toContain('listMods');
    const svc = createHarborService({ discover: async () => [], skillHomes: { claude: home } });
    expect((await svc.listMods!()).map((m) => m.name)).toEqual(['p']);
  });
});

describe('mods, phase B: enabling per project', () => {
  async function setup() {
    const home = tmp(), repo = tmp();
    plugin(join(home, 'plugins', 'synced', 'b', 'data'), { name: 'data' }, {
      skills: ['analyze', 'sql'],
      mcp: {
        bigquery: { type: 'http', url: 'https://bq.example/mcp' },
        local: { command: 'npx', args: ['x'] },
        empty: { type: 'http', url: '' },
        templ: { type: 'http', url: 'https://x.example/${TENANT}/mcp' },
        feed: { type: 'sse', url: 'https://feed.example/sse', headers: { 'X-Team': 'a' } }
      }
    });
    const svc = createHarborService({ discover: async () => [], skillHomes: { claude: home } });
    const project = (await svc.addProject(repo))!;
    return { svc, project, repo };
  }

  it('turning a mod on enables its skills and imports only usable http/sse servers, for that project only', async () => {
    const { svc, project } = await setup();
    const before = await svc.listSkills!(project.id);
    expect(before.filter((s) => s.id.startsWith('claude:plugin/data/')).map((s) => [s.id, s.enabled])).toEqual([['claude:plugin/data/analyze', false], ['claude:plugin/data/sql', false]]);

    const r = await svc.setModEnabled!('claude:data', true, project.id);
    expect(r.skills).toBe(2);
    expect(r.mcp.filter((m) => m.status === 'enabled').map((m) => m.name).sort()).toEqual(['data-bigquery', 'data-feed']);
    const skipped = Object.fromEntries(r.mcp.filter((m) => m.status === 'skipped').map((m) => [m.name, m.why]));
    expect(skipped['data-local']).toMatch(/stdio/);
    expect(skipped['data-empty']).toMatch(/no URL/);
    expect(skipped['data-templ']).toMatch(/placeholder/);
    expect(r.mod).toMatchObject({ skillsEnabled: 2, mcpEnabled: 2 });

    const servers = await svc.listMcpServers!(project.id);
    expect(servers.filter((s) => s.enabled).map((s) => [s.name, s.fromMod]).sort()).toEqual([['data-bigquery', 'claude:data'], ['data-feed', 'claude:data']]);
    expect(servers.find((s) => s.name === 'data-feed')).toMatchObject({ transport: 'sse', headers: { 'X-Team': 'a' } });
    // Not enabled anywhere else: the global default and other projects stay off.
    expect((await svc.listMcpServers!()).some((s) => s.enabled)).toBe(false);
    expect((await svc.listSkills!()).filter((s) => s.id.startsWith('claude:plugin/data/')).some((s) => s.enabled)).toBe(false);
    expect((await svc.listMods!(project.id))[0]).toMatchObject({ skillsEnabled: 2, mcpEnabled: 2 });
  });

  it('turning it off (or back to default) disables them again, and turning on twice imports nothing twice', async () => {
    const { svc, project } = await setup();
    await svc.setModEnabled!('claude:data', true, project.id);
    const again = await svc.setModEnabled!('claude:data', true, project.id);
    expect(again.mcp.filter((m) => m.status === 'enabled')).toHaveLength(2);
    expect((await svc.listMcpServers!()).filter((s) => s.fromMod)).toHaveLength(2);
    const off = await svc.setModEnabled!('claude:data', false, project.id);
    expect(off.mod).toMatchObject({ skillsEnabled: 0, mcpEnabled: 0 });
    expect(off.mcp.map((m) => m.status)).toEqual(['imported-off', 'imported-off']);
    const back = await svc.setModEnabled!('claude:data', null, project.id);
    expect(back.mod).toMatchObject({ skillsEnabled: 0, mcpEnabled: 0 });
  });

  it('never overwrites a different server that already has the name, and rejects unknown mods and bad values', async () => {
    const { svc, project } = await setup();
    await svc.saveMcpServer!({ name: 'data-bigquery', transport: 'http', url: 'https://mine.example/mcp' });
    const r = await svc.setModEnabled!('claude:data', true, project.id);
    expect(r.mcp.find((m) => m.name === 'data-bigquery')).toMatchObject({ status: 'skipped', why: expect.stringContaining('already exists') });
    expect((await svc.listMcpServers!(project.id)).find((s) => s.name === 'data-bigquery')).toMatchObject({ url: 'https://mine.example/mcp', enabled: false });
    await expect(svc.setModEnabled!('claude:nope', true, project.id)).rejects.toThrow(/no longer available/);
    await expect(svc.setModEnabled!('claude:data', 'yes' as unknown as boolean, project.id)).rejects.toThrow(/true, false or null/);
  });
});
