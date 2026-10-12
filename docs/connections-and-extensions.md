# Automatic connections, skills, and plugins

Status: CLI discovery, sign-in checks, enable/disable and native sign-in are implemented for Claude Code and Codex (Gemini CLI is detected only). Native skills and plugins are not discovered or routed on by Harbor; they work only inside each CLI's own session. This page says, per CLI, which capabilities are verified against a real install and which are not. "Verified" means the repository's own notes record a run against a real install; nothing here was re-run when this page was written.

## Core principle

Install Harbor and start working. Discovery, connection checks, and reuse of the CLI's own sign-in happen automatically. Settings offer control without becoming a prerequisite.

This path assumes at least one supported CLI (Claude Code or Codex) is installed and signed in. When it is not, Settings says so and offers the shortest supported path: the CLI's own installer, then its own sign-in flow.

## First launch

1. The project interface opens immediately.
2. Harbor discovers the CLIs in the background: it looks for `claude`, `codex` and `gemini` on PATH (with PATHEXT), in `%APPDATA%\npm`, in `~\.local\bin`, in `~\.claude\local`, in the folders bundled with the Claude desktop app (`%APPDATA%\Claude\claude-code\<version>\<hash>`) and the Codex desktop app (`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>`). The environment variables `HARBOR_CLAUDE_PATH`, `HARBOR_CODEX_PATH` and `HARBOR_GEMINI_PATH` override the path.
3. For each installed CLI it runs the version command and a non-interactive sign-in check where one exists.
4. Enabled, signed-in, adapter-backed CLIs become eligible for routing.

Harbor does not install tools, change authentication, enable plugins, or alter native configuration during a scan. A CLI that was seen and then disappears (the Claude desktop app swaps its folder when it updates) is re-checked a few times at growing intervals before it is shown as missing.

## Connection states

| State shown | Meaning | User action |
| --- | --- | --- |
| Not installed | No executable was found. | Optionally install it with its native installer, then refresh. |
| Needs login | Installed; the sign-in check says signed out (or a run just reported a login failure). Removed from routing until refreshed. | "Sign in" opens a normal `cmd` window running the CLI's login. |
| Status unknown | Installed; the sign-in state could not be established (the check failed, or the CLI has no check). Still eligible, with a small routing penalty. | Refresh, or open the native tool. |
| Ready | Installed and the check says signed in. | Start working. |

The earlier design also named "Checking" and "Unavailable" states; the screen shows a "Checking..." label while refreshing, and does not have a separate "Unavailable" state. Authentication and remaining allowance are separate: a signed-in CLI can be out of allowance, and missing usage data never means logged out.

Discovery never launches an interactive login and never reads or displays credential secrets. Sign-in is each CLI's own flow, and Harbor does not read or store credentials. Opening a login window is Windows only.

## Settings experience

Settings > Connections lists each detected CLI with its name, status, version when available, a note, a Refresh action, "Sign in to <CLI>" for a CLI that needs login, and an Enable switch (a disabled CLI is never routed to). Not built: showing the installation path and last check time, an optional manual executable path in the UI (use the environment variables), and per-adapter capability display.

## Capability verification

