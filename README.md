# Harbor

Harbor is a proposed desktop app for working on projects through AI CLIs in a familiar chat interface.

The core idea is ease of use: install the app and start working. It automatically discovers installed AI CLIs, checks whether they are signed in, and uses available connections with sensible defaults. Configuration is optional. Settings clearly show installed CLIs that still need login.

Projects are the primary organizing unit. Each project contains its own conversations, sessions, files, and preferences. The user opens a project, starts or resumes a conversation, and describes the work. Automatic routing happens in the background.

The app should feel like an everyday coding assistant, with a project sidebar, conversation history, a main conversation, and a composer. Routing controls belong in settings and optional execution details, rather than occupying the main workspace.

Each project has one main agent that assigns and monitors work. All substantive work goes to subagents with one clear responsibility. Users can also open a subagent's conversation and prompt it directly. Subagents request additional help from the main agent instead of creating agents themselves.

Subagents can converse normally. Implementation agents follow a defined specification while planning is delegated separately. The app automatically selects each subagent's CLI, model, and effort and tracks usage across projects to make effective use of subscription windows. Any confirmed optional free reset requires user permission before use.

Sibling agents communicate directly to coordinate dependencies, shared files, and handoffs. The app records their agreements, prevents conflicting edits, and keeps the main agent informed without making it relay every message.

## Design documents

Harbor is intended to install and launch like a regular Windows PC app, with a Start menu entry, taskbar pinning, standard window controls, and normal uninstall support. Its visual identity uses an anchor; see the [app icon](design/harbor-icon.png).

- [Product direction](docs/product-direction.md): goals, scope, and core concepts.
- [Interface design](docs/interface-design.md): project navigation, conversations, and settings.
- [Background routing](docs/background-routing.md): CLI coordination, subscription usage, effort, and fallback policies.
- [Connections and extensions](docs/connections-and-extensions.md): automatic discovery, login states, and native skills and plugins.
- [Project agents](docs/project-agents.md): the coordinating main agent, focused subagents, direct prompts, assignments, and reports.
- [Usage and resets](docs/usage-and-resets.md): shared accounting, pacing, automatic assignment, and permission for optional free resets.
- [Agent collaboration](docs/agent-collaboration.md): direct sibling communication, shared files, dependencies, and efficient teamwork.

## Current stage

Design only. These documents describe intended behavior, not an implemented app or confirmed provider integrations.

The earlier routing dashboard concept is superseded by this project-first direction. Implementation and GitHub publishing are future stages.
