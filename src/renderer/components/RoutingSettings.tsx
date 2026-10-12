import { useEffect, useState } from 'react';
import type { AgentRole, EffortPolicy, LowAllowancePolicy, ProjectSettings, RolePreference, Settings } from '../../shared/api';
import type { HarborState } from '../hooks/useHarbor';
import { errorText } from '../hooks/useAgentActions';
import s from './Features.module.css';
import h from '../Harbor.module.css';

const EFFORT: [EffortPolicy, string][] = [['adaptive', 'Adaptive'], ['conserve', 'Conserve allowance'], ['quality', 'Prioritize quality']];
const LOW: [LowAllowancePolicy, string][] = [['reduceEffort', 'Stay on the CLI and reduce effort'], ['switch', 'Switch CLI']];
const ROLES: Exclude<AgentRole, 'main'>[] = ['planner', 'implementer', 'reviewer', 'other'];
const ROLE_LABEL: Record<Exclude<AgentRole, 'main'>, string> = { planner: 'Planner', implementer: 'Implementer', reviewer: 'Reviewer', other: 'Other helpers' };
const KEYS = ['concurrencyLimit', 'allowedModels', 'rolePreferences', 'effortPolicy', 'lowAllowancePolicy', 'subscriptionReserve'] as const;
type Key = typeof KEYS[number];

const scopedOf = (st: Settings): ProjectSettings => Object.fromEntries(KEYS.filter(k => st[k] !== undefined).map(k => [k, st[k]]));

/**
 * Saves one field and keeps the rejection text next to it. The call goes straight to the API so the message is not lost
 * in the global banner; on success the returned settings are handed to the shared state (same values, so a no-op write).
 */
function useFieldSave(state: HarborState) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState('');
  async function save(field: string, patch: Partial<Settings>) {
    setSaving(field); setErrors(e => ({ ...e, [field]: '' }));
    try { const next = await state.api.setSettings(patch); await state.updateSettings(next); }
    catch (e) { setErrors(es => ({ ...es, [field]: errorText(e) })); }
    finally { setSaving(''); }
  }
  return { errors, saving, save };
}

function NumberField({ label, value, min, max, placeholder, suffix, onCommit, disabled }: { label: string; value?: number; min: number; max: number; placeholder?: string; suffix?: string; onCommit: (v: number | undefined) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => { const n = draft.trim() === '' ? undefined : Number(draft); if (n !== value && (n === undefined || Number.isFinite(n))) onCommit(n); else setDraft(value === undefined ? '' : String(value)); };
  return <div className={s.fxRow}><input type="number" aria-label={label} min={min} max={max} step={1} value={draft} placeholder={placeholder} disabled={disabled} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}/>{suffix ? <span className={s.fxMuted}>{suffix}</span> : null}</div>;
}

