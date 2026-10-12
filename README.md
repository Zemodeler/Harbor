# Harbor

![Harbor icon](design/harbor-icon.png)

Harbor is a Windows desktop app that runs the AI CLIs you already have (Claude Code, Codex) against a local project. Open a folder, describe the work, and Harbor picks the CLI, model and effort for each run. It uses no API keys and calls no model itself.

Personal, open-source, one developer. No team features, and no promise of saving money ([limitations](docs/limitations.md)).

## How it works

1. A cheap **concierge** answers trivial messages or escalates.
2. A **lead** agent (a normal CLI session in your folder) does the work.
3. When it pays off, the lead hands pieces to **helpers**, which work in their own git worktrees. Harbor schedules them and runs your checks.
4. Approved branches are merged into a `harbor/integrate-*` branch. Your branch moves only when you press **Apply** (fast-forward). Harbor never pushes.

Modes: `default` (asks before risky tools), `plan` (read-only), `goal` (keeps going), `auto` (no prompts). `/deep` forces a strong model.

You can open any project or helper worktree in a terminal, your editor, or Explorer (Ctrl+K, or the buttons on a helper card).

## Install

Download `Harbor-Setup-<version>.exe` from [Releases](https://github.com/Zemodeler/Harbor/releases). It is unsigned, so SmartScreen warns once: **More info, Run anyway**. Harbor updates itself ([RELEASING.md](RELEASING.md)). Windows only.

## First run

Install and sign in to `claude` and/or `codex`. Harbor finds them automatically (override with `HARBOR_CLAUDE_PATH` / `HARBOR_CODEX_PATH`); Settings > Connections shows their state. Harbor never touches credentials.

To verify helper work, add `.harbor/checks.json`, e.g. `{"checks": ["npm test", "npm run typecheck"]}`. Harbor asks you to approve the commands before running them.

## Status

Young. Tests run without network or real CLIs. Claude Code and Codex basics were checked on real installs; a multi-helper run with a real model, Codex as lead, and auto-update are not verified ([limitations](docs/limitations.md)).

Data lives in `%APPDATA%\Harbor\` and survives uninstall. Harbor never deletes a branch.

## Development

```
npm install      # then: node node_modules/electron/install.js if electron/dist is missing
npm run dev
npm test && npm run typecheck && npm run build   # all three must pass
npm run smoke    # real CLI check, uses a little quota
```

Rules and file ownership: [AGENTS.md](AGENTS.md). Open work: [BACKLOG.md](BACKLOG.md). MIT ([LICENSE](LICENSE)).

## Docs

[Architecture](docs/architecture.md) · [Safety](docs/safety.md) · [Routing and usage](docs/routing-and-usage.md) · [Limitations](docs/limitations.md) · [Releasing](RELEASING.md)
