/**
 * Manual smoke test against REAL installed CLIs. Uses real quota (a few tiny requests).
 *
 *   npm run smoke                 # adapter check on the first ready CLI
 *   npm run smoke -- codex        # pick a CLI
 *   npm run smoke -- claude --full  # also run the full main-agent -> subagent flow in a temp git repo
 *
 * Override executables with HARBOR_CLAUDE_PATH / HARBOR_CODEX_PATH.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../src/main/adapters/claude';
import { CodexAdapter } from '../src/main/adapters/codex';
import type { CliAdapter, Chunk } from '../src/main/adapters/types';
import { discoverClis } from '../src/main/clis/discovery';
import { createHarborService } from '../src/main/service';

const args = process.argv.slice(2);
const full = args.includes('--full');
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
const adapter: CliAdapter = target.id === 'claude' ? new ClaudeAdapter(target.path!) : new CodexAdapter(target.path!);

const r1 = await collect(adapter, 'Reply with exactly the single word HARBOR_SMOKE_OK and nothing else. Do not use tools.', dir);
const done1 = r1.chunks.find((c) => c.kind === 'done') as Extract<Chunk, { kind: 'done' }> | undefined;
if (!done1) bad('no done chunk');
else if (!done1.ok) bad(`run failed: ${done1.error}`);
ok(`run completed: ${JSON.stringify(r1.text.slice(0, 60))}`);
if (!/HARBOR_SMOKE_OK/.test(r1.text + (done1?.text ?? ''))) bad('expected marker missing from output');
ok('output contains marker');
if (!r1.session) bad('no session id captured'); else ok(`session id captured: ${r1.session}`);

const r2 = await collect(adapter, 'What single word did I ask you to reply with earlier? Answer with just that word.', dir, r1.session);
if (!/HARBOR_SMOKE_OK/.test(r2.text)) bad(`resume did not recall earlier turn (got ${JSON.stringify(r2.text.slice(0, 80))})`);
ok('resume continued the same session');

if (full) {
  console.log('\nFull flow: main agent -> subagent in a temp git repo');
  const repo = mkdtempSync(join(tmpdir(), 'harbor-smoke-repo-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 's@s'); g('config', 'user.name', 'smoke');
  writeFileSync(join(repo, 'README.md'), '# smoke\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  const svc = createHarborService({ worktreesRoot: join(tmpdir(), `harbor-smoke-wt-${Date.now()}`) });
  svc.onEvent((e) => { if (e.type === 'message' && e.message.role !== 'tool') console.log(`  [${e.message.role}] ${e.message.text.slice(0, 160).replace(/\s+/g, ' ')}`); });
  const project = (await svc.addProject(repo))!;
  const [conv] = await svc.listConversations(project.id);
  await svc.send(conv!.id, 'Create a file hello.txt containing the single line "hello from harbor" (this is a tiny, fully specified change).');
  await svc.whenIdle(10 * 60 * 1000);
  const agents = await svc.listAgents(project.id);
  console.log('  agents:', agents.filter((a) => a.role !== 'main').map((a) => `${a.role}:${a.state}:${a.cli}`).join(', '));
  const impl = agents.find((a) => a.role === 'implementer');
  if (!impl || impl.state !== 'done') bad('implementer did not finish');
  ok(`implementer done on branch in ${impl!.worktree}`);
  svc.shutdown();
}
console.log('\nSmoke passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
