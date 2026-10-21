import type { ReactNode } from 'react';
import s from './Switch.module.css';

/** A native checkbox presented as a switch: same keyboard and form behaviour, role "switch" for assistive technology. */
export function Switch({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return <label className={s.switch} data-disabled={disabled || undefined}>
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}/>
    <span className={s.track} aria-hidden="true"/>
    <span>{children}</span>
  </label>;
}
