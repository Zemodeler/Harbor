import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git } from '../src/main/git';
import { DEFAULT_LOOP_LIMITS, LoopDetector, describeLoop, isCheapCommand, normalizeCommand, type LoopVerdict } from '../src/main/loopGuard';
import { LoopWatch } from '../src/main/loopWatch';
import { gitProgressProbe } from '../src/main/progressProbe';
import { PROTOCOL } from '../src/main/prompts';

// Phase 6: the loop guard's detector, probe and watch. Synthetic event streams only (shaped like real runs, no conversation text).

const MIN = 60_000;
const tool = (text: string) => ({ kind: 'tool', text });
const say = (text: string) => ({ kind: 'text', text });

/** A detector driven on a fake clock: `at(ms)` moves time, `feed` observes, `probe` feeds a fingerprint. */
function drive(o: { canEdit: boolean; probed: boolean }) {
  let now = 0;
  const det = new LoopDetector({ ...o, startedAt: 0 });
  const verdicts: LoopVerdict[] = [];
  return {
    det, verdicts,
    at: (ms: number) => { now = ms; },
    step: (ms: number) => { now += ms; },
    now: () => now,
    feed: (c: { kind: string; text: string }) => { const v = det.observe(c, now); verdicts.push(v); return v; },
    probe: (fp: string | undefined) => det.probe(fp, now),
    first: () => verdicts.find((v) => v.loop)
  };
}

describe('normalizeCommand', () => {
  it('drops volatile parts so a retried command matches itself, keeps digits inside names', () => {
    expect(normalizeCommand('Bash  sleep 30')).toBe(normalizeCommand('Bash sleep 60'));
    expect(normalizeCommand('Bash cat C:\\Users\\a\\AppData\\Local\\Temp\\run-123\\out.log')).toBe(normalizeCommand('Bash cat C:\\Users\\a\\AppData\\Local\\Temp\\run-987\\out.log'));
    expect(normalizeCommand('Bash git show 3f9a2c1d')).toBe(normalizeCommand('Bash git show a1b2c3d4e5'));
    expect(normalizeCommand('Bash echo 2026-10-12T14:38:00Z')).toBe(normalizeCommand('Bash echo 2026-10-13T09:01:22Z'));
    expect(normalizeCommand("bash -lc 'npm test'")).toBe('npm test');
    expect(normalizeCommand('Read db/migration_001.sql')).not.toBe(normalizeCommand('Read db/migration_002.sql'));
    expect(isCheapCommand(normalizeCommand('Bash git status'))).toBe(true);
    expect(isCheapCommand(normalizeCommand('Bash npm test'))).toBe(false);
  });
});

describe('a. repeated command', () => {
  it('a read-only helper running the same failing command 6 times with nothing new in between is a loop', () => {
    const d = drive({ canEdit: false, probed: false });
    for (let i = 0; i < 6; i++) { d.step(MIN); d.feed(tool('Bash npm test')); d.feed(say(`The test still fails, let me try again (${i}).`)); }
    const v = d.first();
    expect(v?.loop && v.kind).toBe('repeat');
    if (v?.loop) { expect(v.evidence.count).toBe(6); expect(describeLoop(v.evidence)).toMatch(/ran `bash npm test` 6 times in 5 minutes without doing anything new/); }
  });

  it('benign: cheap reads count at a higher limit; a test re-run after the files changed is never a repeat', () => {
    const r = drive({ canEdit: false, probed: false });
    for (let i = 0; i < DEFAULT_LOOP_LIMITS.cheapRepeatLimit - 1; i++) { r.step(MIN); r.feed(tool('Bash git status')); }
    expect(r.first()).toBeUndefined();

    const e = drive({ canEdit: true, probed: true });
    e.probe('fp0');
    for (let i = 0; i < 30; i++) { e.step(2 * MIN); e.feed(tool('Edit src/a.ts')); e.feed(tool('Bash npm test')); e.probe(`fp${i + 1}`); }
    expect(e.first()).toBeUndefined();
  });
});

describe('b. short cycles', () => {
  it('Bash echo test / Write <test> repeated with an unchanged worktree is a cycle (the stuck-tooling signature)', () => {
    const d = drive({ canEdit: true, probed: true });
    d.probe('same');
    for (let i = 0; i < 12 && !d.first(); i++) {
      d.step(MIN); d.feed(tool('Bash echo test'));
      d.step(MIN); d.feed(tool('Write tests/foo.test.ts')); d.probe('same');
    }
    const v = d.first();
    expect(v?.loop && v.kind).toBe('cycle');
    if (v?.loop) expect(v.evidence.what).toBe('bash echo test -> write tests/foo.test.ts');
    expect(d.now()).toBeLessThanOrEqual(10 * MIN);
  });

  it('benign: the same edit/test cycle while the files change is not a loop', () => {
    const d = drive({ canEdit: true, probed: true });
    for (let i = 0; i < 40; i++) { d.step(MIN); d.feed(tool('Edit src/a.ts')); d.step(MIN); d.feed(tool('Bash npm test')); d.probe(`v${i}`); }
    expect(d.first()).toBeUndefined();
  });
});

