import { useRef } from 'react';
import type { Conversation } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { Brand } from './Brand';
import s from '../Harbor.module.css';

// Two letters are enough to tell a handful of projects apart on the rail.
function initials(name: string) {
  const words = name.split(/[\s_\-.]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}
// Downscale to a small square PNG so the icon stays tiny inside state.json.
function toIcon(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const size = 96, c = document.createElement('canvas'); c.width = c.height = size;
      const side = Math.min(img.width, img.height);
      c.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url); resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image Harbor can read.')); };
    img.src = url;
  });
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function Sidebar({ state, settings, add, close }: { state: HarborState; settings: () => void; add: () => void; close: () => void }) {
  const project = state.projects.find(p => p.id === state.projectId);
  const picker = useRef<HTMLInputElement>(null);
  const roleOf = (c: Conversation) => state.agents.find(a => a.id === c.agentId)?.role;
  // Subagent conversations are reached from the chat with the main agent, not from here.
  const mains = state.conversations.filter(c => roleOf(c) === undefined || roleOf(c) === 'main');
  const viewing = state.agents.find(a => a.id === state.conversation?.agentId);
  const activeAgentId = viewing && viewing.role !== 'main' ? viewing.parentId : viewing?.id;
  // From a subagent's chat, keep its main conversation marked (when that is unambiguous).
  const owners = mains.filter(c => c.agentId === activeAgentId);
  const isActive = (c: Conversation) => c.id === state.conversation?.id || (viewing?.role !== 'main' && owners.length === 1 && owners[0].id === c.id);
  // The main agent is shared by every conversation of a project, so a conversation counts as running only when its own subagents are, or when it is the one open.
  const busy = (a: { state: string }) => ['working', 'queued'].includes(a.state);
  const isWorking = (c: Conversation) => state.agents.some(a => busy(a) && (a.conversationId === c.id || (a.id === c.agentId && c.id === state.conversation?.id)));
  const running = mains.find(c => isActive(c) && isWorking(c));
  const runningAgent = state.agents.find(a => a.id === running?.agentId);
  const today = startOfToday();
  const groups = [{ label: 'Today', items: mains.filter(c => c.updated >= today) }, { label: 'Earlier', items: mains.filter(c => c.updated < today) }].filter(g => g.items.length);
  return <nav aria-label="Projects and conversations" className={s.sidebar}>
    <div className={s.rail}>
      <Brand compact/>
      {state.projects.map(p => <button key={p.id} className={`${s.chip} ${state.projectId === p.id ? s.chipOn : ''}`} aria-label={p.name} aria-pressed={state.projectId === p.id} title={`${p.name}\n${p.path}`} onClick={() => { void state.selectProject(p.id); close(); }}>{p.image ? <img className={s.chipImg} src={p.image} alt=""/> : initials(p.name)}</button>)}
      <button className={s.chip} aria-label="Add project" title="Add project" onClick={add}>+</button>
      <span className={s.railSpace}/>
      <button className={s.chip} aria-label="Settings" title="Settings" onClick={settings}>⚙</button>
      <button className={s.mobileClose} onClick={close} aria-label="Close project menu">×</button>
    </div>
    <div className={s.panel}>
      {state.loading ? <p role="status" className={s.muted}>Loading projects…</p> : null}
      {project ? <>
        <h2 className={s.panelTitle} title={project.path}>{project.name}</h2>
        <div className={s.imageRow}>
          <input ref={picker} type="file" accept="image/*" hidden aria-label="Project image file" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void state.run(async () => state.setProjectImage(project.id, await toIcon(f))); }}/>
          <button onClick={() => picker.current?.click()}>{project.image ? 'Change image' : 'Choose image'}</button>
          {project.image ? <button onClick={() => void state.setProjectImage(project.id, null)}>Remove image</button> : null}
        </div>
        <p className={s.panelSub}>{mains.length === 1 ? '1 conversation' : `${mains.length} conversations`}</p>
        {runningAgent ? <div className={s.live} role="status"><span className={s.dot} data-state="working"/><span>Working<small>{runningAgent.cli} / {runningAgent.model}</small></span><button className={s.stopLink} aria-label={`Stop ${runningAgent.title}`} onClick={() => { void state.run(() => state.api.stopAgent(runningAgent.id)); }}>Stop</button></div> : null}
        <button className={s.newConversation} onClick={() => { void state.newConversation(); close(); }}>New conversation</button>
        {state.projectLoading ? <p role="status" className={s.muted}>Loading conversations…</p> : null}
        <div className={s.conversationList}>
          {groups.map(g => <div key={g.label}><p className={s.group}>{g.label}</p>
            {g.items.map(c => <div key={c.id} className={s.conversationRow}>
              <button className={`${s.conversationLink} ${isActive(c) ? s.selected : ''}`} aria-current={isActive(c) ? 'page' : undefined} onClick={() => { void state.selectConversation(c); close(); }}>{isWorking(c) ? <span className={s.dot} data-state="working" aria-label="Working"/> : null}<span>{c.title}</span></button>
              <button className={s.deleteConversation} aria-label={`Delete conversation ${c.title}`} title="Delete conversation" onClick={() => { if (window.confirm(`Delete “${c.title}”? Its messages will be removed.`)) void state.deleteConversation(c); }}>×</button>
            </div>)}
          </div>)}
        </div>
      </> : !state.loading ? <p className={s.muted}>Your projects will appear here.</p> : null}
      <small className={s.panelFoot}>Local workspace{document.documentElement.dataset.demo ? ' · Demo' : ''}</small>
    </div>
  </nav>;
}
