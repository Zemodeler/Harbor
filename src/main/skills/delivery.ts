/**
 * Which enabled skills a run gets, and how (plan section 3.3). Pure: the file checks are injected.
 * - A skill the CLI already loads natively (it sits in that CLI's own skills folder and the CLI declares `nativeSkills`) is
 *   skipped, so it is never listed twice.
 * - A skill inside the run's working folder is listed by path: every CLI can read its own folder.
 * - Outside it (the shared library, another checkout): `readDirs` CLIs are given read access to the skill's folder (Claude
 *   `--add-dir`, a custom CLI's `run.readDir`); `readable` CLIs are assumed to read anywhere (Codex: its sandboxes restrict
 *   writes, not reads; NOT verified on Windows); `inline` CLIs get the SKILL.md text in the prompt when it is small, and the rest
 *   are named as unavailable on that CLI. No copies are made (owner decision: shared library).
 */

export type SkillAccess = 'readDirs' | 'readable' | 'inline';

export interface DeliverySkill { id: string; name: string; description: string; /** Folder as the run should see it (already moved into the run's checkout when a copy exists there). */ path: string; mdBytes: number }
export interface DeliveryInput {
  skills: DeliverySkill[];
  cwd: string;
  access: SkillAccess;
  isNative: (s: DeliverySkill) => boolean;
  /** Whether a folder is inside the run's working folder. */
  inside: (dir: string, cwd: string) => boolean;
  /** SKILL.md text for inlining (undefined when unreadable). */
  readText: (s: DeliverySkill) => string | undefined;
  /** Path of a skill's SKILL.md (platform separator). */
  fileOf: (s: DeliverySkill) => string;
}
export interface Delivery {
  listed: Array<{ name: string; description: string; file: string }>;
  inline: Array<{ name: string; description: string; text: string }>;
  unavailable: string[];
  /** Skipped because the CLI already has them natively. */
  native: string[];
  /** Folders to grant read access to (readDirs CLIs only). */
  readDirs: string[];
}

/** Most skills listed in one prompt: a few lines each, so the list stays cheap. */
export const MAX_LISTED = 40;
export const MAX_INLINE_BYTES = 8 * 1024;
export const MAX_INLINE_TOTAL = 24 * 1024;

export function planDelivery(i: DeliveryInput): Delivery {
  const d: Delivery = { listed: [], inline: [], unavailable: [], native: [], readDirs: [] };
  let inlineBytes = 0;
  for (const s of i.skills) {
    if (i.isNative(s)) { d.native.push(s.name); continue; }
    if (d.listed.length + d.inline.length >= MAX_LISTED) { d.unavailable.push(s.name); continue; }
    const local = i.inside(s.path, i.cwd);
    if (local || i.access === 'readable') { d.listed.push({ name: s.name, description: s.description, file: i.fileOf(s) }); continue; }
    if (i.access === 'readDirs') { d.listed.push({ name: s.name, description: s.description, file: i.fileOf(s) }); d.readDirs.push(s.path); continue; }
    const text = s.mdBytes <= MAX_INLINE_BYTES && inlineBytes + s.mdBytes <= MAX_INLINE_TOTAL ? i.readText(s) : undefined;
    if (text === undefined) { d.unavailable.push(s.name); continue; }
    inlineBytes += s.mdBytes;
    d.inline.push({ name: s.name, description: s.description, text });
  }
  return d;
}
