import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Conversation, HarborApi } from '../../shared/api';
import App from '../App';
import { HelperDetails } from '../components/HelperDetails';
import { IntegrateAction, MergeSessionAction } from '../components/IntegrationPanel';
import { ReadyToApplyPrompt, readyToApply } from '../components/ReadyToApply';
import { ModePicker } from '../components/ModePicker';
import { ToolRules } from '../components/ToolRules';
import { UsageWindows } from '../components/UsageWindows';
import type { HarborState } from '../hooks/useHarbor';
import { createMockApi } from '../mock/mockApi';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });

/** Renders one helper card against a live mock API: events update the card like the app's state does. */
function Card({ api, id, projectId = 'store' }: { api: HarborApi; id: string; projectId?: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(() => {
    void api.listAgents(projectId).then(setAgents);
    return api.onEvent(e => { if (e.type === 'agent') setAgents(as => [...as.filter(a => a.id !== e.agent.id), e.agent]); });
  }, [api, projectId]);
  const agent = agents.find(a => a.id === id);
  const state = { api, agents, openAgent: vi.fn(), projectId } as unknown as HarborState;
  return agent ? <HelperDetails state={state} agent={agent}/> : <p>loading</p>;
}
const card = async (id: string, api = createMockApi({ delay: 0 })) => { render(<Card api={api} id={id}/>); await waitFor(() => expect(document.querySelector(`[data-helper-details="${id}"]`)).toBeInTheDocument()); return api; };
async function settings(tab: string) {
  render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' });
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await userEvent.click(await screen.findByRole('tab', { name: tab }));
}

describe('Auto mode confirmation', () => {
  const conversation = { id: 'c', projectId: 'p', title: 't', updated: 0, agentId: 'a' } as Conversation;
  it('asks first, states what changes, and only then enables', async () => {
    const setMode = vi.fn(async () => undefined);
    render(<ModePicker conversation={conversation} setMode={setMode}/>);
    await userEvent.click(screen.getByRole('radio', { name: 'Auto' }));
    const confirm = screen.getByRole('group', { name: 'Confirm Auto mode' });
    expect(confirm).toHaveTextContent(/Permission prompts are off for the lead and for edit helpers/);
    expect(confirm).toHaveTextContent(/Reviewers stay read-only/);
    expect(setMode).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Confirm Auto mode' })).not.toBeInTheDocument();
    expect(setMode).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('radio', { name: 'Auto' }));
    await userEvent.click(screen.getByRole('button', { name: 'Enable Auto mode' }));
    expect(setMode).toHaveBeenCalledWith('auto');
  });
  it('does not ask again to leave Auto', async () => {
    const setMode = vi.fn(async () => undefined);
    render(<ModePicker conversation={{ ...conversation, mode: 'auto' }} setMode={setMode}/>);
    await userEvent.click(screen.getByRole('radio', { name: 'Default' }));
    expect(setMode).toHaveBeenCalledWith('default');
  });
});

describe('Usage honesty', () => {
  it('labels the source of every window and never presents an estimate as the provider quota', async () => {
    const api = createMockApi({ delay: 0 });
    render(<UsageWindows windows={await api.getUsage()} clis={await api.listClis()}/>);
    const windows = screen.getAllByText(/% used/).map(el => el.closest('[data-source]') as HTMLElement);
    expect(windows.map(w => w.dataset.source)).toEqual(['estimated', 'reported', 'reported']);
    expect(within(windows[0]).getByText('Estimated from Harbor runs only')).toBeInTheDocument();
    expect(within(windows[0]).getByText('38% used (estimate)')).toBeInTheDocument();
    expect(within(windows[0]).getByText('5-hour session')).toBeInTheDocument();
    expect(windows[0]).toHaveTextContent('Projected 64% by the reset');
    expect(windows[0]).toHaveTextContent(/Resets /);
    expect(within(windows[1]).getByText('Reported by Claude Code')).toBeInTheDocument();
    expect(within(windows[1]).getByText('Weekly')).toBeInTheDocument();
  });
  it('treats a window without a source as an estimate', () => {
    render(<UsageWindows windows={[{ cli: 'codex', label: 'Window', usedPct: 10 }]} clis={[]}/>);
    expect(screen.getByText('Estimated from Harbor runs only')).toBeInTheDocument();
    expect(screen.getByText('Reset time unknown')).toBeInTheDocument();
  });
});

