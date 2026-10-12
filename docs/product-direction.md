# Product direction

Status: Harbor is implemented and working but young; see the [README](../README.md) for what is verified and [Limitations](limitations.md) for the gaps. This document keeps the product intent and says where the implementation differs. Sections marked "Superseded" describe an earlier model that no longer applies; the current model is in [Architecture](architecture.md) and [Project agents](project-agents.md).

## Core idea

Make it easy on the user. The user installs Harbor and can immediately open a project and start working with an already installed, signed-in CLI. No provider setup wizard, routing configuration, or API key is required for that path.

Give one desktop interface for working on projects with the AI CLIs a person already pays for. Keep the experience familiar: choose a project, open a conversation, ask for work. The app handles provider selection, effort and coordination behind the scenes according to configurable policies.

Automatically discover installed CLIs and check their sign-in state. Settings show which tools are ready, which are installed but need login, and which have an unknown status. If no ready CLI exists there is one clear next action (install or sign in). Implemented for Claude Code and Codex; Gemini CLI is detected but cannot be used yet.

Automatic routing is a main capability, but it should not become the main visual experience. Users spend their time working with an assistant, not operating a routing dashboard. Harbor routes every request, but it is honest that routing and delegation add overhead; it does not promise savings (see [Limitations](limitations.md)).

Native Claude and Codex skills and plugins keep working inside their own CLI sessions. Harbor does not discover, list or route on them (not built; see [Connections and extensions](connections-and-extensions.md)).

## Audience and scope

Harbor is built for one developer with a Claude subscription and a Codex subscription (also used by a few friends), on Windows, working on local git projects. It is open source and personal-use. Team features, shared workspaces, cloud execution, deployment and GitHub publishing are out of scope. macOS and Linux are undecided.

## Product priorities

Harbor installs and behaves like a normal Windows app: an NSIS installer (unsigned), a Start menu entry, a pinnable taskbar icon, uninstall through Windows Settings, a native window with standard controls, restoration of projects on relaunch, and an optional tray mode that keeps agents running when the window is closed. Updates arrive through GitHub Releases ([RELEASING.md](../RELEASING.md)).

1. Organize everything by project. (Built.)
2. A familiar coding-assistant conversation interface. (Built.)
3. Coordinate multiple AI CLIs from the first version. (Built for Claude Code and Codex; one CLI per run, with fallback.)
4. Prefer installed CLIs and their existing subscriptions. (Built; there is no API use.)
5. Consider remaining subscription allowance when choosing a model and effort. (Built, with estimates and provider-reported windows where available; see [Usage and resets](usage-and-resets.md).)
6. API tokens as a configurable fallback. (Not built.)
7. Routing that is configurable and inspectable without interrupting ordinary work. (Engine built; a routing settings screen was in progress in the UI. The reason for each choice is stored with the message.)
8. Make it practical to add CLIs through adapters. (An adapter interface and registry exist; there is no baseline terminal adapter.)
9. Discover connections automatically; advanced configuration optional. (Built.)
10. Respect native skills and plugins. (They work in-session; Harbor has no discovery or routing for them.)
11. One lead per project that does the work itself when that is simplest and delegates when it pays off. (Replaces "a main agent that only delegates".)
12. Give each helper one clear responsibility; separate planning from implementation when a task needs it. (Built as helper roles; not mandatory.)
13. Let users prompt helpers directly. (Built: a message to a helper's conversation resumes that helper and is recorded for the lead's next turn.)

## Main concepts

### Project

A project is the top-level boundary of work. It has a local folder (a drive root or the home folder is refused), conversations, session history, and settings that can override the global ones. Switching projects restores that project's conversations; work from one project does not become context for another.

### Conversation

A conversation is the user-facing thread of work inside a project: requests, responses, tool activity, system notes and results. Each conversation has its own lead session (resumed natively between turns) and its own helpers. A conversation has a mode (default, auto, plan, goal). Helpers also have conversations scoped to their assignment, which you can open and message.

The conversation stays continuous when different CLIs contribute. Each response carries its CLI, model, effort and routing reason in execution details.

### Task

A task is a unit of requested work. Harbor does not impose a plan on it. Questions and small changes are handled by the lead itself in one session; work that splits into independent parts, needs a long research sweep, or deserves an independent review may be delegated by the lead to helpers.

### Concierge

Every user message first goes to a cheap, tool-less model that either answers (greetings, status of running work, explanations that need no files) or escalates with a complexity, needs and a one-line acknowledgement. Messages that are obviously work skip it. It exists to keep trivial messages off the expensive lead.

### Lead

An escalation starts or resumes the conversation's lead: a normal working CLI session that reads files, edits them, runs commands, answers questions, and may delegate. It keeps its own native session. The lead is chosen by the router like any other run, at a tier matching the concierge's complexity.

### Helper

A helper has one assignment, reports to the lead, and never creates other agents or talks to other helpers. Roles are planner, implementer, reviewer and other. Edit helpers work in their own git worktree and branch. See [Project agents](project-agents.md).

### CLI session

