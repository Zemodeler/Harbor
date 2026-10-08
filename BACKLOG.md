# BACKLOG

Prioritized next tasks so Harbor's own agents (or people) can pick them up. Each item is one bounded responsibility. Ownership follows `AGENTS.md`. Size: S ≤ 1 hour, M ≤ half a day, L = needs a planner first.

## Core (src/main, src/shared, src/preload, tests)

### P0 — make the self-host loop trustworthy
1. **Verify the Codex adapter on a real install** (S). `adapters/codex.ts` flags and JSONL event shapes are from public docs, not verified here. Run `npm run smoke -- codex --full`, fix `codexArgs` / `parseCodexLine`, confirm resume (`codex exec resume`), effort (`-c model_reasoning_effort`), read-only sandbox, and that stdin `-` works. Update the file header from "NOT VERIFIED" to the verified version.
2. **Run `npm run smoke -- claude --full` signed in** (S). The first full run was never executed (no signed-in CLI in the dev environment). Fix whatever it reveals; add a regression test with a recorded transcript fixture.
3. **Auth-failure handling** (S). When a run fails with "Not logged in" (see `parseClaudeLine`), mark that CLI `authState: signedOut`, emit a `cli` event, and exclude it from routing until `refreshClis()`. Today it only falls back for that task.
4. **Integration of finished branches** (L, planner first). Subagents leave work on `harbor/<slug>` branches. Add an `integrator` flow: assign an integrator agent that merges approved branches into a target branch in its own worktree and reports conflicts. The main agent must never merge. Needs new contract methods (`getChanges(agentId)`, `mergeBranch`) — coordinate with UI.
5. **Streaming deltas** (M). Use `--include-partial-messages` for Claude (and codex equivalents) so `messageDelta` carries tokens, not whole turns.

### P1 — spec coverage
6. **Interactive tool permissions** (L). Headless runs cannot prompt, so non-allowlisted tools are denied. Implement the `permission` kind `tool` via Claude's `--permission-prompt-tool` / stream-json control channel; remember "always allow" per project.
7. **Queue controls** (M). Priority, "do this next", pause/resume/cancel of queued assignments across projects (`docs/background-routing.md`). Needs contract additions (`setAgentPriority`, `pauseAgent`, `resumeAgent`).
8. **Interactive headroom** (M). Reserve one concurrency slot and allowance for user-facing replies; checkpoint/pause background work when the user messages and capacity is tight.
9. **Settings that the docs promise** (M): allowed models, role preferences, effort policy (adaptive / conserve / quality), low-allowance policy, concurrency limit, subscription reserve, per-project overrides. Store them in `Settings` as optional fields (changelog!).
10. **Real allowance signals** (L, investigate). `usage.ts` counts Harbor runs only and assumes a 5h/40-run budget. Find supported ways to read Claude/Codex limits (CLI status commands, rate-limit headers in stream output) and add a `reported` form beside `estimated`; keep unknown as unknown.
11. **Dependency-aware reuse of idle workers** (M). Main agent can reuse a finished compatible agent for follow-ups (resume its session) instead of creating a new one.
12. **Recovery depth** (M). On restart, `recover()` only marks working agents stopped. Add: detect and kill orphaned CLI processes, offer "resume from session" per agent, never replay completed external actions.
13. **Task-scoped rollback** (L). Record per-task baseline and patch (`git diff base..HEAD`), implement preview + selective reversal on the integration branch (`docs/project-agents.md`).
14. **Verification tied to versions** (M). Reviewer/tester reports must record the exact commit tested; mark checks outdated when a branch moves. Store `testedCommit` on reports and compare with branch head.
15. **Instruction changes mid-run** (M). Revision bump currently only counts direct prompts. Implement the hold/ack protocol: pause dependents, notify affected siblings, resume after acknowledgement.

### P2 — breadth
16. **Gemini adapter** (M): headless flags, status check, models. Until then it is detected but never assigned work.
17. **Terminal adapter for other CLIs** (L): baseline adapter with labeled limitations.
18. **Skills and plugins discovery** (L): list native Claude/Codex extensions per scope and expose compatibility states.
19. **API fallback** (L): key storage (OS credential store), ask-before-use, hard per-task/per-period limits.
20. **Storage**: split messages per conversation file or move to SQLite when `state.json` grows; add pagination to `listMessages`.
21. **Archive conversations**, history search.
22. **`CLAUDE.md` containing `@AGENTS.md`** (S) so Claude Code subagents read these rules automatically (Codex already reads `AGENTS.md`). Not done because it was outside the original ownership list.
23. **Tray / background-on-close preference** (UI + main).

## UI requests (src/renderer — owned by the UI engineer)

Behavior the core already provides that the UI should surface or respect:

1. **Add project**: call `addProject()` with no argument; the main process shows the native folder dialog and returns `null` on cancel.
2. **`CliStatus.authState`** (added in contract 0.1.1): show "Installed — login required" only for `signedOut`; show "status unknown" for `unknown`. `signedIn` is false in both. Use `openLogin(id)` for the sign-in button (opens a visible terminal; Windows only).
3. **`listConversations(projectId)`** returns only main-agent conversations. Subagent chats open via `openAgentConversation(agentId)`; `listAgents(projectId)` includes the `main` agent (filter by role) and sets `parentId` on subagents.
4. **Messages**: `role: 'system'` carries coordination activity (assignments, "Plan: ...", finished/failed lines, sibling messages starting with `[sibling]`). `role: 'tool'` is tool activity in subagent conversations. Assistant messages from Harbor's routing carry `details` (cli, model, effort, reason) for the execution-details view.
5. **Streaming**: subagent transcripts arrive as one `message` event then `messageDelta` events appending `"\n\n" + text`. The main agent's reply is a single `message` (not streamed).
6. **Permission events**: handle `kind: 'conflict'` (two agents want the same file; Allow = proceed in parallel in separate worktrees, Deny = wait) and `kind: 'freeReset'` (never auto-answer). Call `answerPermission(requestId, allow)`. Pending requests are in-memory: after an app restart they are gone and the waiting agent stays queued.
7. **Usage**: `getUsage()` percentages are Harbor-observed estimates (label says so; `freeResetAvailable` is only set when a supported entitlement source exists, currently never). Do not present them as provider quota; show the label and `resetsAt` honestly.
8. **Agent states**: `queued` also means "waiting for a dependency, file, or free slot" (the reason is in `Agent.summary` while the agent is queued, waiting, failed or stopped); `waiting` means blocked on a sibling requested via the main agent.
9. **Stop**: `stopAgent(mainAgentId)` stops every running subagent of that project; `stopAgent(subagentId)` stops one.
10. **Change review**: a `harbor/<slug>` branch and worktree path are on `Agent.worktree`; there is no diff API yet (core backlog item 4).
11. Take `gpt/ui`'s version of `src/renderer/**` wholesale when merging; `claude/core` ships only a 2-file placeholder there.
