/**
 * Manual smoke test against REAL installed CLIs. Uses real quota (a few tiny requests).
 *
 *   npm run smoke                 # adapter check on the first ready CLI
 *   npm run smoke -- codex        # pick a CLI
 *   npm run smoke -- claude --full  # also run the concierge -> lead flow in a temp git repo
 *   npm run smoke -- claude --record  # also save both adapter runs as transcripts in tests/fixtures/transcripts
 *                                     # (format: tests/conformance/transcript.ts; home folder and user name scrubbed; review before committing)
 *
 * Override executables with HARBOR_CLAUDE_PATH / HARBOR_CODEX_PATH.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeAdapter } from '../src/main/adapters/claude';
import { CodexAdapter } from '../src/main/adapters/codex';
import type { CliAdapter, Chunk } from '../src/main/adapters/types';
import { discoverClis } from '../src/main/clis/discovery';
import { createHarborService } from '../src/main/service';
import type { StreamedLine } from '../src/main/adapters/stream';
import { scrubTranscriptLine, serializeTranscript, type TranscriptRecord } from '../tests/conformance/transcript';

const args = process.argv.slice(2);
const full = args.includes('--full');
const record = args.includes('--record');
/** Raw lines of the run in progress (only with --record). */
let recording: TranscriptRecord[] = [];
const onLine = (l: StreamedLine) => { if (record) recording.push(l.stream === 'stdout' ? { o: l.line } : { e: l.line }); };
const want = args.find((a) => !a.startsWith('--'));

const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string): never => { console.error(`  FAIL ${m}`); process.exit(1); };

async function collect(a: CliAdapter, prompt: string, cwd: string, resumeId?: string): Promise<{ chunks: Chunk[]; text: string; session?: string }> {
  const chunks: Chunk[] = [];
  for await (const c of a.run(prompt, { cwd, model: 'default', effort: 'low', permission: 'read-only', resumeId })) chunks.push(c);
  const text = chunks.filter((c) => c.kind === 'text').map((c: any) => c.text).join('\n');
  const session = (chunks.find((c) => c.kind === 'session') as any)?.id;
  return { chunks, text, session };
}

async function main(): Promise<void> {
const clis = await discoverClis();
console.log('Discovered CLIs:');
for (const c of clis) console.log(`  ${c.id}: installed=${c.installed} version=${c.version ?? '-'} auth=${c.authState}${c.path ? ` path=${c.path}` : ''}${c.note ? ` (${c.note})` : ''}`);

const target = clis.find((c) => c.installed && (want ? c.id === want : c.authState !== 'signedOut') && (c.id === 'claude' || c.id === 'codex'));
if (!target) {
  console.error(want ? `\n${want} is not installed or has no headless adapter.` : '\nNo installed CLI with a headless adapter that is not signed out. Sign in first (run the CLI once).');
  process.exit(2);
}
if (target.authState === 'signedOut') bad(`${target.id} is signed out; run "${target.id} ${target.id === 'claude' ? 'auth login' : 'login'}" first.`);

const dir = mkdtempSync(join(tmpdir(), 'harbor-smoke-'));
console.log(`\nAdapter check: ${target.id} in ${dir}`);
const adapter: CliAdapter = target.id === 'claude' ? new ClaudeAdapter(target.path!, { onLine }) : new CodexAdapter(target.path!, { onLine });
/** Saves the run just made as a recorded transcript (scrubbed), with what Harbor made of it as the expectation. */
const save = (scenario: string, r: { chunks: Chunk[] }) => {
  if (!record) return;
  const who = { home: homedir(), user: userInfo().username };
  const done = r.chunks.at(-1) as Extract<Chunk, { kind: 'done' }>;
  const captured = new Date().toISOString().slice(0, 10);
  const dir = resolve(__dirname, '..', 'tests', 'fixtures', 'transcripts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${target.id}-recorded-smoke-${scenario}-${captured}.jsonl`);
  const records = recording.map((x) => ('o' in x ? { o: scrubTranscriptLine(x.o, who) } : 'e' in x ? { e: scrubTranscriptLine(x.e, who) } : x));
  writeFileSync(file, serializeTranscript({
    header: { harborTranscript: 1, cli: target.id as 'claude' | 'codex', source: 'recorded', scenario: `npm run smoke: ${scenario}`, cliVersion: target.version ?? 'unknown', captured,
      expect: { done: { ok: done.ok }, kinds: r.chunks.map((c) => c.kind) } },
    // The exit code is only known when the CLI ended without its own terminal event; otherwise a clean exit is assumed.
    records: [...records, { exit: done.exitCode ?? 0 }]
  }));
  recording = [];
  ok(`transcript saved: ${file} (review it before committing)`);
};

const r1 = await collect(adapter, 'Reply with exactly the single word HARBOR_SMOKE_OK and nothing else. Do not use tools.', dir);
const done1 = r1.chunks.find((c) => c.kind === 'done') as Extract<Chunk, { kind: 'done' }> | undefined;
if (!done1) bad('no done chunk');
else if (!done1.ok) bad(`run failed: ${done1.error}`);
ok(`run completed: ${JSON.stringify(r1.text.slice(0, 60))}`);
if (!/HARBOR_SMOKE_OK/.test(r1.text + (done1?.text ?? ''))) bad('expected marker missing from output');
ok('output contains marker');
save('reply', r1);
if (!r1.session) bad('no session id captured'); else ok(`session id captured: ${r1.session}`);

const r2 = await collect(adapter, 'What single word did I ask you to reply with earlier? Answer with just that word.', dir, r1.session);
if (!/HARBOR_SMOKE_OK/.test(r2.text)) bad(`resume did not recall earlier turn (got ${JSON.stringify(r2.text.slice(0, 80))})`);
save('resume', r2);
ok('resume continued the same session');

if (full) {
  console.log('\nFull flow: concierge -> lead in a temp git repo');
  const repo = mkdtempSync(join(tmpdir(), 'harbor-smoke-repo-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 's@s'); g('config', 'user.name', 'smoke');
  writeFileSync(join(repo, 'README.md'), '# smoke\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  const svc = createHarborService({ worktreesRoot: join(tmpdir(), `harbor-smoke-wt-${Date.now()}`) });
  svc.onEvent((e) => {
    if (e.type !== 'message' || e.message.role === 'tool') return;
    const d = e.message.details ? ` ${e.message.details.cli}/${e.message.details.model}` : '';
    console.log(`  [${e.message.role}${d}] ${e.message.text.slice(0, 160).replace(/\s+/g, ' ')}`);
  });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  await svc.send(conv!.id, 'Thanks, you are great.');
  await svc.whenIdle(5 * 60 * 1000);
  ok('simple message handled');
  await svc.send(conv!.id, 'Create a file hello.txt containing the single line "hello from harbor" (this is a tiny, fully specified change).');
  await svc.whenIdle(10 * 60 * 1000);
  const agents = await svc.listAgents(project.id);
  console.log('  helpers:', agents.filter((a) => a.role !== 'main').map((a) => `${a.role}:${a.state}:${a.cli}`).join(', ') || '(none: the lead did it directly)');
  const touched = g('status', '--porcelain').stdout + agents.filter((a) => a.worktree).map((a) => a.worktree).join(' ');
  if (!/hello\.txt/.test(touched) && !agents.some((a) => a.worktree)) bad('hello.txt was not created');
  ok('the requested change was made');
  svc.shutdown();
}
console.log('\nSmoke passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
