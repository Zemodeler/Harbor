import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { Markdown } from '../components/Markdown';
import { guessDelimiter, parseCsv } from '../documents/csv';
import { DocumentLinks } from '../documents/DocumentLinks';
import { DocumentMarkdown } from '../documents/DocumentMarkdown';
import { DocumentViewer } from '../documents/DocumentViewer';
import { formatJson, HIGHLIGHT_MAX_CHARS, tokenize } from '../documents/highlight';
import { isPathLike, resolveRelative, splitPaths } from '../documents/paths';
import { useDocuments } from '../hooks/useDocuments';
import { createMockApi } from '../mock/mockApi';
import type { DocumentResult, HarborEvent } from '../../shared/api';

beforeEach(() => localStorage.clear());

describe('CSV parsing', () => {
  it('handles quotes, doubled quotes, delimiters and line breaks inside quotes, CRLF and a BOM', () => {
    expect(parseCsv('\ufeffa,b\r\n1,"x, y"\r\n2,"say ""hi"""\n3,"two\nlines"').rows).toEqual([['a', 'b'], ['1', 'x, y'], ['2', 'say "hi"'], ['3', 'two\nlines']]);
    expect(parseCsv('a;b\n1;2', ';').rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('').rows).toEqual([]);
    expect(parseCsv('a,b\n').rows).toEqual([['a', 'b']]);
  });
  it('guesses the delimiter and stops after the row cap', () => {
    expect(guessDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(guessDelimiter('a;b;c')).toBe(';');
    expect(guessDelimiter('"x;y",b')).toBe(',');
    expect(guessDelimiter('a,b', 'data.tsv')).toBe('\t');
    const big = parseCsv(Array.from({ length: 50 }, (_, i) => `${i},v`).join('\n'), ',', 10);
    expect(big.rows).toHaveLength(10);
    expect(big.truncated).toBe(true);
  });
});

describe('syntax highlighting', () => {
  it('marks keywords, strings, comments and numbers as text tokens', () => {
    const t = tokenize('const a = "x"; // note\nreturn 42;', 'ts');
    const kind = (text: string) => t.find(x => x.text.includes(text))?.kind;
    expect(kind('const')).toBe('keyword');
    expect(kind('"x"')).toBe('string');
    expect(kind('// note')).toBe('comment');
    expect(kind('42')).toBe('number');
    expect(t.map(x => x.text).join('')).toBe('const a = "x"; // note\nreturn 42;');
    expect(tokenize('# hi\nprint("x")', 'py')[0]).toEqual({ kind: 'comment', text: '# hi' });
    expect(tokenize('<!-- c --><p>', 'html')[0]).toEqual({ kind: 'comment', text: '<!-- c -->' });
  });
  it('stays plain for unknown languages and huge files', () => {
    expect(tokenize('const x', undefined)).toEqual([{ kind: 'plain', text: 'const x' }]);
    expect(tokenize('a'.repeat(HIGHLIGHT_MAX_CHARS + 1), 'ts')).toHaveLength(1);
  });
  it('pretty-prints valid JSON and keeps invalid JSON as written', () => {
    expect(formatJson('{"a":[1]}')).toEqual({ text: '{\n  "a": [\n    1\n  ]\n}', valid: true });
    expect(formatJson('{"a":')).toEqual({ text: '{"a":', valid: false });
  });
});

describe('file paths in text', () => {
  it('recognises file names in code spans and paths with a folder in prose, not URLs or dotted words', () => {
    for (const p of ['src/main/index.ts', 'README.md', 'C:\\Projects\\a\\notes.txt', './docs/plan.md', 'src/a.ts:42', 'data/orders.csv']) expect(isPathLike(p), p).toBe(true);
    for (const p of ['state.api', 'e.g.', 'npm test', 'https://example.com/a.md', 'v1.2', 'foo']) expect(isPathLike(p), p).toBe(false);
    expect(splitPaths('Edited src/main/index.ts and docs/plan.md:3, see https://x.com/a/b.md or e.g. this.')).toEqual(['Edited ', 'src/main/index.ts', ' and ', 'docs/plan.md:3', ', see https://x.com/a/b.md or e.g. this.']);
  });
  it('resolves links relative to the document; web links, anchors and site-root paths are not files', () => {
    expect(resolveRelative('C:\\P\\docs\\a.md', 'b.md')).toBe('C:\\P\\docs\\b.md');
    expect(resolveRelative('C:\\P\\docs\\a.md', '../src/x.ts#L3')).toBe('C:\\P\\src\\x.ts');
    expect(resolveRelative('C:\\P\\docs\\a.md', 'my%20file.md')).toBe('C:\\P\\docs\\my file.md');
    for (const t of ['https://example.com', 'mailto:a@b.c', 'javascript:alert(1)', '#top', '/abs.md', '']) expect(resolveRelative('C:\\P\\docs\\a.md', t), t).toBeUndefined();
  });
});

describe('document markdown is inert except for clicks', () => {
  it('renders headings by level, never interprets HTML, never loads images, and only makes http(s) links', async () => {
    const open = vi.fn();
    const hostile = '# Title\n\n### Sub\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [data](data:text/html,x) ![pixel](https://evil.example/p.png) ![local](img/shot.png)\n\n[site](https://example.com/a) and <https://example.com/b> and [plan](plan.md)';
    const { container } = render(<DocumentMarkdown text={hostile} docPath={'C:\\P\\docs\\a.md'} open={open}/>);
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Sub' })).toBeInTheDocument();
    expect(container.querySelector('script, img, iframe, object, embed')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    const links = [...container.querySelectorAll('a')];
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://example.com/a', 'https://example.com/b']);
    for (const a of links) { expect(a).toHaveAttribute('target', '_blank'); expect(a.getAttribute('rel')).toMatch(/noreferrer/); }
    expect(container.innerHTML).not.toMatch(/javascript:|data:text/);
    await userEvent.click(screen.getByRole('button', { name: 'plan' }));
    expect(open).toHaveBeenCalledWith('C:\\P\\docs\\plan.md');
    await userEvent.click(screen.getByRole('button', { name: '[image: local]' }));
    expect(open).toHaveBeenLastCalledWith('C:\\P\\docs\\img\\shot.png');
    expect(screen.getByText('[image: pixel]').tagName).toBe('SPAN');
  });

  it('chat messages turn file paths into viewer buttons only when a viewer is provided, with the message agent for relative paths', async () => {
    const open = vi.fn();
    const text = 'Changed `src/account.tsx` and docs/plan.md; `state.api` is code. See https://example.com/x.md';
    const { container, unmount } = render(<Markdown text={text}/>);
    expect(container.querySelector('button')).toBeNull();
    unmount();
    render(<DocumentLinks.Provider value={{ open }}><Markdown text={text} agentId="helper-1"/></DocumentLinks.Provider>);
    await userEvent.click(screen.getByRole('button', { name: 'src/account.tsx' }));
    expect(open).toHaveBeenCalledWith('src/account.tsx', { agentId: 'helper-1' });
    await userEvent.click(screen.getByRole('button', { name: 'docs/plan.md' }));
    expect(open).toHaveBeenLastCalledWith('docs/plan.md', { agentId: 'helper-1' });
    expect(screen.queryByRole('button', { name: /state\.api|example\.com/ })).toBeNull();
    expect(document.querySelector('a')).toBeNull();
  });
});

function Viewer({ api }: { api: ReturnType<typeof createMockApi> }) {
  const docs = useDocuments(api, 'store', undefined, []);
  (window as unknown as { docs: typeof docs }).docs = docs;
  return docs.tabs.length ? <DocumentViewer docs={docs} api={api} projectId="store" agentTitle={() => undefined} close={docs.hide}/> : <p>none</p>;
}
const docsNow = () => (window as unknown as { docs: ReturnType<typeof useDocuments> }).docs;

describe('document viewer', () => {
  it('shows each format safely: markdown, code, JSON, CSV, images, SVG as an image, HTML in an empty sandbox', async () => {
    const api = createMockApi({ delay: 0 });
    render(<Viewer api={api}/>);
    act(() => docsNow().open('README.md'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Storefront' })).toBeInTheDocument();
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
    expect(screen.getByText('<script>alert("shown as text")</script>')).toBeInTheDocument();

    act(() => docsNow().open('data/orders.csv'));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['id', 'customer', 'total']);
    expect(within(table).getByText('Ada, Countess')).toBeInTheDocument();
    expect(within(table).getByText('Linus "the" T.')).toBeInTheDocument();

    act(() => docsNow().open('package.json'));
    expect(await screen.findByText(/"storefront"/)).toBeInTheDocument();
    expect(document.querySelector('pre')?.textContent).toContain('\n  "scripts": {');

    act(() => docsNow().open('public/logo.svg'));
    const svg = await screen.findByRole('img', { name: 'logo.svg' });
    expect(svg.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(document.querySelector('svg text')).toBeNull(); // never inlined

    act(() => docsNow().open('public/index.html'));
    const frame = await screen.findByTitle('Preview of index.html');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).not.toMatch(/<script/i);
    await userEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(document.querySelector('pre')?.textContent).toContain('<script>alert(1)</script>');

    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['README.md', 'orders.csv', 'package.json', 'logo.svg', 'index.html']);
    await userEvent.click(screen.getByRole('button', { name: 'Close index.html' }));
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });

  it('PDF, Office, binary and large files get a card with the default app or Explorer; refusals explain and offer the file dialog', async () => {
    const api = createMockApi({ delay: 0 });
    const action = vi.spyOn(api, 'documentAction');
    render(<Viewer api={api}/>);
    act(() => docsNow().open('docs/brief.pdf'));
    expect(await screen.findByText(/PDFs cannot be previewed inside Harbor/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Open in default app' })[0]!);
    expect(action).toHaveBeenCalledWith('store', 'C:\\Projects\\Storefront\\docs\\brief.pdf', 'openExternal', undefined);
    expect(await screen.findByText(/available in the desktop app/)).toBeInTheDocument();
    act(() => docsNow().open('docs/budget.xlsx'));
    expect(await screen.findByText(/Office files cannot be previewed/)).toBeInTheDocument();
    act(() => docsNow().open('build/app.bin'));
    expect(await screen.findByText(/binary file/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in default app' })).toBeNull();
    act(() => docsNow().open('C:\\Windows\\win.ini'));
    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent(/Harbor did not open this file/);
    expect(within(refusal).getByRole('button', { name: 'Open file…' })).toBeInTheDocument();
    act(() => docsNow().open('.env'));
    expect(await screen.findByText(/never shows credential files/)).toBeInTheDocument();
  });

  it('refreshes the visible file when it changes, and sends since so an unchanged file costs nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = createMockApi({ delay: 0 });
      let version = 1;
      const real = api.openDocument!;
      api.openDocument = vi.fn(async (p: string, path: string, o?: { since?: number }): Promise<DocumentResult> => {
        const r = await real(p, path, o);
        if (!r.ok || version === 1) return r;
        return { ok: true as const, document: { ...r.document, unchanged: undefined, modified: r.document.modified + version, text: `# Version ${version}` } };
      });
      render(<Viewer api={api}/>);
      act(() => docsNow().open('docs/plan.md'));
      expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(api.openDocument).toHaveBeenLastCalledWith('store', 'C:\\Projects\\Storefront\\docs\\plan.md', expect.objectContaining({ since: expect.any(Number) }));
      expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
      version = 2;
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(await screen.findByRole('heading', { name: 'Version 2' })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('opens an agent\'s document request only for the conversation on screen', async () => {
    const api = createMockApi({ delay: 0 });
    const event = (conversationId: string, path: string): { seq: number; event: Extract<HarborEvent, { type: 'document' }> } => ({ seq: Math.random(), event: { type: 'document', projectId: 'store', conversationId, path } });
    const conversation = (await api.listConversations('store'))[0]!;
    const { result, rerender } = renderHook(({ req }) => useDocuments(api, 'store', conversation, [], req), { initialProps: { req: undefined as ReturnType<typeof event> | undefined } });
    rerender({ req: event('another-conversation', 'README.md') });
    await new Promise(r => setTimeout(r, 20));
    expect(result.current.tabs).toHaveLength(0);
    rerender({ req: event(conversation.id, 'docs/plan.md') });
    await waitFor(() => expect(result.current.tabs[0]?.result?.ok).toBe(true));
  });
});

describe('document viewer in the app', () => {
  it('Ctrl+K offers Open file… and opening a typed path', async () => {
    const api = createMockApi({ delay: 0 });
    window.harbor = api;
    const pick = vi.spyOn(api, 'pickDocument');
    render(<App/>);
    await screen.findByRole('heading', { name: 'Build the account page', level: 1 });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.click(await screen.findByRole('option', { name: /Open file…/ }));
    expect(pick).toHaveBeenCalledWith('store');
    const viewer = await screen.findByRole('region', { name: 'Document viewer' });
    expect(await within(viewer).findByRole('table')).toBeInTheDocument();
    await userEvent.click(within(viewer).getByRole('button', { name: 'Hide the document viewer' }));
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(screen.getByRole('combobox', { name: 'Search commands, projects and conversations' }), 'docs/plan.md');
    await userEvent.click(screen.getByRole('option', { name: /Open “\s*docs\/plan\.md\s*” in the viewer/ }));
    expect(await within(await screen.findByRole('region', { name: 'Document viewer' })).findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
  });
});
