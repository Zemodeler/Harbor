# HANDOFF — Harbor core engine (branch `claude/core`)

## Read this first: branch and checkout situation

- Core work lives on **`claude/core`** (pushed). It was developed in a separate git worktree: `C:\Users\andrei\Documents\RoutingManager-core`.
- Early on, the UI engineer and I shared the single checkout `C:\Users\andrei\Documents\RoutingManager`; they switched it to `gpt/ui`, so my first six commits landed on `gpt/ui` as well, and one of my commits swept in their in-progress `src/renderer/*` files. I re-created the same work on a clean `claude/core` (cherry-picked, UI files removed) and stopped touching that checkout.
- **To merge:** `claude/core` ships only a 2-file placeholder in `src/renderer/` (`index.html`, `main.tsx`). Take `gpt/ui`'s version of `src/renderer/**` wholesale. The shared files (`package.json`, `tsconfig.json`, `electron.vite.config.ts`) are mine; the UI engineer's renderer expects the same `window.harbor` contract. Because the same core commits exist on `gpt/ui`, expect trivial/identical-content merges there.
- Recommendation: each engineer works only in their own `git worktree` from now on.

## What works (and how it was checked)

| Area | State | Evidence |
| --- | --- | --- |
| Scaffold, `npm run dev/build/test/typecheck/smoke` | works | build + 83 tests + typecheck pass; Electron main process boots and stays up (12 s run, no JS errors) |
| Contract `src/shared/api.ts` + `window.harbor` via typed IPC | works | identical to spec plus one optional field (`CliStatus.authState`, see `src/shared/CHANGELOG.md`); IPC wiring unit-tested for every method, **never exercised from a real renderer** |
| CLI discovery (claude, codex, gemini) | works | PATH + `%APPDATA%\npm` + `~\.local\bin` + Claude desktop's bundled `claude.exe`; override with `HARBOR_CLAUDE_PATH` etc. Run against the real bundled `claude.exe` 2.1.293 (version + `auth status --json` → signed out). Codex via `codex login status` is parsed from docs (unverified). Gemini has no status command → `unknown` + note |
| `openLogin` | implemented | opens a visible `cmd /k <cli> login` window (Windows only). **Not clicked/run by me** |
| Claude adapter | flags verified | all flags accepted by real `claude.exe` 2.1.293 (stdin prompt, stream-json, `--effort`, `--permission-mode`, `--disallowedTools Task Agent`, `--append-system-prompt-file`); stream-json parse verified against the real "Not logged in" result. **No successful model run was possible (no signed-in CLI here)** |
| Codex adapter | smoke-tested once (codex-cli 0.160.0) | `codex exec --json -s <sandbox> -c model_reasoning_effort=... -`; bundled Codex is discovered. Findings from that run (sandbox cannot write worktree git metadata, reviewer misses the spec, peer messages by id) are P0/P1 items in `BACKLOG.md`. Real 5h/weekly limits are read from Codex's local logs (`codexLimits.ts`) |
| `.cmd` shims (npm-installed CLIs) | verified | real `.cmd` with a space in its path: args, stdin, metacharacters, injection guard |
| Storage | works | JSON file `%APPDATA%\Harbor\state.json`, atomic write, corrupt-file quarantine. (SQLite deliberately skipped: native build on Windows) |
| Main agent → planner → implementer → reviewer flow | works with fake CLIs | `tests/orchestrator.test.ts`: plan JSON, planner report becomes implementer spec verbatim, worktrees on `harbor/<slug>`, checkpoint commits, main checkout untouched, dependency failure blocks dependents, circular deps broken, cap of 8 tasks per plan, runaway guard of 12 automatic main turns |
| Subagents can't spawn agents | enforced for Claude | native `Task`/`Agent` tools disabled; others use the `HARBOR_REQUEST_HELP` protocol; Codex has no native subagents but this is **unverified** |
| Direct prompts to a subagent | works | resumes the subagent's native session, recorded in coordination log, revision bumped, main notified on its next turn |
| Help requests / sibling messages | works | blocked agent resumes with the helper's report; peer messages logged in both conversations and coordination record, delivered at the recipient's next run (not mid-run) |
| Routing | works | state-based scorer, reason stored in `Message.details.reason`, fallback to next CLI on failure / rate limit (tested), exhausted CLIs skipped |
| Usage ledger | works, estimate-only | rolling 5 h window, 40-run assumed budget, labels say "estimated from Harbor runs only"; a CLI-reported rate limit forces 100 % for 30 min. Free reset only via `permission` event, only with a confirmed entitlement (none exists today), once per window |
| File locks / conflicts | works | whole-file ownership per project, all-or-nothing acquire, `permission` kind `conflict` (allow = parallel in separate worktrees, deny = wait), out-of-claim edits detected after a run |
| Self-host | prepared, **not run end to end** | `AGENTS.md`, `BACKLOG.md`; worktrees get the project's ignored `node_modules` via junction so agents can run tests |

## What is stubbed or missing

- Everything in `BACKLOG.md`. Most important: integration/merge of `harbor/*` branches, interactive tool permissions (headless runs deny unlisted tools), queue priority/pause, rollback, API fallback, Gemini adapter, skills/plugins discovery, real provider allowance readings.
- Permission requests live in memory; after a restart a conflict-waiting agent stays `queued` until the next scheduling pass.
- Worktrees are created from the repository's **committed HEAD**. Uncommitted changes in the project folder (for example the docs edits currently in this repo) are not visible to agents. Commit first.
- No worktree or branch is ever deleted automatically. `Git.removeWorktree` exists, refuses paths outside Harbor's root, and is unused by the app.
- Projects that are not git repos with commits run implementers directly in the project folder under a whole-project lock.

## Could not verify (needs a signed-in machine)

1. Any real model run end to end (no CLI here is signed in; `claude.exe` bundled with the Claude desktop app reports logged out).
2. A full Codex flow after the sandbox/git-metadata fix (see `BACKLOG.md`).
3. `npm run dev` with the real UI and clicks through IPC (the UI now builds; clicks through a real Electron window are not covered by tests).
4. `openLogin` window, the folder dialog, and a full self-host run of Harbor on this repo.
5. Whether Claude's `acceptEdits` + `Bash(git|npm|npx|node *)` allow-list is enough for implementers to finish real tasks.

## Exact commands

```
git worktree add ../RoutingManager-core claude/core     # if you want my worktree layout (already exists on this machine)
cd C:\Users\andrei\Documents\RoutingManager-core
npm install
node node_modules/electron/install.js      # only if node_modules/electron/dist is missing (install scripts are not auto-run)
npm test                                   # 83 tests, no network, no real CLIs
npm run typecheck
npm run build
npm run dev                                # Electron app; state in %APPDATA%\Harbor
npm run smoke -- claude                    # REAL call, small quota: run, session id, resume
npm run smoke -- claude --full             # also: main agent -> subagent in a temp git repo
npm run smoke -- codex --full
```

Environment overrides: `HARBOR_CLAUDE_PATH`, `HARBOR_CODEX_PATH`, `HARBOR_GEMINI_PATH`.

## First self-host attempt (suggested)

1. Sign in: `claude auth login` (and `codex login`). Commit or stash local changes in the repo you will open.
2. `npm run smoke -- claude --full` until green.
3. `npm run dev`, add this repo as a project, send: "Work on BACKLOG.md item 3 (auth-failure handling)". Review the resulting `harbor/*` branch with `git diff main..harbor/<slug>`; merge it yourself.
