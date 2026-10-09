Note: no codexLimits.ts exists in this worktree. Let me read the core files.

Now shared API, specs, and the uncommitted/untracked check.

# How Harbor picks a CLI, model and effort

This was read-only. I changed no files and made no commit, because the assignment said not to edit anything. I ran no tests or real CLIs.

Line numbers refer to this worktree at `eb2ec2a`.

## 0. Summary

- Routing runs inside `Orchestrator.runRouted` (`orchestrator.ts:533`). It runs once per CLI attempt, for every agent including the main agent.
- The router (`router.ts:53`) is a pure function. It first applies hard exclusions and then ranks the remaining CLIs by a score built only from state. It then derives the model and effort from the task, not from the CLI.
- The main agent's plan never names a provider or model. It carries only `role` and `complexity`. `PlannedTask` has no CLI or model field (`prompts.ts:7-19`), and the parser would drop any extra field.
- Model choice exists only for Claude: `opus`, `sonnet` or `haiku`. Codex always runs with `'default'`, so Harbor passes no `-m` flag and Codex uses its own configured default.

## 1. The scorer (`src/main/router.ts`)

### Inputs
`RouteRequest` (`router.ts:8-17`) has `role`, `complexity`, `continuity?`, `exclude?` and `requireCli?`. `RouterInput` (`:21-31`) has `clis`, `ledger`, and the callbacks `enabled`, `hasAdapter`, `load` and `verified?`.

### Hard exclusions
These run per CLI in this fixed order (`:58-65`). The first one that matches wins, adds a note, and skips the CLI entirely. An excluded CLI has no score.

| # | Rule | Source of the value |
|---|---|---|
| 1 | `!c.installed` → "not installed" | `discovery.ts` |
| 2 | `!hasAdapter` → "no headless adapter yet" | `service.ts:52-57`: only `claude` and `codex` have adapters, and only if installed with a path. Gemini never gets work. |
| 3 | `!enabled` → "disabled in settings" | `service.ts:80`: `cliOverrides[c]?.enabled !== false`, so the default is enabled. |
| 4 | `authState === 'signedOut'` → "login required" | Discovery. |
| 5 | `exclude.includes(id)` → "failed earlier for this task" | Built up by `runRouted` after each failed attempt. |
| 6 | `requireCli` set and different → "task needs X" | Only the router reads `requireCli`. Nothing in `src/` sets it. |
| 7 | `ledger.level === 'exhausted'` → "allowance exhausted or rate limited" | Usage ledger. |

`LEVEL_PENALTY.exhausted = 1000` (`:33`) is never reached, because exhausted CLIs are skipped at step 7. It is dead code.

### Soft score (`:66-70`)
```
score = 100 − LEVEL_PENALTY[level] − 5 × load(cli)
        − 15 if authState === 'unknown'
        + 25 if req.continuity === cli
        + 2  if verified(cli)            // only claude (service.ts:42)
```
Usage penalties are `plenty` 0, `limited` 10 and `low` 30.

- **Load:** `load` is the number of other agents currently in `this.running` whose `AgentRecord.cli` is that CLI (`orchestrator.ts:546`). The main agent is never in `running`, so it does not count toward load.
- **Unknown sign-in:** `unknown` is usable but costs 15.
- **Broken installs stay eligible:** `resolveCli` returns `installed: true, authState: 'unknown'` when the executable is found but `--version` fails (`discovery.ts:42`). The router only tests `installed`. A CLI that cannot run therefore stays eligible at a −15 penalty, and the fallback loop absorbs the failure.

### Ties
Candidates are sorted by `b.score − a.score` (`:73`) and `cands[0]` wins. `Array.sort` is stable, so equal scores keep input order, which is `CLI_DEFINITIONS` order: claude, codex, gemini. The only explicit tie-breaker is the +2 for `verified`, which a single running agent (−5) outweighs.

### Result (`:77-83`)
Effort starts from `baseEffort(role, complexity)` (`:44-48`):

| Role | Base effort |
|---|---|
| main | `low` |
| planner | `medium` if complexity is `low`, otherwise `high` |
| implementer, reviewer, other | equal to complexity |

