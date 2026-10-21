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
    expect(data.parts.map((p) => [p.kind, p.count, p.status])).toEqual([['skills', 2, 'ready'], ['mcp', 1, 'planned']]);
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
