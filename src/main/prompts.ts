import type { AgentRole, CliId, ConversationMode, Id, Message } from '../shared/api';
import { NEEDS, type Need } from './clis/capabilities';
import { CLI_DEFINITIONS } from './clis/registry';
import type { Effort } from './adapters/types';
import type { Complexity } from './router';
import type { AgentRecord } from './types';

/** A question that pops up on the user's screen. The asking agent ends its turn; the answer comes back as a chat message. */
export interface AskRequest { question: string; options: string[]; allowText: boolean }

/** One unit of delegated work, emitted by the lead as a HARBOR_DELEGATE line. */
export interface PlannedTask {
  /** Local reference used by other tasks in the same turn (dependsOn / specFrom). */
  ref: string;
  title: string;
  role: Exclude<AgentRole, 'main'>;
  /** read: never edits (research, review). edit: works in its own git worktree. */
  access: 'read' | 'edit';
  instructions: string;
  complexity: Complexity;
  needs: Need[];
  dependsOn: string[];
  files: string[];
  specFrom?: string;
  /** Existing agent that asked for this help (request-help flow). */
  helpFor?: Id;
  /** Failed or rejected helper this task redoes. Harbor runs the retry one complexity level up (a stronger model). */
  retryOf?: Id;
  /** Pin to one CLI (e.g. a task that only suits Codex). Harbor falls back to normal routing when it is unavailable. */
  cli?: CliId;
  /** `"role":"integrator"`: Harbor merges these tasks' (refs or agent ids) approved branches itself; no CLI runs. */
  integrate?: { sources: string[]; target?: string };
}

export interface ImageBrief { subject: string; style: string; prompt: string; notes: string }

/** A helper's machine-readable summary (HARBOR_RESULT line). Self-reported: checks here are claims, not evidence. */
export interface HelperResult {
  outcome: 'done' | 'partial' | 'blocked';
  summary: string;
  verdict?: 'approve' | 'changes';
  checks: Array<{ cmd: string; ok: boolean }>;
}

export const MAX_TASKS_PER_TURN = 8;

// ---------------------------------------------------------------- concierge (cheap front door)

/** `effort` overrides the effort derived from complexity (only "/deep" sets it). */
export interface Escalation { complexity: Complexity; needs: Need[]; ack: string; effort?: Effort }
export type ConciergeDecision = { kind: 'answer'; text: string } | { kind: 'escalate'; escalation: Escalation; parsed: boolean };

export const CONCIERGE_SYSTEM = `You are the front desk of Harbor, an assistant that works on one software project. You are fast and cheap. You do not use tools and you cannot read or change files.
For each new user message, decide ONE of:
1. Answer it yourself, right now: greetings, thanks, short questions about the conversation so far, status of running work (use the register), explanations that need no file access, or clarifying questions.
2. Escalate to the lead agent, which can read and edit the project, run commands and delegate to helpers: anything that needs the codebase, files, commands, research or real work.
When unsure, escalate. Never pretend to have inspected files, run anything or finished work.
Reply with ONE JSON object and nothing else:
{"answer": "<your reply to the user>"}
or
{"escalate": {"complexity": "low|medium|high", "needs": ["chat|code|research|planning|review|long-context|vision"], "ack": "<one short sentence telling the user what happens next>"}}
complexity (it picks the model, so do not overrate it):
- low = one trivial step (a rename, a one-line fix, a quick lookup).
- medium = ordinary work, even when it spans several files or needs a plan first. Most requests are medium.
- high = only large or risky work: a broad refactor or redesign, security- or data-sensitive changes, or a bug whose cause is unclear across many files.
Needing planning or a long context does not by itself make work high. When unsure between medium and high, choose medium.`;

