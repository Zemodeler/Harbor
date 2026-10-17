# Limitations

This page is drawn from the code, the adapter file headers, `BACKLOG.md`, `HANDOFF.md`, `RELEASING.md` and `src/shared/CHANGELOG.md`. Check those before relying on any line here. "Verified" below means the repository records that it was run. Everything else is unverified.

## Estimates

- **Usage is partly a guess.** Without a provider-reported window, Harbor counts its own runs against a budget. That budget is learned from provider readings, or else it is a fallback of 200 runs per 5 hours and 120 per week, measured once on one account. Harbor cannot see use outside Harbor. Never read an estimate as your provider quota.
- **Reported windows can be stale.** Claude's are only seen while Harbor runs Claude. Codex's are as fresh as your last Codex use. Gemini and custom CLIs have none.
- **Budget constants are starting values** tuned in a simulator that models the providers. The cost priors come from one machine's runs on 2026-10-12, and the Claude figures include the owner's own use outside Harbor. The effort multipliers (`EFFORT_TOKEN_MULT` 0.8/1/1.35) were never measured. The governor projects the last day's burn over the rest of the week and does not model weekends.
- **Difficulty** is computed from wording and file counts, and the concierge's rating is heuristic. `/deep` forces a strong lead.
- **Routing quality is unproven.** The catalog is data, not benchmarks. No eval harness yet compares Harbor with a single agent on quality, cost or time (roadmap Phase 1).

## Cost of delegation

Delegation spends more than one agent working in one session would. Each helper re-reads the code, each lead wake-up resumes its whole context, and reviews, checks and retries add more runs. For features that use several helpers, expect roughly **2.5x to 5x** the quota of a single agent. That figure is an estimate and has not been measured. A task the lead does alone costs about one session plus a small constant. Delegation can still pay off in wall-clock time, in an independent review, or for work that would flood the lead's context.

## Verified and not

| | Claude Code | Codex |
| --- | --- | --- |
| Discovery, headless run, streaming, session id | Flags accepted by 2.1.293. Lean concierge flags accepted by 2.1.295 (no model call). One real `npm run smoke -- claude --full` is recorded in the lead-rework notes; older notes in `BACKLOG.md` P0 #2 and `HANDOFF.md` say no full run was made | Run, session id and events verified once on codex-cli 0.160.0. The sign-in check is unverified |
| Resume, effort | Flags accepted. Whether `total_cost_usd` of a resumed session is the session total is unverified | Used. Full resume and per-model effort are unverified. `xhigh`/`max` are never sent |
| Model ids | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`: **unverified** | `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` (from Codex's local model cache): **unverified** with `codex exec -m` |
| Usage readings | `rate_limit_event` window keys unverified | `cached_input_tokens` and running totals on resume unverified |
| Tool permission prompts | The control channel handshake was verified without a model call. A real prompted turn is unverified. The precedence of deny rules is unverified | None; sandbox only |
| Auto mode | `bypassPermissions` unverified | `approval_policy=never`, `danger-full-access` unverified |
| Worktree git metadata for edit helpers | `--add-dir` listed by `--help`, not run | `writable_roots` passed, not run for real |
| Native sub-agents disabled | By flag | Unknown (`ultra` is never sent) |
| Lead or concierge in a real multi-helper run | Not recorded | Not tried |

Also unverified:
- Whether real models honour the per-turn protocol tag.
- The exit-code fallback when a CLI ends without a completion event.
- The `taskkill` fallback on Stop.
- The before-quit dialog and sleep/wake handling (tested only with mocked Electron).
- The loop guard on real tool-line shapes.
- The claude.ai and ChatGPT export parsers against real exports.
- A skill read through `--add-dir`.
- The GitHub Actions release run, a real update download and install, and update checks before the repository is public ([RELEASING.md](../RELEASING.md)).
- The UI clicked through a live engine.

## Platform and providers

- Windows only. The installer is not signed. macOS is out of scope and Linux is deferred.
- Whether headless, parallel use of subscription CLIs fits each provider's terms is an open owner decision (see the README). Check your plan's terms yourself.
- Built-in adapters exist only for Claude Code and Codex. Gemini is detected but not used, unless you add it as a custom CLI. There is no API fallback.
- "Open in editor" needs the editor installed and registered for its URL protocol.

## Surprises

- **The lead edits your folder directly, unless another session already does.** Helpers start from the committed `HEAD` and do not see uncommitted edits (Harbor warns once). A second editing session of the same project does not wait: it works in its own worktree on a `harbor/session-*` branch, and its changes reach your branch only when you merge the session. That session does not contain your uncommitted edits, and it keeps its worktree for good, so its native CLI session stays valid. A folder without git still has two leads take turns.
- **Merging a session runs no checks.** It scans for secrets and fast-forwards, but the project's `.harbor/checks.json` runs only for helper integrations. Session worktrees are not cleaned up automatically yet, and a session merged into your branch keeps working on the same branch afterwards. Two sessions that change the same code meet as a merge conflict at merge time, not while they work.
- **Verification is only as good as `.harbor/checks.json`.** Reviewers cannot run tests, and a verdict covers one commit.
- **Restarts interrupt work.** Helpers become `stopped` (with their work committed), and the lead needs a new message. Some state lives only in memory and is lost on restart: quota holds and `heldUntil` timers, front-desk exchanges, and the one-time two-leads warning.
- **Decisions** (`HARBOR_DECISION`) are scoped to the conversation they were noted in. A new conversation does not inherit them.
- **Direct messages** reach a running helper only after its current step. A `HARBOR_REPLY` to a queued helper arrives after its first run.
- **A held task is not a record.** A task refused by the size gate or the dirty-base check is not created, so the lead has to delegate it again.
- **Streaming** comes per CLI message, not per token.
- **Rollback** handles merge commits only, one task at a time, and the lead cannot start it.
- **Concurrency** is per project. There is no cross-project queue, and no capacity is reserved for your messages beyond the quota reserve.
- **`routing: manual`** has no effect. You can name a CLI in a message instead ("use codex").
- **Storage** is one JSON file, and it grows until SQLite and paging land (roadmap Phase 6).
- **Worktree retention** is fixed at 14 days and has no setting.

## Interface gaps

These are built in the renderer but recorded as tested only against the in-memory mock: integrate, apply, rollback, queue controls, routing settings, tool rules, diagnostics export, and the auto-mode confirmation. Not built: a deadline picker (`setConversationDeadline`), a budget panel, a cross-project queue view, per-conversation CLI override, a UI for stored decisions, an `autoUpdate` setting in the typed settings or the UI, and an integrated terminal. Quality gaps (re-rendering, no virtualization, one global error string, no accessibility audit) are listed in `BACKLOG.md`.