/** Ten known commands in an order with no short cycle and no command more than 3 times in 30 events. */
const POOL = Array.from({ length: 10 }, (_, i) => `Bash node scripts/check-${'abcdefghij'[i]}.js`);
const ORDER = [0, 3, 7, 1, 9, 4, 2, 8, 5, 6, 1, 4, 0, 7, 3, 9, 6, 2, 5, 8, 4, 1, 7, 0, 9, 3, 6, 8, 2, 5];

describe('c. no progress while active', () => {
  it('edit helper: worktree unchanged for 15 minutes while it keeps going is a loop; with changes it is not', () => {
    for (const changing of [false, true]) {
      const d = drive({ canEdit: true, probed: true });
      for (const c of POOL) d.feed(tool(c)); // all known now
      d.probe('fp');
      for (let i = 0; i < 30 && !d.first(); i++) {
        d.step(MIN); d.feed(tool(POOL[ORDER[i]!]!));
        if (i % 2) d.probe(changing ? `fp${i}` : 'fp');
      }
      const v = d.first();
      if (changing) expect(v).toBeUndefined();
      else { expect(v?.loop && v.kind).toBe('no-progress'); if (v?.loop) expect(describeLoop(v.evidence)).toMatch(/without changing any files/); }
    }
  });

  it('read-only helper: nothing new for 12 minutes while active is a loop; new findings keep it going', () => {
    const d = drive({ canEdit: false, probed: false });
    for (const c of POOL) d.feed(tool(c));
    for (let i = 0; i < 30 && !d.first(); i++) { d.step(MIN); d.feed(tool(POOL[ORDER[i]!]!)); }
    const v = d.first();
    expect(v?.loop && v.kind).toBe('no-progress');
    expect(d.now()).toBeLessThanOrEqual(14 * MIN);

    const ok = drive({ canEdit: false, probed: false });
    for (let i = 0; i < 60; i++) { ok.step(MIN); ok.feed(tool(i % 4 === 0 ? `Read src/module${i}.ts` : POOL[ORDER[i % 30]!]!)); }
    expect(ok.first()).toBeUndefined();
  });

  it('a long single command (no events) is never flagged, however long the worktree stays unchanged', () => {
    const d = drive({ canEdit: true, probed: true });
    d.probe('fp'); d.feed(tool('Bash npm test'));
    for (let i = 0; i < 30; i++) { d.step(2 * MIN); d.probe('fp'); }
    d.feed(say('All 900 tests passed.'));
    expect(d.first()).toBeUndefined();
  });
});

describe('d. waiting loops', () => {
  it('6 "waiting" notes over 15 minutes with nothing new is a loop; a few polls of a running suite are not', () => {
    const d = drive({ canEdit: false, probed: false });
    d.feed(tool('Bash npm run e2e'));
    for (let i = 0; i < 8 && !d.first(); i++) { d.step(3 * MIN); d.feed(say(i % 2 ? 'Still running.' : 'Waiting for the run to finish.')); }
    const v = d.first();
    expect(v?.loop && v.kind).toBe('waiting');

    const ok = drive({ canEdit: false, probed: false });
    ok.feed(tool('Bash npm run e2e'));
    for (let i = 0; i < 5; i++) { ok.step(2 * MIN); ok.feed(say('Waiting for the run to finish.')); }
    ok.feed(say('The run finished: all green.'));
    expect(ok.first()).toBeUndefined();
  });
});

describe('probe errors', () => {
  it('a failing probe gives no information: an edit helper whose probe always fails is never flagged for its edit/test cycle', async () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const w = new LoopWatch({ canEdit: true, probeCwd: '/wt', probe: async () => { throw new Error('git broke'); }, setTimer: (fn) => { timers.push(fn); return () => {}; }, now: () => now });
    const seen: LoopVerdict[] = [];
    for (let i = 0; i < 40; i++) {
      now += MIN;
      seen.push(w.observe(tool('Write tests/foo.test.ts')), w.observe(tool('Bash npx vitest run tests/foo.test.ts')));
      timers.shift()?.(); await Promise.resolve(); await Promise.resolve();
    }
    w.stop();
    expect(seen.some((v) => v.loop)).toBe(false);
  });
});