If the winner's level is `low` (not `limited`) and effort is not already `low`, effort steps down one notch (`high` becomes `medium`, anything else becomes `low`) and the reason says so.

Model comes from `pickModel` (`:36-42`):
- **Claude:** `opus` if the role is planner or complexity is `high`; otherwise `haiku` for `low` and `sonnet` for `medium`.
- **Any other CLI:** `'default'`.

Because of this, the main agent (role `main`, complexity `low`) gets `haiku` on Claude.

## 2. `Message.details.reason`

- **Type:** `Message.details?: { cli; model; effort; reason }` (`shared/api.ts:9`).
- **Reason text:** `router.ts:78-83` joins these parts with ` · `:
  1. `<cli>: signed in | sign-in unverified, usage <level> (~<pct>% est.)`
  2. `continues existing session`, if the continuity bonus applied to the winner
  3. `effort lowered: allowance low`, if the step-down applied
  4. `<role>/<complexity> → effort <effort>`
  5. All skip notes joined by `; `, if any

  Only CLIs that were skipped appear in the notes. Losing candidates that were scored do not. Their scores and the winner's score are not recorded either.
- **Where it is stored:**
  - **Subagents:** `runRouted` builds `details` from the decision (`orchestrator.ts:558`). It is attached to the first streamed assistant message and to each new message that starts after a tool call (`:568`).
  - **Main agent:** the caller builds `details` (`:203`) and attaches it only to the assistant reply (`:206`). If the reply is empty, no message carries the decision.
  - **After a JSON retry:** the main turn takes `out` (and its decision) from the retry only if the retry succeeded (`:201`).
- **Agent record:** `cli`, `model` and `effort` are written to the agent record via `setState(...)` at `:553`. The `reason` string is not stored on the agent, only on messages.
- **Fallback notice:** the "Falling back to X: …" message (`:554`) is a plain system message with no `details`.

## 3. Where routing is called, and the plan format

### Call chain
`service.send` → `orchestrator.userMessage` (`:139`). That posts the user message, resets `autoTurns`, and calls `enqueueMain`. `mainTurn` (`:181`) then runs the main agent through `runRouted` with `role: 'main'`, `complexity: 'low'`, `resume: false` and `permission: 'read-only'` (`:192`). The calls are serialized per project through the `mainChain` promise.

### Plan format
The format is defined in `MAIN_SYSTEM` (`prompts.ts:42-43`):
```json
{"reply":"…","tasks":[{"ref":"t1","title":"…","role":"planner|implementer|reviewer|other",
 "instructions":"…","complexity":"low|medium|high","dependsOn":["…"],"files":["…"],
 "specFrom":"…","helpFor":"…"}]}
```
`parseMainOutput` (`prompts.ts:135-157`) is lenient:
- It extracts the first balanced JSON object, handling code fences and chatter (`extractJson`, `:112`).
- It drops tasks with empty `instructions`.
- It caps the plan at 8 tasks (`MAX_TASKS_PER_PLAN`, `:23`).
- An unknown `role` becomes `other` (`:145`). An unknown or missing `complexity` becomes `medium` (`:151`).
- Any extra keys, such as a `cli`, `model` or `provider` hint, are ignored.
- If the output is not valid JSON, the orchestrator re-asks once with the instruction "reply with ONE JSON object only" (`orchestrator.ts:198-202`).

### From plan to concrete CLI and model
- **`createTasks` (`:221-258`):** each task becomes an `AgentRecord` with `cli: 'auto'`, `model: 'auto'` and `effort: t.complexity`. It also stores `complexity` and `state: 'queued'`.
  - A plain implementer task with no `specFrom` gets its own `instructions` as the spec (the fast path, `:250`).
  - The dependency graph has cycles broken by `breakCycles`.
- **`pump` (`:272`):** starts queued agents once their dependencies are done. A failed or stopped dependency fails the dependent immediately. The concurrency cap is `maxActivePerProject ?? 3`. Edit roles must also acquire file locks (`claim`, `:297`).
- **`runAgent` → `execute` (`:333`, `:379`):** passes `role` and `complexity: a.complexity ?? 'medium'` into `runRouted`. The route happens there.
- **Concrete resolution:** `route(...)` returns the CLI. `pickModel` returns the model, and `baseEffort` plus `stepDown` return the effort. The adapter then receives `{ model, effort, resumeId, permission, systemPrompt }` (`:561`).

