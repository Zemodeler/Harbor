/** A table shows at most this many rows; the rest stays in the file ("open in the default app" shows everything). */
export const CSV_MAX_ROWS = 2000;
export const CSV_MAX_COLUMNS = 200;

/** Comma, tab or semicolon: a .tsv is tab; otherwise whichever appears most in the first line outside quotes. */
export function guessDelimiter(text: string, name = ''): string {
  if (/\.tsv$/i.test(name)) return '\t';
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const outside = first.replace(/"[^"]*"/g, '');
  const count = (c: string) => outside.split(c).length - 1;
  const best = [',', '\t', ';'].map(c => [c, count(c)] as const).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ',';
}

/**
 * RFC 4180-style parsing: quoted fields may hold the delimiter, doubled quotes and line breaks; CRLF, LF and CR end rows; a
 * BOM is dropped. Stops after `maxRows` rows (`truncated`). Cells are plain strings: the table renders them as text only.
 */
export function parseCsv(text: string, delimiter = ',', maxRows = CSV_MAX_ROWS): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const endRow = () => { row.push(cell); cell = ''; if (row.length > CSV_MAX_COLUMNS) row = row.slice(0, CSV_MAX_COLUMNS); rows.push(row); row = []; };
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      if (rows.length >= maxRows) return { rows, truncated: i < src.length };
      continue;
    }
    cell += c; i++;
  }
  if (cell !== '' || row.length) endRow();
  return { rows, truncated: false };
}