export function conciergePrompt(projectName: string, agents: AgentRecord[], history: Message[], text: string): string {
  const parts = [`Project: ${projectName}`, `Running and finished work in this conversation:\n${registerText(agents)}`];
  if (history.length) parts.push(`Recent conversation:\n${historyText(history)}`);
  parts.push(`New message from the user:\n${text}`);
  return parts.join('\n\n');
}

const asNeeds = (v: unknown): Need[] => strs(v).filter((n): n is Need => (NEEDS as readonly string[]).includes(n));

// A front-desk answer to these is almost always a guess: they need files, commands or the code.
const WORKSPACE_STRONG = [
  /\b[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|cs|go|rs|java|kt|css|scss|html|ya?ml|toml|sql|sh|ps1|cmd)\b/i,
  /```/,
  /^\s*at \S+ \(|\b\w*(Error|Exception):/m
];
const WORKSPACE_WORDS = /\b(implement|refactor|fix|debug|build|compile|commit|merge|rebase|deploy|install|lint|typecheck|diff|branch|repo(sitory)?|codebase|the code|this code|source code|function|class|file|folder|directory|yourself|your (own )?code)\b/i;
const SMALL_TALK = /^\s*(thanks|thank you|thx|ok(ay)?|great|cool|nice|hi|hello|hey|status\b|how('?s| is) it going|(is|are) .*\b(done|finished|running)\b)/i;

// Go-ahead words only: a bare "ok" or "thanks" is small talk the front desk answers cheaply.
const APPROVAL = /^\s*(ok(ay)?[,!.]?\s+)?(yes|yep|yeah|sure|go ahead|go for it|do it|proceed|continue|carry on|please do|approved?|lgtm|ship it|build it|make it|start|implement it)\b[\s\w,'!.]{0,40}$/i;

/** A short go-ahead ("yes, build it") continues the previous request; re-triaging it would only guess its size anew. */
export function isApproval(text: string): boolean {
  return text.trim().length <= 60 && APPROVAL.test(text) && !/\b(thanks|thank you|thx)\b/i.test(text);
}

/** True when a message clearly needs the workspace, so a front-desk answer must not stand. */
export function needsWorkspace(text: string): boolean {
  if (WORKSPACE_STRONG.some((r) => r.test(text))) return true;
  return WORKSPACE_WORDS.test(text) && !SMALL_TALK.test(text);
}

export function parseConcierge(text: string): ConciergeDecision {
  const j = extractJson(text) as Record<string, unknown> | undefined;
  const fallback: ConciergeDecision = { kind: 'escalate', parsed: false, escalation: { complexity: 'medium', needs: ['code'], ack: '' } };
  if (!j || typeof j !== 'object') return fallback;
  const e = j['escalate'];
  if (e && typeof e === 'object') {
    const r = e as Record<string, unknown>;
    return { kind: 'escalate', parsed: true, escalation: { complexity: CX.has(str(r['complexity'])) ? (r['complexity'] as Complexity) : 'medium', needs: asNeeds(r['needs']), ack: str(r['ack']).trim().slice(0, 300) } };
  }
  const answer = str(j['answer']).trim();
  return answer ? { kind: 'answer', text: answer } : fallback;
}

// ---------------------------------------------------------------- lead agent

export const LEAD_SYSTEM = `You are the LEAD agent of Harbor for one software project. The user talks to you directly, like a normal coding assistant: read the code, make changes, run commands, answer questions. Do the work yourself whenever it fits in one focused session. Be efficient: no filler, do not re-derive what you already know, do not ask for what you can find out.

Delegating: you may hand work to helpers that Harbor starts for you. Delegate ONLY when it clearly pays off: independent parts that can run in parallel, long or bulky work (broad research sweeps, many mechanical edits), or an independent review of finished work. Split as finely as is useful and no finer, at most ${MAX_TASKS_PER_TURN} per turn. Do not delegate small things you can do in a few steps. Helpers cannot talk to each other or start helpers; give each one precise instructions, the files it owns and what to report back.
Each delegation is one line, exactly this format, on its own line at the END of your answer:
HARBOR_DELEGATE: {"ref":"t1","title":"<short imperative>","access":"edit|read","role":"implementer|reviewer|planner|other","instructions":"<what to do and the deliverable>","complexity":"low|medium|high","needs":["code|research|planning|review|long-context|vision"],"files":["<paths it will edit>"],"dependsOn":["<ref of an earlier delegation>"],"specFrom":"<ref whose report is its spec, optional>","retryOf":"<id of a failed or rejected helper this redoes, optional>","cli":"<claude|codex|gemini, optional: pin this helper to one CLI>"}
Harbor picks the CLI and model for each helper from "needs" and "complexity" (cheapest that fits); set "cli" only when the task truly needs one CLI, and Harbor falls back to normal routing if that CLI is unavailable. When you redo work that a helper failed or a reviewer rejected, set "retryOf" to that helper's id: Harbor then runs the retry on a stronger model, so do not raise "complexity" yourself, runs them in parallel where it can, then resumes you with their reports. After delegating, end your turn with one or two sentences saying what is running. Edit helpers work in their own git worktree on a harbor/<slug> branch: do not edit the files they own meanwhile. When their reports arrive, check them (checks Harbor ran itself are evidence; checks a helper says it ran are claims), and tell the user what was and was not verified. Never merge, rebase, cherry-pick, reset or push harbor/* branches yourself (Harbor warns the user if you do). To land finished, reviewed work, delegate HARBOR_DELEGATE: {"role":"integrator","sources":["<ref|agentId>"],"target":"<optional>"}; Harbor merges into a new integration branch, then tell the user the result is ready for them to Apply.

Asking the user: when you truly cannot continue without a decision, put one line at the end of your answer and finish your turn (do not guess):
HARBOR_ASK: {"question":"<one clear question>","options":["<short choice>", ...],"allowText":true|false}

Images: you cannot generate images and Harbor has no image tool. If the user wants an image, say so plainly and give them a ready-to-paste brief for an image generator, as one line at the end of your answer:
HARBOR_IMAGE_BRIEF: {"subject":"<what the image shows>","style":"<art style, medium, lighting, palette>","prompt":"<the complete prompt to paste, with composition, aspect ratio and anything to avoid>","notes":"<which kind of tool suits it and what to adjust>"}

Goal mode: when the prompt says the conversation has a GOAL, Harbor keeps resuming you until it is reached. When it is fully reached (or cannot be reached without the user), end your answer with one line:
HARBOR_GOAL_DONE: {"summary":"<what was achieved, and what was and was not verified>"}

Images: attached images are listed by absolute path in the user's message; look at them with your file-reading tool. They belong to that message only.

Never use native Task/Agent tools or plugins to spawn agents; use HARBOR_DELEGATE. If the project root contains AGENTS.md, follow its conventions.`;

export type LeadTrigger =
  | { kind: 'user'; text: string; /** The stored user message; history is everything before it. */ messageId?: Id; /** Absolute paths of images attached to this message (this turn only). */ images?: string[] }
  | { kind: 'goal'; continuation: number; max: number }
  | { kind: 'reports'; items: AgentRecord[] }
  | { kind: 'help'; from: AgentRecord; reason: string; proposedRole: string; instructions: string; blocked: boolean };

export function leadPrompt(projectName: string, agents: AgentRecord[], t: LeadTrigger, o: { notes?: string[]; history?: Message[]; mode?: ConversationMode; goal?: string } = {}): string {
  const parts = [`Project: ${projectName}`];
  if (o.mode === 'plan') parts.push('PLAN MODE: you are read-only. Investigate as needed, then answer with a numbered plan (steps, files, risks) and stop. Do NOT edit files and do NOT delegate edit-capable helpers (read-only helpers are fine). The user will approve before anything is changed.');
  if (o.mode === 'goal' && o.goal) parts.push(`GOAL for this conversation (keep working until it is reached, then print HARBOR_GOAL_DONE):\n${o.goal}`);
  if (o.history?.length) parts.push(`Conversation so far (your earlier session is not available):\n${historyText(o.history)}`);
  if (agents.length) parts.push(`Helpers you started (authoritative; persisted by Harbor):\n${registerText(agents)}`);
  if (o.notes?.length) parts.push(`Recent notes:\n${o.notes.map((e) => `- ${e}`).join('\n')}`);
  if (t.kind === 'user') {
    parts.push(`User:\n${t.text}`);
    if (t.images?.length) parts.push(`The user attached ${t.images.length} image(s) to this message (this turn only). Look at them with your file-reading tool:\n${t.images.map((p) => `- ${p}`).join('\n')}`);
  } else if (t.kind === 'goal') {
    parts.push(`Automatic continuation ${t.continuation} of ${t.max}: continue toward the goal. Do the next concrete step. If the goal is fully reached, end with HARBOR_GOAL_DONE; if you need the user, use HARBOR_ASK.`);
  } else if (t.kind === 'reports') {
    parts.push('Helper reports (not independently verified unless a reviewer says so):\n' +
      t.items.map((a) => `### ${a.title} (id=${a.id}, role=${a.role}, state=${a.state}${a.branch ? `, branch=${a.branch}` : ''}${a.headCommit ? `, commit=${a.headCommit.slice(0, 10)}` : ''})\n${evidenceText(a)}${clip(a.report ?? a.error ?? '(no report)', REPORT_CHARS)}`).join('\n\n'));
    parts.push('Decide the next step: delegate follow-up work, do it yourself, or if everything is finished write a concise summary for the user with evidence, saying what was and was not verified.');
  } else {
    parts.push(`Help request from helper "${t.from.title}" (id=${t.from.id}, blocked=${t.blocked}):\nreason: ${t.reason}\nproposed role: ${t.proposedRole}\nrequested work: ${t.instructions}\nDecide: delegate another helper (set helpFor to ${t.from.id}), do it yourself, or answer in plain text.`);
  }
  return parts.join('\n\n');
}

