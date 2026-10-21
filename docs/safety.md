# Safety

Harbor is a personal tool for one person on their own machine. It is not a sandbox or a security product, and none of what follows has been tested by attacking a running build.

**Protected:** your source code and branch, your credentials, your subscription quota, and your machine (agents run as you). **Trusted:** you and the CLIs, but not model output. Text from files, tools, web pages, skills, imported chats, other agents and images is treated as data, never as instructions. Every prompt says so, but a prompt is a request, not a barrier.

## Threats

| Threat | Defence | Gap |
| --- | --- | --- |
| Injected text steers an agent | Dangerous actions are denied or ask you first | A steered model can still do harm it is permitted to do |
| Fake `HARBOR_*` lines | A line counts only as single-line JSON at column 0, outside fences, carrying the per-turn tag; per-turn caps; a verdict is read only from the final line | Real models have not been checked for how well they follow the tag |
| Reports or peer notes steer the lead | Marked unverified; peer notes are information only | The lead is still a model |
| `.harbor/checks.json` runs commands | Read from your main checkout; you approve the exact commands, and are asked again if they change; reduced environment | Approved commands run as you |
| A helper hides a bad change | It works only in its own worktree, and its change reaches your branch only through an approving review, passing checks and your Apply | Reviews are AI judgement; read the diff |
| Compromised renderer | Context isolation, sandbox, no node integration, blocked navigation, IPC argument validation; `harbor-file://` serves only Harbor's own attachments | |
| Malicious update | GitHub Releases over HTTPS; `electron-updater` checks the file hash | **Unsigned**: whoever controls the repo account can ship code |
| Hostile repository | Drive roots and the home folder are refused; credential files are kept out of commits, diffs and the document viewer | Its hooks and scripts run through the CLIs; don't run agents on untrusted repos |
| Concierge is wrong | Runs with no tools (`--tools ""`), read-only; escalates when unsure | Its answers can still be wrong |
| Skills, MCP servers, custom CLIs | Skill imports are checked and run nothing; you approve a custom CLI's executable by its hash; an MCP server reaches a run only if each tool call can be asked about, or if you allowed it without asking | Once allowed, they run as you. The MCP registry is stored as plain text (an owner decision) |
| Screenshots | Every capture needs your yes, and the source is your pick in a live preview, never the agent's; at most one per agent per minute | A capture can show anything on that window or screen |
| Remote API | Off by default; loopback bind; TLS or an explicit plain-HTTP acknowledgement off-box; bearer tokens (hash stored) with scopes; no CORS; requests with an `Origin` header or an unexpected Host refused; desktop-only methods never remote | Unit-tested only. `full` scope can start work that runs as you. Plain HTTP over a network exposes tokens |
| Bundles | Built from an allowlist (no credentials, MCP or env values, CLI paths or session ids); a secret scan, with redaction offered; an imported bundle never approves checks | The secret scan is pattern-based |

## What agents can do (Claude runs)

- **Concierge:** writes one JSON reply, nothing else.
- **Lead:** edits your folder. It may run read-only git, `git add/commit/merge/rebase/cherry-pick/switch/fetch`, a bare `git push`, `npm`, `npx`, `node` and your checks without asking, and asks for anything else, as Claude Code does. Merging skips the reviewer gate, the secret scan and Apply (the lead is told to say so). Git has no hard deny list: reset, clean, restore, force or delete pushes, branch deletion, worktree, config, remote and `git -C` simply reach you as a prompt, marked "This can lose work or rewrite history" and never always-allowable. Only Claude's `Task`/`Agent` tools are denied. In plan mode it is read-only.
- **Edit helper:** edits and commits in its own worktree only. It may run limited git, `npm test`, `npx vitest/tsc` and your checks.
- **Planner, reviewer:** read-only. A reviewer cannot claim tests passed. Read-only runs get no MCP servers.
- **Any helper:** may only print protocol lines. It never starts or messages agents.
- **Harbor itself:** creates worktrees and `harbor/*` branches, merges, reverts, and fast-forwards on Apply. It never pushes, forces, deletes a branch, or moves your branch without Apply. It only removes worktrees under its own root that are on `harbor/*` branches.
- **`auto` mode** removes all prompts (`--permission-mode bypassPermissions`), git included, as in Claude Code.
- **`.harbor/permissions.json`** (`{"allow": [...], "deny": [...]}`, command prefixes, read from your main checkout): `deny` applies at once, to every CLI that asks through Harbor and to Claude as deny rules. `allow` applies only after you approve that exact list, and never for commands an always-allow rule could not cover (chaining, deletes, network, publishing).

