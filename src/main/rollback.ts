import type { AgentState, GitFileChange, Id, RollbackDependent, RollbackLaterCommit, RollbackPreview } from '../shared/api';
import type { Git } from './git';
import type { AgentRecord } from './types';

/**
 * Task-scoped rollback, read-only half: which merge commits brought a task onto a branch, and what reverting them would
 * touch. A task is reversed only through its merge commits (git objects), never by re-applying a recorded patch.
 * Nothing here moves a ref or touches the index or a working tree; the simulation writes unreferenced objects only.
 */

export type RollbackGit = Pick<Git, 'isRepoWithCommits' | 'currentBranch' | 'branchHead' | 'isAncestor' | 'mergeCommits' | 'changes' | 'mergeTree' | 'commitTree' | 'commitsTouching' | 'branchesContaining'>;

export interface RollbackContext {
  git: RollbackGit;
  repo: string;
  /** Every agent record of the project (integrators carry the merge attribution). */
  agents: AgentRecord[];
}

/** A merge commit on the target that brought `source`'s work in. `parents[0]` is the target side, `parents[1]` the task side. */
export interface TaskMerge { commit: string; parents: string[]; source: Id; integrationId?: Id }

export const EXTERNAL_EFFECTS_NOTE = 'External effects (deploys, sent messages, pushes) are not undone by a file rollback.';

const ACTIVE: AgentState[] = ['queued', 'working', 'waiting'];
/** Pathspec limit for the later-commits query (Windows command lines are short). */
const MAX_PATHS = 200;
const MAX_LATER = 30;

const baseOf = (task: AgentRecord): string | undefined => task.integration ? task.integration.base ?? task.baseCommit : task.baseCommit;

/**
 * The task's merges reachable from `targetHead`, newest first. Primary: `IntegrationSource.merge` recorded by Harbor's
 * integrators. Fallback (older or hand-made merges): a merge whose second parent builds on the task's base and is a
 * recorded head of the task or contained in its branch. For an integrator, the merges of all its sources.
 */
export async function findTaskMerges(ctx: RollbackContext, task: AgentRecord, targetHead: string): Promise<TaskMerge[]> {
  const { git, repo, agents } = ctx;
  const base = baseOf(task);
  if (!base) return [];
  const all = await git.mergeCommits(repo, targetHead, [base]);
  const order = new Map(all.map((m, i) => [m.commit, i]));
  const byCommit = new Map(all.map((m) => [m.commit, m]));
  const found = new Map<string, TaskMerge>();

  if (task.integration) {
    for (const s of task.integration.sources) {
      const m = s.merge ? byCommit.get(s.merge) : s.commit ? all.find((x) => x.parents[1] === s.commit) : undefined;
      if (m && !found.has(m.commit)) found.set(m.commit, { ...m, source: s.agentId, integrationId: task.id });
    }
  } else {
    const integrators = agents.filter((a) => a.integration);
    for (const i of integrators) for (const s of i.integration!.sources) {
      const m = s.agentId === task.id && s.merge ? byCommit.get(s.merge) : undefined;
      if (m) found.set(m.commit, { ...m, source: task.id, integrationId: i.id });
    }
    const known = new Set([task.headCommit, ...(task.snapshots ?? []).map((s) => s.head)].filter((x): x is string => !!x));
    const tip = (task.branch ? await git.branchHead(repo, task.branch) : undefined) ?? task.headCommit;
    for (const m of all) {
      const p2 = m.parents[1];
      if (found.has(m.commit) || !p2 || p2 === base) continue;
      if (!known.has(p2) && !(tip && await git.isAncestor(repo, p2, tip))) continue;
      if (tip && await git.isAncestor(repo, m.commit, tip)) continue; // a merge made on the task's own branch
      if (!(await git.isAncestor(repo, base, p2))) continue;
      const via = integrators.find((i) => i.integration!.sources.some((s) => s.agentId === task.id && s.commit === p2));
      found.set(m.commit, { ...m, source: task.id, integrationId: via?.id });
    }
  }
  return [...found.values()].sort((a, b) => order.get(a.commit)! - order.get(b.commit)!);
}

/** Agents whose work relies on the task: waited for it, used its report as spec, or asked for it as help. */
export function relatedAgents(task: AgentRecord, agents: AgentRecord[]): RollbackDependent[] {
  const out: RollbackDependent[] = [];
  for (const a of agents) {
    if (a.id === task.id || a.role === 'main') continue;
    const reason: RollbackDependent['reason'] | undefined = a.dependsOn.includes(task.id) ? 'dependsOn' : a.specFromId === task.id ? 'spec' : task.helpFor === a.id ? 'help' : undefined;
    if (reason) out.push({ agentId: a.id, title: a.title, state: a.state, reason });
  }
  return out;
}

/** The Harbor helper that made `commit`: a recorded head, or a harbor/* branch containing it beyond its base. */
async function ownerOf(ctx: RollbackContext, commit: string): Promise<AgentRecord | undefined> {
  const { git, repo, agents } = ctx;
  const helpers = agents.filter((a) => !a.integration && a.role !== 'main');
  const recorded = helpers.find((a) => a.headCommit === commit || a.snapshots?.some((s) => s.head === commit));
  if (recorded) return recorded;
  for (const b of await git.branchesContaining(repo, commit, 'harbor/')) {
    const a = helpers.find((x) => x.branch === b);
    if (a?.baseCommit && !(await git.isAncestor(repo, commit, a.baseCommit))) return a;
  }
  return undefined;
}

