# Interface design

Status: the interface is implemented in `src/renderer` (React, one CSS module, strict TypeScript). This document keeps the design direction, lists the screens that exist, and marks what is not built. It was written while the UI team was adding more screens; items marked **in progress** exist as uncommitted files in the working tree and were not run or verified here. The renderer is tested against an in-memory mock (`npm run test:renderer`), not against a live engine. Layout and visual details change quickly; treat the component names below as pointers.

## Direction

Harbor's app icon is an anchor: a bold white silhouette on a rounded deep ocean teal tile, with a restrained aqua accent, used for the installed app, the Start menu, the taskbar and the application identity. The asset is [Harbor icon](../design/harbor-icon.png). Keep the anchor legible at small sizes and keep the app name out of the taskbar icon.

Use familiar Windows conventions: standard window controls (native, from the main process), keyboard navigation, native folder dialogs, predictable focus. The app launches and pins like other installed apps. Closing during active work has an explicit choice: a "keep running in the background" preference hides Harbor to a tray icon with Open Harbor and Quit entries; Quit really stops Harbor.

Use a familiar desktop coding-assistant layout: projects are the primary navigation, conversations live inside projects, and the main area holds the selected conversation. Routing and provider details stay in settings and optional detail views, not in the main surface.

## What exists

- **Application shell** (`App.tsx`): a project and conversation sidebar, a header with the project, conversation title and a session status badge, an error banner with a reload action, a notice when no connection is ready (with a link to Settings), and three views: conversation, Git, Settings. A narrow window replaces the sidebar with a project-menu button; panels become dialogs. Keyboard: Ctrl+K opens quick actions and search, Ctrl+N starts a conversation.
- **Layouts** (Settings > Appearance): *Command Center* (conversation with a live-activity panel beside it), *Focus Studio* (a calm conversation, helper details on demand), *Mission Board* (conversations grouped by live status). Several color palettes, light and dark. Text size and density are under Settings > Workspace.
- **Sidebar** (`Sidebar.tsx`): projects (initials or a small chosen icon), add project (native folder picker), the project's conversations grouped Pinned, Today and Earlier, and per conversation rename, pin, archive and delete (delete and archive are refused while the conversation is busy). Removing a project entry removes Harbor's record only, not files.
- **Conversation** (`Conversation.tsx`): the streamed message stream (Markdown with copyable code blocks; raw HTML stays inert), tool activity grouped and collapsed, system notes, lead-to-lead notes rendered as such, and the composer.
- **Composer**: "Message Harbor" in a lead conversation, "Message <helper>" when a helper's conversation is open, so a direct prompt is not mistaken for a project-wide one. Attach images (png, jpeg, gif, webp) and text files, insert reusable prompts, a follow-up queue kept on this device (it pauses across restarts until you resume it), Stop session, and a mode picker. Enter sends; Shift+Enter inserts a line. A message starting with `/deep` skips triage and uses a strong lead.
- **Mode picker** (`ModePicker.tsx`): default, auto, plan, goal (a goal is required). A confirmation step before enabling auto is **in progress**; an Auto badge shows in the header while it is on.
- **Helpers ("subagents")**: a compact list under the lead's conversation with role, state, CLI and model, and a Stop action; each opens its own conversation. A "Review current changes" action opens the review panel.
- **Session information** (`SessionPanel.tsx`): current step, connection, model, the routing reason, complexity, effort, mode, run time and last activity.
- **Review panel** (`ReviewPanel.tsx`): current diffs of the project folder and the conversation's helper worktrees as a read-only snapshot; credential files are never previewed. It states that verification is not tied to the snapshot.
- **Git view** (`GitPanel.tsx`): branches with ahead and behind, helper branches with their agent, worktrees, a commit graph, and changes with inline diffs. Read-only.
- **Dialogs**: a question dialog for `HARBOR_ASK` (options and optional text; selecting is separate from sending), non-blocking permission cards for tool calls (allow once, always allow for this project when offered, deny, with the expiry), file conflicts and free-reset proposals; pending cards are restored after a reload through `listPendingPermissions`.
- **Quick actions and search** (`CommandMenu.tsx`): switch project, new conversation, open settings, session information, review changes, Git view, open project folder, and a search across conversation titles and messages (project-scoped in the history view).
- **Settings**: Connections (status per CLI, version, refresh, native sign-in, enable switch), Appearance, Workspace (text size, density, desktop notifications, reusable prompts), Routing (automatic or manual, the free-reset preference), Usage (each provider's windows with the percentage and whether it is reported or estimated, and the reset time).
- **In progress (uncommitted when this was written):** `RoutingSettings.tsx` (concurrency, allowed models, role preferences, effort policy, low-allowance policy, reserve, tray preference, with per-project overrides), a Project tab, `IntegrationPanel.tsx` (choose helpers to integrate, show sources, conflicts, checks, changed files, and an Apply action), `RollbackDialog.tsx` (preview, roll back, apply), `QueueControls.tsx` (pause, resume, priority, resume a stopped helper), `ToolRules.tsx` (list and remove always-allowed tools), `Diagnostics.tsx` (export a redacted support bundle), `AgentOutcome.tsx` and `HelperDetails.tsx` (a helper's result, Harbor's checks, outdated marks), `UsageWindows.tsx` (estimates labeled as such).

## Layout sketch

```text
+-----------------------+----------------------------------------------+
| Harbor                | Project / Conversation title      [status]   |
|                       +----------------------------------------------+
| Projects              |                                              |
| v Harbor              | User message                                 |
|   + New conversation  |                                              |
|   Pinned / Today / ... | Assistant response (streamed)               |
|                       |                                              |
| > Storefront          | Tool activity (collapsed)                    |
| > Internal tools      |                                              |
|                       | 2 subagents: ...   [Review current changes]  |
|                       +----------------------------------------------+
| Add project           | Message Harbor...                            |
| Settings              | Attach   Prompts   Mode           Send       |
+-----------------------+----------------------------------------------+
```

This is a structural sketch, not a final visual treatment.

## Principles kept from the original design

- The sidebar lists projects first, then their conversations; activity indicators show running work, required input and failures without becoming a metrics display. Conversation names summarize the work, not the provider.
- Show one concise task status near the title (queued, working, waiting for you, done, failed, stopped). A partial result is not a finished one, and passing one set of checks does not mean the task is finished.
- The header holds no permanent quota meters or provider comparison cards. Routing reasons, usage and helper details are available on demand.
- The composer is the primary action surface; routing needs no provider choice per message. A message may name a CLI ("use codex").
- Workspace panels sit beside the conversation on wide windows and in a dismissible dialog on narrow ones.
- Important states stay visible: questions, permission requests, failures, an unready connection.
- Support light and dark, restrained chrome and generous conversation spacing. Avoid dashboard cards and badge clutter. The first impression should be "my projects and conversations".

## Reviewing results

For a code-change result, "Review current changes" is the primary action: it opens the exact current diffs. Harbor-run checks and reviewer verdicts are recorded per helper with the commit they covered and marked outdated when the branch moves (the data exists in the contract; the helper cards that show it are **in progress**). Landing work through an integration and Apply is the intended path to your branch; the integrate, apply and rollback screens are **in progress**.

## Not built, or superseded

- Superseded: a main agent as "the default contact" that only shows delegated progress and relays reports. The conversation is with the lead, which does the work itself and streams it. The header still labels the lead's conversation by the project's main agent title.
- Superseded: "sibling exchanges as collapsible collaboration activity". There are no helper-to-helper messages. Lead-to-lead notes appear as system messages in both sessions.
- Superseded: a concise plan card appearing automatically. Plans come from plan mode on request.
- Not built: an application-wide queue view, interactive-headroom controls, a skills and plugins area, a conversation-level CLI override, a project-level history view with restore beyond the search results, a recovery summary screen (a restart notice is posted in the conversation instead), "instructions changed" and "hold for acknowledgement" states, API key and spending settings, per-conversation or per-task routing overrides, a manual executable path field for a CLI, and image thumbnails in messages (the CSP blocks local files).
- Known quality gaps recorded in `BACKLOG.md` (review findings): whole-conversation re-render while typing, no virtualization of very long conversations or diffs, a single global error string, accessibility audit pending, a CSP `connect-src` that allows a local WebSocket in production.

## Settings model

- **Global settings** hold connections, appearance and workspace preferences, routing defaults (automatic or manual, plus the in-progress policy fields), and the free-reset preference. The Usage tab shows each provider's windows separately; it never shows one combined figure. A free-reset proposal arrives as a permission card with the estimated usage, waiting tasks and next refresh time; it is never automatic and no provider exposes one today.
- **Project settings** (in progress) override the routing fields per project, with an explicit return to the inherited value.
- **Conversation overrides** are not built. A conversation has a mode (default, auto, plan, goal) and a goal.

## Important states

| State | Visible experience | Status |
| --- | --- | --- |
| No projects | Add a project is the main action. | Built |
| Empty project | Start a conversation, with the project named. | Built |
| Checking connections | Background scan; project navigation stays usable. | Built |
| Installed but not logged in | Settings shows the CLI with a native sign-in action. | Built |
| No ready CLI | A notice with a link to Settings. | Built |
| Working | Streamed output; helpers listed under the conversation. | Built |
| Several CLIs active | One status; CLI and model per helper and in session information. | Built |
| Allowance unknown or estimated | Usage tab labels the source; routing follows policy. | Built |
| Allowance exhausted | The fallback is posted in the conversation ("Falling back to ..."), or the run fails with the reason. | Built, plain |
| Input required | A question dialog; the session shows "waiting". | Built |
| Permission required | A non-blocking card per request. | Built |
| Complete / failed | Status badge, helper notes, review action. | Built |
| Queued | State and waiting reason on the helper; queue controls | In progress |
| Restart | A system note per conversation; stopped helpers can be resumed | Notes built; resume control in progress |
| Verification outdated | Data available; helper-card marks | In progress |
| Instructions changed | Hold and acknowledge | Not built |
