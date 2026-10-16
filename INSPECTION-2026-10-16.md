# Harbor inspection, 2026-10-16

Scope: the whole repository at commit cf3a044 plus the uncommitted working tree, the renderer clicked through in the browser (mock API, `npm run dev` was already serving it), and the real data folder (`%APPDATA%\Harbor`: `state.json`, `journal.jsonl`) for evidence of how the app behaves in actual use. Checks run: `npm test` 1409/1409, `npm run test:renderer` 231/231, `npm run typecheck` clean, `npm run build` passes. Three parallel code audits (main process, renderer, docs-versus-code) were run and every finding quoted below was re-checked in the source by hand. Line numbers are from the current working tree.

Verdict in one paragraph: the engine is far more complete than most projects at this stage, the tests are real, and the docs are unusually honest. The problems are concentrated in four places. (1) The uncommitted change that makes `auto` the default mode removes the safety story the docs and UI still describe, and auto mode is weaker than the docs say. (2) The integrate, review, apply loop that the README presents as the way work lands has never completed in real use: 15 integrators ran, 9 failed, 0 were applied, 0 rollbacks. (3) Permission prompts do not fit how Claude Code actually issues commands, which is why the owner keeps turning auto on. (4) The renderer has a handful of real bugs (an invisible primary button on hover, steer dropping attachments, a redundant local message queue) and about a third of the contract has no UI.

---

## 1. The ten things that matter most

1. **Auto mode is now the default and it is less safe than documented.** Uncommitted: `src/main/index.ts:128` passes `defaultMode: 'auto'`, `orchestrator.ts:795` turns a plan-mode go-ahead into `auto`, and `prompts.ts:182` tells the lead to ask "ONLY when you cannot proceed". README, `docs/safety.md:98-103`, `ModePicker.tsx:7` and the UI's auto-mode confirmation all still say `default` asks first. Worse, in auto mode Claude edit helpers get **no deny rules at all**: `adapters/claude.ts:81` returns `[]` unless `permission === 'edit'` or `denyGitWrites`, and helpers never get `denyGitWrites` (`orchestrator.ts:2112-2128`). An implementer in an auto conversation runs `bypassPermissions` with `git push --force`, `git branch -D`, `git clean`, `git -C` all allowed, and the worktree confinement is gone too (bypass lifts the cwd boundary; Codex gets `danger-full-access`). The file header's "in full mode deny rules still apply" is false for helpers.
2. **The landing loop never lands.** Real state: 15 integrators, 4 done, 9 failed, 2 stopped, **0 applied**, 0 rollbacks. Journal: the same "approval is outdated (branch moved since the review)" refusal four times in a row, "has no approving review" three more times. Every fix commit invalidates the approval, Harbor schedules no re-review itself, the lead re-delegates integration and gets refused again. Apply additionally needs a clean project folder and an unmoved target, which the lead (editing the same folder) rarely leaves. The headline feature is effectively a dead end today.
3. **Permission rules cannot match real commands.** `store.ts:846` `SHELL_META` refuses "always allow" for any command containing `&&`, `;` or `|`; prefix matching is on the first word only. Claude Code issues almost everything as `cd <dir> && <cmd>`. Journal: 213 permission entries in a week, "The lead agent asks to run Bash: cd /c/Users/..." 11 times, "No answer within N minutes: denied Bash" 4 times (work silently killed while the owner was away), "Auto mode was turned on" 12 times. The owner's answer was to default to auto; the right answer is rules that fit the commands.
4. **Stop on an idle lead kills every helper in the project.** `orchestrator.ts:876-882`: when no lead turn is running, `stop(mainId)` stops every non-main agent of the project, including other conversations' running implementers.
5. **A helper waiting on a question is stranded by a restart.** `recover()` (`orchestrator.ts:671-689`) only converts `working` agents. A `waiting` helper keeps its state while the in-memory question and its 10-minute default timer are gone; `helpersActive()` stays true, the lead is never woken, goal mode never continues.
6. **The lead's replies to helpers are unreliable.** `deliverReply` (`orchestrator.ts:1573`) refuses when the helper is `done`/`failed`; the lead tried exactly that to answer a secret-scan finding and got "Harbor did not deliver the lead's reply" (6 times in state), plus one `HARBOR_REPLY` dropped for a malformed line. "Harbor cannot tell whether the lead received N helper report(s)" appears 6 times. The protocol works in tests and leaks in practice.
7. **Primary buttons become unreadable on hover (dark themes).** Global `button:hover:not(:disabled) { background: var(--wash) }` (`Harbor.module.css`) overrides `.fxPrimary`/`.primary` backgrounds while their text stays `--on-accent` (dark). Measured: "Enable Auto mode" renders `rgb(8,33,52)` on `rgb(25,60,80)`. This hits every primary action: Save path, Integrate, Apply, Remove CLI, Export diagnostics.
8. **`state.json` is 6.6 MB after one week and is rewritten whole every 150 ms while streaming.** 6771 messages (4928 of them tool lines), 2 MB of routing `details` on 1239 assistant messages, `coordination` never pruned, `sessions` and finished `agents` never pruned (`store.ts:504`, flush at `store.ts:221-239`). Twelve "could not save its state (EPERM)" entries in one second show the rename already failing under load.
9. **The renderer keeps its own message queue that main already provides.** `Conversation.tsx:218-220` holds a message sent while busy in localStorage and releases it only when the UI thinks the session is idle, gated on `state.permissions.length` across all projects; main's `userMessage` (`orchestrator.ts:816`) already queues turns server-side. Queued messages are lost to other devices and marked paused on every restart. "Send now" (steer) also sends `undefined` attachments and leaves images in the composer (`Conversation.tsx:201-210`).
10. **About a third of the contract has no UI.** Spend ceilings, secret allowlist, project notes, task cost report, ratings, routing replay, remote access and tokens, `getGitLogPage`, paged `listMessages`: all in `api.ts`, none in `src/renderer`. Meanwhile two settings that do nothing are shown as if they worked: Routing "Manual" (`src/main` never reads it) and "Optional free resets" (no reset source exists).

