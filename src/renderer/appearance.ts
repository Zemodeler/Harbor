/** 'contrast' = high contrast; it follows the system's light or dark preference. */
export type AppearanceMode = 'system' | 'light' | 'dark' | 'contrast';
export type PaletteId = 'harbor' | 'ocean' | 'olive' | 'amber' | 'rose' | 'command' | 'porcelain' | 'graphite' | 'violet' | 'ice';
export type LayoutMode = 'command' | 'focus' | 'mission';
export type ColorScheme = 'light' | 'dark';
export interface Appearance { palette: PaletteId; mode: AppearanceMode; layout: LayoutMode }

export const layouts = [
  { id: 'command', name: 'Command Center', description: 'Conversation and live activity, side by side.', palette: 'command', mode: 'dark' },
  { id: 'focus', name: 'Focus Studio', description: 'A calm conversation with details on demand.', palette: 'porcelain', mode: 'light' },
  { id: 'mission', name: 'Mission Board', description: 'Every conversation organized by its live status.', palette: 'graphite', mode: 'dark' }
] as const;

// Surface, text, and navigation colors travel together so a palette is more than a button tint.
const tokenNames = ['bg', 'sidebar', 'surface', 'ink', 'muted', 'line', 'accent', 'wash', 'on-accent', 'rail', 'rail-ink', 'rail-accent', 'rail-on-accent'] as const;
export const palettes = [
  { id: 'harbor', name: 'Harbor', description: 'The original teal',
    light: ['#ffffff', '#f4f6f7', '#f6f8f9', '#152d35', '#526775', '#d9e1e6', '#086e70', '#e3f0ee', '#ffffff', '#0f2a2e', '#cfe3e1', '#91d0c4', '#0f2a2e'],
    dark: ['#171f23', '#131b1f', '#212b30', '#e8f0f3', '#abc0cb', '#35444c', '#91d0c4', '#223e38', '#102824', '#0a1215', '#cfe3e1', '#91d0c4', '#0f2a2e'] },
  { id: 'ocean', name: 'Ocean', description: 'Cool slate & blue',
    light: ['#ffffff', '#f1f4f8', '#f4f6fa', '#1c2c43', '#52647c', '#d6deea', '#275ea8', '#e7eef9', '#ffffff', '#15253e', '#d5e1f5', '#a9cafa', '#15253e'],
    dark: ['#181e29', '#131925', '#222c3b', '#e6edf8', '#adbed5', '#374459', '#a9cafa', '#263b58', '#142741', '#0e1420', '#d5e1f5', '#a9cafa', '#15253e'] },
  { id: 'olive', name: 'Olive', description: 'Soft stone & green',
    light: ['#fdfefb', '#f2f4ed', '#f5f6f1', '#293126', '#5b6754', '#d9dfd0', '#526b32', '#eaf0de', '#ffffff', '#252f1e', '#dfe8d0', '#bfd598', '#252f1e'],
    dark: ['#1c211b', '#171c16', '#282f24', '#edf1e6', '#bac7ac', '#3e4837', '#bfd598', '#34432a', '#202f13', '#11160f', '#dfe8d0', '#bfd598', '#252f1e'] },
  { id: 'amber', name: 'Amber', description: 'Warm graphite & gold',
    light: ['#fffefa', '#f6f3ec', '#f8f5ef', '#362e23', '#70614d', '#e3dccf', '#8b5b17', '#f6ecd8', '#ffffff', '#33291a', '#f0dfc1', '#e8c185', '#33291a'],
    dark: ['#24211d', '#1d1b17', '#302c26', '#f4eee4', '#cabca6', '#494137', '#e8c185', '#493824', '#30220e', '#15130f', '#f0dfc1', '#e8c185', '#33291a'] },
  { id: 'rose', name: 'Rose', description: 'Muted plum & pink',
    light: ['#fffdfd', '#f6f1f3', '#f8f4f6', '#382a34', '#725b6b', '#e3d7df', '#95506c', '#f4e7ed', '#ffffff', '#34212d', '#edd6e2', '#e8b5ce', '#34212d'],
    dark: ['#231c23', '#1d171e', '#302631', '#f3e9f1', '#ceb4c5', '#483849', '#e8b5ce', '#493042', '#331d2a', '#160f17', '#edd6e2', '#e8b5ce', '#34212d'] },
  { id: 'command', name: 'Command', description: 'Deep navy & electric cyan',
    light: ['#f8fbff', '#edf3fa', '#eaf1f8', '#14283e', '#40566c', '#cfdeeb', '#006580', '#dceef4', '#ffffff', '#0b1b30', '#d9e8fa', '#50d9f5', '#082134'],
    dark: ['#0b1523', '#101e30', '#15273b', '#ecf4ff', '#a9bed6', '#2b415a', '#50d9f5', '#193c50', '#082134', '#08111e', '#d9e8fa', '#50d9f5', '#082134'] },
  { id: 'porcelain', name: 'Porcelain', description: 'Cool white & precise blue',
    light: ['#ffffff', '#f3f6fc', '#edf2fa', '#14233e', '#445771', '#d7e1f0', '#075bd8', '#e4edff', '#ffffff', '#e8eef9', '#203656', '#075bd8', '#ffffff'],
    dark: ['#131c2b', '#172238', '#1e2c43', '#eff4ff', '#b3c4e0', '#344966', '#98bbff', '#273f63', '#112441', '#0e1728', '#d6e5ff', '#98bbff', '#112441'] },
  { id: 'graphite', name: 'Graphite', description: 'Charcoal & bright mint',
    light: ['#f9fcfb', '#eef4f1', '#e8f0ec', '#192e28', '#435f54', '#cfdfd7', '#006b49', '#dceee4', '#ffffff', '#14251e', '#d6eee2', '#6df0b4', '#102c21'],
    dark: ['#101a1c', '#142123', '#1b2b2d', '#f0f8f4', '#b2c9c2', '#324847', '#6df0b4', '#203d32', '#102c21', '#0b1417', '#d6eee2', '#6df0b4', '#102c21'] },
  { id: 'violet', name: 'Violet', description: 'Midnight plum & lavender',
    light: ['#fcfbff', '#f2eff9', '#ede8f5', '#30213f', '#605073', '#ddd4ea', '#6c3db3', '#ede1fc', '#ffffff', '#231632', '#e9ddfb', '#c4a4ff', '#27143f'],
    dark: ['#1a1425', '#20192e', '#2a213b', '#f5edff', '#c9b8e1', '#453653', '#c4a4ff', '#3c2c52', '#27143f', '#120e1b', '#e9ddfb', '#c4a4ff', '#27143f'] },
  { id: 'ice', name: 'Ice', description: 'Arctic slate & glacier blue',
    light: ['#f9fdff', '#edf5f8', '#e6f0f5', '#17333f', '#405f6e', '#cddfe6', '#086b83', '#dceef5', '#ffffff', '#18313f', '#d8edf5', '#8ddcf7', '#14333f'],
    dark: ['#111e28', '#142633', '#1d3140', '#edf9ff', '#b1cddd', '#34505f', '#8ddcf7', '#254354', '#14333f', '#0a1720', '#d8edf5', '#8ddcf7', '#14333f'] }
] as const;

