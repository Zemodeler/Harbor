# Contract changelog (src/shared/api.ts)

Only optional fields and new methods may be added after the initial contract. Newest first.

- 0.1.4 — `Project.image?` (a small `data:image/...` URL) and `setProjectImage(id, image|null)` (new method; `null` clears it). The image is stored with the project and survives restarts.
- 0.1.3 — `Agent.conversationId?` (optional): the main-agent conversation that created a subagent. All conversations of a project share one main agent, so `parentId` alone cannot tell which chat a subagent belongs to.
- 0.1.2 — `deleteConversation(id)` (new method; removes the conversation and its messages only). `UsageWindow.period?` (`session`|`weekly`) and `UsageWindow.source?` (`reported` = read from the provider/CLI, `estimated` = Harbor-run count). Weekly windows now appear next to the 5h one.
- 0.1.1 — `CliStatus.authState?` (optional): `signedIn`, `signedOut`, or `unknown`. `signedIn` stays false when unknown, so show "status unknown" (not "login required") when authState is `unknown` and installed.
- 0.1.0 — initial contract, identical to the spec.
