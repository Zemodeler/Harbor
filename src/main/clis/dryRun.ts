import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDryRun, CliDryRunStep, CustomCliDescriptor } from '../../shared/api';
import { GenericAdapter, genericArgs } from '../adapters/generic';
import type { RunOptions } from '../adapters/types';
import type { Runner } from '../proc';
import { customEnv, customStatus } from './custom';

/** The one prompt a dry run sends: short, harmless, and easy to recognise in the output. */
export const DRY_RUN_PROMPT = 'Reply with the single word OK and nothing else.';
const SHOWN = 8000;
const clip = (s: string) => (s.length > SHOWN ? `${s.slice(0, SHOWN)}\n[... ${s.length - SHOWN} more characters]` : s);
const shown = (exe: string, args: string[]) => [exe, ...args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');

export interface DryRunDeps {
  run: Runner;
  /** Base environment (default process.env); the CLI gets only the allowlist plus the descriptor's values. */
  env?: NodeJS.ProcessEnv;
  /** Prompt run limit (default 120 s). */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The safety net for a hand-written descriptor (plan 2.2): version, the sign-in check, then one "reply OK" prompt in an empty temp
 * folder, showing the raw output next to what Harbor parsed from it. Uses the real GenericAdapter, so what passes here is what
 * routing will run. The caller has already validated the descriptor and has the user's OK to run its executable.
 */
export async function dryRunCli(d: CustomCliDescriptor, deps: DryRunDeps): Promise<CliDryRun> {
  const now = deps.now ?? Date.now;
  const env = customEnv(deps.env ?? process.env, d.run.env);
  const steps: CliDryRunStep[] = [];
  const check = async (name: 'version' | 'status', args: string[]) => {
    const t0 = now();
    const r = await deps.run(d.exe, args, { timeoutMs: 20_000, env });
    const step: CliDryRunStep = { name, command: shown(d.exe, args), exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr), durationMs: now() - t0,
      ...(r.error ? { error: r.error } : r.timedOut ? { error: 'timed out' } : {}) };
    steps.push(step);
    return r;
  };
  const v = await check('version', d.version?.args ?? ['--version']);
  const version = v.code === 0 ? (v.stdout.match(/\d+\.\d+\.\d+[\w.\-]*/) ?? [])[0] : undefined;
  const authState = d.status ? (await check('status', d.status.args).then((s) => (s.error || s.timedOut ? 'unknown' as const : customStatus(d, s)))) : undefined;

  const cwd = mkdtempSync(join(tmpdir(), 'harbor-dryrun-'));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 120_000);
  timer.unref?.();
  const opts: RunOptions = { cwd, model: d.models?.[0]?.id ?? 'default', effort: 'low', permission: 'read-only', signal: ctl.signal };
  const out: string[] = [], err: string[] = [];
  const texts: string[] = [];
  const parsed: NonNullable<CliDryRun['parsed']> = { chunks: 0 };
  const t0 = now();
  let timedOut = false;
  ctl.signal.addEventListener('abort', () => { timedOut = true; }, { once: true });
  try {
    const adapter = new GenericAdapter(d, { env: deps.env, onLine: (l) => (l.stream === 'stdout' ? out : err).push(l.line) });
    for await (const c of adapter.run(DRY_RUN_PROMPT, opts)) {
      parsed.chunks++;
      if (c.kind === 'text') texts.push(c.text);
      else if (c.kind === 'session') parsed.sessionId = c.id;
      else if (c.kind === 'usage') { if (c.inputTokens !== undefined) parsed.inputTokens = c.inputTokens; if (c.outputTokens !== undefined) parsed.outputTokens = c.outputTokens; }
      else if (c.kind === 'done') { parsed.ok = c.ok; if (c.error) parsed.error = c.error; steps.push({ name: 'prompt', command: shown(d.exe, genericArgs(d, opts, d.run.prompt === 'file' ? '<prompt file>' : undefined)), exitCode: c.ok ? 0 : c.exitCode ?? null, stdout: clip(out.join('\n')), stderr: clip(err.join('\n')), durationMs: now() - t0, ...(c.ok ? {} : { error: timedOut ? 'timed out (no answer within the limit)' : c.error ?? 'failed' }) }); }
    }
  } finally {
    clearTimeout(timer);
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort: an empty temp folder */ }
  }
  if (texts.length) parsed.text = clip(texts.join('\n\n'));
  return { ok: v.code === 0 && parsed.ok === true && !!parsed.text, ...(version ? { version } : {}), ...(authState ? { authState } : {}), steps, parsed };
}
