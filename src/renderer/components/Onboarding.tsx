import { useState } from 'react';
import type { HarborState } from '../hooks/useHarbor';
import { cliReadiness, readinessSummary } from '../onboarding';
import { Modal } from './ui/Modal';
import { CloseIcon, DoneIcon, QuestionIcon, StopIcon, WarningIcon } from './Icons';
import s from '../Harbor.module.css';
import n from './Navigation.module.css';

const steps = ['Welcome', 'Connect your tools', 'Add a project', 'How Harbor works'] as const;
const statusIcon = { ready: DoneIcon, signedOut: WarningIcon, unknown: QuestionIcon, disabled: StopIcon, missing: CloseIcon } as const;
const status = { ready: 'Ready', signedOut: 'Needs sign-in', unknown: 'Sign-in status unknown', disabled: 'Turned off in Settings', missing: 'Not installed' } as const;

/**
 * First-run guide: what Harbor is, which CLIs it found and whether they are signed in, the first project, and the
 * conversation modes. It only reads state and calls the CLI's own sign-in; it never calls a model.
 */
export function Onboarding({ state, finish }: { state: HarborState; finish: () => void }) {
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState(false);
  const { ready, text } = readinessSummary(state.clis, state.settings);
  const project = state.projects.find(p => p.id === state.projectId);
  async function busy(work: () => Promise<unknown>) { setPending(true); try { await work(); } finally { setPending(false); } }
  const last = step === steps.length - 1;
  const actions = <div className={n.wizardActions}>
    <button onClick={finish}>{last ? 'Close' : 'Skip the guide'}</button>
    <span>{step > 0 ? <button onClick={() => setStep(step - 1)}>Back</button> : null}
      <button className={s.primary} autoFocus onClick={() => last ? finish() : setStep(step + 1)}>{last ? (ready ? 'Start working' : 'Finish') : 'Next'}</button></span>
  </div>;
  // Not dismissible: Esc or a stray click must not end the guide; Skip and Close do that on purpose.
  return <Modal title={steps[step] === 'Welcome' ? 'Welcome to Harbor' : steps[step]} close={finish} dismissible={false} size="md" footer={actions}>
    <div className={n.wizard}>
      <ol className={n.steps} aria-label={`Step ${step + 1} of ${steps.length}`}>{steps.map((name, i) => <li key={name} data-done={i < step || undefined} data-current={i === step || undefined}>
        <span className={n.stepDot} aria-hidden="true">{i < step ? <DoneIcon size={14}/> : i + 1}</span>
        <span className={n.visuallyHidden}>{name}{i < step ? ' (done)' : i === step ? ' (current)' : ''}</span></li>)}</ol>
      <p className={n.stepCount} aria-hidden="true">Step {step + 1} of {steps.length}: {steps[step]}</p>
      {step === 0 ? <>
        <p>Harbor is a home for your projects. You talk to one assistant per conversation; Harbor sends the work to the AI command-line tools already installed on this computer (Claude Code, Codex and others), using their own sign-ins and subscriptions.</p>
        <p className={s.muted}>This guide takes a minute. Nothing here runs a model or uses your quota.</p>
      </> : step === 1 ? <>
        <p>{text}</p>
        <ul className={n.cliList} aria-label="Detected CLIs">{state.clis.map(cli => { const r = cliReadiness(cli, state.settings); const Icon = statusIcon[r]; return <li key={cli.id} className={n.cliRow}>
          <Icon size={20} className={n.cliIcon} data-state={r} aria-hidden="true"/>
          <span className={n.cliText}><strong>{cli.name}</strong><small>{status[r]}{cli.version ? ` · ${cli.version}` : ''}</small></span>
          {r === 'signedOut' ? <button disabled={pending} onClick={() => void busy(() => state.run(() => state.api.openLogin(cli.id)))}>Sign in to {cli.name}</button> : null}
        </li>; })}</ul>
        <p className={s.muted}>Signing in opens the tool's own window. You can change this later in Settings → Connections.</p>
        <div><button disabled={pending} onClick={() => void busy(state.refreshClis)}>{pending ? 'Checking…' : 'Check again'}</button></div>
      </> : step === 2 ? <>
        {project ? <p>Your project <strong>{project.name}</strong> is open. Add more any time from the + on the left or with Ctrl+K.</p>
          : <p>Choose a folder on this computer. Harbor works in that folder and in separate git worktrees for helpers; your files stay where they are.</p>}
        <div><button className={project ? undefined : s.primary} disabled={pending} onClick={() => void busy(() => state.addProject(undefined))}>{project ? 'Add another folder…' : 'Choose project folder…'}</button></div>
        {state.error ? <p className={s.error} role="alert">{state.error}</p> : null}
      </> : <>
        <dl className={n.modeList}>
          <dt>Default</dt><dd>A quick first answer; bigger work goes to a lead agent that can split it among helpers. Tools ask before risky actions.</dd>
          <dt>Plan</dt><dd>The lead only reads and replies with a numbered plan. Say “go ahead” to start.</dd>
          <dt>Goal</dt><dd>Harbor keeps going until the goal you describe is done, a question comes up, or you stop it.</dd>
          <dt>Auto</dt><dd>No permission prompts for this conversation. Use it only when you trust the task.</dd>
          <dt>/deep</dt><dd>Start a message with /deep to skip the quick answer and use a strong lead right away. Type / in the message box for more.</dd>
          <dt>Ctrl+K</dt><dd>Jump to any project, conversation, message or command.</dd>
        </dl>
      </>}
    </div>
  </Modal>;
}
