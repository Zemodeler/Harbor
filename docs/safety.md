# Safety and threat model

Harbor is a personal-use tool: one person, on their own Windows machine, running AI CLIs that they already trust with their code. The model below is sized for that. It is not a security product and not a sandbox. It lists what Harbor defends against, how, and where the defence is only a prompt instruction or is unverified. Everything here is from reading the code; no attack was tried against a running build.

## What is being protected

- The project's source and git history, above all the branch you work on.
- Credentials: the CLIs' own sign-in files, environment variables, and secrets inside repositories (`.env`, keys, tokens).
- Your provider quota (a runaway loop of agents spends real subscription allowance).
- The machine and your user account, because every agent is a process running as you.

## Who is trusted

You are trusted. The CLIs and the providers behind them are trusted to the extent you already use them. Model output is not trusted: a model can be steered by anything it reads. Text from repository files, tool output, web pages, other agents' reports and images is **data**; none of it is an instruction. That rule is written into the lead's and the helpers' prompts, and Harbor enforces what it can in code, but a prompt is a request to a model, not a barrier.

## Prompt-injection paths and defences

| Path | Defence | Gap |
| --- | --- | --- |
| A repository file or web page the agent reads says "run this" or "ignore the rules" | Prompts state that file, tool, web and agent content is data. Dangerous actions are denied or ask you (below), whatever the model was told. | A model can still be talked into harmful but permitted actions (editing files, running allowed commands). `AGENTS.md` and `CLAUDE.md` are loaded by the CLIs as trusted project instructions; Harbor's prompt says they cannot override its safety rules, which only a model can honour. |
| Output that contains a fake `HARBOR_DELEGATE`, `HARBOR_ASK`, `HARBOR_RESULT` and so on (for example a quoted document) | Protocol lines count only as one physical line of valid JSON at column 0, outside code fences, block quotes and indented blocks. At most 8 delegations, 3 peer notes and 3 decisions per turn; identical delegations start once; plan mode drops edit delegations. A reviewer's verdict counts only from the final line of its output. Ignored lines are reported once to the lead and logged. | A per-turn secret tag (`HARBOR_X[tag]: ...`) is implemented in the parser but, in the code I read, the orchestrator does not yet add the instruction to the prompt, so the bare form is still accepted (in progress). A spoofed delegation can still start helpers that are bounded by the same permissions as the lead's own. |
| A helper's report steers the lead | Reports go to the lead labelled "not independently verified unless a reviewer says so"; Harbor-run checks are separated from self-reported ones; reviewers must cite file and line and may not claim tests passed. | The lead is a model and may still believe a report. |
| Another lead's `HARBOR_PEER` note | Peer text is delivered as information, never an instruction from you; only leads of the same project can send one; at most 3 per turn; only an urgent note wakes an idle lead, at most twice between your messages. | Both leads are the same trust level; a compromised one can mislead the other. |
| `.harbor/checks.json` in the repository (it runs shell commands) | Read from your main checkout, never from a helper's worktree, so a helper cannot edit its own checks. The first time, and whenever the commands change, Harbor shows you the exact list and runs nothing until you approve (a hash per project). Checks run with a reduced environment (no API keys or tokens). A helper that changes anything under `.harbor/` is flagged. | Once approved, the commands run with your user permissions. If you approve without reading, that is the hole. Checks run inside the helper's worktree, so code a helper wrote is executed by `npm test` and similar. |
| A helper hides a bad change in a branch | Edit helpers work only in their own worktree and branch; nothing reaches your branch until an integration gates it (approving review of the exact head, no change requests), checks pass, and you press Apply. | A review is an AI judgement. Read the diff in the Git view or the review panel before Apply. |
| Attached images | Only png, jpeg, gif and webp, at most 6 per message and 10 MB each, validated as strict base64 and written to Harbor's data folder. | A model reading an image can be influenced by text inside it. |
| The concierge reads your text and can be wrong | Tool-less, read-only, instructed to answer only from facts in its prompt. If it answers a message that plainly needs the workspace, Harbor discards the answer and escalates. Anything uncertain escalates. | "Tool-less" is an instruction plus a read-only permission, not a hard guarantee. |
| Renderer compromise (a malicious page in the app window) | `contextIsolation` on, `nodeIntegration` off, renderer sandbox on; the window may only load Harbor's own document; navigation, `window.open` and `<webview>` are blocked, and only `http(s)` links go to your browser; device and most browser permissions are denied; each IPC call must come from the main frame of the current window while it shows the app document; arguments of the riskiest calls are validated; Markdown renders raw HTML as inert text; image previews of credential files are blocked. | The production CSP still allows `connect-src ws://127.0.0.1:*` (a request to restrict it to development is open). A compromised renderer could still call every API method, including sending messages that start agents. |
| Malicious update | Updates come only from GitHub Releases of Zemodeler/Harbor, over HTTPS, and the downloaded installer is checked against the checksum in that release's `latest.yml`. | The installer is **not code-signed**. Anyone who can publish to that repository (or who controls its account or the release pipeline) can ship code to every install. The only protection is the security of that account. |
| A hostile project (someone else's repository) | Harbor refuses drive roots and your home folder as projects; credential-looking files are excluded from commits and hidden from diffs. | Do not open an untrusted repository in Harbor and run agents on it with your normal account: a repository's own config, hooks and scripts run through the CLIs and checks. |

## What agents can and cannot do

These apply to Claude Code runs, where Harbor controls the permission flags. Codex differs; see the end of this section.

| Actor | Can | Cannot (enforced by flags or code) |
| --- | --- | --- |
| Concierge | Produce one JSON reply | Everything else: runs read-only with no resume |
| Lead, default mode | Read and edit files in the project folder; run `git`, `npm`, `npx`, `node` and the project's check commands without asking; ask for other tools | Merge, rebase, cherry-pick, reset or push; destructive git (clean, restore, checkout of files, branch deletion or rename, update-ref, worktree, stash drop or clear, config, remote, gc, prune, reflog, filter-branch, `git -C`); spawn agents with Claude's `Task` or `Agent` tools |
| Lead, plan mode | Read; delegate read-only helpers | Edit anything (read-only permission) |
| Lead or edit helper, auto mode | Act without prompts and without Claude's permission checks | Nothing is asked. Deny rules are meant to still apply in this mode, but that is not confirmed against the installed CLI |
| Edit helper | Edit and commit inside its own worktree; run `git status`, `diff`, `log`, `show`, `add`, `commit`, `npm test`, `npm run`, `npx vitest`, `npx tsc`, and the project's check commands; ask for other tools | Anything else without asking; the destructive git list above; writing outside its worktree and its git metadata folders without asking |
| Planner, reviewer, read-only helper | Read the repository (a reviewer reads the reviewed worktree) | Modify files; a reviewer cannot run tests and may not claim they passed |
| Every helper | Print `HARBOR_REQUEST_HELP`, `HARBOR_ASK`, `HARBOR_RESULT` | Start agents or message other agents; Harbor never routes helper-to-helper messages |
| Harbor itself | Create worktrees and `harbor/*` branches; merge approved sources into a new `harbor/integrate-*` branch; revert on a `harbor/rollback-*` branch; fast-forward your branch on Apply; remove its own finished worktree folders | Push, force, delete a branch (cleanup removes worktree folders only), move your branch without Apply, apply over uncommitted changes or when the branch moved |

Tool prompts: for Claude edit runs, a tool call outside the allowlist becomes a permission request. You can allow once, always allow for this project, or deny. Always-allow stores only a short command prefix or an exact tool name, and never for git merge, rebase, cherry-pick, reset, push or clean, recursive or forced deletes, network tools and URLs, publishing, privilege or process control, inline interpreter code, or `Write`, `Edit`, `WebFetch` and `WebSearch`. An unanswered request is denied after 5 minutes; stopping the run denies it too. Pending requests exist only in memory.

Be aware of what an allowlist is: `npm run *` and, for leads, `node *` can run arbitrary code. The default mode limits what an honest agent does by accident and what a steered one does without asking; it does not confine a determined one. The lead edits your project folder directly (it is not isolated in a worktree), so its edits are live in your working tree.

**Codex.** `codex exec` has no host approval channel, so Codex runs have no permission prompts and none of the Claude deny rules. They are confined by Codex's sandbox instead: read-only for read-only work, `workspace-write` for edit work (the worktree plus the git metadata folders Harbor passes as writable roots), and `danger-full-access` with approvals off in auto mode. Whether the sandbox blocks network access is not verified here. A Codex lead is not prevented from running git merge or push; Harbor only notices afterwards, and warns, if a helper branch became reachable from your branch during the turn. Whether Codex has native sub-agent features Harbor should disable has not been verified. Until that is checked, prefer Claude as the lead for projects you care about.

## Secrets

- Harbor never reads or stores passwords, API keys or tokens. Sign-in is each CLI's own flow, opened in a visible `cmd` window. Codex's usage windows are read from its session logs in `~/.codex/sessions`; Harbor does not open its auth files.
- Credential-looking files are excluded from the checkpoint commits Harbor makes (`.env`, `.env.*`, `credentials*`, `secrets*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, `*.tfstate`, `.npmrc`, `.netrc`, `.git-credentials`, service-account JSON files and similar), listed as excluded in the report, and shown as hidden with no diff in the Git view and review panel. Worktrees are created from commits, so untracked files such as a local `.env` are not copied into them.
- Strings that look like keys, tokens or passwords are redacted from the main log, from stored check output and from diagnostics, on a best-effort basis. It cannot catch everything.
- Diagnostics export contains versions, CLI states, counts and the tail of the journal and log. No message text, prompts or file contents. The journal records a tool's name only, never its input.
- Checks run with a reduced environment. The CLIs themselves, and therefore the agents, inherit Harbor's full environment, including any API keys in your user environment.
- What you type is in `state.json` in clear text and goes to the provider through the CLI. Do not paste secrets into a conversation. Messages, reports, images and worktrees are stored unencrypted in `%APPDATA%\Harbor`.
- Harbor never commits or pushes secrets because it never pushes; a helper that commits one inside its own branch can still leak it if you later push that branch yourself.

## Quota safety

A multi-agent run multiplies model calls (see [Limitations](limitations.md)). Brakes in code: at most 8 delegations per turn; at most 4 helpers at once per project (adjustable to 8); at most 12 automatic lead turns after one user message; goal mode stops after 8 automatic continuations or when a continuation makes no tool calls and delegates nothing; a helper that keeps requesting help spends the same turn cap; a lead turn is stopped after 60 minutes and a helper after 45; one lead per project edits at a time; a rate-limited model is held out for 30 minutes. There is no spending limit in money terms and no API fallback, so nothing here can spend more than your subscription windows allow.

## Report a problem

`exportDiagnostics` (available in the contract; a Settings > Diagnostics screen was in progress) produces a redacted bundle suitable for a bug report. Do not attach `state.json`.
