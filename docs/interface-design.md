# Interface design

## Direction

Use a familiar desktop coding assistant layout. Projects form the primary navigation structure, conversations live inside projects, and the main area contains the selected conversation.

The earlier concept gave routing plans and provider connections too much prominence. The revised interface places those controls in settings and optional detail views.

## Application layout

On first launch, automatically scan for supported installed CLIs and check sign-in state in the background. Go straight to the project interface. Users with a ready CLI should only need to open their project and describe the work.

Do not put connection selection, routing preferences, skills configuration, or API key entry in a mandatory setup sequence. If nothing is ready, show a compact install or sign-in action and explain what is missing.

```text
┌─────────────────────┬──────────────────────────────────────────────┐
│ Harbor              │ Project / Conversation title                │
│                     ├──────────────────────────────────────────────┤
│ Projects            │                                              │
│ ▾ Harbor            │ User message                                 │
│   + New conversation│                                              │
│   Project switching │ Assistant response                           │
│   Routing preferences│                                             │
│                     │ Tool activity / progress                     │
│ ▸ Storefront        │                                              │
│ ▸ Internal tools    │ Result and reviewable changes                │
│                     │                                              │
│                     ├──────────────────────────────────────────────┤
│ Add project         │ Message composer                             │
│ Settings            │ Attach context        Auto routing     Send  │
└─────────────────────┴──────────────────────────────────────────────┘
```

This is a structural sketch, not a final visual treatment.

## Project sidebar

The sidebar lists projects first. Expanding a project reveals its conversations and a new-conversation action.

Each project also exposes its main agent and an expandable Agents section. The main agent is the default contact. Subagents are labeled by assignment, such as “Plan login flow,” “Implement login form,” or “Test login behavior,” with a small activity indicator. Selecting a subagent opens its conversation in the same familiar chat layout.

Keep the Agents section compact and collapsible. It is direct access to ongoing work, not a permanent orchestration dashboard.

Each project has a name and local folder. Conversation names summarize the work rather than the selected provider. Activity indicators identify running work, required input, or failures without turning the sidebar into a metrics display.

Project actions include opening its folder, editing project settings, renaming its display name, and archiving its entry. Removing an entry must be distinguished from deleting local files.

For long histories, expose additional conversations through a project-level history view. Search, if added, should clearly identify which project each result belongs to.

## Conversation header

Show the active project and conversation title. Keep common actions compact: conversation options, workspace tools, and execution details.

When viewing an agent conversation, identify its role and assignment. A subagent header includes a return-to-main-agent action. The composer clearly names its recipient so a direct prompt cannot be mistaken for a project-wide instruction.

The header should not contain permanent quota meters, provider comparison cards, or a task routing plan.

## Conversation surface

Use a readable stream of user messages, assistant responses, and collapsible tool activity. Keep the assistant's account of progress coherent when several CLIs contribute.

In the main conversation, the main agent acknowledges requests, shows concise assignment progress, and presents reports returned by subagents. It does not produce implementation, research, design, or verification work itself. Detailed work lives in the assigned subagent's conversation and associated artifacts.

In a subagent conversation, show its single assignment, relevant specification, work history, direct user prompts, and reports. Requests for a sibling appear as an activity entry with the main agent's response. Completion reports remain available from both the subagent conversation and the main conversation's details.

Sibling exchanges appear as collapsible collaboration activity with sender, recipient, related assignment, and affected files or contracts. Users can inspect the full thread and add clarification. Keep routine exchanges out of the main conversation; surface meaningful agreements, dependencies, or blockers in its progress details.

Provider attribution can appear as a subtle message label or in execution details. Significant handoffs may appear as a short activity entry. Routine routing decisions should not generate separate chat messages.

Show a concise plan inside the conversation when the work benefits from one. Show outcomes and steps in ordinary language; keep provider assignments and budget calculations in optional details.

## Composer

The composer is the primary action surface. It accepts a request and relevant attachments or context.

A compact control indicates that automatic routing is enabled. Opening it provides a temporary CLI selection or conversation policy override. Users should not have to select a provider, effort level, or execution plan before every message.

During execution, offer stop and follow-up behavior appropriate to the current activity. Steering a task should preserve its conversation and task history.

