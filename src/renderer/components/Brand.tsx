import logo from '../assets/harbor-logo.png';
import s from '../Harbor.module.css';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className={s.brand}><img src={logo} alt="" width={compact ? 25 : 32} height={compact ? 25 : 32}/>{compact ? null : <strong>harbor</strong>}</span>;
}