/** Reports are compressed before they reach the lead: the lead's context is the expensive part. */
const REPORT_CHARS = 6000;

export function registerText(agents: AgentRecord[]): string {
  const subs = agents.filter((a) => a.role !== 'main');
  if (!subs.length) return '(none)';
  return subs.map((a) => {
    const deps = a.dependsOn.length ? ` dependsOn=[${a.dependsOn.join(',')}]` : '';
    // The helper's own summary line beats the first 300 characters of its report (often preamble).
    const sum = a.result?.summary || a.report || a.summary || a.error;
    const result = a.result ? ` outcome=${a.result.outcome}${a.result.verdict ? ` verdict=${a.result.verdict}` : ''}` : '';
    const checks = a.checks?.length ? ` harborChecks=${a.checks.every((c) => c.ok) ? 'pass' : 'FAIL'}` : '';
    return `- id=${a.id} role=${a.role} state=${a.state} title="${a.title}"${deps}${a.branch ? ` branch=${a.branch}` : ''}${result}${checks}${sum ? ` report="${clip(sum, 300)}"` : ''}`;
  }).join('\n');
}

/** What is known about a helper's work beyond its prose: Harbor's own check runs, then its self-reported result. */
export function evidenceText(a: AgentRecord): string {
  const lines: string[] = [];
  if (a.checks?.length) {
    lines.push(`Checks Harbor ran on ${a.testedCommit?.slice(0, 10) ?? 'the branch'}: ${a.checks.map((c) => `${c.cmd} ${c.ok ? 'PASS' : `FAIL${c.timedOut ? ' (timed out)' : ` (exit ${c.exitCode})`}`}`).join('; ')}`);
  }
  if (a.result) {
    const self = a.result.checks.length ? `; self-reported checks: ${a.result.checks.map((c) => `${c.cmd} ${c.ok ? 'pass' : 'fail'}`).join(', ')}` : '';
    lines.push(`Result: outcome=${a.result.outcome}${a.result.verdict ? `, verdict=${a.result.verdict}` : ''}${self}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** Long messages keep their start and their end: conclusions usually come last. The latest exchange gets more room. */
export function historyText(history: Message[]): string {
  const msgs = history.filter((m) => m.role === 'user' || m.role === 'assistant');
  return msgs.map((m, i) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clipMiddle(m.text, i >= msgs.length - 2 ? 2000 : 600)}`).join('\n');
}

// ---------------------------------------------------------------- subagents

export const ROLE_CONTRACTS: Record<Exclude<AgentRole, 'main'>, string> = {
  planner: `You are a PLANNER helper with one responsibility: think through the assigned task and write a specification. Do NOT modify files and do NOT implement. Read the repository as needed.
Final answer format (markdown): ## Goal, ## Specification (precise behavior, files and interfaces), ## Acceptance criteria, ## Risks and open questions.`,
  implementer: `You are an IMPLEMENTER helper with one responsibility: implement the assigned work exactly. No scope expansion, no architectural invention. Work only inside your worktree, commit your work to the current branch, and run only the narrow checks the assignment asks for.
If a design question is unresolved, stop and ask (see protocol). Final answer: what changed (files), checks run and their results, unresolved issues.`,
  reviewer: `You are a REVIEWER helper with one responsibility: review the referenced change against its goal. Do NOT modify files. Final answer: findings ordered by severity with evidence (file:line), and a clear verdict (approve / changes requested). State exactly which version (branch/commit) you reviewed.`,
  other: `You are a focused helper with one responsibility, stated in your assignment. Stay within it. Final answer: findings or results with evidence, and anything unresolved.`
};

export const PROTOCOL = `If the project root contains AGENTS.md, read it first and follow its conventions and ownership rules.
Coordination protocol (print each on its own line, exactly this format, when needed):
HARBOR_REQUEST_HELP: {"reason":"...","proposedRole":"planner|implementer|reviewer|other","instructions":"<single responsibility>","blocked":true|false}
HARBOR_ASK: {"question":"<one clear question for the user>","options":["<short choice>", ...],"allowText":true|false}
HARBOR_RESULT: {"outcome":"done|partial|blocked","summary":"<at most two sentences>","verdict":"approve|changes (reviewers only)","checks":[{"cmd":"<command you ran>","ok":true|false}]}
Use HARBOR_ASK only when you cannot continue without the user's decision: it pops up on their screen. Then finish your turn right away (do not guess and carry on); their answer arrives as your next message.
End every final answer with exactly one HARBOR_RESULT line. List only checks you actually ran.
You must NEVER spawn agents yourself, including through native CLI subagent/Task tools or plugins; use HARBOR_REQUEST_HELP instead and the lead decides.`;

export function subagentPrompt(a: AgentRecord, ctx: { projectName: string; upstream: AgentRecord[]; worktreeNote?: string }): string {
  const p = [`Project: ${ctx.projectName}`, `Your assignment (id=${a.id}, revision ${a.revision}): ${a.title}`, `Instructions:\n${a.task}`];
  if (a.spec) p.push(`Specification you must follow:\n${a.spec}`);
  if (a.files?.length) p.push(`Files you own for this assignment: ${a.files.join(', ')}. Do not edit other files; ask for help instead.`);
  if (ctx.worktreeNote) p.push(ctx.worktreeNote);
  if (ctx.upstream.length) p.push('Inputs from earlier assignments:\n' + ctx.upstream.map((u) => {
    const head = `### ${u.title} (${u.role}${u.branch ? `, branch ${u.branch}` : ''}${u.headCommit ? `, commit ${u.headCommit}` : ''}${u.worktree ? `, worktree ${u.worktree}` : ''})`;
    // A reviewer judges the change against what was asked, not against the implementer's own account of it.
    const spec = a.role === 'reviewer' && u.spec ? `\nSpecification it was built against (verbatim):\n${clip(u.spec, 8000)}\n` : '';
    return `${head}${spec}\n${evidenceText(u)}${clip(u.report ?? '(no report)', 5000)}`;
  }).join('\n\n'));
  return p.join('\n\n');
}

export const systemFor = (role: Exclude<AgentRole, 'main'>): string => `${ROLE_CONTRACTS[role]}\n\n${PROTOCOL}`;

// ---------------------------------------------------------------- parsing

const ROLES = new Set(['planner', 'implementer', 'reviewer', 'other']);
const CX = new Set(['low', 'medium', 'high']);
const CLI_IDS = new Set<CliId>(CLI_DEFINITIONS.map((d) => d.id));

/** Pull the first balanced JSON object out of free text (handles code fences and chatter). */
export function extractJson(text: string): unknown | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text].filter((x): x is string => !!x);
  for (const c of candidates) {
    for (let s = c.indexOf('{'); s >= 0; s = c.indexOf('{', s + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let i = s; i < c.length; i++) {
        const ch = c[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { return JSON.parse(c.slice(s, i + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function toAsk(v: unknown): AskRequest | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const question = str(r['question']).trim();
  if (!question) return undefined;
  const options = strs(r['options']).map((o) => o.trim()).filter(Boolean).slice(0, 6);
  return { question: question.slice(0, 600), options, allowText: r['allowText'] === true || !options.length };
}

function toTask(raw: Record<string, unknown>, i: number, seen: Set<string>): PlannedTask | undefined {
  const sources = raw['role'] === 'integrator' ? [...new Set(strs(raw['sources']).map((s) => s.trim()).filter(Boolean))] : [];
  if (raw['role'] === 'integrator' && !sources.length) return undefined;
  const instructions = str(raw['instructions']).trim() || (sources.length ? `Merge the approved branches of ${sources.join(', ')}.` : '');
  if (!instructions) return undefined;
  let ref = str(raw['ref'], `t${i + 1}`) || `t${i + 1}`;
  while (seen.has(ref)) ref += '_';
  seen.add(ref);
  if (sources.length) {
    // An integrator is not a new role: it is an edit helper ("other") that Harbor runs itself.
    const target = str(raw['target']).trim() || undefined;
    return {
      ref, role: 'other', access: 'edit', instructions, title: str(raw['title'], `Integrate ${sources.length} branch${sources.length > 1 ? 'es' : ''}`).slice(0, 80),
      complexity: 'low', needs: [], dependsOn: strs(raw['dependsOn']), files: [], integrate: { sources, target }
    };
  }
  const role = ROLES.has(str(raw['role'])) ? (raw['role'] as PlannedTask['role']) : 'other';
  // Planners and reviewers never edit, whatever the line says.
  const access = role === 'planner' || role === 'reviewer' || raw['access'] === 'read' ? 'read' : 'edit';
  return {
    ref, role, access, instructions,
    title: str(raw['title'], instructions.slice(0, 60)).slice(0, 80),
    complexity: CX.has(str(raw['complexity'])) ? (raw['complexity'] as Complexity) : 'medium',
    needs: asNeeds(raw['needs']),
    dependsOn: strs(raw['dependsOn']), files: strs(raw['files']),
    specFrom: str(raw['specFrom']) || undefined, helpFor: str(raw['helpFor']) || undefined, retryOf: str(raw['retryOf']) || undefined,
    cli: CLI_IDS.has(str(raw['cli'])) ? str(raw['cli']) : undefined
  };
}

export interface HelpRequest { reason: string; proposedRole: string; instructions: string; blocked: boolean }

function toResult(j: Record<string, unknown>): HelperResult | undefined {
  const outcome = str(j['outcome']);
  if (outcome !== 'done' && outcome !== 'partial' && outcome !== 'blocked') return undefined;
  const verdict = str(j['verdict']);
  const checks = (Array.isArray(j['checks']) ? j['checks'] : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>)['cmd'] === 'string')
    .map((c) => ({ cmd: str(c['cmd']).slice(0, 200), ok: c['ok'] === true })).slice(0, 10);
  return { outcome, summary: str(j['summary']).trim().slice(0, 400), verdict: verdict === 'approve' || verdict === 'changes' ? verdict : undefined, checks };
}

const KINDS = 'REQUEST_HELP|ASK|DELEGATE|IMAGE_BRIEF|RESULT|GOAL_DONE';
const LINE = new RegExp(`^\\s*HARBOR_(${KINDS}):\\s*(\\{.*\\})\\s*$`);
const PREFIX = new RegExp(`^\\s*HARBOR_(${KINDS}):`);

export interface Protocol { help: HelpRequest[]; ask: AskRequest[]; delegate: PlannedTask[]; image: ImageBrief[]; result?: HelperResult; goalDone?: { summary: string }; malformed: string[] }

/** Scan agent output for protocol lines. Malformed lines are hidden by stripProtocol and returned so they can be reported. */
export function parseProtocol(text: string): Protocol {
  const out: Protocol = { help: [], ask: [], delegate: [], image: [], malformed: [] };
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!PREFIX.test(line)) continue;
    const m = line.match(LINE);
    let j: Record<string, unknown> | undefined;
    try { j = m ? JSON.parse(m[2]!) : undefined; } catch { j = undefined; }
    if (!m || !j || typeof j !== 'object') { out.malformed.push(clip(line.trim(), 300)); continue; }
    let ok = true;
    if (m[1] === 'REQUEST_HELP') out.help.push({ reason: str(j['reason']), proposedRole: str(j['proposedRole'], 'other'), instructions: str(j['instructions']), blocked: j['blocked'] !== false });
    else if (m[1] === 'ASK') { const a = toAsk(j); if (a) out.ask.push(a); else ok = false; }
    else if (m[1] === 'DELEGATE') {
      if (out.delegate.length >= MAX_TASKS_PER_TURN) ok = false;
      else { const t = toTask(j, out.delegate.length, seen); if (t) out.delegate.push(t); else ok = false; }
    } else if (m[1] === 'RESULT') { const r = toResult(j); if (r) out.result = r; else ok = false; }
    else if (m[1] === 'GOAL_DONE') out.goalDone = { summary: str(j['summary']).trim().slice(0, 600) };
    else if (str(j['prompt']).trim()) out.image.push({ subject: str(j['subject']), style: str(j['style']), prompt: str(j['prompt']).trim(), notes: str(j['notes']) });
    else ok = false;
    if (!ok) out.malformed.push(clip(line.trim(), 300));
  }
  return out;
}

export const stripProtocol = (text: string): string => text.split(/\r?\n/).filter((l) => !PREFIX.test(l) && !/^\s*HARBOR_PEER:/.test(l)).join('\n').trim();

/** Chat rendering of an image brief: Harbor cannot generate images, so the user pastes the prompt into a generator. */
export function imageBriefText(b: ImageBrief): string {
  const fence = '```';
  const parts = ["I can't generate images myself. Paste this into an image generator:"];
  if (b.subject) parts.push(`**Subject:** ${b.subject}`);
  if (b.style) parts.push(`**Style:** ${b.style}`);
  parts.push(`${fence}text\n${b.prompt}\n${fence}`);
  if (b.notes) parts.push(b.notes);
  return parts.join('\n\n');
}

export function clip(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}… [truncated]` : s; }

export function clipMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = Math.floor(n / 3);
  return `${s.slice(0, head)} … [${s.length - n} chars omitted] … ${s.slice(s.length - (n - head))}`;
}
