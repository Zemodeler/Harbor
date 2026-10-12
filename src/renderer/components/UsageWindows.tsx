import type { CliStatus, UsageWindow } from '../../shared/api';
import s from '../Harbor.module.css';
import f from './Features.module.css';

const PERIOD = { session: '5-hour session', weekly: 'Weekly' } as const;

/** Provider-reported readings and Harbor's own estimates look different on purpose: an estimate is never the provider's quota. */
export function sourceLabel(w: UsageWindow, name: string) {
  return w.source === 'reported' ? `Reported by ${name}` : 'Estimated from Harbor runs only';
}

export function UsageWindows({ windows, clis }: { windows: UsageWindow[]; clis: CliStatus[] }) {
  return <>
    <h3>Subscription windows</h3>
    <p className={s.muted}>Each window belongs to its provider. “Reported” readings come from the provider’s own CLI; “Estimated” ones only count what Harbor itself ran and are not your quota. Missing readings mean usage is unknown.</p>
    {!windows.length ? <p>Usage is unavailable. No allowance estimate is assumed.</p> : windows.map((w, i) => {
      const name = clis.find(c => c.id === w.cli)?.name ?? w.cli, known = Number.isFinite(w.usedPct), reported = w.source === 'reported';
      return <div className={s.connection} key={`${w.cli}-${w.label}-${i}`} data-source={reported ? 'reported' : 'estimated'}>
        <div className={s.connectionHeading}><h3>{name}</h3><span>{known ? `${Math.round(w.usedPct)}% ${reported ? 'used' : 'used (estimate)'}` : 'Usage unknown'}</span></div>
        <p>{w.label}{w.model ? ` · ${w.model}` : ''}</p>
        <div className={f.fxRow}>
          <span className={f.fxBadge} data-tone={reported ? 'ok' : 'warn'}>{sourceLabel(w, name)}</span>
          {w.period ? <span className={f.fxBadge}>{PERIOD[w.period] ?? w.period}</span> : null}
        </div>
        {known ? <progress aria-label={`${name} ${w.label} usage`} max={100} value={Math.max(0, Math.min(100, w.usedPct))}/> : null}
        <small>{w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : 'Reset time unknown'}
          {w.projectedPct !== undefined && Number.isFinite(w.projectedPct) ? ` · Projected ${Math.round(w.projectedPct)}% by the reset` : ''}
          {w.freeResetAvailable ? ' · Optional reset available (approval required)' : ''}</small>
      </div>;
    })}
  </>;
}
