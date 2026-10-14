# Routing and usage

Code: `router.ts` and `routePrice.ts` (pure scoring and pricing), `difficulty.ts`, `budget.ts` (pool states), `budgetCost.ts` and `budgetPriors.ts` (cost estimates), `calibration.ts`, `helperLimit.ts`, `clis/capabilities.ts` (the catalog, as data), `usage.ts` and `codexLimits.ts` (readings), and `orchestrator.ts` (fallback). Weights live in `ROUTING_WEIGHTS` and are pinned by tests. **Every budget constant is a starting value tuned in a week simulator (`tests/sim`, `scripts/simulate-week.ts`), not a provider fact.** Where this page and the code disagree, the code is right.

## What is routed

Every CLI run is routed on its own: the concierge, each lead turn, each helper run and each retry. Each decision stores its technical reason (`Message.details.reason`) and a plain summary (`details.summary`) on the message. The stored details include the difficulty, the best candidates with their effort and estimated price, what was skipped and why, and whether a review is advised.

## Difficulty and the capability floor

`difficulty.ts` rates each piece of work from 0 to 10 using named signals: how many files it claims, the length of the instructions, risk words, whether a deliverable is named, whether verification is required, and whether it follows a planner's spec. The lead's own rating is only a starting hint. Reviewers and read-only helpers are capped at 5. The difficulty sets a **capability floor**, and each catalog model, at each effort, either clears it or does not.

## Choosing model and effort

1. **Hard skips.** A CLI or model is dropped when it is: not installed; without a headless adapter (Gemini); disabled; signed out; already failed for this task; not allowed by the settings; a legacy or non-auto-routed model you did not name; missing a required need (for example vision for images); exhausted or rate-limited; inside the subscription reserve; or short of quota above the reserve for this run. A custom CLI with no read-only mode is skipped for read-only work unless you allowed it. If nothing is left, the run fails with every reason and when each one clears.
2. **The floor.** Models that cannot clear the floor at any effort are dropped while something else clears it. If nothing clears it, Harbor takes the strongest model available, marks the choice degraded, and asks for a review. A helper whose capable models are only short of quota for now waits rather than being degraded.
3. **Price.** Each option (model plus effort) gets an estimated price, in scarcity-weighted percent of a weekly quota window. The price combines expected tokens, the model's cost per k-token, the state of its pools, the risk of failure, and the cost of an automatic review if the margin is thin. Quota that will expire unused at a known reset is cheap ("use it or lose it"). Each doubling over the cheapest option costs 10 points, capped at 55.
4. **Other terms.** Session continuity +28 (another CLI must be about 7x cheaper to move a session), going straight back to a CLI within 30 minutes -12, a CLI you named in the message +60, a role preference from settings +30 for the CLI and +30 more for the model, load -5 per running agent, needs +/-4 each (capped at +/-12), unknown sign-in -15, avoid on retry -30, recent failures up to -20. A resumed session keeps its model while that model can still do the work. A redo of rejected work never moves to a cheaper model.
5. **Effort** is the one the price picked. The `conserve` and `quality` policies step it down or up, but a step down is taken only if the work still clears the floor. Retries are never lowered. Claude receives the effort as `--effort`, Codex as `model_reasoning_effort`. Codex's `xhigh`, `max` and `ultra` are never sent.

The concierge is capped at the cheap tier while a cheap model can do its work. `/deep` forces a strong lead.

## Quota pools

Pools are `claude:all`, `claude:opus`, `claude:fable` and `codex:all`. A model draws from its CLI's account pool and, where the provider caps it separately, from its own pool too. For each pool's 5-hour and weekly window, `budget.ts` derives what is left, the burn rate, and a reserve held back for your interactive work: 15% weekly and 10% for the 5-hour window. The reserve shrinks before a reset and when a deadline is near. From these comes a pool state:

| State | Meaning (projected at the current burn) |
| --- | --- |
| spend | the window resets with quota unspent |
| neutral | about on pace |
| conserve | runs short before the reset |
| protect | runs dry well before the reset; at most one helper |

Helpers never use the reserve, but the lead and the concierge may (you are waiting on them). A per-conversation **deadline** (`setConversationDeadline`) adds urgency, which releases reserve and puts a price on time.

## Settings

Settings are global, with per-project overrides: enabled CLIs, CLI paths, allowed models, role preferences, effort policy (adaptive, conserve, quality), low-allowance policy (unset = price routing; `reduceEffort`; `switch`), subscription reserve (0 to 50%), concurrency (1 to 8, default 4), helpers per turn (default 4), planners per turn (default 1), editor, and free-reset prompts. The catalog can be edited through `capabilities.json` in the data folder. Not built: overrides per conversation or per task, and an API fallback. `routing: manual` has no effect.

## Usage readings

Each CLI run records one usage event: CLI, model, project, duration, success, and tokens and cost when the CLI reports them. Windows come from three kinds of reading:

| Reading | Source | Use |
| --- | --- | --- |
| **Reported** | Claude's `rate_limit_event` seen during Harbor runs; Codex's newest session log in `~/.codex/sessions` | Preferred. Dropped once past its reset. Claude's is only as fresh as Harbor's last Claude run. |
| **Estimated** | Harbor's own runs, measured against a budget learned from provider readings, or else a flagged fallback (200 runs per 5h, 120 per week, measured once on one account) | Used only when there is no reported window. Labelled "estimated"; `calibrated: false` means it is the fallback. Half weight. |
| **Unknown** | nothing (Gemini, custom CLIs without readings) | No window, and never treated as unlimited |

Each window becomes a level: plenty below 50% used, limited from 50%, low from 80%, exhausted at 100%. Windows are never summed, and providers' percentages are never compared with each other. Harbor cannot see use outside Harbor. **Estimates are not your provider quota, and the UI must label them as estimates.**

## Free resets

There are none. `FreeResetCoordinator` (`usage.ts`) could propose a reset through a `permission` prompt, but only for a window whose `freeResetAvailable` is set. That flag needs an entitlement source, and no source exists, so it is never set. A reset is never used without an explicit yes.

## Fallback

Transient failures retry on the same CLI, and an overload retries once. Otherwise the CLI is excluded for the task and the next best one is used ("Falling back to ..."). A run that already started editing passes a partial-work note to the next CLI. Signing out marks the CLI signed out until you refresh.

## Adding a CLI

There are two ways. Without code: describe it in Settings as a custom CLI (`CustomCliDescriptor`), run a dry run, and approve the executable. With code: implement `CliAdapter` (prompt on stdin, a `Chunk` stream, one final `done`) and add a `CliDefinition` in `clis/registry.ts`. Check its flags with `<cli> --help` and record the unverified ones in the file header.