/** The routing fields once, for the global settings and, with `projectId`, as per-project overrides ("Inherit global"). */
export function RoutingFields({ state, projectId }: { state: HarborState; projectId?: string }) {
  const { errors, saving, save } = useFieldSave(state);
  const st = state.settings!;
  const global = scopedOf(st);
  const own: ProjectSettings = projectId ? st.projectOverrides?.[projectId] ?? {} : global;
  const inherit = projectId !== undefined;
  const usable = state.clis.filter(c => c.installed && c.models.length > 0);
  const change = (field: Key, value: ProjectSettings[Key]) => {
    if (!inherit) return save(field, { [field]: value } as Partial<Settings>);
    const entry = { ...own, [field]: value } as Record<string, unknown>;
    for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
    return save(field, { projectOverrides: { [projectId]: entry as ProjectSettings } });   // {} clears the project
  };
  const effective = <K extends Key>(k: K) => own[k] ?? global[k];
  const unset = inherit ? 'Inherit global' : 'Default';
  const err = (f: string) => errors[f] ? <p className={s.fxError} role="alert">{errors[f]}</p> : null;
  const off = saving !== '';

  const allowed = own.allowedModels ?? {};
  const toggleModel = (cli: string, model: string, on: boolean) => {
    const list = allowed[cli] ?? [];
    const nextList = on ? [...list, model] : list.filter(m => m !== model);
    const next = { ...allowed }; if (nextList.length) next[cli] = nextList; else delete next[cli];
    void change('allowedModels', Object.keys(next).length ? next : undefined);
  };
  const prefs = own.rolePreferences ?? {};
  const setPref = (role: Exclude<AgentRole, 'main'>, patch: Partial<RolePreference>) => {
    const cur = { ...(prefs[role] ?? {}), ...patch } as Record<string, string | undefined>;
    for (const k of Object.keys(cur)) if (!cur[k]) delete cur[k];
    const next: NonNullable<Settings['rolePreferences']> = { ...prefs };
    if (Object.keys(cur).length) next[role] = cur as RolePreference; else delete next[role];
    void change('rolePreferences', Object.keys(next).length ? next : undefined);
  };

  return <>
    {inherit ? <div className={s.fxRow}><p className={s.fxNote}>Anything left on “Inherit global” follows Settings → Routing.</p><button disabled={off || !Object.keys(own).length} onClick={() => void save('reset', { projectOverrides: { [projectId]: {} } })}>Reset all to global</button></div> : null}
    {err('reset')}
    <div className={s.fxSettingsGroup}><h4>Concurrency limit</h4>
      <NumberField label={inherit ? 'Project concurrency limit' : 'Concurrency limit'} value={own.concurrencyLimit} min={1} max={8} placeholder={inherit ? `global: ${effective('concurrencyLimit') ?? 'default 4'}` : 'default 4'} suffix="agents at once (1–8)" disabled={off} onCommit={v => void change('concurrencyLimit', v)}/>
      {err('concurrencyLimit')}</div>
    <div className={s.fxSettingsGroup}><h4>Allowed models</h4><p className={s.fxNote}>Leave a CLI with nothing ticked to allow all of its models.</p>
      {!usable.length ? <p className={s.fxNote}>No connected CLI reports its models yet.</p> : usable.map(cli => <fieldset key={cli.id} className={s.fxChoices} style={{ border: 0, padding: 0, margin: 0 }}><legend className={s.fxMuted}>{cli.name}{inherit && !allowed[cli.id] && global.allowedModels?.[cli.id] ? ` (global: ${global.allowedModels[cli.id].join(', ')})` : ''}</legend>
        {cli.models.map(m => <label key={m}><input type="checkbox" disabled={off} checked={allowed[cli.id]?.includes(m) ?? false} onChange={e => toggleModel(cli.id, m, e.target.checked)}/>{m}</label>)}</fieldset>)}
      {err('allowedModels')}</div>
    <div className={s.fxSettingsGroup}><h4>Role preferences</h4><p className={s.fxNote}>A strong preference, not a rule: unavailable or disallowed options are skipped.</p>
      <div className={s.fxTable}>{ROLES.map(role => { const p = prefs[role] ?? {}, cliModels = (p.cli ? usable.filter(c => c.id === p.cli) : usable).flatMap(c => c.models);
        return <div key={role} style={{ display: 'contents' }}><span>{ROLE_LABEL[role]}</span>
          <select aria-label={`${ROLE_LABEL[role]} CLI`} disabled={off} value={p.cli ?? ''} onChange={e => setPref(role, { cli: e.target.value, model: undefined })}><option value="">{unset}{inherit && global.rolePreferences?.[role]?.cli ? ` (${global.rolePreferences[role]!.cli})` : ''}</option>{usable.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select aria-label={`${ROLE_LABEL[role]} model`} disabled={off} value={p.model ?? ''} onChange={e => setPref(role, { model: e.target.value })}><option value="">Any model</option>{[...new Set([...cliModels, ...(p.model ? [p.model] : [])])].map(m => <option key={m} value={m}>{m}</option>)}</select>
        </div>; })}</div>
      {err('rolePreferences')}</div>
    <div className={s.fxSettingsGroup}><h4>Effort and allowance</h4>
      <label className={s.fxField}>Effort policy<select disabled={off} value={own.effortPolicy ?? ''} onChange={e => void change('effortPolicy', (e.target.value || undefined) as EffortPolicy | undefined)}><option value="">{unset} ({EFFORT.find(([v]) => v === (inherit ? global.effortPolicy ?? 'adaptive' : 'adaptive'))![1]})</option>{EFFORT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>{err('effortPolicy')}
      <label className={s.fxField}>When allowance runs low<select disabled={off} value={own.lowAllowancePolicy ?? ''} onChange={e => void change('lowAllowancePolicy', (e.target.value || undefined) as LowAllowancePolicy | undefined)}><option value="">{unset} ({inherit && global.lowAllowancePolicy ? LOW.find(([v]) => v === global.lowAllowancePolicy)![1] : 'use the CLI with more allowance left'})</option>{LOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>{err('lowAllowancePolicy')}
      <div className={s.fxField}><span>Subscription reserve</span><NumberField label={inherit ? 'Project subscription reserve' : 'Subscription reserve'} value={own.subscriptionReserve} min={0} max={50} placeholder={inherit ? `global: ${global.subscriptionReserve ?? 0}` : '0'} suffix="% kept for you (0–50)" disabled={off} onCommit={v => void change('subscriptionReserve', v)}/></div>{err('subscriptionReserve')}
    </div>
  </>;
}

/** Global routing tab: the shared fields plus the background switch (and the update switch once the contract has it). */
export function RoutingSettings({ state }: { state: HarborState }) {
  const { errors, saving, save } = useFieldSave(state);
  const st = state.settings as (Settings & { autoUpdate?: boolean }) | undefined;
  if (!st) return null;
  return <>
    <RoutingFields state={state}/>
    <div className={s.fxSettingsGroup}><h4>Background</h4>
      <label className={h.checkboxRow}><input type="checkbox" disabled={saving === 'keep'} checked={st.keepRunningInBackground === true} onChange={e => void save('keep', { keepRunningInBackground: e.target.checked })}/> Keep Harbor running in the background when the window is closed</label>
      <p className={s.fxNote}>Closing the window hides Harbor to the tray and running agents keep working. “Quit” in the tray menu really stops Harbor and everything it runs.</p>
      {errors.keep ? <p className={s.fxError} role="alert">{errors.keep}</p> : null}
      {/* autoUpdate is not in contract Settings yet: shown only when the core starts returning it. */}
      {'autoUpdate' in st ? <><label className={h.checkboxRow}><input type="checkbox" disabled={saving === 'update'} checked={st.autoUpdate === true} onChange={e => void save('update', { autoUpdate: e.target.checked } as Partial<Settings>)}/> Download updates automatically</label>{errors.update ? <p className={s.fxError} role="alert">{errors.update}</p> : null}</> : null}
    </div>
  </>;
}
