import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Chunk, CliAdapter, RunOptions, ToolPermissionDecision, ToolPermissionRequest } from './types';
import { RATE_LIMIT_RE } from './types';
import { streamLines, type StdinSink, type StreamedLine, type StreamResult } from './stream';

/**
 * Claude Code headless adapter. Flags verified against `claude --help` (2.1.293):
 * -p, --output-format stream-json (needs --verbose), --model, --effort, --resume,
 * --permission-mode, --allowedTools, --disallowedTools, --append-system-prompt.
 *
 * Lean mode (`lean`, the concierge), flags verified against `claude --help` of 2.1.295 and by running `-p` with no input and
 * no model call: --tools "" (help: "Use \"\" to disable all tools"; accepted), --strict-mcp-config, --disable-slash-commands,
 * --no-session-persistence (only with --print), --system-prompt-file (replaces the default prompt; not listed in the help body
 * but accepted: a missing file is reported as "System prompt file not found", an unknown flag as "unknown option").
 * Verified to exist but NOT used: --setting-sources (accepts user, project, local; the concierge runs in a neutral folder, so
 * project and local settings are absent anyway, and what an empty list means was not verified), --system-prompt (argv: the
 * text is long and .cmd shims reject quotes and line breaks). NOT used because unverified: --bare (documented to skip hooks, plugins
 * and memory, but it may require API-key auth, which a subscription login does not have). NOT verified: how much of the
 * default prompt cost these flags remove; measure with `npm run smoke -- claude` and compare costUsd of a concierge run.
 * The prompt goes through stdin so it never touches the command line.
 * NOT VERIFIED (`claude --help` could not be run when these were added): --add-dir (images) and
 * --permission-mode bypassPermissions (auto mode). Both are documented Claude Code options.
 *
 * Git-write deny rules (`denyGitWrites`, lead runs): `Bash(git merge *)` etc. appended to the variadic --disallowedTools list.
 * NOT VERIFIED here (`claude` could not be run in the session that added this): the exact `Bash(prefix *)` rule syntax,
 * and that a deny rule wins over the `Bash(git *)` allow rule. Claude Code's permission docs state deny rules are evaluated
 * first and take precedence over allow rules, but that was not confirmed against the installed CLI. Also not covered:
 * `git -C x merge`, aliases, or merging through a shell wrapper; the post-turn check in orchestrator.ts is the backstop.
 * In `full` (bypassPermissions) mode deny rules still apply in Claude Code (also unconfirmed).
 *
 * Controlled mode (`onToolPermission` set and permission `edit`; everything else is unchanged): the run adds
 * `--input-format stream-json --permission-prompt-tool stdio`, keeps stdin open, sends the prompt as a user message line,
 * and answers the CLI's `can_use_tool` control requests through the host handler. Stdin is ended when `result` arrives.
 * VERIFIED by the planner on claude.exe 2.1.293 (no model call): `--input-format stream-json` is accepted, an `initialize`
 * control_request gets a `control_response` with subtype success, empty stream-json stdin exits quietly; the
 * `can_use_tool` request fields and `control_cancel_request` exist as strings in the binary (not seen live).
 * UNVERIFIED (taken from the Agent SDK; not run live, the CLI was not reachable from the session that added this):
 * `--permission-prompt-tool stdio` being what routes permission prompts to stdin; the response shape
 * `{subtype:'success',request_id,response:{behavior:'allow',updatedInput}|{behavior:'deny',message}}` and the error shape
 * `{subtype:'error',request_id,error}`; the user turn line `{type:'user',message:{role:'user',content}}`; that a cancelled
 * request needs no reply; and that --disallowedTools deny rules are evaluated before the host is asked. Because of the
 * last one, lead runs (`denyGitWrites`) also auto-deny git merge/rebase/cherry-pick/reset/push here, without asking.
 */
/** Both `Bash(prefix)` and `Bash(prefix *)`: the second form may not match a bare command with no arguments. */
const bashRules = (prefixes: string[]): string[] => prefixes.flatMap((p) => [`Bash(${p})`, `Bash(${p} *)`]);

