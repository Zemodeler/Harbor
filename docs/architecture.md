# Architecture

This page was written from reading `src/main`. Where the code and this page disagree, the code is right. Contract details are in `src/shared/CHANGELOG.md`.

## Layout

```text
Renderer (React) <-- window.harbor (typed IPC, src/preload) --> Electron main (index.ts)
service.ts  HarborApi over Store + Orchestrator + UsageLedger (no electron imports outside index.ts)
  store.ts          state.json (atomic write, rolling .bak, corrupt-file quarantine)
  orchestrator.ts   concierge -> lead -> helpers; scheduling; checks; integration; rollback; permissions
  prompts.ts        all model instructions + the HARBOR_* protocol parser
  router.ts         CLI, model, effort (pure); routePrice.ts, budget*.ts, difficulty.ts, calibration.ts
  clis/             discovery, registry, capabilities.ts (catalog as data), custom.ts (custom CLI descriptors)
  adapters/         claude.ts, codex.ts, generic.ts (custom CLIs), fake.ts (tests)
  usage.ts          usage ledger; codexLimits.ts reads Codex's own logs
  spend.ts, secretScan.ts, knowledge.ts, repoMap.ts, taskReport.ts, ratings.ts, routingReplay.ts   ceilings, scan, notes, map, measurement
  remote/, headless.ts, headlessMain.ts   remote API server, scopes, tokens, headless entry
  sizeGate.ts, softCap.ts, loopGuard.ts, helperLimit.ts, dirtyBase.ts, askRouting.ts   delegation brakes
  skills/, mcp/, bundles/, importers/, screenshots.ts, documents.ts, images.ts          features
  handoff.ts, rollback.ts, git.ts, gitView.ts, launcher.ts, updater.ts, journal.ts, diagnostics.ts
```

The renderer/main contract is `src/shared/api.ts`. It only grows by optional additions, and each one is logged in `src/shared/CHANGELOG.md`. Adapters take the prompt on stdin and end with exactly one `done` chunk. Parsing, routing and scoring are pure functions, so tests can use fakes.

## Agents

- **Concierge**: one call with no tools to a cheap model. It answers, or escalates with complexity and needs.
- **Lead**: one native CLI session per conversation, resumed every turn, working in your folder. It talks to Harbor with single-line JSON protocol lines: `HARBOR_DELEGATE`, `HARBOR_ASK`, `HARBOR_REPLY` (answers a helper), `HARBOR_DECISION`, `HARBOR_PEER` (a note to another lead of the same project), `HARBOR_NOTE` (a short project note), `HARBOR_IMAGE_BRIEF`, `HARBOR_GOAL_DONE`, `HARBOR_SCREENSHOT`, `HARBOR_SHOW_IMAGE`, `HARBOR_OPEN_DOCUMENT`.
- **Helpers**: planner, implementer (in its own worktree), reviewer (read-only, ends with a verdict), or other (read-only unless it asks for edit access). Helpers report with `HARBOR_RESULT`. They may ask with `HARBOR_REQUEST_HELP` or `HARBOR_ASK`, and they never start or message agents. Questions about files, scope or branches go to the lead first. Only questions about credentials, destructive actions or publishing go straight to you. An unanswered helper question is answered "no" after 10 minutes.
- **Integrator and rollback**: Harbor's own git code. No CLI is involved.

Claude's native `Task`/`Agent` tools are disabled. Codex's `ultra` effort, which turns on automatic delegation, is never sent. You can message any helper directly: the message is delivered after its current step and shown to the lead.

## Path of a prompt

