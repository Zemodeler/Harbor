import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toasts } from '../components/Toasts';
import type { ToastState } from '../hooks/useToasts';
import { MAX_VISIBLE_TOASTS, remainingMs, toastLive, toastRole, visibleToasts, type Toast } from '../toasts';

const mk = (id: string, kind: Toast['kind'], extra: Partial<Toast> = {}): Toast => ({ id, kind, title: kind, body: `body ${id}`, conversationId: `c${id}`, time: 1, ...extra });
const state = (toasts: Toast[], over: Partial<ToastState> = {}): ToastState => ({ toasts, leaving: [], dismiss: vi.fn(), open: vi.fn(async () => {}), pause: vi.fn(), resume: vi.fn(), ...over } as ToastState);

afterEach(() => vi.restoreAllMocks());

describe('toast helpers (pure)', () => {
  it('maps kinds to live-region roles', () => {
    expect(toastRole('failed')).toBe('alert');
    expect(toastRole('question')).toBe('status');
    expect(toastLive('question')).toBe('assertive');
    expect(toastRole('finished')).toBe('status');
  });
  it('caps visible toasts and keeps questions and failures over finished ones, in original order', () => {
    const list = [mk('1', 'question'), mk('2', 'finished'), mk('3', 'finished'), mk('4', 'failed')];
    const { shown, hidden } = visibleToasts(list);
    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(hidden).toBe(1);
    expect(shown.map(t => t.id)).toEqual(['1', '3', '4']);
    expect(visibleToasts(list.slice(0, 3))).toEqual({ shown: list.slice(0, 3), hidden: 0 });
  });
  it('computes the time left after a pause with a floor', () => {
    expect(remainingMs(10000, 1000, 4000)).toBe(7000);
    expect(remainingMs(10000, 0, 9900)).toBe(1500);
  });
});

describe('Toasts component', () => {
  it('names the region and buttons, with an alert for failures and a status for finished', () => {
    render(<Toasts toasts={state([mk('1', 'failed'), mk('2', 'finished')])} />);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(within(region).getByRole('alert')).toHaveTextContent('body 1');
    expect(within(region).getByRole('status')).toHaveTextContent('body 2');
    expect(within(region).getByRole('button', { name: 'Open conversation: body 2' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Dismiss notification: failed' })).toBeInTheDocument();
  });
  it('labels a question with Answer and dismisses through the corner button', async () => {
    const s = state([mk('q', 'question')]);
    render(<Toasts toasts={s} />);
    expect(screen.getByRole('button', { name: 'Answer: body q' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification: question' }));
    expect(s.dismiss).toHaveBeenCalledWith('q');
  });
  it('shows at most three toasts and a +N more line', () => {
    render(<Toasts toasts={state([mk('1', 'finished'), mk('2', 'finished'), mk('3', 'finished'), mk('4', 'finished')])} />);
    expect(screen.getAllByRole('status')).toHaveLength(3);
    expect(screen.getByText('+1 more')).toBeInTheDocument();
  });
  it('marks a leaving toast and pauses on hover and focus-within, resuming after', async () => {
    const s = state([mk('1', 'finished')], { leaving: ['1'] });
    render(<Toasts toasts={s} />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('data-leaving');
    await userEvent.hover(toast);
    expect(s.pause).toHaveBeenCalledWith('1');
    await userEvent.unhover(toast);
    expect(s.resume).toHaveBeenCalledWith('1');
    vi.mocked(s.pause).mockClear(); vi.mocked(s.resume).mockClear();
    await userEvent.tab();
    expect(s.pause).toHaveBeenCalledWith('1');
    await act(async () => { (document.activeElement as HTMLElement).blur(); });
    expect(s.resume).toHaveBeenCalledWith('1');
  });
  it('shows the region as a popover when the platform supports it', () => {
    const show = vi.fn();
    (HTMLElement.prototype as unknown as { showPopover: () => void }).showPopover = show;
    try {
      render(<Toasts toasts={state([mk('1', 'finished')])} />);
      expect(show).toHaveBeenCalled();
      expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('popover', 'manual');
    } finally { delete (HTMLElement.prototype as unknown as { showPopover?: () => void }).showPopover; }
  });
});
