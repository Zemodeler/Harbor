import { useEffect, useLayoutEffect, useState } from 'react';
import { appearanceKey, defaultAppearance, parseAppearance, resolveTheme, themeTokens } from '../appearance';
import type { Appearance, ColorScheme } from '../appearance';

const DARK = '(prefers-color-scheme: dark)', MORE_CONTRAST = '(prefers-contrast: more)';
const media = (query: string) => window.matchMedia?.(query);

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try { return parseAppearance(window.localStorage.getItem(appearanceKey)); } catch { return defaultAppearance; }
  });
  const [systemDark, setSystemDark] = useState(() => media(DARK)?.matches ?? false);
  const [systemContrast, setSystemContrast] = useState(() => media(MORE_CONTRAST)?.matches ?? false);
  const [saveError, setSaveError] = useState(false);
  const theme = resolveTheme(appearance.mode, { dark: systemDark, moreContrast: systemContrast });
  const scheme: ColorScheme = theme.scheme;
  useEffect(() => {
    const dark = media(DARK), contrast = media(MORE_CONTRAST);
    const change = () => { setSystemDark(dark?.matches ?? false); setSystemContrast(contrast?.matches ?? false); };
    dark?.addEventListener('change', change);
    contrast?.addEventListener('change', change);
    const sync = (event: StorageEvent) => {
      if (event.key === appearanceKey || event.key === null) setAppearance(parseAppearance(event.newValue));
    };
    window.addEventListener('storage', sync);
    return () => { dark?.removeEventListener('change', change); contrast?.removeEventListener('change', change); window.removeEventListener('storage', sync); };
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.palette = appearance.palette;
    root.dataset.layout = appearance.layout;
    if (theme.contrast) root.dataset.contrast = 'more'; else delete root.dataset.contrast;
    root.style.colorScheme = scheme;
    for (const [name, value] of Object.entries(themeTokens(appearance.palette, theme))) root.style.setProperty(name, value);
  }, [appearance.palette, appearance.layout, scheme, theme.contrast]);
  function updateAppearance(patch: Partial<Appearance>) {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    try { window.localStorage.setItem(appearanceKey, JSON.stringify(next)); setSaveError(false); }
    catch { setSaveError(true); }
  }
  return { appearance, scheme, contrast: theme.contrast, updateAppearance, saveError };
}
export type AppearanceState = ReturnType<typeof useAppearance>;
