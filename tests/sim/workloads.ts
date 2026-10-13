import type { AgentRole } from '../../src/shared/api';
import type { TaskSize } from '../../src/main/calibration';
import type { Need } from '../../src/main/clis/capabilities';
import { Rng } from './prng';
import { DAY, HOUR, MIN } from './world';

/**
 * Seeded workload generators for the week simulator. A workload is a list of arrivals: helper tasks (what a lead delegates) and
 * interactive turns (the concierge's first pass and the lead's own turns, which the owner waits on). Times are absolute (epoch ms).
 * Working hours: 08:00-20:00 UTC on weekdays, 10:00-16:00 at weekends (the simulated week starts on a Monday).
 */

export type TaskKind = 'helper' | 'lead' | 'concierge';

export interface TaskSpec {
  id: string;
  conv: string;
  arrival: number;
  kind: TaskKind;
  role: AgentRole;
  difficulty: number;
  size: TaskSize;
  needs: Need[];
  dependsOn: string[];
  /** Extra chance that the work is rejected whatever the model (flaky tests, unclear spec). */
  flaky?: number;
}

export interface Workload { name: WorkloadName; tasks: TaskSpec[]; deadlines: Record<string, number> }

export type WorkloadName = 'steady' | 'bursty' | 'heavy' | 'light' | 'deadline' | 'deadline-none' | 'chronica';

/** Monday 2026-10-05 06:00 UTC: the simulated week starts here. */
export const T0 = Date.UTC(2026, 9, 5, 6, 0);

export function isWorkHour(t: number): boolean {
  const d = new Date(t), h = d.getUTCHours(), wd = d.getUTCDay();
  return wd === 0 || wd === 6 ? h >= 10 && h < 16 : h >= 8 && h < 20;
}

const ROLES: Array<[AgentRole, number]> = [['implementer', 0.55], ['reviewer', 0.2], ['planner', 0.1], ['other', 0.15]];

function weighted<T>(rng: Rng, xs: ReadonlyArray<readonly [T, number]>): T {
  let r = rng.u() * xs.reduce((s, [, w]) => s + w, 0);
  for (const [x, w] of xs) { r -= w; if (r <= 0) return x; }
  return xs[xs.length - 1]![0];
}

/** Difficulty in half steps, 0..10, with a role's usual range (reviewers and read-only work stay <= 5, planners >= 3). */
function difficulty(rng: Rng, role: AgentRole, mix: 'normal' | 'hard'): number {
  const base = mix === 'hard' ? 4.5 + 4 * rng.u() : weighted(rng, [[1 + 2 * rng.u(), 0.35], [3.5 + 2.5 * rng.u(), 0.4], [6.5 + 3 * rng.u(), 0.25]] as const);
  let d = Math.round(base * 2) / 2;
  if (role === 'reviewer' && d > 5) d = 5;
  if (role === 'planner' && d < 3) d = 3;
  return Math.min(10, Math.max(0, d));
}

function size(rng: Rng, mix: 'normal' | 'hard'): TaskSize {
  return weighted(rng, mix === 'hard' ? [['small', 0.15], ['medium', 0.5], ['large', 0.35]] as const : [['small', 0.35], ['medium', 0.5], ['large', 0.15]] as const);
}

class Gen {
  tasks: TaskSpec[] = [];
  private n = 0;
  constructor(readonly rng: Rng) {}
  id(p: string) { return `${p}${++this.n}`; }
  helper(conv: string, at: number, o: Partial<TaskSpec> & { mix?: 'normal' | 'hard' } = {}): TaskSpec {
    const role = o.role ?? weighted(this.rng, ROLES);
    const mix = o.mix ?? 'normal';
    const t: TaskSpec = {
      id: this.id('h'), conv, arrival: at, kind: 'helper', role,
      difficulty: o.difficulty ?? difficulty(this.rng, role, mix), size: o.size ?? size(this.rng, mix),
      needs: o.needs ?? [role === 'reviewer' ? 'review' : role === 'planner' ? 'planning' : 'code'], dependsOn: o.dependsOn ?? [],
      ...(o.flaky !== undefined ? { flaky: o.flaky } : {})
    };
    this.tasks.push(t);
    return t;
  }
  /** One user message: the concierge's first pass, then (usually) a lead turn. */
  message(conv: string, at: number, leadChance = 0.6): void {
    this.tasks.push({ id: this.id('c'), conv, arrival: at, kind: 'concierge', role: 'main', difficulty: 2, size: 'small', needs: ['chat'], dependsOn: [] });
    if (!this.rng.chance(leadChance)) return;
    const d = Math.round((3 + 4 * this.rng.u()) * 2) / 2;
    this.tasks.push({ id: this.id('l'), conv, arrival: at + 2 * MIN, kind: 'lead', role: 'main', difficulty: d, size: this.rng.chance(0.7) ? 'small' : 'medium', needs: ['code'], dependsOn: [] });
  }
  /**
   * Poisson arrivals over the working hours of `days`, `perHour` (weekends at `weekend` of the rate). `weekend` 1 means the same
   * 08:00-20:00 day every day of the week (no weekend at all).
   */
  stream(start: number, days: number, perHour: number, each: (at: number) => void, weekend = 0.3): void {
    for (let h = 0; h < days * 24; h++) {
      const t = start + h * HOUR;
      const hour = new Date(t).getUTCHours();
      if (weekend >= 1 ? hour < 8 || hour >= 20 : !isWorkHour(t)) continue;
      const wd = new Date(t).getUTCDay();
      const n = this.rng.poisson(perHour * (wd === 0 || wd === 6 ? Math.min(1, weekend) : 1));
      for (let i = 0; i < n; i++) each(t + Math.floor(this.rng.u() * HOUR));
    }
  }
}

