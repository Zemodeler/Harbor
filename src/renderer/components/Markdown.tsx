import { Fragment, useState, type ReactNode } from 'react';
import s from '../Harbor.module.css';

function inline(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}
function Code({ language, text }: { language: string; text: string }) {
  const [status, setStatus] = useState('Copy');
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus('Copied'); }
    catch { setStatus('Select code to copy'); }
  }
  return <div className={s.code}><div><span>{language || 'Code'}</span><button onClick={() => void copy()} aria-label="Copy code">{status}</button></div><pre tabIndex={0}><code>{text}</code></pre></div>;
}

// Splits one table row into cells. `\|` and pipes inside `code` spans do not split; `\|` loses its backslash.
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let code = false;
  const body = line.trim();
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') { cell += '|'; i++; }
    else if (c === '`') { code = !code; cell += c; }
    else if (c === '|' && !code) { cells.push(cell); cell = ''; }
    else cell += c;
  }
  cells.push(cell);
  // A leading or trailing pipe only frames the row.
  if (body.startsWith('|')) cells.shift();
  if (body.endsWith('|') && !body.endsWith('\\|') && cells.length) cells.pop();
  return cells.map(c => c.trim());
}
type Align = 'left' | 'center' | 'right' | undefined;
function alignments(line: string): Align[] | null {
  if (!line.includes('|') && !/^\s*:?-{3,}:?\s*$/.test(line)) return null;
  const cells = splitRow(line);
  if (!cells.length || !cells.every(c => /^:?-+:?$/.test(c))) return null;
  return cells.map(c => c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : undefined);
}

const ORDERED = /^\s{0,3}(\d{1,9})[.)] (.*)$/;
const BULLET = /^\s{0,3}[-*] (.*)$/;
const HEADING = /^#{1,6} (.*)$/;
type Block = { kind: 'p' | 'h'; text: string } | { kind: 'ul'; items: string[] } | { kind: 'ol'; start: number; items: string[] }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

export function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) blocks.push({ kind: 'p', text: para.join('\n') }); para = []; };
  const nextNonBlank = (from: number) => { while (from < lines.length && !lines[from].trim()) from++; return from; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(HEADING);
    if (heading) { flush(); blocks.push({ kind: 'h', text: heading[1] }); continue; }
    // A table needs a header row directly followed by a separator row; anything less stays prose while it streams in.
    const align = line.includes('|') && i + 1 < lines.length ? alignments(lines[i + 1]) : null;
    if (align && !alignments(line)) {
      const head = splitRow(line);
      if (head.length === align.length) {
        flush();
        const rows: string[][] = [];
        i += 2;
        for (; i < lines.length && lines[i].includes('|') && lines[i].trim() !== '|'; i++) {
          const row = splitRow(lines[i]).slice(0, head.length);
          while (row.length < head.length) row.push('');
          rows.push(row);
        }
        i--;
        blocks.push({ kind: 'table', head, align, rows });
        continue;
      }
    }
    const ordered = line.match(ORDERED);
    const bullet = ordered ? null : line.match(BULLET);
    if (ordered || bullet) {
      flush();
      const kind = ordered ? 'ol' : 'ul';
      const re = ordered ? ORDERED : BULLET;
      const items: string[] = [];
      const start = ordered ? Number(ordered[1]) : 0;
      for (; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) { items.push(m[m.length - 1]); continue; }
        const next = nextNonBlank(i);
        // Items separated by blank lines still form one list.
        if (!lines[i].trim() && next < lines.length && re.test(lines[next])) continue;
        // An indented line continues the previous item.
        if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length && !HEADING.test(lines[i].trim())) { items[items.length - 1] += '\n' + lines[i].trim(); continue; }
        break;
      }
      i--;
      blocks.push(kind === 'ol' ? { kind, start, items } : { kind, items });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

function Table({ head, align, rows }: { head: string[]; align: Align[]; rows: string[][] }) {
  return <div className={s.mdTableWrap} role="region" aria-label="Table, scrolls horizontally" tabIndex={0}>
    <table className={s.mdTable}>
      <thead><tr>{head.map((h, i) => <th key={i} scope="col" data-align={align[i]}>{inline(h)}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} data-align={align[j]}>{inline(c)}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}
function render(b: Block, key: number): ReactNode {
  switch (b.kind) {
    case 'h': return <h3 key={key}>{inline(b.text)}</h3>;
    case 'ul': return <ul key={key} className={s.mdList}>{b.items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ul>;
    case 'ol': return <ol key={key} className={s.mdList} start={b.start}>{b.items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ol>;
    case 'table': return <Table key={key} head={b.head} align={b.align} rows={b.rows}/>;
    default: return <p key={key}>{inline(b.text)}</p>;
  }
}

export function Markdown({ text }: { text: string }) {
  // Render text nodes only: raw HTML and executable/link schemes are never interpreted.
  return <>{text.split(/```/g).map((block, i) => {
    if (i % 2) {
      const newline = block.indexOf('\n');
      return <Code key={i} language={newline >= 0 ? block.slice(0, newline) : ''} text={newline >= 0 ? block.slice(newline + 1).replace(/\n$/, '') : block}/>;
    }
    return <Fragment key={i}>{parseBlocks(block).map(render)}</Fragment>;
  })}</>;
}
