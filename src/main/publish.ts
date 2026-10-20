import type { Id, Project, PullRequestDraft, PushPreview, PushResult } from '../shared/api';
import type { Git } from './git';
import type { GitHub } from './github';
import { applyAllowlist, findingsFingerprint, scanDiff } from './secretScan';
import { effectiveSettings, type Store } from './store';

export interface PublishDeps {
  git: Git;
  gh: GitHub;
  store: Store;
  /** A system line in a conversation of the project (so the lead and the owner see what was published). */
  notify: (projectId: Id, branch: string, text: string) => void;
}

/** git's well-known empty tree: the "before" of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LIVE = ['queued', 'working', 'waiting'];

export interface PushPlan extends PushPreview { head: string; resolved: string }

/** What a push of `branch` would do: remote, commits, default-branch flag, and a secret scan of exactly those commits. Read-only. */
export async function planPush(project: Project, branch: string, d: PublishDeps): Promise<PushPlan> {
  const { git } = d, repo = project.path;
  const name = await git.resolveBranch(repo, branch);
  if (!name) throw new Error(`The branch ${branch} does not exist in this project.`);
  const head = (await git.branchHead(repo, name))!;
  const remote = (await git.remoteUrl(repo)) ? 'origin' : undefined;
  const ab = await git.aheadBehind(repo, name);
  const commits = await git.commitsToPush(repo, name, ab.upstream);
  const base = await git.defaultBranch(repo);
  const isDefaultBranch = git.sameBranch(base, name);

  const allowlist = effectiveSettings(d.store.getSettings(), project.id).secretAllowlist;
  const kept: { type: string; file: string; line: number }[] = [];
  let keptTotal = 0, allowedCount = 0, truncated = false, failed = false;
  // Per commit, so a secret added and then removed again in a later commit (still in the pushed history) is found too.
  for (const c of commits) {
    const parent = (await git.parents(repo, c.hash))[0] ?? EMPTY_TREE;
    const s = await git.diffForScan(repo, parent, c.hash);
    if (s.failed) { failed = true; continue; }
    if (s.truncated) truncated = true;
    const scan = scanDiff(s.diff);
    const split = applyAllowlist(scan.findings, allowlist);
    keptTotal += scan.total - split.allowed.length; allowedCount += split.allowed.length;
    for (const f of split.kept) kept.push({ type: f.type, file: f.file, line: f.line });
  }
  const live = d.store.listAgentRecords(project.id).some((a) => a.branch !== undefined && git.sameBranch(a.branch, name) && (LIVE.includes(a.state)));
  const onCheckout = git.sameBranch(await git.currentBranch(repo), name) && d.store.listConversations(project.id).some((c) => !!c.activity && LIVE.includes(c.activity.state));
  return {
    branch: name, ...(remote ? { remote } : {}), ...(ab.upstream ? { upstream: ab.upstream } : {}), ahead: ab.ahead, behind: ab.behind, isDefaultBranch,
    commits, needsRemote: !remote, ...(live || onCheckout ? { busy: true } : {}), head, resolved: name,
    secretScan: { findings: kept.slice(0, 50), total: keptTotal, allowed: allowedCount, ...(kept.length ? { fingerprint: findingsFingerprint(head, kept.map((f) => ({ ...f, type: f.type as never }))) } : {}), ...(truncated ? { truncated } : {}), ...(failed ? { failed } : {}) }
  };
}

const strip = ({ head: _h, resolved: _r, ...rest }: PushPlan): PushPreview => rest;
export const previewPush = async (project: Project, branch: string, d: PublishDeps): Promise<PushPreview> => strip(await planPush(project, branch, d));

/** Push one branch with plain `git push`. Every refusal says what to do instead. */
export async function pushBranch(project: Project, branch: string, o: { setUpstream?: boolean; allowDefaultBranch?: boolean; secretOverride?: string } | undefined, d: PublishDeps): Promise<PushResult> {
  const plan = await planPush(project, branch, d);
  if (!plan.remote) throw new Error('This project has no remote yet. Add one (Set remote) or create a GitHub repository first.');
  if (plan.isDefaultBranch && o?.allowDefaultBranch !== true) throw new Error(`${plan.branch} is the default branch. Pushing it needs an explicit confirmation naming the commits.`);
  if (plan.busy) throw new Error(`An agent is still working on ${plan.branch}. Stop it or wait until it finishes, then push.`);
  if (!plan.commits.length && plan.upstream) return { ok: true, output: 'Already up to date with the remote.', remote: plan.remote, branch: plan.branch };
  const scan = plan.secretScan;
  if (scan?.failed) throw new Error('The secret scan could not read all commits, so nothing was pushed. Try again.');
  if (scan?.findings.length && scan.fingerprint !== o?.secretOverride) {
    throw new Error(`The secret scan found ${scan.findings.length} possible secret${scan.findings.length === 1 ? '' : 's'} in the commits to push (${scan.findings.slice(0, 3).map((f) => `${f.type} at ${f.file}${f.line > 0 ? `:${f.line}` : ''}`).join('; ')}). Remove them, add the path to the secret allowlist, or confirm the exact findings to push anyway.`);
  }
  const r = await d.git.push(project.path, plan.remote, plan.branch, { setUpstream: o?.setUpstream ?? !plan.upstream });
  if (!r.ok) return { ok: false, output: r.output, remote: plan.remote, branch: plan.branch };
  const n = plan.commits.length;
  const text = `Pushed ${plan.branch} to ${plan.remote}${n ? `, ${n} commit${n === 1 ? '' : 's'}` : ''}.`;
  d.store.addCoordination({ projectId: project.id, kind: 'handoff', text });
  d.notify(project.id, plan.branch, text);
  return { ok: true, output: r.output, remote: plan.remote, branch: plan.branch };
}

/** Push the branch if the remote lacks commits, then open the pull request. The base defaults to the repository's default branch. */
export async function createPullRequest(project: Project, draft: PullRequestDraft, d: PublishDeps): Promise<{ url: string }> {
  const plan = await planPush(project, draft.branch, d);
  const base = draft.base?.trim() || (await d.git.defaultBranch(project.path)) || 'main';
  if (d.git.sameBranch(base, plan.branch)) throw new Error('A pull request needs a branch other than its base. Pick a harbor/* branch.');
  if (plan.isDefaultBranch) throw new Error('Open a pull request from a working branch, not the default branch.');
  if (!plan.remote) throw new Error('This project has no remote yet. Add one (Set remote) or create a GitHub repository first.');
  if (plan.ahead > 0 || !plan.upstream) {
    const r = await pushBranch(project, plan.branch, undefined, d);
    if (!r.ok) throw new Error(r.output);
  }
  const out = await d.gh.createPr({ cwd: project.path, head: plan.branch, base, title: draft.title.trim(), ...(draft.body ? { body: draft.body } : {}), ...(draft.draft ? { draft: true } : {}) });
  if (!out.ok) throw new Error(out.message);
  d.notify(project.id, plan.branch, `Opened a pull request for ${plan.branch}: ${out.value.url}`);
  return { url: out.value.url };
}
