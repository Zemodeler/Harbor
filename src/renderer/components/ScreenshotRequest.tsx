import { useEffect, useRef, useState } from 'react';
import type { HarborApi, ScreenshotSource } from '../../shared/api';
import type { Permission, PermissionAnswer } from '../hooks/useHarbor';
import s from './PermissionRequests.module.css';

/** How often the preview is refreshed while the card is shown: it is a live view of what would be captured. */
export const PREVIEW_REFRESH_MS = 2500;

/**
 * The body of a screenshot request card (CHANGELOG 0.1.33). The user picks the window or screen; nothing is preselected, because the
 * capture target must be their choice and never the agent's text. A live preview of the choice is shown before anything is captured
 * or sent; "allow for this conversation" is offered for a window only and starts unticked.
 */
export function ScreenshotRequest({ p, api, busy, answer }: { p: Permission; api: HarborApi; busy?: PermissionAnswer; answer: (choice: 'allow' | 'deny', shot?: { sourceId: string; forConversation: boolean }) => void }) {
  const info = p.screenshot;
  const [sources, setSources] = useState<ScreenshotSource[]>();
  const [detail, setDetail] = useState<ScreenshotSource>();
  const [chosen, setChosen] = useState<string>();
  const [forConversation, setForConversation] = useState(false);
  const [problem, setProblem] = useState('');
  const [updated, setUpdated] = useState<number>();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const supported = typeof api.previewScreenshot === 'function' && typeof api.answerScreenshot === 'function';

  // The list of windows and screens, refreshed while the card is up (a window may open, close or change).
  useEffect(() => {
    if (!supported || busy) return;
    let stop = false;
    const load = () => api.previewScreenshot!(p.requestId).then(list => { if (!stop && alive.current) { setSources(list); setProblem(''); setUpdated(Date.now()); } })
      .catch(e => { if (!stop && alive.current) setProblem(e instanceof Error && e.message ? e.message : 'The preview could not be loaded.'); });
    void load();
    const timer = setInterval(load, PREVIEW_REFRESH_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [api, p.requestId, supported, busy]);

  // A larger live view of the chosen source: exactly what "Capture" would take.
  useEffect(() => {
    setDetail(undefined);
    if (!supported || !chosen || busy) return;
    let stop = false;
    const load = () => api.previewScreenshot!(p.requestId, { sourceId: chosen }).then(list => { if (!stop && alive.current) { setDetail(list[0]); setProblem(''); setUpdated(Date.now()); } })
      .catch(e => { if (!stop && alive.current) { setDetail(undefined); setProblem(e instanceof Error && e.message ? e.message : 'That window or screen is no longer available.'); } });
    void load();
    const timer = setInterval(load, PREVIEW_REFRESH_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [api, p.requestId, chosen, supported, busy]);

  const picked = sources?.find(x => x.id === chosen) ?? (detail?.id === chosen ? detail : undefined);
  const ready = !!picked && detail?.id === chosen && !busy;
  const choose = (id: string) => { setChosen(id); setForConversation(false); };
  const who = info?.agentRole === 'main' ? 'The lead agent' : info?.agentTitle ? `Helper “${info.agentTitle}”` : 'An agent';
  const asked = info?.target === 'screen' ? 'a screen' : info?.title ? `a window like “${info.title}”` : 'a window';

  return <div className={s.shot}>
    <dl className={s.shotFacts}>
      <div><dt>Asked by</dt><dd>{who}{info?.projectName ? <> in {info.projectName}</> : null}</dd></div>
      <div><dt>Wants</dt><dd>{asked}</dd></div>
      {info?.why ? <div><dt>Reason</dt><dd>{info.why}</dd></div> : null}
    </dl>
    <p className={s.shotWarning} role="note">Windows and screens can show passwords, tokens and private messages. Nothing is captured or sent to a model until you pick what to capture below and choose Capture. The agent’s request is only a hint.</p>
    {info?.recent ? <p className={s.hint}>This agent received a screenshot less than a minute ago.</p> : null}
    {!supported ? <p className={s.error} role="alert">This version of Harbor cannot show a preview, so the capture cannot be approved here. Deny it, or update Harbor.</p>
      : <>
        <fieldset className={s.shotSources} disabled={!!busy}>
          <legend>What to capture{updated ? <span className={s.shotLive}> · live preview, updated {new Date(updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> : null}</legend>
          {!sources ? <p className={s.hint} role="status">Loading windows and screens…</p> : !sources.length ? <p className={s.hint}>No windows or screens are available.</p>
            : <div className={s.shotGrid}>{sources.map(src => <label key={src.id} className={s.shotSource} data-chosen={src.id === chosen || undefined}>
              <input type="radio" name={`shot-${p.requestId}`} value={src.id} checked={src.id === chosen} onChange={() => choose(src.id)}/>
              {src.thumbnail ? <img src={src.thumbnail} alt=""/> : <span className={s.shotBlank} aria-hidden="true"/>}
              <span className={s.shotName}>{src.kind === 'screen' ? 'Screen: ' : ''}{src.name || '(untitled window)'}{src.suggested ? <small> · matches the request</small> : null}</span>
            </label>)}</div>}
        </fieldset>
        {chosen ? <figure className={s.shotPreview}>
          {detail?.thumbnail ? <img src={detail.thumbnail} alt={`Preview of ${picked?.name ?? 'the chosen source'}`}/> : <p className={s.hint} role="status">Loading the preview…</p>}
          <figcaption>This is what would be captured and given to the agent.</figcaption>
        </figure> : null}
        {picked?.kind === 'window' ? <label className={s.shotOption}><input type="checkbox" checked={forConversation} onChange={e => setForConversation(e.target.checked)} disabled={!!busy}/> Allow this window for the rest of this conversation (later window requests capture it without asking, at most once a minute per agent; never a whole screen)</label> : null}
      </>}
    {problem ? <p className={s.error} role="alert">{problem}</p> : null}
    <div className={s.actions}>
      <button aria-disabled={!!busy} onClick={() => { if (!busy) answer('deny'); }}>{busy === 'deny' ? 'Denying…' : 'Deny'}</button>
      <button className={s.primary} aria-disabled={!ready} onClick={() => { if (ready && chosen) answer('allow', { sourceId: chosen, forConversation: picked?.kind === 'window' && forConversation }); }}>{busy === 'allow' ? 'Capturing…' : 'Capture and send'}</button>
    </div>
  </div>;
}
