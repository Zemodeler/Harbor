import { ClockIcon, DoneIcon, QuestionIcon, StopIcon, WarningIcon, WorkingIcon } from './Icons';
import { statusLabels, type SessionState } from '../session';
import type { SessionActivity } from '../../shared/api';
import s from '../Harbor.module.css';

export function SessionStatus({ status }: { status: SessionState }) {
  const Icon = status === 'working' ? WorkingIcon : status === 'queued' ? ClockIcon : status === 'waiting' ? QuestionIcon : status === 'failed' ? WarningIcon : status === 'stopped' ? StopIcon : DoneIcon;
  return <span className={s.sessionStatus} data-state={status}><Icon size={14} className={status === 'working' ? s.spinner : undefined} aria-hidden="true"/><span>{statusLabels[status]}</span></span>;
}

const complexityLabels = { low: 'Low', medium: 'Medium', high: 'High' } as const;
export function ComplexityBadge({ complexity }: { complexity?: SessionActivity['complexity'] }) {
  if (!complexity || !complexityLabels[complexity]) return null;
  return <span className={s.complexityBadge} data-level={complexity}>{complexityLabels[complexity]}<span className={s.srOnly}> complexity</span></span>;
}
