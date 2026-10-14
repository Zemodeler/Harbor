import { useMemo, useState } from 'react';
import type { DocumentView, HarborApi } from '../../shared/api';
import type { DocumentsState, DocTab } from '../hooks/useDocuments';
import { CloseIcon } from '../components/Icons';
import { CSV_MAX_ROWS, guessDelimiter, parseCsv } from './csv';
import { formatJson } from './highlight';
import { CodeView } from './CodeView';
import { DocumentMarkdown } from './DocumentMarkdown';
import d from './Documents.module.css';

const ROOT_LABEL: Record<DocumentView['root'], string> = { project: 'Project', worktree: 'Helper worktree', attachments: 'Conversation attachment', skills: 'Skills library', picked: 'Chosen file' };
const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const tabName = (t: DocTab) => t.result?.ok ? t.result.document.name : t.title || t.request.path.split(/[\\/]/).pop() || 'File';

/**
 * The read-only document viewer beside the conversation (plan section 4b). Nothing here can change a file. HTML is shown in an
 * iframe with an empty sandbox (no scripts, forms, popups or same-origin) and its own `default-src 'none'` CSP from main; SVG
 * and images only as <img>; markdown as React elements. Actions that leave Harbor (default app, Explorer) go through main,
 * which checks the path again and refuses programs and scripts.
 */
export function DocumentViewer({ docs, api, projectId, agentTitle, close }: { docs: DocumentsState; api: HarborApi; projectId: string; agentTitle: (id?: string) => string | undefined; close: () => void }) {
  const tab = docs.active;
  return <section className={d.viewer} aria-label="Document viewer">
    <div className={d.tabs} role="tablist" aria-label="Open documents">
      {docs.tabs.map(t => <div key={t.key} className={d.tab} data-active={t.key === docs.activeKey || undefined}>
        <button role="tab" aria-selected={t.key === docs.activeKey} title={t.result?.ok ? t.result.document.path : t.request.path} onClick={() => docs.setActive(t.key)}>{tabName(t)}</button>
        <button className={d.tabClose} aria-label={`Close ${tabName(t)}`} onClick={() => docs.close(t.key)}><CloseIcon size={11} aria-hidden="true"/></button>
      </div>)}
      <button className={d.closeViewer} onClick={close} aria-label="Hide the document viewer">Hide</button>
    </div>
    {tab ? <TabBody key={tab.key} tab={tab} docs={docs} api={api} projectId={projectId} agentTitle={agentTitle}/> : <p className={d.muted}>No document open.</p>}
  </section>;
}

function TabBody({ tab, docs, api, projectId, agentTitle }: { tab: DocTab; docs: DocumentsState; api: HarborApi; projectId: string; agentTitle: (id?: string) => string | undefined }) {
  const [notice, setNotice] = useState('');
  const [source, setSource] = useState(false);
  if (tab.loading) return <p className={d.muted} role="status">Opening {tab.request.path}…</p>;
  if (tab.error) return <div className={d.card} role="alert"><p>{tab.error}</p>{tab.request.path ? <button onClick={() => docs.reload(tab.key)}>Try again</button> : null}</div>;
  const r = tab.result;
  if (!r) return null;
  if (!r.ok) return <div className={d.card} role="alert">
    <p><strong>Harbor did not open this file.</strong> {r.message}</p>
    {tab.request.path ? <p className={d.mono}>{tab.request.path}</p> : null}
    <div className={d.actions}>{r.reason === 'outside' && docs.supported ? <button onClick={() => void docs.pick()}>Open file…</button> : null}{tab.request.path ? <button onClick={() => docs.reload(tab.key)}>Try again</button> : null}</div>
  </div>;
  const doc = r.document;
  const act = async (action: 'openExternal' | 'reveal') => {
    setNotice('');
    if (!api.documentAction) { setNotice('This is available in the desktop app.'); return; }
    try { await api.documentAction(projectId, doc.path, action, tab.request.agentId ? { agentId: tab.request.agentId } : undefined); }
    catch (e) { setNotice(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'That did not work.'); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(doc.path); setNotice('Path copied.'); } catch { setNotice('Select the path to copy it.'); } };
  const where = doc.root === 'worktree' ? `${ROOT_LABEL.worktree}${agentTitle(doc.agentId) ? ` · ${agentTitle(doc.agentId)}` : ''}` : ROOT_LABEL[doc.root];
  const canToggle = doc.kind === 'markdown' || doc.kind === 'html';
  return <div className={d.body}>
    <div className={d.toolbar}>
      <div className={d.where}><strong title={doc.path}>{doc.relPath || doc.name}</strong><small>{where} · {size(doc.size)} · read-only</small></div>
      <div className={d.actions}>
        {canToggle ? <button aria-pressed={source} onClick={() => setSource(v => !v)}>{source ? 'Preview' : 'Source'}</button> : null}
        {doc.canOpenExternally ? <button onClick={() => void act('openExternal')}>Open in default app</button> : null}
        <button onClick={() => void act('reveal')}>Show in Explorer</button>
        <button onClick={() => void copy()}>Copy path</button>
      </div>
    </div>
    {tab.gone ? <p className={d.warning} role="status">This file changed and can no longer be shown: {tab.gone} The last version stays below.</p> : null}
    {notice ? <p className={d.notice} role="status">{notice}</p> : null}
    <div className={d.content}><Content doc={doc} source={source} open={path => docs.open(path, tab.request.agentId ? { agentId: tab.request.agentId } : {})} act={act}/></div>
  </div>;
}

