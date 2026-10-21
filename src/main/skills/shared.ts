import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.harbor/extensions.json`: the skill choices a project shares with everyone who opens it (checked into the repository),
 * {"skills": {"library:review-helper": true, "claude:user/pdf": false}}. Ids are the ones the skills list shows. It only
 * sets the project's default: a choice the user made in the app for this project always wins, and a skill it enables still has to
 * exist locally and pass the same import checks as any other (it cannot add files, only switch listed skills on or off).
 */
export const EXTENSIONS_FILE = join('.harbor', 'extensions.json');
const MAX_ENTRIES = 200;
const MAX_BYTES = 64 * 1024;

export function loadSharedChoices(projectPath: string): Record<string, boolean> {
  const file = join(projectPath, EXTENSIONS_FILE);
  try {
    if (!existsSync(file) || statSync(file).size > MAX_BYTES) return {};
    const j = JSON.parse(readFileSync(file, 'utf8')) as { skills?: unknown };
    const out: Record<string, boolean> = {};
    if (j.skills && typeof j.skills === 'object' && !Array.isArray(j.skills)) {
      for (const [id, v] of Object.entries(j.skills as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
        if (typeof v === 'boolean' && id.length <= 200 && !/[\r\n\0]/.test(id)) out[id] = v;
      }
    }
    return out;
  } catch { return {}; }
}
