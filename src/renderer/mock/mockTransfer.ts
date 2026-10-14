import type { BundleExportPreview, BundleItem, BundlePreview, ChatImportEntry, ChatImportSourceId, ChatImportSourceInfo, CliStatus, Conversation, HarborApi, HarborEvent, ImportedInfo, Message, Project, Settings } from '../../shared/api';

type TransferMethods = Required<Pick<HarborApi, 'previewBundleExport' | 'exportBundle' | 'browseImportFile' | 'previewBundle' | 'importBundle' | 'listImportSources' | 'previewImport' | 'importConversation' | 'continueImported'>>;
interface Data { projects: Project[]; conversations: Conversation[]; messages: Message[]; clis: CliStatus[] }

const SOURCES: ChatImportSourceInfo[] = [
  { id: 'claude-code', name: 'Claude Code', kind: 'folder', available: true, location: '~\\.claude\\projects', verified: true, note: 'Sessions in ~\\.claude\\projects. Harbor lists the session files; it reads only the ones you choose.' },
  { id: 'codex', name: 'Codex', kind: 'folder', available: true, location: '~\\.codex\\sessions', verified: true, note: 'Sessions in ~\\.codex\\sessions. Harbor lists the session files and their names; it reads only the ones you choose.' },
  { id: 'claude-export', name: 'claude.ai export', kind: 'file', available: true, verified: false, note: 'The conversations.json of a claude.ai data export, or the export .zip. Not yet checked against a real export.' },
  { id: 'chatgpt-export', name: 'ChatGPT export', kind: 'file', available: true, verified: false, note: 'The conversations.json of a ChatGPT data export, or the export .zip. Not yet checked against a real export.' }
];
const LABEL: Record<ChatImportSourceId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'claude-export': 'claude.ai export', 'chatgpt-export': 'ChatGPT export' };
const EXCLUDED = ['Credentials, sign-ins and tokens', 'Secret values of MCP servers and environment variables', 'CLI paths and custom CLI descriptors', 'Absolute paths of this machine (rewritten to project-relative paths)', 'Run logs, helper reports, check output and the journal', 'Native CLI session ids (a bundle conversation cannot be resumed, only continued)'];
const SECRET = /\b(?:ghp_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,})|(?:password|token|api[_-]?key)\s*[:=]\s*\S{4,}/i;

/**
 * Import and export for the demo (CHANGELOG 0.1.35): the same rules the UI depends on (a preview before anything is written, a secret
 * choice before saving, a newer bundle version refused, no silent overwrite, imported chats read-only, "Continue with" making a new
 * conversation). Nothing is read from or written to disk; the chats are sample text.
 */
