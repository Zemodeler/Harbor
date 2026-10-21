import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from '../components/ui/Tooltip';

describe('Tooltip', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('shows after a hover delay, hides on leave and on Esc, and does not rename the control', () => {
    render(<Tooltip text="Add project"><button aria-label="Add">+</button></Tooltip>);
    const button = screen.getByRole('button', { name: 'Add' });
    fireEvent.mouseOver(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Add project');
    fireEvent.mouseOut(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseOver(button); act(() => { vi.advanceTimersByTime(500); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('stays hidden for a disabled control or when switched off', () => {
    const { rerender } = render(<Tooltip text="x"><button disabled>Go</button></Tooltip>);
    fireEvent.mouseOver(screen.getByRole('button')); act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    rerender(<Tooltip text="x" disabled><button>Go</button></Tooltip>);
    fireEvent.mouseOver(screen.getByRole('button')); act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
