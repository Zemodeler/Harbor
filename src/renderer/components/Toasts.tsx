import type { ToastState } from '../hooks/useToasts';
import n from './Navigation.module.css';

/** Polite live region: toasts never take focus; their buttons are reachable with Tab and named after the toast. */
export function Toasts({ toasts }: { toasts: ToastState }) {
  return <section className={n.toastRegion} aria-label="Notifications" aria-live="polite">
    {toasts.toasts.map(t => <div key={t.id} className={n.toast} data-kind={t.kind}>
      <strong>{t.title}</strong><p>{t.body}</p>
      <div className={n.toastActions}>
        {t.conversationId ? <button onClick={() => void toasts.open(t)} aria-label={`${t.kind === 'question' ? 'Answer' : 'Open conversation'}: ${t.body}`}>{t.kind === 'question' ? 'Answer' : 'Open conversation'}</button> : null}
        <button onClick={() => toasts.dismiss(t.id)} aria-label={`Dismiss notification: ${t.title}`}>Dismiss</button>
      </div>
    </div>)}
  </section>;
}
