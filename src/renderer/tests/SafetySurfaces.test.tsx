import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Conversation, HarborApi } from '../../shared/api';
import App from '../App';
import { DeadlineControl, fromLocalInput, toLocalInput } from '../components/DeadlineControl';
import { HelperStatus, helperFlags } from '../components/HelperStatus';
import { ModePicker } from '../components/ModePicker';
import { RoutingDetails } from '../components/RoutingDetails';
import { paceOf, UsageWindows } from '../components/UsageWindows';
import { createMockApi } from '../mock/mockApi';
import { seed } from '../mock/seed';

beforeEach(() => { localStorage.clear(); window.harbor = createMockApi({ delay: 0 }); });

const helper = (extra: Partial<Agent>): Agent => ({ id: 'h', projectId: 'store', role: 'implementer', title: 'Helper', state: 'working', cli: 'codex', model: 'default', effort: 'medium', ...extra });

describe('Helper status', () => {
  it('shows a loop stop distinctly from a user stop', () => {
    const looping = seed().agents.find(a => a.id === 'looping')!;
    render(<HelperStatus agent={looping}/>);
    expect(screen.getByText('Stopped: looping')).toBeInTheDocument();
    expect(screen.getByText(/kept repeating the same steps/)).toBeInTheDocument();
    expect(helperFlags(helper({ state: 'stopped', summary: 'Stopped by the user.' }))).toEqual([]);
  });
  it('prefers stopKind when the core sends it', () => {
    expect(helperFlags({ ...helper({ state: 'stopped', summary: 'Stopped by the user.' }), stopKind: 'loop' } as Agent).map(f => f.id)).toEqual(['loop']);
    expect(helperFlags({ ...helper({ state: 'stopped', summary: 'Harbor stopped this run: Spend ceiling reached: per request' }), stopKind: 'spend' } as Agent).map(f => f.id)).toEqual(['spend']);
    expect(helperFlags(helper({ state: 'stopped', summary: 'Harbor stopped this run: Spend ceiling reached: per request' })).map(f => f.id)).toEqual(['spend']);
    expect(helperFlags({ ...helper({ state: 'stopped', summary: 'going in circles' }), stopKind: 'user' } as Agent)).toEqual([]);
    expect(helperFlags(helper({ state: 'stopped', summary: 'Harbor stopped this run at its time limit. The lead decides.' })).map(f => f.id)).toEqual(['cap']);
  });
  it('tells waiting on the lead apart from waiting on you', () => {
    const { rerender } = render(<HelperStatus agent={helper({ state: 'waiting', summary: "Waiting for the lead's answer." })}/>);
    expect(screen.getByText('Waiting on the lead')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is needed from you/)).toBeInTheDocument();
    rerender(<HelperStatus agent={helper({ state: 'waiting', summary: 'Waiting for your answer.' })}/>);
    expect(screen.getByText('Waiting on you')).toBeInTheDocument();
  });
  it('flags possibly stuck, quota holds, and labels the time as an estimate', () => {
    render(<HelperStatus agent={helper({ summary: 'possibly stuck', estimatedMinutes: 12.4 })}/>);
    expect(screen.getByText('Possibly stuck')).toBeInTheDocument();
    expect(screen.getByText('about 12 min (estimate)')).toBeInTheDocument();
    expect(helperFlags(helper({ state: 'queued', summary: 'Waiting: too little quota is left above the reserve for this helper until about 14:00.' })).map(f => f.id)).toEqual(['quota']);
    expect(helperFlags(helper({ state: 'done', estimatedMinutes: 5 }))).toEqual([]);
  });
});

describe('Usage pace and calibration', () => {
  const now = Date.UTC(2026, 9, 14, 12);
  it('computes straight-line pace from the reading and its reset', () => {
    const p = paceOf({ cli: 'claude', label: 'w', usedPct: 70, period: 'weekly', resetsAt: now + 3.5 * 86400_000 }, now)!;
    expect(Math.round(p.budgetPct)).toBe(50);
    expect(Math.round(p.deltaPct)).toBe(20);
    expect(paceOf({ cli: 'claude', label: 'w', usedPct: 70, period: 'weekly' }, now)).toBeUndefined();
  });
  it('shows an uncalibrated estimate as approximate, without a gauge, and pace for readings', () => {
    render(<UsageWindows now={now} clis={[]} windows={[
      { cli: 'claude', label: 'Five', usedPct: 12, period: 'session', source: 'estimated', calibrated: false, resetsAt: now + 3600_000 },
      { cli: 'codex', label: 'Week', usedPct: 20, period: 'weekly', source: 'reported', resetsAt: now + 3.5 * 86400_000, projectedPct: 40 }
    ]}/>);
    const approx = document.querySelector('[data-approximate]') as HTMLElement;
    expect(within(approx).getByText('About 12% (approximate)')).toBeInTheDocument();
    expect(within(approx).getByText('Uncalibrated')).toBeInTheDocument();
    expect(within(approx).queryByRole('progressbar')).not.toBeInTheDocument();
    const week = screen.getByText('Week').closest('[data-source]') as HTMLElement;
    expect(within(week).getByRole('progressbar')).toBeInTheDocument();
    expect(week.querySelector('[data-pace]')).toHaveTextContent(/30 points under pace/);
    expect(week.querySelector('[data-pace]')).toHaveTextContent(/about 60% may go unused/);
  });
});