Complexity therefore influences only the Claude model tier and the effort, never which CLI.

### Role effects on execution
- **Edit roles:** `implementer` and `other` get their own git worktree and `permission: 'edit'`.
- **Read-only roles:** the others get `read-only`, and reviewers run in the reviewed worktree.
- These affect where the agent runs, not which CLI is chosen.

## 4. The main agent and continuity

### Choosing the main agent's CLI
There is no separate "main agent chooser". `ensureProject` (`:105-118`) creates one `role: 'main'` record per project with `cli: 'auto'`. Every main turn goes through the same `route()` with `role: 'main'`. Whichever eligible CLI wins is recorded on that record.

### Continuity
- **Sessions:** each agent has at most one `SessionLink {agentId, cli, sessionId}` (`store.ts:122-123`). The latest `session` chunk from any adapter overwrites it (`orchestrator.ts:562`). Claude's session id comes from the `system/init` event and the `result` event. Codex's comes from `thread.started`.
- **Routing:** `runRouted` passes `continuity: link?.cli` (`:544`), which gives +25 to that CLI.
- **Resuming:** `resumeId` is set only if `o.resume` is true and `link.cli === decision.cli` (`:551`). `resume: true` is used only by `followUp` (`:495`), which handles direct user messages and sibling-help hand-backs. First runs and the main agent never resume.
- **Switch:** if the winner is a different CLI, the old session is not used. The orchestrator adds a note, "continuing on X without the previous Y session" (`:552`), which feeds the next main prompt. Nothing is checkpointed or handed over as context, so the new CLI starts fresh.
- **Main agent quirk:** the main agent records sessions and gets the +25 stickiness on later turns, but `resume` is hard-coded to `false` (`:192`, `:200`). Its state comes from the assignment register in the prompt, not a native session. The bonus therefore only keeps it on the same CLI without resuming any context.
- **Overridable:** continuity is soft. A usage penalty or load can outweigh +25. For example, a continuing CLI at `low` usage scores 100−30+25 = 95, while a fresh CLI scores 100, so the switch happens.

## 5. Model selection inside a CLI

- **Registry** (`clis/registry.ts`): `models` is `['sonnet','opus','haiku']` for Claude (`:61`) and `['default']` for Codex (`:76`) and Gemini (`:83-84`). This list is only informational. It is shown through `CliStatus.models`. The router does not read it. `pickModel` is hard-coded, and no "allowed models" setting exists.
- **Claude adapter** (`adapters/claude.ts:15-30`):
  - Args are `-p --output-format stream-json --verbose`.
  - `--model <m>` is added unless `m === 'default'`, and `--effort <low|medium|high>` is always added.
  - `--resume <id>` is added when resuming.
  - Edit mode uses `--permission-mode acceptEdits` with an allowlist of Bash `git`, `npm`, `npx` and `node` commands. Read-only mode uses `--permission-mode plan`.
  - `--disallowedTools Task Agent` blocks native subagents.
  - The role contract goes in through `--append-system-prompt-file`, and the prompt goes in through stdin.
- **Codex adapter** (`adapters/codex.ts:11-18`):
  - Args are `exec [resume <id>] --json --skip-git-repo-check -c sandbox_mode="workspace-write"|"read-only"`.
  - `-m <model>` is added only if the model is not `default`, which never happens today.
  - `-c model_reasoning_effort=<effort>` is always added, and the prompt goes through stdin via `-`.
  - There is no system-prompt flag, so the role contract is prepended to the prompt (`:34`).
- **Gemini:** no adapter. It is detected only.
- **Not verified:** whether Claude's Haiku accepts `--effort low` for the main agent, and whether Codex accepts `model_reasoning_effort` values for its default model.

## 6. Usage, exhaustion, and sign-in

