import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, vi } from 'vitest';
import { Git } from '../src/main/git';
import { GitHub } from '../src/main/github';
import { runProcess, type RunResult, type Runner } from '../src/main/proc';
import { createHarborService, type HarborService } from '../src/main/service';

// Shared harness for the Track B tests (contract 0.1.48-0.1.59): real git in temp dirs with a local bare origin; gh and the recycle bin are injected.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
export const dirs: string[] = [], services: HarborService[] = [];
export const temp = (p = 'harbor-p2-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(async () => { for (const s of services.splice(0)) await s.shutdown(); dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true, maxRetries: 3 })); });
export const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();
export const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
export const LOGGED_IN: RunResult = { code: 0, stdout: '', stderr: '  ✓ Logged in to github.com account Zemodeler (keyring)\n', timedOut: false };

/** A fake gh with recorded calls; `answers` maps the first two args ("repo list", "pr view", ...) to a result. */
export function fakeGh(answers: Record<string, (args: string[], input?: string) => RunResult> = {}, o: { missing?: boolean } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: Runner = async (_exe, args, opts) => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    if (o.missing) return { code: null, stdout: '', stderr: '', timedOut: false, error: 'spawn gh ENOENT' };
    if (args[0] === 'auth') return LOGGED_IN;
    const f = answers[`${args[0]} ${args[1]}`];
    return f ? f(args, opts?.input) : { code: 1, stdout: '', stderr: 'unexpected', timedOut: false };
  };
  return { gh: new GitHub(run), calls };
}

export function setup(extra: Partial<Parameters<typeof createHarborService>[0]> = {}, gh = fakeGh()) {
  const dataDir = temp('harbor-data-'), parent = temp('harbor-projects-');
  const service = createHarborService({ dataDir, discover: async () => [], github: gh.gh, defaultProjectsDir: parent, deleteSleep: async () => {}, ...extra });
  services.push(service);
  return { service, dataDir, parent, gh, worktreesRoot: join(dataDir, 'worktrees') };
}

/** A bare "remote" holding one commit on main, reachable only through the fake URL mapping below. */
export function bareWithCommit(): string {
  const origin = temp('harbor-origin-'), work = temp('harbor-work-');
  sh(origin, 'init', '--bare', '-b', 'main');
  sh(work, 'init', '-b', 'main');
  writeFileSync(join(work, 'README.md'), '# remote project\n');
  sh(work, '-c', 'user.name=T', '-c', 'user.email=t@t', 'add', '-A');
  sh(work, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'first');
  sh(work, 'push', origin, 'main');
  return origin;
}
/** A git whose clone of the https test URL reads the local bare origin instead (the real URL checks still run first). */
export const gitCloningFrom = (origin: string, inspect?: (args: string[]) => RunResult | undefined): Git => new Git((exe, args, o) => {
  const hit = inspect?.(args);
  if (hit) return Promise.resolve(hit);
  const i = args.indexOf('clone');
  return runProcess(exe, i >= 0 ? args.map((a, k) => (k > i && /^https:\/\/example\.test\//.test(a) ? origin : a)) : args, o);
});

