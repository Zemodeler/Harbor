/**
 * Eval harness: Harbor vs a single agent on one task set, judged on quality (acceptance command, reviewer verdict), cost (Harbor's
 * usage estimate) and wall time. Writes a markdown and a JSON report.
 *
 *   npm run eval                                          # fake adapters (default, CI-safe): scripts/eval/tasks/sample.json
 *   npm run eval -- path/to/tasks.json --out eval-out     # another task set; reports go to eval-out/
 *   npm run eval -- --arms harbor                         # one arm only
 *   npm run eval -- --real --yes [--baseline-cli claude] [--baseline-model m] [--timeout-min 60]
 *                                                         # REAL CLIs: spends subscription quota (see the warning it prints)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ClaudeAdapter } from '../../src/main/adapters/claude';
import { CodexAdapter } from '../../src/main/adapters/codex';
import { discoverClis } from '../../src/main/clis/discovery';
import { evalMarkdown, parseTaskSet, type EvalArm } from '../../src/main/evalScore';
import { runEval } from './runner';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const valued = new Set(['--out', '--arms', '--baseline-cli', '--baseline-model', '--timeout-min']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));

const file = resolve(positional[0] ?? join(__dirname, 'tasks', 'sample.json'));
const taskSet = parseTaskSet(JSON.parse(readFileSync(file, 'utf8')));
const real = flag('--real');
const arms = (value('--arms')?.split(',') ?? ['harbor', 'baseline']).filter((a): a is EvalArm => a === 'harbor' || a === 'baseline');
const outDir = resolve(value('--out') ?? 'eval-out');

async function main(): Promise<void> {
  if (real) {
    const runs = taskSet.tasks.length * (arms.includes('harbor') ? 3 : 0) + taskSet.tasks.length * (arms.includes('baseline') ? 1 : 0);
    console.warn([
      '',
      '  WARNING: REAL CLI MODE. This runs your installed CLIs (Claude Code, Codex) on every task and SPENDS SUBSCRIPTION QUOTA.',
      `  ${taskSet.tasks.length} task(s) x ${arms.join(' + ')}: at least ${runs} CLI runs, likely more (helpers, reviews, retries).`,
      '  Harbor\'s figures in the report are estimates; check your provider\'s own usage page for the real cost.',
      ''
    ].join('\n'));
    if (!flag('--yes')) { console.warn('  Not started. Add --yes to confirm.'); process.exitCode = 2; return; }
  }
  const timeoutMin = Number(value('--timeout-min'));
  const report = await runEval({
    taskSet, baseDir: dirname(file), mode: real ? 'real' : 'fake', arms, log: (l) => console.log(l), keep: flag('--keep'),
    ...(Number.isFinite(timeoutMin) && timeoutMin > 0 ? { taskTimeoutMs: timeoutMin * 60_000 } : {}),
    ...(value('--baseline-cli') ? { baselineCli: value('--baseline-cli') } : {}), ...(value('--baseline-model') ? { baselineModel: value('--baseline-model') } : {}),
    ...(real ? {
      real: {
        discover: discoverClis,
        baselineAdapter: (c) => (!c.path ? undefined : c.id === 'claude' ? new ClaudeAdapter(c.path) : c.id === 'codex' ? new CodexAdapter(c.path) : undefined)
      }
    } : {})
  });
  mkdirSync(outDir, { recursive: true });
  const stem = `eval-${taskSet.name.replace(/[^A-Za-z0-9._-]+/g, '-')}-${report.mode}`;
  writeFileSync(join(outDir, `${stem}.md`), evalMarkdown(report));
  writeFileSync(join(outDir, `${stem}.json`), JSON.stringify(report, null, 1));
  console.log(evalMarkdown(report));
  console.log(`Reports written to ${join(outDir, stem)}.{md,json}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
