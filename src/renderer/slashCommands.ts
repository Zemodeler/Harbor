// The composer's slash menu: typing "/" at the start of a message lists /deep, a few built-in prompts and the user's
// saved prompts. Only /deep means something to Harbor; the others just insert text the user can edit before sending.
import { matchScore } from './palette';
import type { PromptTemplate } from './hooks/useWorkspace';

export interface SlashCommand { id: string; name: string; title: string; description: string; text: string; kind: 'harbor' | 'builtin' | 'saved' }
export interface TemplateVars { project?: string; conversation?: string; now?: Date }

export const builtinCommands: SlashCommand[] = [
  { id: 'slash:deep', name: 'deep', title: 'Deep request', description: 'Skip the quick first answer and start a strong lead right away.', text: '/deep ', kind: 'harbor' },
  { id: 'slash:review', name: 'review', title: 'Review changes', description: 'Ask for a review of the current changes.', text: 'Review the current changes in {{project}} for bugs, missing tests and risky edits. List findings by severity with file and line, and do not change files.', kind: 'builtin' },
  { id: 'slash:tests', name: 'tests', title: 'Add tests', description: 'Ask for tests that cover recent work.', text: 'Add focused tests for the most recent changes in {{project}}. Run the test command and report what passed and what failed.', kind: 'builtin' },
  { id: 'slash:explain', name: 'explain', title: 'Explain code', description: 'Ask how a part of the project works.', text: 'Explain how this part of {{project}} works, with the files involved: ', kind: 'builtin' },
  { id: 'slash:summary', name: 'summary', title: 'Summarize conversation', description: 'Ask for a summary of where this conversation stands.', text: 'Summarize where "{{conversation}}" stands: what is done, what is open, and what you need from me.', kind: 'builtin' }
];

/** "Review before finishing" -> "review-before-finishing". */
export function slug(title: string): string {
  return title.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'prompt';
}
/** Built-ins first, then saved prompts; a saved prompt whose name clashes gets a numeric suffix. */
export function slashCommands(templates: PromptTemplate[]): SlashCommand[] {
  const taken = new Set(builtinCommands.map(c => c.name));
  const saved = templates.map(t => {
    let name = slug(t.title), n = 2;
    while (taken.has(name)) name = `${slug(t.title)}-${n++}`;
    taken.add(name);
    return { id: `slash:saved:${t.id}`, name, title: t.title, description: t.text.slice(0, 90), text: t.text, kind: 'saved' as const };
  });
  return [...builtinCommands, ...saved];
}
/** The command being typed: the draft is "/word" (no space yet) with the caret at its end; otherwise null. */
export function slashQuery(draft: string, caret = draft.length): string | null {
  const head = draft.slice(0, caret);
  const m = /^\/([\p{L}\p{N}_-]*)$/u.exec(head);
  return m && caret === draft.length ? m[1] : null;
}
export function matchSlash(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;
  return commands.map((c, i) => ({ c, i, s: Math.max(matchScore(query, c.name) ?? -1, (matchScore(query, c.title) ?? -1) * .8) }))
    .filter(x => x.s >= 0).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.c);
}
/** Fills {{project}}, {{conversation}} and {{date}}; unknown placeholders stay as typed. */
export function fillTemplate(text: string, vars: TemplateVars): string {
  const now = vars.now || new Date();
  return text.replace(/\{\{\s*(project|conversation|date)\s*\}\}/g, (_, name: string) =>
    name === 'project' ? vars.project || 'this project' : name === 'conversation' ? vars.conversation || 'this conversation' : now.toLocaleDateString());
}
/** The draft after choosing a command: the "/word" is replaced by the command's text. */
export function applySlash(draft: string, command: SlashCommand, vars: TemplateVars): string {
  const rest = draft.replace(/^\/[\p{L}\p{N}_-]*\s*/u, '');
  const text = fillTemplate(command.text, vars);
  return command.kind === 'harbor' ? text + rest : rest ? `${text}\n\n${rest}` : text;
}
