# Architecture

This page describes what the code does today. The other documents say what each part is for; where they differ from this page, this page (written from reading `src/main`) wins, and the difference is marked in the other document. Nothing here was checked by running the app.

## One screen

```text
Renderer (React, src/renderer)        window.harbor  (typed IPC, src/preload)
        |                                      |
        v                                      v
Electron main (src/main/index.ts)  --  ipc.ts: sender check + argument validation (ipcValidate.ts)
        |
        v
service.ts  HarborApi over Store + Orchestrator + UsageLedger   (no electron imports outside index.ts)
        |
        +-- store.ts          state.json (atomic write, rolling .bak, corrupt-file quarantine)
        +-- orchestrator.ts   concierge -> lead -> helpers; scheduling; checks; integration; rollback; permissions
        |       +-- prompts.ts     LEAD_SYSTEM, CONCIERGE_SYSTEM, role contracts, protocol parser
        |       +-- router.ts      which CLI, model and effort (pure)  + clis/capabilities.ts (catalog as data)
        |       +-- usage.ts       ledger: estimates and provider-reported windows; free-reset coordinator
        |       +-- git.ts, gitView.ts, review.ts, rollback.ts, checks.ts, locks.ts, handoff.ts, journal.ts
        |       +-- adapters/      claude.ts, codex.ts (prompt on stdin, Chunk stream, one final "done")
        +-- clis/discovery.ts  finds claude, codex, gemini; sign-in state
        +-- updater.ts, logger.ts, diagnostics.ts, tray.ts, windowSecurity.ts (main-process only)
```

Rules that shape the code: the renderer/main contract is `src/shared/api.ts` (only optional fields and new methods are added; every change is in `src/shared/CHANGELOG.md`); adapters take the prompt on stdin, never argv, and always end with exactly one `done` chunk; pure functions (routing, parsing, scoring, handoff) are separated from processes so they can be tested with fakes; capability claims live only in the editable catalog data, never in routing code.

## Roles of agents

- **Concierge.** One short, tool-less call to a cheap model (tier `cheap`, effort low, read-only, no session resume). It either answers or escalates with a complexity (low, medium, high), a list of needs, and a one-line acknowledgement. It sees only facts printed in its prompt: the project name, counts and titles of the conversation's helpers, and the last few messages.
- **Lead.** One logical lead (`role: 'main'`) per project, but one native CLI session per conversation, resumed on every turn. It is an ordinary working agent: it reads, edits and runs commands in the project folder. It delegates with `HARBOR_DELEGATE` lines only when that pays off. It may also emit `HARBOR_ASK` (a question for you), `HARBOR_IMAGE_BRIEF`, `HARBOR_GOAL_DONE`, `HARBOR_DECISION` (something that must survive a lost session) and `HARBOR_PEER` (a note to another lead of the same project).
- **Helpers.** Roles `planner`, `implementer`, `reviewer`, `other`. Each has one assignment and a role contract. Edit helpers (implementer, or `other` with edit access) get their own git worktree; planners, reviewers and read-only helpers do not edit (a reviewer runs in the reviewed helper's worktree). They report in their final message and may print `HARBOR_REQUEST_HELP`, `HARBOR_ASK` and a `HARBOR_RESULT` line. They never start agents (Claude's `Task`/`Agent` tools are disabled and the contract forbids it) and never message each other.
- **Integrator and rollback agents.** `role: 'other'` records that Harbor runs itself with no CLI (`cli: 'harbor'`, `model: 'git'`): deterministic git code in `runIntegration` and `runRollback`.

## Path of one user prompt

