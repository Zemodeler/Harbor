import type { CliStatus, UsageWindow } from '../../shared/api';
import s from '../Harbor.module.css';
import f from './Features.module.css';

const PERIOD = { session: '5-hour session', weekly: 'Weekly' } as const;
const PERIOD_MS = { session: 5 * 3600_000, weekly: 7 * 86400_000 } as const;

/** Provider-reported readings and Harbor's own estimates look different on purpose: an estimate is never the provider's quota. */
export function sourceLabel(w: UsageWindow, name: string) {
  return w.source === 'reported' ? `Reported by ${name}` : 'Estimated from Harbor runs only';
}

/** An estimate whose budget is Harbor's fallback guess (never learned from a provider reading) is only approximate. */
export const isApproximate = (w: UsageWindow) => w.source !== 'reported' && w.calibrated === false;

/**
 * Straight-line pace: how much of the window would be used by now if it were spent evenly up to the reset.
 * Derived here from the reading and its reset time; undefined when either is missing or the period is unknown.
 */
export function paceOf(w: UsageWindow, now = Date.now()): { budgetPct: number; deltaPct: number; hoursLeft: number } | undefined {
  if (!w.period || !w.resetsAt || !Number.isFinite(w.usedPct)) return undefined;
  const length = PERIOD_MS[w.period], left = w.resetsAt - now;
  if (!length || left <= 0 || left > length) return undefined;
  const budgetPct = (1 - left / length) * 100;
  return { budgetPct, deltaPct: w.usedPct - budgetPct, hoursLeft: left / 3600_000 };
}

function paceText(w: UsageWindow, now: number) {
  const p = paceOf(w, now);
  if (!p) return null;
  const hours = p.hoursLeft >= 48 ? `${Math.round(p.hoursLeft / 24)} days` : `${Math.max(1, Math.round(p.hoursLeft))} h`;
  const delta = Math.round(Math.abs(p.deltaPct));
  const where = delta < 3 ? 'on pace' : p.deltaPct > 0 ? `${delta} points over pace` : `${delta} points under pace`;
  return `Pace: ${where} (an even spend would be at ${Math.round(p.budgetPct)}% now) · ${hours} to the reset`;
}

export function UsageWindows({ windows, clis, now = Date.now() }: { windows: UsageWindow[]; clis: CliStatus[]; now?: number }) {
  return <>
    <h3>Subscription windows</h3>
    <p className={s.muted}>Each window belongs to its provider. “Reported” readings come from the provider’s own CLI; “Estimated” ones only count what Harbor itself ran and are not your quota. Missing readings mean usage is unknown. Pace and the projection are Harbor’s straight-line estimates.</p>
    {!windows.length ? <p>Usage is unavailable. No allowance estimate is assumed.</p> : windows.map((w, i) => {
      const name = clis.find(c => c.id === w.cli)?.name ?? w.cli, known = Number.isFinite(w.usedPct), reported = w.source === 'reported', approx = isApproximate(w);
      const projected = w.projectedPct !== undefined && Number.isFinite(w.projectedPct) ? Math.round(w.projectedPct) : undefined;
      const pace = known && !approx ? paceText(w, now) : null;
      return <div className={s.connection} key={`${w.cli}-${w.label}-${i}`} data-source={reported ? 'reported' : 'estimated'} data-approximate={approx || undefined}>
        <div className={s.connectionHeading}><h3>{name}</h3><span>{!known ? 'Usage unknown' : approx ? `About ${Math.round(w.usedPct)}% (approximate)` : `${Math.round(w.usedPct)}% ${reported ? 'used' : 'used (estimate)'}`}</span></div>
        <p>{w.label}{w.model ? ` · ${w.model}` : ''}</p>
        <div className={f.fxRow}>
          <span className={f.fxBadge} data-tone={reported ? 'ok' : 'warn'}>{sourceLabel(w, name)}</span>
          {w.period ? <span className={f.fxBadge}>{PERIOD[w.period] ?? w.period}</span> : null}
          {approx ? <span className={f.fxBadge} data-tone="warn" title="Harbor has not yet seen a provider reading to learn this budget from, so the figure is a fallback guess.">Uncalibrated</span> : null}
        </div>
        {known && !approx ? <progress aria-label={`${name} ${w.label} usage`} max={100} value={Math.max(0, Math.min(100, w.usedPct))}/> : null}
        {approx ? <p className={f.fxNote}>Harbor has no provider reading to calibrate this window yet, so the percentage is a rough guess and is not drawn as a gauge.</p> : null}
        <small>{w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : 'Reset time unknown'}
          {projected !== undefined ? ` · Projected ${approx ? 'about ' : ''}${projected}% by the reset (estimate)` : ''}
          {w.freeResetAvailable ? ' · Optional reset available (approval required)' : ''}</small>
        {pace ? <p className={f.fxNote} style={{ marginTop: 4 }} data-pace>{pace}{projected !== undefined && projected < 100 && w.period === 'weekly' ? ` · about ${100 - projected}% may go unused at this pace` : ''}</p> : null}
      </div>;
    })}
    <p className={f.fxNote}>Routing also gives each quota pool a state (spend, neutral, conserve, protect); it appears in a reply’s routing details until Harbor reports it here.</p>
  </>;
}
