import { useEffect, useLayoutEffect, useState } from 'react';
import { appearanceKey, defaultAppearance, paletteTokens, parseAppearance } from '../appearance';
import type { Appearance, ColorScheme } from '../appearance';

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try { return parseAppearance(window.localStorage.getItem(appearanceKey)); } catch { return defaultAppearance; }
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const [saveError, setSaveError] = useState(false);
  const scheme: ColorScheme = appearance.mode === 'system' ? systemDark ? 'dark' : 'light' : appearance.mode;
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media?.matches ?? false);
    media?.addEventListener('change', change);
    const sync = (event: StorageEvent) => {
      if (event.key === appearanceKey || event.key === null) setAppearance(parseAppearance(event.newValue));
    };
    window.addEventListener('storage', sync);
    return () => { media?.removeEventListener('change', change); window.removeEventListener('storage', sync); };
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.palette = appearance.palette;
    root.dataset.layout = appearance.layout;
    root.style.colorScheme = scheme;
    for (const [name, value] of Object.entries(paletteTokens(appearance.palette, scheme))) root.style.setProperty(name, value);
  }, [appearance.palette, appearance.layout, scheme]);
  function updateAppearance(patch: Partial<Appearance>) {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    try { window.localStorage.setItem(appearanceKey, JSON.stringify(next)); setSaveError(false); }
    catch { setSaveError(true); }
  }
  return { appearance, scheme, updateAppearance, saveError };
}
export type AppearanceState = ReturnType<typeof useAppearance>;
