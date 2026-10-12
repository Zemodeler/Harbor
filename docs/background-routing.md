# Background routing and settings

Status: implemented in `src/main/router.ts` (pure scoring), `src/main/clis/capabilities.ts` (the catalog, as data), `src/main/usage.ts` (allowance) and `src/main/orchestrator.ts` (fallback and scheduling). This document describes what the code does. The routing settings exist in the engine and the API; the committed Settings screen did not expose most of them, and a routing settings screen was uncommitted work in progress when this was written (see [Interface design](interface-design.md)). Where this page and the code disagree, the code wins.

## Purpose

Choose, for every run, which installed CLI and model should do the work and at what effort, so that an ordinary user never has to. Routing runs behind the conversation. The decision and its reason are stored with the message it produced (`details.reason`) and shown in Session information.

Routing works from the first launch with built-in defaults. A user does not configure a policy to begin. The router selects from CLIs that are installed, enabled, have a headless adapter and are not signed out.

## What gets routed

Every CLI run is routed separately: the concierge call, each lead turn, and each helper run (including retries and follow-ups). Harbor-run integrator and rollback agents use no CLI and are not routed. Requests carry a role (concierge and lead are `main`), a complexity (low, medium, high), a tier, stated needs, and optional extras: a retry flag, a CLI the user named, a CLI the lead pinned, the CLI that holds the session being resumed.

## Hard skips (a candidate is never considered)

A CLI or model is skipped, with the reason recorded, when:

1. it is not installed;
2. Harbor has no headless adapter for it (today: Gemini CLI);
3. it is disabled in settings;
4. it is signed out (an unknown sign-in state is still eligible, with a small penalty);
5. it already failed for this task (excluded after a non-rate-limit failure);
6. the task is pinned to another CLI (but see below: a pin that cannot be met falls back);
7. the allowed-models setting leaves it no model;
8. the model lacks a need the request marks as required (supported by the router; the orchestrator does not set required needs yet);
9. its allowance is exhausted or it was rate limited in the last 30 minutes (judged per model when the limit message names a model, so a capped Opus does not block Sonnet on the same account; a limit that names no model holds every model of the CLI out);
10. its usage is inside the subscription reserve (percent used at or above 100 minus the reserve).

If every candidate is skipped, the run fails with "No eligible CLI is available" followed by the router's per-skip explanation, including the time each transient skip clears (for example "available again around 2026-10-12 15:30 UTC"). A turn with images requires a model whose catalog strengths include vision.

## Scoring, in plain words

Each eligible CLI and model entry gets a score starting from 100. Points are added or subtracted for the terms below; the highest score wins. Every term is listed in the decision's `scored` breakdown. The exact numbers are in `ROUTING_WEIGHTS` and pinned by tests.

| Term | Meaning |
| --- | --- |
| Allowance (headroom) | Default policy: the room left in the tighter of the 5h and weekly windows (see "Headroom" below), from 0 points down to 55. With an explicit `reduceEffort` or `switch` policy this is the older curve instead: nothing below 10% used, then about 14 points at 50% used, 28 at 80%, 44 at 99%, halved for Harbor-only estimates and, under `reduceEffort`, capped at 20 so it cannot outweigh continuity. The term is still called `usage` in the breakdown. |
| Load | 5 points per agent already running on that CLI (any project), to spread parallel work. |
| Tier fit | The wanted tier comes from the role and complexity (high complexity wants strong, low wants cheap, otherwise standard, planners included; the concierge and lead ask for a tier directly). A more powerful model than needed costs 8 points per step; a weaker one costs 25 per step. |
| Needs | +4 for each stated need the model's catalog entry lists as a strength, -4 for each it does not, repeated needs counted once, the total capped at +/-12 so needs refine a choice but never beat a tier step. |
| Cost | The catalog entry's optional extra cost, to make a pricier model lose close calls. Zero by default. |
| Sign-in unverified | -15 when the CLI's sign-in state is unknown instead of confirmed. |
| Continuity | +28 (`switchGap`) for the CLI that holds the native session being resumed under the default policy: another CLI must have about that many points more headroom to take the session. +25 under an explicit `reduceEffort` or `switch` policy. Just below a settings preference (30), so a preference still wins. |
| Switch back | -12 for going straight back to the CLI a session left less than 30 minutes ago (default policy only), so a session does not ping-pong. An exhausted CLI is skipped, so a forced move is never blocked by it. |
| Requested by you | +60 for a CLI you named in the message ("use codex"). Stronger than anything but it never overrides a hard skip: if that CLI is unavailable another takes over and the reason says so. |
| Preference | +30 when a role preference (settings) names this CLI, and +30 more when it names this model. |
| Verified adapter | +2 when the adapter was verified against a real install (a tie-breaker in practice). |
| Low allowance, switch policy | -40 when the model's allowance level is low and the policy is "switch". |
| Avoid | -30 for a CLI marked to avoid: a retry after a failed run avoids the CLI that failed (not one model, which would only buy the pricier sibling). Larger than continuity, so a retry does not return to the CLI that failed just because its session lives there. |
| Weekly pacing | `pacing` in the breakdown: up to +35 for a CLI whose known weekly reset is near and whose week is underspent, up to -20 for one that has overspent the week (see "Weekly pacing" below). Replaces the old +6 "use it or lose it" bonus. |
| Recent failures | -8 per recent failure on that model, decaying with a 6-hour half-life, capped at 20. Supported by the router; not yet passed in by the orchestrator. |

