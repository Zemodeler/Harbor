import type { CliId } from '../../shared/api';

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
   * Asked before the CLI runs a tool outside its allowlist (`edit` runs only; deny rules are applied first).
   * `signal` aborts when the CLI cancels the request or the run stops. Without it, such tools are denied silently as before.
   * Only Claude honours it: `codex exec` has no host approval channel (verified flags: --approve-for-me,
   * --dangerously-bypass-approvals-and-sandbox, -s; `codex app-server` has requestApproval but is experimental and out of scope).
   */
  onToolPermission?(req: ToolPermissionRequest, signal: AbortSignal): Promise<ToolPermissionDecision>;
  signal?: AbortSignal;
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
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: 'limits'; limits: Array<{ period: 'session' | 'weekly'; usedPct: number; resetsAt: number; asOf: number; scope?: string }> }
  | { kind: 'done'; ok: boolean; text?: string; error?: string; rateLimited?: boolean };

export interface CliAdapter {
  id: CliId;
  /** Streams chunks; always ends with exactly one 'done' chunk. Never throws for CLI-level failures. */
  run(prompt: string, opts: RunOptions): AsyncIterable<Chunk>;
}

export const RATE_LIMIT_RE = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded|limit reached|limit will reset/i;
