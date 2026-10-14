import type { CliMcpServer, HarborApi, McpServer, McpServerDraft, McpTestResult } from '../../shared/api';

type McpMethods = Required<Pick<HarborApi, 'listMcpServers' | 'saveMcpServer' | 'removeMcpServer' | 'setMcpServerEnabled' | 'testMcpServer' | 'listCliMcpServers'>>;
interface Stored { draft: McpServerDraft; defaultEnabled: boolean; projects: Map<string, boolean>; updated: number }

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BARE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ABSOLUTE_RE = /^(?:[A-Za-z]:\\|\\\\|\/)/;

/**
 * Port of the main checks in src/main/mcp/registry.ts validateMcpServer (same messages for the cases the UI can produce), so the
 * demo refuses what Harbor refuses. Messages never repeat a value.
 */
function problemsOf(d: McpServerDraft): string[] {
  const p: string[] = [];
  if (!NAME_RE.test(d.name ?? '')) p.push('name must be 1-64 letters, digits, dashes or underscores.');
  if (d.transport === 'stdio') {
    const c = (d.command ?? '').trim();
    if (!c) p.push('command is required for a stdio server.');
    else if (!BARE_RE.test(c) && (!ABSOLUTE_RE.test(c) || /["%\r\n]/.test(c))) p.push('command must be a program name found on PATH (like npx) or an absolute path, without quotes, % or line breaks.');
    for (const k of Object.keys(d.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) p.push(`env: "${k}" is not a valid variable name.`);
      else if (['path', 'pathext', 'comspec', 'systemroot', 'windir', 'node_options'].includes(k.toLowerCase())) p.push(`env: ${k} cannot be set for an MCP server.`);
    }
  } else if (d.transport === 'http' || d.transport === 'sse') {
    let ok = false;
    try { const u = new URL((d.url ?? '').trim()); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { /* not a URL */ }
    if (!ok) p.push('url must be an http:// or https:// address of at most 2000 characters.');
    for (const k of Object.keys(d.headers ?? {})) if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) p.push(`headers: "${k}" is not a valid header name.`);
  } else p.push('transport must be stdio, http or sse.');
  return p;
}

/** Demo MCP registry: the same rules as Harbor for what the UI shows (validation, per-project choices, confirmation to test a command). Nothing is run. */
export function createMockMcp(pause: () => Promise<void>): McpMethods {
  const copy = <T,>(v: T): T => structuredClone(v);
  let servers: Stored[] = [
    { draft: { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], allowUnattended: true }, defaultEnabled: true, projects: new Map(), updated: Date.now() - 86400000 },
    { draft: { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer demo-token' } }, defaultEnabled: false, projects: new Map([['store', true]]), updated: Date.now() - 3600000 }
  ];
  const resolve = (s: Stored, projectId?: string): McpServer => ({ ...copy(s.draft), enabled: projectId ? s.projects.get(projectId) ?? s.defaultEnabled : s.defaultEnabled, defaultEnabled: s.defaultEnabled, updated: s.updated });
  const list = (projectId?: string) => servers.map(s => resolve(s, projectId));
  const find = (name: string) => servers.find(s => s.draft.name.toLowerCase() === name.trim().toLowerCase());
  const clean = (d: McpServerDraft): McpServerDraft => {
    const out: McpServerDraft = { name: d.name.trim(), transport: d.transport };
    if (d.transport === 'stdio') { out.command = d.command!.trim(); if (d.args?.length) out.args = [...d.args]; if (d.env && Object.keys(d.env).length) out.env = { ...d.env }; }
    else { out.url = d.url!.trim(); if (d.headers && Object.keys(d.headers).length) out.headers = { ...d.headers }; }
    if (d.allowUnattended) out.allowUnattended = true;
    return out;
  };
  return {
    async listMcpServers(projectId) { await pause(); return list(projectId); },
    async saveMcpServer(server, o) {
      await pause();
      const problems = problemsOf(server);
      if (problems.length) throw new Error(`This MCP server cannot be saved:\n- ${problems.join('\n- ')}`);
      const prev = o?.previousName !== undefined ? find(o.previousName) : undefined;
      if (o?.previousName !== undefined && !prev) throw new Error('There is no MCP server with that name to replace.');
      const clash = find(server.name);
      if (clash && clash !== prev) throw new Error(`An MCP server named ${server.name.trim()} already exists.`);
      const next: Stored = { draft: clean(server), defaultEnabled: prev?.defaultEnabled ?? false, projects: new Map(prev?.projects ?? []), updated: Date.now() };
      servers = prev ? servers.map(s => s === prev ? next : s) : [...servers, next];
      return list(o?.projectId);
    },
    async removeMcpServer(name, o) { await pause(); servers = servers.filter(s => s !== find(name)); return list(o?.projectId); },
    async setMcpServerEnabled(name, enabled, projectId) {
      await pause();
      const s = find(name);
      if (!s) throw new Error('That MCP server is no longer in the registry.');
      if (projectId === undefined) s.defaultEnabled = enabled === true;
      else if (enabled === null) s.projects.delete(projectId); else s.projects.set(projectId, enabled);
      return list(projectId);
    },
    async testMcpServer(server, o): Promise<McpTestResult> {
      await pause();
      const problems = problemsOf(server);
      if (problems.length) throw new Error(`This MCP server cannot be tested:\n- ${problems.join('\n- ')}`);
      if (server.transport === 'stdio' && o?.confirmCommand?.trim() !== server.command?.trim()) throw new Error(`Confirm that Harbor may run ${server.command?.trim()} first.`);
      return { ok: true, transport: server.transport, durationMs: 420, serverName: `${server.name} (demo)`, serverVersion: '1.0.0', protocolVersion: '2025-06-18', tools: ['search', 'fetch'], stderr: 'Demo only: nothing was run.' };
    },
    async listCliMcpServers(): Promise<CliMcpServer[]> {
      await pause();
      return [
        { source: 'claude', scope: 'user', name: 'playwright', transport: 'stdio', where: '~\\.claude.json' },
        { source: 'codex', scope: 'user', name: 'context7', transport: 'stdio', where: '~\\.codex\\config.toml' }
      ];
    }
  };
}
