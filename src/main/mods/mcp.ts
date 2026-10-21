import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServerDraft, ModMcpResult } from '../../shared/api';
import { modSlug } from './scan';

/**
 * The MCP servers a mod ships (`.mcp.json` or `mcpServers` in plugin.json), turned into Harbor registry drafts.
 * Only http and sse servers with a real URL are imported: a stdio server is a command that would run as you, so the user adds
 * that one themselves under MCP (where the command is shown and approved); a URL that is empty or holds a ${placeholder} cannot be
 * used as written. Nothing here enables a server and nothing contacts one.
 */
const MAX_SERVERS = 20;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readServers(modPath: string): Record<string, unknown> {
  const read = (p: string): Record<string, unknown> | undefined => {
    try { if (statSync(p).size > 256 * 1024) return undefined; const j = JSON.parse(readFileSync(p, 'utf8')) as unknown; return isObj(j) ? j : undefined; } catch { return undefined; }
  };
  const fromFile = read(join(modPath, '.mcp.json'))?.['mcpServers'];
  const fromManifest = read(join(modPath, '.claude-plugin', 'plugin.json'))?.['mcpServers'];
  const s = fromFile ?? fromManifest;
  return isObj(s) ? s : {};
}

/** The registry name a mod's server gets. */
export const modServerName = (modName: string, server: string): string => `${modSlug(modName)}-${server.replace(/[^A-Za-z0-9_-]+/g, '_')}`.slice(0, 64);

export function readModMcp(modPath: string, modName: string): { servers: McpServerDraft[]; skipped: ModMcpResult[] } {
  const servers: McpServerDraft[] = [];
  const skipped: ModMcpResult[] = [];
  for (const [key, raw] of Object.entries(readServers(modPath)).slice(0, MAX_SERVERS)) {
    const name = modServerName(modName, key);
    const skip = (why: string) => skipped.push({ name, status: 'skipped', why });
    if (!isObj(raw)) { skip('not a valid server entry.'); continue; }
    const url = typeof raw['url'] === 'string' ? raw['url'].trim() : '';
    if (typeof raw['command'] === 'string' && raw['command'].trim()) { skip('it is a stdio command; add it yourself under MCP so you see and approve the command.'); continue; }
    if (!url) { skip('it has no URL (the plugin expects you to fill one in).'); continue; }
    const headers = isObj(raw['headers']) ? Object.fromEntries(Object.entries(raw['headers']).filter((e): e is [string, string] => typeof e[1] === 'string')) : undefined;
    if (url.includes('${') || Object.values(headers ?? {}).some((v) => v.includes('${'))) { skip('its URL or headers hold a ${placeholder} that Harbor cannot fill.'); continue; }
    const transport = raw['type'] === 'sse' ? 'sse' : 'http';
    servers.push({ name, transport, url, ...(headers && Object.keys(headers).length ? { headers } : {}) });
  }
  return { servers, skipped };
}
