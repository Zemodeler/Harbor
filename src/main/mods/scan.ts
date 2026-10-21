import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import type { Mod, ModPart } from '../../shared/api';

/**
 * Mods = Claude Code plugins found on this machine (Phase A: read-only listing, nothing is enabled or run).
 *
 * A plugin folder is any folder with `.claude-plugin/plugin.json`. Layout VERIFIED on this machine (2026-10-21): the Claude desktop app
 * syncs account plugins to `~/.claude/plugins/synced/<bucket>/<plugin>/` and each holds `.claude-plugin/plugin.json` (name, version,
 * description, author), `skills/<skill>/SKILL.md`, and optionally `.mcp.json` ({"mcpServers": {...}}). NOT VERIFIED (no such install here):
 * `~/.claude/plugins/cache/...` and `~/.claude/plugins/installed_plugins.json` written by `claude plugin install`, the `commands/`,
 * `agents/` and `hooks/hooks.json` conventions of the public plugin docs, and a project's `.claude/plugins`. They are looked for, so a
 * machine that has them lists them; a parse failure only drops that plugin. The walk is bounded and follows no links.
 */
/** A plugin name made safe for ids and registry names. */
export const modSlug = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'mod';

const MAX_DEPTH = 6;
const MAX_WALK = 4000;
const MAX_MODS = 200;
const MAX_PART_NAMES = 40;
const MAX_JSON = 256 * 1024;

const lst = (p: string) => { try { return statSync(p); } catch { return undefined; } };
const readJson = (p: string): Record<string, unknown> | undefined => {
  try {
    const st = lst(p);
    if (!st?.isFile() || st.size > MAX_JSON) return undefined;
    const j = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch { return undefined; }
};
const line = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const dirents = (p: string): Dirent[] => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };

/** Folders that contain `.claude-plugin/plugin.json`, found under `root` (not inside another plugin). */
export function findPluginDirs(root: string): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    if (out.length >= MAX_MODS || depth > MAX_DEPTH) return;
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) { out.push(dir); return; }
    for (const e of dirents(dir)) {
      if (++seen > MAX_WALK) return;
      if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(dir, e.name), depth + 1);
    }
  };
  if (lst(root)?.isDirectory()) walk(root, 0);
  return out;
}

function skillNames(dir: string): string[] {
  return dirents(join(dir, 'skills')).filter((e) => e.isDirectory() && !e.isSymbolicLink() && existsSync(join(dir, 'skills', e.name, 'SKILL.md'))).map((e) => e.name).sort();
}
function mdNames(dir: string, sub: string): string[] {
  return dirents(join(dir, sub)).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name.slice(0, -3)).sort();
}
function mcpNames(dir: string, manifest: Record<string, unknown>): string[] {
  const fromFile = readJson(join(dir, '.mcp.json'));
  const servers = (fromFile?.['mcpServers'] ?? manifest['mcpServers']) as unknown;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers as object).sort() : [];
}
function hookEvents(dir: string, manifest: Record<string, unknown>): string[] {
  const fromFile = readJson(join(dir, 'hooks', 'hooks.json'));
  const hooks = (fromFile?.['hooks'] ?? manifest['hooks']) as unknown;
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? Object.keys(hooks as object).sort() : [];
}

/** What Harbor does with each kind of part today. Honest about Phase A: nothing here is switched on. */
const NOTE: Record<ModPart['kind'], { status: ModPart['status']; note: string }> = {
  skills: { status: 'ready', note: 'Its skills are listed with the other skills, off by default; turning the mod on enables them for the project.' },
  commands: { status: 'planned', note: 'Slash commands would be expanded by Harbor in chat. Not built yet.' },
  mcp: { status: 'ready', note: 'Its http/sse servers are imported into Harbor\'s MCP registry and enabled with the mod. stdio servers, servers with no URL and servers with ${...} placeholders are not imported: add them yourself under MCP.' },
  hooks: { status: 'claude-only', note: 'Hooks are a Claude Code feature. Harbor does not run them yet and would only pass them to Claude runs, after your approval.' },
  agents: { status: 'unused', note: 'Harbor delegates through its own lead and helpers, so a plugin\'s agents are not used.' }
};

function part(kind: ModPart['kind'], names: string[]): ModPart | undefined {
  return names.length ? { kind, count: names.length, names: names.slice(0, MAX_PART_NAMES), ...NOTE[kind] } : undefined;
}

export interface ModScanOptions {
  /** `~/.claude`. Absent = nothing to scan. */
  claudeHome?: string;
  /** A project folder: its `.claude/plugins` is scanned too. */
  projectPath?: string;
}

export function scanMods(o: ModScanOptions): Mod[] {
  const roots: Array<{ root: string; source: Mod['source'] }> = [];
  if (o.claudeHome) roots.push({ root: join(o.claudeHome, 'plugins'), source: 'claude' });
  if (o.projectPath) roots.push({ root: join(o.projectPath, '.claude', 'plugins'), source: 'project' });
  const enabled = new Set<string>();
  if (o.claudeHome) {
    const ep = readJson(join(o.claudeHome, 'settings.json'))?.['enabledPlugins'];
    if (ep && typeof ep === 'object' && !Array.isArray(ep)) for (const [k, v] of Object.entries(ep as Record<string, unknown>)) if (v === true) enabled.add(k.split('@')[0]!.toLowerCase());
  }
  const mods: Mod[] = [];
  const seen = new Set<string>();
  for (const { root, source } of roots) {
    for (const dir of findPluginDirs(root)) {
      const m = readJson(join(dir, '.claude-plugin', 'plugin.json'));
      if (!m) continue;
      const name = line(m['name'], 80) || basename(dir);
      const version = line(m['version'], 40);
      const key = `${source}:${name}`.toLowerCase();
      if (seen.has(key)) continue; // an older cached copy of the same plugin is not listed twice
      seen.add(key);
      const author = m['author'] && typeof m['author'] === 'object' ? line((m['author'] as Record<string, unknown>)['name'], 80) : line(m['author'], 80);
      const parts = [
        part('skills', skillNames(dir)), part('commands', mdNames(dir, 'commands')), part('mcp', mcpNames(dir, m)),
        part('hooks', hookEvents(dir, m)), part('agents', mdNames(dir, 'agents'))
      ].filter((p): p is ModPart => !!p);
      mods.push({
        id: `${source}:${name}`, name, ...(version ? { version } : {}), description: line(m['description'], 400), ...(author ? { author } : {}),
        source, path: dir, parts, enabledInClaude: enabled.has(name.toLowerCase())
      });
    }
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name));
}
