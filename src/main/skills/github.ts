import { createHash } from 'node:crypto';
import { checkArchivePath, fmtBytes } from './zip';

/**
 * GitHub skill import (plan section 3.4; the owner allowed it). Two explicit steps, each started by a click in Harbor:
 *  1. listGitHub: resolves the reference to one commit and lists the files under the path with their sizes (GitHub REST API:
 *     the commit sha, then the recursive git tree). No file content is fetched.
 *  2. downloadGitHub: fetches exactly the files of that listing at that commit from raw.githubusercontent.com and checks each
 *     one against the tree's git blob hash and size, so what is imported is what was shown.
 * Symbolic links (mode 120000) and submodules are refused. Unauthenticated: no token is ever read or sent. The fetch function
 * is injected; tests fake it and never use the network.
 * Endpoints (documented GitHub REST API, not exercised from this machine by tests): GET /repos/{o}/{r},
 * GET /repos/{o}/{r}/commits/{ref} with Accept application/vnd.github.sha, GET /repos/{o}/{r}/git/trees/{sha}?recursive=1.
 */

export interface FetchResponse {
  ok: boolean; status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' | 'error' }) => Promise<FetchResponse>;

export interface GitHubRef { owner: string; repo: string; ref?: string; path: string }
export interface GitHubEntry { path: string; bytes: number; sha: string; executable: boolean }
export interface GitHubListing { owner: string; repo: string; commit: string; path: string; entries: GitHubEntry[] }

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const REF = /^[A-Za-z0-9._\/-]{1,200}$/;
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const HEADERS = { 'User-Agent': 'Harbor-skill-import', 'X-GitHub-Api-Version': '2022-11-28' };
/** The recursive tree of a big repository can be several MB; beyond this the user should name a smaller path. */
export const MAX_TREE_BYTES = 8 * 1024 * 1024;

/** `owner/repo[/path]`, `github.com/owner/repo`, or `https://github.com/owner/repo[/tree|blob/<ref>/<path>]`. A ref with a slash is not supported. */
export function parseGitHubRef(input: string): GitHubRef | { why: string } {
  const s = (typeof input === 'string' ? input : '').trim();
  if (!s || s.length > 500 || /[\s\0]/.test(s)) return { why: 'Enter a GitHub address such as owner/repo or https://github.com/owner/repo/tree/main/skills/name.' };
  let rest = s;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(s);
  if (url) rest = url[1]!;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return { why: 'Only github.com addresses can be imported.' };
  rest = rest.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = rest.split('/');
  const owner = parts[0] ?? '', repo = (parts[1] ?? '').replace(/\.git$/i, '');
  if (!NAME.test(owner) || !NAME.test(repo) || owner.includes('..') || repo.includes('..')) return { why: 'The address must name an owner and a repository.' };
  let ref: string | undefined, pathParts: string[];
  if (url && (parts[2] === 'tree' || parts[2] === 'blob')) {
    ref = parts[3];
    if (!ref || !REF.test(ref) || ref.includes('..')) return { why: 'The address names an invalid branch, tag or commit.' };
    pathParts = parts.slice(4);
    // A link to a file (usually SKILL.md) means the folder holding it.
    if (parts[2] === 'blob') pathParts = pathParts.slice(0, -1);
  } else if (url && parts.length > 2) {
    return { why: 'Use a /tree/<branch>/<path> address, or owner/repo/path.' };
  } else pathParts = parts.slice(2);
  const path = pathParts.map((p) => decodeURIComponent(p)).join('/');
  if (path) {
    const c = checkArchivePath(path);
    if (!c.path) return { why: `The path is not usable: ${c.why}.` };
  }
  return { owner, repo, ...(ref ? { ref } : {}), path };
}

export const describeGitHub = (l: Pick<GitHubListing, 'owner' | 'repo' | 'commit' | 'path'>): string => `github.com/${l.owner}/${l.repo}@${l.commit.slice(0, 12)}${l.path ? `/${l.path}` : ''}`;

/** Reads a response body, stopping (and refusing) as soon as it passes `max` bytes. */
export async function readCapped(res: FetchResponse, max: number, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new Error(`${what} is larger than ${fmtBytes(max)}.`);
  const reader = res.body?.getReader?.();
  if (!reader) {
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > max) throw new Error(`${what} is larger than ${fmtBytes(max)}.`);
    return b;
  }
  const parts: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => undefined); throw new Error(`${what} is larger than ${fmtBytes(max)}.`); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

async function getJson(fetchFn: FetchLike, url: string, max: number, what: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchFn(url, { headers: { ...HEADERS, Accept: 'application/vnd.github+json' }, signal });
  if (!res.ok) throw new Error(httpWhy(res.status, what));
  try { return JSON.parse((await readCapped(res, max, what)).toString('utf8')); } catch (e) { throw new Error(e instanceof Error && /larger than/.test(e.message) ? e.message : `GitHub sent an unreadable answer for ${what}.`); }
}

