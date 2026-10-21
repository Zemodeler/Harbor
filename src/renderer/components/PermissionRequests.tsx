import { useEffect, useRef, useState } from 'react';
import { InlineConfirm } from './ui/InlineConfirm';
import type { Conversation } from '../../shared/api';
import type { HarborState, Permission } from '../hooks/useHarbor';
import { ScreenshotRequest } from './ScreenshotRequest';
import s from './PermissionRequests.module.css';

const KIND = { tool: 'Tool permission', conflict: 'File conflict', freeReset: 'Optional free reset', screenshot: 'Screenshot' } as const;
/** Harbor asks to run a project's `.harbor/checks.json` through a tool request with this name; the approval is remembered per file content. */
export const isChecksRequest = (p: Pick<Permission, 'kind' | 'tool'>) => p.kind === 'tool' && p.tool === 'Harbor checks';
const titleFor = (p: Permission) => isChecksRequest(p) ? 'Run this project’s checks?' : p.kind === 'tool' ? `Allow ${p.tool || 'this tool call'}?` : p.kind === 'conflict' ? 'Allow parallel editing?' : p.kind === 'screenshot' ? 'Allow a screenshot?' : 'Approve optional free reset?';
/** The checks prompt lists one command per indented line; show those as a list so each can be read. */
const checkCommands = (prompt: string) => prompt.split(/\r?\n/).filter(l => /^\s{2,}\S/.test(l)).map(l => l.trim());

function remaining(ms: number) {
  if (ms < 60_000) return 'less than a minute left';
  const min = Math.ceil(ms / 60_000);
  return `${min} min left`;
}

/**
 * Pending approvals as cards above the workspace, never a blocking dialog: navigation and the composer stay usable.
 * Nothing here answers on its own; an expired card is removed by useHarbor because Harbor has already denied it.
 */