describe('Helper outcome and checks', () => {
  it('separates what Harbor ran from what the helper claims, with exit codes and the tested commit', async () => {
    await card('implement');
    const box = await screen.findByLabelText('Results for Implement account page');
    expect(box).toHaveTextContent('Outcome: Partial');
    expect(box).toHaveTextContent(/Checks run by Harbor\s*on c3a9e1f/);
    expect(box).toHaveTextContent('exit code 2');
    expect(box).toHaveTextContent('timed out');
    expect(box).toHaveTextContent(/Reported by the helper/);
    expect(box).toHaveTextContent('says pass');
    expect(box).not.toHaveTextContent('outdated');
  });
  it('shows a reviewer verdict with its commit, and marks it outdated', async () => {
    await card('verify');
    const box = await screen.findByLabelText('Results for Verify account flow');
    expect(box).toHaveTextContent(/Approve\s*@ a0b1c2d/);
    expect(within(box).getByText('outdated')).toBeInTheDocument();
  });
  it('shows changes requested and NO VERDICT for a reviewer that ended without one', async () => {
    await card('verify-c');
    expect(await screen.findByText(/Changes requested/)).toBeInTheDocument();
    await card('verify-b');
    expect(await screen.findByText('NO VERDICT')).toBeInTheDocument();
  });
});