/**
 * Denied on EVERY edit run (helpers and leads): commands that destroy work, rewrite refs, escape the worktree or touch
 * configuration. Merge/rebase/cherry-pick are not here because integrator helpers legitimately merge inside their worktree;
 * leads additionally get GIT_WRITE_DENY below. `git -C` is denied because it lets a command act on another repository.
 */
export const GIT_DESTRUCTIVE_PREFIXES = [
  'git clean', 'git restore', 'git checkout --', 'git checkout .', 'git branch -D', 'git branch -d', 'git branch -M', 'git branch -m',
  'git branch --delete', 'git branch --move', 'git update-ref', 'git worktree', 'git stash drop', 'git stash clear', 'git config',
  'git remote', 'git push', 'git reset --hard', 'git gc', 'git prune', 'git reflog', 'git filter-branch', 'git -C'
];
export const GIT_DESTRUCTIVE_DENY: readonly string[] = bashRules(GIT_DESTRUCTIVE_PREFIXES);
const GIT_DESTRUCTIVE_RE = /\bgit\b(?:\s+-[Cc]\b|[^;&|\n]*?\s(?:clean|restore|update-ref|worktree|config|remote|push|gc|prune|reflog|filter-branch)(?![\w-])|[^;&|\n]*?\s(?:checkout\s+(?:--|\.)|branch\s+(?:-[DdMm]\b|--delete|--move)|stash\s+(?:drop|clear)|reset\s+--hard))/i;

/** Bash commands a helper may run without being asked: read-only git, staging and committing, tests. Everything else is asked or denied. */
export const HELPER_BASH_ALLOW: readonly string[] = bashRules([
  'git status', 'git diff', 'git log', 'git show', 'git rev-parse', 'git add', 'git commit', 'git ls-files', 'git grep', 'git blame',
  'git branch --show-current', 'npm test', 'npm run', 'npx vitest', 'npx tsc'
]);
/** Leads keep the original broad allowlist; their deny rules, not the allowlist, are what keeps them safe. */
const LEAD_BASH_ALLOW = ['Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)'];

/** The deny rules (without Task/Agent) for one run. */
export function claudeDenyRules(o: RunOptions): string[] {
  if (o.permission !== 'edit' && !o.denyGitWrites) return [];
  return [...(o.denyGitWrites ? GIT_WRITE_DENY : []), ...GIT_DESTRUCTIVE_DENY];
}

const GIT_WRITE_CMDS = ['merge', 'rebase', 'cherry-pick', 'reset', 'push'];
const GIT_WRITE_DENY = GIT_WRITE_CMDS.map((c) => `Bash(git ${c} *)`);
// Broader than the deny rules on purpose (`git -C x merge`, `cd x && git push`): a false deny is cheap, a merge is not.
const GIT_WRITE_RE = new RegExp(`\\bgit\\b[^;&|\\n]*?\\s(?:${GIT_WRITE_CMDS.join('|')})(?![\\w-])`, 'i');

/** Whether this run answers permission prompts through the host instead of silently denying. */
export const isControlled = (o: RunOptions): boolean => !!o.onToolPermission && o.permission === 'edit';