export function createMockTransfer(data: () => Data, settings: () => Settings, emit: (e: HarborEvent) => void, pause: () => Promise<void>): TransferMethods {
  const copy = <T,>(v: T): T => structuredClone(v);
  const id = () => crypto.randomUUID();
  const exports = new Map<string, BundleExportPreview>();
  const bundles = new Map<string, BundlePreview>();
  const listings = new Map<string, { source: ChatImportSourceId; entries: ChatImportEntry[]; done: Set<string> }>();
  const project = (projectId: string) => { const p = data().projects.find(x => x.id === projectId); if (!p) throw new Error('Choose an existing project.'); return p; };

  function addImported(projectId: string, title: string, imported: ImportedInfo, turns: Array<[Message['role'], string]>): Conversation {
    const d = data(), now = Date.now();
    const c: Conversation = { id: id(), projectId, title, updated: now, agentId: `main-${projectId}`, customTitle: true, imported: { ...imported, messages: turns.length } };
    d.conversations.unshift(c);
    d.messages.push({ id: id(), conversationId: c.id, role: 'system', time: now - turns.length - 1, text: `Imported from ${imported.label}: read-only history (${turns.length} messages). It was written outside Harbor; agents see it only as quoted history. Use "Continue with…" to keep working on it. Demo only: sample text.` });
    turns.forEach(([role, text], i) => d.messages.push({ id: id(), conversationId: c.id, role, text, time: now - turns.length + i }));
    emit({ type: 'conversation', conversation: copy(c) });
    return copy(c);
  }

  return {
    async previewBundleExport(projectId, sel) {
      const p = project(projectId);
      await pause();
      const d = data();
      const convs = (sel.conversations ?? []).map(cid => { const c = d.conversations.find(x => x.id === cid && x.projectId === p.id); if (!c) throw new Error('A chosen conversation is not a conversation of this project.'); return c; });
      const items: BundleItem[] = [];
      const own = settings().projectOverrides?.[p.id];
      if (sel.settings && own && Object.keys(own).length) items.push({ kind: 'settings', key: 'settings', label: 'Routing preferences', detail: Object.keys(own).join(', ') });
      if (sel.toolRules) items.push({ kind: 'toolRules', key: 'toolRules', label: '2 tool rules', detail: 'Bash(npm test ...), Read' });
      if (sel.skillChoices) items.push({ kind: 'skillChoices', key: 'skillChoices', label: 'Skill choices for this project', detail: 'project:release-notes on' });
      for (const c of convs) items.push({ kind: 'conversation', key: c.id, label: c.title, detail: `${d.messages.filter(m => m.conversationId === c.id && m.role !== 'tool').length} messages, 0 decisions` });
      for (const sk of sel.skills ?? []) items.push({ kind: 'skill', key: sk, label: sk.replace(/^[a-z]+:(user\/|project\/)?/, ''), detail: '2 files' });
      if (!items.length) throw new Error('Choose at least one thing to export.');
      const secrets = convs.flatMap(c => d.messages.filter(m => m.conversationId === c.id && SECRET.test(m.text)).map(m => ({ where: `conversation "${c.title}"`, kind: 'secret-looking value', excerpt: `${(SECRET.exec(m.text)?.[0] ?? '').slice(0, 4)}… (${SECRET.exec(m.text)?.[0].length ?? 0} characters)` })));
      const token = id();
      const preview: BundleExportPreview = { token, fileName: `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.harbor.zip`, items, excluded: [...EXCLUDED, ...(sel.images ? [] : ['Image files (only their names), unless you tick "Include images"'])], secrets, bytes: 4096 + items.length * 1800, notes: ['Demo only: nothing is read or written.'] };
      exports.set(token, preview);
      return copy(preview);
    },
    async exportBundle(token, o) {
      const pv = exports.get(token);
      if (!pv) throw new Error('That export preview has expired. Check it again.');
      if (pv.secrets.length && !o?.keepSecrets && !o?.redactSecrets) throw new Error(`The secret scan found ${pv.secrets.length} possible secret${pv.secrets.length === 1 ? '' : 's'}. Choose to remove ${pv.secrets.length === 1 ? 'it' : 'them'} or to keep ${pv.secrets.length === 1 ? 'it' : 'them'}, then export again.`);
      exports.delete(token);
      await pause();
      return { path: `C:\\Users\\you\\Documents\\${pv.fileName}`, bytes: pv.bytes, items: pv.items.length, ...(o?.redactSecrets && pv.secrets.length ? { redacted: pv.secrets.length } : {}) };
    },
    async browseImportFile(kind) { await pause(); return kind === 'bundle' ? 'C:\\Downloads\\storefront.harbor.zip' : 'C:\\Downloads\\conversations.json'; },
    async previewBundle(path) {
      await pause();
      if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(path.trim())) throw new Error('Choose the bundle by its full path.');
      if (/newer/i.test(path)) return { version: 2, supported: false, items: [], conversations: [], secrets: [], problems: ['This bundle was made by a newer Harbor (bundle version 2; this Harbor reads up to version 1). Update Harbor, then import it again. Nothing was read beyond its version.'] };
      const token = id();
      const preview: BundlePreview = {
        token, version: 1, supported: true, createdAt: Date.now() - 86400000, appVersion: '0.1.0', projectName: 'Storefront',
        items: [{ kind: 'settings', key: 'settings', label: 'Routing preferences', detail: 'concurrencyLimit, effortPolicy' }, { kind: 'toolRules', key: 'toolRules', label: '2 tool rules' }, { kind: 'conversation', key: 'c1', label: 'Shipping estimates' }, { kind: 'conversation', key: 'c2', label: 'Refund flow' }, { kind: 'skill', key: 'release-notes', label: 'release-notes' }],
        conversations: [{ key: 'c1', title: 'Shipping estimates', messages: 4, decisions: 1, images: 0 }, { key: 'c2', title: 'Refund flow', messages: 2, decisions: 0, images: 1 }],
        settings: { concurrencyLimit: 2, effortPolicy: 'quality' },
        toolRules: [{ tool: 'Bash', prefix: 'npm test', allowed: true }, { tool: 'Bash', prefix: 'git push', allowed: false }],
        checksFile: '.harbor/checks.json',
        skills: { source: 'bundle "Storefront"', fileCount: 1, totalBytes: 900, skills: [{ name: 'release-notes', description: 'Write release notes (demo).', dir: 'release-notes', targetName: 'release-notes', files: [{ path: 'SKILL.md', bytes: 900 }], bytes: 900, hasScripts: false }] },
        secrets: []
      };
      bundles.set(token, preview);
      return copy(preview);
    },
    async importBundle(token, o) {
      const pv = bundles.get(token);
      if (!pv) throw new Error('That bundle preview has expired. Check it again.');
      const p = project(o.projectId);
      const own = settings().projectOverrides?.[p.id];
      if (o.settings && own && Object.keys(own).length && !o.replaceSettings) throw new Error(`${p.name} already has its own routing preferences. Tick "Replace them" to use the bundle's, or leave routing preferences out.`);
      bundles.delete(token);
      await pause();
      const applied: string[] = [], skipped: string[] = [];
      if (o.settings) applied.push('Routing preferences');
      if (o.toolRules) { applied.push('1 tool rule'); skipped.push('Tool rule Bash(git push ...): Harbor never always-allows it.'); }
      if (o.skills?.length) applied.push(`${o.skills.length} skill${o.skills.length === 1 ? '' : 's'} into the library`);
      const conversations = pv.conversations.filter(c => o.conversations?.includes(c.key)).map(c => addImported(p.id, c.title, { source: 'bundle', label: `Harbor bundle from ${pv.projectName}`, importedAt: Date.now(), messages: 0 }, [['user', `Sample request from the bundle: ${c.title}.`], ['assistant', 'Sample answer. Demo only.']]));
      if (conversations.length) applied.push(`${conversations.length} conversation${conversations.length === 1 ? '' : 's'} as read-only history`);
      skipped.push('The bundle\'s project used .harbor/checks.json; its commands stay in the repository and run only after you approve them here.');
      return { conversations, skills: [], applied, skipped };
    },
    async listImportSources() { return copy(SOURCES); },
    async previewImport(source, o) {
      const src = SOURCES.find(x => x.id === source);
      if (!src) throw new Error('Unknown import source.');
      if (src.kind === 'file' && !o?.path?.trim()) throw new Error('Choose the export file first.');
      await pause();
      const now = Date.now();
      const entries: ChatImportEntry[] = src.kind === 'folder'
        ? [{ id: 's1', title: source === 'codex' ? 'Parser tests' : '~-Projects-Storefront', detail: source === 'codex' ? '2026/10/02/rollout-…' : 'session 1', updated: now - 3600000, bytes: 48000 }, { id: 's2', title: source === 'codex' ? 'Fix the build' : '~-Projects-Storefront', detail: 'session 2', updated: now - 86400000, bytes: 120000 }]
        : [{ id: '0', title: 'Trip planning', started: now - 864000000, updated: now - 860000000, messages: 6 }, { id: '1', title: 'Regex help', started: now - 400000000, messages: 4 }];
      const token = id();
      listings.set(token, { source, entries, done: new Set() });
      return { token, source, label: src.kind === 'file' ? `${LABEL[source]} (conversations.json)` : LABEL[source], entries: copy(entries) };
    },
    async importConversation(projectId, token, entryIds) {
      const l = listings.get(token);
      if (!l) throw new Error('That chat listing has expired. Check it again.');
      const p = project(projectId);
      await pause();
      const conversations: Conversation[] = [], skipped: string[] = [];
      for (const eid of entryIds) {
        const e = l.entries.find(x => x.id === eid);
        if (!e) { skipped.push(`${eid}: not in this listing.`); continue; }
        if (l.done.has(eid)) { skipped.push(`${e.title}: already imported from this listing.`); continue; }
        l.done.add(eid);
        const title = l.source === 'claude-code' ? `Dark mode toggle (${e.detail})` : e.title;
        conversations.push(addImported(p.id, title, { source: l.source, label: LABEL[l.source].replace(/ export$/, ''), importedAt: Date.now(), started: e.started ?? e.updated, messages: 0, skipped: ['12 tool calls', '12 tool results', '3 thinking blocks'] },
          [['user', 'Add a dark mode toggle to the settings page.'], ['assistant', 'Done: the toggle is in src/settings.tsx. (Sample text, demo only.)']]));
        skipped.push(`${title}: left out 12 tool calls, 12 tool results, 3 thinking blocks.`);
      }
      return { conversations, skipped };
    },
    async continueImported(conversationId, o) {
      const d = data();
      const c = d.conversations.find(x => x.id === conversationId);
      if (!c) throw new Error('This conversation is no longer available.');
      if (!c.imported) throw new Error('Only an imported conversation can be continued this way. Send a message to continue this one.');
      const cli = d.clis.find(x => x.id === o?.cli);
      if (!cli?.installed) throw new Error(`${o?.cli || 'That CLI'} is not installed.`);
      await pause();
      const next: Conversation = { id: id(), projectId: c.projectId, title: `${c.title} (continued)`, updated: Date.now(), agentId: `main-${c.projectId}`, customTitle: true, continuedFrom: c.id };
      d.conversations.unshift(next);
      d.messages.push({ id: id(), conversationId: next.id, role: 'system', time: Date.now(), text: `Continues "${c.title}" (imported from ${c.imported.label}). On its first turn the lead gets Harbor's summary of that chat as quoted history (not a replay; the other tool's own session is never resumed), and Harbor prefers ${cli.name} for it. Write what you want done next.` });
      emit({ type: 'conversation', conversation: copy(next) });
      return copy(next);
    }
  };
}
