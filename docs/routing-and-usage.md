# Routing and usage

Code: `router.ts` (pure scoring), `clis/capabilities.ts` (catalog as data), `usage.ts`, `codexLimits.ts`, `orchestrator.ts` (fallback). Constants are in `ROUTING_WEIGHTS`, pinned by tests, and reasoned rather than measured ([limitations](limitations.md)). The code wins over this page.

## What is routed

Every CLI run separately: the concierge, each lead turn, each helper run and retry. A request has a role, complexity (low/medium/high), tier (cheap/standard/strong), needs, and optional extras (retry, a CLI you named or the lead pinned, the CLI holding the session). The decision and reason are stored on the message and shown in Session information.

## Hard skips

Not installed, no adapter (Gemini), disabled, signed out, already failed for this task, pinned elsewhere (an unmeetable pin falls back), excluded by allowed-models, missing a required need or vision, exhausted or rate-limited in the last 30 minutes (per model when named), or inside the subscription reserve. If nothing is left the run fails with the reasons and when they clear.

## Scoring

Start at 100, highest wins (ties: tier distance, load, verified adapter, catalog order). Every term is in `scored`.

| Term | Effect |
| --- | --- |
| Headroom | up to -55 by room left in the tighter of the 5h and weekly windows |
| Load | -5 per agent running on that CLI |
| Tier fit | -8 per tier too strong, -25 per tier too weak |
| Needs | +/-4 each, capped at +/-12 |
| Continuity | +28 for the CLI holding the session; -12 for going straight back within 30 minutes |
| You named a CLI | +60 (never beats a hard skip) |
| Role preference | +30 CLI, +30 more for model |
| Retry | -30 on the CLI that failed |
| Unknown sign-in | -15 |
| Weekly pacing | +35 to -20 |

The catalog is editable (`capabilities.json` in the data folder). Built in: Claude `haiku`, `sonnet`, `opus`, `claude-fable-5-1` (unverified id), and Codex's default model. A session only resumes on the CLI that created it; otherwise Harbor says so and prepends a handoff.

## Settings

Global with per-project overrides: enabled CLIs, allowed models, role preferences (not the lead), effort policy (adaptive, conserve, quality), low-allowance policy (`reduceEffort`, `switch`), subscription reserve (0 to 50%), concurrency (1 to 8, default 4), editor, free-reset prompts. Not built: conversation or task overrides, API fallback.

## Effort

A deliberate effort wins (concierge low, `/deep` high). Retrying rejected work on the top tier is high. A low allowance steps down one notch; the policy shifts the base. The base comes from role and complexity; a retry of rejected work goes one complexity level up. Sent as `--effort` (Claude) or `model_reasoning_effort` (Codex).

## Headroom and pacing

- The tighter of the 5h and weekly windows binds; the other adds a quarter of its points. Reported windows count in full, Harbor-only estimates at half.
- Points by share left: 0 above 95%, 6 at 60%, 12 at 40%, 22 at 25%, 44 at 10%, 55 at 0.
- A session stays on its CLI unless another has about 28 points more room: 55% vs 45% never moves it, 10% vs 90% always does.
- Under 25% left, flexible work runs a tier cheaper at lower effort (not planners, retries, high complexity, resumed sessions).
- **Weekly pacing** treats the week as a straight line to a known reset: underspent near the reset earns up to +35 (and, with a fresh reading, 30%+ surplus and under 36h left, a tier stronger); overspent costs up to -20 (and a tier cheaper). It needs a known reset time and ignores a CLI you named.

## Complexity

`complexity.ts` scores wording (refactor, migrate, root cause, long specs, many paths, plan/goal mode); renames and explanations are low. For messages skipping the concierge it is the rating; otherwise it can only raise it to high.

## Fallback

Transient failures retry on the same CLI; an overload retries once. Otherwise the CLI is excluded for the task and the next best is used ("Falling back to ..."), up to three attempts per CLI. A resumed session never moves to a cheaper model. Signed-out marks the CLI signed out until refresh.

## Usage

Each CLI run records one event (CLI, model, project, duration, success, tokens and cost when reported). Three kinds of reading:

| Reading | Source | Use |
| --- | --- | --- |
| Reported | Claude's `rate_limit_event` during Harbor runs; Codex's newest session log in `~/.codex/sessions` | Preferred; dropped once past its reset |
| Estimated | Harbor's own run count against a budget (calibrated from two readings, else a flagged fallback) | Only without a reported window; labeled "estimated from Harbor runs only"; half weight |
| Unknown | Nothing (Gemini) | No window; never treated as unlimited |

Windows become a level (plenty < 50% used, limited 50%, low 80%, exhausted 100%). On reported windows a projection of 100%+ at reset raises the level, under 70% lowers "limited". Windows are never summed and providers' percentages are never compared. Not built: a cross-project queue, reserved capacity for your messages, waiting for a reset.

Free resets are dormant: no provider exposes one. If one ever does, it is only proposed as a permission request.

## Adding a CLI

Implement `CliAdapter` (prompt on stdin, `Chunk` stream, one final `done`) and a `CliDefinition` in `clis/registry.ts`. Check flags with `<cli> --help` and record unverified ones in the file header.
