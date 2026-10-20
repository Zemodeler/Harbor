import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Conversation, SearchHit } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { highlight, parseQuery, rankEntries, type PaletteEntry } from '../palette';
import { builtinCommands } from '../slashCommands';
import type { PromptTemplate } from '../hooks/useWorkspace';
import { layouts, type AppearanceMode, type LayoutMode } from '../appearance';
import { sessionStatus } from '../session';
import { SearchIcon } from './Icons';
import s from '../Harbor.module.css';
import n from './Navigation.module.css';

/** What the palette can ask the shell to do; optional members hide their commands. */
export interface PaletteActions {
  settings: () => void;
  add: () => void;
  newProject?: () => void;
  review: () => void;
  activity: () => void;
  git?: () => void;
  rename?: (c: Conversation) => void;
  editTags?: (c: Conversation) => void;
  deep?: () => void;
  insertPrompt?: (text: string) => void;
  welcome?: () => void;
  setTheme?: (mode: AppearanceMode) => void;
  setLayout?: (layout: LayoutMode) => void;
  showArchived?: () => void;
  /** Document viewer: pick any file (native dialog), or open a typed project-relative or absolute path (main checks it). */
  openFile?: () => void;
  openPath?: (path: string) => void;
}
export interface PaletteMeta { tags: Record<string, string[]>; recent: string[]; used: (id: string) => void }

const SEARCH_DELAY_MS = 180;
const LIMIT = 60;
const kindLabel = { action: 'Command', project: 'Project', conversation: 'Conversation', prompt: 'Prompt' } as const;
const themeNames: Record<AppearanceMode, string> = { system: 'Use system', light: 'Light', dark: 'Dark', contrast: 'High contrast' };

type Entry = PaletteEntry & { conversation?: Conversation };

const Option = memo(function Option({ entry, id, index, active, query, run, hover }: { entry: Entry; id: string; index: number; active: boolean; query: string; run: (e: Entry) => void; hover: (i: number) => void }) {
  return <li id={id} role="option" aria-selected={active} aria-disabled={entry.disabled || undefined} className={n.option} data-active={active || undefined}
    onMouseDown={e => e.preventDefault()} onMouseMove={active ? undefined : () => hover(index)} onClick={() => run(entry)}>
    <span className={n.optionMain}>
      <span className={n.optionTitle}>{highlight(entry.title, query).map((p, i) => p.match ? <mark key={i}>{p.text}</mark> : p.text)}</span>
      {entry.detail ? <small> {entry.detail}</small> : null}
      {entry.excerpt ? <span className={n.excerpt}> {highlight(entry.excerpt, query).map((p, i) => p.match ? <mark key={i}>{p.text}</mark> : p.text)}</span> : null}
    </span>
    <span className={n.optionMeta}>{entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}<span className={n.kind}>{kindLabel[entry.kind]}</span></span>
  </li>;
});

/**
 * Keyboard-first command palette (Ctrl+K): commands, projects, conversations (titles locally, messages through
 * searchConversations) and saved prompts in one ranked list. `history` limits it to this project's conversations,
 * archived ones included. Prefixes: ">" commands, "@" projects, "#" tags.
 */
