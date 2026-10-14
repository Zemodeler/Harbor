import type { CliId } from '../../shared/api';
import type { McpRun } from '../mcp/materialize';

export type Effort = 'low' | 'medium' | 'high';

export interface RunOptions {
  cwd: string;
  model: string;
  effort: Effort;
  /** Native session id captured from an earlier run, to continue that session. */
  resumeId?: string;
  /** read-only: planners/reviewers. edit: implementers inside their own worktree. full: auto mode, no approvals or sandbox. */
  permission: 'read-only' | 'edit' | 'full';
  /** Absolute paths of images attached to this turn (only the turn they were sent with). */
  images?: string[];
  /** Extra system-level instructions (role contract). Appended, never replaces CLI defaults. */
  systemPrompt?: string;
  /** Lead runs: forbid git merge/rebase/cherry-pick/reset/push where the CLI can enforce it (the integrator lands branches). */
  denyGitWrites?: boolean;
  /**
   * Extra directories the run may write to besides its cwd (e.g. the worktree's git metadata dir under the main repo's .git,
   * without which `git add/commit` fails inside a sandboxed worktree). Codex: sandbox_workspace_write.writable_roots; Claude: --add-dir.
   */
  writableDirs?: string[];
  /**
   * Extra directories the run must be able to READ (enabled skills outside its working folder, skills/delivery.ts). Claude: --add-dir
   * (which also lets acceptEdits runs edit there: Harbor shows a library skill as modified when its files stop matching the hash
   * recorded at import). Custom CLIs: run.readDir. Codex: ignored, its sandboxes restrict writes and not reads (NOT verified on Windows).
   */
  readableDirs?: string[];
  /** Extra Bash command prefixes a Claude edit run may run unasked (the project's own test commands, e.g. `pnpm test`). */
  allowedCommands?: string[];
  /**
   * Asked before the CLI runs a tool outside its allowlist (`edit` runs only; deny rules are applied first).
   * `signal` aborts when the CLI cancels the request or the run stops. Without it, such tools are denied silently as before.
   * Only Claude honours it: `codex exec` has no host approval channel (verified flags: --approve-for-me,
   * --dangerously-bypass-approvals-and-sandbox, -s; `codex app-server` has requestApproval but is experimental and out of scope).
   */
  onToolPermission?(req: ToolPermissionRequest, signal: AbortSignal): Promise<ToolPermissionDecision>;
  signal?: AbortSignal;
  /**
   * A pure question-and-answer run (the concierge): no tools, no project settings, MCP servers or skills, no saved session, and the
   * system prompt replaces the CLI's own instead of being appended to it. Claude only; other adapters ignore it.
   */
  lean?: boolean;
  /**
   * The CLI-native effort for this run's model (clis/effort.ts). Codex uses it for `model_reasoning_effort`; Claude keeps `effort`.
   * Absent: `effort` is used as is.
   */
  nativeEffort?: string;
  /**
   * MCP servers from Harbor's registry for this run, already filtered by mcp/materialize.ts planMcpRun (permission, CLI support,
   * allowUnattended). Claude: a per-run --mcp-config file (and --strict-mcp-config when `strict`); Codex: -c mcp_servers overrides;
   * custom CLIs: run.mcp with {mcpConfigFile}. Holds env and header values: never log it.
   */
  mcp?: McpRun;
}

/** A CLI asking the host whether it may run one tool call. */
export interface ToolPermissionRequest {
  tool: string;
  input: unknown;
  toolUseId?: string;
  description?: string;
  blockedPath?: string;
  /** The CLI's own reason for asking (e.g. why the rule did not match). */
  reason?: string;
}

export type ToolPermissionDecision = { allow: true } | { allow: false; message: string };

export type Chunk =
  | { kind: 'session'; id: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; text: string }
  | {
      kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number;
      /** Claude only: prompt-cache reads and writes, which `inputTokens` excludes. */ cacheReadTokens?: number; cacheWriteTokens?: number;
      /**
       * One model message's usage seen mid-run, not the run's final report. Kept so a run that is stopped before its final report
       * still records what it used (see runUsage.ts). `messageId` dedupes repeats of the same message.
       */
      partial?: boolean; messageId?: string;
    }
  | { kind: 'limits'; limits: Array<{ period: 'session' | 'weekly'; usedPct: number; resetsAt: number; asOf: number; scope?: string }> }
  /** `exitCode` is set only when the CLI ended without a terminal event of its own: 0 with output means it simply finished. */
  | { kind: 'done'; ok: boolean; text?: string; error?: string; rateLimited?: boolean; exitCode?: number | null };

export interface CliAdapter {
  id: CliId;
  /** Streams chunks; always ends with exactly one 'done' chunk. Never throws for CLI-level failures. */
  run(prompt: string, opts: RunOptions): AsyncIterable<Chunk>;
}

export const RATE_LIMIT_RE = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded|limit reached|limit will reset/i;

/**
 * Whether a rate-limit message names one model ("Opus usage limit reached", "limit for gpt-5") rather than the account. Only a
 * model-specific limit cools that model alone; anything else (the 5h window, a generic 429) holds the whole CLI out.
 */
export const isModelSpecific = (text: string | undefined): boolean =>
  !!text && /\b(?:opus|sonnet|haiku|fable)\b|\bgpt-[\w.-]+|\bo\d(?:-(?:mini|pro))?\b|\bmodel\b/i.test(text);