export function claudeArgs(o: RunOptions, systemPromptFile?: string): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (o.model && o.model !== 'default') a.push('--model', o.model);
  a.push('--effort', o.effort);
  if (o.lean) {
    // The concierge answers from its prompt alone: no tools (so no tool schemas in every request), no MCP servers, no skills, no
    // session on disk, and Harbor's front-desk text instead of Claude Code's long default system prompt.
    a.push('--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence');
    if (systemPromptFile) a.push('--system-prompt-file', systemPromptFile);
    return a;
  }
  if (o.resumeId) a.push('--resume', o.resumeId);
  if (o.permission === 'full') {
    a.push('--permission-mode', 'bypassPermissions');
  } else if (o.permission === 'edit') {
    const extra = (o.allowedCommands ?? []).filter((c) => c.trim() && !/[\r\n]/.test(c)).flatMap((c) => bashRules([c.trim()]));
    a.push('--permission-mode', 'acceptEdits', '--allowedTools', ...(o.denyGitWrites ? LEAD_BASH_ALLOW : HELPER_BASH_ALLOW), ...extra);
  } else {
    a.push('--permission-mode', 'plan');
  }
  // Attached images live outside the project: the agent may only Read them if their folder is added. Variadic flag, so it
  // must be followed by another flag (--disallowedTools below).
  const dirs = [...new Set([...(o.images ?? []).map((p) => dirname(p)), ...(o.writableDirs ?? [])])];
  if (dirs.length) a.push('--add-dir', ...dirs);
  // Subagents must not spawn agents (docs/architecture.md): block native delegation tools.
  a.push('--disallowedTools', 'Task', 'Agent');
  a.push(...claudeDenyRules(o));
  // Role text is long and multi-line: pass it by file so it works through .cmd shims too.
  if (systemPromptFile) a.push('--append-system-prompt-file', systemPromptFile);
  if (isControlled(o)) a.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio');
  return a;
}

export interface ControlRequest { requestId: string; subtype: string; permission?: ToolPermissionRequest }

/** Parse a `control_request` line from the CLI. Pure; anything else is undefined. */
export function parseControlRequest(line: string): ControlRequest | undefined {
  let j: any;
  try { j = JSON.parse(line); } catch { return undefined; }
  if (j?.type !== 'control_request' || typeof j.request_id !== 'string') return undefined;
  const r = j.request ?? {};
  const subtype = typeof r.subtype === 'string' ? r.subtype : '';
  if (subtype !== 'can_use_tool') return { requestId: j.request_id, subtype };
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const reason = typeof r.decision_reason === 'string' ? r.decision_reason : r.decision_reason ? JSON.stringify(r.decision_reason) : undefined;
  const permission: ToolPermissionRequest = { tool: String(r.tool_name ?? ''), input: r.input ?? {} };
  const opt = { toolUseId: str(r.tool_use_id), description: str(r.description), blockedPath: str(r.blocked_path), reason: str(reason) };
  for (const [k, v] of Object.entries(opt)) if (v) (permission as any)[k] = v;
  return { requestId: j.request_id, subtype, permission };
}

/** The request id of a `control_cancel_request` line, or undefined. Pure. */
export function parseControlCancel(line: string): string | undefined {
  let j: any;
  try { j = JSON.parse(line); } catch { return undefined; }
  return j?.type === 'control_cancel_request' && typeof j.request_id === 'string' ? j.request_id : undefined;
}

/** One stream-json user turn, newline-terminated. */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

/** Answer to a can_use_tool request. Allow passes the original input back unchanged (the host never rewrites tool calls). */
export function controlResponse(requestId: string, decision: ToolPermissionDecision, originalInput: unknown): string {
  const response = decision.allow
    ? { behavior: 'allow', updatedInput: originalInput ?? {} }
    : { behavior: 'deny', message: decision.message };
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';
}

export function controlError(requestId: string, error: string): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }) + '\n';
}

