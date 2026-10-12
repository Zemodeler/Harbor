# Safety

A personal tool for one person on their own machine. It is not a sandbox or a security product, and none of this was attacked on a running build.

**Protected:** your source and branch, credentials, your subscription quota, your machine (agents run as you). **Trusted:** you and the CLIs, not model output. Text from files, tools, web pages, other agents and images is data, never instructions; that is stated in every prompt, but a prompt is a request, not a barrier.

## Threats

| Threat | Defence | Gap |
| --- | --- | --- |
| Injected text steers an agent | Dangerous actions are denied or ask you | A steered model can still do permitted harm |
| Fake `HARBOR_*` lines | Only single-line JSON at column 0 outside fences; per-turn caps; verdicts only from the final line | Per-turn secret tag is parsed but not yet in prompts |
| Reports or peer notes steer the lead | Labeled unverified; peers are information only | The lead is a model |
| `.harbor/checks.json` runs commands | Read from your main checkout; you approve the exact commands (re-asked on change); reduced environment | Approved commands run as you |
| A helper hides a bad change | Own worktree only; reaches your branch only via approved review, passing checks and your Apply | Reviews are AI judgement; read the diff |
| Compromised renderer | Context isolation, sandbox, no node integration, blocked navigation, IPC validation | CSP still allows `ws://127.0.0.1:*` |
| Malicious update | GitHub Releases over HTTPS, checksum-checked | **Unsigned**; whoever controls the repo account can ship code |
| Hostile repository | Drive roots and home refused; credential files excluded from commits and diffs | Its hooks and scripts run via the CLIs; don't run agents on untrusted repos |
| Concierge wrong | Tool-less, read-only, escalates when unsure | "Tool-less" is partly an instruction |
| Open terminal/editor | User-started only; folder is an argument or cwd, editors via URL protocol; file paths must stay inside the folder | The terminal is a normal shell running as you |

## What agents can do (Claude runs)

- **Concierge:** one JSON reply.
- **Lead:** edits your folder; runs `git`, `npm`, `npx`, `node` and your checks unprompted; asks for anything else. Denied: merge, rebase, cherry-pick, reset, push, destructive git (clean, restore, branch deletion, worktree, config, remote, `git -C`), and Claude's `Task`/`Agent` tools. Plan mode is read-only.
- **Edit helper:** edits and commits in its own worktree; limited git, `npm test`, `npx vitest/tsc` and your checks.
- **Planner, reviewer:** read-only; a reviewer cannot claim tests passed.
- **Any helper:** may only print protocol lines; never starts or messages agents.
- **Harbor:** creates worktrees and `harbor/*` branches, merges, reverts, fast-forwards on Apply. Never pushes, forces, deletes a branch, or moves your branch without Apply.
- **`auto` mode** removes prompts; deny rules should still apply but are unconfirmed on the installed CLI.

Tool prompts: allow once, always allow for this project (command prefix or tool name only; never git write operations, deletes, network, publishing, privilege control, inline code, or `Write`/`Edit`/`WebFetch`/`WebSearch`), or deny. Unanswered after 5 minutes is denied. An allowlist is not confinement (`npm run *`, `node *` run arbitrary code), and the lead's edits are live in your working tree.

**Codex** has no approval channel, so no prompts and no deny rules, only its sandbox (read-only, `workspace-write`, or full access in auto). Network blocking is unverified, and a Codex lead can merge or push (Harbor only warns afterwards). Prefer Claude as lead for projects you care about.

## Secrets

- Harbor never reads or stores credentials; sign-in is each CLI's own flow. Codex usage comes from `~/.codex/sessions`, never auth files.
- Credential-looking files (`.env*`, keys, `.npmrc`, `.netrc`, service-account JSON, ...) are excluded from Harbor's commits and hidden in diffs.
- Secret-shaped strings are redacted from logs, check output and diagnostics (best effort). Diagnostics have no message text.
- Agents inherit your full environment, including API keys in it; checks get a reduced one.
- What you type is stored in clear text and sent to the provider. Don't paste secrets.

## Quota brakes

8 delegations per turn; 4 helpers per project (max 8); 12 automatic lead turns per message; goal mode stops after 8 continuations; lead turns stop at 60 minutes, helpers at 45; one editing lead per project; rate-limited models held out 30 minutes. No API fallback, so nothing spends beyond your subscription.

Report problems with Settings > Diagnostics (`exportDiagnostics`). Don't attach `state.json`.
