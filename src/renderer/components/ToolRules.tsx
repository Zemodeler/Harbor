import { useCallback, useEffect, useState } from 'react';
import type { HarborApi, ToolRule } from '../../shared/api';
import { errorText } from '../hooks/useAgentActions';
import s from './Features.module.css';

export const ruleLabel = (r: ToolRule) => r.prefix ? `${r.tool}(${r.prefix} ...)` : r.tool;

/** "Always allow for this project" rules, each removable. Removing one means Harbor asks again next time. */
export function ToolRules({ api, projectId }: { api: HarborApi; projectId: string }) {
  const [rules, setRules] = useState<ToolRule[]>();
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string>();
  const load = useCallback(async () => {
    setError(''); setRules(undefined);
    try { setRules(await api.listToolRules(projectId)); } catch (e) { setError(errorText(e)); setRules([]); }
  }, [api, projectId]);
  useEffect(() => { void load(); }, [load]);
  async function remove(r: ToolRule) {
    setRemoving(r.id); setError('');
    try { setRules(await api.removeToolRule(projectId, r.id)); } catch (e) { setError(errorText(e)); } finally { setRemoving(undefined); }
  }
  return <div className={s.fxSettingsGroup}>
    <h3>Always-allowed tools</h3>
    <p className={s.fxNote}>Tool calls you chose to always allow for this project. Remove a rule and Harbor asks again next time.</p>
    {rules === undefined ? <p role="status">Loading…</p> : !rules.length ? <p className={s.fxNote}>No tools are always allowed in this project.</p>
      : <ul className={s.fxList} aria-label="Always-allowed tools">{rules.map(r => <li key={r.id}>
        <span className={s.fxMono}>{ruleLabel(r)}</span><span className={s.fxMuted}>added {new Date(r.created).toLocaleDateString()}</span>
        <button disabled={removing === r.id} aria-label={`Remove ${ruleLabel(r)}`} onClick={() => void remove(r)}>Remove</button>
      </li>)}</ul>}
    {error ? <p className={s.fxError} role="alert">{error}</p> : null}
  </div>;
}