---

## 2. Says it does, but does not (claims versus code)

| Claim | Where | Reality |
|---|---|---|
| Lead is denied `git push` | `docs/safety.md:98` | `adapters/claude.ts:77,83`: `Bash(git *)` allowlisted, only `--force`/`--delete` pushes denied; `prompts.ts:180` permits a plain push "when the user asks". `orchestrator.ts:348` comment still says push is forbidden |
| `default` mode is the normal mode; a go-ahead returns to default | README:25, safety.md, `ModePicker.tsx:7`, BACKLOG:162 | Uncommitted diff makes `auto` the default and the go-ahead target (headless keeps `default`, so the two front ends disagree on the same data folder) |
| Auto mode keeps the deny rules | `claude.ts:34` header, safety.md:103 | Helpers: none (item 1). Lead: `GIT_WRITE_DENY` only because `denyGitWrites` is set for leads |
| Helper changes reach your branch only through review, checks and Apply | safety.md threat table | True for `edit` runs; in auto mode the helper can write anywhere, and `detectLeadMerge` only watches the lead |
| Harbor never deletes a branch | README:46, architecture.md:64 | `git.ts:139` and `git.ts:436` run `git branch -D` on `harbor/*` (production only reaches the first, after a failed `worktree add`). Capability exists; docs say it does not |
| Codex lead: Harbor warns after a merge or push | safety.md:107 | `detectLeadMerge` catches merges; nothing detects a push |
| Every push to main that passes tests publishes | README:48 | CI (`release.yml:31`, `ci.yml:18`) runs only the root suite; the 231 renderer tests never run in CI, `src/renderer` is never installed there |
| Unanswered helper question is answered "no" after 10 minutes | architecture.md:28 | Not after a restart (item 5); and for `repeat`/`lead` kinds the default is "most conservative option", not "no" |
| Every screenshot needs your yes | README:28, safety.md:92 | `answerScreenshot({ forConversation: true })` lets later window captures in that conversation go without asking (`screenshots.ts:191-210`) |
| Spend ceilings "planned, not built"; eval harness "not yet"; remote API "Phase 5"; deadline picker "not built"; contract "0.1.37" | safety.md:119, README:68, limitations.md:73,128, README:11 | All built; contract is 0.1.44. Docs are stale the other way |
| Updater never restarts while agents run | README:46 | `isBusy` counts `working` and `queued` only; a `waiting` agent allows the prompt. Conversely a helper queued "waiting for a restart-stopped sibling" blocks updates forever (`index.ts:287`) |
| Markdown: no tables, no italics | `src/renderer/README.md` | Both implemented. What is missing: links (shown as literal `[text](url)`), heading levels (all `<h3>`, `Markdown.tsx:192`), `+` bullets, task lists, rules, escapes |
| Messages sent mid-turn are queued by Harbor | `api.ts` `send` comment | Main does queue; the renderer queues again on its own (item 9) |

---

