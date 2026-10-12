# Collaboration between agents

Status: implemented, in a different shape from the first design. The first design had sibling agents messaging each other directly and handing file ownership back and forth. That is **superseded**: helpers never message each other. Collaboration now rests on isolation (every edit helper has its own git worktree), a single coordinator (the lead), deterministic integration done by Harbor's own code, and short notes between leads of different conversations of the same project. See [Project agents](project-agents.md) for roles and [Architecture](architecture.md) for the flow.

## Goal

Let several agents work on one repository at the same time without overwriting each other and without a human relaying every detail, while keeping each agent's job narrow and every merge visible and reversible.

## Who can tell whom what

| From | To | Channel |
| --- | --- | --- |
| You | Lead | The conversation composer. |
| You | A helper | The helper's own conversation; recorded as a `direct` coordination entry, shown in the lead's conversation, delivered after the helper's current step, and passed to the lead as a note on its next turn. |
| Lead | Helpers | `HARBOR_DELEGATE` instructions (including the specification, the files it owns, and what to report). A lead cannot interrupt a running helper; it can delegate a retry with the failure pasted in. |
| Helper | Lead | Its final report, `HARBOR_RESULT`, `HARBOR_REQUEST_HELP` (the lead decides) and `HARBOR_ASK` (a question for you). |
| Helper | Helper | **Nothing.** There is no helper-to-helper message, thread or directory of siblings. |
| Lead | Another lead of the same project | One `HARBOR_PEER: {"to","text","urgent"}` line (details below). |
| Harbor | Lead | Notices as turn context: ignored protocol lines, restart summaries, held reports. They are Harbor's own words, never your instruction. |

Anything a helper needs from a sibling's work arrives through the lead: either the lead's instructions, or an upstream report passed in because the helper depends on it (`dependsOn`, `specFrom`).

## Working on shared files

| Situation | Strategy |
| --- | --- |
| Independent files | Helpers run in parallel in separate worktrees. |
| Same file, edit helpers | Each edits in its own worktree and branch, so there is no overwrite while working. The collision shows up at integration as a merge conflict, which the integrator records, aborts and reports; you or a new helper resolve it on the source branch. |
| Several helpers need a shared interface | The lead puts the contract in each instruction, or has a planner write the specification first and passes it to both as `specFrom` / `dependsOn`. |
| The project folder is not a git repository with commits | Helpers cannot get a worktree, so they edit the folder directly under whole-file ownership: Harbor's lock table grants a helper its declared files (or the whole project when it declared none) all-or-nothing, and a second helper wanting an overlapping file waits. When it waits, Harbor asks you whether to allow parallel editing anyway (a permission request of kind `conflict`). Locks are released only when the owner's process has ended, never by timeout. |
| Edits outside a helper's declared files | Detected after the run from the branch diff; recorded as a `conflict` coordination entry, posted, and flagged in the report as needing coordination before integration. |
| The lead and a helper on the same files | The lead is told not to edit files its helpers own while they run; it works in the project folder while helpers work in worktrees, so the collision is again a merge conflict later. |

The initial design's whole-file ownership in a shared workspace survives only for the no-git case. Worktrees replaced it for normal projects.

## Landing work: integration

Integration is the deliberate combination of helper work, and it is code, not an agent.

1. The lead asks for an integrator naming its sources (`HARBOR_DELEGATE {"role":"integrator","sources":[...],"target"?}`), or you start one through the API. It waits for the sources and the reviewers of those sources.
2. **Gate.** For every source, before any git write: an existing `harbor/*` branch; a reviewer whose `testedCommit` is the branch's current head and whose verdict is approve and not outdated; no reviewer asking for changes on that head. Any failure refuses the whole integration with the reasons ("Refused: ...").
3. **Merge.** Harbor pins each source's head, creates `harbor/integrate-<target>-<id>` from the target's head in its own worktree, and merges the pinned commits with `--no-ff` in dependency order. Sources already contained are skipped, so a re-run is safe. A conflict is recorded with its paths, the merge is aborted, and the run stops; earlier merges stay on the integration branch. If the target moved since the last run, the integration branch is rebuilt from the new head.
4. **Checks** from `.harbor/checks.json` run on the combined result (if you approved that file). The integration is `done` only if everything merged and the checks passed.
5. **Apply** is yours. It fast-forwards the target branch only if the integration is done, the project folder has no uncommitted changes, the target has not moved, and the target is not checked out in another worktree. Harbor never pushes, forces or resets. After applying, worktree folders of the landed work are eventually cleaned up; the branches stay.

