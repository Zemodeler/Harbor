import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexRateLimits, readCodexLimits } from '../src/main/codexLimits';
import { parseClaudeLine } from '../src/main/adapters/claude';
import { UsageLedger, WEEK_MS } from '../src/main/usage';
import { Store } from '../src/main/store';
import { createHarborService } from '../src/main/service';

const NOW = 1_800_000_000_000;
const line = (primary: number, secondary: number, resetsP = NOW / 1000 + 3600, resetsS = NOW / 1000 + 86400) => JSON.stringify({
  timestamp: new Date(NOW - 60_000).toISOString(),
  payload: { type: 'token_count', rate_limits: { primary: { used_percent: primary, window_minutes: 300, resets_at: resetsP }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: resetsS } } }
});

describe('codex reported limits', () => {
  it('uses the last rate_limits event and maps primary/secondary to session/weekly', () => {
    const r = parseCodexRateLimits(`${line(10, 1)}\nnoise\n${line(43, 8)}\n`, NOW);
    expect(r.map((l) => [l.period, l.usedPct])).toEqual([['session', 43], ['weekly', 8]]);
  });
  it('drops windows that already reset (stale percentage)', () => {
    const r = parseCodexRateLimits(line(90, 50, NOW / 1000 - 10), NOW);
    expect(r.map((l) => l.period)).toEqual(['weekly']);
  });
  it('reads the newest session log from disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'codexhome-'));
    try {
      const day = join(home, 'sessions', '2027', '01', '15'); mkdirSync(day, { recursive: true });
      writeFileSync(join(day, 'rollout-a.jsonl'), `${line(5, 2)}\n`);
      expect(readCodexLimits(NOW, home).find((l) => l.period === 'weekly')?.usedPct).toBe(2);
      expect(readCodexLimits(NOW, join(home, 'missing'))).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('weekly usage window', () => {
  it('estimates a rolling 7-day window and prefers reported values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-usage-'));
    try {
      const store = new Store(dir);
      let now = NOW;
      const ledger = new UsageLedger(store, { now: () => now, runsPerWeek: 4, reported: (c) => (c === 'codex' ? parseCodexRateLimits(line(20, 60), NOW) : []) });
      for (let i = 0; i < 2; i++) ledger.record({ cli: 'claude', projectId: 'p', agentId: 'a', model: 'm', durationMs: 1, ok: true });
      const [s, w] = ledger.windows(['claude']);
      expect([s.period, w.period, w.source, w.usedPct]).toEqual(['session', 'weekly', 'estimated', 50]);
      expect(w.resetsAt).toBe(NOW + WEEK_MS);
      const cw = ledger.windows(['codex']);
      expect(cw.map((x) => [x.source, x.usedPct])).toEqual([['reported', 20], ['reported', 60]]);
      expect(ledger.usedPct('codex')).toBe(60); // the tighter window drives routing
      now += WEEK_MS + 1;
      expect(ledger.windows(['claude'])[1].usedPct).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('claude reported limits', () => {
  it('parses rate_limit_event into session/weekly percentages', () => {
    const ev = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: NOW / 1000 + 100 }, seven_day: { utilization: 0.64, resetsAt: NOW / 1000 + 200 } } } });
    const c = parseClaudeLine(ev);
    expect(c).toHaveLength(1);
    const l = (c[0] as { limits: Array<{ period: string; usedPct: number; resetsAt: number }> }).limits;
    expect(l.map((x) => [x.period, Math.round(x.usedPct)])).toEqual([['session', 2], ['weekly', 64]]);
    expect(parseClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }))).toEqual([]);
  });
  it('ledger prefers limits observed in a Claude run over the Harbor-only estimate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-claude-lim-'));
    try {
      const ledger = new UsageLedger(new Store(dir), { now: () => NOW });
      const limits = [{ period: 'weekly' as const, usedPct: 64, resetsAt: NOW + 1000, asOf: NOW - 5 }];
      ledger.record({ cli: 'claude', projectId: 'p', agentId: 'a', model: 'm', durationMs: 1, ok: true, limits });
      const w = ledger.windows(['claude'])[1];
      expect([w.source, w.usedPct]).toEqual(['reported', 64]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('unmeasurable CLIs', () => {
  it('shows no window for a CLI Harbor cannot run or read (no fake 0%)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-measurable-'));
    try {
      const ledger = new UsageLedger(new Store(dir), { now: () => NOW, measurable: (c) => c !== 'gemini' });
      expect(ledger.windows(['claude', 'gemini']).map((w) => w.cli)).toEqual(['claude', 'claude']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('deleteConversation', () => {
  it('removes the conversation and its messages only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-del-')), proj = mkdtempSync(join(tmpdir(), 'harbor-proj-'));
    try {
      const svc = createHarborService({ dataDir: dir, discover: async () => [] });
      const p = (await svc.addProject(proj))!;
      const keep = await svc.newConversation(p.id), drop = await svc.newConversation(p.id);
      await svc.deleteConversation(drop.id);
      const ids = (await svc.listConversations(p.id)).map((c) => c.id);
      expect(ids).toContain(keep.id);
      expect(ids).not.toContain(drop.id);
      expect(await svc.listMessages(drop.id)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });
});

describe('CLI re-check', () => {
  it('re-discovers a CLI that disappeared after being seen, then stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-recheck-'));
    try {
      let calls = 0;
      const cli = (installed: boolean) => ({ id: 'claude', name: 'Claude Code', installed, signedIn: installed, models: [], authState: installed ? 'signedIn' : 'unknown' } as const);
      // call 1: installed, call 2 (manual refresh): missing, call 3 (auto re-check): back.
      const discover = async () => [cli(++calls !== 2)] as never;
      const svc = createHarborService({ dataDir: dir, discover, recheckDelaysMs: [20, 20] });
      await svc.listClis();
      expect((await svc.refreshClis())[0].installed).toBe(false);
      await new Promise((r) => setTimeout(r, 150));
      expect((await svc.listClis())[0].installed).toBe(true);
      expect(calls).toBe(3);
      svc.shutdown();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('re-checks a CLI that is missing on the very first (startup) check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-recheck-'));
    try {
      let calls = 0;
      const cli = (installed: boolean) => ({ id: 'claude', name: 'Claude Code', installed, signedIn: installed, models: [], authState: installed ? 'signedIn' : 'unknown' } as const);
      // call 1 (startup): missing mid-update, call 2 (auto re-check): back.
      const discover = async () => [cli(++calls > 1)] as never;
      const svc = createHarborService({ dataDir: dir, discover, recheckDelaysMs: [20, 20] });
      expect((await svc.listClis())[0].installed).toBe(false);
      await new Promise((r) => setTimeout(r, 150));
      expect((await svc.listClis())[0].installed).toBe(true);
      expect(calls).toBe(2);
      svc.shutdown();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not keep re-checking after a manual refresh finds a never-seen CLI missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-recheck-'));
    try {
      let calls = 0;
      const discover = async () => { calls++; return [{ id: 'gemini', name: 'Gemini', installed: false, signedIn: false, models: [], authState: 'unknown' }] as never; };
      const svc = createHarborService({ dataDir: dir, discover, recheckDelaysMs: [10, 10] });
      await svc.listClis();
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toBe(3); // startup chain only: 1 + 2 retries
      await svc.refreshClis();
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toBe(4); // manual refresh does not start a new chain
      svc.shutdown();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
