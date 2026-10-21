# PLAN: roadmap 3 (2026-10-21)

Follows `PLAN-project-lifecycle.md` (built on branch `harbor/project-lifecycle`, commit 560fc3b, not yet merged). Owner request in chat on 2026-10-21: implement every item from the recommendation list. That request is the scope-owner override for `src/renderer/**`, `src/shared/**` and the docs reconcile. Nothing is pushed to `main`; the owner merges.

## Tracks (each in its own worktree and branch)

| Track | Branch | Cut from | Items | Touches |
| --- | --- | --- | --- | --- |
| **B** projects | `harbor/projects-2` | `harbor/project-lifecycle` | 2 clone/import by URL, 3 overview + archive + pin + search + usage view, 4 templates + save-as-template + default checks, 5 recycle-bin delete, 6 PR/CI status + merge PR + tags | `service.ts`, `store.ts`, `git.ts`, `github.ts`, contract, renderer |
| **R** reliability | `harbor/reliability` | `main` | 1 real-run proof (smoke), 7 crash recovery for pending permissions, token streaming for leads, per-task cost and time report polish | `adapters/claude.ts`, `adapters/codex.ts`, `orchestrator.ts`, `store.ts` (permissions), `scripts/smoke.ts`, tests |
| **G** adapters | `harbor/more-adapters` | `main` | 7 Gemini adapter, baseline terminal adapter, routing catalog entries | `adapters/gemini.ts`, `adapters/terminal.ts` (new), `clis/registry.ts`, `clis/capabilities.ts`, tests |
| **D** docs | `harbor/docs-reconcile` | `main` | 8 README and `docs/**` rewritten to the concierge + lead design | `README.md`, `docs/**` only |

Why this split: B is sequential because every B item edits the contract, `service.ts` and the renderer. R, G and D touch disjoint files, so they run in parallel with B and with each other.

Contract numbers (avoid collisions; the owner renumbers at merge if order changes): B uses 0.1.48-0.1.59, R uses 0.1.60-0.1.69, G uses 0.1.70-0.1.79. D changes no contract. All members optional; each change needs the full IPC checklist from AGENTS.md (type, `INVOKE_METHODS`, validation, remote scope, `createHarborService`, mock, test).

## Track B detail (sequential phases)

- **B1 Clone/import by URL.** `cloneProject(url, parentDir?)`: validate https/ssh URL (reuse `setRemote` validation), `git clone` into the projects folder (non-empty target refused, name sanitised as in create), register, set `origin`. `listGithubRepos()` through `gh repo list` (owner-selectable, cached, desktop-only) feeding a picker in the New project dialog ("Start from existing repo" tab). Failures: auth, repo not found, clone interrupted (remove only the folder this call created).
- **B2 Overview and organisation.** Home screen listing all projects: running agents, unmerged `harbor/*` branches, unpushed commits, last activity, quota hints. `Project.archived?`, `Project.pinned?` (optional fields); archive hides from the sidebar without deleting anything and is reversible; pinned sort first. Cross-project search over conversation titles and messages (main-side, capped, paginated). Global usage view: per CLI and per project estimate from Harbor's own ledger, always labelled an estimate (AGENTS.md rule).
- **B3 Templates.** User templates stored under the data folder (`templates/<id>/template.json` plus files); "Save project as template" copies tracked files minus ignored and secret-looking ones (secret scan runs; findings block); per-template default checks (test/build commands) become the new project's project checks (with the existing approval flow for checks, never auto-approved). Built-ins stay.
- **B4 Recycle-bin delete.** The `folder` delete level moves the folder to the Windows Recycle Bin by default (via Electron `shell.trashItem`, injected so `service.ts` stays electron-free); permanent delete becomes a second explicit option. Preview says which will happen. Fallback to permanent only after a second typed confirmation if trashing fails.
- **B5 Publish, part two.** PR status and CI check summary in the Git view (`gh pr view`, `gh pr checks`, read-only), "Re-run failed checks" (`gh run rerun --failed`), "Merge PR" (only for PRs whose checks are green or after an explicit override, merge method chosen, never force, confirmation naming the PR), release tag create+push (`git tag -a`, `git push origin <tag>`, tag names validated, no deletes). All behind desktop-only scope `never`. Everything external uses the injected `gh` runner in tests.
- **B6 Wrap-up.** Renderer tests for each, BACKLOG/HANDOFF/CHANGELOG, final report.

## Track R detail

- **R0 Real-run proof.** Using the owner's signed-in CLIs, run only the documented commands, one at a time: `npm run smoke -- claude`, then `-- claude --full`, then `-- codex`, `-- codex --full`. Stop a CLI's checks immediately if it reports signed out or quota exhausted (do not sign in, do not retry in a loop). Record each outcome; fix what the runs reveal (flags, event shapes, `parseCodexLine`), add recorded transcript fixtures as regression tests. Total quota use must stay small; say how much was spent.
- **R1 Pending permissions survive restart.** Persist unanswered `permission` events (kind, agent, payload hash, created) in the store; on startup `recover()` restores them or, when the agent cannot continue, marks the agent `stopped` with `stopKind: 'restart'` and tells the lead. Test with a simulated restart.
- **R2 Streaming deltas.** `--include-partial-messages` for Claude and the Codex equivalent so `messageDelta` carries tokens (BACKLOG P0 #5), with a fallback to whole messages; adapters still end with exactly one `done` chunk; tests with fixtures.
- **R3 Task cost/time report polish.** Surface per-task and per-day totals consistently (estimate label kept), including retries and fallbacks.

## Track G detail

- **G1 Gemini adapter.** First run `gemini --help` (and a status check) and record verified vs unverified flags in the file header, as AGENTS.md requires. Prompt on stdin, `Chunk`s out, exactly one `done`, auth detection, model list into `capabilities.ts` with tiers (data only). Registered but unverified models are marked so in the catalog.
- **G2 Baseline terminal adapter.** For CLIs with no structured output: run, capture text, label limitations (no resume, no streaming deltas, no tool-permission control). Used only when the owner enables the CLI.
- **G3** Routing tests: a third CLI takes work when two are exhausted; reasons stored in `Message.details.reason`. No real quota use.

## Track D detail

Rewrite `README.md` and `docs/*.md` to match the shipped behaviour (concierge, lead, delegation lines, worktrees, parallel sessions, integration, rollback, secret scan, usage estimate, remote API, project lifecycle once merged). Verify each claim against code or `src/shared/CHANGELOG.md`; where behaviour is uncertain say so rather than guess. No code edits.

## Verification for every track

`npm test`, `npm run typecheck`, `npm run build` (plus `npm --prefix src/renderer test` where the renderer changed; worktrees need `npm --prefix src/renderer install` first, then discard the lock-file change; never two `npm test` at once). Final report lists what was and was not verified.

## Safety and ownership

No pushes, no PRs opened, no real GitHub writes, no real deletes of real projects in any track; tests use temp dirs, a local bare origin and injected runners. No credentials read or printed. Sign-in is the CLI's own flow and is never started by an agent.

## Merge order (owner)

1. `harbor/project-lifecycle`, 2. `harbor/projects-2`, 3. `harbor/reliability`, 4. `harbor/more-adapters`, 5. `harbor/docs-reconcile` (re-check its project-lifecycle sections after 1-2). Expect conflicts only in `src/shared/CHANGELOG.md`, `api.ts` and `BACKLOG.md`.