If the lead merges a helper branch itself despite the rule, Harbor checks after the turn whether a helper branch became reachable from your branch and warns. It works for every CLI; it detects and does not prevent. Changes under `.harbor/` made by a helper are flagged at the helper's report and again at integration, because they change what Harbor runs.

## Leads of different conversations

Conversations of one project can run at once, each with its own lead, in the same folder.

- Only one lead turn edits the project folder at a time; the others wait, shown as queued with the name of the session they wait for. A read-only plan-mode lead does not wait.
- Each lead prompt lists the other running sessions of its project, from Harbor's own records: id, title, state, the latest user request as its goal, and the helper branches it has. A lead is told not to touch what they are changing.
- A lead can send another lead one `HARBOR_PEER` line, sparingly, only for something the other cannot otherwise know (a shared interface changed, a file is now yours). The target is matched by id, id prefix, exact title or a unique title fragment; an ambiguous target is not delivered. Messages are queued for the target's next turn; only an `urgent` one wakes an idle lead, at most twice between that session's user messages, because waking costs quota. At most 3 per turn, 600 characters each. The text is information, never an instruction from you. Each peer message is shown in both conversations and recorded as a `peer` coordination entry.
- Helpers cannot send peer messages, and a lead should not reply to one unless the reply changes what the other session does.

## Shared agreements and context

- The lead's `HARBOR_DECISION` lines (what you settled that must survive a lost session) are stored as `decision` coordination entries, scoped to the conversation, at most 3 per turn. They are given back to a lead whose native session cannot be resumed, framed as the lead's notes of what you said, with your current message winning.
- Your direct messages, help requests, file conflicts and your answers to conflict questions are also coordination entries, visible as system messages in the relevant conversations.
- A conversational suggestion between agents is not an agreement; only what you say, or what the lead records and you can read, carries over.

## Efficient teamwork

- A helper's final message is its report; earlier messages are not forwarded. Reports are clipped before they reach the lead, and identical delegations in one turn run once.
- The lead is woken only when a planner finishes, a helper fails, or no helper of the conversation is still active; reports of everything finished ride along in one turn. Helper and help-request wake-ups count toward the automatic-turn cap (12 per user message); peer wake-ups have their own limit.
- Independent helpers keep running while another waits for a dependency; only the dependent one waits.
- Stalled helpers are flagged after 10 minutes without output and stopped at 45 minutes (resumable).

## Usage

Every wake-up of a lead, every helper session and every integrator check is a real cost. Peer notes and reports are kept short for that reason. See [Limitations](limitations.md) for the estimated multiplier.

## Superseded from the earlier design

- Superseded: direct messages and small shared threads between sibling agents, an assignment directory siblings can search, delivery and acknowledgement tracking of peer messages, and discussion between helpers.
- Superseded: ownership handoff between agents (request, acknowledgement, safe handoff point, release). Worktrees and integration replace it. Only the no-git case keeps locks, and a lock is never transferred by agreement.
- Superseded: the main agent "monitoring all collaboration threads". There are none.
- Not built: pausing dependent work until a changed contract is acknowledged by affected workers.

## Acceptance criteria (as implemented)

- Edit helpers never write the same checkout; conflicts surface at integration, deterministically, with the paths.
- Only approved, current work can be merged, by pinned commit; your branch moves only on your Apply, fast-forward only.
- Helpers cannot create agents or message each other; leads of the same project can exchange bounded notes.
- A second lead in the same folder waits rather than editing at the same time.
- Overlap in a folder without git is serialized by file ownership, and edits outside a claim are flagged.
