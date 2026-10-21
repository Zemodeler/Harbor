# PLAN: project lifecycle and publish (2026-10-20)

Branch: `harbor/project-lifecycle`, cut from current `main` in its own worktree (the `harbor/ui-polish` tree has uncommitted renderer edits; do not build on it). Never pushed to `main` by an agent; the owner merges.

Scope owner override: needed for `src/renderer/**` (UI owns it) and for contract changes. The owner asked for this in chat on 2026-10-20; record that in the PR text. `README.md` and `docs/**` stay untouched (product owner); doc follow-ups go to `BACKLOG.md`.

## Goal

The owner wants to make many projects with Harbor:
1. **Start** a project in one step: a name, a place, optionally a GitHub repo.
2. **Delete** a project in one step, with a clear choice of what disappears.
3. **Publish**: push a branch and open a PR from inside Harbor.

## What exists today (verified in code)

| Fact | Where |
| --- | --- |
| `addProject(path?)` only registers an existing folder; no folder or repo creation | `service.ts:678` |
| `removeProject(id)` stops agents and drops Harbor's records only; folder, `harbor/*` branches and worktrees stay | `service.ts:703`, `store.ts:274` |
| No `push` anywhere in `src/main`, `src/shared`, or the renderer | grep |
| Leads: "Plain git push only when asked to publish"; AGENTS.md: never push `main` | `prompts.ts:180` |
| `Git.removeWorktree(repo, root, path, branch?)` already refuses paths outside Harbor's worktrees root; stale-worktree pruning exists (14 days, keeps the branch) | `git.ts:432`, `orchestrator.ts:645` |
| `projectPathRefusal` refuses unsafe project paths (home, drive roots, ...) | `projectPath.ts` |
| Git works from the shell: `gh` is logged in as Zemodeler (keyring), `credential.helper=manager` | checked |
| Latest contract version is 0.1.46 | `src/shared/CHANGELOG.md` |
| `addProject` and `openProjectFolder` are remote scope `never`; `removeProject` is `full` | `remote/scopes.ts` |

## Decisions (defaults; the owner can flip any of these before P3)

| # | Decision | Default | Why |
| --- | --- | --- | --- |
| D1 | Can Delete remove the project folder? | **Yes, as an explicit third level**, never the default, behind a typed-name confirmation | The owner wants easy deletion; leaving junk folders defeats it. Only safe when the folder is verified clean or the owner types the project name. |
| D2 | Can Push go to `main`? | **No.** Push is allowed for `harbor/*` and any non-default branch. A default-branch push needs a per-push "push main" confirmation that names the commits | Matches AGENTS.md; keeps the one irreversible-ish action deliberate. |
| D3 | Where do new projects live? | A configurable **projects folder**, default `%USERPROFILE%\Documents\Harbor Projects` | One predictable place; new setting is optional so old state loads. |
| D4 | GitHub repo creation | Through the `gh` CLI the owner already has, visibility **private** by default | No new dependency, no token handled by Harbor (AGENTS.md: never read credentials). |
| D5 | Credentials | Harbor never reads or stores them. Git and `gh` use their own credential helpers. Git runs with `GIT_TERMINAL_PROMPT=0` so a missing login fails fast with a clear message instead of hanging | Safety rule; avoids a hung child process. |
| D6 | Remote (phone) access | `createProject`, `deleteProject`, `pushBranch`, `createPullRequest` are all remote scope `never` | Disk deletion and publishing stay desktop-only, like `addProject`. |

## Contract changes (0.1.47, optional members and new methods only)

All in `src/shared/api.ts`; each new method gets its name in `INVOKE_METHODS` (`ipc.ts`), validation in `ipcValidate.ts`, a scope in `remote/scopes.ts`, an implementation in `createHarborService`, a mock in `renderer/mock/mockApi.ts`, and a test. One `CHANGELOG.md` entry (newest first) in the same commit.

