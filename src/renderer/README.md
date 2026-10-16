# Harbor renderer

The interface uses React, strict TypeScript, and one CSS module. All engine calls go through `window.harbor`; no Node, Electron, remote fonts, or network integrations are imported by the renderer.

## Run

Install root dependencies for Electron, then install the standalone renderer dependencies with `npm install --prefix src/renderer`.

- `npm run dev:renderer`: browser demo with realistic in-memory data. Append `?firstRun` to start without projects.
- `npm run dev`: Electron app using the preload-provided real engine.
- `npm run test:renderer`: Vitest and React Testing Library flows against the mock.
- `npm --prefix src/renderer run build`: strict renderer type check and production browser bundle.
- `npm install --prefix build`, then `npm run dist`: production Electron build and unsigned Windows x64 NSIS installer, without publishing.

The standalone renderer dependencies are isolated to avoid changing the core engineer's dependency set. Lockfiles are supplied for pnpm as well. With pnpm, install each owned package from its directory. `build/pnpm-workspace.yaml` disables an unused Squirrel installer hook; NSIS does not need it.

## Structure

- `App.tsx`: header, view selection, project switcher, folder picker, and permission queue.
- `hooks/useHarbor.ts`: typed API loading, event subscription, project/conversation selection, race guards, and recoverable errors.
- `components/`: sidebar, compact agents, conversation and composer, Markdown/code copying, Settings, native HTML modal, and shared brand.
- `mock/`: complete in-memory implementation, demo data, streaming, queued/working/done events, usage updates, and one optional reset request. Stops cancel future streaming and completion.
- `assets/harbor-logo.png`: supplied anchor identity, used in the sidebar, assistant avatar, and favicon.
- `components/Switch.tsx`: checkbox rendered as a switch (`role=switch`). Semantic design tokens (type, spacing, radius, elevation, status tones) and the `.primary`, `.quiet`, `.danger`, `.pill` button variants live at the top of `Harbor.module.css`.
- `Harbor.module.css`: mockup-based light/dark system themes, responsive navigation, scroll areas, focus rings, and short-window layout.
- `tests/`: project onboarding, streaming, agent chats, login, Settings, keyboard shortcuts, draft isolation, errors, untrusted Markdown, cancellation, and permission outcomes.
- `../../build/`: installer tool and scripts, multi-size icon converter, and browser visual check.

## Real engine integration

Types are imported directly from `src/shared/api.ts`. `installMockApi()` supplies the mock only if `window.harbor` is undefined, so an Electron preload automatically takes precedence without renderer changes. Mock connections, usage, login, and reset actions are explicitly sample data; they never alter a real project or account. The browser demo does not persist across reloads.

Drafts are isolated per conversation while the conversation view stays mounted. Ctrl+K opens the command palette (`components/CommandMenu.tsx`, ranking in `palette.ts`): commands, projects, conversations by title and, through `searchConversations`, by message text, plus saved prompts; `>` limits it to commands, `@` to projects, `#` to tagged conversations, and recently used entries come first. Ctrl+Shift+F searches this project's conversations, archived ones included. Ctrl+N starts a conversation; Enter sends and Shift+Enter inserts a line. Direct agent chats name their recipient and provide Back to main. Permissions appear in a queued modal, trap focus, and require Approve or Deny; Escape grants nothing.

Navigation polish (local-only layers are marked; core requests are in `BACKLOG.md`):

- Pin and archive use `updateConversation`; archived conversations appear in a "Show archived" section of the list and in history. Tags are **local to this device** (`conversationMeta.ts`, `hooks/useConversationMeta.ts`) until the contract has them; the list can be filtered by tag. Fork is not offered (no API).
- First-run guide (`components/Onboarding.tsx`, `onboarding.ts`): detected CLIs and sign-in state, the first project, and the modes. It never calls a model. It reopens from the palette ("Show the welcome guide").
- Toasts (`hooks/useToasts.ts`, `toasts.ts`): "Needs your answer", "Finished" and "Failed" with Open/Answer and Dismiss, for changes seen while the window is open, never for the conversation on screen while focused. An optional clickable Windows notification (Notification API, `notificationPrefs.ts`) is off while main's desktop notifications are on.
- Themes: Use system (default; follows light/dark and `prefers-contrast: more`), Light, Dark, High contrast (`resolveTheme`, `contrastTokens` in `appearance.ts`). Reduced motion stops all animations; forced-colors mode keeps focus visible.
- Composer: type `/` for `/deep`, built-in prompts and saved prompts (`slashCommands.ts`; `{{project}}`, `{{conversation}}`, `{{date}}` are filled in). Text, log and source files (several at once, by picker, drop or paste) are quoted into the message; PDFs and credential files are refused with a reason (`attachments.ts`).
- Accessibility: skip link, labelled landmarks, palette as combobox/listbox with `aria-activedescendant`, arrow keys in the conversation list.

Markdown supports paragraphs, headings, bold, inline code, unordered lists, and fenced code blocks with copying. Raw HTML stays inert text. Full CommonMark, embedded media, and advanced tables are not implemented.

## Packaging and verification

`electron-builder.yml` configures a Harbor x64 NSIS installer with an optional installation location, Start menu shortcut, standard uninstall entry, and the supplied icon at 16/24/32/48/64/128/256 pixels. App data is retained on uninstall. Native window controls come from the main process. Runtime window icon and Windows app identity requests are recorded in `BACKLOG.md` for the core owner.

Verified on 8 October 2026:

- Strict renderer type check and complete Electron production build.
- Renderer/mock test suite, including explicit reset approval/denial and cancellation.
- Headless Edge checks at 1440×1000 light/dark, 390×844 dark, and 760×480 light: no horizontal overflow, composer stays visible, narrow navigation opens projects and Settings, permission modal retains focus and survives Escape, code copying works, and no browser errors.
- Screenshots reviewed for conversation, Settings, and permission layouts; generated locally in `build/qa/` with a machine-readable results file.
- Unsigned NSIS installer generated in `dist/`; Windows Authenticode reports `NotSigned` for both installer and application executable.

Not verified: installing/uninstalling on a clean Windows machine, actual taskbar pinning/native runtime identity, live provider execution from the packaged UI, screen-reader use, and recovery of permission requests after a renderer reload. These require engine integration or a native installation check. Advanced design-document features absent from the supplied contract are listed in `BACKLOG.md`, including exact diffs, verified task completion, extensions, queues, archived history, and conversation-scoped agent assignments.
