import type { GithubRepo, GithubStatus, MergeMethod, PullRequestCheck, PullRequestStatus } from '../shared/api';
import { runProcess, type Runner } from './proc';
import { scanLine } from './secretScan';

/**
 * The `gh` CLI as Harbor uses it: create a repository, open a pull request, ask whether it is signed in. Harbor never reads
 * or stores a credential: gh uses its own keyring login. The pull request body goes to stdin, never argv. Error text is passed
 * through `plainGhMessage`, which drops any line that looks like a secret.
 */
export type GhFailure = 'needs-gh' | 'not-logged-in' | 'name-taken' | 'error';
export type GhOutcome<T> = { ok: true; value: T } | { ok: false; kind: GhFailure; message: string };

/** The one-line fix shown when gh is missing. */
export const GH_INSTALL_HINT = 'Install the GitHub CLI (winget install GitHub.cli), then run `gh auth login`.';
export const GH_LOGIN_HINT = 'Run `gh auth login` in a terminal, then try again.';

const GH_TIMEOUT_MS = 120_000;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Error text of a failed gh call without any line that looks like a key or token, shortened for a message. */
export function plainGhMessage(text: string): string {
  const lines = (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => scanLine(l).length === 0 && !/\bgh[pousr]_[A-Za-z0-9]+|\btoken\b.*:\s*\S{12,}/i.test(l));
  return lines.slice(0, 3).join(' ').slice(0, 400) || 'no details';
}

export class GitHub {
  constructor(private run: Runner = runProcess) {}