Tool prompts offer three answers: allow once; always allow for this project (a command prefix or a tool name only; never for git write operations, deletes, network, publishing, privilege control, inline code, or `Write`/`Edit`/`WebFetch`/`WebSearch`); or deny. A prompt left unanswered for 5 minutes counts as denied. An allowlist does not confine anything (`npm run *` and `node *` run arbitrary code), and the lead's edits land live in your working tree.

**Codex** has no approval channel, so it gets no prompts and no deny rules, only its sandbox (read-only, `workspace-write`, or full access in auto mode). Whether its network blocking works is unverified, and a Codex lead can reset, force-push or delete branches without a prompt (Harbor does not even warn). MCP servers from your own `~/.codex/config.toml` still load. Prefer Claude as the lead for projects you care about.

## Secrets

- Harbor never reads or stores credentials. Sign-in is always each CLI's own flow. Codex usage is read from `~/.codex/sessions`, never from auth files.
- Credential-looking files (`.env*`, keys, `.npmrc`, `.netrc`, service-account JSON, ...) are kept out of Harbor's commits and hidden in diffs.
- An edit helper's commits and every integration are scanned for secrets (see [architecture](architecture.md)); a finding blocks the integration until you allow it. Pattern-based, so it misses things.
- Secret-shaped strings are redacted from logs, check output and diagnostics, on a best-effort basis. Diagnostics contain no message text.
- Agents inherit your full environment, including any API keys in it. Checks get a reduced one, and custom CLIs and MCP tests get a fixed allowlist of variables.
- What you type is stored in clear text and sent to the provider. Don't paste secrets.

## Remote API

Off by default (`remote.enabled`; `npm run headless` always serves it). It listens on `127.0.0.1:47821` by default. A non-loopback bind is refused without TLS (`tlsCertFile` and `tlsKeyFile`) unless `allowPlainHttp` says a tunnel already encrypts the traffic. Every request needs `Authorization: Bearer <token>`. A token has one scope: `read-only` (list/get methods and events), `answer-permissions` (adds answering permissions and questions) or `full` (methods that start, stop or change work; creating one needs `remote.allowFullScope`). A token is shown once and only its SHA-256 is stored. Opening windows, folders and terminals, sign-in, diagnostics export, adding project folders and token management are never remote; free resets are never answerable remotely; "always allow" needs `full`; `setSettings` cannot change `remote`. Settings are read once at startup. Only one Harbor (app or headless) may use a data folder at a time. Not verified outside unit tests.

## Quota brakes

Up to 8 delegations per turn, plus optional per-turn helper and planner limits (off by default; when set, the rest are created paused for you to resume). Helpers running at once: at most 3, set by the quota budget and the concurrency setting. At most 12 automatic lead turns per message. Goal mode stops after 8 continuations. Each lead turn stops at 60 minutes; helpers stop at 35 (soft) and 70 (hard) minutes. The loop guard stops looping helpers. Only one editing lead per project. Rate-limited models are kept out for 30 minutes. A reserve is held back for your interactive work. There is no API fallback, so nothing can spend beyond your subscription. Optional spend ceilings per task, 24 hours and 7 days (estimates from Harbor's own runs) ask you before a run starts and stop runs when reached.

Report problems with Settings > Diagnostics (`exportDiagnostics`). Don't attach `state.json`.