```ts
interface NewProjectDraft {
  name: string;                 // 1-80 chars; becomes the folder name (sanitised, see below)
  parentDir?: string;           // default Settings.projectsDir
  template?: 'empty' | 'node-ts' | 'python' | 'static-web';
  github?: { create: true; visibility: 'private' | 'public'; owner?: string } | { create: false };
  firstPrompt?: string;         // optional: sent to a fresh conversation after creation
}
interface CreateProjectResult { project: Project; path: string; remote?: string; warnings: string[] }

type DeleteScope = 'forget' | 'worktrees' | 'folder';
interface DeletePreview {
  projectId: Id; path: string;
  running: number;                         // agents that would be stopped
  worktrees: { path: string; branch?: string; dirty: boolean; unmergedCommits: number }[];
  branches: { name: string; unpushed: number; merged: boolean }[];   // harbor/* only
  folder: { exists: boolean; dirty: boolean; unpushedCommits: number; hasRemote: boolean; sizeBytes?: number; outsideProjectsDir: boolean };
  blockers: string[];                      // e.g. "folder is the Harbor app's own repo"
}
interface DeleteResult { removed: { records: boolean; worktrees: number; branches: number; folder: boolean }; warnings: string[] }

interface PushPreview { branch: string; remote?: string; upstream?: string; ahead: number; behind: number; isDefaultBranch: boolean; commits: { hash: string; subject: string }[]; secretScan?: SecretScanSummary; needsRemote: boolean }
interface PushResult { ok: boolean; output: string; remote: string; branch: string; pullRequestUrl?: string }
interface PullRequestDraft { branch: string; base?: string; title: string; body?: string; draft?: boolean }

// HarborApi (all optional methods)
createProject?(draft: NewProjectDraft): Promise<CreateProjectResult>;
previewDeleteProject?(id: Id): Promise<DeletePreview>;
deleteProject?(id: Id, scope: DeleteScope, confirmName?: string): Promise<DeleteResult>;
previewPush?(projectId: Id, branch: string): Promise<PushPreview>;
pushBranch?(projectId: Id, branch: string, opts?: { setUpstream?: boolean; allowDefaultBranch?: boolean }): Promise<PushResult>;
createPullRequest?(projectId: Id, draft: PullRequestDraft): Promise<{ url: string }>;
setRemote?(projectId: Id, url: string): Promise<void>;     // add or change `origin` (https/ssh URL only)
Settings.projectsDir?: string;                              // optional, D3
```

`removeProject` stays unchanged (it is the "forget" level; `deleteProject(id,'forget')` calls it).

## Phases

### P0 Baseline and branch
- New worktree and branch `harbor/project-lifecycle` off `main`. In the worktree run `npm --prefix src/renderer install` (remove the lock-file change afterwards) per the saved worktree note, then `npm test`, `npm run typecheck`, `npm run build`, `npm --prefix src/renderer test`. Record results; never run two `npm test` in parallel.
- Commit nothing from the main checkout's uncommitted renderer edits.

