import type { Mod, Skill } from '../shared/api';

/**
 * Chat commands Harbor answers itself, without starting an agent: `/skills` and `/mods`. Pure text in, text out; the service does the
 * work (it owns the skills library and the mod switch) and the orchestrator posts the reply.
 */
export interface ChatCommand { name: string; args: string }

/** `/name rest...` at the very start of a message; anything else is not a command. */
export function parseChatCommand(text: string): ChatCommand | undefined {
  const m = /^\/([A-Za-z][\w:-]{0,80})(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : undefined;
}

export type Pick<T> = { item: T } | { none: true } | { many: T[] };

/** One item by exact id, then exact name, then a unique prefix of the name (all case-insensitive). */
export function pickByName<T>(items: T[], q: string, id: (t: T) => string, name: (t: T) => string): Pick<T> {
  const l = q.trim().toLowerCase();
  if (!l) return { none: true };
  const byId = items.filter((i) => id(i).toLowerCase() === l);
  if (byId.length === 1) return { item: byId[0]! };
  const exact = items.filter((i) => name(i).toLowerCase() === l);
  if (exact.length === 1) return { item: exact[0]! };
  const pool = exact.length ? exact : items.filter((i) => name(i).toLowerCase().startsWith(l));
  return pool.length === 1 ? { item: pool[0]! } : pool.length ? { many: pool } : { none: true };
}

const MAX_LINES = 40;
const mark = (on: boolean) => (on ? '[on] ' : '[off]');

export function skillsText(skills: Skill[]): string {
  if (!skills.length) return 'No skills found. Add some under Skills, or enable a mod that ships them (/mods).';
  const usable = skills.filter((s) => !s.problems?.length);
  const lines = usable.slice(0, MAX_LINES).map((s) => `${mark(s.enabled)} ${s.name} (${s.id})${s.enabled === s.defaultEnabled ? '' : ' - set for this project'}`);
  const more = usable.length - lines.length;
  return [`Skills for this project (${usable.filter((s) => s.enabled).length} on of ${usable.length}):`, ...lines, ...(more > 0 ? [`...and ${more} more.`] : []),
    'Change one: /skills on <name>, /skills off <name>, /skills reset <name> (back to the default).'].join('\n');
}

export function modsText(mods: Mod[]): string {
  if (!mods.length) return 'No mods (Claude Code plugins) found on this machine.';
  const lines = mods.slice(0, MAX_LINES).map((m) => `${mark(!!m.enabled)} ${m.name}${m.version ? ` ${m.version}` : ''} - ${m.parts.map((p) => `${p.count} ${p.kind}`).join(', ') || 'nothing Harbor can use'}`);
  return ['Mods for this project:', ...lines, 'Change one: /mods on <name>, /mods off <name>, /mods reset <name>. A mod\'s commands then work as /name or /mod:name.'].join('\n');
}

/** `on|off|reset <name>` of /skills and /mods. */
export function parseToggle(args: string): { enabled: boolean | null; query: string } | undefined {
  const m = /^(on|off|enable|disable|reset)\s+(.+)$/i.exec(args.trim());
  if (!m) return undefined;
  const w = m[1]!.toLowerCase();
  return { enabled: w === 'on' || w === 'enable' ? true : w === 'reset' ? null : false, query: m[2]!.trim() };
}

export const manyText = (kind: string, q: string, names: string[]): string => `"${q}" matches more than one ${kind}: ${names.slice(0, 8).join(', ')}. Use the full name or id.`;