## 3. Engine bugs (verified in source)

- **Send validation contradiction.** `ipcValidate.ts:22` rejects more than 6 attachments as "at most 6 images" while `service.ts:196` allows 10 files. Attaching 7 text files fails with a wrong message.
- **Archive and delete are blocked by unrelated pending asks.** `service.ts:713,798` test the global `pending.size` (conflict and free-reset map), so an open conflict question in project A prevents archiving a finished conversation in project B.
- **Stop does not drop chained lead turns.** `stop()` aborts the running lead but never bumps `sessionGeneration` (only `stopConversation` and `interruptLead` do), so a report or goal turn already in `mainChain` starts right after the abort and spends quota.
- **"Paused automatic coordination" system message repeats** once per caller past the 12-turn cap (`orchestrator.ts:1061-1069`, six call sites).
- **Held-for-quota helpers re-post their whole "Assignment" message** on every 10-minute release (`holdRun` 2082-2099 re-enters `runAgent`).
- **Desktop notifications fire on cosmetic updates.** `index.ts:252-256` notifies on any `conversation` event with a `done`/`failed` activity; rename, pin and deadline changes emit such events.
- **Synthetic "auto mode turned on" turn strips the real last user message from the handoff history** (`modeChanged` 862-866 then `chatHistory(id, true)` at 1240). Only matters when the native session cannot resume.
- **Flush uses `Atomics.wait` on the main thread** (`store.ts:42-44,244`) on write failure: 40/80/120 ms synchronous sleeps in the Electron main process, right where the EPERM burst happened.
- **Caps are additive.** Goal continuations (8) and automatic turns (12) are separate counters; worst case is 20 unattended lead turns per user message, not documented.
- **Queued helpers auto-start at launch** (`recover()` pumps every project) while `startupGit` is still pruning worktrees; the docs promise only that working agents stop.
- **Peer wake misjudges idleness** (`deliverPeer` 1150: a turn queued in `mainChain` is not in `leads`), so an urgent note can add a redundant wake turn.
- **`setConversationMode` has no `validateInvoke` case**; `goal` is clipped only after `.trim()`, so a multi-megabyte goal over the remote `full` scope is accepted.
- **Remote `full` scope can switch a conversation to auto** (`remote/scopes.ts`), which after item 1 means unattended bypass runs started from the network. Policy question rather than a bug, but it should be an explicit decision.

---

## 4. What real use shows (data folder, one week)

- 106 agents, 25 reviewers (9 approve, 11 changes requested, 5 no verdict), 43 implementers done, 9 integrators failed, 0 applies.
- "Interrupted to follow your new message" 11 times: steering is used a lot and works.
- "Allowed Bash once" 31 times, "asked to run Bash: cd /c/Users/..." 11 times, denied by timeout 4 times.
- "Main agent: no output for 10 minutes (possibly stuck)" 3 times with no automatic action.
- "Harbor could not save its state" 12 times in one second.
- Secret scan flagged two test files (`test/moodle.test.ts:12`, `test/gcal-client.test.ts:70`) as secrets; both blocked integration; the lead could not resolve it (reply to a done helper refused).
- One lead protocol line ignored for format, one lead merge-in-place detected. The nonce tag is otherwise honoured by real models, which the docs list as unverified.

---

## 5. UI: bugs and awkward places (mock renderer, clicked through)

Bugs

- Primary buttons unreadable on hover in dark palettes (item 7). Reproduced on the Auto-mode confirmation.
- Steer sends without attachments and keeps the images in the composer, silently.
- Autoscroll does not follow your own message when you had scrolled up; there is no "jump to latest" affordance (`Conversation.tsx:93-109`).
- Question cards have no height limit and permission cards take up to 40 vh (`App.tsx:185`, `PermissionRequests.module.css:2`): three helper questions plus two tool prompts push the composer off a 768 px screen, and the composer is the documented fallback.
- After a renderer reload, pending permissions are recovered but pending **questions** are not (no `listPendingQuestions` in the contract): the header says "Needs input" with no card anywhere. In the mock today the "Needs input" badge is not even clickable.
- Modals stack: Ctrl+K and Ctrl+Shift+F open over Rename, Tags, Onboarding and Project settings; Ctrl+N fires behind them (`App.tsx:141-147,204-205`). The rollback dialog nests inside the session-details modal on narrow windows and the outer Tab trap sees the inner dialog's Tab.
- Deleting a conversation selects `rest[0]`, which may be an archived one (`useHarbor.ts:275`).
- Dark theme chosen in Settings (not the OS) misses the code-token colours and Git lane colours, which are only swapped under the `prefers-color-scheme` media query (`Documents.module.css:35-38`, `GitPanel.tsx:12`).
- Send errors show twice with different texts: the real reason in the page banner with a "Reload workspace" button, and a fixed "Retry when the connection is ready" under the composer (`useHarbor.ts:323-331`, `Conversation.tsx:208,227`).
- Fenced code in chat has no line clip (tool output clips at 400, the viewer at 3000); a pasted 20k-line log renders in full (`Markdown.tsx:204-206`).
- Every state change re-renders the whole tree because `useHarbor` returns fresh closures; during streaming Sidebar, MissionBoard, LiveActivity and PermissionRequests re-render per animation frame. Per-message cost is bounded (MessageView is memoised), the shell is not.
- Hard-coded panel widths: at the 1180 px "wide" threshold the document pane (min 360 px), info panel (300 px), sidebar (276 px) and conversation can all be docked, leaving roughly 130 px for the conversation column.