### P1 Core git helpers (`src/main/git.ts`, tests in `tests/git.test.ts`)
New methods on `Git`, all pure wrappers over `exec` with the existing timeout constants, and a `GIT_TERMINAL_PROMPT=0` environment:
- `init(path, defaultBranch='main')`, `initialCommit(path, message)` (needs a committer identity; fall back to the owner's global config and say so in `warnings` if missing).
- `remoteUrl(repo, name='origin')`, `setRemote(repo, url)` with URL validation (https or ssh only; reject `file:`, `ext::`, `-` prefixed args; pass as a separate argv element after `--`).
- `defaultBranch(repo)` (from `origin/HEAD`, else `main`/`master`, else current).
- `aheadBehind(repo, branch)` and `unpushedCommits(repo, branch)`.
- `push(repo, remote, branch, {setUpstream})`: plain `git push`, **never** `--force`, `--force-with-lease`, `--mirror`, or `--delete`; the argv builder rejects them and a test pins that. Maps stderr to friendly causes: not authenticated, no remote, non-fast-forward (tell the owner to merge or rebase first), protected branch.
- `deleteBranch(repo, name)` reuses the `harbor/` prefix guard that `removeWorktree` uses; refuses any other branch name and refuses a branch checked out in a worktree. Uses `-D` only when preview showed it unmerged **and** the owner chose `worktrees` or `folder`.
- Tests (real git, temp dirs; a second bare repo as `origin` for push): init+commit, push new branch, push rejected non-fast-forward, argv builder rejects force flags, branch guard, URL validation.

### P2 `gh` wrapper (`src/main/github.ts`, new, tests with an injected runner)
- `ghStatus()` (installed? `gh auth status` parsed without printing the token), `createRepo({name, visibility, owner, sourcePath})` via `gh repo create ... --source <path> --remote origin`, `createPr({...})` via `gh pr create --head ... --base ... --title ... --body-file -` (body on stdin, never argv), returns the URL.
- Never captures or logs tokens; strips anything matching the existing secret patterns from error text.
- Absent `gh` gives a typed "needs gh" outcome; creating a local project still works and `warnings` says the repo was not created, with the exact one-line fix.
- Tests: injected runner for success, not installed, not logged in, name taken.

### P3 Create project (`src/main/projectCreate.ts`, new; wired in `service.ts`)
Steps, each recoverable:
1. Validate name; sanitise to a folder name (Windows reserved names `CON`, `NUL`, ..., trailing dots/spaces, length, case-insensitive collisions via `normPath`). Refuse if the target exists and is not empty; refuse targets that `projectPathRefusal` rejects; refuse targets inside Harbor's own data or worktrees root.
2. `mkdir`, write the template files (small static string maps in `src/main/templates.ts`, no dependencies): `empty` = README + `.gitignore`; `node-ts` = `package.json`, `tsconfig.json`, `src/index.ts`, `.gitignore`; `python` = `pyproject.toml`, `main.py`; `static-web` = `index.html`. Also write a short `AGENTS.md` stub so Claude/Codex agents get conventions from turn one.
3. `git init`, initial commit.
4. If `github.create`: `gh repo create`, then optional first push of `main` (this one push of the default branch is the **initial publish of a brand-new empty repo**, shown in the confirmation, not an exception to D2 for existing repos).
5. Register through the same code path as `addProject` (`upsertProject`, `ensureProject`).
6. If `firstPrompt`, create a conversation and `send` it.
- Failure rollback: remove only what this call created (a folder that did not exist before; never a pre-existing one), delete a just-created repo only if the owner opts in (default: leave it and report, since deleting remote repos is out of scope). Return `warnings` for partial results.
- Tests: each template, name sanitising table, collision refusal, rollback after failing step 3/4, registration, GitHub path with the fake runner.

### P4 Delete project (`src/main/projectDelete.ts`, new)
- `previewDeleteProject` is read-only: lists the project's worktrees (agent records plus `git worktree list`), the `harbor/*` branches with unmerged and unpushed counts, and folder state. Blockers: the project path is the folder Harbor itself runs from, the folder is not inside `projectsDir` and not a git repo Harbor created (`outsideProjectsDir` makes the UI demand the typed name), the path fails `projectPathRefusal`.
- `deleteProject(id, scope, confirmName)`:
  - `forget`: today's behaviour.
  - `worktrees`: stop agents; for each worktree `removeWorktree` (already path-guarded), then `deleteBranch` for `harbor/*` only; then drop records; then `pruneWorktrees`. Dirty worktrees or unmerged branches require `confirmName` to equal the project name; the preview shows the commits that would be lost.
  - `folder`: everything above, then delete the project folder. Hard rules: `confirmName` must match exactly; the folder must still equal the stored project path (re-resolved with `realpath`, no symlink escape; junctions inside it are unlinked, not followed, so a linked `node_modules` cannot delete its target); refuse if the folder contains unpushed commits on a branch with no remote unless `confirmName` matches (the preview says "N commits exist nowhere else"); delete via `fs.rm` with `recursive`, in a retry loop for Windows file locks (EBUSY/EPERM, 3 tries), and report leftovers in `warnings` instead of failing the whole call.
  - Order is records last: if disk removal fails midway the project stays visible and retryable.
- Never touches the GitHub remote.
- Tests: forget parity with today; worktrees scope removes only Harbor worktrees and `harbor/*`; refuses a non-`harbor/` branch; folder scope with wrong name, junction safety, dirty and unpushed warnings, retry on a simulated lock, project path guard.

### P5 Publish (service + orchestrator integration)
- `previewPush`: branch, remote, ahead/behind, commit list, default-branch flag, **secret scan of the commits to be pushed** using the existing `secrets.ts` scanner (same allowlist and override rules as integration), `needsRemote`.
- `pushBranch`: refuses a default-branch push unless `allowDefaultBranch` (the UI sets it only after the named confirmation); refuses when the secret scan has findings that are not allowlisted or overridden; refuses a branch with a running agent writing to it; runs `Git.push` and records a `coordination` entry plus a message in the conversation ("Pushed harbor/x to origin, N commits").
- `createPullRequest`: push first if needed, then `github.createPr`; returns the URL; the base defaults to the repo's default branch.
- `setRemote` validates the URL (P1) and refuses overwriting an existing `origin` without an explicit flag in the UI.
- Prompt change (`prompts.ts:180`): lead text becomes "Harbor can push and open PRs for the user from its Git view; do not run `git push` yourself unless the user asks you to in chat." This keeps leads unable to bypass the secret scan by accident. Update the matching prompt tests.

### P6 Renderer (UI-owned; override covers this)
- **New project** button (sidebar, empty state, and the Onboarding "Choose project folder…" screen gets a second path "Start a new project"). Dialog: name, location (shows the resolved path live), template radio, "Create a private GitHub repository" checkbox (disabled with a hint when `gh` is missing), optional first prompt. Primary action "Create project"; progress states for the steps; partial-success warnings shown inline.
- **Delete** replaces the single "Remove project" confirm in `ProjectSettings.tsx` with a three-level chooser that reads `previewDeleteProject`: "Remove from Harbor" (default), "Also remove Harbor's worktrees and branches (N)", "Also delete the folder (size, path)". The destructive levels show the preview lists, require typing the project name for the folder level (and for dirty/unmerged cases), and use the existing danger button style. Keep the existing accessible names for "Keep project" and "Remove project" so current tests keep passing; the new levels add new names.
- **Git view** (exists): add Push and "Open pull request" actions to the branch header, with the push preview (commits, secret scan result, behind warning) in a small confirmation. A default-branch push shows a stronger confirm naming the commits.
- Multi-project ergonomics: project switcher keyboard shortcut, "New project" in the command palette if one exists, recent projects first (`lastOpened` already stored).
- Settings > General: "Projects folder" field with folder picker (needs a `pickFolder`-style call that already exists for `addProject`).
- Mock API implements every new method with realistic delays and failures so the demo build (`npm run dev:renderer`) shows all states.
- Tests (RTL, query by role/name): create flow happy path and each warning; delete levels, typed-name gating, disabled buttons while pending, preview rendering; push confirm and default-branch gate; Settings field.

### P7 Housekeeping across all projects (small, high value for "many projects")
- Settings > Storage: list Harbor worktrees by project with age, size and merged state, "Clean up merged and stale" (reuses `staleWorktrees` and `removeWorktree`; branches are deleted only when merged and `harbor/*`). The 14-day automatic prune keeps its current behaviour.
- Orphan detection: worktree folders whose project no longer exists (left by earlier `removeProject` calls) are listed and removable.

### P8 Verification, docs, and hand-off
- `npm test`, `npm run typecheck`, `npm run build`, `npm --prefix src/renderer test` all pass; record counts.
- Manual real-machine check (needs the owner's signed-in `gh`): create a project with a private repo, run one trivial lead task, push the `harbor/*` branch, open a PR, delete with each of the three levels on throwaway projects. Report what was and was not run.
- Update `BACKLOG.md` (core and UI sections), `HANDOFF.md` (the "No worktree or branch is ever deleted automatically" line), `src/shared/CHANGELOG.md` 0.1.47. Add README/doc notes as a BACKLOG "doc reconcile" item for the product owner.

## Order and parallelism

P0 -> P1 -> (P2 and P3 can overlap once P1 lands) -> P4 -> P5 -> P6 -> P7 -> P8. P6 can start against the mock API as soon as the P-contract commit (types only) lands, since the renderer builds against `api.ts`. Core phases touch `git.ts` and `service.ts`, so they run one at a time; renderer work touches only `src/renderer/**` and can run in parallel with P3-P5. Rough size: P1 S, P2 S, P3 M, P4 M, P5 M, P6 L, P7 S, P8 S.

## Risks and how the plan handles them

| Risk | Handling |
| --- | --- |
| Deleting the wrong folder | Typed-name confirm, `realpath` re-resolution, `projectPathRefusal`, junction unlinking, preview lists everything, records removed last |
| Losing work that exists nowhere else | Preview counts unmerged and unpushed commits and dirty files; extra confirmation when nonzero |
| Pushing secrets | Existing secret scanner runs on the exact commits to push; findings block unless allowlisted or overridden |
| Force-push or branch deletion creep | Argv builder rejects force flags; delete-branch guarded to `harbor/*`; tests pin both |
| Hung git on missing login | `GIT_TERMINAL_PROMPT=0`, timeouts, friendly error mapping |
| Windows file locks on delete | Retry loop, partial results reported as warnings, project stays retryable |
| Contract drift | Optional members only, one CHANGELOG entry, IPC list/validation/scope/mock/test for each method |
| Remote API exposure | All four destructive/publishing methods are scope `never` |
| Template maintenance | Templates are small static data; `empty` is the safe default |

## Not in scope (put in BACKLOG)

Deleting the GitHub repo, importing a repo by URL ("clone and register"; a natural next step reusing `setRemote`), GitLab/other hosts, signing commits, tag/release management, a Harbor-hosted remote.

## Done criteria

A change is done only when `npm test`, `npm run typecheck`, `npm run build` and the renderer tests pass, and the final report states what was verified on this machine versus left for the owner's signed-in check.
