import type { AgentRole } from '../shared/api';
import { EFFORT_BONUS, capabilityFloor, capabilityOf, maxDifficultyFor } from './budgetCost';
import type { TaskSize } from './calibration';
import { autoRoutable, type CatalogEntry, type Need } from './clis/capabilities';
import { bindingNeed } from './routePrice';
import { estimateComplexity, pathsIn } from './complexity';
import type { Complexity } from './router';

/**
 * Difficulty of one piece of work on a 0-10 scale, computed by Harbor from concrete signals. The lead's own rating is only a HINT:
 * in a real run the lead rated all twelve helpers "high", which bought Opus for reviewers and small edits. Pure and transparent:
 * every point comes from a named signal, returned for the routing reason.
 *
 * Start: the hint (low 2, medium 5, high 7), or the request's own wording (complexity.ts) when there is none. Then:
 *   files claimed: none named +0.5 (ambiguous scope), 1 file -1, 2-3 files 0, 4-7 +1, 8 or more +2;
 *   instructions: under 160 characters -0.5, over 1500 +0.5, over 4000 +1;
 *   risk words (concurrency, security, migration, root cause, refactor, race, lease/lock/transaction, schema): +0.5 each, at most +2;
 *   no deliverable named (no verb such as add, fix, implement, write, review): +0.5;
 *   verification required (an edit that Harbor's checks will judge): +0.5;
 *   an implementer that follows a planner's spec: -1 (the hard thinking is in the spec).
 * Clamps, in order: above 7 needs at least 2 independent risk words (a bare "high" stays at 7); a reviewer or a read-only 'other'
 * helper never exceeds 5 (reading and judging is not the hard part); a planner is at least 3 (it reads code); 0..10.
 * Every number is a STARTING VALUE for the Phase 5 simulator.
 */

export interface DifficultyInput {
  role: AgentRole;
  /** The instructions (or the user's request for the lead). */
  text: string;
  /** The task's files claim; undefined = not stated (the whole project may be in play). */
  files?: readonly string[];
  /** Files in the project, when known: used for the scope when no files are claimed. */
  projectFileCount?: number;
  /** Read-only work (access read): research, review. */
  readOnly?: boolean;
  /** The lead's or the concierge's complexity: a hint, blended and clamped. */
  hint?: Complexity;
  /** Harbor will run checks on the result. */
  verify?: boolean;
  /** An implementer whose specification comes from a planner. */
  hasSpec?: boolean;
}

export interface DifficultyEstimate {
  /** 0 (trivial) .. 10 (the hardest work the best model can still do), in half steps. */
  difficulty: number;
  size: TaskSize;
  signals: string[];
  /** What the size came from, so a refusal can name it (sizeGate.gateSize / describeDrivers). */
  drivers: SizeDrivers;
}

export interface SizeDrivers { files: number | undefined; chars: number; risks: string[] }

export const HINT_DIFFICULTY: Record<Complexity, number> = { low: 2, medium: 5, high: 7 };
/** Difficulty assumed from a bare complexity label when a caller computed nothing else (old callers, the lead's own turn). */
export const COMPLEXITY_DIFFICULTY: Record<Complexity, number> = { low: 2, medium: 5, high: 8 };
/** Above this a task needs at least MIN_RISK_FOR_HARD independent risk words. */
export const UNPROVEN_MAX = 7;
export const MIN_RISK_FOR_HARD = 2;
/** Reading and judging work (reviewers, read-only 'other' helpers) never rates above this. */
export const READ_ONLY_MAX = 5;
export const PLANNER_MIN = 3;

const RISK: Array<[RegExp, string]> = [
  [/\bconcurren\w*|\bparallel\w*|\bthread[- ]?safe\w*/i, 'concurrency'],
  [/\bsecurity\b|\bvulnerab\w*|\bexploit\w*|\bauth(?:entication|orization)\b/i, 'security'],
  [/\bmigrat(?:e|es|ed|ion|ions|ing)\b/i, 'migration'],
  [/\broot[- ]cause\b/i, 'root cause'],
  [/\bre-?factor\w*/i, 'refactor'],
  [/\brace(?: condition)?s?\b|\bdeadlocks?\b/i, 'race'],
  [/\blease\w*|\block(?:s|ing|file)?\b|\bmutex\w*|\btransaction\w*/i, 'lease/lock/transaction'],
  [/\bschema\w*/i, 'schema']
];
const DELIVERABLE = /\b(?:add|fix|implement|write|create|update|remove|delete|rename|change|build|refactor|migrate|review|test|verify|check|document|plan|design|investigate|find|list|explain|report|move|replace|port)\w*/i;

/** NaN (a bad external number) clamps to `lo` instead of poisoning every score it feeds. */
const clamp = (v: number, lo: number, hi: number) => (Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)));
const half = (v: number) => Math.round(v * 2) / 2;