Awkward

- Five names for one thing on one screen: "Main agent" (header, composer), "Lead agent" (live activity), "Subagents" (crew section), "helpers" (summary, Mission Board), "agents" (header count). Header says "0 agents active, 9 helpers" while Live activity says "Agents 10". Five different stop labels ("Stop", "Stop agent", "Stop this agent", "Stop session", "Stop this session"). The concierge, the first thing that answers, is never named in the UI.
- A queued helper card shows both a "Stop" button and a "Cancel" button that do the same thing.
- The Project settings tab repeats its own intro sentence ("Fields left on Inherit global..." then "Anything left on Inherit global...").
- Usage tab lists windows per CLI and period interleaved (Codex 5h, Claude weekly, Codex weekly, Claude 5h) instead of grouped per provider, and the text admits the pool state is not shown.
- "Keep Harbor running in the background" lives under the Routing tab.
- Routing "Manual" and "Optional free resets" are presented as working choices.
- Integrate and Rollback dialogs ask for the target branch as free text although `getGitOverview` has the list.
- "Why this model?" appears twice in the session panel (a hard-coded Haiku sentence, then the routed summary).
- Markdown links are shown with their brackets; a `[docs](url)` from a model looks broken.
- Empty project state still shows "Harbor / Main agent", "Ready" and a Git button with nothing to open.
- Three workspace modes and ten colour palettes are a lot of chrome for a one-user tool and double the surface every UI change has to be checked on.
- Accessibility: new assistant messages are not announced (no `role="log"`/`aria-live` on the stream), the mode picker uses `role="radio"` buttons without arrow keys, `Modal.tsx:13` focuses a dialog with no `tabindex` (no-op).

---

## 6. Biggest missing features

1. **A re-review loop that converges.** After a reviewer asks for changes and the fix lands, Harbor should schedule the re-review itself (same reviewer session, diff since the reviewed commit) and the integrator should accept "approved at X, only commits by the fix helper since". Without it, item 2 stays dead.
2. **Permission rules that match reality.** Treat `cd <path inside project or worktree> && <cmd>` as `<cmd>`; allow rules by command pattern (`npm run *`, `npx vitest *`) like Claude Code's own `Bash(npm run:*)`; pass project rules through `--allowedTools` so the CLI does not even ask; and a per-conversation "allow everything for the next N minutes" instead of a permanent auto flip.
3. **A real "needs input" inbox.** One list of every open question, permission, screenshot and conflict across projects, clickable from the header badge and recoverable after a reload (`listPendingQuestions`, `expiresAt` on questions).
4. **Cost and time per conversation** in the UI (`getTaskReport` exists), with a budget panel per pool (the router already computes spend/neutral/conserve/protect).
5. **Storage that scales.** Messages per conversation file or SQLite, tool lines stored once per agent run rather than as messages, routing `details` stored once per decision and referenced, pruning of `coordination`, `sessions`, finished agents, and a size warning in Diagnostics.
6. **Secret-scan allowlisting from the UI**, including "this is a test fixture" from the integrator's failure card, so a false positive does not need the lead.
7. **Decisions and notes UI.** `HARBOR_DECISION` and `HARBOR_NOTE` are stored and injected into prompts but invisible and uneditable.
8. **Remote access settings and tokens** (contract 0.1.41) and spend ceilings (0.1.38) in Settings; both exist in main only.
9. **Paging** of messages and git log in the renderer (`getGitLogPage`, `listMessages` opts).
10. **Streaming per token** (`--include-partial-messages`), still per CLI message today.
11. **Conversation fork** and **cross-project queue view** (both named in BACKLOG, neither started).
12. **Gemini adapter**, or remove Gemini from discovery output until one exists, so the Connections tab stops showing a CLI Harbor cannot use.

