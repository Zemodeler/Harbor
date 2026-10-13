import type { AskRequest } from './prompts';

/**
 * Who answers a helper's HARBOR_ASK. PURE.
 *
 * In a real run the last helper waited 69 of its 75 minutes for the USER to answer "May I include the four packages/ai files from
 * c8afb84 unchanged?": a file-claim question its lead could have answered at once. Questions about file claims, scope inside the
 * assignment, or which branch or commit to build on now go to the lead first; the lead answers (Harbor forwards it), or decides the
 * question is the user's and asks them. Only questions that can only be the user's go straight to them: credentials, destructive
 * actions and publishing (the safety rules in AGENTS.md), plus a helper that asks again after the lead already answered once.
 * A question that reaches the user is answered with a SAFE DEFAULT after USER_QUESTION_TIMEOUT_MS instead of blocking forever, and
 * that default is always the conservative "no": nothing on the safety list is ever approved automatically.
 */

/** How long a helper's question to the user waits before Harbor answers it with the safe default. */
export const USER_QUESTION_TIMEOUT_MS = 10 * 60_000;
/** Questions one helper may send to the lead before the next one goes to the user (stops a helper and a lead looping). */
export const MAX_LEAD_ASKS = 1;

export type UserAskKind = 'credentials' | 'destructive' | 'publish' | 'repeat' | 'lead';

export type AskRoute = { to: 'lead' } | { to: 'user'; kind: UserAskKind };

const CREDENTIALS = /\b(?:passwords?|passphrases?|credentials?|secrets?|api[ -]?keys?|access[ -]?tokens?|auth(?:entication)? tokens?|tokens? for|ssh keys?|private keys?|\.env\b|sign(?:ing)?[ -]?in\b|log(?:ging)?[ -]?in\b|2fa|one[- ]time code|otp\b)/i;
const DESTRUCTIVE = /\b(?:reset --hard|git clean|clean -[a-z]*f|push --force|force[- ]push|branch -D|worktree remove|rm -rf|drop (?:the )?(?:table|database|schema|collection)s?|truncate|wipe|purge|delete (?:the |all |every )?(?:data|database|records|rows|branch(?:es)?|backups?|production|user data)|discard (?:the |all |your |my )?(?:changes|uncommitted|local|work)|overwrite (?:the |your |my )?(?:user'?s? )?(?:changes|work|data)|production (?:data|database))/i;
const PUBLISH = /\b(?:git push|push (?:it|this|the (?:branch|commit|changes)|to (?:origin|remote|main|master|github))|deploy|publish|release (?:it|this|a version|v\d)|merge (?:it |this )?(?:in)?to (?:main|master)|open a (?:pull request|pr)\b)/i;

/** The question and its options, as one text to classify. */
const textOf = (q: AskRequest): string => [q.question, ...q.options].join(' \n ');

/** `leadAsks`: how many questions this helper already sent to the lead in this assignment. */
export function routeAsk(q: AskRequest, o: { leadAsks: number; leadAvailable?: boolean }): AskRoute {
  const t = textOf(q);
  if (CREDENTIALS.test(t)) return { to: 'user', kind: 'credentials' };
  if (DESTRUCTIVE.test(t)) return { to: 'user', kind: 'destructive' };
  if (PUBLISH.test(t)) return { to: 'user', kind: 'publish' };
  if (o.leadAsks >= MAX_LEAD_ASKS) return { to: 'user', kind: 'repeat' };
  if (o.leadAvailable === false) return { to: 'user', kind: 'repeat' };
  return { to: 'lead' };
}

/** What a helper is told when the user did not answer in time. Never an approval. */
export function safeDefault(kind: UserAskKind, minutes: number): string {
  const head = `The user did not answer your question within ${minutes} minutes. Harbor applies the safe default:`;
  switch (kind) {
    case 'credentials': return `${head} NO. Do not use, request or create credentials, tokens or secrets. Continue without them within your assignment, or report that you are blocked and what you need.`;
    case 'destructive': return `${head} NO. Do not delete, discard, reset, overwrite or clean anything. Keep all existing work and data; continue without that step, or report that you are blocked.`;
    case 'publish': return `${head} NO. Do not push, deploy, publish or merge into main. Commit on your own branch only; Harbor and the user integrate.`;
    default: return `${head} take the most conservative option within your assignment: do not expand its scope and do not edit files outside the files you own. Say in your report what you assumed, so the lead can correct it.`;
  }
}
