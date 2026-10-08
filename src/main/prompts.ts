import type { AgentRole, Id } from '../shared/api';
import type { Complexity } from './router';
import type { AgentRecord } from './types';

// ---------------------------------------------------------------- main agent

export interface PlannedTask {
  /** Local reference used by other tasks in the same plan (dependsOn / specFrom). */
  ref: string;
  title: string;
  role: Exclude<AgentRole, 'main'>;
  instructions: string;
  complexity: Complexity;
  dependsOn: string[];
  files: string[];
  specFrom?: string;
  /** Existing agent that asked for this help (sibling request flow). */
  helpFor?: Id;
}

export interface MainOutput { reply: string; tasks: PlannedTask[]; parsed: boolean }

export const MAX_TASKS_PER_PLAN = 8;

export const MAIN_SYSTEM = `You are the MAIN AGENT of a software project in Harbor. You only coordinate: you assign work, monitor subagents, receive their reports, and keep the user informed.
You MUST NOT write code, investigate the codebase, design features, run checks, review, or integrate. You do not use tools. If anything substantive is needed, assign a subagent.

Roles you can assign (one responsibility each):
- planner: thinks through ONE feature/task and returns a written specification, acceptance criteria and proposed assignments. Never implements.
- implementer: implements ONE bounded change strictly from a specification. Works in its own git worktree.
- reviewer: reviews a defined change against its specification (read-only).
- other: investigation, testing, or integration with a single stated responsibility.

Rules:
- Anything beyond a clear, small, fully specified change starts with a planner. When a planner's report arrives, assign implementers and set "specFrom" to the planner's task ref or agent id so the spec is passed verbatim.
- A clear small edit may go straight to one implementer (put the precise spec in "instructions").
- Questions about status are answered from the register below with no tasks.
- Reviewers/testers depend on the implementer they check (use "dependsOn").
- Subagents never create agents. When one asks for help, you decide whether to assign a sibling.
- Never promise results are verified unless a reviewer/tester report says so.

Reply with ONE JSON object and nothing else:
{"reply": "<short message to the user>", "tasks": [{"ref":"t1","title":"<short imperative>","role":"planner|implementer|reviewer|other","instructions":"<what to do and the deliverable>","complexity":"low|medium|high","dependsOn":["<ref or agent id>"],"files":["<paths the task will edit>"],"specFrom":"<ref or agent id, optional>","helpFor":"<agent id, optional>"}]}
Use "tasks": [] when nothing needs to be assigned.`;

export const ROLE_CONTRACTS: Record<Exclude<AgentRole, 'main'>, string> = {
  planner: `You are a PLANNER subagent with one responsibility: think through the assigned task and write a specification. Do NOT modify files and do NOT implement. Read the repository as needed.
Final answer format (markdown): ## Goal, ## Specification (precise behavior, files and interfaces), ## Acceptance criteria, ## Proposed assignments (one per implementer, each with the files it owns and its dependencies), ## Risks and open questions.`,
  implementer: `You are an IMPLEMENTER subagent with one responsibility: implement the assigned specification exactly. No separate planning, no scope expansion, no architectural invention. Work only inside your worktree, commit your work to the current branch, and run only the narrow checks that the specification asks for.
If a design question is unresolved, stop and ask (see protocol). Final answer: what changed (files), checks run and their results, unresolved issues.`,
  reviewer: `You are a REVIEWER subagent with one responsibility: review the referenced change against its specification. Do NOT modify files. Final answer: findings ordered by severity with evidence (file:line), and a clear verdict (approve / changes requested). State exactly which version (branch/commit) you reviewed.`,
  other: `You are a focused subagent with one responsibility, stated in your assignment. Stay within it. Final answer: findings or results with evidence, and anything unresolved.`
};

export const PROTOCOL = `If the project root contains AGENTS.md, read it first and follow its conventions and ownership rules.
Coordination protocol (print each on its own line, exactly this format, when needed):
HARBOR_REQUEST_HELP: {"reason":"...","proposedRole":"planner|implementer|reviewer|other","instructions":"<single responsibility>","blocked":true|false}
HARBOR_PEER: {"to":"<sibling agent title or id>","text":"<short message>"}
You can talk normally with the user and siblings. You must NEVER spawn agents yourself, including through native CLI subagent/Task tools or plugins; use HARBOR_REQUEST_HELP instead.`;

export function registerText(agents: AgentRecord[]): string {
  const subs = agents.filter((a) => a.role !== 'main');
  if (!subs.length) return '(no assignments yet)';
  return subs.map((a) => {
    const deps = a.dependsOn.length ? ` dependsOn=[${a.dependsOn.join(',')}]` : '';
    const sum = a.report ?? a.summary ?? a.error;
    return `- id=${a.id} role=${a.role} state=${a.state} rev=${a.revision} title="${a.title}"${deps}${a.branch ? ` branch=${a.branch}` : ''}${sum ? ` report="${clip(sum, 400)}"` : ''}`;
  }).join('\n');
}

export type MainTrigger =
  | { kind: 'user'; text: string }
  | { kind: 'reports'; items: { agent: AgentRecord }[] }
  | { kind: 'help'; from: AgentRecord; reason: string; proposedRole: string; instructions: string; blocked: boolean };

