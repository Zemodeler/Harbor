import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { InlineConfirm } from '../components/ui/InlineConfirm';

describe('Modal', () => {
  it('names the dialog by its title, keeps the footer outside the body, and closes from the button', async () => {
    const close = vi.fn();
    render(<Modal title="Edit thing" close={close} footer={<button>Save</button>}><p>Body text</p></Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Edit thing' });
    expect(dialog).toContainElement(screen.getByText('Body text'));
    expect(screen.getByText('Body text').parentElement).not.toContainElement(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('closes on Esc and a backdrop click, but not when it is not dismissible', () => {
    const close = vi.fn();
    const { rerender } = render(<Modal title="T" close={close}>x</Modal>);
    const dialog = screen.getByRole('dialog');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    fireEvent.mouseDown(dialog); fireEvent.click(dialog);
    expect(close).toHaveBeenCalledTimes(2);
    rerender(<Modal title="T" close={close} dismissible={false}>x</Modal>);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    fireEvent.mouseDown(dialog); fireEvent.click(dialog);
    expect(close).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Close dialog' })).toBeNull();
  });
  it('does not treat a click that started inside the dialog as a backdrop click', () => {
    const close = vi.fn();
    render(<Modal title="T" close={close}><input aria-label="field"/></Modal>);
    fireEvent.mouseDown(screen.getByLabelText('field')); fireEvent.click(screen.getByRole('dialog'));
    expect(close).not.toHaveBeenCalled();
  });
  it('wraps focus with Tab and returns it to the opener', async () => {
    function Host() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>Open</button>{open ? <Modal title="T" close={() => setOpen(false)}><button>One</button></Modal> : null}</>; }
    render(<Host/>);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    screen.getByRole('button', { name: 'One' }).focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    vi.restoreAllMocks();
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(opener).toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  it('focuses the safe choice for a destructive confirm and shows pending state and errors', async () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    const { rerender } = render(<ConfirmDialog title="Delete it?" confirmLabel="Delete" tone="danger" onConfirm={onConfirm} onCancel={onCancel}>Gone forever.</ConfirmDialog>);
    expect(screen.getByRole('alertdialog', { name: 'Delete it?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalled();
    rerender(<ConfirmDialog title="Delete it?" confirmLabel="Delete" pendingLabel="Deleting…" tone="danger" pending error="Nope" onConfirm={onConfirm} onCancel={onCancel}>Gone forever.</ConfirmDialog>);
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Nope');
    expect(screen.queryByRole('button', { name: 'Close dialog' })).toBeNull();
  });
});

describe('InlineConfirm', () => {
  it('is a named group with a cancel and a confirm', async () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    render(<InlineConfirm label="Remove server" confirmLabel="Remove" onConfirm={onConfirm} onCancel={onCancel}>Remove it?</InlineConfirm>);
    const group = screen.getByRole('group', { name: 'Remove server' });
    await userEvent.click(group.querySelector('button:last-child')!);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).toHaveBeenCalled(); expect(onCancel).toHaveBeenCalled();
  });
});
