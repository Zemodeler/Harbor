import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Mod, ModCommand } from '../../shared/api';
import { modSlug } from './scan';

/**
 * A mod's slash commands: `commands/<name>.md` of a Claude Code plugin (a markdown prompt with optional frontmatter). Harbor expands
 * `$ARGUMENTS` and `$1`..`$9` and nothing else: lines starting with `!` (shell) and `@file` references stay as written, `allowed-tools` and
 * `model` are ignored, so a command can never run anything or widen a permission. The expanded text goes to the lead as the user's
 * request, labelled with where it came from. Layout of `commands/` is from the public plugin docs and NOT verified on an installed
 * plugin (none of the plugins on this machine ship commands).
 */
const MAX_COMMANDS = 60;
const MAX_BYTES = 32 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ParsedCommandFile { description: string; argumentHint?: string; body: string }

/** Frontmatter (`key: value` lines between `---`) and body of a command file. Unknown keys are dropped. */
export function parseCommandFile(text: string): ParsedCommandFile {
  let body = text.replace(/^﻿/, '');
  const meta: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (m) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '');
    }
    body = body.slice(m[0].length);
  }
  const clean = (v: string | undefined, max: number) => (v ?? '').replace(/[\0-\x1f\x7f]+/g, ' ').trim().slice(0, max);
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
  const hint = clean(meta['argument-hint'], 100);
  return { description: clean(meta['description'], 200) || clean(firstLine, 120), ...(hint ? { argumentHint: hint } : {}), body: body.trim() };
}

/** `$ARGUMENTS` is the whole argument text, `$1`..`$9` the words (quotes group). Arguments without a placeholder are appended. */
export function expandCommand(body: string, args: string): string {
  const words = [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((x) => x[1] ?? x[2] ?? x[3] ?? '');
  let used = false;
  const out = body.replace(/\$ARGUMENTS\b|\$([1-9])\b/g, (_m, n: string | undefined) => { used = true; return n ? words[Number(n) - 1] ?? '' : args; });
  return used || !args.trim() ? out : `${out}\n\nARGUMENTS: ${args.trim()}`;
}

/** Commands of one mod, newest names first not needed: sorted by name. */
export function modCommandsOf(mod: Pick<Mod, 'id' | 'name' | 'path'>): Array<ModCommand & { body: string }> {
  let files: string[] = [];
  try { files = readdirSync(join(mod.path, 'commands'), { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name).sort(); } catch { return []; }
  const out: Array<ModCommand & { body: string }> = [];
  for (const f of files.slice(0, MAX_COMMANDS)) {
    const name = f.slice(0, -3);
    if (!NAME_RE.test(name)) continue;
    try {
      const p = join(mod.path, 'commands', f);
      if (statSync(p).size > MAX_BYTES) continue;
      const c = parseCommandFile(readFileSync(p, 'utf8'));
      if (!c.body) continue;
      out.push({ name, mod: mod.id, modName: mod.name, qualified: `${modSlug(mod.name)}:${name}`, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}), body: c.body });
    } catch { /* an unreadable command is left out */ }
  }
  return out;
}

/** Built-in names a mod command can never take over. */
export const RESERVED_COMMANDS = new Set(['deep', 'skills', 'mods', 'review', 'tests', 'explain', 'summary']);

/**
 * The command a message runs, by `name` or `mod:name`. A bare name that two mods define, or a reserved one, is not run (the
 * `mod:name` form always is); `ambiguous` lists the mods to choose from.
 */
export function resolveCommand<T extends { name: string; qualified: string }>(all: T[], typed: string): { command?: T; ambiguous?: string[] } {
  const t = typed.toLowerCase();
  const exact = all.filter((c) => c.qualified.toLowerCase() === t);
  if (exact.length === 1) return { command: exact[0]! };
  if (t.includes(':') || RESERVED_COMMANDS.has(t)) return {};
  const byName = all.filter((c) => c.name.toLowerCase() === t);
  if (byName.length === 1) return { command: byName[0]! };
  return byName.length > 1 ? { ambiguous: byName.map((c) => c.qualified) } : {};
}
