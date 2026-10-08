export type AppearanceMode = 'system' | 'light' | 'dark';
export type PaletteId = 'harbor' | 'ocean' | 'olive' | 'amber' | 'rose';
export type ColorScheme = 'light' | 'dark';
export interface Appearance { palette: PaletteId; mode: AppearanceMode }

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
    dark: ['#231c23', '#1d171e', '#302631', '#f3e9f1', '#ceb4c5', '#483849', '#e8b5ce', '#493042', '#331d2a', '#160f17', '#edd6e2', '#e8b5ce', '#34212d'] }
] as const;

export const appearanceKey = 'harbor.appearance.v1';
export const defaultAppearance: Appearance = { palette: 'harbor', mode: 'system' };
export function parseAppearance(value: string | null): Appearance {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    if (parsed && typeof parsed === 'object' && 'palette' in parsed && 'mode' in parsed &&
      palettes.some(p => p.id === parsed.palette) && ['system', 'light', 'dark'].includes(String(parsed.mode))) {
      return { palette: parsed.palette as PaletteId, mode: parsed.mode as AppearanceMode };
    }
  } catch { /* A damaged preference must not prevent the workspace from opening. */ }
  return defaultAppearance;
}
export function paletteTokens(id: PaletteId, scheme: ColorScheme, prefix = '--') {
  const palette = palettes.find(p => p.id === id) || palettes[0];
  const tokens: Record<string, string> = {};
  tokenNames.forEach((name, i) => { tokens[prefix + name] = palette[scheme][i]; });
  tokens[prefix + 'error'] = scheme === 'dark' ? '#ffb4ab' : '#a42828';
  return tokens;
}