  private async gh(args: string[], o: { cwd?: string; input?: string } = {}) {
    return this.run('gh', args, { ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.input !== undefined ? { input: o.input } : {}), timeoutMs: GH_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
  }

  private missing(r: { code: number | null; error?: string; stderr: string }): boolean {
    return r.code === null && /ENOENT|not recognized|cannot find|not found/i.test(`${r.error ?? ''} ${r.stderr}`);
  }

  /** Is gh installed and signed in? Reads only the account name from `gh auth status`; no token is requested. */
  async status(): Promise<GithubStatus> {
    const r = await this.gh(['auth', 'status', '--hostname', 'github.com']);
    if (this.missing(r) || (r.code === null && !r.timedOut)) return { installed: false, loggedIn: false };
    const text = `${r.stdout}\n${r.stderr}`;
    const loggedIn = r.code === 0 && /logged in/i.test(text);
    const account = /account\s+([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(text)?.[1];
    return { installed: true, loggedIn, ...(loggedIn && account ? { account } : {}) };
  }

  private async needGh(): Promise<GhOutcome<never> | undefined> {
    const s = await this.status();
    if (!s.installed) return { ok: false, kind: 'needs-gh', message: `The GitHub CLI (gh) is not installed. ${GH_INSTALL_HINT}` };
    if (!s.loggedIn) return { ok: false, kind: 'not-logged-in', message: `gh is not signed in to GitHub. ${GH_LOGIN_HINT}` };
    return undefined;
  }

  /** `gh repo create` for the local folder, wiring `origin` to it. Never pushes (the caller decides). Returns the repository URL. */
  async createRepo(o: { name: string; visibility: 'private' | 'public'; owner?: string; sourcePath: string }): Promise<GhOutcome<{ url: string; slug: string }>> {
    if (!REPO_NAME.test(o.name) || o.name.startsWith('-') || /^\.+$/.test(o.name)) return { ok: false, kind: 'error', message: 'GitHub repository names use letters, digits, dots, dashes and underscores.' };
    if (o.owner !== undefined && !OWNER_NAME.test(o.owner)) return { ok: false, kind: 'error', message: 'The GitHub owner is not a valid account name.' };
    const blocked = await this.needGh();
    if (blocked) return blocked;
    const slug = o.owner ? `${o.owner}/${o.name}` : o.name;
    const r = await this.gh(['repo', 'create', slug, o.visibility === 'public' ? '--public' : '--private', '--source', o.sourcePath, '--remote', 'origin'], { cwd: o.sourcePath });
    if (r.timedOut) return { ok: false, kind: 'error', message: 'gh timed out while creating the repository. Check whether it exists on GitHub before trying again.' };
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0) {
      if (/already exists|name already|name is already taken/i.test(text)) return { ok: false, kind: 'name-taken', message: `A repository named ${slug} already exists on GitHub. Pick another name or connect it with Set remote.` };
      if (/auth|log ?in|credentials|401/i.test(text)) return { ok: false, kind: 'not-logged-in', message: `gh is not signed in to GitHub. ${GH_LOGIN_HINT}` };
      return { ok: false, kind: 'error', message: `gh could not create the repository: ${plainGhMessage(text)}` };
    }
    const url = /https:\/\/github\.com\/[^\s]+/.exec(text)?.[0];
    return { ok: true, value: { url: url ?? `https://github.com/${slug}`, slug } };
  }

  /** The repositories of the signed-in account (or of `owner`) through `gh repo list`, newest push first. Read-only. */
  async listRepos(o: { owner?: string; limit?: number } = {}): Promise<GhOutcome<GithubRepo[]>> {
    if (o.owner !== undefined && !OWNER_NAME.test(o.owner)) return { ok: false, kind: 'error', message: 'The GitHub owner is not a valid account name.' };
    const limit = Math.min(200, Math.max(1, Math.floor(o.limit ?? 100)));
    const blocked = await this.needGh();
    if (blocked) return blocked;
    const r = await this.gh(['repo', 'list', ...(o.owner ? [o.owner] : []), '--limit', String(limit), '--json', 'nameWithOwner,name,owner,description,isPrivate,isFork,updatedAt,url']);
    if (r.timedOut) return { ok: false, kind: 'error', message: 'gh timed out while listing repositories.' };
    const text = `${r.stdout}
${r.stderr}`;
    if (r.code !== 0) {
      if (/auth|log ?in|credentials|401/i.test(text)) return { ok: false, kind: 'not-logged-in', message: `gh is not signed in to GitHub. ${GH_LOGIN_HINT}` };
      if (/could not resolve|not found|404/i.test(text)) return { ok: false, kind: 'error', message: `GitHub does not know ${o.owner ?? 'that account'}.` };
      return { ok: false, kind: 'error', message: `gh could not list repositories: ${plainGhMessage(text)}` };
    }
    return { ok: true, value: parseRepoList(r.stdout) };
  }

  /** Mapped failure of a gh call that is not about the PR itself (sign-in, timeout, anything else). */
  private failed(r: { stdout: string; stderr: string; timedOut: boolean }, what: string): GhOutcome<never> {
    if (r.timedOut) return { ok: false, kind: 'error', message: `gh timed out ${what}.` };
    const text = `${r.stdout}\n${r.stderr}`;
    if (/auth|log ?in|credentials|401/i.test(text)) return { ok: false, kind: 'not-logged-in', message: `gh is not signed in to GitHub. ${GH_LOGIN_HINT}` };
    return { ok: false, kind: 'error', message: `gh could not ${what}: ${plainGhMessage(text)}` };
  }

  /** The pull request of a branch with its check summary (`gh pr view` + `gh pr checks`, both read-only). Value null = the branch has no pull request. */
  async prStatus(o: { cwd: string; branch: string }): Promise<GhOutcome<PullRequestStatus | null>> {
    if (!plainBranch(o.branch)) return { ok: false, kind: 'error', message: 'The branch name is not a plain name.' };
    const blocked = await this.needGh();
    if (blocked) return blocked;
    const v = await this.gh(['pr', 'view', o.branch, '--json', 'number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefName'], { cwd: o.cwd });
    if (v.code !== 0) {
      if (/no pull requests? found|could not find any pull request|no open pull requests?/i.test(`${v.stdout}\n${v.stderr}`)) return { ok: true, value: null };
      return this.failed(v, 'read the pull request');
    }
    // gh pr checks exits non-zero while checks fail or are pending but still prints the JSON; only the JSON matters here.
    const c = await this.gh(['pr', 'checks', o.branch, '--json', 'name,bucket,workflow,link'], { cwd: o.cwd });
    if (c.timedOut) return this.failed(c, 'read the checks');
    const status = parsePrStatus(v.stdout, c.stdout);
    return status ? { ok: true, value: status } : { ok: false, kind: 'error', message: 'gh answered with something Harbor could not read as a pull request.' };
  }

  /** `gh run rerun <id> --failed` for each run id (digits only, at most 10). Returns how many runs were restarted. */
  async rerunFailed(o: { cwd: string; runIds: readonly string[] }): Promise<GhOutcome<{ rerun: number }>> {
    const ids = [...new Set(o.runIds)].slice(0, 10);
    if (!ids.length || !ids.every((i) => /^\d{1,20}$/.test(i))) return { ok: false, kind: 'error', message: 'There is no failed workflow run to restart.' };
    const blocked = await this.needGh();
    if (blocked) return blocked;
    let rerun = 0;
    for (const id of ids) {
      const r = await this.gh(['run', 'rerun', id, '--failed'], { cwd: o.cwd });
      if (r.code !== 0) return rerun ? { ok: true, value: { rerun } } : this.failed(r, 'restart the failed checks');
      rerun++;
    }
    return { ok: true, value: { rerun } };
  }

  /** `gh pr merge <number> --merge|--squash|--rebase`. Never `--admin`, never `--delete-branch`, never `--auto`; the caller has already checked the PR. */
  async mergePr(o: { cwd: string; number: number; method: MergeMethod }): Promise<GhOutcome<{ url?: string; message: string }>> {
    if (!Number.isInteger(o.number) || o.number < 1) return { ok: false, kind: 'error', message: 'The pull request number is not valid.' };
    const flag = o.method === 'squash' ? '--squash' : o.method === 'rebase' ? '--rebase' : o.method === 'merge' ? '--merge' : undefined;
    if (!flag) return { ok: false, kind: 'error', message: 'Choose merge, squash or rebase.' };
    const blocked = await this.needGh();
    if (blocked) return blocked;
    const r = await this.gh(['pr', 'merge', String(o.number), flag], { cwd: o.cwd });
    if (r.code !== 0) return this.failed(r, 'merge the pull request');
    const text = `${r.stdout}\n${r.stderr}`;
    return { ok: true, value: { ...(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(text) ? { url: /https:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(text)![0] } : {}), message: plainGhMessage(text) } };
  }

  /** `gh pr create` from a branch already on the remote. The body is read from stdin. Returns the pull request URL. */
  async createPr(o: { cwd: string; head: string; base: string; title: string; body?: string; draft?: boolean }): Promise<GhOutcome<{ url: string }>> {
    for (const b of [o.head, o.base]) if (!b || b.startsWith('-') || /[\s:]/.test(b)) return { ok: false, kind: 'error', message: 'The branch names are not plain names.' };
    if (!o.title.trim() || /[\r\n\0]/.test(o.title)) return { ok: false, kind: 'error', message: 'A pull request title is one line.' };
    const blocked = await this.needGh();
    if (blocked) return blocked;
    const r = await this.gh(['pr', 'create', '--head', o.head, '--base', o.base, '--title', o.title, '--body-file', '-', ...(o.draft ? ['--draft'] : [])], { cwd: o.cwd, input: o.body ?? '' });
    if (r.timedOut) return { ok: false, kind: 'error', message: 'gh timed out while opening the pull request.' };
    const text = `${r.stdout}\n${r.stderr}`;
    const url = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(text)?.[0];
    if (r.code === 0 && url) return { ok: true, value: { url } };
    if (url && /already exists/i.test(text)) return { ok: true, value: { url } };
    if (/auth|log ?in|credentials|401/i.test(text)) return { ok: false, kind: 'not-logged-in', message: `gh is not signed in to GitHub. ${GH_LOGIN_HINT}` };
    return { ok: false, kind: 'error', message: `gh could not open the pull request: ${plainGhMessage(text)}` };
  }
}

/** Repositories from `gh repo list --json ...`: tolerant of missing fields, never trusts a url that is not https. */
export function parseRepoList(stdout: string): GithubRepo[] {
  let j: unknown;
  try { j = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(j)) return [];
  const out: GithubRepo[] = [];
  for (const raw of j.slice(0, 200)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const slug = typeof r['nameWithOwner'] === 'string' ? r['nameWithOwner'] : '';
    const name = typeof r['name'] === 'string' ? r['name'] : slug.split('/')[1] ?? '';
    const owner = typeof (r['owner'] as { login?: unknown } | undefined)?.login === 'string' ? (r['owner'] as { login: string }).login : slug.split('/')[0] ?? '';
    const web = typeof r['url'] === 'string' ? r['url'] : '';
    if (!slug || !name || !owner || !/^https:\/\/github\.com\/[^\s]+$/.test(web)) continue;
    const when = typeof r['updatedAt'] === 'string' ? Date.parse(r['updatedAt']) : NaN;
    out.push({ slug, name, owner, ...(typeof r['description'] === 'string' && r['description'] ? { description: r['description'].slice(0, 300) } : {}), isPrivate: r['isPrivate'] === true, ...(r['isFork'] === true ? { isFork: true } : {}), ...(Number.isFinite(when) ? { updatedAt: when } : {}), url: web.endsWith('.git') ? web : `${web}.git` });
  }
  return out;
}

/** A branch name as a plain argument: no leading dash, no whitespace, colon, or control characters. */
export const plainBranch = (b: string): boolean => typeof b === 'string' && b.length > 0 && b.length <= 250 && !b.startsWith('-') && !/[\s:\0]/.test(b);

const BUCKETS: Record<string, PullRequestCheck['bucket']> = { pass: 'pass', fail: 'fail', pending: 'pending', skipping: 'skipped', cancel: 'cancelled' };

/** The workflow run id inside a check link (`.../actions/runs/123/job/456`), or undefined (external status checks have none). */
export const runIdOfLink = (link: string | undefined): string | undefined => /\/actions\/runs\/(\d{1,20})(?:\/|$)/.exec(link ?? '')?.[1];

/** Run ids behind the failed checks, in order, without repeats. */
export function failedRunIds(items: readonly PullRequestCheck[]): string[] {
  return [...new Set(items.filter((c) => c.bucket === 'fail').map((c) => runIdOfLink(c.link)).filter((x): x is string => !!x))];
}

/** Reads `gh pr view --json ...` and `gh pr checks --json ...` output into a status with the reasons Merge is or is not offered. Pure. */
export function parsePrStatus(viewJson: string, checksJson: string): PullRequestStatus | undefined {
  let v: Record<string, unknown>;
  try { v = JSON.parse(viewJson) as Record<string, unknown>; } catch { return undefined; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v['number'] !== 'number') return undefined;
  const url = typeof v['url'] === 'string' && /^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/.test(v['url']) ? v['url'] : undefined;
  if (!url) return undefined;
  let rawChecks: unknown[] = [];
  try { const j = JSON.parse(checksJson || '[]') as unknown; if (Array.isArray(j)) rawChecks = j.slice(0, 200); } catch { /* "no checks reported" is plain text: zero checks */ }
  const items: PullRequestCheck[] = rawChecks.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const c = raw as Record<string, unknown>;
    if (typeof c['name'] !== 'string') return [];
    const link = typeof c['link'] === 'string' && /^https:\/\//.test(c['link']) ? c['link'] : undefined;
    return [{ name: c['name'].slice(0, 200), bucket: BUCKETS[String(c['bucket'])] ?? 'pending', ...(typeof c['workflow'] === 'string' && c['workflow'] ? { workflow: c['workflow'].slice(0, 200) } : {}), ...(link ? { link } : {}) }];
  });
  const count = (b: PullRequestCheck['bucket']) => items.filter((c) => c.bucket === b).length;
  const failing = count('fail'), pending = count('pending');
  const rawState = String(v['state'] ?? '').toUpperCase();
  const state: PullRequestStatus['state'] = rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : 'open';
  const m = String(v['mergeable'] ?? '').toUpperCase();
  const mergeable: PullRequestStatus['mergeable'] = m === 'MERGEABLE' ? 'mergeable' : m === 'CONFLICTING' ? 'conflicting' : 'unknown';
  const merge = String(v['mergeStateStatus'] ?? '').toUpperCase();
  const review = typeof v['reviewDecision'] === 'string' && v['reviewDecision'] ? v['reviewDecision'] : undefined;
  const hard: string[] = [];
  if (state !== 'open') hard.push(`The pull request is already ${state}.`);
  if (v['isDraft'] === true) hard.push('It is a draft. Mark it ready for review on GitHub first.');
  if (mergeable === 'conflicting' || merge === 'DIRTY') hard.push('It has merge conflicts with its base branch.');
  if (merge === 'BEHIND') hard.push('The branch is behind its base and the repository requires it to be up to date.');
  if (merge === 'BLOCKED' && !failing && !pending) hard.push('Branch protection or a required review is blocking the merge.');
  if (review === 'CHANGES_REQUESTED') hard.push('A reviewer requested changes.');
  if (review === 'REVIEW_REQUIRED') hard.push('A review is required before it can be merged.');
  const soft: string[] = [];
  if (failing) soft.push(`${failing} check${failing === 1 ? ' is' : 's are'} failing.`);
  if (pending) soft.push(`${pending} check${pending === 1 ? ' is' : 's are'} still running.`);
  return {
    number: v['number'], url, title: String(v['title'] ?? '').slice(0, 300), state, draft: v['isDraft'] === true,
    base: String(v['baseRefName'] ?? ''), head: String(v['headRefName'] ?? ''), mergeable, ...(review ? { reviewDecision: review } : {}),
    checks: { total: items.length, passing: count('pass'), failing, pending, skipped: count('skipped') + count('cancelled'), items },
    blockers: [...hard, ...soft], checksOverridable: !hard.length && soft.length > 0, canMerge: !hard.length && !soft.length, canRerun: failedRunIds(items).length > 0
  };
}