1. **Composer to main process.** The renderer calls `send(conversationId, text, attachments?)`. `ipc.ts` checks that the call comes from the app's own window and validates the arguments. `service.send` validates and writes any images (png, jpeg, gif or webp, up to 6, 10 MB each) to `attachments\<conversationId>\`, then calls `orchestrator.userMessage`.
2. **Recording.** The message is stored. If the conversation is in `plan` mode and the text is a short go-ahead, the mode returns to `default`. The turn is queued on a per-conversation chain, so one long turn never blocks another conversation.
3. **Triage (`mainTurn`).** `/deep` skips triage and uses a strong lead at high effort. Images, a go-ahead continuing the last request, pending helper reports, and a reply to the lead's own question also skip the concierge. Messages that are plainly work (a file name, a code fence, a stack trace, words like fix, implement, build, commit), or that name a CLI ("use codex"), escalate without a concierge call. Everything else goes to the concierge. If the concierge answers a message that needs the workspace, its answer is discarded and the lead takes over. An unparseable concierge reply escalates at medium complexity.
4. **Routing.** The lead's tier follows the complexity (low is cheap, medium standard, high strong), its needs always include `code`, and `route()` (see [Background routing](background-routing.md)) picks CLI, model and effort. The session continues natively if the same CLI is chosen; otherwise Harbor prepends a handoff it wrote (decisions, unfinished work, evidence against the commit it ran on; see below).
5. **Edit slot.** Only one lead turn per project edits the project folder at a time; others wait (shown as queued). `plan` mode leads are read-only and never wait. A notice appears once when a second lead is running in the same folder.
6. **Lead turn.** The CLI runs with the lead's system prompt, streaming text and tool activity into the conversation. Permission is `edit` (default; Claude: accept edits, an allowlist of `git`, `npm`, `npx`, `node`, plus the project's check commands; other tools ask you), `read-only` (plan) or `full` (auto). Git merge, rebase, cherry-pick, reset and push are denied for Claude leads. A turn is stopped at 60 minutes; a run silent for 10 minutes is flagged as possibly stuck.
7. **Protocol parsing.** After the turn Harbor parses `HARBOR_*` lines (one physical line of valid JSON at column 0, not inside a fence, quote or indented block). Duplicate delegations are started once, and lines it could not act on are reported once, with one corrective resume of the lead per user message. In plan mode, edit delegations are dropped. Decisions become `decision` coordination entries; peer lines are delivered (below).
8. **Creating helpers.** For each delegation Harbor creates an agent record (state `queued`) and its own conversation. A `dependsOn`, `specFrom` or integrator source that names nothing fails that task instead of guessing; circular dependencies are broken and announced; a retry of failed or rejected work (`retryOf`) runs one complexity level up and at high effort. If the project folder has uncommitted edits Harbor says so once: helpers start from the committed `HEAD`.
9. **Scheduling (`pump`).** Queued helpers start in order of priority then age, when their dependencies are done, the project is under its concurrency limit (default 4, 1 to 8), the conversation is not in plan mode (for edit helpers), and file ownership allows it. A helper that edits in its own worktree takes no lock; only a helper that must edit the shared folder (no git repository with commits) locks files, or the whole project when it did not name files. A dependency that failed or was stopped fails its dependents, except when a restart stopped it (they wait for you to resume it).
10. **Running a helper.** An edit helper gets a worktree under `%APPDATA%\Harbor\worktrees` on branch `harbor/<slug>` from the committed `HEAD` (an existing branch of that helper is reused), with the project's ignored `node_modules` linked in. The CLI is routed per helper (role, complexity, needs, a CLI the lead pinned, retry). Every run ends with a checkpoint commit of whatever the helper left (credential-looking files excluded), so a failure or stop loses nothing. A planner's report becomes an implementer's specification verbatim; a reviewer is told the base commit and judges `git diff <base>..HEAD` against the specification.
11. **Checks.** If `.harbor/checks.json` exists and you approved its exact commands, Harbor runs them in the helper's worktree on the checkpoint commit and records the outcome with `testedCommit`. These are evidence; a helper's own `HARBOR_RESULT` checks are only claims. A later commit on the branch marks both outdated.
12. **Reports back.** Harbor wakes the lead only when its judgement is needed: a planner finished, a helper failed, or no helper of the conversation is still active. The wake-up carries the compressed reports of everything finished and not yet delivered, and Harbor tracks whether each report was delivered. A helper that was requested for a blocked helper hands its report straight back to the blocked one. A helper that ends without a `HARBOR_RESULT` is recorded as `partial`, and a reviewer without a final verdict line is flagged `NO VERDICT` and counts as neither approval nor rejection. The lead reads the reports, may delegate follow-up work, and ends with a summary that should say what was and was not verified.
13. **Integration.** The lead asks for an integrator (you can also start one through the `integrateBranches` API method; the integrate screen was in progress in the UI). It waits for the sources and their reviewers, then gates every source: an approving review of exactly the branch's current head, none asking for changes. It merges each source by pinned SHA with `--no-ff` into a new `harbor/integrate-<target>-<id>` worktree created from the target's head, runs the checks on the combined result, and stops on any conflict (aborting that merge). Nothing in your branch has changed yet.
14. **Apply.** `applyIntegration` fast-forwards the target branch to the integration head, and only if the integration is done and fully merged, your project folder has no uncommitted changes, the target has not moved since the integration's base, and the target is not checked out in another worktree. It never pushes or forces and is idempotent.
15. **Rollback (on request).** `previewRollback` simulates reverting the merges that brought a task onto a branch (using `git merge-tree`, changing nothing). `rollbackTask` reverts those merges, newest first, on a new `harbor/rollback-*` worktree, runs the checks, and the result is applied like an integration. Effects outside git (deploys, messages sent, pushes) are not undone.