export interface WorkloadOptions { days: number; seed: number; scale?: number }

/** Builds a named workload (arrivals sorted by time). `scale` multiplies helper rates (tuning only). */
export function workload(name: WorkloadName, o: WorkloadOptions): Workload {
  const g = new Gen(new Rng(o.seed * 7919 + name.length));
  const s = o.scale ?? 1;
  const deadlines: Record<string, number> = {};
  let conv = 0;
  const convOf = (at: number) => `conv${Math.floor((at - T0) / (3 * HOUR))}`; // a conversation lasts about three hours
  const background = (perHour: number, msgPerHour: number, weekend = 0.3) => {
    g.stream(T0, o.days, perHour * s, (at) => g.helper(convOf(at), at), weekend);
    g.stream(T0, o.days, msgPerHour, (at) => g.message(convOf(at), at), weekend);
  };
  switch (name) {
    case 'steady':
      // Tasks all week, every day the same (08:00-20:00): about as much work as the two accounts' weekly quota holds at the models the
      // work needs. The governor has no notion of weekdays: a demand that changes by day of week is a different test (light, bursty).
      background(7.5, 3, 1);
      break;
    case 'light':
      background(0.6, 1);
      break;
    case 'heavy':
      // Demand well beyond the week's quota (about one and a half times it): hard work around the clock, every day. The second week
      // brings nothing new (arrivalDays 7 of 14): the queue must drain after the reset.
      for (const d of [0, 12]) g.stream(T0 + d * HOUR, o.days, 3.2 * s, (at) => g.helper(convOf(at), at, { mix: 'hard' }), 1);
      g.stream(T0, o.days, 4, (at) => g.message(convOf(at), at), 1);
      break;
    case 'bursty': {
      // About as much work as steady, but most of it in bursts: 26 helpers delegated within one hour, three times a day, over a
      // light background.
      background(1.5, 2, 1);
      for (let d = 0; d < o.days; d++) {
        for (const h of [3, 7, 11]) {
          const at = T0 + d * DAY + h * HOUR;
          const c = `burst${++conv}`;
          for (let i = 0; i < Math.round(26 * s); i++) g.helper(c, at + Math.floor(g.rng.u() * HOUR));
        }
      }
      break;
    }
    case 'deadline':
    case 'deadline-none': {
      // A conversation with a deadline 6 hours out and a big backlog (twelve plan -> implement -> review chains), delegated at once,
      // while steady work from other conversations keeps the pools busy. 'deadline-none' is the same week without the deadline.
      background(6, 3, 1);
      const c = 'deadline';
      const at = T0 + 2 * HOUR;
      if (name === 'deadline') deadlines[c] = at + 6 * HOUR;
      for (let i = 0; i < 12; i++) {
        const p = g.helper(c, at, { role: 'planner', size: 'medium', mix: 'normal' });
        const impl = g.helper(c, at, { role: 'implementer', dependsOn: [p.id], size: g.rng.chance(0.5) ? 'medium' : 'large' });
        g.helper(c, at, { role: 'reviewer', dependsOn: [impl.id], size: 'medium' });
      }
      break;
    }
    case 'chronica': {
      // A Chronica-like day: three hard, large implementers (split by the size gate), review, retries from flaky checks.
      const c = 'chronica';
      g.message(c, T0 + 2 * HOUR, 1);
      const plan = g.helper(c, T0 + 2 * HOUR + 10 * MIN, { role: 'planner', difficulty: 7, size: 'medium' });
      for (let i = 0; i < 3; i++) {
        const impl = g.helper(c, T0 + 2 * HOUR + 30 * MIN, { role: 'implementer', difficulty: 8, size: 'large', dependsOn: [plan.id], flaky: 0.25 });
        g.helper(c, T0 + 2 * HOUR + 30 * MIN, { role: 'reviewer', difficulty: 5, size: 'medium', dependsOn: [impl.id] });
      }
      g.stream(T0, o.days, 3, (at) => g.message(c, at, 0.8), 1);
      break;
    }
  }
  g.tasks.sort((a, b) => a.arrival - b.arrival || (a.id < b.id ? -1 : 1));
  return { name, tasks: g.tasks, deadlines };
}