describe('Harbor checks approval', () => {
  it('lists the commands and explains the approval is remembered', async () => {
    await window.harbor.send('account', 'Please run the checks');
    render(<App/>); await screen.findByRole('heading', { name: 'Build the account page', level: 1 });
    const card = await screen.findByRole('article', { name: 'Run this project’s checks?' });
    const list = within(card).getByRole('list', { name: 'Commands Harbor would run' });
    expect(within(list).getByText('npm test')).toBeInTheDocument();
    expect(within(list).getByText('npm run typecheck')).toBeInTheDocument();
    expect(card).toHaveTextContent(/asks again only if the checks file changes/);
    expect(card).not.toHaveTextContent(/can only be allowed once/);
    await userEvent.click(within(card).getByRole('button', { name: 'Allow these checks' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Run this project’s checks?' })).not.toBeInTheDocument());
  });
});

async function settings(tab: string) {
  render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' });
  await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  await userEvent.click(await screen.findByRole('tab', { name: tab }));
}

describe('Routing fan-out settings', () => {
  it('saves helpers per turn clamped like Harbor, and names headroom as the default', async () => {
    await settings('Routing');
    await userEvent.type(await screen.findByLabelText('Helpers per lead turn'), '20{enter}');
    await waitFor(async () => expect((await window.harbor.getSettings()).maxHelpersPerTurn).toBe(12));
    await userEvent.type(screen.getByLabelText('Planners per lead turn'), '2{enter}');
    await waitFor(async () => expect((await window.harbor.getSettings()).maxPlannersPerTurn).toBe(2));
    expect(screen.getByRole('option', { name: 'Headroom: use the CLI with more room (default)' })).toBeInTheDocument();
  });
});

function DeadlineHarness({ api, id }: { api: HarborApi; id: string }) {
  const [c, setC] = useState<Conversation>();
  useEffect(() => {
    void api.listConversations('store').then(cs => setC(cs.find(x => x.id === id)));
    return api.onEvent(e => { if (e.type === 'conversation' && e.conversation.id === id) setC(e.conversation); });
  }, [api, id]);
  return c ? <DeadlineControl api={api} conversation={c}/> : null;
}

describe('Conversation deadline', () => {
  it('round-trips local time', () => {
    const t = new Date(2026, 9, 20, 17, 30).getTime();
    expect(fromLocalInput(toLocalInput(t))).toBe(t);
    expect(fromLocalInput('nonsense')).toBeUndefined();
  });
  it('sets, shows and clears a deadline', async () => {
    const api = createMockApi({ delay: 0 });
    render(<DeadlineHarness api={api} id="account"/>);
    const input = await screen.findByLabelText('Needed by');
    const when = new Date(Date.now() + 2 * 86400_000); when.setSeconds(0, 0);
    fireEvent.change(input, { target: { value: toLocalInput(when.getTime()) } });
    await userEvent.click(screen.getByRole('button', { name: 'Set deadline' }));
    await waitFor(async () => expect((await api.listConversations('store')).find(c => c.id === 'account')?.deadline).toBe(when.getTime()));
    expect(await screen.findByText(/^Needed by/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear deadline' }));
    await waitFor(async () => expect((await api.listConversations('store')).find(c => c.id === 'account')?.deadline).toBeUndefined());
  });
  it('refuses a time in the past and hides when the core has no such method', async () => {
    const api = createMockApi({ delay: 0 });
    const { unmount } = render(<DeadlineHarness api={api} id="account"/>);
    fireEvent.change(await screen.findByLabelText('Needed by'), { target: { value: toLocalInput(Date.now() - 3600_000) } });
    expect(screen.getByRole('button', { name: 'Set deadline' })).toBeDisabled();
    expect(screen.getByText('Pick a time in the future.')).toBeInTheDocument();
    unmount();
    delete api.setConversationDeadline;
    render(<DeadlineHarness api={api} id="account"/>);
    await waitFor(() => expect(screen.queryByLabelText('Needed by')).not.toBeInTheDocument());
  });
});

describe('Why this model', () => {
  const details = seed().messages.find(m => m.id === 'intro')!.details!;
  it('shows difficulty, review, the best candidates with estimates, and what was skipped', () => {
    render(<RoutingDetails details={details}/>);
    expect(screen.getByText('difficulty 6/10')).toBeInTheDocument();
    expect(screen.getByText('needs review')).toBeInTheDocument();
    expect(screen.getByText(/Review suggested: Touches a form/)).toBeInTheDocument();
    const candidates = document.querySelectorAll('[data-candidate]');
    expect(candidates).toHaveLength(3);
    expect(within(candidates[0] as HTMLElement).getByText('chosen')).toBeInTheDocument();
    expect(candidates[0]).toHaveTextContent('price ≈ 0.8% weekly (estimate)');
    expect(candidates[0]).toHaveTextContent(/tierFit \+22/);
    expect(candidates[0]).toHaveTextContent(/\[estimate\]/);
    expect(screen.getByText(/too little quota left above the reserve for this run · until about/)).toBeInTheDocument();
  });
  it('collapses a long reason behind a toggle', async () => {
    render(<RoutingDetails details={details}/>);
    const toggle = screen.getByRole('button', { name: 'Show full reasoning' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/No deadline set\./)).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/No deadline set\./)).toBeInTheDocument();
  });
});

describe('Auto mode confirmation focus', () => {
  it('returns focus to the Auto option when cancelled with Escape', async () => {
    const setMode = vi.fn(async () => undefined);
    render(<ModePicker conversation={{ id: 'c', projectId: 'p', title: 't', updated: 0, agentId: 'a' }} setMode={setMode}/>);
    await userEvent.click(screen.getByRole('radio', { name: 'Auto' }));
    expect(screen.getByRole('button', { name: 'Enable Auto mode' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Confirm Auto mode' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveFocus();
    expect(setMode).not.toHaveBeenCalled();
  });
});
