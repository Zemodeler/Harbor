import type { Complexity } from './router';

/**
 * Automatic complexity from the request itself. Pure and transparent: every point comes from a named signal, and the signals
 * are returned so the routing reason can show them. It is a guess from wording, not an understanding of the repository, which
 * is why the orchestrator only lets it RAISE a cheaper model's rating (never lower it) once a concierge has judged the message.
 *
 * Scoring: high needs 2 points. Strong hard-work words are worth 2 on their own, softer ones 1; a question phrased as "explain
 * ..." takes 1 away (asking about a hard topic is not hard work); long specs, many file paths and plan/goal modes add points.
 * Low needs a clear small cue (typo, rename, explain, status, one-line question) with no hard-work word, a short text and at most
 * one path. Everything else is medium.
 */
export interface ComplexityInput {
  text: string;
  /** Attached files or images (count or the list). */
  attachments?: number | readonly unknown[];
  /** Files in the project, when known: a large repository makes a hard-work word count for more. */
  projectFileCount?: number;
  /** The folder looks like a real repository (has git history, a manifest or tests). */
  hasRepoSignals?: boolean;
  mode?: 'default' | 'auto' | 'plan' | 'goal';
}

export interface ComplexityEstimate { complexity: Complexity; signals: string[] }

/** Worth 2 points each: words that name hard, wide or risky work. */
const STRONG: Array<[RegExp, string]> = [
  [/\bre-?factor\w*/i, 'refactor'],
  [/\bre-?write\b|\brewrit(?:e|ing)\b/i, 'rewrite'],
  [/\bre-?architect\w*|\barchitecture\b|\barchitectural\b/i, 'architecture'],
  [/\bmigrat(?:e|ion|ions|ing)\b/i, 'migration'],
  [/\broot[- ]cause\b/i, 'root cause'],
  [/\bsecurity\b|\bvulnerab\w*|\bexploit\w*/i, 'security'],
  [/\brace conditions?\b|\bdeadlocks?\b/i, 'race condition'],
  [/\b(?:across|throughout|in) (?:the |this |our )?(?:whole |entire )?(?:code ?base|repo(?:sitory)?|project|app(?:lication)?)\b/i, 'across the codebase'],
  [/\bmulti-?(?:file|module|package|service)\b|\bmany files\b|\ball (?:the )?(?:files|modules|services)\b/i, 'multi-file'],
  [/\bfrom scratch\b|\bend[- ]to[- ]end\b/i, 'from scratch / end-to-end'],
  [/\b(?:design|build|implement|add)\b[^.\n]{0,40}\b(?:feature|system|service|pipeline|framework|engine|subsystem|module)\b/i, 'new feature or system']
];
/** Worth 1 point each: hard-sounding topics that a small question can also mention. */
const WEAK: Array<[RegExp, string]> = [
  [/\bauth(?:entication|orization)\b/i, 'auth'],
  [/\bperformance\b|\boptimi[sz]\w*|\bslow\b|\bfaster\b|\bspeed up\b|\blatency\b|\bmemory leak\b/i, 'performance'],
  [/\bconcurren\w+|\bthread[- ]?safe\w*|\basync\b|\bparallel\w*/i, 'concurrency'],
  [/\bflak(?:y|iness|e)\b|\bintermittent\w*|\bnon-?determinis\w*/i, 'flaky'],
  [/\bcomplex\b|\btricky\b|\bsubtle\b|\bhard to\b/i, 'self-described hard']
];
/** Phrasings of a question or small chore. */
const LOW_CUES: Array<[RegExp, string]> = [
  [/^\s*(?:please\s+)?(?:explain|describe|summari[sz]e|what(?:'s| is| does| are)|where(?:'s| is| are)|which|show me|list|tell me|how do i (?:run|start|use))\b/i, 'explanation or lookup'],
  [/\btypos?\b|\bspelling\b|\bwhitespace\b|\bformat(?:ting)?\b|\bprettier\b|\blint(?:ing)? (?:error|warning)s?\b/i, 'typo or formatting'],
  [/\brename\b|\bbump (?:the )?version\b|\bupdate (?:the )?(?:comment|docstring|readme|changelog)\b|\badd (?:a )?(?:comment|docstring)\b/i, 'small mechanical edit'],
  [/^\s*(?:status\b|what(?:'s| is) the status|how(?:'s| is) it going)/i, 'status ask'],
  [/\bone[- ]?liner\b|\bsingle (?:line|file|function)\b|\bjust (?:the|this) (?:one )?(?:line|file|function)\b/i, 'single-file scope']
];
const QUESTION_START = /^\s*(?:please\s+)?(?:explain|describe|what|why|how|where|which|who|when|is|are|does|do|can|could|should)\b/i;

