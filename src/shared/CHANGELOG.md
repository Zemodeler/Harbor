# Contract changelog (src/shared/api.ts)

Only optional fields and new methods may be added after the initial contract. Newest first.

- 0.1.7 — Optional `UsageWindow.model` (a per-model limit such as Fable or Opus; absent = account-wide) and `UsageWindow.projectedPct` (where usage lands at reset at the current pace).
- 0.1.6 — Optional conversation pin/archive/custom-title fields and persisted per-conversation `activity` (state, timing, connection, model, and current step), plus optional `reviewBase`; `conversation` events update session status independently of the shared main agent. New `updateConversation`, `searchConversations`, `stopConversation`, `getReview`, and `openProjectFolder` methods. Review snapshots are read-only current diffs, with no inferred verification claims. Optional `Settings.desktopNotifications` enables native background completion/attention notifications.

- 0.1.5 — `HarborEvent` variant `question` (`requestId`, `conversationId`, `prompt`, `options?`, `allowText?`, `agentId?`) and `answerQuestion(requestId, answer)` (new method). An agent that needs a user decision ends its turn with a question; show it as a pop-up and send the chosen option or typed text with `answerQuestion`, which delivers it as the user's next message in that conversation. Renderers must ignore unknown event types.
- 0.1.4 — `Project.image?` (a small `data:image/...` URL) and `setProjectImage(id, image|null)` (new method; `null` clears it). The image is stored with the project and survives restarts.
- 0.1.3 — `Agent.conversationId?` (optional): the main-agent conversation that created a subagent. All conversations of a project share one main agent, so `parentId` alone cannot tell which chat a subagent belongs to.
- 0.1.2 — `deleteConversation(id)` (new method; removes the conversation and its messages only). `UsageWindow.period?` (`session`|`weekly`) and `UsageWindow.source?` (`reported` = read from the provider/CLI, `estimated` = Harbor-run count). Weekly windows now appear next to the 5h one.
- 0.1.1 — `CliStatus.authState?` (optional): `signedIn`, `signedOut`, or `unknown`. `signedIn` stays false when unknown, so show "status unknown" (not "login required") when authState is `unknown` and installed.
- 0.1.0 — initial contract, identical to the spec.