Scores are compared to a tenth of a point. A tie is broken in this fixed order: smaller tier distance, lower load, a verified adapter, catalog order, CLI id, model name. The decision is flagged `tied` when the runner-up had the same score, and the reason says the tie-break decided. A model of a lower tier than wanted is flagged as degraded in the reason.

The catalog is editable data: `capabilities.json` in the data folder replaces the built-in list (invalid or duplicate entries are dropped with a warning). Built in: Claude `haiku` (cheap), `sonnet` (standard), `opus` and `claude-fable-5-1` (strong; the Fable id is unverified and it has its own usage limit), and Codex's default model (standard; named Codex models are unverified, so none are listed). Strengths in the catalog are editable defaults, not benchmarks. Routing code makes no claim that one provider is better at a category.

## Continuity before unnecessary switching

A run that resumes a native session gets the continuity bonus for that session's CLI, large enough that a modest allowance difference does not move work between CLIs (a large one does; see Headroom). When a different CLI is nevertheless chosen (a hard skip, a failure, a stronger signal), Harbor says so in the conversation and prepends a handoff it wrote itself: the lead's recorded decisions, unfinished work, verification evidence tied to the commit it covered, and what was already applied. A session is resumed only on the CLI that created it. Continuity never overrides a hard skip.

## Preferences and pins

- **Role preferences** (settings): a preferred CLI and optional model for planner, implementer, reviewer or other helpers. A bonus, not a bypass. They do not apply to the lead.
- **Named CLI**: "use codex for this" in a message adds a strong bonus for that request and its go-aheads.
- **Pin by the lead**: a helper pinned to a CLI by `HARBOR_DELEGATE` is routed to it; if it is unavailable, Harbor says so and routes normally rather than leaving the helper without a model.
- **Allowed models**: per CLI, restricts the catalog models the router may pick. It never invents a model the catalog does not have.
- **Subscription reserve** (0 to 50%): a model at or above 100 minus the reserve percent used is skipped.

## Effort

Effort is decided in one place, in this order of precedence:

1. A deliberate effort is untouched: the concierge always runs at low, and `/deep` runs at high.
2. A retry of work that was rejected (a reviewer asked for changes, or a Harbor check failed) while already on the strongest tier is high, whatever the policy or the allowance. A resumed session keeps the effort it started with (a change rewrites the prompt cache) unless the effort was chosen deliberately.
3. A low allowance steps the base effort down one notch (this wins over a policy that would raise it).
4. The effort policy shifts the base: **adaptive** (default) leaves it, **conserve** steps down one notch (never for retries), **quality** steps up one.

The base comes from role and complexity: a planner gets high for high complexity and medium otherwise; everything else gets its complexity, except high complexity, which gets medium because a stronger model already costs more. A retry of rejected work runs one complexity level higher, so a stronger model, and only when it is already on the top tier does its effort rise; a retry after an infrastructure failure keeps both.