/** Lead runs never get a git history rewrite or push approved through the handler. */
/** Destructive git on any run: auto-denied in the control channel without asking, since deny rules may not be evaluated first. */
export function isGitDestructive(tool: string, input: unknown): boolean {
  const cmd = (input as { command?: unknown } | null)?.command;
  // A commit message or search pattern may contain "config", "restore", "push"...: drop those arguments before matching.
  // Only message-like options are stripped, so a quoted subcommand (`git "clean"`) is still seen.
  return tool === 'Bash' && typeof cmd === 'string' && GIT_DESTRUCTIVE_RE.test(cmd.replace(GIT_TEXT_ARG, '$1 ""').replace(QUOTED_WORD, '$1$2'));
}
// `git "clean"` runs clean: unquote a lone quoted word so the subcommand check sees it.
const QUOTED_WORD = /(\s)(?:"([A-Za-z][\w-]*)"|'([A-Za-z][\w-]*)')(?=\s|$)/g;
const GIT_TEXT_ARG = /(\s(?:-m|--message|--grep|--author|-S|-G|-F|--file)(?:=|\s+))(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;

export function isGitWrite(tool: string, input: unknown): boolean {
  const cmd = (input as { command?: unknown } | null)?.command;
  return tool === 'Bash' && typeof cmd === 'string' && GIT_WRITE_RE.test(cmd);
}

/** Parse one stream-json line into zero or more chunks. Pure; unknown shapes are ignored. */
export function parseClaudeLine(line: string): Chunk[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  const out: Chunk[] = [];
  if (j.type === 'system' && j.subtype === 'init' && j.session_id) out.push({ kind: 'session', id: j.session_id });
  else if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    for (const c of j.message.content) {
      if (c.type === 'text' && c.text) out.push({ kind: 'text', text: c.text });
      else if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${summarizeInput(c.input)}`.trim() });
    }
  } else if (j.type === 'rate_limit_event') {
    // The account's real 5h / 7-day utilization (0..1) as the subscription sees it, not just Harbor's runs.
    const uw = j.rate_limit_info?.unifiedWindows, asOf = Date.now();
    const limits: Array<{ period: 'session' | 'weekly'; usedPct: number; resetsAt: number; asOf: number; scope?: string }> = [];
    // `five_hour` / `seven_day` are account-wide; `seven_day_<model>` (e.g. opus, fable) is a per-model cap. The
    // per-model key names are inferred from that pattern, not verified against every plan (see BACKLOG).
    for (const [key, w] of Object.entries(uw ?? {}) as [string, any][]) {
      const m = /^(five_hour|seven_day)(?:_(.+))?$/.exec(key);
      if (!m || !w || typeof w.utilization !== 'number' || typeof w.resetsAt !== 'number') continue;
      limits.push({ period: m[1] === 'five_hour' ? 'session' : 'weekly', usedPct: w.utilization * 100, resetsAt: w.resetsAt * 1000, asOf, ...(m[2] ? { scope: m[2].toLowerCase() } : {}) });
    }
    if (limits.length) out.push({ kind: 'limits', limits });
  } else if (j.type === 'result') {
    if (j.session_id) out.push({ kind: 'session', id: j.session_id });
    const u = j.usage ?? {};
    out.push({
      kind: 'usage', inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd: j.total_cost_usd,
      // Cached prompt tokens are most of a Claude run's input and are NOT in input_tokens; undefined when absent so older output parses as before.
      ...(typeof u.cache_read_input_tokens === 'number' ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
      ...(typeof u.cache_creation_input_tokens === 'number' ? { cacheWriteTokens: u.cache_creation_input_tokens } : {})
    });
    const err = j.is_error || (j.subtype && j.subtype !== 'success');
    const text = typeof j.result === 'string' ? j.result : undefined;
    out.push({ kind: 'done', ok: !err, text, error: err ? text || String(j.subtype) : undefined, rateLimited: err && RATE_LIMIT_RE.test(text ?? '') });
  }
  return out;
}

function summarizeInput(i: any): string {
  if (!i || typeof i !== 'object') return '';
  const v = i.file_path ?? i.command ?? i.pattern ?? i.path ?? '';
  return String(v).slice(0, 120);
}

/**
 * The host side of the control channel for one run. Requests are answered asynchronously so stdout keeps flowing while
 * the host decides; each has its own AbortController, aborted by a control_cancel_request, the run signal, or the run ending.
 */
class PermissionChannel {
  private stdin?: StdinSink;
  private pending = new Map<string, AbortController>();
  private closed = false;
  private onAbort = () => this.finish();
  constructor(private o: RunOptions) {
    o.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  attach(s: StdinSink): void { this.stdin = s; }

  /** Consume a control line; false means it is an ordinary output line. */
  handle(line: string): boolean {
    const cancelled = parseControlCancel(line);
    if (cancelled !== undefined) {
      this.pending.get(cancelled)?.abort();
      this.pending.delete(cancelled);
      return true;
    }
    const req = parseControlRequest(line);
    if (!req) return false;
    if (!req.permission) this.send(controlError(req.requestId, `Unsupported control request: ${req.subtype || 'unknown'}`));
    else void this.ask(req.requestId, req.permission);
    return true;
  }

  private async ask(id: string, p: ToolPermissionRequest): Promise<void> {
    if (this.o.denyGitWrites && isGitWrite(p.tool, p.input)) {
      this.send(controlResponse(id, { allow: false, message: 'Lead runs never merge, rebase, cherry-pick, reset or push; the integrator lands branches.' }, p.input));
      return;
    }
    if (isGitDestructive(p.tool, p.input)) {
      this.send(controlResponse(id, { allow: false, message: 'Harbor does not allow destructive git commands (clean, restore, checkout --, branch deletion, update-ref, worktree, stash drop, config, remote, push, -C).' }, p.input));
      return;
    }
    const ac = new AbortController();
    this.pending.set(id, ac);
    let d: ToolPermissionDecision;
    try {
      d = await this.o.onToolPermission!(p, ac.signal);
    } catch (e) {
      d = { allow: false, message: `Permission request failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    // A cancelled or finished request needs no answer; the CLI has moved on.
    if (ac.signal.aborted || this.pending.get(id) !== ac) return;
    this.pending.delete(id);
    this.send(controlResponse(id, d, p.input));
  }

  private send(line: string): void { if (!this.closed) this.stdin?.write(line); }

  /** The result arrived or the run stopped: end stdin so the CLI exits, and drop open questions. */
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.o.signal?.removeEventListener('abort', this.onAbort);
    for (const ac of this.pending.values()) ac.abort();
    this.pending.clear();
    this.stdin?.end();
  }
}

