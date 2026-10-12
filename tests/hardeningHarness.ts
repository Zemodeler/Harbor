import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { createHarborService, type ServiceOptions } from '../src/main/service';
import type { HarborEvent, Message } from '../src/shared/api';

// Shared by the wave 2 hardening tests: a fake CLI split by caller (front desk, lead, helper), real git in temp folders.

const dirs: string[] = [];
export const tmp = (prefix = 'harbor-hard-'): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

export const fakeCli = (id: string): ResolvedCli =>
  ({ id, name: id, installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: `/fake/${id}` });
export const isConcierge = (o: RunOptions): boolean => !!o.systemPrompt?.includes('front desk');
export const isLead = (o: RunOptions): boolean => !!o.systemPrompt?.includes('LEAD agent');
export const isHelper = (o: RunOptions): boolean => !isConcierge(o) && !isLead(o);
export const say = (text: string): Chunk[] => [{ kind: 'text', text }];
/** A turn that used a tool and then said something (a goal continuation that only talks counts as no progress). */
export const work = (text: string): Chunk[] => [{ kind: 'tool', text: 'Read src/x.ts' }, { kind: 'text', text }];
export const answer = (text: string): Chunk[] => say(JSON.stringify({ answer: text }));
export const escalate = (complexity = 'medium', ack = '', needs: string[] = ['code']): Chunk[] => say(JSON.stringify({ escalate: { complexity, needs, ack } }));
export const delegateLine = (t: unknown): string => `HARBOR_DELEGATE: ${JSON.stringify(t)}`;
export const delegate = (text: string, ...tasks: unknown[]): Chunk[] => say([text, ...tasks.map(delegateLine)].join('\n'));
export const result = (r: object): string => `HARBOR_RESULT: ${JSON.stringify(r)}`;

export const git = (cwd: string, ...a: string[]): string => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

export function gitRepo(): string {
  const d = tmp('harbor-repo-');
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  writeFileSync(join(d, 'README.md'), 'hi'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}

/** One script per caller kind. */
export interface Roles { concierge?: FakeScript; lead?: FakeScript; helper?: FakeScript }
export const script = (r: Roles): FakeScript => (prompt, o, i) => {
  if (isConcierge(o)) return (r.concierge ?? (() => escalate()))(prompt, o, i);
  if (isLead(o)) return (r.lead ?? (() => say('ok')))(prompt, o, i);
  return (r.helper ?? (() => say('ok')))(prompt, o, i);
};

export interface HarnessOptions { git?: boolean | string; ids?: string[]; service?: Partial<ServiceOptions>; bare?: boolean; dataDir?: boolean }

export async function harness(scripts: Record<string, FakeScript | undefined>, opts: HarnessOptions = {}) {
  const adapters: Record<string, FakeAdapter> = {};
  for (const id of opts.ids ?? ['claude']) adapters[id] = new FakeAdapter(id, scripts[id] ?? (() => say('ok')), { bareProtocol: opts.bare });
  const events: HarborEvent[] = [];
  const dataDir = opts.dataDir ? tmp('harbor-data-') : undefined;
  const svc = createHarborService({
    dataDir,
    discover: async () => Object.keys(adapters).map(fakeCli),
    adapterFor: (id) => adapters[id],
    worktreesRoot: join(tmp('harbor-wt-'), 'wt'),
    maxActivePerProject: 3,
    ...opts.service
  });
  svc.onEvent((e) => events.push(e));
  const repoPath = typeof opts.git === 'string' ? opts.git : opts.git === false ? tmp('harbor-nogit-') : gitRepo();
  const project = (await svc.addProject(repoPath))!;
  const [conv] = await svc.listConversations(project.id);
  const messages = async (cid = conv!.id): Promise<Message[]> => svc.listMessages(cid);
  const texts = async (cid = conv!.id): Promise<string[]> => (await messages(cid)).map((m) => m.text);
  const calls = (pred: (o: RunOptions) => boolean, cli = 'claude') => adapters[cli]!.calls.filter((c) => pred(c.opts));
  const helpers = () => svc.store.listAgentRecords(project.id).filter((a) => a.role !== 'main');
  const helper = (title: string) => helpers().find((a) => a.title === title)!;
  return { svc, adapters, events, project, conv: conv!, repoPath, dataDir, messages, texts, calls, helpers, helper };
}

export const until = async (cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

export const makeDir = (p: string): string => { mkdirSync(p, { recursive: true }); return p; };
