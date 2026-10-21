import { useCallback, useEffect, useState } from 'react';
import type { CliMcpServer, HarborApi, McpServer, McpServerDraft, McpTestResult, McpTransport } from '../../shared/api';
import { errorText } from '../hooks/useAgentActions';
import s from './Features.module.css';
import { InlineConfirm } from './ui/InlineConfirm';

// The safe choice (Cancel, first in the group) takes focus when a destructive confirm opens. Module-level so it runs on mount only.
const focusSafe = (el: HTMLElement | null) => { el?.querySelector('button')?.focus(); };

const TRANSPORT_LABEL: Record<McpTransport, string> = { stdio: 'Local command (stdio)', http: 'HTTP (streamable)', sse: 'HTTP + SSE (older servers)' };
const SOURCE_LABEL: Record<CliMcpServer['source'], string> = { claude: 'Claude Code', codex: 'Codex' };

export const canManageMcp = (api: HarborApi): boolean => !!(api.listMcpServers && api.saveMcpServer && api.setMcpServerEnabled);
const commandLine = (d: McpServerDraft) => [d.command ?? '', ...(d.args ?? []).map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' ').trim();

/**
 * Settings > MCP servers (plan section 5): Harbor's one registry of MCP servers, which Harbor writes out for each run in the chosen
 * CLI's own format. Env and header values are stored as plain text in Harbor's data folder (owner decision); the form says so.
 */
