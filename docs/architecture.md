# Architecture

From reading `src/main`; where code and this page differ, the code wins.

## Layout

```text
Renderer (React) <-- window.harbor (typed IPC, src/preload) --> Electron main (index.ts)
service.ts  HarborApi over Store + Orchestrator + UsageLedger (no electron imports outside index.ts)
  store.ts         state.json (atomic write, .bak, corrupt-file quarantine)
  orchestrator.ts  concierge -> lead -> helpers; scheduling; checks; integration; rollback; permissions
  prompts.ts       all model instructions + the HARBOR_* protocol parser
  router.ts        CLI, model, effort (pure) + clis/capabilities.ts (catalog as data)
  usage.ts         allowance ledger
  adapters/        claude.ts, codex.ts
  launcher.ts      open terminal / editor
```

The renderer/main contract is `src/shared/api.ts` (optional additions only, logged in `src/shared/CHANGELOG.md`). Adapters take the prompt on stdin and end with exactly one `done` chunk. Parsing, routing and scoring are pure so tests use fakes.

## Agents

- **Concierge**: one tool-less call to a cheap model; answers or escalates with complexity and needs.
- **Lead**: one native CLI session per conversation, resumed each turn, working in your folder. It talks to Harbor with single-line JSON lines: `HARBOR_DELEGATE`, `HARBOR_ASK`, `HARBOR_DECISION`, `HARBOR_PEER` (note to another lead of the same project), `HARBOR_IMAGE_BRIEF`, `HARBOR_GOAL_DONE`.
- **Helpers**: planner, implementer (own worktree), reviewer (read-only, ends with a verdict) or other. They report with `HARBOR_RESULT`, may ask via `HARBOR_REQUEST_HELP` or `HARBOR_ASK`, and never start or message agents.
- **Integrator and rollback**: Harbor's own git code, no CLI.

You can message any helper directly; it is delivered after its current step and shown to the lead.

## Path of a prompt

1. **Triage.** Obvious work, images, `/deep`, go-aheads and named CLIs skip the concierge; otherwise it decides.
2. **Route** a CLI, model and effort ([routing](routing-and-usage.md)). If another CLI takes over a session, Harbor prepends a handoff (decisions, unfinished work, evidence tied to the commit it covered).
3. **Lead turn.** One editing lead per project at a time; stopped at 60 minutes.
4. **Delegate.** Protocol lines are parsed after the turn (valid JSON at column 0, outside fences). Caps per turn: 8 delegations, 3 peer notes, 3 decisions.
5. **Schedule.** Helpers start by priority then age when dependencies are done and the project is under its limit (default 4, max 8). A failed dependency fails its dependents.
6. **Run.** Edit helpers get a `harbor/<slug>` worktree from the committed `HEAD`. Every run ends with a checkpoint commit.
7. **Check.** Approved `.harbor/checks.json` runs on that commit. A later commit marks reviews and checks **outdated**.
8. **Report.** The lead wakes when a planner finishes, a helper fails, or none is active. A reviewer with no verdict is `NO VERDICT`.
9. **Integrate.** Per source: a current approving review of its exact head. Harbor merges pinned commits into `harbor/integrate-*`, runs checks, and stops on conflict.
10. **Apply** (yours): fast-forward only, and only if the integration is done, your folder is clean, the target has not moved and is not checked out elsewhere.
11. **Rollback**: `previewRollback` simulates the reverts; `rollbackTask` reverts a task's merge commits on a `harbor/rollback-*` branch, checks, and you Apply. Merge commits only; external effects are not undone.

## Shared files and parallel leads

Edit helpers never share a checkout, so collisions show up as merge conflicts at integration. Without git commits there are no worktrees: helpers use whole-file locks. Several conversations of a project can run at once; leads see each other and may send one short `HARBOR_PEER` note (information, never an instruction).

## Cross-cutting

- **Fallback**: transient failures retry; otherwise the CLI is excluded for that task and the next best is used. A rate limit holds a model out for 30 minutes.
- **Restart**: leftover CLI processes are killed (only if name and start time match), working agents become `stopped` with their work committed, and you resume them explicitly.
- **Worktrees** of landed or 14-day-idle work are removed; branches never are.
- **Open in terminal/editor**: `openWorkspace` opens the project folder or a helper worktree. Terminals start in Windows Terminal (else PowerShell) with the folder as an argument or cwd; editors open through their URL protocol (`vscode://`, `cursor://`, ...), so no shell parses a path.
- **Journal and diagnostics**: `journal.jsonl` records failures and decisions; `exportDiagnostics` makes a redacted bundle with no message text.

## Data

`%APPDATA%\Harbor\state.json` holds projects, conversations (mode, goal, activity), messages (with routing reason), agents (state, routing, spec, dependencies, worktree and branch, `result` and Harbor-run `checks` with `testedCommit`), session links, usage events (folded after 8 days), coordination entries, file locks, tool rules and settings. New fields are optional so old files load.