export function CommandMenu({ state, history, close, actions, meta, templates = [] }: { state: HarborState; history?: boolean; close: () => void; actions: PaletteActions; meta?: PaletteMeta; templates?: PromptTemplate[] }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [active, setActive] = useState(0);
  const listId = useId(), optionId = useId();
  const list = useRef<HTMLUListElement>(null);
  const parsed = parseQuery(query);
  const text = parsed.text;
  // Message search goes to Harbor (it searches titles and message text); local titles answer instantly meanwhile.
  const wantsSearch = (parsed.scope === 'all' && text.length >= 2) || (history && !!text);
  useEffect(() => {
    let live = true;
    setError('');
    if (!wantsSearch) { setLoading(false); setHits([]); setSearched(''); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void state.api.searchConversations(text, history ? state.projectId : undefined)
        .then(result => { if (live) { setHits(result); setSearched(text); } })
        .catch(e => { if (live) setError(e instanceof Error && e.message ? e.message : 'Search failed.'); })
        .finally(() => { if (live) setLoading(false); });
    }, SEARCH_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [state.api, state.projectId, text, history, wantsSearch, retry]);

  const c = state.conversation;
  const busy = c ? ['working', 'queued', 'waiting'].includes(sessionStatus(c, state.agents, state.sending)) : false;
  const projectName = (id: string) => state.projects.find(p => p.id === id)?.name || '';
  const commands = useMemo<Entry[]>(() => {
    if (history) return [];
    const none = !state.projectId, noConv = !c;
    const list: Array<Entry | false | undefined> = [
      { id: 'cmd:new', kind: 'action', title: 'New conversation', shortcut: 'Ctrl N', disabled: none, keywords: ['chat', 'start'] },
      { id: 'cmd:open-project', kind: 'action', title: 'Open a project', keywords: ['add project', 'folder'] },
      ...(actions.newProject ? [{ id: 'cmd:new-project', kind: 'action' as const, title: 'New project', keywords: ['create project', 'start project', 'new repository'] }] : []),
      { id: 'cmd:settings', kind: 'action', title: 'Open Settings', keywords: ['preferences', 'connections', 'sign in', 'usage'] },
      actions.openFile && { id: 'cmd:open-file', kind: 'action', title: 'Open file…', detail: 'Show a file in the viewer', disabled: none, keywords: ['document', 'viewer', 'view file'] },
      actions.git && { id: 'cmd:git', kind: 'action', title: 'Git branches and changes', disabled: none, keywords: ['branches', 'commits', 'diff'] },
      { id: 'cmd:session', kind: 'action', title: 'Session information', disabled: noConv, keywords: ['activity', 'agents', 'helpers'] },
      { id: 'cmd:review', kind: 'action', title: 'Review changes', disabled: noConv, keywords: ['diff'] },
      actions.deep && { id: 'cmd:deep', kind: 'action', title: 'Ask with /deep', detail: 'Skip the quick first answer and start a strong lead', disabled: noConv || c?.archived, keywords: ['deep', 'strong', 'lead'] },
      { id: 'cmd:folder', kind: 'action', title: 'Open project folder', disabled: none, keywords: ['explorer'] },
      state.api.openWorkspace && { id: 'cmd:terminal', kind: 'action', title: 'Open terminal here', disabled: none, keywords: ['shell', 'console'] },
      state.api.openWorkspace && { id: 'cmd:editor', kind: 'action', title: 'Open in editor', disabled: none, keywords: ['vs code', 'code'] },
      c && { id: 'cmd:pin', kind: 'action', title: c.pinned ? 'Unpin this conversation' : 'Pin this conversation' },
      c && { id: 'cmd:archive', kind: 'action', title: c.archived ? 'Restore this conversation' : 'Archive this conversation', disabled: !c.archived && busy },
      c && actions.rename && { id: 'cmd:rename', kind: 'action', title: 'Rename this conversation' },
      c && actions.editTags && { id: 'cmd:tags', kind: 'action', title: 'Edit tags of this conversation', keywords: ['label'] },
      c && busy && { id: 'cmd:stop', kind: 'action', title: 'Stop this session', keywords: ['cancel'] },
      actions.showArchived && { id: 'cmd:archived', kind: 'action', title: 'Show archived conversations', disabled: none, keywords: ['history'] },
      ...(actions.setTheme ? (Object.keys(themeNames) as AppearanceMode[]).map(m => ({ id: `cmd:theme:${m}`, kind: 'action' as const, title: `Theme: ${themeNames[m]}`, keywords: ['appearance', 'color', m === 'contrast' ? 'accessibility' : 'mode'] })) : []),
      ...(actions.setLayout ? layouts.map(l => ({ id: `cmd:layout:${l.id}`, kind: 'action' as const, title: `Layout: ${l.name}`, keywords: ['workspace mode', 'view'] })) : []),
      actions.welcome && { id: 'cmd:welcome', kind: 'action', title: 'Show the welcome guide', keywords: ['onboarding', 'help', 'modes'] },
      ...(actions.insertPrompt ? [...builtinCommands.filter(b => b.kind !== 'harbor').map(b => ({ id: `prompt:${b.id}`, kind: 'prompt' as const, title: `Insert prompt: ${b.title}`, detail: `/${b.name}`, disabled: noConv || c?.archived })),
        ...templates.map(t => ({ id: `prompt:saved:${t.id}`, kind: 'prompt' as const, title: `Insert prompt: ${t.title}`, detail: t.text.slice(0, 80), disabled: noConv || c?.archived }))] : [])
    ];
    return list.filter((e): e is Entry => !!e);
  }, [history, state.projectId, state.api.openWorkspace, c, busy, actions, templates]);
  const projects = useMemo<Entry[]>(() => history ? [] : [...state.projects].sort((a, b) => b.lastOpened - a.lastOpened).map(p => ({ id: `project:${p.id}`, kind: 'project', title: p.name, detail: p.path })), [history, state.projects]);
  const conversations = useMemo<Entry[]>(() => {
    const tags = meta?.tags || {};
    const describe = (conv: Conversation, project: string, excerpt?: string): Entry => ({ id: `conv:${conv.id}`, kind: 'conversation', conversation: conv, title: conv.title, excerpt,
      detail: [project, conv.archived ? 'Archived' : '', conv.pinned ? 'Pinned' : '', ...(tags[conv.id] || []).map(t => `#${t}`)].filter(Boolean).join(' · '),
      keywords: (tags[conv.id] || []).map(t => `#${t}`) });
    const local = state.conversations.filter(x => history || !x.archived || !!text).map(x => describe(x, projectName(x.projectId)));
    // Harbor's hits add message matches and other projects; a hit for a listed conversation adds its excerpt.
    const fresh = searched === text ? hits : [];
    const byId = new Map(local.map(e => [e.conversation!.id, e]));
    const extra: Entry[] = [];
    for (const h of fresh) {
      const known = byId.get(h.conversation.id);
      if (known) { if (h.excerpt) known.excerpt = h.excerpt; known.keywords = [...(known.keywords || []), ...(h.excerpt ? [text] : [])]; }
      else extra.push({ ...describe(h.conversation, h.projectName, h.excerpt), keywords: [text] });
    }
    return [...local, ...extra];
  }, [state.conversations, state.projects, hits, searched, text, history, meta?.tags]);

  // A typed path (with a folder separator or a file extension) can be opened directly; main checks it like any other path.
  const typed = query.trim();
  const typedPath = !history && actions.openPath && state.projectId && parsed.scope === 'all' && typed.length <= 400 && /^\S.*(?:[\\/].*|\.[A-Za-z0-9]{1,8})$/.test(typed) ? typed : undefined;
  const ranked = useMemo<Entry[]>(() => {
    const recent = meta?.recent || [];
    if (parsed.scope === 'actions') return rankEntries(commands, text, { recent, limit: LIMIT });
    if (parsed.scope === 'projects') return rankEntries(projects, text, { recent, limit: LIMIT });
    if (parsed.scope === 'tag') {
      const tagged = conversations.filter(e => (e.keywords || []).some(k => k.startsWith(`#${text.toLocaleLowerCase()}`)));
      return rankEntries(tagged, '', { recent, limit: LIMIT });
    }
    if (history) return text ? rankEntries(conversations, text, { limit: LIMIT }) : conversations.slice(0, LIMIT);
    if (!text) {
      // Nothing typed: recently used first, then commands, projects and this project's latest conversations.
      const all = [...commands, ...projects, ...conversations.slice(0, 8)];
      const firstRecent = recent.map(id => all.find(e => e.id === id)).filter((e): e is Entry => !!e && !e.disabled);
      const rest = all.filter(e => !firstRecent.includes(e));
      return [...firstRecent, ...rest].slice(0, LIMIT);
    }
    return rankEntries([...commands, ...projects, ...conversations], text, { recent, limit: LIMIT });
  }, [commands, projects, conversations, parsed.scope, text, history, meta?.recent]);
  const entries = useMemo<Entry[]>(() => typedPath ? [{ id: 'cmd:open-path', kind: 'action', title: `Open “${typedPath}” in the viewer` }, ...ranked] : ranked, [typedPath, ranked]);

  useEffect(() => { setActive(0); }, [query]);
  const current = Math.min(active, Math.max(entries.length - 1, 0));
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-active]`)?.scrollIntoView?.({ block: 'nearest' }); }, [current]);

  function run(entry: Entry) {
    if (entry.disabled) return;
    meta?.used(entry.id);
    const conv = entry.conversation;
    close();
    const id = entry.id;
    if (id === 'cmd:open-path') { if (typedPath) actions.openPath?.(typedPath); return; }
    if (conv) { void state.openConversation(conv); return; }
    if (id.startsWith('project:')) { void state.selectProject(id.slice(8)); return; }
    if (id.startsWith('cmd:theme:')) { actions.setTheme?.(id.slice(10) as AppearanceMode); return; }
    if (id.startsWith('cmd:layout:')) { actions.setLayout?.(id.slice(11) as LayoutMode); return; }
    if (id.startsWith('prompt:')) {
      const key = id.slice(7);
      const text = key.startsWith('saved:') ? templates.find(t => t.id === key.slice(6))?.text : builtinCommands.find(b => b.id === key)?.text;
      if (text) actions.insertPrompt?.(text);
      return;
    }
    const pid = state.projectId;
    switch (id) {
      case 'cmd:new': void state.newConversation(); break;
      case 'cmd:open-project': actions.add(); break;
      case 'cmd:new-project': actions.newProject?.(); break;
      case 'cmd:settings': actions.settings(); break;
      case 'cmd:open-file': actions.openFile?.(); break;
      case 'cmd:git': actions.git?.(); break;
      case 'cmd:session': actions.activity(); break;
      case 'cmd:review': actions.review(); break;
      case 'cmd:deep': actions.deep?.(); break;
      case 'cmd:folder': void state.run(() => state.api.openProjectFolder(pid)); break;
      case 'cmd:terminal': void state.run(() => state.api.openWorkspace!(pid, 'terminal')); break;
      case 'cmd:editor': void state.run(() => state.api.openWorkspace!(pid, 'editor')); break;
      case 'cmd:pin': if (c) void state.updateConversation(c, { pinned: !c.pinned }); break;
      case 'cmd:archive': if (c) void state.updateConversation(c, { archived: !c.archived }); break;
      case 'cmd:rename': if (c) actions.rename?.(c); break;
      case 'cmd:tags': if (c) actions.editTags?.(c); break;
      case 'cmd:stop': if (c) void state.stopConversation(c.id); break;
      case 'cmd:archived': actions.showArchived?.(); break;
      case 'cmd:welcome': actions.welcome?.(); break;
    }
  }
  const runRef = useRef(run); runRef.current = run;
  const runStable = useCallback((entry: Entry) => runRef.current(entry), []);
  function onKeyDown(e: KeyboardEvent) {
    if (e.nativeEvent.isComposing) return;
    const last = entries.length - 1;
    const move = (to: number) => { e.preventDefault(); setActive(Math.max(0, Math.min(last, to))); };
    if (e.key === 'ArrowDown') move(current >= last ? 0 : current + 1);
    else if (e.key === 'ArrowUp') move(current <= 0 ? last : current - 1);
    else if (e.key === 'PageDown') move(current + 8);
    else if (e.key === 'PageUp') move(current - 8);
    else if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey) move(e.key === 'Home' ? 0 : last);
    else if (e.key === 'Enter') { e.preventDefault(); const entry = entries[current]; if (entry) run(entry); }
  }
  const label = history ? 'Search conversation history' : 'Search commands, projects and conversations';
  const activeId = entries.length ? `${optionId}-${current}` : undefined;
  return <div className={n.palette}>
    <div className={s.searchBox}><SearchIcon size={18} aria-hidden="true"/>
      <input autoFocus className={s.search} role="combobox" aria-label={label} aria-expanded={entries.length > 0} aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list"
        placeholder={history ? 'Search titles and messages…' : 'Type a command, project or conversation…'} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}/>
    </div>
    {!history ? <p className={n.hint} id={`${listId}-hint`}>↑↓ to move · Enter to run · <kbd>&gt;</kbd> commands · <kbd>@</kbd> projects · <kbd>#</kbd> tags</p> : null}
    <ul ref={list} id={listId} role="listbox" aria-label={history ? 'Conversations' : 'Results'} className={n.options}>
      {entries.map((entry, i) => <Option key={entry.id} id={`${optionId}-${i}`} index={i} entry={entry} active={i === current} query={text} run={runStable} hover={setActive}/>)}
    </ul>
    <div aria-live="polite" className={n.status}>
      {loading ? <p>Searching messages…</p> : error ? <p role="alert">{error} <button onClick={() => setRetry(x => x + 1)}>Retry search</button></p>
        : !entries.length ? <p className={s.muted}>{history || parsed.scope === 'tag' ? 'No matching conversations.' : 'Nothing matches. Try fewer letters, or > for commands.'}</p> : null}
    </div>
  </div>;
}
