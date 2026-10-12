import { Fragment, memo, useMemo, useState, type ReactNode } from 'react';
import s from '../Harbor.module.css';

// Text nodes only: no HTML and no links are ever produced, whatever the model writes. `_x_` needs word boundaries so
// snake_case stays plain.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s](?:[^*]*[^*\s])?\*|(?<![\w])_[^_\s](?:[^_]*[^_\s])?_(?![\w]))/g;
function inline(text: string) {
  return text.split(INLINE).map((part, i) =>
    i % 2 === 0 ? part
      : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code>
      : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <em key={i}>{part.slice(1, -1)}</em>);
}
function Code({ language, text }: { language: string; text: string }) {
  const [status, setStatus] = useState('Copy');
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus('Copied'); }
    catch { setStatus('Select code to copy'); }
  }
  return <div className={s.code}><div><span>{language || 'Code'}</span><button onClick={() => void copy()} aria-label="Copy code">{status}</button></div><pre tabIndex={0}><code>{text}</code></pre></div>;
}

// Splits one table row into cells. `\|` and pipes inside matched `code` spans do not split; `\|` loses its backslash.
// A backtick only opens a code span when a closing run of the same length follows, so a stray one cannot swallow later cells.
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  const body = line.trim();
  const framedEnd = body.endsWith('|');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') { cell += '|'; i++; }
    else if (c === '\\' && body[i + 1] === '`') { cell += '\\`'; i++; }
    else if (c === '`') {
      let n = 1;
      while (body[i + n] === '`') n++;
      const ticks = '`'.repeat(n);
      let close = -1;
      for (let j = body.indexOf(ticks, i + n); j >= 0; j = body.indexOf(ticks, j + 1)) {
        let run = 0;
        while (body[j + run] === '`') run++;
        if (run === n && body[j - 1] !== '\\') { close = j; break; }
        j += run - 1;
      }
      if (close < 0) { cell += ticks; i += n - 1; continue; }
      cell += body.slice(i, close + n).replace(/\\\|/g, '|');
      i = close + n - 1;
    }
    else if (c === '|') { cells.push(cell); cell = ''; }
    else cell += c;
  }
  cells.push(cell);
  // A leading or trailing pipe only frames the row (a trailing escaped pipe is cell content).
  if (body.startsWith('|')) cells.shift();
  if (framedEnd && !/(^|[^\\])(\\\\)*\\\|$/.test(body) && cells.length) cells.pop();
  return cells.map(c => c.trim());
}
type Align = 'left' | 'center' | 'right' | undefined;
function alignments(line: string): Align[] | null {
  // Only a piped separator counts: a bare `---` after prose is a rule, not a table.
  if (!line.includes('|')) return null;
  const cells = splitRow(line);
  if (!cells.length || !cells.every(c => /^:?-+:?$/.test(c))) return null;
  return cells.map(c => c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : undefined);
}

// Markers may be indented: an item indented two or more columns past its list's own marker is nested inside it.
const ORDERED = /^(\s*)(\d{1,9})[.)] (.*)$/;
const BULLET = /^(\s*)[-*] (.*)$/;
const HEADING = /^#{1,6} (.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const indentOf = (line: string) => line.length - line.trimStart().length;
type Item = { text: string; children: Block[] };
type Block = { kind: 'p' | 'h'; text: string } | { kind: 'ul'; items: Item[] } | { kind: 'ol'; start: number; items: Item[] }
  | { kind: 'quote'; blocks: Block[] } | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

