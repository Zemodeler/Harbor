import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateEval, evalMarkdown, parseTaskSet, type EvalOutcome } from '../src/main/evalScore';
import { runEval } from '../scripts/eval/runner';

const sampleFile = join(__dirname, '..', 'scripts', 'eval', 'tasks', 'sample.json');
const task = { id: 't1', prompt: 'do it', fixture: { files: { 'a.txt': 'x' } }, acceptance: { command: 'node', args: ['check.js'] } };

describe('task-set format', () => {
  it('accepts the sample set and a minimal task', () => {
    const s = parseTaskSet(JSON.parse(readFileSync(sampleFile, 'utf8')));
    expect(s.tasks.map((t) => t.id)).toEqual(['add-sum', 'fix-greeting', 'scripted-miss']);
    expect(s.tasks[2]!.fake!.harbor!.solution).toBeNull();
    expect(parseTaskSet({ version: 1, name: 'x', tasks: [task] }).tasks[0]).toEqual(task);
  });

  it.each([
    [{ version: 2, name: 'x', tasks: [task] }, /version/],
    [{ version: 1, name: 'x', tasks: [] }, /at least one task/],
    [{ version: 1, name: 'x', tasks: [task, task] }, /Duplicate task id/],
    [{ version: 1, name: 'x', tasks: [{ ...task, id: 'a b' }] }, /id must be/],
    [{ version: 1, name: 'x', tasks: [{ ...task, fixture: { files: { '../escape.txt': 'x' } } }] }, /not a relative path/],
    [{ version: 1, name: 'x', tasks: [{ ...task, fixture: { dir: 'C:\\abs' } }] }, /relative folder/],
    [{ version: 1, name: 'x', tasks: [{ ...task, acceptance: { command: 'node', args: [1] } }] }, /args/],
    [{ version: 1, name: 'x', tasks: [{ ...task, fake: { harbor: { plan: 'swarm' } } }] }, /plan must be/]
  ])('rejects %j', (j, re) => { expect(() => parseTaskSet(j)).toThrow(re); });
});

const outcome = (taskId: string, arm: 'harbor' | 'baseline', accepted: boolean, k: number, wallMs: number, extra: Partial<EvalOutcome> = {}): EvalOutcome => ({
  taskId, arm, accepted, acceptance: { exitCode: accepted ? 0 : 1, output: '' }, verdict: 'none', integration: 'in-place', runs: 1, failedRuns: 0,
  tokens: { inputTokens: k * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billableKTok: k }, quota: [{ pool: 'claude:all', period: 'weekly', pct: k / 1000 }],
  wallMs, agentMinutes: 1, models: ['claude/claude-sonnet-5-5'], ...extra
});

describe('eval scoring (pure)', () => {
  it('summarizes each arm and compares Harbor with the baseline on the tasks both ran', () => {
    const r = aggregateEval({ name: 'n', mode: 'real', generatedAt: 0, outcomes: [
      outcome('a', 'harbor', true, 20, 4000, { verdict: 'approve' }), outcome('a', 'baseline', false, 10, 2000),
      outcome('b', 'harbor', true, 20, 4000, { verdict: 'changes' }), outcome('b', 'baseline', true, 10, 2000)
    ] });
    expect(r.summary).toEqual([
      { arm: 'harbor', tasks: 2, accepted: 2, acceptRate: 1, reviewed: 2, approved: 1, runs: 2, meanBillableKTok: 20, meanWeeklyQuota: [{ pool: 'claude:all', pct: 0.02 }], meanWallSec: 4 },
      { arm: 'baseline', tasks: 2, accepted: 1, acceptRate: 0.5, reviewed: 0, approved: 0, runs: 2, meanBillableKTok: 10, meanWeeklyQuota: [{ pool: 'claude:all', pct: 0.01 }], meanWallSec: 2 }
    ]);
    expect(r.comparison).toEqual({ tasks: 2, acceptDelta: 1, tokensRatio: 2, wallRatio: 2, onlyHarbor: ['a'], onlyBaseline: [] });
    expect(r.notes.join('\n')).not.toMatch(/FAKE MODE/);
    const md = evalMarkdown(r);
    expect(md).toContain('| harbor | 2/2 (100%) | 2 (1) |');
    expect(md).toContain('Only Harbor passed: a');
    expect(md).toMatch(/estimate/);
  });

  it('labels fake mode and has no comparison with one arm', () => {
    const r = aggregateEval({ name: 'n', mode: 'fake', generatedAt: 0, outcomes: [outcome('a', 'harbor', true, 1, 1)] });
    expect(r.comparison).toBeUndefined();
    expect(r.notes[0]).toMatch(/^FAKE MODE/);
  });
});

describe('eval runner (fake adapters, real git)', () => {
  it('runs the sample set through Harbor and the single-agent baseline and judges both', async () => {
    const taskSet = parseTaskSet(JSON.parse(readFileSync(sampleFile, 'utf8')));
    const r = await runEval({ taskSet, baseDir: join(sampleFile, '..'), mode: 'fake' });
    const get = (id: string, arm: string) => r.outcomes.find((o) => o.taskId === id && o.arm === arm)!;
    // Delegated: implementer on its own branch, approved by the reviewer, merged, then accepted.
    expect(get('add-sum', 'harbor')).toMatchObject({ accepted: true, verdict: 'approve', integration: 'harness-merge', failedRuns: 0 });
    expect(get('add-sum', 'harbor').runs).toBeGreaterThanOrEqual(3);
    expect(get('add-sum', 'harbor').tokens.inputTokens).toBe(get('add-sum', 'harbor').runs * 12_000);
    expect(get('add-sum', 'harbor').quota.some((q) => q.pool === 'claude:all' && q.period === 'weekly' && q.pct > 0)).toBe(true);
    // The lead edited the project folder itself.
    expect(get('fix-greeting', 'harbor')).toMatchObject({ accepted: true, integration: 'in-place' });
    // Scripted failure: the helper writes nothing, the reviewer asks for changes, the acceptance fails.
    expect(get('scripted-miss', 'harbor')).toMatchObject({ accepted: false, verdict: 'changes' });
    for (const id of ['add-sum', 'fix-greeting', 'scripted-miss']) expect(get(id, 'baseline')).toMatchObject({ accepted: true, runs: 1, verdict: 'none', models: ['claude/claude-sonnet-5-5'] });
    expect(get('add-sum', 'baseline').tokens).toMatchObject({ inputTokens: 30_000, outputTokens: 3_000, billableKTok: 33 });
    expect(r.comparison).toMatchObject({ tasks: 3, acceptDelta: -1, onlyBaseline: ['scripted-miss'] });
    expect(r.mode).toBe('fake');
    expect(evalMarkdown(r)).toMatch(/FAKE MODE/);
  }, 240_000);

  it('refuses real mode without the installed CLIs', async () => {
    const taskSet = parseTaskSet({ version: 1, name: 'x', tasks: [task] });
    await expect(runEval({ taskSet, baseDir: '.', mode: 'real' })).rejects.toThrow(/Real mode/);
  });
});
