import type { DocumentResult, DocumentView, HarborApi, Project } from '../../shared/api';

/**
 * Sample files for the document viewer in the browser demo. Mirrors Harbor's rules closely enough to show each state: files
 * resolve against the project folder, anything outside it is refused, credential files are refused, PDFs and Office files point
 * to the default app, HTML comes back already sanitised (main does that in Harbor), and the default app is desktop-only.
 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" rx="12" fill="#086e70"/><text x="80" y="48" font-size="20" text-anchor="middle" fill="#fff">Storefront</text></svg>')}`;
type Sample = Omit<DocumentView, 'path' | 'name' | 'size' | 'modified' | 'root' | 'relPath'> & { size?: number };
const SAMPLES: Record<string, Sample> = {
  'README.md': { kind: 'markdown', canOpenExternally: true, text: '# Storefront\n\nA sample shop. See [the account page](src/account.tsx) and [docs/plan.md](docs/plan.md).\n\n## Checks\n\n| Command | Purpose |\n|---|---|\n| `npm test` | unit tests |\n\n```ts\nexport const answer = 42;\n```\n\nMore at <https://example.com/docs>.\n\n<script>alert("shown as text")</script>' },
  'docs/plan.md': { kind: 'markdown', canOpenExternally: true, text: '# Plan\n\n1. Build the address form\n2. Review it\n\n> Written by the lead.' },
  'src/account.tsx': { kind: 'code', language: 'ts', text: "import { useState } from 'react';\n\n// The account page form.\nexport function Account() {\n  const [name, setName] = useState('');\n  return <input value={name} onChange={e => setName(e.target.value)}/>;\n}\n" },
  'src/address.tsx': { kind: 'code', language: 'ts', text: 'export const fields = ["street", "city", "zip"] as const;\n' },
  'package.json': { kind: 'json', language: 'json', canOpenExternally: true, text: '{"name":"storefront","scripts":{"test":"vitest run"},"private":true}' },
  'data/orders.csv': { kind: 'csv', canOpenExternally: true, text: 'id,customer,total\n1,"Ada, Countess",12.50\n2,Grace,7.00\n3,"Linus ""the"" T.",3.20\n' },
  'public/logo.svg': { kind: 'svg', mime: 'image/svg+xml', dataUrl: SVG },
  'public/dot.png': { kind: 'image', mime: 'image/png', dataUrl: PNG, canOpenExternally: true },
  'docs/brief.pdf': { kind: 'pdf', mime: 'application/pdf', canOpenExternally: true, note: 'PDFs cannot be previewed inside Harbor (its security settings block the PDF viewer). Open it in its default app.' },
  'docs/budget.xlsx': { kind: 'office', canOpenExternally: true, note: 'Office files cannot be previewed in Harbor yet. Open it in its default app.' },
  'public/index.html': { kind: 'html', language: 'html', text: '<h1>Welcome</h1><script>alert(1)</script>', html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><h1>Welcome</h1>` },
  'build/app.bin': { kind: 'binary', note: 'This is a binary file; Harbor cannot preview it.' },
  'logs/huge.log': { kind: 'tooLarge', size: 12 * 1024 * 1024, canOpenExternally: true, note: 'This file is larger than 5 MB, too large to preview.' }
};
const CREDENTIAL = /(^|[\\/])(\.env(\.|$)|id_rsa|[^\\/]*\.(pem|key|pfx|p12)$)/i;

export function createMockDocuments(projects: () => Project[], pause: () => Promise<void>): Pick<HarborApi, 'openDocument' | 'pickDocument' | 'documentAction'> {
  const started = Date.now() - 3600000;
  function open(projectId: string, raw: string): DocumentResult {
    const project = projects().find(p => p.id === projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    let path = raw.trim().replace(/:\d+(:\d+)?$/, '').replace(/\\/g, '/');
    const root = project.path.replace(/\\/g, '/');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('//')) return { ok: false, reason: 'invalid', message: 'Only files can be opened here, not web addresses.' };
    if (path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) path = path.slice(root.length + 1);
    else if (/^[a-z]:\//i.test(path) || path.split('/').includes('..')) return { ok: false, reason: 'outside', message: 'Harbor only opens files inside the project, its helpers\' worktrees and Harbor\'s own folders. Use "Open file…" to choose another file.' };
    path = path.replace(/^\.\//, '');
    if (CREDENTIAL.test(path)) return { ok: false, reason: 'credential', message: 'Harbor never shows credential files (.env, keys, tokens).' };
    const sample = SAMPLES[path];
    if (!sample) return { ok: false, reason: 'notFound', message: 'That file does not exist (it may have been moved or deleted).' };
    const { size, ...rest } = sample;
    return { ok: true, document: { ...rest, path: `${project.path}\\${path.replace(/\//g, '\\')}`, name: path.split('/').pop()!, relPath: path, root: 'project', size: size ?? (sample.text?.length ?? 2048), modified: started, canOpenExternally: !!sample.canOpenExternally } };
  }
  return {
    async openDocument(projectId, path, o) {
      await pause();
      const r = open(projectId, path);
      return r.ok && o?.since === r.document.modified ? { ok: true, document: { ...r.document, text: undefined, html: undefined, dataUrl: undefined, unchanged: true } } : r;
    },
    async pickDocument(projectId) { await pause(); return open(projectId, 'data/orders.csv'); },
    async documentAction() { throw new Error('Opening files outside Harbor is available in the desktop app.'); }
  };
}
