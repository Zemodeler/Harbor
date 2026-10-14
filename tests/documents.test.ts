import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentResult, DocumentView, HarborEvent } from '../src/shared/api';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { HTML_PREVIEW_CSP, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, canOpenExternally, decodeText, openDocumentAt, resolveDocumentPath, sanitizeHtml, type DocumentRoot } from '../src/main/documents';
import { validateInvoke } from '../src/main/ipcValidate';
import { LEAD_SYSTEM, SCREENSHOT_INSTRUCTIONS, parseProtocol, stripProtocol, systemFor } from '../src/main/prompts';
import { createHarborService } from '../src/main/service';
import { calmReported } from './fixtures/calmReadings';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-doc-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ } } });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const junction = (link: string, target: string) => spawnSync('cmd', ['/c', 'mklink', '/J', link, target]);
const doc = (r: DocumentResult): DocumentView => { if (!r.ok) throw new Error(`refused: ${r.reason} ${r.message}`); return r.document; };
const refused = (r: DocumentResult) => (r.ok ? 'ok' : r.reason);

function project() {
  const root = tmp();
  const roots: DocumentRoot[] = [{ kind: 'project', path: root }];
  const open = (p: string, opts?: { since?: number }, cwd = root, rs = roots) => openDocumentAt(p, cwd, rs, opts);
  return { root, roots, open };
}

// ---------------------------------------------------------------- the path guard

describe('document path guard', () => {
  it('opens files inside the project by relative or absolute path, and refuses traversal and outside paths', () => {
    const { root, open } = project();
    const outside = tmp();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'a.md'), '# A');
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    expect(doc(open('docs/a.md'))).toMatchObject({ kind: 'markdown', relPath: 'docs/a.md', root: 'project', text: '# A' });
    expect(doc(open(join(root, 'docs', 'a.md'))).relPath).toBe('docs/a.md');
    expect(doc(open('docs/../docs/a.md')).relPath).toBe('docs/a.md');
    for (const bad of ['../' + outside.split(/[\\/]/).pop() + '/secret.txt', join(outside, 'secret.txt'), 'docs/../../x.txt', 'C:\\Windows\\win.ini']) {
      const r = open(bad);
      expect(refused(r), bad).toBe('outside');
      // A refusal never repeats an outside path back.
      expect(r.ok ? '' : r.message).not.toContain(outside);
    }
  });

  it('compares Windows paths case-insensitively', () => {
    const { root, open } = project();
    writeFileSync(join(root, 'Notes.TXT'), 'hello');
    const upper = join(root.toUpperCase(), 'NOTES.txt');
    expect(doc(open(upper))).toMatchObject({ kind: 'text', text: 'hello' });
    expect(doc(open('notes.txt', undefined, root.toLowerCase(), [{ kind: 'project', path: root.toUpperCase() }])).text).toBe('hello');
  });

  it('refuses links: a junction leaving the project, and a symlinked file', () => {
    const { root, open } = project();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.md'), 'outside');
    junction(join(root, 'linked'), outside);
    if (existsSync(join(root, 'linked'))) expect(refused(open('linked/secret.md'))).toBe('link');
    let made = true;
    try { symlinkSync(join(outside, 'secret.md'), join(root, 'file-link.md'), 'file'); } catch { made = false; /* needs Developer Mode or admin on Windows */ }
    if (made) expect(refused(open('file-link.md'))).toBe('link');
    // A junction that stays inside the project is fine (worktrees link node_modules this way).
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'in.md'), 'inside');
    junction(join(root, 'alias'), join(root, 'real'));
    if (existsSync(join(root, 'alias'))) expect(doc(open('alias/in.md')).text).toBe('inside');
  });

  it('refuses URLs, network paths, control characters, folders, missing files and credential files', () => {
    const { root, open } = project();
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, '.env'), 'TOKEN=x');
    mkdirSync(join(root, 'keys'));
    writeFileSync(join(root, 'keys', 'id_rsa'), 'key');
    writeFileSync(join(root, 'server.pem'), 'pem');
    const cases: Array<[string, string]> = [['', 'invalid'], ['  ', 'invalid'], ['a\0b.md', 'invalid'], ['a\nb.md', 'invalid'], ['x'.repeat(2000), 'invalid'],
      ['https://example.com/a.md', 'invalid'], ['\\\\server\\share\\a.md', 'invalid'], ['//server/share/a.md', 'invalid'], ['file://server/share/a.md', 'invalid'],
      ['dir', 'notFile'], ['missing.md', 'notFound'], ['.env', 'credential'], ['keys/id_rsa', 'credential'], ['server.pem', 'credential']];
    for (const [p, reason] of cases) expect(refused(open(p)), p).toBe(reason);
    expect(refused(openDocumentAt(42 as unknown as string, root, [{ kind: 'project', path: root }]))).toBe('invalid');
  });

  it('accepts file:// URLs and a trailing :line or :line:col reference', () => {
    const { root, open } = project();
    writeFileSync(join(root, 'a.ts'), 'const a = 1;');
    expect(doc(open(pathToFileURL(join(root, 'a.ts')).href)).kind).toBe('code');
    expect(doc(open('a.ts:12')).relPath).toBe('a.ts');
    expect(doc(open('a.ts:12:4')).relPath).toBe('a.ts');
    expect(doc(open(`${join(root, 'a.ts')}:3`)).relPath).toBe('a.ts');
  });

  it('a picked file is allowed exactly, not its folder; worktree roots carry their agent', () => {
    const elsewhere = tmp();
    writeFileSync(join(elsewhere, 'picked.md'), 'mine');
    writeFileSync(join(elsewhere, 'sibling.md'), 'not mine');
    const wt = tmp();
    writeFileSync(join(wt, 'out.md'), 'helper output');
    const { root } = project();
    const roots: DocumentRoot[] = [{ kind: 'project', path: root }, { kind: 'worktree', path: wt, agentId: 'a1' }, { kind: 'picked', path: join(elsewhere, 'picked.md'), file: true }];
    expect(doc(openDocumentAt(join(elsewhere, 'picked.md'), root, roots))).toMatchObject({ root: 'picked', relPath: 'picked.md', text: 'mine' });
    expect(refused(openDocumentAt(join(elsewhere, 'sibling.md'), root, roots))).toBe('outside');
    expect(doc(openDocumentAt('out.md', wt, roots))).toMatchObject({ root: 'worktree', agentId: 'a1', text: 'helper output' });
  });

  it('resolveDocumentPath reports size and modification time', () => {
    const { root, roots } = project();
    writeFileSync(join(root, 'x.txt'), 'abc');
    const r = resolveDocumentPath('x.txt', root, roots);
    expect(r).toMatchObject({ ok: true, size: 3 });
  });
});

