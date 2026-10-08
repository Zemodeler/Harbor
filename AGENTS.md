# AGENTS.md — working on Harbor

Harbor is a Windows desktop app (Electron + TypeScript) that routes project work to installed AI CLIs (Claude Code, Codex, ...). The product spec is `README.md` and `docs/*.md`; read them before changing behavior. This file is for any agent or human contributing code, including Harbor's own subagents (Harbor develops itself).

## Layout and ownership

| Path | Owner | Notes |
| --- | --- | --- |
| `src/main/**` | core | Main process: discovery, adapters, orchestrator, store, router, ledger, locks, git |
| `src/shared/**` | core | `api.ts` is the renderer/main contract |
| `src/preload/**` | core | `window.harbor` bridge (typed IPC) |
| `tests/**`, `scripts/**` | core | vitest unit tests, `npm run smoke` |
| `src/renderer/**` | UI | React UI. Core agents never edit it |
| `build/**`, installer/electron-builder config, icons | UI | Packaging |
| `AGENTS.md`, `BACKLOG.md`, `HANDOFF.md` | core | |
| `README.md`, `docs/**`, `design/**` | product owner | Design documents; do not rewrite them in code tasks |

If you need a change in a path you do not own, add an item to `BACKLOG.md` (core backlog, or "UI requests") instead of editing it.

## Commands (Windows, Node 22)

```
npm install            # then: node node_modules/electron/install.js if electron/dist is missing
npm run dev            # electron-vite dev (hot reload)
npm run build          # electron-vite build -> out/
npm test               # vitest, no network, no real CLIs
npm run typecheck      # tsc --noEmit (excludes src/renderer)
npm run smoke          # REAL CLI check; uses a little quota (see scripts/smoke.ts)
npm run smoke -- claude --full   # also runs the whole main-agent -> subagent flow in a temp repo
```

A change is done only when `npm test`, `npm run typecheck` and `npm run build` pass.

## Contract rules (`src/shared/api.ts`)

- Only add optional fields or new methods. Never rename, remove, or retype existing members.
- Every change is recorded in `src/shared/CHANGELOG.md` (newest first) in the same commit.
- A new method needs: the type in `api.ts`, its name in `INVOKE_METHODS` (`src/shared/ipc.ts`), an implementation in `createHarborService`, and a test.

## Architecture in one screen

- `service.ts` implements `HarborApi` over `Store` + `Orchestrator`. No electron imports outside `index.ts`.
- `orchestrator.ts`: one logical main agent per project. The main agent only emits a JSON plan (`prompts.ts`); the orchestrator creates subagents, schedules them (dependencies, concurrency limit, file locks), runs them via adapters, collects reports, and calls the main agent again only when its judgement is needed (planner finished, failure, everything finished).
- Subagents never spawn agents. They print `HARBOR_REQUEST_HELP: {...}` or `HARBOR_PEER: {...}` lines (see `PROTOCOL` in `prompts.ts`). Claude's native `Task`/`Agent` tools are disabled in `adapters/claude.ts`.
- Edit-capable roles (implementer, other) run in their own git worktree on branch `harbor/<slug>` under `%APPDATA%\Harbor\worktrees`. Read-only roles run in the project folder (reviewers in the reviewed worktree).
- Routing (`router.ts`) is a state-based scorer: installed, enabled, has adapter, not signed out, not exhausted, load, continuity. Every decision's reason is stored in `Message.details.reason`. Do not hard-code "provider X is best at Y".
- Usage (`usage.ts`) only counts what Harbor ran and labels it as an estimate. Never present it as the provider's quota. A free reset is only ever proposed through a `permission` event and only after an explicit yes.
- Adapters (`adapters/*.ts`) take the prompt on stdin (never argv), emit `Chunk`s, and always end with exactly one `done` chunk. Add new CLIs by implementing `CliAdapter` and a `CliDefinition` in `clis/registry.ts`; verify flags with `<cli> --help` first and record unverified ones as such in the file header.

## Conventions

- TypeScript strict, ES modules in source, no `any` unless parsing untyped CLI JSON (keep it inside parse functions).
- Pure functions for parsing and scoring so they can be tested without processes. Inject runners, adapters, clocks.
- Tests: vitest in `tests/`, use `FakeAdapter` and temp dirs; real git is fine (it is available), real CLIs are not.
- Match surrounding style: small files, comments explain why, not what. No new dependencies without a reason in the commit message.
- Windows: `.cmd` shims need a shell (`proc.ts` handles it); kill process trees with `taskkill`; paths are case-insensitive (use `normPath`).

## Safety rules (non-negotiable)

- Never commit secrets, tokens, or `.env` files. Never read or print credentials; sign-in is always the CLI's own flow.
- Never run destructive git commands (`reset --hard`, `clean`, `push --force`, `branch -D`, `worktree remove`) except on worktrees/branches Harbor created (`harbor/*` under Harbor's worktrees root). `Git.removeWorktree` enforces this; keep it that way.
- Do not push to `main`. Work on your assigned branch (`harbor/<task>` for Harbor subagents) and report; the owner merges.
- Only touch files you own or that your assignment names. If you must edit something else, stop and ask for help.

## Reporting (Harbor subagents)

End your final answer with: what changed (files), checks run and their results (pass/fail with the command), unresolved issues, and the branch and commit you worked on. State what you did not verify. Do not claim something is verified unless you ran it.
