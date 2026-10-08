import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { appearanceKey, palettes, paletteTokens } from '../appearance';
import { createMockApi } from '../mock/mockApi';

beforeEach(() => {
  localStorage.clear();
  window.harbor = createMockApi({ delay: 0 });
});
async function openAppearance() {
  await userEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
  await userEvent.click(await screen.findByRole('tab', { name: 'Appearance' }));
}

describe('Workspace appearance', () => {
  it('applies a palette immediately and restores it with the selected mode on reopening', async () => {
    const view = render(<App/>);
    await openAppearance();
    await userEvent.click(screen.getByRole('radio', { name: 'Ocean' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(paletteTokens('ocean', 'dark')['--accent']);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    view.unmount(); render(<App/>); await openAppearance();
    expect(screen.getByRole('radio', { name: 'Ocean' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  });
  it('recovers from invalid saved preferences and supports keyboard palette selection', async () => {
    localStorage.setItem(appearanceKey, '{"palette":"missing","mode":"dark"}');
    render(<App/>); await openAppearance();
    const harbor = screen.getByRole('radio', { name: 'Harbor' });
    expect(harbor).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Use system' })).toBeChecked();
    harbor.focus(); await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Ocean' })).toBeChecked();
  });
  it('follows live system appearance changes while respecting an explicit mode', async () => {
    const listeners = new Set<() => void>();
    const media = { matches: false, addEventListener: (_: string, cb: () => void) => listeners.add(cb), removeEventListener: (_: string, cb: () => void) => listeners.delete(cb) };
    vi.stubGlobal('matchMedia', () => media);
    try {
      render(<App/>); await openAppearance();
      act(() => { media.matches = true; listeners.forEach(cb => cb()); });
      expect(document.documentElement.style.colorScheme).toBe('dark');
      await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
      act(() => listeners.forEach(cb => cb()));
      expect(document.documentElement.style.colorScheme).toBe('light');
    } finally { vi.unstubAllGlobals(); }
  });
  it('keeps the palette usable and explains when saving is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    render(<App/>); await openAppearance();
    await userEvent.click(screen.getByRole('radio', { name: 'Rose' }));
    expect(screen.getByRole('radio', { name: 'Rose' })).toBeChecked();
    expect(screen.getByText(/Applied for this session/)).toBeInTheDocument();
  });
});

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + .05) / (low + .05);
}
it('keeps text and primary controls readable in every palette and appearance', () => {
  for (const palette of palettes) for (const scheme of ['light', 'dark'] as const) {
    const t = paletteTokens(palette.id, scheme);
    for (const surface of ['bg', 'sidebar', 'surface', 'wash']) {
      for (const text of ['ink', 'muted']) expect(contrast(t[`--${surface}`], t[`--${text}`]), `${palette.name} ${scheme}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t['--accent'], t['--on-accent']), `${palette.name} ${scheme}: primary button`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--rail'], t['--rail-ink'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--rail-accent'], t['--rail-on-accent'])).toBeGreaterThanOrEqual(4.5);
  }
});
