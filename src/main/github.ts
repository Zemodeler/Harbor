import type { GithubStatus } from '../shared/api';
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