function Content({ doc, source, open, act }: { doc: DocumentView; source: boolean; open: (path: string) => void; act: (a: 'openExternal' | 'reveal') => Promise<void> }) {
  const text = doc.text ?? '';
  switch (doc.kind) {
    case 'markdown': return source ? <CodeView text={text}/> : <DocumentMarkdown text={text} docPath={doc.path} open={open}/>;
    case 'text': return <CodeView text={text}/>;
    case 'code': return <CodeView text={text} language={doc.language}/>;
    case 'json': return <JsonView text={text}/>;
    case 'csv': return <CsvView text={text} name={doc.name}/>;
    case 'image': case 'svg': return doc.dataUrl ? <div className={d.image}><img src={doc.dataUrl} alt={doc.name}/></div> : null;
    case 'html': return source ? <CodeView text={text} language="html"/> : <>
      <p className={d.muted}>Preview without scripts, forms or network access; links in it do not open.</p>
      {/* sandbox="" = every restriction on: no scripts, no same-origin, no forms, no popups, no top navigation. */}
      <iframe className={d.frame} sandbox="" referrerPolicy="no-referrer" srcDoc={doc.html ?? ''} title={`Preview of ${doc.name}`}/>
    </>;
    default: return <div className={d.card}>
      <p>{doc.note || 'Harbor cannot preview this file.'}</p>
      <div className={d.actions}>{doc.canOpenExternally ? <button onClick={() => void act('openExternal')}>Open in default app</button> : null}<button onClick={() => void act('reveal')}>Show in Explorer</button></div>
    </div>;
  }
}

function JsonView({ text }: { text: string }) {
  const json = useMemo(() => formatJson(text), [text]);
  return <>{json.valid ? null : <p className={d.warning}>This is not valid JSON; it is shown as written.</p>}<CodeView text={json.text} language="json"/></>;
}

function CsvView({ text, name }: { text: string; name: string }) {
  const table = useMemo(() => parseCsv(text, guessDelimiter(text, name)), [text, name]);
  const [head, ...rows] = table.rows;
  if (!head) return <p className={d.muted}>This file is empty.</p>;
  const width = Math.max(head.length, ...rows.map(r => r.length));
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')];
  return <>
    {table.truncated ? <p className={d.warning}>Showing the first {CSV_MAX_ROWS} rows. Open the file in its default app to see everything.</p> : null}
    <div className={d.tableWrap} role="region" aria-label="Table, scrolls horizontally" tabIndex={0}>
      <table className={d.table}><thead><tr>{pad(head).map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{pad(r).map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
    </div>
  </>;
}