// ---------------------------------------------------------------- formats

describe('document formats', () => {
  it('markdown, plain text, code, JSON and CSV come back as text with their kind', () => {
    const { root, open } = project();
    const files: Array<[string, string, Partial<DocumentView>]> = [
      ['README.md', '# Title\n\nSome *text*.', { kind: 'markdown' }],
      ['notes.txt', 'plain', { kind: 'text' }],
      ['app.log', 'line 1', { kind: 'text' }],
      ['main.ts', 'export const x: number = 1;', { kind: 'code', language: 'ts' }],
      ['script.py', 'def f():\n  return 1', { kind: 'code', language: 'py' }],
      ['Dockerfile', 'FROM node:22', { kind: 'code', language: 'sh' }],
      ['data.json', '{"a":[1,2]}', { kind: 'json', language: 'json' }],
      ['broken.json', '{"a":', { kind: 'json' }],
      ['table.csv', 'a,b\n1,"two, three"', { kind: 'csv' }],
      ['table.tsv', 'a\tb\n1\t2', { kind: 'csv' }],
      ['LICENSE', 'MIT License', { kind: 'text' }]
    ];
    for (const [name, text, want] of files) {
      writeFileSync(join(root, name), text);
      expect(doc(open(name)), name).toMatchObject({ ...want, text, name, size: Buffer.byteLength(text) });
    }
  });

  it('decodes UTF-8 with a BOM and UTF-16 with a BOM; NUL bytes or invalid UTF-8 are binary', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé', 'utf16le')]))).toBe('hé');
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hi', 'utf16le').swap16()]))).toBe('hi');
    expect(decodeText(Buffer.from([0x68, 0x00, 0x69]))).toBeUndefined();
    expect(decodeText(Buffer.from([0xc3, 0x28]))).toBeUndefined();
    const { root, open } = project();
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]));
    writeFileSync(join(root, 'looks.txt'), Buffer.from([0x41, 0x00, 0x42]));
    expect(doc(open('blob.bin'))).toMatchObject({ kind: 'binary' });
    expect(doc(open('blob.bin')).text).toBeUndefined();
    expect(doc(open('looks.txt')).kind).toBe('binary');
  });

  it('images become data URLs only when their bytes match; SVG is an image, never inline markup', () => {
    const { root, open } = project();
    writeFileSync(join(root, 'ok.png'), PNG);
    writeFileSync(join(root, 'fake.png'), '<script>alert(1)</script>');
    writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>');
    writeFileSync(join(root, 'notsvg.svg'), 'hello');
    const png = doc(open('ok.png'));
    expect(png).toMatchObject({ kind: 'image', mime: 'image/png', canOpenExternally: true });
    expect(png.dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(doc(open('fake.png'))).toMatchObject({ kind: 'binary' });
    expect(doc(open('fake.png')).dataUrl).toBeUndefined();
    const svg = doc(open('icon.svg'));
    expect(svg.kind).toBe('svg');
    expect(svg.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(svg.text).toBeUndefined();
    expect(svg.html).toBeUndefined();
    expect(svg.canOpenExternally).toBe(false); // a browser would run its script
    expect(doc(open('notsvg.svg')).kind).toBe('binary');
  });

  it('PDF and Office files carry no content and point to the default app; a fake PDF is binary', () => {
    const { root, open } = project();
    writeFileSync(join(root, 'paper.pdf'), '%PDF-1.4\n%fake but starts right\n');
    writeFileSync(join(root, 'fake.pdf'), 'MZ this is a program');
    writeFileSync(join(root, 'report.docx'), Buffer.from([0x50, 0x4b, 3, 4]));
    writeFileSync(join(root, 'sheet.xlsx'), Buffer.from([0x50, 0x4b, 3, 4]));
    writeFileSync(join(root, 'deck.pptx'), Buffer.from([0x50, 0x4b, 3, 4]));
    const pdf = doc(open('paper.pdf'));
    expect(pdf).toMatchObject({ kind: 'pdf', canOpenExternally: true });
    expect(pdf.note).toMatch(/default app/);
    expect(pdf.text ?? pdf.dataUrl).toBeUndefined();
    expect(doc(open('fake.pdf')).kind).toBe('binary');
    for (const f of ['report.docx', 'sheet.xlsx', 'deck.pptx']) expect(doc(open(f)), f).toMatchObject({ kind: 'office', canOpenExternally: true });
  });

  it('HTML comes back sanitised for a sandboxed iframe, with its source as text', () => {
    const { root, open } = project();
    const page = '<html><head><script src="https://evil.example/x.js"></script></head><body onload="steal()"><h1>Hi</h1><img src="https://evil.example/t.png"></body></html>';
    writeFileSync(join(root, 'index.html'), page);
    const d = doc(open('index.html'));
    expect(d.kind).toBe('html');
    expect(d.text).toBe(page);
    expect(d.html!.startsWith(`<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`)).toBe(true);
    expect(d.html).toContain('<h1>Hi</h1>');
    expect(d.html).not.toMatch(/script|onload|evil\.example/i);
    expect(d.canOpenExternally).toBe(false);
  });

  it('size caps: large text is tooLarge, large binaries stay binary, images over 10 MB are tooLarge; nothing large is read whole', () => {
    const { root, open } = project();
    writeFileSync(join(root, 'big.log'), Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
    writeFileSync(join(root, 'big.unknown'), Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(MAX_TEXT_BYTES + 1, 0));
    writeFileSync(join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    writeFileSync(join(root, 'edge.txt'), Buffer.alloc(MAX_TEXT_BYTES, 0x62));
    expect(doc(open('big.log'))).toMatchObject({ kind: 'tooLarge', canOpenExternally: true });
    expect(doc(open('big.log')).text).toBeUndefined();
    expect(doc(open('big.unknown')).kind).toBe('tooLarge');
    expect(doc(open('big.bin')).kind).toBe('binary');
    expect(doc(open('big.png'))).toMatchObject({ kind: 'tooLarge' });
    expect(doc(open('big.png')).dataUrl).toBeUndefined();
    expect(doc(open('edge.txt')).text).toHaveLength(MAX_TEXT_BYTES);
  });

  it('since: an unchanged file sends no content; a changed one does', () => {
    const { root, open } = project();
    const f = join(root, 'live.md');
    writeFileSync(f, 'v1');
    const first = doc(open('live.md'));
    const again = doc(open('live.md', { since: first.modified }));
    expect(again).toMatchObject({ unchanged: true, kind: 'markdown' });
    expect(again.text).toBeUndefined();
    writeFileSync(f, 'v2');
    utimesSync(f, new Date(), new Date(first.modified + 5000));
    expect(doc(open('live.md', { since: first.modified })).text).toBe('v2');
  });

  it('only documents and images may be handed to their default app', () => {
    for (const ok of ['a.pdf', 'a.DOCX', 'b.xlsx', 'c.pptx', 'd.png', 'e.txt', 'f.md', 'g.csv', 'h.json']) expect(canOpenExternally(ok), ok).toBe(true);
    for (const bad of ['a.js', 'b.vbs', 'c.bat', 'd.cmd', 'e.ps1', 'f.exe', 'g.lnk', 'h.hta', 'i.html', 'j.svg', 'k.msi', 'l.scr', 'm.ts', 'noext', 'n.jse', 'o.wsf']) expect(canOpenExternally(bad), bad).toBe(false);
  });
});

// ---------------------------------------------------------------- HTML sanitiser against hostile input

describe('sanitizeHtml', () => {
  const hostile = [
    '<script>alert(1)</script>', '<SCRIPT SRC=//evil.example/x.js></SCRIPT>', '<script>never closed', '<scr<script>ipt>alert(1)</script>',
    '<img src=x onerror=alert(1)>', '<img src="javascript:alert(1)">', '<img srcset="https://evil.example/a.png 1x">', '<body onload=alert(1)>',
    '<a href="javascript:alert(1)">x</a>', '<a href="https://evil.example" target="_blank">x</a>', '<a href=" JaVaScRiPt:alert(1)">x</a>',
    '<iframe src="https://evil.example"></iframe>', '<object data="evil.swf"></object>', '<embed src="evil.swf">', '<applet code="x"></applet>',
    '<base href="https://evil.example/">', '<meta http-equiv="refresh" content="0;url=https://evil.example">', '<link rel="stylesheet" href="https://evil.example/s.css">',
    '<style>@import url(https://evil.example/s.css); body { background: url("https://evil.example/b.png") }</style>',
    '<div style="background-image:url(https://evil.example/b.png); width: expression(alert(1))">x</div>',
    '<form action="https://evil.example"><input name="q"><button formaction="https://evil.example">go</button></form>',
    '<svg><script>alert(1)</script><use href="https://evil.example/s.svg#a"/><animate attributeName="href" values="javascript:alert(1)"/><image href="https://evil.example/i.png"/></svg>',
    '<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>', '<!--[if IE]><script>alert(1)</script><![endif]-->', '<?xml-stylesheet href="https://evil.example/x.xsl"?>',
    '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video>', '<audio src="https://evil.example/a.mp3"></audio>',
    '<div title="a>b" onclick="alert(1)">quoted gt</div>', '<input autofocus onfocus=alert(1)>', '<details open ontoggle=alert(1)>', '<template><script>alert(1)</script></template>',
    '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">', '<a href="data:text/html,<script>alert(1)</script>">x</a>', '<p style="behavior:url(x.htc);-moz-binding:url(x.xml#y)">x</p>'
  ];
  it('removes scripts, handlers, remote and script URLs, frames, plugins, forms and media; puts the CSP first', () => {
    for (const h of hostile) {
      const out = sanitizeHtml(h);
      const body = out.slice(out.indexOf('>', out.indexOf('no-referrer')) + 1);
      expect(out.startsWith('<meta http-equiv="Content-Security-Policy"'), h).toBe(true);
      expect(body, h).not.toMatch(/<script|<iframe|<object|<embed|<applet|<base|<link|<meta|<form|<input|<button|<video|<audio|<use|<animate|<image\b/i);
      expect(body, h).not.toMatch(/\son[a-z]+\s*=/i);
      expect(body, h).not.toMatch(/javascript:/i);
      expect(body, h).not.toMatch(/(src|href|srcset|poster|action|formaction)\s*=\s*["']?\s*(https?:|\/\/|data:text)/i);
      expect(body, h).not.toMatch(/url\(\s*["']?https?:/i);
      expect(body, h).not.toMatch(/@import|expression\(|behavior:|-moz-binding/i);
    }
  });
  it('keeps ordinary markup, inline styles, anchors and inline raster images', () => {
    const out = sanitizeHtml('<h1 class="t" style="color: red">Title</h1><a href="#s2">jump</a><img alt="dot" src="data:image/png;base64,iVBORw0KGgo="><table><tr><td>1</td></tr></table><a href="https://example.com">site</a>');
    expect(out).toContain('<h1 class="t" style="color: red">Title</h1>');
    expect(out).toContain('<a href="#s2">jump</a>');
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(out).toContain('<td>1</td>');
    expect(out).toContain('<a title="https://example.com">site</a>'); // the address stays readable; the link does not navigate
  });
});

// ---------------------------------------------------------------- protocol line and prompts

describe('HARBOR_OPEN_DOCUMENT parsing and prompt text', () => {
  const line = (o: unknown) => `HARBOR_OPEN_DOCUMENT: ${typeof o === 'string' ? o : JSON.stringify(o)}`;
  it('parses path and optional title, at most three per turn, and strips the lines', () => {
    const t = ['Done.', line({ path: 'docs/a.md', title: 'Design notes' }), line({ path: 'b.csv' })].join('\n');
    const p = parseProtocol(t);
    expect(p.openDocument).toEqual([{ path: 'docs/a.md', title: 'Design notes' }, { path: 'b.csv' }]);
    expect(p.malformed).toEqual([]);
    expect(stripProtocol(t)).toBe('Done.');
    const many = parseProtocol(['a', 'b', 'c', 'd'].map((x) => line({ path: `${x}.md` })).join('\n'));
    expect(many.openDocument.map((d) => d.path)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(many.malformed).toHaveLength(1);
  });
  it('rejects garbage JSON, a missing or multi-line path, and cleans the title', () => {
    const bad = [line('{oops'), line('{"path": }'), line('[1,2]'), line({ title: 'no path' }), line({ path: '' }), line({ path: 'a\nb.md' }), line({ path: 42 }), line('{"path":"x.md"} trailing')];
    const p = parseProtocol(bad.join('\n'));
    expect(p.openDocument).toEqual([]);
    expect(p.malformed.length).toBe(bad.length);
    expect(parseProtocol(line({ path: 'x.md', title: 'a\u0007b\nc' + 'z'.repeat(300) })).openDocument[0]!.title).toMatch(/^a b cz+$/);
    expect(parseProtocol(line({ path: 'x.md', title: 'z'.repeat(300) })).openDocument[0]!.title).toHaveLength(120);
    // Fenced or quoted examples are documentation, not requests.
    expect(parseProtocol(['```', line({ path: 'x.md' }), '```', '> ' + line({ path: 'y.md' })].join('\n')).openDocument).toEqual([]);
  });
  it('lead and helper prompts explain the line; the lead prompt stays under its limit', () => {
    for (const text of [LEAD_SYSTEM, systemFor('implementer'), systemFor('reviewer'), SCREENSHOT_INSTRUCTIONS]) expect(text).toContain('HARBOR_OPEN_DOCUMENT: {"path":"<path>","title":"<optional>"}');
    // Raised from 8000/7950 when project notes (HARBOR_NOTE) joined screenshots and documents in one prompt (roadmap wave 1).
    expect(LEAD_SYSTEM.length).toBeLessThan(8400);
  });
});

// ---------------------------------------------------------------- IPC validation and the contract

describe('document IPC', () => {
  it('lists the new methods and validates their arguments', () => {
    for (const m of ['openDocument', 'pickDocument', 'documentAction'] as const) expect(INVOKE_METHODS).toContain(m);
    expect(INVOKE_METHODS as string[]).not.toContain('pathForFile');
    expect(() => validateInvoke('openDocument', ['p1', 'docs/a.md'])).not.toThrow();
    expect(() => validateInvoke('openDocument', ['p1', 'docs/a.md', { agentId: 'a1', since: 123 }])).not.toThrow();
    for (const args of [[], ['p1'], ['p1', ''], ['p1', 'a\0b'], ['p1', 'x'.repeat(2000)], ['', 'a.md'], ['p1', 'a.md', 'opts'], ['p1', 'a.md', { since: 'now' }], ['p1', 'a.md', { since: Infinity }], ['p1', 'a.md', { agentId: 7 }]]) {
      expect(() => validateInvoke('openDocument', args), JSON.stringify(args)).toThrow(/Invalid request/);
    }
    expect(() => validateInvoke('documentAction', ['p1', 'a.pdf', 'openExternal'])).not.toThrow();
    expect(() => validateInvoke('documentAction', ['p1', 'a.pdf', 'reveal', { agentId: 'a1' }])).not.toThrow();
    expect(() => validateInvoke('documentAction', ['p1', 'a.pdf', 'delete'])).toThrow(/openExternal or reveal/);
    expect(() => validateInvoke('pickDocument', [])).toThrow(/project id/);
    expect(() => validateInvoke('pickDocument', ['p1'])).not.toThrow();
  });
});

// ---------------------------------------------------------------- service and orchestrator

const say = (text: string): Chunk[] => [{ kind: 'text', text }];
const isConcierge = (o: RunOptions) => !!o.systemPrompt?.includes('front desk');
const isLead = (o: RunOptions) => !!o.systemPrompt?.includes('LEAD agent');

async function setup(o: { lead?: FakeScript; pick?: string; opened?: string[]; revealed?: string[] } = {}) {
  const repo = tmp();
  const g = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# Project'); g('add', '.'); g('commit', '-q', '-m', 'init');
  let leadCalls = 0;
  const script: FakeScript = (p, opts, i) => isConcierge(opts) ? say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }))
    : isLead(opts) ? (o.lead ?? (() => say('ok')))(p, opts, leadCalls++) : say('helper done\nHARBOR_RESULT: {"outcome":"done","summary":"ok","checks":[]}');
  const adapter = new FakeAdapter('claude', script);
  const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
  const dataDir = tmp();
  const svc = createHarborService({ dataDir, discover: async () => [cli], adapterFor: () => adapter, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 3, ledger: { reported: calmReported },
    pickDocument: async () => o.pick, openFolder: async (p) => { o.opened?.push(p); }, revealPath: (p) => { o.revealed?.push(p); } });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  const events: Array<Extract<HarborEvent, { type: 'document' }>> = [];
  svc.onEvent((e) => { if (e.type === 'document') events.push(e); });
  const system = () => svc.store.listMessages(conv!.id).filter((m) => m.role === 'system').map((m) => m.text);
  return { svc, project, conv: conv!, events, system, repo, dataDir };
}

describe('documents through the service', () => {
  it('openDocument reads project files and the skills library; refuses others and unknown agents', async () => {
    const t = await setup();
    expect(doc(await t.svc.openDocument(t.project.id, 'README.md'))).toMatchObject({ kind: 'markdown', text: '# Project', root: 'project' });
    mkdirSync(join(t.dataDir, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(t.dataDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nbody');
    expect(doc(await t.svc.openDocument(t.project.id, join(t.dataDir, 'skills', 'demo', 'SKILL.md')))).toMatchObject({ root: 'skills', relPath: 'demo/SKILL.md' });
    expect(refused(await t.svc.openDocument(t.project.id, join(t.dataDir, 'state.json')))).toBe('outside');
    await expect(t.svc.openDocument(t.project.id, 'README.md', { agentId: 'nobody' })).rejects.toThrow(/does not belong/);
    await expect(t.svc.openDocument('no-project', 'README.md')).rejects.toThrow(/Unknown project/);
  });

  it('pickDocument allows exactly the chosen file for the session; cancel returns null', async () => {
    const elsewhere = tmp();
    writeFileSync(join(elsewhere, 'chosen.csv'), 'a,b\n1,2');
    writeFileSync(join(elsewhere, 'other.csv'), 'x');
    const t = await setup({ pick: join(elsewhere, 'chosen.csv') });
    expect(refused(await t.svc.openDocument(t.project.id, join(elsewhere, 'chosen.csv')))).toBe('outside');
    expect(doc((await t.svc.pickDocument(t.project.id))!)).toMatchObject({ kind: 'csv', root: 'picked' });
    expect(doc(await t.svc.openDocument(t.project.id, join(elsewhere, 'chosen.csv')))).toMatchObject({ root: 'picked' });
    expect(refused(await t.svc.openDocument(t.project.id, join(elsewhere, 'other.csv')))).toBe('outside');
    const none = await setup();
    expect(await none.svc.pickDocument(none.project.id)).toBeNull();
  });

  it('documentAction: reveal any allowed file, open only documents and images in their default app, refuse outside paths', async () => {
    const opened: string[] = [], revealed: string[] = [];
    const t = await setup({ opened, revealed });
    writeFileSync(join(t.repo, 'paper.pdf'), '%PDF-1.4');
    writeFileSync(join(t.repo, 'run.js'), 'WScript.Echo(1)');
    await t.svc.documentAction(t.project.id, 'paper.pdf', 'openExternal');
    expect(opened).toEqual([join(t.repo, 'paper.pdf')].map((p) => doc(openDocumentAt(p, t.repo, [{ kind: 'project', path: t.repo }])).path));
    await expect(t.svc.documentAction(t.project.id, 'run.js', 'openExternal')).rejects.toThrow(/only documents and images/);
    expect(opened).toHaveLength(1);
    await t.svc.documentAction(t.project.id, 'run.js', 'reveal');
    expect(revealed).toHaveLength(1);
    await expect(t.svc.documentAction(t.project.id, 'C:\\Windows\\notepad.exe', 'reveal')).rejects.toThrow(/only opens files inside/);
  });

  it('a lead\'s HARBOR_OPEN_DOCUMENT opens checked files and refuses the rest with a note; the journal never names the path', async () => {
    const outside = tmp();
    writeFileSync(join(outside, 'secret-plan.md'), 'outside');
    const t = await setup({
      lead: (_p, _o, n) => n === 0 ? say(['Written.', `HARBOR_OPEN_DOCUMENT: ${JSON.stringify({ path: 'docs/plan.md', title: 'The plan' })}`, `HARBOR_OPEN_DOCUMENT: ${JSON.stringify({ path: join(outside, 'secret-plan.md') })}`, 'HARBOR_OPEN_DOCUMENT: {garbage'].join('\n')) : say('ok')
    });
    mkdirSync(join(t.repo, 'docs'));
    writeFileSync(join(t.repo, 'docs', 'plan.md'), '# Plan');
    await t.svc.send(t.conv.id, 'write the plan');
    await t.svc.whenIdle();
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ projectId: t.project.id, conversationId: t.conv.id, title: 'The plan' });
    expect(doc(await t.svc.openDocument(t.project.id, t.events[0]!.path)).text).toBe('# Plan');
    expect(t.system()).toContain('Opened The plan (`docs/plan.md`) from the lead in the document viewer.');
    expect(t.system().some((m) => m.startsWith('Harbor did not open a document from the lead'))).toBe(true);
    const messages = await t.svc.listMessages(t.conv.id);
    expect(messages.some((m) => m.role === 'assistant' && m.text.includes('HARBOR_OPEN_DOCUMENT'))).toBe(false);
    expect(t.system().some((m) => m.startsWith('Harbor ignored 1 protocol line(s): HARBOR_OPEN_DOCUMENT') && m.includes('{garbage'))).toBe(true);
    const journal = t.svc.orchestrator.journal.list(t.project.id).filter((e) => e.kind === 'protocol').map((e) => e.text).join('\n');
    expect(journal).toMatch(/document not opened: outside/);
    expect(journal).not.toContain('secret-plan');
  });
});