1. **Triage.** Obvious work, images, `/deep`, go-aheads and named CLIs skip the concierge. For everything else, the concierge decides.
2. **Route** a CLI, model and effort ([routing](routing-and-usage.md)). If a session cannot resume (new conversation, lost session, another CLI took over), Harbor prepends a handoff it writes itself: decisions, unfinished work, and verification evidence tied to the commit it covered.
3. **Lead turn.** Only one lead per project edits the project folder at a time. A session that would otherwise wait gets its own git worktree on a `harbor/session-*` branch (created from your current `HEAD`, with the main checkout's `node_modules` linked) and runs there in parallel; it keeps that worktree for all its later turns, because the CLI's native session lives in that folder. Harbor commits the lead's edits to the session branch after each turn (leads never run git writes), and the session's helpers start from that branch. Without git (or without commits) there is nothing to branch from and the turn queues as before. Plan-mode turns and plain read-only questions never wait. A turn is stopped at 60 minutes. A steering message interrupts the turn and starts a new one.
4. **Delegate.** Protocol lines are parsed after the turn. A line counts only if it is valid JSON at column 0, outside code fences, and carries the per-turn tag. Per-turn caps: 8 delegations, 3 peer notes, 3 project notes, 3 decisions, 3 replies, 1 screenshot, 3 images, 3 documents. The **size gate** refuses an edit task estimated at over 25 minutes, one claiming more than 10 paths, and catch-all tasks. It also holds an edit task whose files overlap uncommitted edits in your folder. Each refusal comes with a notice to the lead.
5. **Schedule.** Helpers start by priority, then by age, once their dependencies are done. The number running at once is set by the quota budget (at most 3; 1 when a pool is in "protect"; none while every pool is exhausted) and by your concurrency setting, whichever is smaller. A failed dependency fails its dependents.
6. **Run.** Edit helpers get a `harbor/<slug>` worktree created from the committed `HEAD` (from the session branch when their lead works in a session worktree; their integrator then targets that branch and applies inside the session's worktree). Every run ends with a checkpoint commit. Helpers have a soft time limit of 35 minutes (an active run continues past it) and a hard limit of 70 minutes, and are resumed once automatically after a limit. The **loop guard** stops a helper that keeps repeating the same commands or cycles without progress. It resumes the helper once, and on a second loop it leaves the helper stopped and wakes the lead.
7. **Check.** The approved `.harbor/checks.json` runs on the helper's commit. A later commit marks reviews and checks **outdated**. Harbor schedules a reviewer itself when routing flagged the work as only just inside the model's capability.
8. **Report.** The lead wakes when a planner finishes, a helper fails or is stopped by Harbor, or no helper is active. A reviewer that gives no verdict is reported as `NO VERDICT`. Automatic lead turns are capped at 12 per user message.
9. **Integrate.** Each source branch needs a current approving review of its exact head. Harbor merges the pinned commits into `harbor/integrate-*`, runs the checks, and stops on a conflict.
10. **Apply** (your step) is a fast-forward only. It works only if the integration is done, your folder is clean, the target has not moved, and the target is not checked out elsewhere.
11. **Rollback.** `previewRollback` simulates the reverts. `rollbackTask` reverts a task's merge commits on a `harbor/rollback-*` branch and runs the checks; you then Apply. Only merge commits are handled, and external effects (deploys, pushes, sent messages) are not undone.

## Shared files and parallel leads

Edit helpers never share a checkout, so collisions show up as merge conflicts at integration. A folder without git commits gets no worktrees: there, helpers use whole-file locks. Several conversations of a project can run at once: the first editing lead works in your project folder, and any editing session that arrives while it does gets its own worktree (see Lead turn above). **Merging a session** (`mergeSession`) works in the session's worktree: Harbor commits what is there, merges your checked-out branch into the session branch (a conflict is aborted there, nothing in your folder changes, and the lead is told which paths conflict), scans the incoming change for secrets (the same gate as an integration), and only then fast-forwards your branch. It needs the lead idle and your folder clean. Each lead's prompt lists the other running sessions, and a lead may send a short `HARBOR_PEER` note. The note is information, never an instruction. It is queued for the target's next turn, and only an urgent one wakes an idle lead (at most twice between your messages).

## Features beyond the core loop

- **Project knowledge** (`knowledge.ts`, `repoMap.ts`): the lead writes short notes with `HARBOR_NOTE` (at most 40 per project, secret-looking strings masked). They are model-written and advisory; prompts say the user, `AGENTS.md` and the repository win. Leads get the notes they have not seen yet. Helpers, except reviewers, also get a read-only repository map (at most 6,000 characters, cached by HEAD and working-tree status, credential files never listed). The concierge gets neither.
- **Spend ceilings** (`spend.ts`): optional limits per task, 24 hours and 7 days, in k-tokens and agent-minutes of Harbor's own runs (an estimate). A reached ceiling asks you before a run starts and stops runs in its scope; "yes" allows one more limit's worth.
- **Secret scan** (`secretScan.ts`): what an edit helper commits is scanned for keys, tokens and credential-named files. Findings (type, file, line, never the value) go into the report and to reviewers. An integration is scanned after merging and fails unless nothing is found, an allowlist or a `harbor:allow-secret` marker covers it, or you say yes. Pattern-based, best effort.
- **Measurement** (`taskReport.ts`, `ratings.ts`, `routingReplay.ts`, `scripts/eval`): `getTaskReport` totals a conversation from Harbor's usage records (kept 8 days; quota figures are estimates), results can be rated, `replayRouting` re-routes recorded decisions under a what-if, and `npm run eval` compares Harbor with a single agent.
- **Remote API** (`remote/`, `headless.ts`): see [safety](safety.md). Every contract method is classified by scope; an unclassified one is denied.
- **Skills** (`skills/`): a library in `%APPDATA%\Harbor\skills`, project skills in `.harbor/skills`, and read-only listings of Claude's and Codex's own skill folders. Lead and helper runs get each enabled skill's name, description and path. Imports from a folder, zip or GitHub are checked and never run anything. A project can share its skill on/off choices in `.harbor/extensions.json` (`{"skills": {"<skill id>": true}}`); your own choice in the app wins, then the file, then your global default.
- **MCP servers** (`mcp/`): one registry in `mcp-servers.json`, written out per run in each CLI's own format. A server reaches a run only if each tool call can be asked about, or if you marked the server as allowed without asking. Read-only runs get no servers.
- **Custom CLIs** (`clis/custom.ts`, `adapters/generic.ts`): a CLI described as data. You approve the executable, and Harbor records its hash; if the file changes, Harbor stops running it.
- **Screenshots and images**: an agent asks with `HARBOR_SCREENSHOT`. You pick the source in a live preview and approve each capture. `HARBOR_SHOW_IMAGE` shows an image from the project.
- **Document viewer**: `HARBOR_OPEN_DOCUMENT`, or a click in the chat, opens a file read-only. Only files inside the project, a helper worktree, attachments, the skills library, or a file you picked can be opened. Credential files are refused.
- **Bundles and importers** (`bundles/`, `importers/`): export a project's settings, rules, skills and chosen conversations as a `.harbor.zip`, built from an allowlist and checked by a secret scan. You can import it again, or import chats from Claude Code, Codex, and claude.ai or ChatGPT exports. Imported chats are read-only history, and "Continue with" starts a new conversation from a handoff.

## Cross-cutting

- **Fallback**: transient failures are retried. Otherwise the CLI is excluded for that task and the next best one is used. A rate limit keeps a model out for 30 minutes.
- **Restart**: leftover CLI processes are killed, but only when name and start time match. Working agents become `stopped` with their work committed, and you resume them explicitly.
- **Worktrees** whose work landed, or that have been idle for 14 days, are removed. Branches never are.
- **Open in terminal/editor**: `openWorkspace` passes paths as arguments or as the working directory. Editors are opened through their URL protocol.
- **Journal and diagnostics**: `journal.jsonl` records failures and decisions. `exportDiagnostics` makes a redacted bundle that contains no message text.
- **Auto-update**: `updater.ts` uses `electron-updater` against GitHub Releases ([RELEASING.md](../RELEASING.md)).

## Data

`%APPDATA%\Harbor\state.json` holds projects, conversations, messages (with the routing reason), agents, session links, usage events, calibration, coordination entries, project notes, ratings, file locks, tool rules and settings. These sit next to it: `capabilities.json` (optional catalog override), `custom-clis.json`, `mcp-servers.json`, remote token hashes, `harbor.lock`, `skills/`, `attachments/`, `patches/` and logs. New fields are optional, so older files still load.