export function PermissionRequests({ state, openConversation, fallbackFocus }: { state: HarborState; openConversation: (c: Conversation) => void; fallbackFocus: () => void }) {
  const { permissions, permissionAnswering: answering, permissionErrors: errors, permissionSyncError: syncError, permissionNotice: notice } = state;
  const [confirming, setConfirming] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState(false);
  const count = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const focused = useRef<number | undefined>(undefined);
  const resetReturn = useRef<string | undefined>(undefined);
  const timed = permissions.some(p => p.expiresAt !== undefined);
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [timed]);
  // A card that held focus disappeared (answered, expired or withdrawn): move to the card now in its place, never to <body>.
  const ids = permissions.map(p => p.requestId).join();
  useEffect(() => {
    const index = focused.current, active = document.activeElement;
    if (index === undefined || active && active !== document.body && document.contains(active)) return;
    focused.current = undefined;
    const cards = list.current?.querySelectorAll<HTMLElement>('[data-card]');
    const next = cards?.[Math.min(index, cards.length - 1)];
    if (next) next.focus(); else fallbackFocus();
  }, [ids, fallbackFocus]);
  // Hiding makes room to read the conversation; a new request shows the cards again.
  useEffect(() => { if (permissions.length > count.current) setCollapsed(false); count.current = permissions.length; }, [permissions.length]);
  useEffect(() => {
    // The safe choice (Back, the first button) has focus; a reset is only ever used after the explicit second click.
    if (confirming) list.current?.querySelector<HTMLElement>('[data-reset-confirm] button')?.focus();
    else if (resetReturn.current) list.current?.querySelector<HTMLElement>(`[data-request="${CSS.escape(resetReturn.current)}"] [data-reset]`)?.focus();
    resetReturn.current = undefined;
  }, [confirming]);
  // The live region stays mounted in every state (same position in the fragment), otherwise a notice that appears
  // together with its container is not announced by screen readers.
  const live = <div role="status" style={SR_ONLY}>{notice ?? ''}</div>;
  if (!permissions.length && !syncError && !notice) return <>{live}{null}</>;
  // Busy buttons stay focusable (aria-disabled), so focus survives a failed answer; useHarbor ignores repeat clicks.
  const answer = (p: Permission, choice: 'allow' | 'always' | 'deny') => { if (!answering[p.requestId]) void state.answerPermission(p.requestId, choice); };
  const locate = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-card]') : null;
  return <>{live}<section className={s.panel} aria-labelledby="permission-requests-title">
    <div className={s.panelHeader}>
      <h2 id="permission-requests-title" className={s.panelTitle}>{permissions.length ? <>Waiting for your answer <span className={s.count}>{permissions.length}</span></> : 'Approval requests'}</h2>
      {permissions.length ? <button className={s.toggle} aria-expanded={!collapsed} aria-controls="permission-requests-cards" onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Show requests' : 'Hide'}</button> : null}
      <div className={s.status}>{notice ? <><span>{notice}</span><button className={s.linkButton} onClick={state.dismissPermissionNotice}>Dismiss</button></> : null}</div>
    </div>
    {syncError ? <p className={s.syncError} role="alert">{syncError} <button className={s.linkButton} onClick={() => void state.refreshPermissions()}>Check again</button></p> : null}
    {permissions.length && !collapsed ? <div id="permission-requests-cards" className={s.cards} ref={list}
      onFocus={e => { const card = locate(e.target); if (card) focused.current = Number(card.dataset.index); }}
      onBlur={e => { if (e.relatedTarget && !list.current?.contains(e.relatedTarget as Node)) focused.current = undefined; }}>
      {permissions.map((p, index) => {
        const busy = answering[p.requestId];
        const agent = state.agents.find(a => a.id === p.agentId);
        const target = p.conversationId ? state.conversations.find(c => c.id === p.conversationId) : undefined;
        const titleId = `permission-${p.requestId}-title`, promptId = `permission-${p.requestId}-prompt`;
        const left = p.expiresAt !== undefined ? p.expiresAt - now : undefined;
        return <article key={p.requestId} className={s.card} data-card data-index={index} data-request={p.requestId} data-kind={p.kind} tabIndex={-1} aria-labelledby={titleId} aria-describedby={promptId} aria-busy={busy ? true : undefined}>
          <div className={s.cardTop}>
            <span className={s.kind}>{KIND[p.kind]}</span>
            {p.expiresAt !== undefined ? <span className={s.expiry} data-soon={left !== undefined && left < 60_000 || undefined}>Denied automatically at <time dateTime={new Date(p.expiresAt).toISOString()}>{new Date(p.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> · {remaining(Math.max(0, left ?? 0))}</span> : null}
          </div>
          <h3 id={titleId} className={s.title}>{titleFor(p)}</h3>
          <p id={promptId} className={s.prompt}>{p.prompt}</p>
          {agent || p.conversationId ? <p className={s.meta}>
            {agent ? <span>Asked by {agent.title}</span> : null}
            {target ? target.id === state.conversation?.id ? <span>In this conversation</span> : <span>In <button className={s.linkButton} onClick={() => openConversation(target)}>{target.title}</button></span>
              : p.conversationId ? <span>In a conversation outside this project</span> : null}
          </p> : null}
          {/* A screenshot is approved by picking what to capture in a live preview, never by a plain "allow". */}
          {p.kind === 'screenshot' ? <ScreenshotRequest p={p} api={state.api} busy={busy} answer={(choice, shot) => { if (!answering[p.requestId]) void state.answerPermission(p.requestId, choice, shot); }}/> : <>
          {isChecksRequest(p) && checkCommands(p.prompt).length ? <ul className={s.prompt} aria-label="Commands Harbor would run" style={{ paddingLeft: 18, whiteSpace: 'normal' }}>{checkCommands(p.prompt).map((c, i) => <li key={i}><code>{c}</code></li>)}</ul> : null}
          {isChecksRequest(p) ? <p className={s.hint}>Allowing approves exactly these commands for this project. Harbor remembers it and asks again only if the checks file changes.</p>
            : p.kind === 'tool' && !p.alwaysAllow ? <p className={s.hint}>This call can only be allowed once; Harbor will ask again next time.</p> : null}
          {p.kind === 'conflict' ? <p className={s.hint}>Allowing lets both agents work in separate worktrees; their results will need integration. Deny makes this agent wait.</p> : null}
          {confirming === p.requestId ? <div data-reset-confirm>
            <InlineConfirm label="Confirm free reset" tone="default" cancelLabel="Back" pending={!!busy} confirmLabel={busy === 'allow' ? 'Confirming…' : 'Confirm free reset'} onCancel={() => { resetReturn.current = p.requestId; setConfirming(undefined); }} onConfirm={() => answer(p, 'allow')}>Use one free reset now? Harbor will not use a reset without this confirmation.</InlineConfirm>
          </div> : <div className={s.actions}>
            <button aria-disabled={!!busy} onClick={() => answer(p, 'deny')}>{busy === 'deny' ? 'Denying…' : 'Deny'}</button>
            {p.kind === 'tool' && p.alwaysAllow ? <button aria-disabled={!!busy} onClick={() => answer(p, 'always')}>{busy === 'always' ? 'Saving rule…' : 'Always allow for this project'}</button> : null}
            {p.kind === 'freeReset' ? <button className={s.primary} data-reset aria-disabled={!!busy} onClick={() => { if (!busy) setConfirming(p.requestId); }}>Use free reset…</button>
              : <button className={s.primary} aria-disabled={!!busy} onClick={() => answer(p, 'allow')}>{busy === 'allow' ? 'Allowing…' : p.kind === 'conflict' ? 'Allow in parallel' : isChecksRequest(p) ? 'Allow these checks' : 'Allow once'}</button>}
          </div>}
          </>}
          {errors[p.requestId] ? <p className={s.error} role="alert">{errors[p.requestId]}</p> : null}
        </article>;
      })}
    </div> : null}
  </section></>;
}

const SR_ONLY: React.CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
