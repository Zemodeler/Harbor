# Harbor

![Harbor icon](design/harbor-icon.png)

Harbor is a Windows desktop app (Electron, TypeScript) for working on a local project through the AI command-line tools you already have installed and signed in to. You open a project folder, describe the work in a chat, and Harbor decides which CLI and model handle it. Today the supported CLIs are Claude Code and Codex. Most messages are handled by one working "lead" agent that reads, edits and runs commands like a normal assistant session. When it pays off, the lead hands bounded pieces to helper agents that work in their own git branches. Harbor schedules them, checks the results, and merges them only after you press Apply. It does not use API keys, does not talk to any model itself, and does not replace the CLIs: every model call is a CLI process Harbor starts on your machine.

## Who it is for

Harbor is built for one person, a developer with a Claude subscription and a Codex subscription (also shared with a few friends), who wants one place to run several coding agents against one repository without juggling terminals and without one agent trampling another's files. It is open source (GitHub: Zemodeler/Harbor) and intended for personal use. It is not an enterprise product, has no team features, and makes no claim to save money. See [Limitations](docs/limitations.md) before relying on it.

## Status

Working but young. The distinction below is what the repository itself records; nothing here was re-run when this README was written.

Tested or verified:
- The unit and integration test suite (`npm test`, vitest) runs without network or real CLIs, using fake adapters and real git in temp folders. It covers the concierge/lead/helper flow, scheduling, worktrees, checks, integration, apply, rollback, tool permissions, routing and usage. `HANDOFF.md` recorded about 440 tests at its last refresh.
- Claude Code: the flags Harbor uses were checked against `claude` 2.1.293, and `npm run smoke -- claude --full` (concierge, then lead, in a temp repo) was run against a real install.
- Codex: run, session id capture, resume and the JSONL event shapes were checked against codex-cli 0.160.0 with a real smoke run.
- Windows `.cmd` shims, process-tree cleanup, git worktree handling and the Electron window hardening are covered by tests.

Not verified (treat as untested):
- Codex model ids. Harbor only uses Codex's default model; the catalog has no named Codex models. Codex flags for images, `approval_policy` and full-access ("auto") mode are documented but unverified.
- Codex as the lead or concierge, and any real multi-helper run (several helpers, reviewer, integrator) driven by a real model, with either CLI.
- Claude's permission-prompt control channel (`--permission-prompt-tool stdio`), the exact deny-rule syntax, and that deny rules win over allow rules in the installed CLI. The adapter header lists each unverified detail.
- Auto-update from a real GitHub release, and the GitHub Actions release workflow itself (see [RELEASING.md](RELEASING.md)).
- Clicks through the real Electron window. The renderer is tested against an in-memory mock, not against a live engine.
- Per-model rate-limit names reported by Claude (inferred from a pattern) and the `claude-fable-5-1` model id.

Some hardening work is still in progress on other branches (see [HARDENING-PLAN.md](HARDENING-PLAN.md)); [docs/limitations.md](docs/limitations.md) says which behaviors this affects. The committed renderer lagged the engine. Screens for integrate, apply, rollback, queue controls, routing settings, always-allowed tools, diagnostics export and an auto-mode confirmation were being added in the working tree (uncommitted) when this was written and have not been verified here; see [Interface design](docs/interface-design.md).

## Install

1. Download `Harbor-Setup-<version>.exe` from the latest release at https://github.com/Zemodeler/Harbor/releases (the repository has to be public for updates to work).
2. Run it. The installer is **not code-signed**, so Windows SmartScreen will warn on this first install: choose "More info", then "Run anyway". Later updates are installed by Harbor itself and do not repeat the warning.
3. Harbor checks GitHub Releases shortly after launch and every few hours, downloads updates in the background, and asks "Restart now / Later". It never prompts or restarts while agents are running. Set `HARBOR_NO_UPDATE=1` to turn updates off; development runs never update.

Windows is the only supported platform. Each push to `main` publishes a release; see [RELEASING.md](RELEASING.md).

## First run

