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
10. **Real allowance signals** (M, partly done). Codex limits are read from `~/.codex/sessions` (`codexLimits.ts`) and Claude's from `rate_limit_event` in its stream (persisted on usage events); `usage.ts` prefers them (`source: 'reported'`) and falls back to the 5h/40-run and weekly/300-run estimates. Remaining: Claude limits are only seen when Harbor itself runs Claude (no status command is read), so they can be stale; other CLIs have none.
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
22. ~~**`CLAUDE.md` containing `@AGENTS.md`**~~ Done (branch `harbor/self-improve-2`).
23. **Tray / background-on-close preference** (UI + main).

## Lead rework (concierge + lead) — what is done and what is next

Done (branch `claude/lead-rework`): every prompt goes to a cheap concierge that answers or escalates; an escalation starts a lead working session (resumed per conversation) that delegates with `HARBOR_DELEGATE` lines; routing uses the editable capability catalog (`clis/capabilities.ts`, `capabilities.json`); image requests produce a paste-ready brief; sibling messaging is removed. Verified with fake CLIs (`npm test`) and `npm run smoke -- claude --full` on a real Claude install. NOT verified: Codex as concierge/lead (adapter unverified, see P0 #1), multi-helper delegation with a real model, and merging helper branches by the lead.

Next:
- **Delta streaming for the lead** (M): backlog P0 #5; lead text currently arrives per CLI message, not per token.
- **Interactive tool permissions for the lead** (L): P1 #6. The lead runs with `acceptEdits` and the allowlist in `adapters/claude.ts`; anything else is denied silently.
- **Codex model ids** (S): fill `DEFAULT_CATALOG` with verified Codex models and tiers once P0 #1 is done.
- **Concierge quality** (S): the `needsWorkspace` guard overrides front-desk answers to workspace requests, and guarded answers, unparseable replies and "/deep after an answer" are journaled. Use `/journal` to see whether the guard is too broad or too narrow. Consider a per-conversation "always use lead" toggle.
- **Self-improvement follow-ups** (from `harbor/self-improve-2`):
  - Check runs are not surfaced in the UI. `AgentRecord.checks` / `testedCommit` are main-process only; exposing them needs optional `Agent` fields (contract change + UI request).
  - Checks run sequentially with a 15-minute timeout per command and hold the helper's concurrency slot meanwhile. Consider a separate check queue if builds get slow.
  - The worktree's `node_modules` junction is only created when `node_modules` is git-ignored. Projects without it need a setup command before checks (`.harbor/checks.json` could gain `"setup"`).
  - A running conversation summary for the lead was not added: the head+tail history clipping covers the observed loss. Revisit if resumed sessions break often.
  - Concierge session reuse (prompt caching) was not done. It needs measurement with a real CLI first.
- **Doc reconcile** (product owner): README and `docs/*` still describe the old planner/implementer pipeline and sibling messaging.

## UI requests (src/renderer — owned by the UI engineer)

Behavior the core already provides that the UI should surface or respect:

1. **Add project**: call `addProject()` with no argument; the main process shows the native folder dialog and returns `null` on cancel.
2. **`CliStatus.authState`** (added in contract 0.1.1): show "Installed — login required" only for `signedOut`; show "status unknown" for `unknown`. `signedIn` is false in both. Use `openLogin(id)` for the sign-in button (opens a visible terminal; Windows only).
3. **`listConversations(projectId)`** returns only main-agent conversations. Subagent chats open via `openAgentConversation(agentId)`; `listAgents(projectId)` includes the `main` agent (filter by role) and sets `parentId` on subagents.
4. **Messages**: `role: 'system'` carries coordination activity (assignments, "Plan: ...", finished/failed lines, sibling messages starting with `[sibling]`). `role: 'tool'` is tool activity in subagent conversations. Assistant messages from Harbor's routing carry `details` (cli, model, effort, reason) for the execution-details view.
4a. **Lead rework**: the main conversation now shows the lead's own streamed work: assistant messages carry `details` (cli, model, effort, reason) for the concierge and the lead, `role: 'tool'` messages appear in the main conversation, `system` lines start with `Delegated:`, and image requests arrive as an assistant message with markdown (a fenced ```text block) the UI should render with a Copy button. Type `/deep <message>` to skip the concierge and use a strong lead. Sibling `[sibling]` messages no longer exist.
5. **Streaming**: subagent transcripts arrive as one `message` event then `messageDelta` events appending `"\n\n" + text`. The main agent's reply is a single `message` (not streamed).
6. **Permission events**: handle `kind: 'conflict'` (two agents want the same file; Allow = proceed in parallel in separate worktrees, Deny = wait) and `kind: 'freeReset'` (never auto-answer). Call `answerPermission(requestId, allow)`. Pending requests are in-memory: after an app restart they are gone and the waiting agent stays queued.
7. **Usage**: `getUsage()` percentages are Harbor-observed estimates (label says so; `freeResetAvailable` is only set when a supported entitlement source exists, currently never). Do not present them as provider quota; show the label and `resetsAt` honestly.
8. **Agent states**: `queued` also means "waiting for a dependency, file, or free slot" (the reason is in `Agent.summary` while the agent is queued, waiting, failed or stopped); `waiting` means blocked on a sibling requested via the main agent.
9. **Stop**: `stopAgent(mainAgentId)` stops every running subagent of that project; `stopAgent(subagentId)` stops one.
10. **Change review**: a `harbor/<slug>` branch and worktree path are on `Agent.worktree`; there is no diff API yet (core backlog item 4).
11. Take `gpt/ui`'s version of `src/renderer/**` wholesale when merging; `claude/core` ships only a 2-file placeholder there.

## API requests (from UI)

- Add assignment/conversation ownership to Agent (or a conversation-scoped listAgents API). The current contract identifies parent agents but cannot distinguish assignments belonging to different main-agent conversations in one project. The UI currently shows all children of the selected main agent.
- Expose pending permissions for recovery and initial load. Event-only permissions cannot be recovered by a renderer reload; the engine must replay pending requests after subscribing or provide listPendingPermissions.
- Provide conversation overrides/manual CLI selection, extensions discovery, project history/archiving, task status/verification, changed files and exact diffs, workspace panels, and queue controls before exposing those actions. The first UI implements the supplied contract and does not fabricate these capabilities.
- Usage source, freshness, unknown readings, and entitlement details need typed fields. The UI shows each supplied window separately; absent windows/reset times stay unknown.
- Main-process integration: set `app.setAppUserModelId('com.harbor.desktop')` on Windows; set the BrowserWindow icon from `build/icon.ico` during development and `process.resourcesPath/icon.ico` after packaging. Retain native window controls. Do not change the renderer to implement desktop window controls.

## Integration notes (from UI)

- UI implementation is on `gpt/ui`. The core scaffold arrived directly in the shared checkout while UI work was underway. Core-owned files were read but not edited. Root package changes add only UI and installer scripts; existing main scripts are preserved.
- Installer tooling is isolated in `build/package.json`; install it with `npm install --prefix build`. `npm run dist` builds the app then runs unsigned NSIS packaging without publishing.

## Found by the real Codex smoke run (codex-cli 0.160.0)
- P0: Codex `workspace-write` sandbox cannot write the worktree's git metadata (`<repo>/.git/worktrees/<name>`), so implementers cannot commit themselves (the checkpoint commit by Harbor rescues it). Pass that dir via `-c sandbox_workspace_write.writable_roots=[...]` (needs a writable-dirs field on RunOptions).
- P1: Reviewer did not receive the implementer's original specification; reviewer then spawned a "recover spec" agent. Include the spec verbatim in the reviewer assignment.
- P1: Peer messages addressed by agent id ("no unique sibling matches <uuid>") are not delivered; accept ids as well as titles.