export function mainPrompt(projectName: string, agents: AgentRecord[], t: MainTrigger, extra: string[] = []): string {
  const parts = [`Project: ${projectName}`, `Assignment register (authoritative; persisted by Harbor):\n${registerText(agents)}`];
  if (extra.length) parts.push(`Recent notes:\n${extra.map((e) => `- ${e}`).join('\n')}`);
  if (t.kind === 'user') parts.push(`New message from the user:\n${t.text}`);
  else if (t.kind === 'reports') {
    parts.push('Subagent reports received (not independently verified unless a reviewer/tester says so):\n' +
      t.items.map(({ agent: a }) => `### ${a.title} (id=${a.id}, role=${a.role}, state=${a.state}, rev=${a.revision})\n${clip(a.report ?? a.error ?? '(no report)', 24000)}`).join('\n\n'));
    parts.push('Decide the next step: assign follow-up work (e.g. implementers from a planner spec, reviewers for finished changes), or if all work is finished, write a concise summary for the user that keeps sources and evidence and says what was and was not verified.');
  } else {
    parts.push(`Help request from "${t.from.title}" (id=${t.from.id}, blocked=${t.blocked}):\nreason: ${t.reason}\nproposed role: ${t.proposedRole}\nrequested work: ${t.instructions}\nDecide: assign a sibling (set helpFor to ${t.from.id}), or answer in "reply" if no new agent is warranted.`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- subagents

export function subagentPrompt(a: AgentRecord, ctx: { projectName: string; upstream: AgentRecord[]; siblings: AgentRecord[]; mailbox: string[]; worktreeNote?: string }): string {
  const p = [`Project: ${ctx.projectName}`, `Your assignment (id=${a.id}, revision ${a.revision}): ${a.title}`, `Instructions:\n${a.task}`];
  if (a.spec) p.push(`Specification you must follow:\n${a.spec}`);
  if (a.files?.length) p.push(`Files you own for this assignment: ${a.files.join(', ')}. Do not edit other files; ask for help instead.`);
  if (ctx.worktreeNote) p.push(ctx.worktreeNote);
  if (ctx.upstream.length) p.push('Inputs from earlier assignments:\n' + ctx.upstream.map((u) => `### ${u.title} (${u.role}${u.branch ? `, branch ${u.branch}` : ''}${u.worktree ? `, worktree ${u.worktree}` : ''})\n${clip(u.report ?? '(no report)', 5000)}`).join('\n\n'));
  const sibs = ctx.siblings.filter((s) => s.id !== a.id && s.state !== 'done' && s.state !== 'failed' && s.state !== 'stopped');
  if (sibs.length) p.push('Active siblings (message with HARBOR_PEER):\n' + sibs.map((s) => `- ${s.title} (id=${s.id}, ${s.role}) files: ${(s.files ?? []).join(', ') || 'n/a'}`).join('\n'));
  if (ctx.mailbox.length) p.push('Messages delivered to you:\n' + ctx.mailbox.map((m) => `- ${m}`).join('\n'));
  return p.join('\n\n');
}

export const systemFor = (role: Exclude<AgentRole, 'main'>): string => `${ROLE_CONTRACTS[role]}\n\n${PROTOCOL}`;

// ---------------------------------------------------------------- parsing

const ROLES = new Set(['planner', 'implementer', 'reviewer', 'other']);
const CX = new Set(['low', 'medium', 'high']);

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

export function parseMainOutput(text: string): MainOutput {
  const j = extractJson(text) as Record<string, unknown> | undefined;
  if (!j || typeof j !== 'object' || (!('reply' in j) && !('tasks' in j))) return { reply: text.trim(), tasks: [], parsed: false };
  const tasks: PlannedTask[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of (Array.isArray(j['tasks']) ? (j['tasks'] as Record<string, unknown>[]) : []).entries()) {
    if (!raw || typeof raw !== 'object' || tasks.length >= MAX_TASKS_PER_PLAN) continue;
    let ref = str(raw['ref'], `t${i + 1}`) || `t${i + 1}`;
    while (seen.has(ref)) ref += '_';
    seen.add(ref);
    const role = ROLES.has(str(raw['role'])) ? (raw['role'] as PlannedTask['role']) : 'other';
    const instructions = str(raw['instructions']).trim();
    if (!instructions) continue;
    tasks.push({
      ref, role, instructions,
      title: str(raw['title'], instructions.slice(0, 60)).slice(0, 80),
      complexity: CX.has(str(raw['complexity'])) ? (raw['complexity'] as Complexity) : 'medium',
      dependsOn: strs(raw['dependsOn']), files: strs(raw['files']),
      specFrom: str(raw['specFrom']) || undefined, helpFor: str(raw['helpFor']) || undefined
    });
  }
  return { reply: str(j['reply']).trim(), tasks, parsed: true };
}

export interface HelpRequest { reason: string; proposedRole: string; instructions: string; blocked: boolean }
export interface PeerMessage { to: string; text: string }

/** Scan agent output for protocol lines. */
export function parseProtocol(text: string): { help: HelpRequest[]; peer: PeerMessage[] } {
  const help: HelpRequest[] = [], peer: PeerMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*HARBOR_(REQUEST_HELP|PEER):\s*(\{.*\})\s*$/);
    if (!m) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(m[2]!); } catch { continue; }
    if (m[1] === 'REQUEST_HELP') help.push({ reason: str(j['reason']), proposedRole: str(j['proposedRole'], 'other'), instructions: str(j['instructions']), blocked: j['blocked'] !== false });
    else if (str(j['to']) && str(j['text'])) peer.push({ to: str(j['to']), text: str(j['text']) });
  }
  return { help, peer };
}

export const stripProtocol = (text: string): string => text.split(/\r?\n/).filter((l) => !/^\s*HARBOR_(REQUEST_HELP|PEER):/.test(l)).join('\n').trim();

export function clip(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}… [truncated]` : s; }
