# API requests

- Add assignment/conversation ownership to Agent (or a conversation-scoped listAgents API). The current contract identifies parent agents but cannot distinguish assignments belonging to different main-agent conversations in one project. The UI currently shows all children of the selected main agent.
- Expose pending permissions for recovery and initial load. Event-only permissions cannot be recovered by a renderer reload; the engine must replay pending requests after subscribing or provide listPendingPermissions.
- Provide conversation overrides/manual CLI selection, extensions discovery, project history/archiving, task status/verification, changed files and exact diffs, workspace panels, and queue controls before exposing those actions. The first UI implements the supplied contract and does not fabricate these capabilities.
- Usage source, freshness, unknown readings, and entitlement details need typed fields. The UI shows each supplied window separately; absent windows/reset times stay unknown.
- Main-process integration: set `app.setAppUserModelId('com.harbor.desktop')` on Windows; set the BrowserWindow icon from `build/icon.ico` during development and `process.resourcesPath/icon.ico` after packaging. Retain native window controls. Do not change the renderer to implement desktop window controls.

# Integration notes

- UI implementation is on `gpt/ui`. The core scaffold arrived directly in the shared checkout while UI work was underway. Core-owned files were read but not edited. Root package changes add only UI and installer scripts; existing main scripts are preserved.
- Installer tooling is isolated in `build/package.json`; install it with `npm install --prefix build`. `npm run dist` builds the app then runs unsigned NSIS packaging without publishing.