Harbor needs at least one CLI that is installed and signed in. It finds `claude` and `codex` on your PATH, in `%APPDATA%\npm`, in `~\.local\bin`, and in the folders bundled with the Claude and Codex desktop apps; override with `HARBOR_CLAUDE_PATH` and `HARBOR_CODEX_PATH`. Settings > Connections shows each tool as ready, needs login, status unknown, or not installed. Sign-in is always the CLI's own flow ("Sign in" opens a normal `cmd` window running the CLI's login); Harbor never reads or stores your credentials. Gemini CLI is detected and listed but never assigned work. Then add a project folder and start a conversation. Harbor refuses a drive root or your whole home folder as a project.

For checks to run on helper work, add `.harbor/checks.json` to the project, for example `{"checks": ["npm test", "npm run typecheck"]}`. Without it, Harbor runs no checks and nothing a helper reports is independently verified.

## How a conversation works

Every message goes through the same path ([Architecture](docs/architecture.md) has the details):

1. **Concierge.** A cheap, tool-less model first decides whether it can answer from the conversation itself (greetings, status of running work) or must escalate. Messages that are obviously work, name a CLI, answer the lead's last question or carry images skip this step.
2. **Lead.** An escalation starts (or resumes, per conversation) a lead agent: a normal CLI session in your project folder that reads, edits and runs commands. It does the work itself when that fits in one session. Only one lead turn per project edits the folder at a time.
3. **Helpers.** Only when it pays off (parallel pieces, bulky research, independent review) the lead emits `HARBOR_DELEGATE` lines. Harbor creates the helpers, schedules them (dependencies, per-project concurrency limit, file locks), runs edit helpers in their own git worktrees on `harbor/<slug>` branches, runs your `.harbor/checks.json` on each result, and resumes the lead with the reports. Helpers cannot start other agents or message each other.
4. **Landing the work.** The lead can ask for an integrator. Harbor merges the approved branches by pinned commit into a new `harbor/integrate-*` branch, runs the checks again, and waits. Only your explicit Apply fast-forwards your branch. Harbor never pushes. A finished task can later be rolled back the same way (revert on a new branch, then Apply).

Several conversations of one project can run at once. Their leads know about each other and can send one short `HARBOR_PEER` note; helpers never can.

Modes (per conversation): `default` asks before risky tool calls; `auto` turns permission prompts and the sandbox off for the lead and edit helpers; `plan` is read-only and answers with a plan, and a go-ahead like "yes, do it" returns to default; `goal` keeps resuming the lead (up to 8 automatic continuations) until it reports the goal reached, asks you something, or you stop it. Start a message with `/deep` to skip the concierge and use a strong model with high effort. Harbor cannot generate images: asked for one, the lead writes a paste-ready prompt for an image generator.

## Routing and usage

Harbor scores every installed, enabled, signed-in CLI and model against the work (needed tier, stated needs, current allowance, load, session continuity, your preferences) and picks the best; the reason is stored with each message. The capability catalog that says which model suits which need is editable data (`capabilities.json` in the data folder). If a run fails, it falls back to another CLI, and rate-limited models are held out for 30 minutes. See [Background routing](docs/background-routing.md).

Usage numbers are estimates unless labeled otherwise. Harbor counts only the runs it started (runs, tokens and cost when the CLI reports them) against assumed budgets of 40 runs per 5 hours and 300 per week. Where the provider reports a window (Claude's `rate_limit_event` during Harbor runs, Codex's local session logs in `~/.codex/sessions`) Harbor uses and labels that instead. It is never the provider's quota page, cannot see usage outside Harbor, and can be stale. A discretionary free reset is only ever proposed after you say yes, and no CLI currently exposes one, so that feature is dormant. See [Usage and resets](docs/usage-and-resets.md).

## Safety model

