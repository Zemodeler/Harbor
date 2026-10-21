/**
 * Which of the app's overlays is on screen. `showModal()` stacks native dialogs, so two open at once would trap focus
 * in the wrong one; instead only the highest-priority open one renders and the others wait their turn (a lower one
 * appears again when the one above it closes). Order matters: a rename or the palette is something the user just
 * asked for, whereas the welcome guide and the ready-to-apply prompt are interruptions that must never cover them.
 */
export const DIALOG_ORDER = ['rename', 'palette', 'create', 'tags', 'menu', 'viewer', 'panel', 'welcome', 'ready'] as const;
export type DialogId = (typeof DIALOG_ORDER)[number];

export function topDialog(open: Partial<Record<DialogId, boolean>>): DialogId | undefined {
  return DIALOG_ORDER.find(id => open[id]);
}