/** The user-facing label: <= 3 low, <= 6 medium, else high. */
export function complexityOf(difficulty: number): Complexity {
  return difficulty <= 3 ? 'low' : difficulty <= 6 ? 'medium' : 'high';
}

/** Size of the work for the cost estimates: files claimed and instruction length (or the risk count for a sprawling task). */
function sizeOf(files: number | undefined, chars: number, risk: number): TaskSize {
  if ((files !== undefined && files >= 8) || chars > 3000 || risk >= 3) return 'large';
  if ((files === undefined || files <= 1) && chars < 600) return 'small';
  return 'medium';
}

export function difficultyOf(i: DifficultyInput): DifficultyEstimate {
  const text = i.text.trim();
  const signals: string[] = [];
  let d: number;
  if (i.hint) { d = HINT_DIFFICULTY[i.hint]; signals.push(`hint ${i.hint} = ${d}`); }
  else { const est = estimateComplexity({ text, projectFileCount: i.projectFileCount }); d = HINT_DIFFICULTY[est.complexity]; signals.push(`wording ${est.complexity} = ${d}`); }
  const add = (n: number, why: string) => { if (n) { d += n; signals.push(`${n > 0 ? '+' : ''}${n} ${why}`); } };

  const named = i.files?.length ?? pathsIn(text).length;
  const files = i.files !== undefined || named > 0 ? named : undefined;
  if (files === undefined || files === 0) add(0.5, (i.projectFileCount ?? 0) >= 500 ? `no files named (${i.projectFileCount} in the project)` : 'no files named');
  else if (files === 1) add(-1, '1 file');
  else if (files >= 8) add(2, `${files} files`);
  else if (files >= 4) add(1, `${files} files`);

  if (text.length > 4000) add(1, `long instructions (${text.length} chars)`);
  else if (text.length > 1500) add(0.5, `long instructions (${text.length} chars)`);
  else if (text.length < 160) add(-0.5, 'short instructions');

  const risks = RISK.filter(([re]) => re.test(text)).map(([, n]) => n);
  if (risks.length) add(Math.min(2, 0.5 * risks.length), `risk: ${risks.join(', ')}`);
  if (!DELIVERABLE.test(text)) add(0.5, 'no deliverable named');
  if (i.verify) add(0.5, 'checks will verify it');
  if (i.hasSpec && i.role === 'implementer') add(-1, "follows a planner's spec");

  if (d > UNPROVEN_MAX && risks.length < MIN_RISK_FOR_HARD) { signals.push(`capped at ${UNPROVEN_MAX}: fewer than ${MIN_RISK_FOR_HARD} risk signals`); d = UNPROVEN_MAX; }
  if ((i.role === 'reviewer' || (i.role === 'other' && i.readOnly)) && d > READ_ONLY_MAX) { signals.push(`capped at ${READ_ONLY_MAX}: ${i.role === 'reviewer' ? 'review' : 'read-only'} work`); d = READ_ONLY_MAX; }
  if (i.role === 'planner' && d < PLANNER_MIN) { signals.push(`raised to ${PLANNER_MIN}: a planner reads code`); d = PLANNER_MIN; }
  return { difficulty: half(clamp(d, 0, 10)), size: sizeOf(files, text.length, risks.length), signals, drivers: { files, chars: text.length, risks } };
}

/** One step of the capability floor: the effort bonuses come in quarter levels (budgetCost.EFFORT_BONUS). */
export const FLOOR_STEP_LEVEL = 0.25;

/**
 * The difficulty of a redo of REJECTED work (a reviewer asked for changes, or a check Harbor ran failed): the smallest half-step
 * difficulty whose capability floor is one step (a quarter level) above the old one, so the same model needs one effort step more
 * (or a stronger model, when that is cheaper). Never above what `strongestLevel` (the best auto-routable model at high effort) can
 * clear, so a retry is never routed to a model kept out of automatic routing nor asked for more than any model can do.
 */
export function raiseDifficulty(d: number, strongestLevel: number): number {
  const cap = maxDifficultyFor(strongestLevel);
  const target = capabilityFloor(d) + FLOOR_STEP_LEVEL;
  for (let x = Math.floor(d * 2) / 2 + 0.5; x <= 10; x += 0.5) if (capabilityFloor(x) >= target - 1e-9) return Math.max(d, Math.min(x, cap));
  return Math.max(d, Math.min(10, cap));
}

/** What the best auto-routable model can reach at high effort for these needs: an escalated retry never asks for more (5 with no model). */
export function strongestLevel(catalog: readonly CatalogEntry[], needs?: readonly Need[]): number {
  const auto = catalog.filter(autoRoutable);
  return auto.length ? Math.max(...auto.map((e) => capabilityOf(e, bindingNeed(e, needs)) + EFFORT_BONUS.high)) : 5;
}