export class ClaudeAdapter implements CliAdapter {
  id = 'claude';
  constructor(private exe: string) {}

  async *run(prompt: string, o: RunOptions): AsyncGenerator<Chunk> {
    if (o.images?.length) prompt = `${prompt}\n\nThe user attached image file(s) to this message. Read each one with the Read tool to see it:\n${o.images.map((p) => `- ${p}`).join('\n')}`;
    let done = false;
    let spFile: string | undefined;
    if (o.systemPrompt) {
      spFile = join(tmpdir(), `harbor-sp-${randomUUID()}.txt`);
      writeFileSync(spFile, o.systemPrompt);
    }
    let res: IteratorResult<StreamedLine, StreamResult>;
    const ctl = isControlled(o) ? new PermissionChannel(o) : undefined;
    const gen = ctl
      ? streamLines(this.exe, claudeArgs(o, spFile), { cwd: o.cwd, input: userMessageLine(prompt), signal: o.signal, interactive: (s) => ctl.attach(s) })
      : streamLines(this.exe, claudeArgs(o, spFile), { cwd: o.cwd, input: prompt, signal: o.signal });
    try {
      res = await gen.next();
      while (!res.done) {
        if (res.value.stream === 'stdout') {
          if (ctl?.handle(res.value.line)) { res = await gen.next(); continue; }
          for (const c of parseClaudeLine(res.value.line)) {
            if (c.kind === 'done') { done = true; ctl?.finish(); }
            yield c;
          }
        }
        res = await gen.next();
      }
    } finally {
      ctl?.finish();
      if (spFile) try { unlinkSync(spFile); } catch { /* already gone */ }
    }
    if (!done) {
      const r = res.value;
      const reason = r.aborted ? 'stopped' : r.spawnError ?? (r.stderr.trim().slice(-500) || `exited with code ${r.code}`);
      yield { kind: 'done', ok: false, error: reason, rateLimited: RATE_LIMIT_RE.test(r.stderr), exitCode: r.aborted || r.spawnError ? null : r.code };
    }
  }
}