### Usage ledger (`usage.ts`)
- **Counting:** `ledger.record` (called at `orchestrator.ts:582` after every attempt, success or not, for all agents including main) stores a `UsageEvent` with the `rateLimited` flag.
- **Estimate:** `usedPct` is the count of events in a sliding 5-hour window (`WINDOW_MS`) divided by an assumed budget of `DEFAULT_RUNS_PER_WINDOW = 40`, capped at 100. The budget can be overridden only through `ServiceOptions.ledger`, which is a test hook, not a user setting.
- **Levels:** `level()` is `exhausted` at ≥100, `low` at ≥80, `limited` at ≥50, and `plenty` otherwise.
- **Rate limits:** any run that reports a rate limit triggers a 30-minute cooldown (`COOLDOWN_MS`), during which `usedPct` is forced to 100, so the CLI is `exhausted`.
- **Detection:** `RATE_LIMIT_RE` (`adapters/types.ts:31`) matches `rate limit`, `usage limit`, `quota`, `429`, `overloaded` and similar. Claude checks the `result` text, and Codex checks the error message or stderr.
- **What it measures:** only runs Harbor itself made. The window label says "estimated from Harbor runs only" (`windows()`).
- **Free reset:** `FreeResetCoordinator.maybePropose` is called only after a rate-limited run (`orchestrator.ts:584`). It asks the user through a `permission` event. It needs an entitlement callback, but `service.ts` does not pass one, so `freeResetAvailable` is never true. No reset is ever offered in production.

### `src/main/codexLimits.ts`
This file does not exist. It is not tracked in this worktree and not in any branch history (`git log --all -- '*codexLimits*'` returned nothing). Nothing in `src/` references it. I could not tell whether it exists as an untracked file in the main checkout (`C:/Users/andrei/Documents/RoutingManager`). I made no attempt to read other directories, because the assignment says not to touch them. `BACKLOG.md` item 10 ("Real allowance signals") says reading real Claude and Codex limits is not done. So today Codex limits do not feed routing.

### Sign-in state (`clis/discovery.ts`)
- **Claude:** `claude auth status --json` → `loggedIn` boolean gives `signedIn` or `signedOut`, and anything else gives `unknown` (`registry.ts:52-59`).
- **Codex:** `codex login status`. Text matching "not logged in", "logged out" or "not signed in" gives `signedOut`. Exit code 0 plus "logged in" or "signed in" gives `signedIn`. Otherwise `unknown` (`:67-73`).
- **Gemini:** there is no status check, so it is always `unknown`.
- **Not found or failed to run:** not installed gives `unknown` with `installed: false`. A failing `--version` gives `installed: true, unknown`.
- **Routing effect:** `signedOut` is a hard exclusion, and `unknown` costs 15 points.
- **Refresh timing:** discovery runs at service start and on `refreshClis` only. There is no re-check on a login failure mid-run.

### Fallback and re-routing (`runRouted`, `:533-595`)
- **Attempt count:** `maxAttempts = getClis().length` (`:540`).
- **Failure handling:** on a failed attempt that was not a user stop, it sets `lastError`, adds the CLI to `exclude` (`:590-591`), and loops. Each attempt re-reads load and usage, which now includes the failed run.
- **User notice:** from the second attempt it posts "Falling back to X: <error>" (`:554`).
- **Exhaustion:** when no CLI is left, the run fails. The first attempt's message is "No eligible CLI is available. Open Settings to install or sign in to a supported CLI." Later attempts add "(no remaining CLI to fall back to)".
- **Main agent:** the failure becomes "The main agent could not run: …" (`:194`).
- **Subagents:** the failure goes through `afterRun` and sets the agent to `failed`, which triggers a main-agent turn (`maybeReportToMain`, `:446`).
- **Exclude scope:** the exclusion lasts for that run only. A fresh run starts with an empty list.
- **Rate limit:** a rate-limited failure also puts the CLI into the 30-minute cooldown for every later routing decision.
- **Stop:** a user stop returns without trying another CLI, but the ledger still records the run.

### User overrides in the store (`store.ts:7`, `:147`)
`Settings = { routing: 'auto'|'manual', cliOverrides: Record<CliId,{enabled}>, allowFreeReset: 'ask'|'never' }`.
- Only `cliOverrides[cli].enabled` affects routing.
- `routing: 'manual'` is stored and shown in the UI, but nothing in `src/main` reads it. The UI text says per-conversation tool selection is not available yet.
- There are no per-project overrides, no model allow-list, and no effort policy.

