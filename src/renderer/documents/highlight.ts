/**
 * A small read-only syntax highlighter: comments, strings, numbers and keywords, by language family. No dependency: the viewer
 * only needs files to be easier to read, not a parser. Output is plain tokens rendered as text spans (never HTML).
 */
export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword';
export interface Token { kind: TokenKind; text: string }

/** Above this the file is shown plain: a regex pass over megabytes would freeze the window. */
export const HIGHLIGHT_MAX_CHARS = 300_000;

const words = (s: string) => new Set(s.split(' '));
const C_LIKE = 'break case catch class const continue default do else enum extends false finally for if import in instanceof new null return static super switch this throw true try void while';
const KEYWORDS: Record<string, Set<string>> = {
  js: words(`${C_LIKE} async await delete export from function let of typeof undefined var yield get set`),
  ts: words(`${C_LIKE} abstract as async await declare delete export from function implements interface keyof let namespace never of private protected public readonly satisfies type typeof undefined unknown var yield any boolean number string`),
  py: words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self'),
  rs: words('as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
  go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false'),
  java: words(`${C_LIKE} abstract boolean byte char double final float implements int interface long native package private protected public short synchronized throws transient volatile`),
  cs: words(`${C_LIKE} abstract as async await base bool byte char decimal double event explicit float foreach implicit int interface internal is lock long namespace object operator out override params private protected public readonly ref sealed short string struct using var virtual`),
  c: words('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while NULL true false'),
  sh: words('if then else elif fi for while do done case esac function in return local export echo exit'),
  ps1: words('if else elseif foreach for while do switch function param return begin process end try catch finally throw $true $false $null'),
  sql: words('select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit as and or not null is in primary key foreign references distinct union'),
  css: words('important media import supports keyframes'),
  yaml: words('true false null yes no on off'),
  json: words('true false null')
};
KEYWORDS['kt'] = KEYWORDS['java']!; KEYWORDS['scala'] = KEYWORDS['java']!; KEYWORDS['swift'] = KEYWORDS['java']!; KEYWORDS['cpp'] = KEYWORDS['c']!; KEYWORDS['php'] = KEYWORDS['js']!; KEYWORDS['dart'] = KEYWORDS['java']!; KEYWORDS['toml'] = KEYWORDS['yaml']!; KEYWORDS['bat'] = words('echo set if else goto call exit rem for in do not exist');

const HASH_COMMENTS = new Set(['py', 'sh', 'ps1', 'yaml', 'toml', 'rb', 'r', 'pl', 'ex', 'hcl']);
const DASH_COMMENTS = new Set(['sql', 'lua']);
const MARKUP = new Set(['html', 'xml']);

function pattern(lang: string): RegExp {
  const parts: string[] = [];
  if (MARKUP.has(lang)) parts.push('<!--[\\s\\S]*?(?:-->|$)');
  else {
    if (!HASH_COMMENTS.has(lang) && lang !== 'json' && lang !== 'bat') parts.push('\\/\\*[\\s\\S]*?(?:\\*\\/|$)');
    if (HASH_COMMENTS.has(lang)) parts.push('#[^\\n]*');
    else if (DASH_COMMENTS.has(lang)) parts.push('--[^\\n]*');
    else if (lang === 'bat') parts.push('(?:^|(?<=\\n))\\s*(?:rem\\b|::)[^\\n]*');
    else if (lang !== 'json' && lang !== 'css') parts.push('\\/\\/[^\\n]*');
  }
  const comments = parts.join('|');
  const strings = lang === 'py' ? '"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?'
    : '`(?:\\\\[\\s\\S]|[^`\\\\])*`?|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?';
  return new RegExp(`(${comments || '(?!)'})|(${strings})|(\\b(?:0x[0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)|([$A-Za-z_][\\w$]*)`, 'g');
}

export function tokenize(text: string, language?: string): Token[] {
  const lang = (language || '').toLowerCase();
  if (!lang || text.length > HIGHLIGHT_MAX_CHARS || lang === 'text') return [{ kind: 'plain', text }];
  const keywords = KEYWORDS[lang];
  const re = pattern(lang);
  const out: Token[] = [];
  let last = 0;
  const push = (kind: TokenKind, t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind) prev.text += t; else out.push({ kind, text: t });
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') { re.lastIndex++; continue; }
    push('plain', text.slice(last, m.index));
    if (m[1]) push('comment', m[0]);
    else if (m[2]) push('string', m[0]);
    else if (m[3]) push('number', m[0]);
    else push(keywords?.has(m[0]) || (lang === 'sql' && keywords?.has(m[0].toLowerCase())) ? 'keyword' : 'plain', m[0]);
    last = m.index + m[0].length;
  }
  push('plain', text.slice(last));
  return out;
}

/** Pretty JSON when it parses (and is not huge); otherwise the text as it is, with a note. */
export function formatJson(text: string): { text: string; valid: boolean } {
  if (text.length > 2_000_000) return { text, valid: true };
  try { return { text: JSON.stringify(JSON.parse(text), null, 2), valid: true }; } catch { return { text, valid: false }; }
}