describe('Queue controls and resume', () => {
  it('pauses, resumes, raises priority and cancels a queued agent', async () => {
    const api = await card('queued-1');
    const controls = await screen.findByLabelText('Queue controls for Index product titles');
    await userEvent.click(within(controls).getByRole('button', { name: 'Pause' }));
    expect(await within(controls).findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(within(controls).getByText('Paused')).toBeInTheDocument();
    await userEvent.click(within(controls).getByRole('button', { name: 'Resume' }));
    await within(controls).findByRole('button', { name: 'Pause' });
    expect(within(controls).getByRole('button', { name: 'Do this next' })).toBeDisabled();   // already first in the queue
    await userEvent.click(within(controls).getByRole('button', { name: 'Cancel Index product titles' }));
    await waitFor(async () => expect((await api.listAgents('store')).find(a => a.id === 'queued-1')?.state).toBe('stopped'));
  });
  it('puts a paused agent after others with "Do this next" only when it is not already first', async () => {
    const api = await card('queued-2');
    await userEvent.click(await screen.findByRole('button', { name: 'Do this next' }));
    await waitFor(async () => expect((await api.listAgents('store')).find(a => a.id === 'queued-2')?.priority).toBe(2));
  });
  it('shows the error and suggests a message when a stopped helper cannot resume', async () => {
    await card('stopped-helper');
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('no saved session');
    expect(alert).toHaveTextContent('Send a message');
  });
});

describe('Integration', () => {
  it('shows the integrator, source states, checks and only offers Apply when done and not applied', async () => {
    await card('integrate-1');
    const box = await screen.findByLabelText('Integration Integrate account work');
    expect(box).toHaveTextContent('Target: main');
    expect(box).toHaveTextContent(/base a1b2c3d/);
    expect(box).toHaveTextContent(/head e1f2a3b/);
    expect(within(box).getByText('merged')).toBeInTheDocument();
    expect(within(box).getByText('not merged')).toBeInTheDocument();
    expect(box).toHaveTextContent('Checks run by Harbor');
    await userEvent.click(within(box).getByRole('button', { name: 'Apply to main' }));
    expect(await within(box).findByText('Applied to main.')).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: /Apply to/ })).not.toBeInTheDocument();
  });
  it('lists conflicting paths and offers no Apply for a failed integration', async () => {
    await card('integrate-2');
    const box = await screen.findByLabelText('Integration Integrate checkout fixes');
    expect(within(box).getByText('conflict')).toBeInTheDocument();
    expect(within(box).getAllByText('src/checkout.tsx').length).toBeGreaterThan(0);
    expect(within(box).queryByRole('button', { name: /Apply to/ })).not.toBeInTheDocument();
  });
  it('lists changed files and hides credential files', async () => {
    await card('implement');
    await userEvent.click(await screen.findByRole('button', { name: 'Show changed files' }));
    const list = await screen.findByRole('list', { name: 'Files changed by Implement account page' });
    expect(within(list).getByText('src/account.tsx')).toBeInTheDocument();
    expect(within(list).getByText(/\.env\.local \(hidden: credentials\)/)).toBeInTheDocument();
  });
  it('shows the rejection inline when Integrate is refused', async () => {
    const api = createMockApi({ delay: 0 });
    const helpers = (await api.listAgents('store')).filter(a => a.id === 'implement');
    render(<IntegrateAction api={api} projectId="store" helpers={helpers}/>);
    await userEvent.click(screen.getByText('Integrate branches'));
    await userEvent.click(screen.getByRole('checkbox', { name: /Implement account page/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Integrate 1 helper/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no current reviewer approval');
  });
});

describe('Ready to apply prompt', () => {
  const base = { projectId: 'store', role: 'other', state: 'done', cli: 'harbor', model: 'git', effort: 'low' } as const;
  const helper: Agent = { ...base, id: 'h1', title: 'Write the form', role: 'implementer' };
  const integrator: Agent = { ...base, id: 'i1', title: 'Integrate "Write the form"', integration: { target: 'master', head: 'abcdef0123456789', sources: [{ agentId: 'h1', state: 'merged' }] } };
  it('pops up for a finished integration and applies with one click', async () => {
    const applyIntegration = vi.fn(async () => integrator);
    render(<ReadyToApplyPrompt api={{ applyIntegration } as unknown as HarborApi} agents={[helper, integrator]} projectId="store"/>);
    const dialog = await screen.findByRole('dialog', { name: 'Ready to apply' });
    expect(dialog).toHaveTextContent('master');
    expect(dialog).toHaveTextContent('Write the form');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to master' }));
    expect(applyIntegration).toHaveBeenCalledWith('i1');
  });
  it('goes away on Later', async () => {
    render(<ReadyToApplyPrompt api={{} as HarborApi} agents={[helper, integrator]} projectId="store"/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('stays quiet for work that is applied, unfinished, conflicting or in another project', () => {
    const int = integrator.integration!;
    expect(readyToApply({ ...integrator, integration: { ...int, applied: true } })).toBe(false);
    expect(readyToApply({ ...integrator, state: 'working' })).toBe(false);
    expect(readyToApply({ ...integrator, integration: { ...int, sources: [{ agentId: 'h1', state: 'conflict' }] } })).toBe(false);
    const { container } = render(<ReadyToApplyPrompt api={{} as HarborApi} agents={[integrator]} projectId="other"/>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Merge session', () => {
  it("shows a worktree session's branch and merges it, then says nothing is left to merge", async () => {
    const api = createMockApi({ delay: 0 });
    const conversation = (await api.listConversations('store')).find(c => c.id === 'checkout')!;
    render(<MergeSessionAction api={api} conversation={conversation} working={false}/>);
    expect(screen.getByLabelText('Session branch')).toHaveTextContent('harbor/session-polish-the-checkout');
    await userEvent.click(screen.getByRole('button', { name: 'Merge into your branch' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/main fast-forwarded/);
    await userEvent.click(screen.getByRole('button', { name: 'Merge into your branch' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Nothing to merge/);
  });
  it('waits for the lead, and renders nothing for a session in the project folder', async () => {
    const api = createMockApi({ delay: 0 });
    const [plain, isolated] = [(await api.listConversations('store')).find(c => c.id === 'account')!, (await api.listConversations('store')).find(c => c.id === 'checkout')!];
    const { container, rerender } = render(<MergeSessionAction api={api} conversation={plain} working={false}/>);
    expect(container).toBeEmptyDOMElement();
    rerender(<MergeSessionAction api={api} conversation={isolated} working/>);
    expect(screen.getByRole('button', { name: 'Merge into your branch' })).toBeDisabled();
  });
});

describe('Rollback', () => {
  it('previews a clean rollback, then queues it', async () => {
    await card('implement');
    await userEvent.click(await screen.findByRole('button', { name: 'Preview rollback' }));
    const dialog = await screen.findByRole('dialog', { name: /Preview rollback/ });
    expect(await within(dialog).findByText('Reverts cleanly')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/Preview only/);
    expect(dialog).toHaveTextContent(/9f8e7d6|a1b2c3d/);
    expect(dialog).toHaveTextContent('Verify account flow');
    expect(dialog).toHaveTextContent(/external effects/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    expect(await within(dialog).findByText(/Rollback queued as/)).toBeInTheDocument();
  });
  it('shows conflicts and later commits for a conflicting rollback', async () => {
    await card('integrate-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Preview rollback' }));
    const dialog = await screen.findByRole('dialog', { name: /Preview rollback/ });
    expect(await within(dialog).findByText('Conflicts')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Add account page form');
    expect(dialog).toHaveTextContent('later work on the same files');
  });
  it('disables Roll back while blockers exist and says it could not be simulated', async () => {
    await card('stopped-helper');
    await userEvent.click(await screen.findByRole('button', { name: 'Preview rollback' }));
    const dialog = await screen.findByRole('dialog', { name: /Preview rollback/ });
    expect(await within(dialog).findByText('Could not be simulated')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Blockers');
    expect(within(dialog).getByRole('button', { name: 'Roll back' })).toBeDisabled();
  });
  it('shows the rollback card with per-merge state, outdated, and the Apply error as is', async () => {
    await card('rollback-1');
    const box = await screen.findByLabelText('Rollback Roll back Implement account page');
    expect(within(box).getByText('reverted')).toBeInTheDocument();
    expect(within(box).getByText('pending')).toBeInTheDocument();
    expect(within(box).getAllByText('outdated').length).toBeGreaterThan(0);
    await userEvent.click(within(box).getByRole('button', { name: 'Apply to main' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent('The project folder has uncommitted changes.');
  });
});

describe('Always-allowed tools', () => {
  it('lists rules with their label and removes one', async () => {
    const api = createMockApi({ delay: 0 });
    render(<ToolRules api={api} projectId="harbor"/>);
    expect(await screen.findByText('Bash(npm test ...)')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Bash(npm test ...)' }));
    await waitFor(() => expect(screen.queryByText('Bash(npm test ...)')).not.toBeInTheDocument());
    expect(await api.listToolRules('harbor')).toHaveLength(1);
  });
  it('says so when there are none', async () => {
    render(<ToolRules api={createMockApi({ delay: 0 })} projectId="store"/>);
    expect(await screen.findByText(/No tools are always allowed/)).toBeInTheDocument();
  });
});

describe('Routing settings', () => {
  it('saves a global concurrency limit and shows the value Harbor clamped it to', async () => {
    await settings('Routing');
    const input = await screen.findByLabelText('Concurrency limit');
    await userEvent.type(input, '12{enter}');
    await waitFor(async () => expect((await window.harbor.getSettings()).concurrencyLimit).toBe(8));
    await waitFor(() => expect(screen.getByLabelText('Concurrency limit')).toHaveValue(8));
  });
  it('shows the rejection text next to the field', async () => {
    const api = window.harbor;
    api.setSettings = vi.fn(async () => { throw new Error("Error invoking remote method 'settings:set': Error: effortPolicy must be one of: adaptive, conserve, quality."); });
    await settings('Routing');
    await userEvent.selectOptions(await screen.findByLabelText('Effort policy'), 'conserve');
    expect(await screen.findByRole('alert')).toHaveTextContent('effortPolicy must be one of: adaptive, conserve, quality.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error invoking');
  });
  it('picks allowed models and a role preference', async () => {
    await settings('Routing');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'gpt-5-codex' }));
    await waitFor(async () => expect((await window.harbor.getSettings()).allowedModels).toEqual({ codex: ['gpt-5-codex'] }));
    await userEvent.selectOptions(screen.getByLabelText('Reviewer CLI'), 'claude');
    await waitFor(async () => expect((await window.harbor.getSettings()).rolePreferences).toEqual({ reviewer: { cli: 'claude' } }));
  });
  it('saves the background switch', async () => {
    await settings('Routing');
    await userEvent.click(await screen.findByRole('checkbox', { name: /Keep Harbor running in the background/ }));
    await waitFor(async () => expect((await window.harbor.getSettings()).keepRunningInBackground).toBe(true));
    expect(screen.queryByRole('checkbox', { name: /Download updates automatically/ })).not.toBeInTheDocument();   // not in the contract yet
  });
  it('overrides per project and clears them with "Reset all to global"', async () => {
    await settings('Project');
    await userEvent.selectOptions(await screen.findByLabelText('Effort policy'), 'quality');
    await waitFor(async () => expect((await window.harbor.getSettings()).projectOverrides).toEqual({ store: { effortPolicy: 'quality' } }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset all to global' }));
    await waitFor(async () => expect((await window.harbor.getSettings()).projectOverrides).toBeUndefined());
  });
  it('lists the project tool rules in the Project tab', async () => {
    await settings('Project');
    expect(await screen.findByText(/No tools are always allowed/)).toBeInTheDocument();
  });
});

describe('Diagnostics', () => {
  it('exports the text, copies it and saves it through a Blob', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { created.push(b as Blob); return 'blob:diag'; });
    URL.revokeObjectURL = vi.fn();
    const clip = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await settings('Diagnostics');
    await userEvent.click(await screen.findByRole('button', { name: 'Export diagnostics' }));
    const box = await screen.findByLabelText('Diagnostics text');
    expect((box as HTMLTextAreaElement).value).toContain('Harbor diagnostics (demo)');
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(clip).toHaveBeenCalledWith(expect.stringContaining('Harbor diagnostics')));
    await userEvent.click(screen.getByRole('button', { name: 'Save as file' }));
    expect(click).toHaveBeenCalled();
    expect(created).toHaveLength(1);
    expect(created[0].size).toBeGreaterThan(0);
    expect(created[0].type).toContain('text/plain');
  });
  it('hides the tab when the API has no exportDiagnostics', async () => {
    const api = createMockApi({ delay: 0 }); delete api.exportDiagnostics; window.harbor = api;
    await settings('Connections');
    expect(screen.queryByRole('tab', { name: 'Diagnostics' })).not.toBeInTheDocument();
  });
});