| Capability | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| Discovery and version | Verified against `claude` 2.1.293 (including the executable bundled with the Claude desktop app). | Verified: the Codex desktop app's bundled executable is found; version from `--version`. | Detected on PATH; `--version` only. |
| Sign-in check | `claude auth status --json` (`loggedIn`). The signed-out result was seen on a real install. | `codex login status`, parsed from its text output. Recorded as parsed from documentation, not verified. | None exists; status is unknown. |
| Headless run, streamed output, session id | Verified (flags accepted by 2.1.293; stream-json parsing checked against a real result; a real signed-in `npm run smoke -- claude --full` run was recorded). | Verified on codex-cli 0.160.0: `codex exec --json`, prompt on stdin, session id capture and event shapes. | No adapter. |
| Resume a session | `--resume` with a captured id; covered by the smoke script. | `codex exec resume <id>`; it rejects `-s`, so the sandbox is passed as a config value. A full resume flow is not recorded as verified. | No adapter. |
| Effort | `--effort` accepted by 2.1.293. | `-c model_reasoning_effort=<level>` (low, medium or high); value handling per model is not verified. | No adapter. |
| Model selection | `--model` with aliases `haiku`, `sonnet`, `opus`; the `claude-fable-5-1` id is not verified. | Only Codex's default model; no named model ids are verified or listed. | No adapter. |
| Read-only, edit and full modes | `--permission-mode plan`, `acceptEdits` plus an allowlist, and `bypassPermissions`. The first two verified as accepted flags; `bypassPermissions` unverified. | `-c sandbox_mode=read-only`, `workspace-write`, `danger-full-access` with `approval_policy=never`. The read-only and workspace-write sandboxes were used in the smoke run; the full-access values are unverified. | No adapter. |
| Write access to a worktree's git metadata | `--add-dir` with the worktree's git folders; `--add-dir` itself is unverified. | `sandbox_workspace_write.writable_roots` added after a real run showed commits failed in the sandbox; the fix itself is not verified. | No adapter. |
| Tool permission prompts to Harbor | stream-json control channel (`--permission-prompt-tool stdio`): `--input-format stream-json` and an `initialize` round trip were checked without a model call; the live `can_use_tool` request and response shapes, and that deny rules are evaluated before the host is asked, are taken from the Agent SDK and unverified. | Impossible: `codex exec` has no host approval channel. Runs are confined by Codex's sandbox. | No adapter. |
| Deny dangerous git commands | `--disallowedTools` rules plus a command check in the control channel. Rule syntax and precedence over allow rules unverified. | Not available; Harbor only detects after the fact if a lead merged a helper branch. | No adapter. |
| Block native sub-agents | `--disallowedTools Task Agent` (flag accepted; documented tool names). | Not verified that Codex has none, or how to disable them. | No adapter. |
| Cancellation | Process-tree kill with `taskkill`, tested against fake CLIs. | Same. | No adapter. |
| Usage and limits reporting | `rate_limit_event` in the stream gives five-hour, weekly and per-model windows, seen only during Harbor runs; per-model key names are inferred. | The newest session logs under `~/.codex/sessions` carry the account's five-hour and weekly windows; Harbor reads them and never opens auth files. Format not verified across versions. | None. |
| Images | `--add-dir` for the image folder plus a note to read the files; unverified. | `--image` per file; unverified. | No adapter. |

A capability that fails verification for a given CLI version should be reported as unsupported rather than assumed. In practice that means: if Claude's permission prompts or git denials do not work on your version, see [Safety](safety.md) before relying on them.

## Native skills and plugins

Claude Code and Codex load their skills, plugins, `CLAUDE.md`/`AGENTS.md` and user configuration themselves when Harbor starts them in the project folder (or a helper's worktree) as your user. That is the only support today:

- No discovery, listing or compatibility states in Harbor, no composer picker, and no routing on skill descriptions.
- Project-level extensions that live in the repository reach a helper only if committed (a worktree is created from a commit). User-level extensions come from your profile and apply to every run.
- Discovery does not authorize execution. A skill's actions follow your request and the CLI's permission settings; Harbor's allowlist and deny rules apply to Claude runs.
- A Claude skill or plugin is not a Codex one, and a handoff to another CLI carries Harbor's written handoff, not the extension's state.

This remains the design intent, not behavior: prefer the owning CLI when a request depends on a specific extension, show extension states (available, needs setup, disabled, unsupported, compatibility unknown), never claim Harbor changed a native plugin's enabled state, and never auto-install or enable plugins during a scan.

## Focused adapter rollout

Claude Code and Codex were chosen as the first adapters. Status of the lifecycle verification: discovery and sign-in (done for Claude, partly for Codex), launch and streamed output (done for both on the versions above), permissions (Claude only, partly unverified), cancellation and recovery after failures (tested against fake CLIs and real git, not against a real CLI mid-run), session resume (Claude covered; Codex partly), workspace isolation through worktrees (tested with real git; Codex needed an extra writable-roots fix whose effect is unverified), managed-agent constraint (Claude enforced by flag; Codex unverified). Additional CLIs would start as detected-only with their limits labeled; there is no baseline terminal adapter, and a detected executable does not establish compatibility.

## Open questions

- Which of Codex's remaining flags (images, full access, writable roots, effort values per model) behave as documented on current versions?
- Does Claude's control channel behave as the adapter assumes on a live turn, and do deny rules win over allow rules?
- Which native extensions can be discovered, and which are usable only through native delegation?
- How should an isolated worktree inherit project extension configuration for each CLI?
