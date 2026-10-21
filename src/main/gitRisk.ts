/**
 * Which Bash commands lose work or rewrite history. They are not denied (git follows Claude Code's rules: anything off the allowlist
 * asks the user); this only lets the prompt say so plainly and refuses "always allow" for them. Pure.
 */
const GIT_DESTRUCTIVE_RE = /\bgit\b(?:\s+-[Cc]\b|[^;&|\n]*?\s(?:clean|restore|update-ref|worktree|config|remote|gc|prune|reflog|filter-branch)(?![\w-])|[^;&|\n]*?\spush\s(?:[^;&|\n]*?\s)?(?:--force\S*|-[a-z]*f[a-z]*|--delete|-d|\+\S)|[^;&|\n]*?\s(?:checkout\s+(?:--|\.)|branch\s+(?:-[DdMm]\b|--delete|--move)|stash\s+(?:drop|clear)|reset\s+--hard))/i;
// `git "clean"` runs clean: unquote a lone quoted word so the subcommand check sees it.
const QUOTED_WORD = /(\s)(?:"([A-Za-z][\w-]*)"|'([A-Za-z][\w-]*)')(?=\s|$)/g;
// A commit message or search pattern may contain "config", "restore", "push"...: drop those arguments before matching.
const GIT_TEXT_ARG = /(\s(?:-m|--message|--grep|--author|-S|-G|-F|--file)(?:=|\s+))(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;

export function isGitDestructive(tool: string, input: unknown): boolean {
  const cmd = (input as { command?: unknown } | null)?.command;
  return tool === 'Bash' && typeof cmd === 'string' && GIT_DESTRUCTIVE_RE.test(cmd.replace(GIT_TEXT_ARG, '$1 ""').replace(QUOTED_WORD, '$1$2'));
}
