# PLAN: roadmap 2 (2026-10-14)

Source: the owner's selection from the "what is Harbor missing" review. In scope: sections 1-9, **except** a mobile UI and macOS. Linux is deferred (lowest priority, decide later). Model for agents: Opus.

## Rules for every phase
- `AGENTS.md` applies: contract changes are optional fields or new methods only, recorded in `src/shared/CHANGELOG.md`; a new method needs type, `INVOKE_METHODS`, `createHarborService` implementation and a test.
- Done = `npm test`, `npm run typecheck`, `npm run build` pass. No real CLIs in tests. No `npm run smoke` unless the owner says so (it spends subscription quota).
- Agents work on their own `harbor/<task>` branch in a worktree, commit there, never push, never touch `main`. The owner merges (every push to `main` publishes a release).
- Renderer (`src/renderer/**`) and docs (`README.md`, `docs/**`) edits need the owner's explicit go for that phase. Core agents add "UI requests" to `BACKLOG.md` instead.

## Phase 0: trust and safety (core first)
- Spend ceilings: hard stop per task, per day, per week, including the lead's own turn. Setting fields are optional.
- Secret scanning on helper diffs; block integration on a hit, with an override that needs a yes.
- Auto-mode confirmation (UI), crash capture, audit-log export.
- Verification by hand (owner, uses quota): Codex adapter, model ids, permission protocol, nonce compliance.
- Docs reconcile and terms-of-service position (owner).

## Phase 1: measurement (section 1)
- Eval harness: same task set, Harbor vs single agent, quality / cost / time, runnable with fake adapters for CI and with real CLIs on request.
- Per-task cost and time report as data (`getTaskReport`).
- Quality feedback (thumbs, "redo stronger") stored as local evidence for the catalog.
- Routing replay / what-if over recorded decisions.
- Recorded-transcript fixtures for real CLI output shapes.

## Phase 2: orchestration (section 3)
- Project knowledge store (notes the lead and helpers read and write).
- Repo map generated once and refreshed on change, injected into helper prompts.
- Dependency install and dev-server management in worktrees (ports, lifetime).
- Planner/critic pass, test-first mode, best-of-N race for high-stakes work, idle worker reuse.

## Phase 3: git, PR, CI (section 4)
- PR creation through `gh`, CI results as verification evidence tied to the commit.
- Conflict-resolution integrator, partial (hunk/file) integration, stacked branches, hook-failure handling.
- Worktree retention setting and disk usage.

## Phase 4: providers (section 2)
- Adapter conformance suite (every adapter must pass it).
- Local models (Ollama) as a free tier; Gemini; Copilot/OpenCode/Aider as demand shows.
- Multi-account pools, provider-outage detection.

## Phase 5: extensibility and remote (sections 8, 7-remote)
- Headless service and local HTTP/WebSocket API over the existing `HarborApi`, plus a `harbor` CLI.
- Hooks, scheduled/recurring tasks (spend surplus quota before a weekly reset), issue-tracker intake, project templates, plugin API.

### Remote design
Harbor stays on the PC, because the signed-in CLIs, the repos and the quota live there. The remote surface is the same `HarborApi` that `INVOKE_METHODS` already lists, exposed over a server bound to 127.0.0.1 by default.
- Auth: per-device tokens stored hashed, each with a scope (read-only, answer permissions, full). Revocable. Never sent over plain HTTP off-box.
- Reach: the owner's own tunnel (Tailscale, SSH, Cloudflare tunnel). Harbor hosts no relay and no account system.
- Clients: `harbor` CLI first (`harbor status`, `harbor run`, `harbor answer`), then the existing renderer served over the same port.
- Events: WebSocket stream of the existing event types; permissions can be answered remotely only with a token scoped for it.
- Safety: tool-permission and "free reset" prompts are never auto-answered; remote full-scope is off by default.

## Phase 6: platform (section 9)
- SQLite storage with pagination, backup/restore, settings export/import, opt-in local telemetry. Linux later.

## Phase 7: UI (needs owner go for renderer)
- Command palette, global search, archive/pin/tag/fork, inline diff review with comments, live task board, timeline/replay, toasts with actions, themes and accessibility pass, onboarding, templates, richer attachments. Existing "UI requests" in `BACKLOG.md` fold in here.

## Budget (cross-cutting)
- Alerts when a pool enters conserve/protect, weekly seasonality and away-time awareness, cost view by project/conversation/model with CSV, quota holds persisted across restart.

## Wave 1 (started 2026-10-14, all core, disjoint files)
1. `harbor/spend-ceilings-secret-scan`: Phase 0 spend ceilings and secret scanning.
2. `harbor/eval-and-task-report`: Phase 1 eval harness and task report.
3. `harbor/knowledge-and-repo-map`: Phase 2 knowledge store and repo map.
4. `harbor/adapter-conformance`: Phase 4 conformance suite and transcript fixtures.
5. `harbor/remote-api`: Phase 5 headless service, HTTP/WS API, token auth, `harbor` CLI skeleton.

Later waves follow the phase order above; the owner reviews and merges each wave first.