Effort maps to each CLI's native control (`--effort` for Claude, `model_reasoning_effort` for Codex). Whether Codex honors every value on every model is not verified.

## Headroom (the default pacing)

Harbor paces itself across your subscriptions. For each model it reads both windows, the 5h one and the weekly one (and any model-scoped limit, such as Opus-only), turns each into the share still left, and lets the tighter one bind:

- A provider-reported window counts as read. A Harbor-only estimate counts its used share at half (it is a guess about someone else's quota).
- A reported window whose burn rate would overshoot 100% before its reset keeps only `100 / projected` of what is left, never less than half of it. A 5h window that resets within 30 minutes is not paced down: capacity right now is what the work needs, however the projection looks. A weekly window with plenty left and a distant reset is simply abundant.
- The tighter window costs points by what is left: nothing above 95%, 6 points at 60% left, 12 at 40%, 22 at 25%, 44 at 10%, 55 at 0%. The other window adds a quarter of its own points, so a healthy 5h window does not hide a nearly spent week.
- A session on a CLI keeps it unless another CLI is about 28 points better. In practice 55% against 45% left never moves anything, while 10% against 90% always does, even mid-session (the handoff note then carries the context). A move back to the CLI just left costs 12 more for 30 minutes. If a CLI is exhausted it is skipped and the other one takes the work, or the work waits per the usual exhausted-CLI rules.
- A CLI you named ("use codex") is not judged on headroom; only exhaustion stops it. A settings preference (30 points) still outweighs the stickiness, but a big gap can outweigh the preference: pacing is the point.
- Below 25% left on its tighter window, work that can spare it runs one tier cheaper on that CLI (Sonnet instead of Opus, Haiku instead of Sonnet), but never planners, retries, high-complexity work, a resumed session (which keeps its model, and so its prompt cache), or a cheaper model that lacks a stated need. The effort also steps down. The reason says so.
- The reason lists both windows of every CLI considered, for example "codex: 5h 10% used, weekly 10% used; claude: 5h 90% used (pace → ~150% at reset: runs out before it), weekly 80% used → codex", and each entry of `scored` carries the same numbers.

Every constant is in `ROUTING_WEIGHTS` (`headroomCurve`, `headroomSecondShare`, `switchGap`, `switchBack`, `paceFloor`, `lowHeadroomPct`) and pinned by `tests/pacing.test.ts`. They are tuned by reasoning, not by data from real accounts.

## Weekly pacing

Allowance not used by a weekly reset is lost, so Harbor measures each CLI against a straight-line budget for the week and spends the surplus before the reset, or conserves when a CLI is burning faster than the week allows. It only acts on a weekly window whose reset time Harbor actually knows: a provider-reported one (Claude's `rate_limit_event`, Codex's local logs), or an estimate against a calibrated budget (counted at half). With no known reset, or only an uncalibrated estimate, nothing changes. It applies under the default (headroom) policy only.

- **Pace.** `elapsed` = share of the 7 days already gone, from the reset time. `ideal used` = 100 x elapsed. `surplus` = ideal used - used (positive: underspent; that much of the week's allowance is lost if nothing changes). If several weekly windows apply (account-wide, Opus-only), the one with the least surplus binds.
- **Urgency** grows as the reset nears, by hours left: 0 at 96h or more, 0.25 at 48h, 0.9 at 12h, 1 at the reset (linear between).
- **Spend** (underspent): `+35 x min(1, surplus / 40) x urgency x trust x capacity`. So 40% or more about to be lost near the reset is worth about +35. `capacity` is the 5h window: 0 at 25% remaining or less, 1 at 50% or more, so a CLI with 5% left on its 5h window earns nothing however big its week (capacity now still binds, as do hard skips). The bonus is 0 for a model below the wanted tier, so it never buys a weaker model.
- **Conserve** (overspent, at least 10% of the week gone): `-20 x min(1, deficit / 40) x min(1, hours left / 72) x trust`: more time left to recover means stronger conservation.
- **Trust.** 1 for a reported reading at most 3h old, falling to 0.25 at 24h old (it never reaches 0); an estimate counts 0.5 on top.
- **Both CLIs.** Both underspent: the one whose reset is sooner has the higher urgency, so its allowance is spent first. Both overspent: the one with more left costs less. The spend bonus can outweigh session continuity (28) when the surplus is large; small surpluses cannot, and the usual switch-back cost (12 for 30 minutes) still prevents ping-pong. A CLI you named ("use codex") is not judged on pacing; pacing never overrides a hard skip or a required need.
- **Spend freely.** With a reported, fresh reading, a surplus of 30% or more, a reset within 36h and a 5h window with at least 50% left, standard and low work on that CLI goes one tier stronger (Haiku to Sonnet, Sonnet to Opus, where the catalog has them) and the effort goes one step up. The reason says so. Never for planners, retries, high work (already on the strongest tier), a resumed session on that CLI (its model stays, for its prompt cache), a fixed effort, an estimated window, or under the `conserve` effort policy. The stronger model must itself be in good standing (not exhausted, not over its own weekly pace).
- **Conserve down.** With a reported, fresh reading, a deficit of 20% or more, at least 24h to the reset and headroom not already low, flexible work (not planner, retry, high or resumed) goes one tier cheaper where a model that covers its needs exists, and the effort one step down. It complements the below-25% downshift.
- **Reason.** For example: "claude weekly: 40% used, 84% of the week elapsed, resets in 27h → ~44% of the week's allowance would be lost: spending it (+22)". Each entry in `scored` carries the same number as `terms.pacing`.

Constants: `spendCap`, `spendFullSurplusPct`, `urgencyKnots`, `spendCapacityFullPct`, `conserveCap`, `conserveFullDeficitPct`, `conserveFullHours`, `paceMinElapsed`, `staleAfterMs`, `staleFullMs`, `staleFloor`, `spendUpMinSurplusPct`, `spendUpWithinMs` (36h), `spendUpLowWork`, `spendUpMinCapacityPct`, `conserveDownMinDeficitPct`, `conserveDownMinMs`, all in `ROUTING_WEIGHTS` and pinned by `tests/weeklyPacing.test.ts`. They are reasoned, not measured (see [Known limitations](limitations.md)).

## Automatic complexity

`src/main/complexity.ts` estimates complexity from the request: hard-work words (refactor, rewrite, migrate, architecture, root cause, race condition, security, "across the codebase") score points, as do long specs, many file paths, a large project and plan or goal mode; typos, renames, "explain ..." and status asks are low; the rest is medium. When a message skips the front desk (plainly work) the estimate is the complexity. When the front desk answered, the estimate can only raise its rating to high, never lower it. The signals appear in the routing reason. It is wording heuristics, not an understanding of the code.

## Low-allowance policies

Allowance "low" means 80% or more of a window is used (or a high pace on a provider-reported window; see [Usage and resets](usage-and-resets.md)).

- **not set** (default): headroom routing, described below. Work moves to the CLI with clearly more room; otherwise it behaves like the CLI the conversation is already on.
- **reduceEffort** (explicit): stay on the CLI and spend less. Usage cannot outweigh continuity under this policy.
- **switch**: steer away. A low model takes an extra 40-point penalty, so a healthy option of similar fit wins; if none exists the effort still steps down and the reason says so.

Deferring the work or asking you first are not built.

## Fallback and retries

If a run fails, Harbor does not give up on the task:

- A known transient failure (Claude's sign-in refresh race, a connection error) is retried on the same CLI after a short wait, a couple of times.
- Otherwise the CLI is excluded for this task and the next best is routed, with "Falling back to ..." in the conversation. A rate limit is held against that model for 30 minutes (the whole CLI when the message names no model), so another model of the same CLI can be tried before another CLI. A resumed session keeps its model: it never moves to a cheaper one, and moves up a tier only when the work wants it. Planner, implementer and reviewer helpers are not started on a CLI at low allowance while another CLI is healthy.
- A run that reports a signed-out CLI marks it signed out until the next refresh.
- Up to three attempts per installed CLI are made before the run fails.

The fallback does not yet tell the new CLI that an edit run had already started; it relies on the worktree and checkpoint commit (a note for this is in progress).

## Work queue and capacity

Helpers are scheduled per project: higher priority first, then oldest, subject to dependencies, plan mode, file ownership and the project's concurrency limit (default 4, 1 to 8). A dependency's failure fails its dependents; a failed dependency stopped by a restart makes them wait. Pause, resume and priority exist in the API and only affect queued work (a running helper is not interrupted).

Not built: an application-wide queue across projects, a configurable reserve of capacity or allowance for your interactive messages, and checkpointing background work to make room for a message. The "why is it waiting" reason is shown on a queued helper (dependency, file, slot, plan mode).

## Settings

| Setting | Status |
| --- | --- |
| Enable or disable each CLI | Built; in the UI. |
| Allowed models (per CLI) | Engine and API; UI in progress. |
| Role preferences | Engine and API; UI in progress. |
| Effort policy (adaptive, conserve, quality) | Engine and API; UI in progress. |
| Low-allowance policy (reduceEffort, switch) | Engine and API; UI in progress. |
| Subscription reserve (0 to 50%) | Engine and API; UI in progress. |
| Concurrency limit (1 to 8 per project) | Engine and API; UI in progress. |
| Helpers and planners per lead turn (1 to 12 and 1 to 4; defaults 4 and 1; global only) | Engine and API; no UI yet. Helpers beyond it are held back and announced; the lead is asked to confirm them. |
| Per-project overrides of the six settings above | Engine and API; UI in progress. A project value wins per field, per CLI (allowed models) and per role (preferences). |
| Free-reset prompts (ask or never) | Built; in the UI. |
| Notifications; keep running in the tray | Built; in the UI. |
| `routing: auto or manual` | Stored; the manual value has no effect on routing in the code I read. |
| Auto-update on or off | Read by the main process as `autoUpdate`, not in the typed settings or the UI; `HARBOR_NO_UPDATE=1` works. |
| Unknown-usage policy, active-helper limit separate from concurrency, retry limits, context-transfer rules | Not built. |
| API fallback and spending limits | Not built. See below. |

Scope precedence today is project over global. Conversation-level and task-level overrides are not built.

## API fallback

Not built. Everything runs on the CLIs. The intent stands: prefer CLIs, never spend money silently, ask first, and treat any limit as a hard stop.

## Adapters

An adapter implements `CliAdapter`: it takes the prompt on stdin, emits chunks (session id, text, tool activity, usage, reported limits) and always ends with exactly one `done` chunk. Claude's adapter maps modes to `--permission-mode`, an allowlist and deny rules, an optional control channel for tool prompts, `--effort`, `--model`, `--resume`, and disables `Task` and `Agent`. Codex's maps modes to a sandbox (`read-only`, `workspace-write`, `danger-full-access`), passes effort as a config value, and prepends the system prompt to the stdin prompt. Gemini is detected only. Add a CLI by implementing an adapter and a registry definition; verify its flags with `<cli> --help` first and record unverified ones in the file header.

## Superseded from the earlier design

- Superseded: a routing sequence in which the main agent delegates interpretation to a planner, a planner estimates work and uncertainty, and a coordinator dispatches approved assignments. There is no estimation step; routing is a per-run function of role, complexity, needs and live state.
- Superseded: "the main agent performs no substantive task work". The lead does the work itself and is routed like any run.
- Superseded: sibling communication that scheduling takes into account. Helpers do not communicate. See [Agent collaboration](agent-collaboration.md).
- Not built: native skills and plugins as a routing input, extension-driven routing, interactive headroom, application-wide scheduling, unknown-usage policy, API fallback, per-task overrides.

## Design acceptance criteria (status)

- A user can complete ordinary work without choosing a CLI. Met.
- Routing uses allowance information when available and labels estimates and unknowns. Met in the engine; the Usage tab labels each window's source.
- Users can see why a provider was chosen. Met (Session information shows the stored reason). Overriding it per conversation is not built (a message can name a CLI).
- A project keeps its own conversations and sessions; one task can involve several CLIs without splitting the conversation. Met.
- Effort responds to task needs and to policy. Met.
- Routing preserves useful session continuity and records the reason for a handoff. Met.
- API fallback follows a permission and spending policy. Not applicable yet.
- Queue control across projects and reserved interactive capacity. Not met.