// Fences are recognised per line (up to 3 spaces of indent, a run of 3+ backticks or tildes alone with an info string),
// so a ``` inside inline code or text never splits a message. An unclosed fence runs to the end, which is what a
// streaming reply looks like.
type Part = { kind: 'text'; text: string } | { kind: 'code'; language: string; text: string };
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
export function splitFences(text: string): Part[] {
  const parts: Part[] = [];
  let buffer: string[] = [], fence: { char: string; length: number; language: string } | undefined;
  const flushText = () => { if (buffer.length) parts.push({ kind: 'text', text: buffer.join('\n') }); buffer = []; };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!fence) {
      const open = FENCE_OPEN.exec(line);
      if (open) { flushText(); fence = { char: open[1][0], length: open[1].length, language: open[2] }; }
      else buffer.push(raw);
      continue;
    }
    const close = FENCE_CLOSE.exec(line);
    if (close && close[1][0] === fence.char && close[1].length >= fence.length) { parts.push({ kind: 'code', language: fence.language, text: buffer.join('\n') }); buffer = []; fence = undefined; }
    else buffer.push(raw);
  }
  if (fence) parts.push({ kind: 'code', language: fence.language, text: buffer.join('\n') }); else flushText();
  return parts;
}

export function parseBlocks(text: string): Block[] {
  // Windows output arrives as CRLF (or a lone CR); fenced code is split off before this and keeps its bytes.
  const lines = text.split(/\r\n?|\n/);
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) blocks.push({ kind: 'p', text: para.join('\n') }); para = []; };
  const nextNonBlank = (from: number) => { while (from < lines.length && !lines[from].trim()) from++; return from; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(HEADING);
    if (heading) { flush(); blocks.push({ kind: 'h', text: heading[1] }); continue; }
    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(QUOTE, '$1'));
      i--;
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner.join('\n')) });
      continue;
    }
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
    if ((ordered || bullet) && indentOf(line) < 4) {
      flush();
      const kind = ordered ? 'ol' : 'ul';
      const re = ordered ? ORDERED : BULLET;
      const base = indentOf(line);
      const raw: { text: string; sub: string[] }[] = [];
      const start = ordered ? Number(ordered[2]) : 0;
      for (; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m && indentOf(lines[i]) < base + 2) { raw.push({ text: m[m.length - 1], sub: [] }); continue; }
        const next = nextNonBlank(i);
        if (!lines[i].trim()) {
          // Items separated by blank lines still form one list, and an indented block after a blank belongs to the item.
          if (next < lines.length && raw.length && (indentOf(lines[next]) >= base + 2 || re.test(lines[next]) && indentOf(lines[next]) < base + 2)) { if (indentOf(lines[next]) >= base + 2) raw[raw.length - 1].sub.push(''); continue; }
          break;
        }
        // An indented line (more text, or a nested list) belongs to the previous item.
        if (indentOf(lines[i]) >= base + 2 && raw.length && !HEADING.test(lines[i].trim())) { raw[raw.length - 1].sub.push(lines[i]); continue; }
        break;
      }
      i--;
      const items: Item[] = raw.map(({ text, sub }) => {
        if (!sub.length) return { text, children: [] };
        const margin = Math.min(...sub.filter(l => l.trim()).map(indentOf));
        const children = parseBlocks(sub.map(l => l.slice(margin)).join('\n'));
        // Plain continuation lines stay part of the item's own text.
        const first = children[0];
        return first?.kind === 'p' ? { text: `${text}\n${first.text}`, children: children.slice(1) } : { text, children };
      });
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
    case 'ul': return <ul key={key} className={s.mdList}>{b.items.map((t, k) => <li key={k}>{inline(t.text)}{t.children.map(render)}</li>)}</ul>;
    case 'ol': return <ol key={key} className={s.mdList} start={b.start}>{b.items.map((t, k) => <li key={k}>{inline(t.text)}{t.children.map(render)}</li>)}</ol>;
    case 'quote': return <blockquote key={key} className={s.hqQuote}>{b.blocks.map(render)}</blockquote>;
    case 'table': return <Table key={key} head={b.head} align={b.align} rows={b.rows}/>;
    default: return <p key={key}>{inline(b.text)}</p>;
  }
}

/** Memoised on the text: a message is parsed once per change, not on every parent render (typing, scrolling). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Render text nodes only: raw HTML and executable/link schemes are never interpreted.
  const content = useMemo(() => splitFences(text).map((part, i) => part.kind === 'code'
    ? <Code key={i} language={part.language} text={part.text}/>
    : <Fragment key={i}>{parseBlocks(part.text).map(render)}</Fragment>), [text]);
  return <>{content}</>;
});
