# Usage accounting and reset-aware execution

Status: implemented in `src/main/usage.ts` and `src/main/codexLimits.ts`, used by `router.ts`. It is deliberately modest. This page describes what is counted, what is only an estimate, what the provider reports, and what is not built. It must never be read as a statement of your provider quota.

## Goal

Keep authorized work progressing by routing each run to a CLI and model whose allowance can bear it, at a sensible effort, without letting two projects or two conversations each assume the same allowance is free. The ledger is application-wide because the subscriptions are shared.

## Assignment

CLI, model and effort are chosen per run by the router (see [Background routing](background-routing.md)); nothing is configured per agent. The router reads this ledger for each candidate model: how full each window is, whether a rate limit hit that model recently, and how the usage is trending. Harbor records the requested CLI, model and effort of every run with its reason on the message, and the effective values on the agent.

## What the ledger records

Each CLI run (concierge, lead turn, helper run, retry, follow-up) writes one usage event: CLI, model, project, agent, conversation, start time, duration, whether it succeeded, whether it was rate limited, and, when the CLI reported them, input and output tokens, a cost in dollars (Claude reports it; Codex reports tokens only), and the account limits the run printed. Events older than 8 days are folded into archive totals so lifetime figures survive pruning. Integration and rollback runs use no CLI and record nothing. Gemini has no adapter, so it records nothing and has no window.

Not tracked: planned or reserved consumption, usage outside Harbor, per-task attribution beyond the stored project, agent and conversation ids, tool activity as a separate unit. Spawn failures (the CLI could not even start) are, in the code I read, still recorded as runs; excluding them is planned.

## Three kinds of reading

| Kind | Where it comes from | How it is used |
| --- | --- | --- |
| Reported | The provider's own numbers. Claude: the `rate_limit_event` its stream prints during a Harbor run (five-hour and seven-day account windows, and per-model windows such as Opus or Fable). Codex: the newest of the five latest session logs under `~/.codex/sessions`, whose `rate_limits` give a primary (five-hour) and secondary (weekly) window. Harbor never opens Codex's auth files. | Wins over the estimate. Used with its reset time. A reported window whose reset time has passed is dropped as stale. |
| Estimated | Harbor's own count of the runs it started in a rolling window, divided by an assumed budget: 40 runs per five hours and 300 per seven days per CLI. Every run is one unit regardless of size. | Used when no reported window exists, labeled "estimated from Harbor runs only". Counts half as much as a reported reading in routing, and pace is not applied to it. |
| Unknown | Nothing is available (for example Gemini). | No window is shown. A missing reading never means unlimited or empty. |

Claude's windows can be stale: they are only learned when Harbor itself runs Claude, and they stay until their reset time. The per-model names (`seven_day_<model>`) are inferred from a naming pattern, not verified for every plan. When a window resets, estimated usage counts only the runs after the reset the CLI reported, so a window that already rolled over does not keep locking the CLI out.

Both windows are shown separately, with the provider's unit (a percentage) and a reset time when one is known. Harbor does not add unlike units into one figure, and never compares a percentage from one provider with another's.

## Levels and pace

For routing, each model's windows (account-wide five-hour and weekly, plus any per-model window that applies to it) become a level: plenty below 50% used, limited from 50%, low from 80%, exhausted at 100%. The worst window decides. On provider-reported windows, once at least 10% of the window has elapsed, Harbor projects where usage would land at reset (used percent divided by elapsed share): a projection of 100% or more raises the level one notch, and a projection under 70% lowers "limited" to "plenty". Estimated windows get no pace adjustment because their start is Harbor's first run, not the provider's window start. The projection is shown as `projectedPct` on a window.

A rate limit reported by a CLI in a run holds that model out for 30 minutes (judged per model, not for the whole CLI), and the reset time is unknown until the CLI reports one. The adapters' rate-limit pattern also matches "overloaded", so a provider overload currently holds the model out for 30 minutes like a quota limit (treating overload separately is planned). A sign-in failure removes the CLI from routing until the next refresh.

## What the user sees

The Usage tab lists each provider's windows with percentage, label ("reported by claude as of 14:32" or "estimated from Harbor runs only"), and reset time or "Reset time unknown". The plain levels are used by routing and are not displayed. There is no per-project or per-agent breakdown screen and no cost view yet. Usage updates stream through a `usage` event after every run.

## Pacing

Pacing is limited to what routing does: a tightening window raises the penalty on that model, a low window lowers effort or steers away (per the low-allowance policy), a reserve skips a model entirely, and an exhausted one is skipped until it resets. Harbor does not queue work to land after a reset, estimate a task's cost in advance, or generate work to use up allowance. Work that cannot run now fails with the reason; the user sends it again. It does not resume by itself after a reset, and it cannot run while the computer or Harbor is off.

Not built from the earlier design: planned and reserved consumption, estimating work before it runs, an unknown-usage policy, "defer" and "ask first" low-allowance behaviors, and attribution of account usage outside Harbor.

## Optional free resets

Some provider might one day expose a discretionary reset entitlement. **None does today**: the ledger's entitlement source defaults to "none", so `freeResetAvailable` is never set and the feature is dormant. The code path exists and its rules are firm:

- It is only ever proposed when an entitlement is confirmed from a supported source, the model's level is low or exhausted, tasks are waiting, the user has not already answered for the current five-hour window, and the setting is not "never".
- The proposal is a permission request, never automatic. It states the estimated usage (labeled Harbor-observed), the number of waiting tasks, the next scheduled refresh, and that the entitlement count is unknown. The user's yes or no is stored. A yes applies to that one reset.
- If Harbor has no supported way to perform the reset it reports "manual" and leaves the user to use the provider's own interface. Harbor does not retry.
- Declining is remembered for the window, so it does not re-ask repeatedly.

Do not describe this as a verified or free reset: no entitlement source has been verified for any provider. The README and this page therefore make no claim that a free reset exists.

## Acceptance criteria (status)

- CLI, model and effort are assigned automatically for every run. Met.
- Conversation, coordination and helper runs are counted where observable. Met for runs; spawn failures should be excluded and are not yet.
- Shared subscriptions are not independently overallocated by different projects: the ledger and routing are application-wide. Met for routing; concurrency limits are per project.
- Reported, estimated and unknown usage are distinguishable. Met in the engine and labels; per-model labels depend on what the CLI reports.
- Reset windows keep provider semantics (five-hour, weekly, per-model). Met where reported.
- A discretionary reset is never consumed without explicit permission. Met by construction (and dormant).
- Scheduled refresh unblocking queued work automatically. Not met.