export function McpPanel({ api, projectId, projectName, ownMcp, onOwnMcp }: { api: HarborApi; projectId?: string; projectName?: string; ownMcp: boolean; onOwnMcp: (on: boolean) => Promise<void> }) {
  const [servers, setServers] = useState<McpServer[]>();
  const [found, setFound] = useState<CliMcpServer[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<McpServer | 'new'>();
  const [confirm, setConfirm] = useState<string>();
  const [testing, setTesting] = useState<string>();
  const [results, setResults] = useState<Record<string, McpTestResult | string | undefined>>({});

  const load = useCallback(async () => {
    try {
      setServers(await api.listMcpServers!(projectId));
      if (api.listCliMcpServers) setFound(await api.listCliMcpServers(projectId));
      setError('');
    } catch (e) { setError(errorText(e)); }
  }, [api, projectId]);
  useEffect(() => { void load(); }, [load]);

  async function act(work: () => Promise<unknown>) { setBusy(true); setError(''); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const toggle = (m: McpServer, on: boolean) => act(async () => setServers(await api.setMcpServerEnabled!(m.name, on, projectId)));
  const remove = (m: McpServer) => act(async () => { setServers(await api.removeMcpServer!(m.name, { projectId })); setConfirm(undefined); });
  const test = (m: McpServerDraft) => act(async () => {
    setResults(r => ({ ...r, [m.name]: undefined }));
    try { const r = await api.testMcpServer!(m, m.transport === 'stdio' ? { confirmCommand: m.command } : undefined); setResults(x => ({ ...x, [m.name]: r })); }
    catch (e) { setResults(x => ({ ...x, [m.name]: errorText(e) })); }
    setTesting(undefined);
  });
  const where = projectName ? `in ${projectName}` : 'by default';

  return <div className={s.fxSettingsGroup} role="group" aria-label="MCP servers">
    <p className={s.fxNote}>MCP servers give agents extra tools (docs, issue trackers, databases). Harbor keeps one list and hands the enabled servers to each lead and helper run in that CLI’s own format: Claude Code and Codex, and custom CLIs that say how. The concierge and read-only runs (planners, reviewers, plan mode) never get them.</p>
    <p className={s.fxNote}>Claude Code asks you about every MCP tool call in normal runs. Codex, custom CLIs and auto mode cannot ask, so they only get servers you allow without asking.</p>
    <p className={s.fxNote}>{projectName ? `Ticks apply to ${projectName}. Without a choice, a server follows its default (off unless you turn it on for every project).` : 'Open a project to choose servers for it. Ticks here set the default for every project.'}</p>
    <label className={s.fxNote}><input type="checkbox" checked={ownMcp} disabled={busy} onChange={e => void act(() => onOwnMcp(e.target.checked))}/> Also let Claude Code use its own MCP servers (its settings, the project’s .mcp.json, plugins) in Harbor runs. Never in auto mode, where their tools would run without asking.</label>
    <div className={s.fxRow}>
      <button disabled={busy} onClick={() => setEditor('new')}>Add MCP server</button>
      <button disabled={busy} onClick={() => void act(load)}>Refresh</button>
    </div>
    {editor ? <McpServerForm key={editor === 'new' ? 'new' : editor.name} api={api} editing={editor === 'new' ? undefined : editor} projectId={projectId} onClose={() => setEditor(undefined)} onSaved={list => { setServers(list); setEditor(undefined); }}/> : null}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
    {!servers ? <p className={s.fxNote} role="status">Loading MCP servers…</p> : !servers.length ? <p className={s.fxNote}>No MCP servers yet. Add one with its command or URL.</p> :
      <ul className={s.fxList} aria-label="MCP servers list" style={{ gap: 10 }}>{servers.map(m => {
        const r = results[m.name];
        return <li key={m.name} className={s.fxBlock} style={{ display: 'grid', gap: 4 }}>
          <div className={s.fxHead}><span>{m.name}</span><span className={s.fxBadge}>{TRANSPORT_LABEL[m.transport]}</span>{m.allowUnattended ? <span className={s.fxBadge} data-tone="warn">allowed without asking</span> : null}</div>
          <span className={`${s.fxMono} ${s.fxMuted}`}>{m.transport === 'stdio' ? commandLine(m) : m.url}</span>
          {m.env && Object.keys(m.env).length ? <span className={s.fxMuted}>Variables: {Object.keys(m.env).join(', ')}</span> : null}
          {m.headers && Object.keys(m.headers).length ? <span className={s.fxMuted}>Headers: {Object.keys(m.headers).join(', ')}</span> : null}
          <div className={s.fxRow}>
            <label><input type="checkbox" checked={m.enabled} disabled={busy} onChange={e => void toggle(m, e.target.checked)} aria-label={`Use ${m.name} ${where}`}/> Use {where}</label>
            <button disabled={busy} onClick={() => setEditor(m)}>Edit</button>
            {api.testMcpServer ? <button disabled={busy} onClick={() => (m.transport === 'stdio' ? setTesting(m.name) : void test(m))}>Test</button> : null}
            {api.removeMcpServer ? <button disabled={busy} onClick={() => setConfirm(m.name)}>Remove</button> : null}
          </div>
          {testing === m.name ? <div className={s.fxConfirm} role="group" aria-label={`Test ${m.name}`}>
            <p>Harbor will start this program on your computer, ask it for its tools and stop it (at most 20 seconds):</p>
            <p className={s.fxMono}>{commandLine(m)}</p>
            <div className={s.fxRow}><button className={s.fxPrimary} disabled={busy} onClick={() => void test(m)}>Run {m.command}</button><button disabled={busy} onClick={() => setTesting(undefined)}>Cancel</button></div>
          </div> : null}
          {typeof r === 'string' ? <p className={s.fxError} role="alert">{r}</p> : r ? <div className={s.fxDialog} role="status" aria-label={`Test result of ${m.name}`}>
            {r.ok ? <p className={s.fxNote}>Works: {r.serverName ?? 'the server'}{r.serverVersion ? ` ${r.serverVersion}` : ''} answered in {Math.round(r.durationMs)} ms with {r.tools?.length ?? 0} tool{r.tools?.length === 1 ? '' : 's'}{r.tools?.length ? `: ${r.tools.join(', ')}` : ''}.</p>
              : <p className={s.fxError}>Did not work: {r.error}</p>}
            {r.stderr ? <pre className={`${s.fxMono} ${s.fxScroll}`} style={{ whiteSpace: 'pre-wrap', margin: 0 }} aria-label={`Output of ${m.name}`}>{r.stderr}</pre> : null}
          </div> : null}
          {confirm === m.name ? <div ref={focusSafe}><InlineConfirm label={`Remove ${m.name}`} confirmLabel={`Remove ${m.name}`} cancelLabel="Keep it" pending={busy} onConfirm={() => void remove(m)} onCancel={() => setConfirm(undefined)}>Remove {m.name}? Projects stop using it, and its saved values are deleted.</InlineConfirm></div> : null}
        </li>;
      })}</ul>}
    {found?.length ? <div className={s.fxBlock} role="group" aria-label="Servers your CLIs already have">
      <div className={s.fxHead}>Already set up in your CLIs (read-only)</div>
      <p className={s.fxNote}>Codex always loads its own servers. Claude Code loads its own only when the box above is ticked. To control one from Harbor, add it here with the same command or URL.</p>
      <ul className={s.fxList}>{found.map(f => <li key={`${f.source}:${f.scope}:${f.name}`}><span>{f.name}</span><span className={s.fxBadge}>{SOURCE_LABEL[f.source]} · {f.scope}</span>{f.transport ? <span className={s.fxMuted}>{f.transport}</span> : null}<span className={`${s.fxMono} ${s.fxMuted}`}>{f.where}</span></li>)}</ul>
    </div> : null}
  </div>;
}

type Pair = { key: string; value: string };
const toPairs = (o?: Record<string, string>): Pair[] => Object.entries(o ?? {}).map(([key, value]) => ({ key, value }));
const fromPairs = (l: Pair[]): Record<string, string> | undefined => { const o: Record<string, string> = {}; for (const p of l) if (p.key.trim()) o[p.key.trim()] = p.value; return Object.keys(o).length ? o : undefined; };

function Pairs({ label, keyLabel, pairs, onChange, disabled }: { label: string; keyLabel: string; pairs: Pair[]; onChange: (p: Pair[]) => void; disabled: boolean }) {
  const [shown, setShown] = useState(false);
  const set = (i: number, p: Partial<Pair>) => onChange(pairs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return <fieldset className={s.fxField} style={{ border: 0, padding: 0, margin: 0 }}>
    <legend>{label}</legend>
    <p className={s.fxNote} role="note">Stored as plain text in Harbor’s data folder on this computer. Never put in exports, diagnostics or logs.</p>
    {pairs.map((p, i) => <div key={i} className={s.fxRow}>
      <input aria-label={`${keyLabel} ${i + 1}`} className={s.fxMono} placeholder={keyLabel} value={p.key} disabled={disabled} spellCheck={false} onChange={e => set(i, { key: e.target.value })}/>
      <input aria-label={`Value ${i + 1}`} className={s.fxMono} type={shown ? 'text' : 'password'} placeholder="value" value={p.value} disabled={disabled} spellCheck={false} autoComplete="off" onChange={e => set(i, { value: e.target.value })}/>
      <button disabled={disabled} onClick={() => onChange(pairs.filter((_, j) => j !== i))} aria-label={`Remove ${keyLabel.toLowerCase()} ${i + 1}`}>Remove</button>
    </div>)}
    <div className={s.fxRow}>
      <button disabled={disabled} onClick={() => onChange([...pairs, { key: '', value: '' }])}>Add {keyLabel.toLowerCase()}</button>
      {pairs.length ? <label><input type="checkbox" checked={shown} onChange={e => setShown(e.target.checked)}/> Show values</label> : null}
    </div>
  </fieldset>;
}

export function McpServerForm({ api, editing, projectId, onClose, onSaved }: { api: HarborApi; editing?: McpServer; projectId?: string; onClose: () => void; onSaved: (list: McpServer[]) => void }) {
  const [name, setName] = useState(editing?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(editing?.transport ?? 'stdio');
  const [command, setCommand] = useState(editing?.command ?? '');
  const [args, setArgs] = useState((editing?.args ?? []).join('\n'));
  const [env, setEnv] = useState<Pair[]>(toPairs(editing?.env));
  const [url, setUrl] = useState(editing?.url ?? '');
  const [headers, setHeaders] = useState<Pair[]>(toPairs(editing?.headers));
  const [unattended, setUnattended] = useState(editing?.allowUnattended === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const draft = (): McpServerDraft => transport === 'stdio'
    ? { name: name.trim(), transport, command: command.trim(), ...(args.trim() ? { args: args.split(/\r?\n/).filter(a => a.length) } : {}), ...(fromPairs(env) ? { env: fromPairs(env) } : {}), ...(unattended ? { allowUnattended: true } : {}) }
    : { name: name.trim(), transport, url: url.trim(), ...(fromPairs(headers) ? { headers: fromPairs(headers) } : {}), ...(unattended ? { allowUnattended: true } : {}) };
  async function save() {
    setBusy(true); setError('');
    try { onSaved(await api.saveMcpServer!(draft(), { ...(editing ? { previousName: editing.name } : {}), ...(projectId ? { projectId } : {}) })); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return <div className={s.fxSettingsGroup} role="group" aria-label={editing ? `Edit ${editing.name}` : 'Add an MCP server'}>
    <h3>{editing ? `Edit ${editing.name}` : 'Add an MCP server'}</h3>
    <div className={s.fxField}><label htmlFor="mcp-name">Name</label><input id="mcp-name" className={s.fxMono} value={name} disabled={busy} spellCheck={false} placeholder="docs" onChange={e => setName(e.target.value)}/></div>
    <div className={s.fxChoices} role="radiogroup" aria-label="Kind">
      {(['stdio', 'http', 'sse'] as const).map(t => <label key={t}><input type="radio" name="mcp-transport" checked={transport === t} disabled={busy} onChange={() => setTransport(t)}/> {TRANSPORT_LABEL[t]}</label>)}
    </div>
    {transport === 'stdio' ? <>
      <div className={s.fxField}><label htmlFor="mcp-command">Command</label><input id="mcp-command" className={s.fxMono} value={command} disabled={busy} spellCheck={false} placeholder="npx  or  C:\tools\server.exe" onChange={e => setCommand(e.target.value)}/></div>
      <div className={s.fxField}><label htmlFor="mcp-args">Arguments (one per line)</label><textarea id="mcp-args" className={s.fxMono} rows={3} value={args} disabled={busy} spellCheck={false} placeholder={'-y\n@scope/server'} onChange={e => setArgs(e.target.value)}/></div>
      <Pairs label="Environment variables" keyLabel="Variable" pairs={env} onChange={setEnv} disabled={busy}/>
    </> : <>
      <div className={s.fxField}><label htmlFor="mcp-url">URL</label><input id="mcp-url" className={s.fxMono} value={url} disabled={busy} spellCheck={false} placeholder="https://example.com/mcp" onChange={e => setUrl(e.target.value)}/></div>
      <Pairs label="Headers" keyLabel="Header" pairs={headers} onChange={setHeaders} disabled={busy}/>
      {transport === 'sse' ? <p className={s.fxNote}>Codex supports only local commands and streamable HTTP, so it does not get SSE servers.</p> : null}
    </>}
    <label className={s.fxNote}><input type="checkbox" checked={unattended} disabled={busy} onChange={e => setUnattended(e.target.checked)}/> Allow its tools without asking. Needed for Codex, custom CLIs and auto mode; Claude Code then runs them unasked too. Only for servers you trust with everything their tools can do.</label>
    <div className={s.fxRow}>
      <button className={s.fxPrimary} disabled={busy || !name.trim()} onClick={() => void save()}>{editing ? 'Save changes' : 'Add server'}</button>
      <button disabled={busy} onClick={onClose}>Cancel</button>
    </div>
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}