Users can send prompts directly to a subagent. In-scope clarification reaches that agent without an additional approval round. A request that changes its scope or conflicts with another assignment is surfaced to the main agent for reassignment or replanning. Stop actions clearly distinguish stopping one subagent from stopping the overall task.

## Optional workspace panels

Provide secondary panels for changed files and diffs, project files, raw CLI output or terminal access, and execution details.

Open these when requested or when reviewing a result requires them. The default view remains the conversation.

Execution details can show:

- Task steps and their status.
- CLI assignments and the reason for each assignment.
- Requested effort and any adapter limitations.
- Allowance readings, timestamps, and estimate confidence.
- Linked native sessions and context handoffs.
- Failures, retries, and fallback decisions.
- Subagent assignments, reports, sibling requests, and direct user steering.
- Automatically selected CLI, model, and effort, including effective settings.
- Shared usage, remaining allowance, scheduled resets, and optional reset entitlements where known.
- Sibling conversations, file ownership, waiting dependencies, and handoff acknowledgements.

## Settings

### Global settings

Global settings contain CLI connections, routing defaults, effort policy, subscription conservation, API credentials and spending policy, and general application preferences.

A Usage area shows application-wide consumption and per-project, task, and agent breakdowns. Keep provider units and overlapping windows distinct. Show reported versus estimated values, pending reservations, last refresh, and the next known reset. This information stays out of the default conversation view except when it affects progress.

When a confirmed optional free reset would unblock useful work, show a concise approval in the main conversation: affected account and allowance window, current remaining allowance, what the reset restores, remaining reset entitlement, and why resetting now helps more than waiting. Offer use reset, wait for the scheduled reset, or continue with an eligible alternative. Do not repeatedly prompt after deferral without a material change.

The connections page is populated automatically. For each discovered CLI, show its installation location, detected version when available, and a plain-language state: ready, installed but needs login, checking, status unknown, or unavailable. Offer a refresh action and an optional manual path for tools the scan cannot find.

For an installed CLI that needs login, offer its supported native sign-in flow. Preserve existing signed-in accounts without asking users to re-enter credentials. Distinguish an inconclusive authentication check from a confirmed logged-out state.

Show supported adapter capabilities without implying that every CLI supports structured output, quota reporting, or session resume.

A Skills & plugins area lists discovered native extensions grouped by CLI and scope. Show whether an extension is available in the active project, needs setup or permissions, is disabled, or has unknown compatibility. Clearly label native settings that must be managed in Claude or Codex. Routine use of an already configured extension should not require another setup step.

### Project settings

Project settings inherit global defaults and can override allowed CLIs, preferred roles, effort policy, usage reserve, API fallback, and concurrency behavior.

Make inherited values explicit and provide a return-to-default action. A project should not need to duplicate the global configuration.

### Conversation overrides

A conversation may temporarily use a particular CLI or routing policy. Show a subtle indicator when an override is active, with a clear way to return to automatic routing.

## Important states

| State | Visible experience |
| --- | --- |
| No projects | Add or open a project as the main action. |
| Empty project | Start a conversation, with the selected project clearly named. |
| Checking connections | Scan in the background; keep project navigation available. |
| Installed but not logged in | Show the affected CLI in settings with a native sign-in action. |
| No ready CLI | Offer one clear install or sign-in action before execution. |
| Extension needs setup | Explain the missing setup when that extension is needed. |
| Working | Brief progress in the conversation; details are expandable. |
| Several CLIs active | One coherent task status, with per-CLI activity available in details. |
| Allowance unknown | Normal work follows policy; details mark allowance as unknown. |
| Allowance exhausted | Explain whether the app will switch CLI, wait, or request API fallback. |
| Input required | Ask the necessary question in the conversation and mark the sidebar entry. |
| Complete | Present the result, changed files, and relevant verification. |
| Execution failed | Explain the failed step and available recovery without losing history. |

## Visual direction

Use restrained chrome, compact navigation, clear typography, and generous conversation spacing. Support light and dark appearances. Avoid decorative dashboard cards and excessive status badges.

The main first impression should be: “my projects and conversations.” The router should become visible when the user wants to configure it or understand a decision.
