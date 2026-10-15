/**
 * File references in chat text that can open in the document viewer. Conservative on purpose: a known file extension is
 * required, and bare text needs a folder separator too, so "e.g." or "state.api" never turn into links. Main checks every
 * path again (inside the project or a worktree), so a false positive can only produce a polite refusal.
 */
const EXT = 'md|markdown|mdx|txt|log|json|jsonc|csv|tsv|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs|go|java|kt|cs|c|h|cpp|hpp|swift|php|lua|sh|ps1|bat|cmd|sql|css|scss|less|html|htm|xml|yml|yaml|toml|ini|cfg|svg|png|jpe?g|gif|webp|pdf|docx|xlsx|pptx|vue|svelte|graphql|proto|lock|env\\.example';
const LINE = '(?::\\d+(?::\\d+)?)?';
/** A whole code span that names a file: `src/a.ts`, `README.md`, `C:\\x\\y.json:12`. */
const CODE_PATH = new RegExp(`^(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?(?:[\\w.@() -]+[\\\\/])*[\\w.@() -]*\\w\\.(?:${EXT})${LINE}$`, 'i');
/** A path inside prose: needs at least one separator, and is not part of a URL or a longer word. */
export const TEXT_PATH = new RegExp(`(?<![\\w/\\\\.:@-])((?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/])?(?:[\\w.@-]+[\\\\/])+[\\w@.-]*\\w\\.(?:${EXT})${LINE})(?![\\w/\\\\-])`, 'gi');

/** `src/a.ts:65:3` names a place in the file: the viewer opens the file itself. */
export const withoutLine = (path: string): string => path.replace(/:\d+(?::\d+)?$/, '');

export function isPathLike(code: string): boolean {
  const t = code.trim();
  return t.length > 2 && t.length <= 400 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && CODE_PATH.test(t);
}

/** Splits prose into text and path pieces (odd indices are paths). */
export function splitPaths(text: string): string[] {
  return text.split(TEXT_PATH);
}

/** A link target inside a document, resolved against that document's folder; undefined for web links, anchors and other schemes. */
export function resolveRelative(docPath: string, target: string): string | undefined {
  const t = target.trim().replace(/[?#].*$/, '');
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[A-Za-z]:[\\/]/.test(t)) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(t)) return t;
  if (t.startsWith('/') || t.startsWith('\\')) return undefined; // site-root or network paths mean nothing for a file on disk
  let decoded = t;
  try { decoded = decodeURIComponent(t); } catch { /* keep as written */ }
  const sep = docPath.includes('\\') ? '\\' : '/';
  const parts = docPath.split(/[\\/]/);
  parts.pop();
  for (const p of decoded.split(/[\\/]/)) {
    if (!p || p === '.') continue;
    if (p === '..') { if (parts.length > 1) parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join(sep);
}