const httpWhy = (status: number, what: string): string =>
  status === 404 ? `GitHub could not find ${what} (it may be private, renamed, or the branch or path may not exist).`
  : status === 403 || status === 429 ? `GitHub refused ${what} (status ${status}); its rate limit for addresses without sign-in may be used up. Try again later.`
  : `GitHub answered ${status} for ${what}.`;

/** Step 1: one commit and the files under the path (names, sizes, blob hashes). Downloads no file content. */
export async function listGitHub(fetchFn: FetchLike, r: GitHubRef, signal?: AbortSignal): Promise<GitHubListing> {
  const base = `${API}/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
  let ref = r.ref;
  if (!ref) {
    const repo = await getJson(fetchFn, base, 1024 * 1024, `the repository ${r.owner}/${r.repo}`, signal) as { default_branch?: unknown };
    if (typeof repo?.default_branch !== 'string' || !REF.test(repo.default_branch)) throw new Error('GitHub did not name the repository\'s default branch.');
    ref = repo.default_branch;
  }
  const shaRes = await fetchFn(`${base}/commits/${encodeURIComponent(ref)}`, { headers: { ...HEADERS, Accept: 'application/vnd.github.sha' }, signal });
  if (!shaRes.ok) throw new Error(httpWhy(shaRes.status, `${r.owner}/${r.repo} at ${ref}`));
  const commit = (await readCapped(shaRes, 1024, 'the commit id')).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('GitHub did not answer with a commit id.');
  const tree = await getJson(fetchFn, `${base}/git/trees/${commit}?recursive=1`, MAX_TREE_BYTES, 'the file list', signal) as { tree?: unknown; truncated?: unknown };
  if (!Array.isArray(tree?.tree)) throw new Error('GitHub sent no file list.');
  if (tree.truncated === true) throw new Error('The repository is too large for GitHub to list at once. Point at the skill\'s own folder (owner/repo/path).');
  const prefix = r.path ? `${r.path}/` : '';
  const entries: GitHubEntry[] = [];
  let found = !r.path;
  for (const t of tree.tree as Array<Record<string, unknown>>) {
    const p = typeof t['path'] === 'string' ? t['path'] : '';
    if (r.path && p === r.path) { found = true; if (t['type'] === 'blob') throw new Error('The address names a file; name the skill\'s folder instead.'); continue; }
    if (prefix && !p.startsWith(prefix)) continue;
    found = true;
    const rel = p.slice(prefix.length);
    if (t['type'] === 'tree') continue;
    if (t['type'] === 'commit') throw new Error(`${p} is a submodule; submodules are not imported.`);
    if (t['mode'] === '120000') throw new Error(`${p} is a symbolic link; links are not imported.`);
    if (t['type'] !== 'blob' || typeof t['sha'] !== 'string' || !/^[0-9a-f]{40}$/.test(t['sha']) || typeof t['size'] !== 'number') throw new Error(`GitHub listed ${p} in a form Harbor does not read.`);
    const c = checkArchivePath(rel);
    if (!c.path) throw new Error(`The folder contains ${c.why}.`);
    entries.push({ path: c.path, bytes: t['size'], sha: t['sha'], executable: t['mode'] === '100755' });
  }
  if (!found) throw new Error(`${r.owner}/${r.repo} has no folder ${r.path} at ${ref}.`);
  return { owner: r.owner, repo: r.repo, commit, path: r.path, entries };
}

/** git's blob id: sha1("blob <size>\0" + content). */
export const gitBlobSha = (data: Buffer): string => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

/** Step 2: exactly these entries at the listed commit. Each must match its listed size and blob hash. */
export async function downloadGitHub(fetchFn: FetchLike, l: GitHubListing, entries: GitHubEntry[], maxFileBytes: number, signal?: AbortSignal): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const e of entries) {
    const full = l.path ? `${l.path}/${e.path}` : e.path;
    const url = `${RAW}/${encodeURIComponent(l.owner)}/${encodeURIComponent(l.repo)}/${l.commit}/${full.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetchFn(url, { headers: HEADERS, signal });
    if (!res.ok) throw new Error(httpWhy(res.status, full));
    const data = await readCapped(res, Math.min(maxFileBytes, e.bytes), full).catch(() => { throw new Error(`${full} does not match the file GitHub listed for that commit (it is larger); nothing was imported.`); });
    if (data.length !== e.bytes || gitBlobSha(data) !== e.sha) throw new Error(`${full} does not match the file GitHub listed for that commit; nothing was imported.`);
    out.set(e.path, data);
  }
  return out;
}