## 7. Worked example

**Setup:**
- Claude: signed in and verified. Its ledger holds 24 runs in the window, so 60% and level `limited`.
- Codex: signed in, 0 runs, `plenty`, and one other agent currently running on it.
- Gemini: installed but with no adapter.
- A medium-complexity implementer task has no session yet.

**Per CLI** (in registry order):
1. **Claude:**
   - It passes the exclusions.
   - Score = 100 − 10 (limited) − 0 (load) + 2 (verified) = **92**.
2. **Codex:**
   - It passes the exclusions.
   - Score = 100 − 0 − 5×1 (load) = **95**.
3. **Gemini:** skipped at rule 2, "no headless adapter yet".

**Result:** Codex wins, 95 against 92.
- Model is `'default'`.
- Effort is `medium`, with no step-down because the level is `plenty`.

**Stored reason:**
`codex: signed in, usage plenty (~0% est.) · implementer/medium → effort medium · gemini skipped: no headless adapter yet`

**If the user then messages that agent directly (a follow-up with `resume: true`):**
1. The session link now says `codex`.
2. Codex scores 95 + 25 = 120, so it wins again.
3. `resumeId` is passed, giving `codex exec resume <id> …`.
4. The reason adds "continues existing session".

**If Codex rate-limits during a later run:**
1. A 30-minute cooldown starts for Codex.
2. The orchestrator posts "Falling back to claude: codex failed (rate limit): …".
3. Claude runs with `sonnet` and effort `medium`, and the previous Codex session is not used.

## 8. Spec versus code (`docs/background-routing.md`, `connections-and-extensions.md`, `interface-design.md`)

| Spec | Code |
|---|---|
| Decision inputs include user preferences, project overrides and extension-owning CLI (`background-routing.md:25-37`) | Only the global enable flag is used. `requireCli` exists in the router but nothing sets it. There is no skills or plugin signal. |
| Allowance from real provider readings, with form, window and freshness | Harbor-run counts only, with a fixed 40-run budget. No Claude or Codex limit reading, so real allowance signals are not used. |
| Continuity weighs the cost of switching, and switches are recorded and checkpointed first (`:41-45`) | A flat +25. There is no checkpoint or context transfer on a switch, only a note to the main agent. |
| Effort policy of adaptive, conservation or quality (`:85-95`) | Fixed mapping from role and complexity. The only budget input is the step-down when the level is `low`. |
| Allowed-models setting, low-allowance policy, API fallback and spending limits (`:119-152`) | Not implemented. Model choice is hard-coded in `pickModel`. |
| Safe concurrency per assignment, plus an application-wide queue with priorities | A fixed per-project limit of 3 (configurable only through a test hook), with file locks. No cross-project queue and no priorities. |
| Conversation-level temporary CLI override (`interface-design.md:92,153`) | Not implemented. `routing: 'manual'` is stored but unused. |
| Claim that the planner supplies estimates used in routing | The planner returns only a markdown spec. Only the main agent's `complexity` per task reaches the router. |
| Free reset only when an entitlement is confirmed, never automatic | Consistent, since no entitlement source is wired in. The offer can never appear in production. |
| "Avoid hard-coded provider superiority" (also `AGENTS.md`) | The code holds no provider-superiority claims. The model tiers (opus, sonnet, haiku) are hard-coded within Claude only. |

## 9. What I did not verify

- I ran no tests, no `npm run smoke`, and no real CLI.
- The behaviour of Claude and Codex flags is taken from the code's own header comments, which cite `claude` 2.1.293 and `codex-cli` 0.160.0.
- I did not read `src/renderer/**` beyond the lines that reference routing and settings.
- I did not read the main checkout or any untracked or uncommitted files there. Whether `codexLimits.ts` exists there is unknown.
- I did not read `scripts/smoke.ts`, `tests/orchestrator.test.ts` or `core.test.ts` in full. From the test lines I saw, the claims on continuity, exclusion, unknown sign-in and fallback match the tests, but I did not run them.

No changes were committed on harbor/explain-how-harbor-picks-an-agen-474f46.