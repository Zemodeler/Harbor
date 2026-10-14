import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CliMcpServer } from '../../shared/api';
import { normPath } from '../store';

/**
 * The MCP servers Claude Code and Codex already know, listed read-only (Settings > MCP servers). Only names and kinds are taken:
 * these files can hold commands, URLs, tokens and env values, and none of that leaves this module. Nothing is changed or run.
 * Locations (from Claude Code's and Codex's own documentation; the Claude file shapes match the schema strings in claude.exe 2.1.295):
 * - Claude Code: `~/.claude.json` `mcpServers` (user scope) and `projects[<folder>].mcpServers` (local scope), `<project>/.mcp.json`
 *   (project scope).
 * - Codex: `[mcp_servers.<name>]` tables of `$CODEX_HOME/config.toml` (read line by line; no TOML parser is bundled).
 */

const MAX_FILE = 50 * 1024 * 1024;
const MAX_LISTED = 100;

export interface CliMcpHomes { home?: string; codexHome?: string }

const readSmall = (file: string): string | undefined => {
  try { if (!existsSync(file) || statSync(file).size > MAX_FILE) return undefined; return readFileSync(file, 'utf8'); } catch { return undefined; }
};
const tilde = (p: string, home?: string) => (home && normPath(p).startsWith(normPath(home)) ? `~${p.slice(home.length)}` : p);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function claudeServers(map: unknown, scope: CliMcpServer['scope'], where: string): CliMcpServer[] {
  if (!isObj(map)) return [];
  return Object.entries(map).slice(0, MAX_LISTED).map(([name, cfg]) => {
    const type = isObj(cfg) ? (typeof cfg['type'] === 'string' ? cfg['type'] : typeof cfg['command'] === 'string' ? 'stdio' : typeof cfg['url'] === 'string' ? 'http' : undefined) : undefined;
    return { source: 'claude' as const, scope, name: name.slice(0, 100), ...(type ? { transport: type.slice(0, 20) } : {}), where };
  });
}

export function discoverCliMcpServers(homes: CliMcpHomes, projectPath?: string): CliMcpServer[] {
  const out: CliMcpServer[] = [];
  if (homes.home) {
    const file = join(homes.home, '.claude.json');
    const text = readSmall(file);
    let j: unknown;
    try { j = text ? JSON.parse(text) : undefined; } catch { j = undefined; }
    if (isObj(j)) {
      const where = tilde(file, homes.home);
      out.push(...claudeServers(j['mcpServers'], 'user', where));
      if (projectPath && isObj(j['projects'])) {
        const key = Object.keys(j['projects']).find((k) => normPath(k) === normPath(projectPath));
        const proj = key ? (j['projects'] as Record<string, unknown>)[key] : undefined;
        if (isObj(proj)) out.push(...claudeServers(proj['mcpServers'], 'local', where));
      }
    }
  }
  if (projectPath) {
    const file = join(projectPath, '.mcp.json');
    const text = readSmall(file);
    let j: unknown;
    try { j = text ? JSON.parse(text) : undefined; } catch { j = undefined; }
    if (isObj(j)) out.push(...claudeServers(j['mcpServers'], 'project', file));
  }
  if (homes.codexHome) {
    const file = join(homes.codexHome, 'config.toml');
    const text = readSmall(file);
    if (text) {
      const where = tilde(file, homes.home);
      let current: CliMcpServer | undefined;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const head = /^\[\s*mcp_servers\.(?:"([^"]{1,100})"|'([^']{1,100})'|([A-Za-z0-9_-]{1,100}))\s*\]$/.exec(line);
        if (head) { current = { source: 'codex', scope: 'user', name: head[1] ?? head[2] ?? head[3]!, where }; out.push(current); continue; }
        if (line.startsWith('[')) { current = undefined; continue; }
        if (current && !current.transport) {
          if (/^command\s*=/.test(line)) current.transport = 'stdio';
          else if (/^url\s*=/.test(line)) current.transport = 'http';
        }
      }
    }
  }
  return out.slice(0, MAX_LISTED * 3);
}
