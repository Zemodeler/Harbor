import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { parseBlocks, splitFences, type Align, type Block } from '../components/Markdown';
import { resolveRelative } from './paths';
import { CodeView } from './CodeView';
import d from './Documents.module.css';

/**
 * Markdown documents in the viewer. Built from React elements only (the same block parser as chat messages): raw HTML in the
 * file is shown as text, never interpreted, so there is nothing to sanitise away and no script can run. Web links are real
 * links that open in the user's browser only when clicked (Harbor's window policy hands http(s) to the OS); links to other
 * files open them in the viewer; images are never fetched (local ones open in the viewer on click, remote ones stay text).
 */
type Open = (path: string) => void;

// Inline syntax, in priority order: code, image, link, autolink, bold, italic.
const INLINE = /(`[^`]+`|!\[[^\]]*\]\([^)\s]*(?:\s+"[^"]*")?\)|\[[^\]]+\]\([^)\s]*(?:\s+"[^"]*")?\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|\*\*[^*]+\*\*|\*[^*\s](?:[^*]*[^*\s])?\*|(?<![\w])_[^_\s](?:[^_]*[^_\s])?_(?![\w]))/g;
const LINK = /^(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)$/;

export function webUrl(raw: string): string | undefined {
  try { const u = new URL(raw); return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}

function inline(text: string, docPath: string, open: Open): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (i % 2 === 0) return part;
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = LINK.exec(part);
    if (link) {
      const [, bang, label, target] = link as unknown as [string, string, string, string];
      if (bang) {
        // An image is never loaded from the document: a local one opens in its own tab, a remote one stays a label.
        const local = webUrl(target) ? undefined : resolveRelative(docPath, target);
        return local ? <button key={i} type="button" className={d.pathLink} onClick={() => open(local)}>[image: {label || target}]</button> : <span key={i} className={d.muted}>[image: {label || target}]</span>;
      }
      const web = webUrl(target);
      if (web) return <a key={i} href={web} target="_blank" rel="noreferrer noopener" title={web}>{label}</a>;
      const local = resolveRelative(docPath, target);
      return local ? <button key={i} type="button" className={d.pathLink} title={`Open ${target}`} onClick={() => open(local)}>{label}</button> : <span key={i}>{label}</span>;
    }
    if (/^<?https?:\/\//.test(part)) {
      const raw = part.replace(/^<|>$/g, '');
      const web = webUrl(raw);
      return web ? <a key={i} href={web} target="_blank" rel="noreferrer noopener">{raw}</a> : raw;
    }
    return <em key={i}>{part.slice(1, -1)}</em>;
  });
}

function Table({ head, align, rows, docPath, open }: { head: string[]; align: Align[]; rows: string[][]; docPath: string; open: Open }) {
  return <div className={d.tableWrap} role="region" aria-label="Table, scrolls horizontally" tabIndex={0}>
    <table className={d.table}>
      <thead><tr>{head.map((h, i) => <th key={i} scope="col" data-align={align[i]}>{inline(h, docPath, open)}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} data-align={align[j]}>{inline(c, docPath, open)}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}

function render(b: Block, key: number, docPath: string, open: Open): ReactNode {
  const r = (x: Block, k: number) => render(x, k, docPath, open);
  switch (b.kind) {
    case 'h': { const H = (`h${Math.min(6, Math.max(1, b.level))}`) as 'h1'; return <H key={key}>{inline(b.text, docPath, open)}</H>; }
    case 'ul': return <ul key={key}>{b.items.map((t, k) => <li key={k}>{inline(t.text, docPath, open)}{t.children.map(r)}</li>)}</ul>;
    case 'ol': return <ol key={key} start={b.start}>{b.items.map((t, k) => <li key={k}>{inline(t.text, docPath, open)}{t.children.map(r)}</li>)}</ol>;
    case 'quote': return <blockquote key={key}>{b.blocks.map(r)}</blockquote>;
    case 'table': return <Table key={key} head={b.head} align={b.align} rows={b.rows} docPath={docPath} open={open}/>;
    default: return <p key={key}>{inline(b.text, docPath, open)}</p>;
  }
}

export const DocumentMarkdown = memo(function DocumentMarkdown({ text, docPath, open }: { text: string; docPath: string; open: Open }) {
  const content = useMemo(() => splitFences(text).map((part, i) => part.kind === 'code'
    ? <CodeView key={i} text={part.text} language={part.language} compact/>
    : <Fragment key={i}>{parseBlocks(part.text).map((b, k) => render(b, k, docPath, open))}</Fragment>), [text, docPath, open]);
  return <div className={d.markdown}>{content}</div>;
});
