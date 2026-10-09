import { useRef } from 'react';
import type { Conversation } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Brand } from './Brand';
import { sessionStatus } from '../session';
import { SessionStatus } from './SessionStatus';
import { CloseIcon, MoreIcon, PlusIcon, SearchIcon, SettingsIcon } from './Icons';
import s from '../Harbor.module.css';

// Two letters are enough to tell a handful of projects apart on the rail.
function initials(name: string) {
  const words = name.split(/[\s_\-.]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}
// Downscale to a small square PNG so the icon stays tiny inside state.json.
function toIcon(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // A data: URL, not a blob: URL: the CSP (index.html) allows img-src 'self' data: only.
    const bad = () => reject(new Error('That file is not an image Harbor can read.'));
    const reader = new FileReader();
    reader.onerror = bad;
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 96, c = document.createElement('canvas'); c.width = c.height = size;
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, side = Math.min(w, h);
        if (!side) return bad();
        c.getContext('2d')!.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = bad;
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function Sidebar({ state, settings, add, close, search, history, rename }: { state: HarborState; settings: () => void; add: () => void; close: () => void; search: () => void; history: () => void; rename: (c: Conversation) => void }) {
  const project = state.projects.find(p => p.id === state.projectId);
  const picker = useRef<HTMLInputElement>(null);
  const roleOf = (c: Conversation) => state.agents.find(a => a.id === c.agentId)?.role;
  // Subagent conversations are reached from the chat with the main agent, not from here.
  const mains = state.conversations.filter(c => !c.archived && (roleOf(c) === undefined || roleOf(c) === 'main'));
  const viewing = state.agents.find(a => a.id === state.conversation?.agentId);
  const activeAgentId = viewing && viewing.role !== 'main' ? viewing.parentId : viewing?.id;
  // From a subagent's chat, keep its main conversation marked (when that is unambiguous).
  const owners = mains.filter(c => c.agentId === activeAgentId);
  const isActive = (c: Conversation) => c.id === state.conversation?.id || (viewing?.role !== 'main' && owners.length === 1 && owners[0].id === c.id);
  // The main agent is shared by every conversation of a project, so a conversation counts as running only when its own subagents are, or when it is the one open.
  const isWorking = (c: Conversation) => ['working', 'queued'].includes(sessionStatus(c, state.agents, state.sending));
  const running = mains.find(c => isActive(c) && isWorking(c));
  const runningAgent = state.agents.find(a => a.id === running?.agentId);
  const today = startOfToday();
  const groups = [{ label: 'Pinned', items: mains.filter(c => c.pinned) }, { label: 'Today', items: mains.filter(c => !c.pinned && c.updated >= today) }, { label: 'Earlier', items: mains.filter(c => !c.pinned && c.updated < today) }].filter(g => g.items.length);
  return <nav aria-label="Projects and conversations" className={s.sidebar}>
    <div className={s.rail}>
      <Brand compact/>
      {state.projects.map(p => <button key={p.id} className={`${s.chip} ${state.projectId === p.id ? s.chipOn : ''}`} aria-label={p.name} aria-pressed={state.projectId === p.id} title={`${p.name}\n${p.path}`} onClick={() => { void state.selectProject(p.id); close(); }}>{p.image ? <img className={s.chipImg} src={p.image} alt=""/> : initials(p.name)}</button>)}
      <button className={s.chip} aria-label="Add project" title="Add project" onClick={add}><PlusIcon size={19} aria-hidden="true"/></button>
      <span className={s.railSpace}/>
      <button className={s.chip} aria-label="Settings" title="Settings" onClick={settings}><SettingsIcon size={19} aria-hidden="true"/></button>
      <button className={s.mobileClose} onClick={close} aria-label="Close project menu"><CloseIcon size={18} aria-hidden="true"/></button>
    </div>
    <div className={s.panel}>
      {state.loading ? <p role="status" className={s.muted}>Loading projects…</p> : null}
      {project ? <>
        <h2 className={s.panelTitle} title={project.path}>{project.name}</h2>
        <button className={s.sidebarSearch} onClick={search}><SearchIcon size={16} aria-hidden="true"/> Search <kbd>Ctrl K</kbd></button>
        <div className={s.imageRow}>
          <input ref={picker} type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.ico,image/png,image/jpeg,image/*" hidden aria-label="Project image file" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void state.run(async () => state.setProjectImage(project.id, await toIcon(f))); }}/>
          <button onClick={() => picker.current?.click()}>{project.image ? 'Change image' : 'Choose image'}</button>
          {project.image ? <button onClick={() => void state.setProjectImage(project.id, null)}>Remove image</button> : null}
        </div>
        <p className={s.panelSub}>{mains.length === 1 ? '1 conversation' : `${mains.length} conversations`}</p>
        {runningAgent && running ? <div className={s.live} role="status"><SessionStatus status={sessionStatus(running, state.agents, state.sending)}/><button className={s.stopLink} aria-label={`Stop ${runningAgent.title}`} onClick={() => { void state.run(() => state.api.stopConversation(running.id)); }}>Stop</button></div> : null}
        <button className={s.newConversation} onClick={() => { void state.newConversation(); close(); }}>New conversation</button>
        {state.projectLoading ? <p role="status" className={s.muted}>Loading conversations…</p> : null}
        <div className={s.conversationList}>
          {groups.map(g => <div key={g.label}><p className={s.group}>{g.label}</p>
            {g.items.map(c => <div key={c.id} className={s.conversationRow}>
              <button className={`${s.conversationLink} ${isActive(c) ? s.selected : ''}`} aria-current={isActive(c) ? 'page' : undefined} onClick={() => { void state.selectConversation(c); close(); }}><span className={s.conversationText}><span className={s.conversationTitle}>{c.title}</span>{sessionStatus(c, state.agents, state.sending) !== 'idle' ? <SessionStatus status={sessionStatus(c, state.agents, state.sending)}/> : null}</span></button>
              <details className={s.conversationMenu}><summary aria-label={`Options for ${c.title}`} title="Conversation options"><MoreIcon size={20} aria-hidden="true"/></summary><div className={s.conversationMenuItems}>
                <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); void state.updateConversation(c, { pinned: !c.pinned }); }}>{c.pinned ? 'Unpin' : 'Pin conversation'}</button>
                <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); rename(c); }}>Rename</button>
                <button disabled={['working', 'queued', 'waiting'].includes(sessionStatus(c, state.agents, state.sending))} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); void state.updateConversation(c, { archived: true }); }}>Archive</button>
              </div></details>
              <button className={s.deleteConversation} aria-label={`Delete conversation ${c.title}`} title="Delete conversation" onClick={() => { if (window.confirm(`Delete “${c.title}”? Its messages will be removed.`)) void state.deleteConversation(c); }}><CloseIcon size={14} aria-hidden="true"/></button>
            </div>)}
          </div>)}
        </div>
      </> : !state.loading ? <p className={s.muted}>Your projects will appear here.</p> : null}
      <div className={s.panelFoot}><button className={s.historyButton} onClick={history}>Conversation history</button><small>Local workspace{document.documentElement.dataset.demo ? ' · Demo' : ''}</small></div>
    </div>
  </nav>;
}
