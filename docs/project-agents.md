# Concierge, lead and helpers

Status: implemented (`src/main/orchestrator.ts`, `prompts.ts`). This document replaces the earlier "main agent that only delegates, sibling agents that talk to each other" model; see [Superseded](#superseded-from-the-earlier-design) at the end. [Architecture](architecture.md) has the step-by-step path of a prompt.

## Core model

Every user message goes first to a **concierge**: a cheap, tool-less model that either answers from the conversation or escalates. An escalation starts the conversation's **lead**: a normal working agent session in the project folder that reads, edits and runs commands, and answers you. The lead does the work itself whenever it fits in one focused session. Only when that clearly pays off (independent parts that can run in parallel, long or bulky work such as broad research or many mechanical edits, an independent review) does it delegate to **helpers** by printing `HARBOR_DELEGATE` lines. Harbor, not the lead, creates, schedules, routes and monitors the helpers.

Helpers never start agents and never message each other. They report to the lead. Leads of different conversations of the same project can send each other one short `HARBOR_PEER` note (see [Agent collaboration](agent-collaboration.md)). You can open any helper's conversation and message it directly.

This remains a project-first chat experience. Coordination happens behind the familiar interface and needs no setup.

## Lead

One logical lead agent exists per project (an agent record with role `main`), but each conversation has its own native session, resumed between turns, so conversations do not share context. The lead:

- Answers questions, reads code, edits files and runs commands in the project folder, as any coding assistant would.
- Delegates with `HARBOR_DELEGATE` lines (at most 8 per turn). It states what the work needs (code, research, planning, review, long-context, vision) and its complexity; Harbor picks the CLI and model. It may pin a CLI only when the task truly needs one.
- Receives helper reports (compressed), checks them (Harbor-run checks are evidence, a helper's own claims are not), may delegate follow-ups or fix things itself, and tells you what was and was not verified.
- Requests an integrator (`HARBOR_DELEGATE` with `"role":"integrator"`) to land finished, reviewed branches. It never merges, rebases, cherry-picks, resets or pushes itself; the integrator is Harbor's own code.
- Asks you a question with `HARBOR_ASK` when it truly cannot proceed (it ends its turn; your answer is its next message), records settled decisions with `HARBOR_DECISION` so they survive a lost session, writes a paste-ready brief with `HARBOR_IMAGE_BRIEF` when asked for an image (Harbor cannot generate images), and in goal mode ends with `HARBOR_GOAL_DONE` when the goal is reached.
- Is not allowed to use Claude's native `Task` or `Agent` tools or plugins to spawn agents.

Harbor guards the lead's behavior in code: one lead turn per project edits the folder at a time; a turn is stopped at 60 minutes; at most 12 automatic lead turns follow one user message; protocol lines it got wrong are reported once and the lead gets one chance to correct them; delegations it repeats start once; an edit delegation in plan mode is dropped.

The lead's tier follows the concierge's complexity estimate (low is a cheap model, medium standard, high strong), and its needs always include code. A user can force a strong lead with `/deep`.

## Helper roles

| Role | Single responsibility | Access | Output |
| --- | --- | --- | --- |
| Planner | Think through one task and write a specification. | Read-only | Goal, specification, acceptance criteria, risks and open questions. |
| Implementer | Implement exactly the assigned work. | Edit, in its own git worktree and branch | Committed changes, a report of files changed, checks run and unresolved issues. |
| Reviewer | Try to show a change does not meet its goal. | Read-only, in the reviewed helper's worktree; cannot run tests | Findings with file and line evidence, then a verdict (approve or changes) on the last line. |
| Other | One focused job the lead describes (research, investigation, a tester-like read of the code, a mechanical edit). | Read by default; edit when the lead says so | Findings or results with evidence. |
| Integrator | Merge approved branches of other helpers. | Harbor's own code, no CLI | `harbor/integrate-*` branch and report. See [Agent collaboration](agent-collaboration.md). |
| Rollback | Revert a task's merges. | Harbor's own code, no CLI | `harbor/rollback-*` branch and report. |

Unknown roles the lead invents (researcher, investigator, analyst, tester, explorer) become read-only `other` helpers. These are available assignment types, not mandatory stages. A small, fully specified change goes to one implementer, or the lead just does it; do not create agents to fill roles. An implementer receives its specification before it starts (a planner's report verbatim, or the lead's instructions) and must not expand scope; an unresolved design question goes back to the lead through `HARBOR_REQUEST_HELP`. This restriction is about work, not conversation: a helper can explain, answer and discuss with you.

## Small-task fast path

The default for a clear question or small edit is no helper at all: the concierge escalates, the lead does it in one session. Planning, independent review and integration are added only when complexity or the cost of an error justifies them. A helper that already finished can be followed up (its session is resumed) rather than replaced, by a direct message or a lead instruction; an idle-worker reuse policy beyond that is not built.

## Assignment record

Each helper is an agent record that Harbor persists:

- Identity: id, revision (incremented when you message it directly), project, the conversation it reports to, its title and role.
- Instructions (`task`), and for implementers a specification (the planner's report, or the instructions themselves).
- Dependencies (`dependsOn`, `specFrom`), declared file ownership (`files`, informational for worktree helpers), needs, complexity, pinned CLI.
- Scheduling: state, priority, paused flag, retry marker.
- Workspace: worktree, branch, base commit, head commit.
- Evidence: the helper's own `HARBOR_RESULT` (outcome, summary, reviewer verdict, claimed checks), Harbor-run checks with the tested commit, whether that evidence is outdated, per-run snapshots.
- Routing: CLI, model, effort chosen at run time, with the reason stored on the messages.

## Requesting help

A helper that needs something it cannot do alone prints `HARBOR_REQUEST_HELP` (reason, proposed role, single-responsibility instructions, whether it is blocked). Harbor wakes the lead with the request. The lead decides: delegate another helper (marked as helping the requester), do it itself, or answer in text. If the lead assigns nobody, Harbor tells the blocked helper to proceed on its own judgment. Requests count toward the same automatic-turn cap as everything else. No recursive delegation exists: helpers cannot create agents, and Claude's native spawning tools are disabled for every run. Whether Codex has a native sub-agent feature that would bypass this is not verified.

## Direct user access

You can open a helper's conversation, send context or corrections, stop it, resume it from its saved session when it was stopped, and (through the API) pause, prioritize or cancel it while it is queued. A direct message is recorded as a coordination entry, shown in the lead's conversation, passed to the lead as a note on its next turn, and delivered to the helper after its current step. The helper's revision increases so its later reports are attributable.

Not built: a hold-and-acknowledge protocol that pauses dependents when you change a specification or a shared interface. Today the lead decides what to do about it on its next turn, and dependent work is not automatically held. See [Limitations](limitations.md).

## Reports

A helper's final message is all the lead receives, so it must contain the findings with file and line evidence. It ends with exactly one `HARBOR_RESULT` line (outcome done, partial or blocked, a summary of at most two sentences, the reviewer's verdict, and the checks it says it ran). A helper that ends without one is recorded as `partial`; a reviewer without a valid final verdict is flagged `NO VERDICT` and counts as neither approval nor rejection. Reports are clipped before they reach the lead. Harbor tracks whether each report reached the lead: confirmed when a lead turn carrying it finished, uncertain when the turn was interrupted, and uncertain reports are re-sent with the next turn. Reports are never presented as independently verified unless a reviewer or Harbor's checks say so.

### Verification applies to a specific version

A reviewer's approval is recorded with the exact commit it examined (`testedCommit`, taken when its run starts); Harbor-run checks are recorded with the commit they ran on. If the branch later moves, `outdated` becomes true and neither counts for the new head. The integration gate requires a current approval of exactly the head it merges. Evidence from an earlier commit is shown to a lead or a restarted session as covering that earlier commit only. Without a `.harbor/checks.json` Harbor runs no checks and tells the lead so.

## States and lifecycle

Helper states are `queued`, `working`, `waiting`, `done`, `failed` and `stopped`. Queued also means "waiting for a dependency, a file or a free slot", with the reason shown. `waiting` means blocked on a question to you or on help it requested. A paused flag keeps a queued helper from starting. A report alone does not satisfy dependents when checks or integration are outstanding: a dependent runs only when its dependencies are `done`, and a failed or stopped dependency fails its dependents (except one stopped by a Harbor restart, which waits for you to resume it).

When a CLI fails or runs out of allowance, the run is retried or routed to another CLI; the helper's identity, branch and history are unchanged. Stopping a helper aborts its process tree and commits what it left to its branch before anything else touches that worktree.

## Durable recovery

Persisted: agents and their states, dependencies, delivered and uncertain reports, pending-report marks, linked CLI sessions, worktree and branch references, per-run snapshots, decisions, tracked CLI process ids. On startup Harbor kills only the leftover CLI processes it recorded and whose live identity still matches, stops agents that were running (error text says Harbor restarted), commits their uncommitted work, prunes dead worktree records, and posts one summary per conversation. Nothing is replayed automatically: a stopped helper is resumed explicitly in its saved session with a prompt that tells it to inspect its worktree and not repeat completed steps (commits, installs, anything with external effects), or it receives a handoff when its CLI session is gone. Pending permission requests and questions are not persisted. Explicitly stopped work stays stopped.

## Task-scoped rollback

Harbor records what each edit run committed on a helper's branch (up to 5 snapshots, with a credential-free patch as evidence) and which merge commit each source produced on an integration branch. A rollback reverses one task's work by reverting those merge commits (newest first) on a new `harbor/rollback-*` branch built from the target's current head; unrelated edits and other tasks are left alone, and your branch is never reset.

1. `previewRollback` is read-only. It lists the merge commits, the files they change, later commits on those files (and which helper made them), dependents (waited for it, used its spec, was created to help it, or later work on the same files), whether the reverts apply cleanly (simulated with `git merge-tree`), blockers (the task or a dependent is still running, an integration for that branch is running) and notes (external effects such as deploys, messages and pushes are not undone).
2. `rollbackTask` re-runs the preview as a gate, then reverts, runs the project checks on the result, and finishes `done` only if everything reverted and the checks pass.
3. You Apply it like an integration (fast-forward only, refused if your folder is dirty or the branch moved). Afterwards the verification of the reverted task, its helpers, dependents and their reviewers is marked outdated.

Limits: only work that arrived through merge commits (those Harbor's integrator made, or older merges that recognizably contain the task's branch) can be reversed; a fast-forward, squash or cherry-pick is reported as unsupported. One rollback per project at a time; a rollback cannot be rolled back; the lead cannot start one; the rollback screen was in progress in the UI.

## Example: add project switching

1. You ask for project switching in a conversation. The concierge sees it is work and escalates (or, because it names a code concept, Harbor escalates without asking it).
2. The lead reads the code. The change is two parts that touch different files, so it delegates: an implementer for the picker UI, another for the persistence behavior, each with the files it owns. It tells you what is running.
3. Harbor creates two worktrees on `harbor/*` branches, starts both helpers (a CLI and model for each, chosen by Harbor), and runs your checks on each branch when it finishes.
4. One implementer hits an unresolved storage question and prints `HARBOR_REQUEST_HELP`. The lead answers it or delegates a read-only investigation. The implementer does not spawn anything.
5. You open the picker helper's conversation and ask it to show the current project more clearly. The message is recorded, the lead learns of it, and the helper handles it after its current step.
6. The helpers report. The lead delegates a reviewer for each (the reviewer sees the diff and the original specification), then an integrator for the approved branches.
7. Harbor merges both branches by pinned commit into `harbor/integrate-*`, runs the checks on the combined result, and the lead tells you it is ready. You review the changes and press Apply; your branch fast-forwards. Later you can preview and roll the task back.

## Superseded from the earlier design

- Superseded: "every project has one main agent that only assigns work and never writes code; every substantive request is delegated, even when small". The lead works directly; delegation is optional.
- Superseded: "all subagents are siblings that communicate directly, coordinate shared files and hand off ownership". There are no helper-to-helper messages. Helpers learn about each other only through the lead. See [Agent collaboration](agent-collaboration.md).
- Superseded: "a planner is delegated estimation and every request has the main agent relay". Planners exist as one optional helper role. Harbor, not an agent, estimates nothing about work size beyond the concierge's complexity guess.
- Superseded: a distinct Tester and Investigator role. They are `other` helpers; independent verification of behavior is Harbor's `.harbor/checks.json` run, not a role.
- Not built: assignment revisions that hold dependent work until acknowledged; idle-worker reuse policy; an application-wide assignment register shown to the user.
