import type { Id, MergePullRequestOptions, MergePullRequestResult, Project, PullRequestStatus, ReleaseTagDraft, ReleaseTagPreview, ReleaseTagResult } from '../shared/api';
import { tagNameProblem, type Git } from './git';
import { failedRunIds, plainBranch, type GitHub } from './github';
import type { Store } from './store';

/**
 * Publish, part two (contract 0.1.56-0.1.59): pull request status, re-running failed checks, merging a pull request and release tags.
 * Everything external goes through the injected `gh` wrapper and `Git`. Harbor never forces, never deletes a tag or a branch, never
 * passes `--admin`, and a tag is only pushed when its commit is already on a remote branch (so the branch push's secret scan stays the
 * only way history reaches the remote).
 */
export interface PrDeps {
  git: Git;
  gh: GitHub;
  store: Store;
  /** A system line in a conversation of the project (so the lead and the owner see what happened). */
  notify: (projectId: Id, text: string) => void;
}

const METHODS = ['merge', 'squash', 'rebase'];

function branchOf(branch: string): string {
  if (!plainBranch(branch)) throw new Error('Choose a branch.');
  return branch.trim();
}

/** The branch's pull request and checks (read-only); null when it has none. */
export async function pullRequestStatus(project: Project, branch: string, d: PrDeps): Promise<PullRequestStatus | null> {
  const out = await d.gh.prStatus({ cwd: project.path, branch: branchOf(branch) });
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

/** Restarts the workflow runs behind failed checks (`gh run rerun --failed`). Reads the checks again first: the run ids come from GitHub, never from the caller. */
export async function rerunFailedChecks(project: Project, branch: string, d: PrDeps): Promise<{ rerun: number }> {
  const status = await pullRequestStatus(project, branch, d);
  if (!status) throw new Error('This branch has no pull request.');
  if (status.state !== 'open') throw new Error(`The pull request is already ${status.state}; there is nothing to re-run.`);
  const ids = failedRunIds(status.checks.items);
  if (!ids.length) throw new Error('No failed check belongs to a workflow run that can be re-run.');
  const out = await d.gh.rerunFailed({ cwd: project.path, runIds: ids });
  if (!out.ok) throw new Error(out.message);
  d.notify(project.id, `Re-ran the failed checks of pull request #${status.number} (${out.value.rerun} workflow run${out.value.rerun === 1 ? '' : 's'}).`);
  return out.value;
}

/**
 * Merge a pull request. Harbor reads the pull request again right before merging and refuses unless it is open, not a draft, not
 * conflicting, not blocked, and (unless `overrideChecks`) green. The caller must repeat the number (the confirmation names the PR).
 */
export async function mergePullRequest(project: Project, o: MergePullRequestOptions, d: PrDeps): Promise<MergePullRequestResult> {
  if (!o || typeof o !== 'object') throw new Error('Choose a pull request to merge.');
  if (!METHODS.includes(o.method)) throw new Error('Choose merge, squash or rebase.');
  if (!Number.isInteger(o.number) || o.number < 1) throw new Error('The pull request number is not valid.');
  if (o.confirmNumber !== o.number) throw new Error(`Confirm by repeating the pull request number (#${o.number}).`);
  const status = await pullRequestStatus(project, o.branch, d);
  if (!status) throw new Error('This branch has no pull request.');
  if (status.number !== o.number) throw new Error(`The pull request for this branch is #${status.number}, not #${o.number}. Reload and check which one you mean to merge.`);
  if (!status.canMerge) {
    if (!status.checksOverridable) throw new Error(`Harbor will not merge #${status.number}: ${status.blockers.join(' ')}`);
    if (o.overrideChecks !== true) throw new Error(`#${status.number} is not green: ${status.blockers.join(' ')} Merging anyway needs an explicit override.`);
  }
  const out = await d.gh.mergePr({ cwd: project.path, number: status.number, method: o.method });
  if (!out.ok) throw new Error(out.message);
  const text = `Merged pull request #${status.number} "${status.title}" into ${status.base} (${o.method}${status.canMerge ? '' : ', checks overridden'}).`;
  d.store.addCoordination({ projectId: project.id, kind: 'handoff', text });
  d.notify(project.id, text);
  return { merged: true, url: out.value.url ?? status.url, message: out.value.message };
}

const SEMVER = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

/** The next patch version after the highest vX.Y.Z tag, keeping that tag's `v` prefix. Undefined when no tag looks like a version. */
export function suggestNextTag(tags: readonly string[]): string | undefined {
  let best: { v: string; n: [number, number, number] } | undefined;
  for (const t of tags) {
    const m = SEMVER.exec(t);
    if (!m) continue;
    const n: [number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (!best || n[0] > best.n[0] || (n[0] === best.n[0] && (n[1] > best.n[1] || (n[1] === best.n[1] && n[2] > best.n[2])))) best = { v: m[1]!, n };
  }
  return best ? `${best.v}${best.n[0]}.${best.n[1]}.${best.n[2] + 1}` : undefined;
}

export async function previewReleaseTag(project: Project, d: PrDeps): Promise<ReleaseTagPreview> {
  const { git } = d, repo = project.path;
  const remote = (await git.remoteUrl(repo)) ? 'origin' : undefined;
  const defaultBranch = await git.defaultBranch(repo);
  const head = defaultBranch ? await git.resolveCommit(repo, defaultBranch) : undefined;
  const recent = await git.tags(repo, 10);
  const suggested = suggestNextTag(await git.tags(repo, 200));
  return {
    ...(remote ? { remote } : {}), ...(defaultBranch ? { defaultBranch } : {}), ...(head ? { head, headSubject: await git.commitSubject(repo, head) } : {}),
    headOnRemote: !!head && !!remote && await git.isOnRemote(repo, head), recent, ...(suggested ? { suggested } : {})
  };
}

/** `git tag -a` and, when asked, a push of that one tag. Never moves, replaces or deletes a tag. */
export async function createReleaseTag(project: Project, draft: ReleaseTagDraft, d: PrDeps): Promise<ReleaseTagResult> {
  const { git } = d, repo = project.path;
  if (!draft || typeof draft !== 'object') throw new Error('Name the tag.');
  const problem = tagNameProblem(draft.name);
  if (problem) throw new Error(problem);
  if (draft.message !== undefined && (typeof draft.message !== 'string' || draft.message.length > 500 || draft.message.includes('\0'))) throw new Error('A tag message is at most 500 characters.');
  const ref = draft.ref?.trim() || (await git.defaultBranch(repo));
  if (!ref) throw new Error('This project has no branch to tag yet.');
  const commit = await git.resolveCommit(repo, ref);
  if (!commit) throw new Error(`${ref} does not name a commit in this project.`);
  const remote = (await git.remoteUrl(repo)) ? 'origin' : undefined;
  if (draft.push) {
    if (!remote) throw new Error('This project has no remote yet, so a tag cannot be pushed. Add one first.');
    if (!(await git.isOnRemote(repo, commit))) throw new Error('That commit is not on the remote yet. Push its branch first (Harbor scans for secrets there), then push the tag.');
  }
  const made = await git.createTag(repo, draft.name, draft.message?.trim() || draft.name, commit);
  if (!made.ok) throw new Error(made.error ?? 'The tag was not created.');
  let pushed = false, output: string | undefined;
  if (draft.push) {
    const r = await git.pushTag(repo, remote!, draft.name);
    pushed = r.ok;
    if (!r.ok) output = `The tag ${draft.name} was created here but not pushed: ${r.output}`;
  }
  const text = `Created tag ${draft.name} at ${commit.slice(0, 7)}${pushed ? ' and pushed it' : ''}.`;
  d.store.addCoordination({ projectId: project.id, kind: 'handoff', text });
  d.notify(project.id, text);
  return { name: draft.name, commit, pushed, ...(output ? { output } : {}) };
}