export const appearanceKey = 'harbor.appearance.v1';
// A first start follows the system (light/dark and a high-contrast request) until the user picks a mode.
export const defaultAppearance: Appearance = { palette: 'command', mode: 'system', layout: 'command' };
export const appearanceModes = ['system', 'light', 'dark', 'contrast'] as const;
export function parseAppearance(value: string | null): Appearance {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    if (parsed && typeof parsed === 'object' && 'palette' in parsed && 'mode' in parsed &&
      palettes.some(p => p.id === parsed.palette) && (appearanceModes as readonly string[]).includes(String(parsed.mode))) {
      const layout = 'layout' in parsed && layouts.some(l => l.id === parsed.layout) ? parsed.layout as LayoutMode : 'command';
      return { palette: parsed.palette as PaletteId, mode: parsed.mode as AppearanceMode, layout };
    }
    // An unknown palette (e.g. from a newer version) keeps the rest of the choice.
    if (parsed && typeof parsed === 'object' && 'mode' in parsed && (appearanceModes as readonly string[]).includes(String(parsed.mode))) {
      const layout = 'layout' in parsed && layouts.some(l => l.id === parsed.layout) ? parsed.layout as LayoutMode : defaultAppearance.layout;
      return { ...defaultAppearance, mode: parsed.mode as AppearanceMode, layout };
    }
  } catch { /* A damaged preference must not prevent the workspace from opening. */ }
  return defaultAppearance;
}
export interface ResolvedTheme { scheme: ColorScheme; contrast: boolean }
/** What the window shows for a chosen mode and the system's current light/dark and contrast preferences. */
export function resolveTheme(mode: AppearanceMode, system: { dark: boolean; moreContrast: boolean }): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return { scheme: mode, contrast: false };
  const scheme: ColorScheme = system.dark ? 'dark' : 'light';
  return { scheme, contrast: mode === 'contrast' || system.moreContrast };
}
// High contrast replaces the palette: pure black/white surfaces, solid borders, one strong accent (WCAG AAA for text).
const contrastSets: Record<ColorScheme, string[]> = {
  light: ['#ffffff', '#ffffff', '#f2f2f2', '#000000', '#1a1a1a', '#000000', '#0000b8', '#e3e9ff', '#ffffff', '#000000', '#ffffff', '#ffffff', '#000000'],
  dark: ['#000000', '#000000', '#0d0d0d', '#ffffff', '#ebebeb', '#ffffff', '#ffd400', '#1f1f1f', '#000000', '#000000', '#ffffff', '#ffd400', '#000000']
};
export function contrastTokens(scheme: ColorScheme, prefix = '--') {
  const tokens: Record<string, string> = {};
  tokenNames.forEach((name, i) => { tokens[prefix + name] = contrastSets[scheme][i]; });
  tokens[prefix + 'error'] = scheme === 'dark' ? '#ff9d94' : '#9b0000';
  tokens[prefix + 'warning'] = scheme === 'dark' ? '#ffe066' : '#5c3900';
  tokens[prefix + 'success'] = scheme === 'dark' ? '#8cffbd' : '#00532a';
  return tokens;
}
export function themeTokens(id: PaletteId, theme: ResolvedTheme, prefix = '--') {
  return theme.contrast ? contrastTokens(theme.scheme, prefix) : paletteTokens(id, theme.scheme, prefix);
}
export function paletteTokens(id: PaletteId, scheme: ColorScheme, prefix = '--') {
  const palette = palettes.find(p => p.id === id) || palettes[0];
  const tokens: Record<string, string> = {};
  tokenNames.forEach((name, i) => { tokens[prefix + name] = palette[scheme][i]; });
  tokens[prefix + 'error'] = scheme === 'dark' ? '#ffb4ab' : '#a42828';
  tokens[prefix + 'warning'] = scheme === 'dark' ? '#ffd078' : '#805300';
  tokens[prefix + 'success'] = scheme === 'dark' ? '#85e5b0' : '#17613d';
  return tokens;
}