An underlying execution session of one CLI, tied to a conversation or a helper. Native session ids are preserved and resumed only on the same CLI. When another CLI takes over, Harbor writes a handoff (decisions, unfinished work, evidence against the commit it covered) instead of pretending sessions are interchangeable.

### Routing policy

Which installed CLIs and models are eligible, how they are scored, what effort is requested, how a low allowance is handled, and which preferences apply. Global defaults, per-project overrides, per-CLI model restrictions, role preferences. A user can also name a CLI in a message ("use codex"). See [Background routing](background-routing.md).

## Primary workflow

1. Add or open a local project.
2. Start a new conversation or resume one; optionally choose a mode.
3. Describe the work in the composer.
4. The concierge answers or escalates; the lead works, delegating only when worthwhile.
5. Harbor routes each run to a CLI, model and effort, schedules helpers (dependencies, concurrency, file locks), runs your `.harbor/checks.json` on their results, and resumes the lead with reports.
6. You can read the lead's streamed work, open a helper's conversation, answer questions and permission prompts, stop a run, or change the mode.
7. Finished, reviewed work is merged by Harbor's integrator into a `harbor/integrate-*` branch and lands on your branch only when you Apply it. A task can be rolled back the same way.

## Experience principles

- Install and start: use discovered, signed-in CLIs without mandatory configuration.
- Project context is always clear. Conversation is the main surface.
- Routing needs no manual selection for normal tasks, and its reasons are available on demand.
- Important blockers and decisions are visible: questions, permission requests, failures.
- Usage uncertainty is presented honestly: estimates are labeled; unknown is unknown.
- Settings use plain language and have predictable scope.
- Project switching preserves ongoing work; it does not cancel it.
- Nothing lands on your branch, is pushed, or spends a free reset without an explicit action from you.
- Helpers do one clear thing and follow a supplied specification; broader thinking belongs to the lead or a planner.

## Design scope

- A direct single-worker path for clear small tasks: this is the default. The lead does it, with no helper.
- Durable recovery without duplicate actions: Harbor records processes and agent state, stops and checkpoints interrupted helpers on restart, and tells the lead which reports may not have arrived. Native session resume is used where available. (Built; not exercised against real long runs.)
- Verification tied to the exact version tested: reviews and Harbor-run checks record the commit they covered and go stale when the branch moves. (Built.)
- Routing that preserves useful session continuity. (Built; see the continuity bonus in [Background routing](background-routing.md).)
- User-controlled queues with capacity reserved for interactive responses. Priority, pause and resume exist per project in the API. A cross-project queue and reserved interactive headroom are not built.
- Task-scoped rollback that preserves unrelated edits. (Built for merges Harbor's integrator made; see [Project agents](project-agents.md#task-scoped-rollback).)
- Focused adapter rollout: Claude Code and Codex first, each verified against a real install before breadth. (Done for the basics; gaps listed in [Connections and extensions](connections-and-extensions.md).)

## Design decisions

### First dedicated adapters

Claude Code and Codex are the two adapters. They are the CLIs the owner actually uses. Every other CLI is detected only. Each adapter's capabilities are verified against a supported version rather than assumed; what is and is not verified is listed in [Connections and extensions](connections-and-extensions.md).

### Active and archived conversations

A project keeps one history, and each conversation is active or archived. The sidebar shows active conversations. Archiving is manual and refused while a conversation has running work or pending requests; archived conversations stay searchable and keep their agents and reports. (The contract and engine support archive, pin, rename and search; check the UI for how much is exposed.)

### When a plan appears

Superseded: "the main agent shows a concise plan when work has several assignments". There is no automatic plan card. The lead explains what it delegates in a short line ("Delegated: ..."), and the user can ask for a plan explicitly by switching the conversation to plan mode, where the lead is read-only and answers with a numbered plan; a go-ahead ("yes, do it") leaves plan mode and the lead carries the plan out.

### Comparing allowance across providers

Harbor does not convert providers' units into one number. Each provider shows its own windows (5-hour and weekly, and per-model limits when the CLI reports them), each labeled reported or estimated, with a reset time when known. Routing derives a plain level (plenty, limited, low, exhausted) per model from its own windows and never compares percentages across providers directly. The Usage tab shows per-window percentages; the levels are used by the router, not displayed.

### API spending policy

Not built. The intent stands: API use off by default, no key needed to start, ask before use once a key exists, hard per-task and per-period limits if the user sets them. Nothing in the app can currently spend money; everything runs on the CLIs' subscriptions.

## Superseded: a main agent that never performs the task itself

The original design had one "main agent per project" that "only delegates, monitors and reports", never writes code, and delegates every substantive request, including to a planner for estimation. That model was replaced. The repository records no detailed rationale beyond the lead-rework notes in `BACKLOG.md`. The practical difference is that a coordinator-only model puts a delegate-and-wait cycle in front of every request, however small, and Harbor now avoids that. The replacement is the concierge plus lead model above. The lead may and usually does read, edit, run commands and test directly. "One logical lead per project" survives; "every substantive user request is delegated" and "the main agent does not investigate, design, implement, test, review or integrate" do not. Integration is the one thing the lead does not do itself: Harbor's integrator merges branches in code, and the lead is denied merging.
