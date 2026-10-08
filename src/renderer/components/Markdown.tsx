import { Fragment, useState } from 'react';
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
export function Markdown({ text }: { text: string }) {
  // Render text nodes only: raw HTML and executable/link schemes are never interpreted.
  return <>{text.split(/```/g).map((block, i) => {
    if (i % 2) {
      const newline = block.indexOf('\n');
      return <Code key={i} language={newline >= 0 ? block.slice(0, newline) : ''} text={newline >= 0 ? block.slice(newline + 1).replace(/\n$/, '') : block}/>;
    }
    return <Fragment key={i}>{block.replace(/^(#{1,6} .+)$/gm, '\n\n$1\n\n').split(/\n\n+/).filter(p => p.trim()).map((paragraph, j) => {
      paragraph = paragraph.trim();
      const heading = paragraph.match(/^(#{1,6}) (.*)$/);
      if (heading) return <h3 key={j}>{inline(heading[2])}</h3>;
      if (/^[-*] /m.test(paragraph)) return <ul key={j}>{paragraph.split('\n').map((line, k) => <li key={k}>{inline(line.replace(/^[-*] /, ''))}</li>)}</ul>;
      return <p key={j}>{inline(paragraph)}</p>;
    })}</Fragment>;
  })}</>;
}
