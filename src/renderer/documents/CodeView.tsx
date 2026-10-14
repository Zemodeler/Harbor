import { memo, useMemo, useState } from 'react';
import { tokenize } from './highlight';
import d from './Documents.module.css';

/** Past this many lines the rest waits behind "Show all" (rendering 100k spans at once would stall the window). */
export const CODE_CLIP_LINES = 3000;

/** Read-only, highlighted code: tokens become text spans, never HTML. */
export const CodeView = memo(function CodeView({ text, language, compact }: { text: string; language?: string; compact?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => text.split('\n').length, [text]);
  const shown = useMemo(() => {
    if (all || lines <= CODE_CLIP_LINES) return text;
    let at = -1;
    for (let n = 0; n < CODE_CLIP_LINES; n++) at = text.indexOf('\n', at + 1);
    return text.slice(0, at);
  }, [text, all, lines]);
  const tokens = useMemo(() => tokenize(shown, language), [shown, language]);
  return <div className={compact ? `${d.code} ${d.codeCompact}` : d.code}>
    {compact && language ? <div className={d.codeLabel}>{language}</div> : null}
    <pre tabIndex={0} data-language={language || undefined}><code>{tokens.map((t, i) => t.kind === 'plain' ? t.text : <span key={i} className={d[`tok_${t.kind}`]}>{t.text}</span>)}</code></pre>
    {shown.length < text.length ? <button type="button" onClick={() => setAll(true)}>Show all {lines} lines</button> : null}
  </div>;
});