---

## 7. Suggested fixes, in order

P0, this week, mostly small

1. Decide the mode default consciously. Either revert `defaultMode: 'auto'` and the plan go-ahead change, or keep them and (a) make `claudeDenyRules` return `GIT_DESTRUCTIVE_DENY` for every edit-capable run regardless of permission mode, (b) keep `denyGitWrites` for helpers too, (c) keep Codex helpers on `workspace-write` plus `writable_roots` in auto mode, (d) update README, `docs/safety.md`, `ModePicker.tsx` text and BACKLOG:141/162, (e) pass the same default to headless. The prompt wording ("ask ONLY when you cannot proceed") is fine to keep if the gate above holds.
2. Permission matching: strip a leading `cd <inside project> &&`, add command-pattern rules, and forward stored rules to Claude as `--allowedTools`. Expect the 213 prompts per week to drop by most of that.
3. `stop(mainId)` with no running lead: stop only helpers of the conversation the user is looking at (pass `conversationId` from the renderer; the method already exists as `stopConversation`).
4. `recover()`: convert `waiting` helpers whose question is gone to `stopped` with `stopKind: 'restart'` and a note, or re-arm the default timer from a persisted deadline.
5. `deliverReply`: accept replies to `done`/`failed` helpers by resuming their session (the branch is still there), the same path `resumeAgentSession` uses.
6. Fix the hover rule: scope `button:hover` to non-primary buttons or give `.fxPrimary:hover`/`.primary:hover` an explicit accent background.
7. Steer: send the images and clear them, or disable "Send now" while images are attached with a reason.
8. `ipcValidate` attachments limit 10, message "at most 6 images or 10 files"; `service.ts` archive/delete checks scoped to the conversation's own pending asks.
9. Bump `sessionGeneration` in `stop()`; dedupe the "Paused automatic coordination" message; post the held-helper "Assignment" message once.
10. Notifications only on a real state transition (compare previous activity state).

P1, next

11. Auto re-review after a fix commit on a reviewed branch; integrator accepts approval-plus-fix-commits by the same helper; Apply offers "stash, apply, pop" for a dirty folder with the diff shown.
12. Renderer: delete the local follow-up queue and rely on main's turn queue (keep the draft only); jump-to-latest pill; cap question and permission regions with inner scroll; single error surface per area; clip code fences at 400 lines with "show all"; memoise `useHarbor` actions with `useCallback` and split the state object.
13. Needs-input inbox with `listPendingQuestions` and `expiresAt`.
14. Storage: prune `coordination` and `sessions`, store tool lines and routing details out of `messages`, debounce flush to 1 s while streaming, replace `Atomics.wait` with async retry.
15. Surface the already-built main features: spend ceilings, secret allowlist, project notes and decisions, task report, remote settings and tokens.
16. CI: install and run the renderer suite; a smoke that at least boots the packaged app.
17. Terminology pass: pick "lead", "helper", "conversation" and one stop label; name the concierge reply ("Quick answer") so users know when a cheap model answered.

P2

18. Streaming deltas, message and git paging in the UI, SQLite, fork, cross-project queue, Gemini adapter, routing replay and ratings UI.

---

## 8. Docs and backlog lines to close or fix

- README: contract 0.1.37 (now 0.1.44); "Phase 0: spend ceilings, secret scanning" (built); "up to 3 helpers at a time" versus the UI's "default 4" concurrency (two different limits, say so).
- `docs/safety.md:98` push is allowed for the lead; `:119` spend ceilings exist; `:103` auto mode and deny rules (item 1).
- `docs/limitations.md:73` eval harness exists; `:128` deadline picker exists.
- `docs/architecture.md:27` add `HARBOR_NOTE`; `:64` branch deletion exists on failed worktree add.
- `src/renderer/README.md`: tables and italics are supported, links are not; permissions are cards, not a modal; reload recovery of permissions is implemented.
- BACKLOG review findings already fixed in code: updated messages jumping, `cachedMessages` growth, "Working..." forever, dismissable error banner, mock installed in production, CSP `ws://`, peer messages rendered distinctly, loop/cap/spend stop labels, estimated minutes, outdated badges. Remove them so the open list is readable.
- BACKLOG:141 (auto-mode confirmation as a UI item) belongs in core P0 next to item 1.
