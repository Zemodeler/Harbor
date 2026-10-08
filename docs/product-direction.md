# Product direction

## Core idea

Make it easy on the user. The user installs Harbor and can immediately open a project and start working with an already installed, signed-in CLI. No provider setup wizard, routing configuration, or API key is required for that path.

Give users one desktop interface for working on projects with their preferred AI CLIs. Keep the experience familiar: choose a project, open a conversation, and ask for work. The app handles provider selection, effort, and coordination behind the scenes according to configurable policies.

Automatically discover installed CLIs and check their sign-in state. Settings show which tools are ready, which are installed but need login, and which have an unknown status. If no ready CLI exists, provide one clear next action to install or sign in to a supported tool. This is an exception to the immediate-start path, not a mandatory onboarding flow for everyone.

Use existing Claude and Codex skills and plugins through their native environments where supported. Preserve project and user configuration so work inside Harbor can benefit from the same extensions users already rely on.

Automatic routing is the main product capability, but it should not become the main visual experience. Users should spend their time working with an assistant, rather than operating a routing dashboard.

## Product priorities

1. Organize everything by project.
2. Provide a familiar coding assistant conversation interface, drawing on the general interaction patterns of Codex and Claude apps.
3. Coordinate multiple AI CLIs from the first version.
4. Prefer installed CLIs and their existing subscriptions.
5. Consider remaining subscription allowance when planning work and choosing effort.
6. Support API tokens as a configurable fallback.
7. Make routing configurable and inspectable without interrupting ordinary work.
8. Make it practical to connect additional AI CLIs through adapters.
9. Discover connections automatically and make advanced configuration optional.
10. Respect and support native Claude and Codex skills and plugins.
11. Give each project one main agent that only delegates, monitors, and reports.
12. Assign every subagent one clear responsibility; separate planning from implementation.
13. Let users prompt subagents directly while keeping the main agent informed.

## Main concepts

### Project

A project is the top-level boundary for work. It has a local folder, conversations, session history, routing preferences, and relevant working context.

Switching projects restores that project's conversation and workspace state. Work from one project must not silently become context for another.

### Conversation

The project's main agent is the default contact. Its conversations contain delegated work and consolidated reports. Each subagent also has an accessible conversation scoped to its assignment.

A conversation is the user-facing thread of work inside a project. It contains requests, assistant responses, progress, tool activity, and results.

The conversation remains continuous even when different CLIs contribute. It should be possible to identify the provider behind a response without making every response look like an orchestration report.

### Task

A task is a unit of requested work within a conversation. The router may divide it into planning, implementation, review, or other steps when that helps achieve the request.

Not every message needs a multi-step plan. The main agent can delegate a question or small edit to one suitable subagent. It never performs the task itself.

### Main agent

Each project has exactly one logical main agent. It receives requests, delegates work, monitors assignments, handles requests for sibling agents, and relays reports to the user. It does not investigate, design, implement, test, review, or integrate the work itself. Planning and estimation are delegated to a planning subagent.

### Subagent

A subagent has one clear assignment and reports to the project's main agent. An implementation subagent owns one designated feature or bounded change. Planning, research, review, testing, and integration belong to separate subagent assignments when needed.

Subagents cannot create other subagents. They request a sibling from the main agent. Users can inspect and prompt them directly. See [Project agents](project-agents.md) for role boundaries and communication rules.

### CLI session

A CLI session is an underlying execution session belonging to a project and conversation. One conversation can contain several CLI sessions.

Native session identifiers should be preserved when an adapter supports them. A handoff to another CLI creates a linked session with transferred context; it does not imply that native sessions are interchangeable across providers.

### Routing policy

A routing policy determines which connected CLIs are eligible, how they are assigned work, what effort to request, how allowance is conserved, and when API fallback is permitted.

Global defaults apply unless a project overrides them. Optional conversation overrides allow specific work to use a chosen CLI or policy.

## Primary workflow

1. Add or open a local project.
2. Start a new conversation or resume an existing one.
3. Describe the work in the composer.
4. The main agent delegates planning to a focused subagent when the request needs it.
5. Background routing assigns suitable CLIs and effort to the approved assignments under project policy.
6. The main agent dispatches subagents, monitors them, and receives their progress and completion reports.
7. The user can prompt the main agent or open a specific subagent's conversation.
8. The main conversation shows consolidated progress and results. Changes, linked CLI sessions, and individual reports remain inspectable.

## Experience principles

- Install and start: use discovered, signed-in CLIs without mandatory configuration.
- Existing native skills and plugins remain available where compatible.
- Project context is always clear.
- Conversation is the main surface.
- Routing requires no manual selection for normal tasks.
- Background decisions remain explainable on demand.
- Important blockers and budget decisions remain visible.
- Usage uncertainty is presented honestly.
- Settings use plain language and have predictable scope.
- Project switching preserves ongoing work; it does not implicitly cancel it.
- The main agent coordinates only; all substantive work is delegated.
- Each subagent does one clear thing and requests siblings through the main agent.
- Feature implementers follow a supplied specification; broader thinking belongs to a planning subagent.

## Design scope

The initial design covers a local desktop app, project navigation, conversations, CLI connections, background routing, multi-CLI coordination, allowance-aware effort, and optional API fallback.

Automatic connection discovery and native skills and plugins are part of the initial design. Shared web workspaces, deployment, and GitHub publishing are later stages. These documents do not authorize or describe completed implementation.

## Open design questions

- Which CLIs should receive dedicated adapters first?
- Should project conversations be grouped into active and archived lists, or remain in one history?
- Which activities warrant a visible plan in the conversation?
- How should users compare subscription allowance when providers expose different units?
- What default API spending policy should be offered during onboarding?