/** Seeded PRNG (mulberry32): deterministic streams, no Math.random. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('simulation', () => {
  it('detects the evidence-shaped loops within a few minutes', () => {
    // Implementer stuck on tooling: echo test / rewrite the test file, worktree unchanged.
    const a = drive({ canEdit: true, probed: true });
    a.probe('wt');
    let n = 0;
    while (!a.first() && n < 60) { a.step(40_000); a.feed(tool(n % 2 ? 'Write tests/ledger.test.ts' : 'Bash echo test')); n++; if (n % 3 === 0) a.probe('wt'); }
    expect(a.first()?.loop).toBe(true);
    expect(n).toBeLessThanOrEqual(24);

    // Consolidate helper: TaskStop / ToolSearch over and over.
    const b = drive({ canEdit: false, probed: false });
    n = 0;
    while (!b.first() && n < 60) { b.step(30_000); b.feed(tool(n % 2 ? 'ToolSearch select:TaskStop' : 'TaskStop')); b.feed(say('Let me stop the background task.')); n++; }
    expect(b.first()?.loop).toBe(true);
    expect(n).toBeLessThanOrEqual(10);

    // "Other" helper polling a run that never changes.
    const c = drive({ canEdit: false, probed: false });
    c.feed(tool('Bash npm run build'));
    n = 0;
    while (!c.first() && n < 60) { c.step(150_000); c.feed(say('Waiting for the run to finish.')); n++; }
    expect(c.first()?.loop).toBe(true);
    expect(c.now()).toBeLessThanOrEqual(20 * MIN);
  });

  it('a productive helper stream (explore, edit/test cycles, commits, polls) is never flagged across 20 seeds', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed);
      const d = drive({ canEdit: true, probed: true });
      let fp = 0, file = 0, nextProbe = 2 * MIN;
      const advance = (ms: number) => { d.step(ms); while (d.now() >= nextProbe) { d.probe(`fp${fp}`); nextProbe += 2 * MIN; } };
      while (d.now() < 70 * MIN) {
        const phase = r();
        const steps = 3 + Math.floor(r() * 8);
        for (let s = 0; s < steps; s++) {
          advance(20_000 + Math.floor(r() * 70_000));
          if (phase < 0.3) d.feed(tool(r() < 0.5 ? `Read src/mod${file++}.ts` : `Grep pattern${file++}`));
          else if (phase < 0.7) { d.feed(tool(s % 2 ? 'Bash npm test' : `Edit src/mod${Math.floor(r() * 5)}.ts`)); if (s % 2 === 0) fp++; }
          else if (phase < 0.85) { d.feed(tool(['Bash npm run typecheck', 'Bash git status', 'Bash git diff', 'Bash npm test'][s % 4]!)); if (s % 4 === 3) { d.feed(tool('Bash git commit -m "step"')); fp++; } }
          else { d.feed(s === 0 ? tool('Bash npm run build') : say(r() < 0.5 ? 'Waiting for the build to finish.' : 'Still running.')); }
          if (r() < 0.3) d.feed(say(`Progress note ${file}: ${r() < 0.5 ? 'the parser handles' : 'next, the writer covers'} case ${Math.floor(r() * 1000)}.`));
        }
      }
      expect({ seed, v: d.first() }).toEqual({ seed, v: undefined });
    }
  });
});

describe('progress probe (real git)', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  it('changes with commits, edits in place and untracked content; read-only; fails soft outside a repository', async () => {
    const d = mkdtempSync(join(tmpdir(), 'harbor-probe-')); dirs.push(d);
    const g = (...a: string[]) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(d, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
    const probe = gitProgressProbe(new Git());
    const p0 = await probe(d);
    expect(p0).toMatch(/^[0-9a-f]{64}$/);
    expect(await probe(d)).toBe(p0); // stable
    writeFileSync(join(d, 'a.txt'), 'two\n'); // edit in place: same shortstat, different content
    const p1 = await probe(d);
    expect(p1).not.toBe(p0);
    writeFileSync(join(d, 'new.txt'), 'x');
    const p2 = await probe(d);
    // Untracked files count by size and mtime (their content is never read, it could be a .env): a change that alters the size shows.
    writeFileSync(join(d, 'new.txt'), 'yy');
    const p3 = await probe(d);
    expect(p3).not.toBe(p2);
    writeFileSync(join(d, 'new.txt'), 'zz'); // same size: only the mtime differs
    utimesSync(join(d, 'new.txt'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(await probe(d)).not.toBe(p3);
    const status = g('status', '--porcelain').stdout;
    expect(status).toContain('a.txt'); // the probe changed nothing
    const notRepo = mkdtempSync(join(tmpdir(), 'harbor-probe-none-')); dirs.push(notRepo);
    expect(await probe(notRepo)).toBeUndefined();
  });
});

describe('helper contract', () => {
  it('tells helpers to stop repeating a failing command or fix', () => {
    expect(PROTOCOL).toContain('If the same command or fix fails twice with the same result, stop repeating it');
  });
});