## Cross-cutting machinery

- **Fallback and retries.** A failed run is retried on the same CLI after a wait when the failure is a known transient (a Claude sign-in refresh race, a connection error); otherwise the CLI is excluded for that task and the next best is routed, with the reason posted. A rate limit holds that model out for 30 minutes. A signed-out failure marks the CLI signed out until you refresh.
- **Restart recovery.** On startup Harbor kills leftover CLI processes it recorded (only when the live process still matches the recorded name and start time), marks working agents `stopped` with a restart notice, commits their uncommitted work to their branches, prunes dead worktree records, and tells each conversation which helper reports may not have reached its lead. Pending permission requests and questions live in memory only. A stopped helper is continued from its saved session through `resumeAgentSession` or by messaging it.
- **Handoff (`handoff.ts`).** When a lead or helper cannot resume its native session (new conversation, lost session, another CLI took over) Harbor prepends its own briefing: decisions the lead recorded (framed as the lead's notes of what you said; your current message wins), unfinished work, verification evidence with the commit it covered (anything older shows as stale), and what was already applied. It is built only when needed.
- **Tool permissions.** Claude edit runs use the stream-json control channel; a tool outside the allowlist becomes a `permission` event (kind `tool`) answered by you. Project "always allow" rules are stored per project (`ToolRule`) and never cover dangerous kinds. Codex has no host approval channel, so it runs in its own sandbox with no prompts.
- **Worktree cleanup.** At startup and after an Apply, Harbor removes worktree folders of work that has landed or been idle 14 days (after committing anything left), never a running helper, a needed dependency, or the source of an unapplied integration. Branches are never deleted.
- **Journal and diagnostics.** `journal.jsonl` records protocol problems, helper failures, failed checks, out-of-claim edits, permission decisions and rollbacks. `exportDiagnostics` builds a redacted support bundle with no message text.

## Data model

Persisted in `%APPDATA%\Harbor\state.json` (`State` in `src/main/types.ts`; fields added later are optional so older files load):

| Entity | What it is |
| --- | --- |
| `Project` | Name, local folder, last opened, optional icon. One lead agent record is created per project. |
| `Conversation` | A thread inside a project. `agentId` is the lead for a user conversation, or a helper's id for that helper's chat. Optional `mode` (default, auto, plan, goal), `goal`, `activity` (state, current step, CLI, model, complexity, effort), `reviewBase`, pinned, archived, custom title. |
| `Message` | `role` user, assistant, system or tool; text; optional `details` (CLI, model, effort and the routing reason) and image attachments (paths in Harbor's data folder). |
| `AgentRecord` | The lead (`main`) or one assignment. State queued, working, waiting, done, failed or stopped; role; CLI, model, effort; task and specification; `dependsOn`, `files`, `needs`, pinned CLI, priority and paused; `worktree`, `branch`, `baseCommit`, `headCommit`; `result` (self-reported), `checks` (Harbor-run) with `testedCommit` and `outdated`; `integration` or `rollback` details; per-run `snapshots`; report-delivery marks. 1 agent is 1 assignment. |
| `SessionLink` | Maps a session key to a native CLI session: `lead:<conversationId>`, `concierge:<conversationId>`, or a helper's agent id, with the CLI that owns it. A session is only resumed on the same CLI. |
| `UsageEvent` | One CLI run: CLI, model, project, agent, conversation, duration, ok, rate-limited, tokens and cost when the CLI reported them, and the account limits it printed (`limits`). Events older than 8 days are folded into archive totals. |
| `CoordinationEntry` | Kinds `peer` (lead-to-lead note), `lock`, `handoff`, `conflict`, `direct` (you messaged a helper), `help` (a helper asked for help) and `decision`. |
| `FileLock` | Whole-file ownership for edits made in the shared folder, with prefix-aware overlap; only released after the owner's process ended. |
| Other | `ResetApproval` (your answers to free-reset proposals), `toolRules` (per project), `checksApproved` (hash of the approved `.harbor/checks.json` commands per project), tracked CLI process ids, `Settings`. |

## Where the code is

`src/main/orchestrator.ts` is the largest file (turn handling, scheduling, runs, integration, rollback, permissions); `prompts.ts` holds every instruction given to models and the protocol parser; `router.ts` and `usage.ts` are pure enough to read in one sitting. The tests in `tests/` use fake adapters and real git in temp folders.