Details and the threat model are in [docs/safety.md](docs/safety.md). In short:
- Edit helpers work in separate git worktrees on `harbor/*` branches under `%APPDATA%\Harbor\worktrees`. Their work reaches your branch only through an integration that you Apply (fast-forward only, refused when your folder has uncommitted changes or the branch moved). Harbor never pushes. The lead is different: it edits your project folder directly, like any assistant session.
- Claude agents are denied destructive git (clean, restore, hard reset, branch deletion, worktree, config, remote, push, `git -C`), leads are also denied merge, rebase, cherry-pick, reset and push, and Claude's own sub-agent tools are disabled. Codex agents run in Codex's sandbox without these deny rules; Harbor can only detect afterwards if a lead merged a helper branch itself.
- Tools outside the allowlist ask you first (Claude edit runs only), with allow once, always allow for this project (never for dangerous kinds), or deny; unanswered requests are denied after 5 minutes. `auto` mode removes these prompts; a confirmation step before enabling it was being added to the UI (in progress).
- Credential-looking files (`.env*`, keys, `.npmrc`, ...) are excluded from checkpoint commits and never shown in diffs. Secrets are redacted from logs, check output and diagnostics, best effort.
- `.harbor/checks.json` is read from your main checkout, not from a helper's worktree. The first time (and whenever the file changes) Harbor shows you the exact commands and runs nothing until you approve; checks run with a reduced environment.
- Text from files, tools, web pages and other agents is treated as data in every prompt. This reduces prompt-injection risk; it does not remove it.

## Where data lives

`%APPDATA%\Harbor\`: `state.json` (projects, conversations, messages, agents, usage; with a rolling `state.json.bak` and quarantined `state.json.corrupt-*` if it ever fails to parse), `logs\main.log` (rotated), `journal.jsonl` (what went wrong in Harbor's own runs), `worktrees\` (helper, integration and rollback checkouts), `patches\` (rollback evidence), `attachments\` (images you sent), and an optional `capabilities.json`. Uninstalling keeps this folder. Harbor never deletes a branch; it removes the worktree folders of finished work after a retention period, while the branches stay.

## Development

```
npm install            # then: node node_modules/electron/install.js if electron/dist is missing
npm run dev            # electron-vite dev (hot reload)
npm run build          # electron-vite build -> out/
npm test               # vitest, no network, no real CLIs
npm run typecheck      # tsc --noEmit (excludes src/renderer)
npm run smoke          # REAL CLI check; uses a little quota (see scripts/smoke.ts)
npm run smoke -- claude --full   # also runs the whole concierge -> lead -> helper flow in a temp repo
npm run dist           # local unsigned installer, no publishing (needs: npm install --prefix build)
```

A change is done only when `npm test`, `npm run typecheck` and `npm run build` pass. Contribution rules, file ownership and the renderer/main contract (`src/shared/api.ts`, with `src/shared/CHANGELOG.md`) are in [AGENTS.md](AGENTS.md). Open work: [BACKLOG.md](BACKLOG.md) and [HARDENING-PLAN.md](HARDENING-PLAN.md); handoff notes: [HANDOFF.md](HANDOFF.md). Harbor is released under the [MIT License](LICENSE).

## Documents

- [Architecture](docs/architecture.md): one-screen architecture, the path of a prompt, the data model.
- [Safety](docs/safety.md): threat model, what agents can and cannot do, secrets.
- [Limitations](docs/limitations.md): known gaps, cost of delegation, what is estimated.
- [Product direction](docs/product-direction.md): goals, scope, core concepts.
- [Project agents](docs/project-agents.md): concierge, lead and helpers, roles, reports, recovery, rollback.
- [Agent collaboration](docs/agent-collaboration.md): file ownership, worktrees, integration, lead-to-lead notes.
- [Background routing](docs/background-routing.md): how a CLI and model are chosen, effort, fallback, settings.
- [Usage and resets](docs/usage-and-resets.md): the ledger, estimates versus reported windows, free resets.
- [Connections and extensions](docs/connections-and-extensions.md): CLI discovery, sign-in states, what is verified per CLI.
- [Interface design](docs/interface-design.md): the screens that exist and what is not built yet.
- [Releasing](RELEASING.md): CI, versions, updates, rollback of a bad release.
