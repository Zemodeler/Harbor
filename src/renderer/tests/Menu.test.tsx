import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from '../components/ui/Menu';

function setup() {
  const pick = vi.fn();
  const items: MenuItem[] = [
    { key: 'a', label: 'Alpha', onSelect: () => pick('a') },
    { key: 'b', label: 'Beta', onSelect: () => pick('b') },
    { key: 's', separator: true },
    { key: 'c', label: 'Charlie', onSelect: () => pick('c'), disabled: true, reason: 'Not now' },
    { key: 'd', label: 'Delete', danger: true, onSelect: () => pick('d') },
  ];
  render(<div><Menu label="Options" trigger="more" items={items}/><button>outside</button></div>);
  return { pick, trigger: screen.getByRole('button', { name: 'Options' }) };
}

describe('Menu', () => {
  it('opens with menu roles, focuses the first item and shows a separator and the disabled reason', async () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Charlie/ })).toBeDisabled();
    expect(screen.getByText('Not now')).toBeVisible();
  });
  it('moves with arrows, Home and End, skipping disabled items and wrapping', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  });
  it('jumps to an item by typing its first letters', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    await userEvent.keyboard('de');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  });
  it('selects with Enter, closes and returns focus to the trigger', async () => {
    const { trigger, pick } = setup();
    await userEvent.click(trigger);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(pick).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('does not run a disabled item', async () => {
    const { trigger, pick } = setup();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitem', { name: /Charlie/ }));
    expect(pick).not.toHaveBeenCalled();
  });
  it('closes on Escape with focus back on the trigger, and on an outside click without stealing focus', async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus();
  });
  it('opens from the keyboard with ArrowDown on the trigger', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
  });
});