/** Why there is nothing to reverse: the work arrived without a merge commit, or not at all. */
async function noMergeNote(ctx: RollbackContext, task: AgentRecord, target: string, targetHead: string): Promise<string> {
  const { git, repo } = ctx;
  const base = baseOf(task);
  const tips = task.integration
    ? [task.integration.head, ...task.integration.sources.map((s) => s.commit)]
    : [task.headCommit, ...(task.snapshots ?? []).map((s) => s.head), task.branch ? await git.branchHead(repo, task.branch) : undefined];
  for (const t of new Set(tips.filter((x): x is string => !!x && x !== base))) {
    if (await git.isAncestor(repo, t, targetHead)) return `The work of "${task.title}" reached ${target} without a merge commit (fast-forward). Harbor reverses a task only through its merge commits, so it cannot roll this one back as a task.`;
  }
  return `No merge commit of "${task.title}" is on ${target}. If its changes arrived by squash or cherry-pick, Harbor cannot attribute them to the task.`;
}

/**
 * What rolling back `task` on `requested` (default: the checked-out branch) would do. Reverts are simulated newest first
 * with `git merge-tree`, chained through unreferenced commit objects.
 */
export async function previewRollback(ctx: RollbackContext, task: AgentRecord, requested?: string): Promise<RollbackPreview> {
  const { git, repo, agents } = ctx;
  const blockers: string[] = [], notes: string[] = [], conflicts: string[] = [];
  const dependents = relatedAgents(task, agents);
  const out: RollbackPreview = { agentId: task.id, supported: false, merges: [], files: [], laterCommits: [], dependents, clean: null, conflicts, blockers, notes };
  const finish = (): RollbackPreview => {
    if (ACTIVE.includes(task.state)) blockers.unshift(`"${task.title}" is ${task.state}.`);
    for (const d of dependents) if (d.state && ACTIVE.includes(d.state)) blockers.push(`"${d.title}" (${d.reason}) is ${d.state}.`);
    notes.push(EXTERNAL_EFFECTS_NOTE);
    return out;
  };

  if (!(await git.isRepoWithCommits(repo))) { blockers.push('The project folder is not a git repository with commits.'); return finish(); }
  const target = requested?.trim() || await git.currentBranch(repo);
  if (!target) { blockers.push('The project folder has a detached HEAD; name a target branch.'); return finish(); }
  const head = await git.branchHead(repo, target);
  if (!head) { blockers.push(`"${target}" is not an existing local branch.`); return finish(); }
  Object.assign(out, { target, targetHead: head });
  for (const i of agents) {
    if (i.id !== task.id && i.integration && i.state === 'working' && (i.integration.target ?? target) === target) blockers.push(`Integration "${i.title}" is running for ${target}.`);
    if (i.id !== task.id && i.rollback && i.state === 'working' && (i.rollback.target ?? target) === target) blockers.push(`Rollback "${i.title}" is running for ${target}.`);
  }
  if (!baseOf(task)) {
    blockers.push(`"${task.title}" has no recorded base commit, so Harbor cannot tell which commits are its own.`);
    return finish();
  }

  const merges = await findTaskMerges(ctx, task, head);
  if (!merges.length) {
    blockers.push(`No merge of "${task.title}" is on ${target}.`);
    notes.push(await noMergeNote(ctx, task, target, head));
    return finish();
  }
  out.supported = true;
  out.merges = merges.map((m) => ({ commit: m.commit, agentId: m.source, ...(m.integrationId ? { integrationId: m.integrationId } : {}) }));

  // What the reverts would change: union of each merge's diff against its target-side parent.
  const files = new Map<string, GitFileChange>();
  for (const m of merges) for (const f of await git.changes(repo, m.parents[0]!, m.commit)) if (!files.has(f.path)) files.set(f.path, f);
  out.files = [...files.values()];

  // Later work on the same files: on the target, not in the oldest merge, not the task's own commits.
  const paths = [...new Set(out.files.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]))];
  if (paths.length > MAX_PATHS) notes.push(`Later commits were checked for the first ${MAX_PATHS} of ${paths.length} files.`);
  const exclude = [merges[merges.length - 1]!.commit, ...merges.map((m) => m.parents[1]!).filter(Boolean)];
  const later: RollbackLaterCommit[] = [];
  for (const c of await git.commitsTouching(repo, head, exclude, paths.slice(0, MAX_PATHS), MAX_LATER)) {
    const owner = await ownerOf(ctx, c.hash);
    later.push({ hash: c.hash, subject: c.subject, files: c.files, ...(owner ? { agentId: owner.id, agentTitle: owner.title } : {}) });
    if (owner && owner.id !== task.id && !dependents.some((d) => d.agentId === owner.id)) dependents.push({ agentId: owner.id, title: owner.title, state: owner.state, reason: 'overlap' });
  }
  out.laterCommits = later;

  // Simulate the reverts on the target head, newest first: merge-base M, ours = current, theirs = M's target-side parent.
  let cur = head;
  for (const m of merges) {
    const r = await git.mergeTree(repo, m.commit, cur, m.parents[0]!);
    if (r.status === 'conflict') {
      out.clean = false;
      conflicts.push(...r.paths);
      notes.push(`Reverting merge ${m.commit.slice(0, 10)} conflicts with later work on ${target}${r.paths.length ? ` in ${r.paths.join(', ')}` : ''}. Older merges were not simulated.`);
      return finish();
    }
    if (r.status === 'unsupported') {
      notes.push(`The revert could not be simulated (needs git 2.40 or newer for merge-tree --write-tree --merge-base): ${r.message}`);
      return finish();
    }
    const next = await git.commitTree(repo, r.tree, cur, `harbor: rollback preview of ${m.commit}`);
    if (!next) { notes.push('The revert could not be simulated: git commit-tree failed.'); return finish(); }
    cur = next;
  }
  out.clean = true;
  return finish();
}
