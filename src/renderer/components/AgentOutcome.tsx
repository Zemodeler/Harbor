import type { Agent } from '../../shared/api';
import s from './Features.module.css';

export const shortHash = (h?: string) => h ? h.slice(0, 7) : '';
const outcomeLabel = { done: 'Done', partial: 'Partial', blocked: 'Blocked' } as const;
const FINISHED = ['done', 'failed', 'stopped'];

export function OutdatedBadge() {
  return <span className={s.fxBadge} data-tone="warn" title="The branch has moved since this was recorded, so it no longer covers the current head.">outdated</span>;
}

/**
 * What a helper reported and what Harbor itself verified, kept apart on purpose:
 * `Agent.checks` are commands Harbor ran (evidence); `Agent.result.checks` are the helper's own claims.
 */
export function AgentOutcome({ agent }: { agent: Agent }) {
  const r = agent.result, checks = agent.checks ?? [], claimed = r?.checks ?? [], stale = agent.outdated === true;
  const noVerdict = agent.role === 'reviewer' && FINISHED.includes(agent.state) && !r?.verdict;
  if (!r && !checks.length && !noVerdict && !stale) return null;
  return <div className={s.fxBlock} data-stale={stale || undefined} aria-label={`Results for ${agent.title}`}>
    {r ? <div className={s.fxHead}>
      <span>Outcome: {outcomeLabel[r.outcome] ?? r.outcome}</span>
      {r.verdict ? <span className={s.fxBadge} data-tone={r.verdict === 'approve' ? 'ok' : 'bad'} data-stale={stale || undefined}>{r.verdict === 'approve' ? 'Approve' : 'Changes requested'}{r.commit ? <span className={s.fxMono}> @ {shortHash(r.commit)}</span> : null}</span> : null}
      {stale ? <OutdatedBadge/> : null}
    </div> : stale ? <div className={s.fxHead}><OutdatedBadge/></div> : null}
    {noVerdict ? <div className={s.fxHead}><span className={s.fxBadge} data-tone="bad">NO VERDICT</span><span className={s.fxMuted}>This reviewer ended without approving or requesting changes.</span></div> : null}
    {r?.summary ? <div className={s.fxMuted}>{r.summary}</div> : null}
    {checks.length ? <div>
      <div className={s.fxHead}>Checks run by Harbor{agent.testedCommit ? <span className={s.fxMuted}>on <span className={s.fxMono}>{shortHash(agent.testedCommit)}</span></span> : null}{stale ? <OutdatedBadge/> : null}</div>
      <ul className={s.fxList}>{checks.map((c, i) => <li key={`${c.cmd}-${i}`}>
        <span className={s.fxBadge} data-tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'pass' : 'fail'}</span><span className={s.fxMono}>{c.cmd}</span>
        {!c.ok ? <span className={s.fxMuted}>{c.timedOut ? 'timed out' : c.exitCode === null ? 'no exit code' : `exit code ${c.exitCode}`}</span> : null}
      </li>)}</ul>
    </div> : null}
    {claimed.length ? <div>
      <div className={s.fxHead}>Reported by the helper<span className={s.fxMuted}>(its own claims, not run by Harbor)</span></div>
      <ul className={s.fxList}>{claimed.map((c, i) => <li key={`${c.cmd}-${i}`}><span className={s.fxBadge} data-tone="warn">{c.ok ? 'says pass' : 'says fail'}</span><span className={s.fxMono}>{c.cmd}</span></li>)}</ul>
    </div> : null}
  </div>;
}