const PATH = /(?:[\w.-]+[\\/])+[\w.-]+\.\w{1,6}\b|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|cpp|c|h|rb|php|swift|css|scss|html|json|ya?ml|toml|sql|sh|md)\b/gi;

/** Distinct file paths named in the text. */
export function pathsIn(text: string): string[] {
  return [...new Set((text.match(PATH) ?? []).map((p) => p.toLowerCase()))];
}

export function estimateComplexity(i: ComplexityInput): ComplexityEstimate {
  const text = i.text.trim();
  const signals: string[] = [];
  let high = 0;
  for (const [re, name] of STRONG) if (re.test(text)) { high += 2; signals.push(`+2 ${name}`); }
  for (const [re, name] of WEAK) if (re.test(text)) { high += 1; signals.push(`+1 ${name}`); }

  const paths = pathsIn(text);
  if (paths.length >= 4) { high += 2; signals.push(`+2 ${paths.length} files named`); }
  else if (paths.length >= 2) { high += 1; signals.push(`+1 ${paths.length} files named`); }

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const bullets = (text.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) ?? []).length;
  if (text.length > 1500 || (paragraphs >= 3 && text.length > 600) || bullets >= 6) { high += 2; signals.push(`+2 long spec (${text.length} chars, ${paragraphs} paragraphs, ${bullets} list items)`); }
  else if (text.length > 700 || bullets >= 3) { high += 1; signals.push(`+1 detailed request (${text.length} chars)`); }

  if (i.mode === 'plan' || i.mode === 'goal') { high += 2; signals.push(`+2 ${i.mode} mode`); }
  const attached = typeof i.attachments === 'number' ? i.attachments : i.attachments?.length ?? 0;
  if (attached >= 3) { high += 1; signals.push(`+1 ${attached} attachments`); }
  if ((i.projectFileCount ?? 0) >= 500 && high >= 1) { high += 1; signals.push(`+1 large project (${i.projectFileCount} files)`); }

  const question = QUESTION_START.test(text) && /\?\s*$|^\s*(?:please\s+)?(?:explain|describe)\b/i.test(text);
  if (question && high > 0 && high < 3) { high -= 1; signals.push('-1 phrased as a question'); }

  if (high >= 2) return { complexity: 'high', signals };

  const lowHits = LOW_CUES.filter(([re]) => re.test(text)).map(([, n]) => n);
  const short = text.length <= 300 && text.split(/\s+/).length <= 50;
  const hardWord = signals.some((s) => s.startsWith('+'));
  if (lowHits.length && !hardWord && short && paths.length <= 1) return { complexity: 'low', signals: [...lowHits.map((n) => `low: ${n}`), ...signals] };
  if (!hardWord && short && question && paths.length === 0 && i.hasRepoSignals !== true && text.split(/\s+/).length <= 12) return { complexity: 'low', signals: ['low: short question'] };
  return { complexity: 'medium', signals: signals.length ? signals : ['no strong signal'] };
}

const RANK: Record<Complexity, number> = { low: 0, medium: 1, high: 2 };

/**
 * The orchestrator's rule: a concierge's rating is only ever RAISED to high by the estimate (a cheap model under-rating hard work
 * is the known failure); with no concierge (the message was plainly work) the estimate stands alone. Returns the complexity and a
 * note for the routing reason.
 */
export function combineComplexity(estimate: ComplexityEstimate, concierge?: Complexity): { complexity: Complexity; note: string } {
  const sig = estimate.signals.join('; ');
  if (concierge === undefined) return { complexity: estimate.complexity, note: `complexity ${estimate.complexity} estimated from the request (${sig})` };
  if (estimate.complexity === 'high' && RANK[concierge] < RANK.high) return { complexity: 'high', note: `complexity raised ${concierge} → high by the request's own signals (${sig}); the concierge said ${concierge}` };
  return { complexity: concierge, note: `complexity ${concierge} from the concierge (request signals: ${estimate.complexity}; ${sig})` };
}
