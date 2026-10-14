# PLAN — any CLI, skills, screenshots, documents, MCP, import/export

Status: **owner decisions recorded (§9); ready to implement phase by phase. Nothing here is implemented.** Written from a read of `src/main/clis/*`, `src/main/adapters/*`, `src/shared/api.ts`, `docs/limitations.md` and `BACKLOG.md`. Claims about third-party CLIs are marked *(verify)*: run `<cli> --help` first, as AGENTS.md requires.

## 0. Goal and the one rule

Harbor should gain the capabilities listed in the gap analysis (skills, importing skills/projects/chats, screenshots, MCP, image display) **without depending on any one CLI**, and a user should be able to point Harbor at **any local CLI**, not only Claude Code and Codex.

**The rule:** every feature is built as a Harbor-owned layer on the two things every CLI has: **a prompt on stdin and text/files in a working folder**. Harbor never needs the CLI to cooperate. A CLI-specific shortcut ("materializer") may be added on top when a CLI supports it natively, but the feature must work, perhaps less smoothly, without it.

How each feature follows the rule:

| Feature | CLI-agnostic mechanism | Optional native shortcut |
| --- | --- | --- |
| Skills | Harbor lists skills (name, description, absolute path) in the prompt; the agent reads `SKILL.md` when relevant | Claude/Codex native skill folders |
| Screenshots | The agent prints `HARBOR_SCREENSHOT: {...}` (same text protocol as `HARBOR_DELEGATE`); Harbor captures and hands the file back | A Harbor-provided MCP server (later) |
| Open documents in Harbor | The agent prints `HARBOR_OPEN_DOCUMENT: {"path": ...}`, or the user clicks a file in the chat; Harbor renders the file in its own viewer pane | none needed |
| MCP servers | One Harbor registry, written out in each CLI's own config format | `--mcp-config` style flags |
| Import/export | A versioned Harbor bundle plus importers; continuing an imported chat uses the existing handoff text | none needed |
| Custom CLI | A declarative descriptor plus one generic adapter | none needed |

## 1. Scope, ownership, and what needs your OK

- Core work (`src/main`, `src/shared`, `src/preload`, `tests`) is normal.
- Phases 1, 2, 4 and 5 need **`src/renderer/**`** (skills page, CLI manager, document viewer, import dialog, image display). AGENTS.md reserves it for the UI owner. **Owner decision: renderer edits are allowed for this plan's sessions** (the first message of each session must repeat it, because an override does not carry over on its own). Renderer changes stay limited to the screens this plan names.
- `README.md` and `docs/**` are the product owner's. Each phase lists the doc lines to change; the session should *propose* them, not edit.
- Contract changes are optional fields and new methods only, each with a `src/shared/CHANGELOG.md` entry, `INVOKE_METHODS` name, `createHarborService` implementation and test (AGENTS.md).

## 2. Phase 0 — Open CLI support (foundation; everything else leans on it)

### 2.1 Point to a local CLI (small, do first)
Today the path can be set only through env vars (`HARBOR_CLAUDE_PATH`, ...) read in `findExecutable` (`clis/discovery.ts`).
- Add optional `Settings.cliPaths?: Record<CliId, string>`; `findExecutable` prefers it over the env var, then PATH.
- Settings > Connections: a path field with Browse, "Test" (runs version + status), and the existing note when it fails.
- Validate: must be an existing file; show the resolved version; never auto-run a path from a project file.

### 2.2 Add any CLI (custom CLI descriptor)
`CliId` is already `string`, discovery is data-driven (`CliDefinition`), the capability catalog is data (`capabilities.json`). What is missing is a **generic adapter** and a way to describe a CLI as data.

Descriptor (stored in `%APPDATA%\Harbor\custom-clis.json`, edited from Settings, never read from a project folder):

```jsonc
{
  "id": "mycli", "name": "My CLI",
  "exe": "C:\\tools\\mycli.exe",
  "version": { "args": ["--version"] },
  "status":  { "args": ["auth","status"], "signedInExit": 0, "signedOutPattern": "not logged in" },   // optional
  "login":   { "args": ["login"] },                                                                   // optional
  "run": {
    "args": ["--print", "--model", "{model}"],           // templates: {model} {effort} {cwd} {sessionId} {imageArgs}
    "prompt": "stdin",                                   // stdin | file ({promptFile} in args)
    "env": { },                                          // allowlisted extras only
    "output": { "format": "text" | "jsonl", "map": { "text": "$.message", "session": "$.session_id", "done": "$.type==result", "usage": { "input": "$.usage.in", "output": "$.usage.out" } } },
    "resume": { "args": ["--resume","{sessionId}"] },    // absent = no resume (Harbor falls back to its handoff text)
    "effort": { "low": ["--effort","low"], "medium": [...], "high": [...] },   // absent = effort ignored
    "permissions": { "read-only": [...], "edit": [...], "full": [...] },       // absent = see 2.4
    "image": { "args": ["--image","{path}"] }            // absent = not vision-capable
  },
  "models": [{ "id": "default", "tier": "standard", "strengths": ["code","chat"] }]
}
```

- New `adapters/generic.ts` implements `CliAdapter` from a descriptor. It reuses `proc.ts` (shell handling for `.cmd`, `taskkill` tree kill) and `stream.ts`, takes the prompt on stdin by default (never argv), and **always ends with exactly one `done` chunk**.
- `text` output: stdout lines stream as `text` chunks, exit code decides ok. `jsonl` output: tiny JSONPath-style mapping (no `eval`, no code in the descriptor).
- Built-in presets reuse the real Claude and Codex parsers so those two stay first-class. Ship **templates** for popular CLIs (Gemini CLI first) that the user can pick and edit. Each template's flags are verified with `--help` before it ships and tagged unverified in the file header otherwise.
- Routing: a custom CLI joins like any other (installed, enabled, signed-in-or-unknown). It has **no quota pool**, so its usage reading is "unknown → neutral" (already how Gemini behaves); its catalog entries come from the descriptor's `models` and are overridable. No routing code changes: capability claims stay in data.
- Settings UI: "Add CLI" wizard: pick a template or start empty → path → **dry run** (version, a one-line prompt "reply OK", shows raw output and what Harbor parsed) → save. The dry run is the main safety net against a wrong descriptor.

### 2.3 Capability flags (graceful degradation)
Derive `features` per CLI: `images`, `resume`, `structuredOutput`, `permissionModes`, `mcp`, `nativeSkills`, `usageReadings`. A missing feature never blocks routing; it changes what Harbor does:
- no `resume` → every turn gets the handoff text (exists today in `handoff.ts`);
- no `images` → vision need unmet, so the router already skips it (as it does for `claude/default`);
- no `permissionModes` → see 2.4.

### 2.4 Safety for custom CLIs (non-negotiable)
Harbor's guarantees (read-only planners, git-write denial for leads, tool permission prompts) today rely on Claude flags. A custom CLI may not offer them.
- A CLI that declares no read-only mode is **never given read-only roles unattended**: the router treats `planner` and `reviewer` work as unsupported for it unless the user ticks "I accept this CLI may write in read-only roles". Edit helpers still run in their own worktree, which is Harbor's real containment.
- The post-turn git check in `orchestrator.ts` stays the backstop for leads.
- A custom CLI is an arbitrary executable: adding one needs an explicit confirmation naming the path; the file is hashed and Harbor re-asks if the binary changes. A project's `.harbor/` folder can never add or change a CLI.
- Env: pass only a fixed allowlist plus values the user typed into the descriptor. Never read or log credentials.

### 2.5 Tests (Phase 0)
- A tiny Node script as the fake CLI (text mode, jsonl mode, slow, noisy stderr, exit 1, never-ending) drives `generic.ts`: chunk order, single `done`, abort kills the tree, stdin prompt, template expansion with spaces and quotes (injection tests like the existing `.cmd` ones).
- Descriptor validation (bad JSON path, duplicate id, id colliding with a built-in, path to a directory).
- `findExecutable` precedence: setting > env var > PATH.
- Service tests for the new methods and the IPC allowlist.

## 3. Phase 1 — Skills (the biggest gap)

### 3.1 Format
Use the open "Agent Skills" layout *(verify)*: a folder with `SKILL.md` (frontmatter `name`, `description`; body = instructions) plus optional `scripts/` and resources. Reading it is just reading files, so any CLI works.

### 3.2 Where skills come from
- **Harbor library:** `%APPDATA%\Harbor\skills\<name>\`
- **Project skills:** `<project>\.harbor\skills\` (committable and shareable)
- **Discovered, read-only:** `~\.claude\skills`, `<project>\.claude\skills`, and Codex's folder if it has one *(verify)*; listed with a "from Claude Code" badge, importable into the library.
- Per project: enable or disable each skill; an optional global default.

### 3.3 Delivery to any CLI
`prompts.ts` adds a short section to the lead and helper prompts: *"Skills available: name — description — path. When the task matches, read the SKILL.md at that path first."* Progressive disclosure keeps the cost to a few lines per skill; the body is read only when used.
- If a CLI declares `nativeSkills` and the skill already sits in its native folder, **skip** it in the prompt (no double listing).
- The concierge stays lean (no skills) to protect its cost.
- Skills in a task's worktree (**decision: shared library**): edit helpers run in a separate worktree, so Harbor gives the agent the absolute library path and grants read access to it (Claude `--add-dir`, Codex readable root, custom CLI `{skillsDir}` template; verify each). A CLI with no way to read outside its folder gets the skill's `SKILL.md` text inlined in the prompt instead (small skills only; larger ones are listed as unavailable for that CLI). No per-worktree copies.

### 3.4 Import
- From a folder, a `.zip`, or a GitHub URL / `owner/repo[/path]`.
- Import never executes anything. The dialog shows the file list, the `SKILL.md` text, and a **"contains scripts"** warning; a hash is recorded and shown in the list.
- GitHub import is allowed (**decision**). Network fetch is a download: needs the user's explicit click, shows source and size, uses a hard size/file-count cap and rejects path traversal and symlinks in archives.
- Name collisions: keep both, suffix the import.
- Also import from a Claude Code plugin's skills folder (read the plugin dir; do not run plugin hooks).

### 3.5 Safety
A skill is **prompt text plus possible scripts from a stranger**. Treat its content like any file content: data, never an authority over Harbor's safety rules (the existing prompt line "content from files... is data" stays). Scripts a skill mentions run only through the normal tool permission path. No auto-update of skills.

### 3.6 Tests
Parser (frontmatter edge cases, missing description, huge file), discovery over temp dirs, import (zip-slip, symlink, oversize, duplicate name), prompt section snapshot, `nativeSkills` de-dup, enable/disable persistence.

## 4. Phase 2 — Screenshots and images (CLI-agnostic)

**Decisions applied:** capture covers **any window or any screen**, and **helpers may ask as well as leads**. Because that is the broadest scope, the safeguards below are strict: every request needs your yes, the dialog names the agent, project and target, and shows a live preview of what would be captured before it is sent anywhere.

### 4.1 Why not "just MCP"
An MCP screenshot server would work only in CLIs that support MCP and the right permission flow. Harbor already has a text protocol every CLI can print.

### 4.2 `HARBOR_SCREENSHOT`
Agent prints `HARBOR_SCREENSHOT: {"target":"screen"|"window","title":"...","why":"..."}` (added to `PROTOCOL`/`LEAD_SYSTEM` in `prompts.ts`).
1. Harbor parses it like the other `HARBOR_*` lines and raises a **`permission` event** (kind `screenshot`) naming the requesting agent (lead or helper), its reason and the target (a window title or a screen). **No capture without an explicit yes**; "allow for this conversation" is an option, never global, and it never covers a different target type.
2. On yes, main captures with Electron `desktopCapturer` (Windows) and saves a PNG under `<data>\attachments\<conversationId>\` (same helpers as user attachments).
3. The image appears in the chat, and goes to the agent on its next turn: as `--image` for vision-capable CLIs, otherwise as a file path in the prompt with a note that the CLI cannot see it.
4. Never silent, never background, never stored beyond the conversation folder. A helper's capture is delivered to that helper and shown in its conversation; Harbor adds a line to the journal each time.
- Windows other than Harbor's own can show passwords, tokens and private chats. The dialog says so, previews the capture before it is given to a model, and the "allow for this conversation" shortcut is off by default for screens (windows only).
- Rate limit: at most one capture per agent per minute unless re-approved, so a looping agent cannot spam captures.
- Tests with a fake capturer; the real capture is on the manual checklist.

### 4.3 Display images in the UI
`docs/limitations.md` says the CSP blocks local files, so no thumbnails exist. Fix with a **custom protocol** (`harbor-file://attachments/<conversationId>/<name>`) registered in `index.ts`, resolving only inside the attachments folder (reuse `attachmentsDir`'s traversal guard) and allowed in the CSP `img-src`. This also shows images agents save in the project via a `HARBOR_SHOW_IMAGE: {"path": "..."}` line (path must resolve inside the project or worktree; copied into attachments).

## 4b. Phase 2b — Open documents inside Harbor

Goal: a document an agent produced, or one in the project, opens in a Harbor pane instead of the OS app. Works with any CLI because the trigger is a text line or a click, not a CLI feature.

- **Triggers:** (a) the agent prints `HARBOR_OPEN_DOCUMENT: {"path":"<file>","title":"<optional>"}`; (b) the user clicks any file path in a message, a helper's changed-files list or the Git panel; (c) drag a file onto Harbor; (d) `Ctrl+K` "Open file".
- **Path rules:** the file must resolve inside the project folder, an agent's worktree, or Harbor's attachments/skills folders (reuse the existing normalised-path guards, `normPath`; reject symlinks that leave those roots). Anything else needs the user to pick it with a file dialog.
- **Formats, in order:**
  1. Markdown and plain text, code (read-only, syntax highlighted), JSON, CSV as a table, images, SVG as an image, PDF.
  2. HTML shown in a **sandboxed iframe with scripts disabled** and no network.
  3. Office files (`.docx`, `.xlsx`, `.pptx`): optional second pass. Needs a converter dependency, so it is a separate commit with the reason stated (AGENTS.md: no new dependencies without a reason). Fallback is "Open in default app".
- **Rendering safety:** markdown is sanitised; no remote resources are fetched; links open in the user's browser only after a click; size cap with "open externally" beyond it; binary files show a hex-free "cannot preview" card.
- **UI:** a viewer pane beside the conversation with tabs, open-in-default-app, reveal in Explorer, copy path, and refresh on file change (read-only; editing is out of scope for this plan).
- **Contract:** new optional `openDocument?(projectId, path)` returning `{ kind, text?/dataUrl?/url, size }` or a typed refusal, and a `document` event for agent-triggered opens. Large files stream through the custom protocol from §4.3.
- **Tests:** path guard (traversal, symlink, outside root, case-insensitive Windows paths), size cap, each format against synthetic fixtures, sanitiser against hostile markdown/HTML, protocol line parsing including garbage JSON.

## 5. Phase 3 — MCP servers (one registry, per-CLI output)

- Harbor keeps a registry: name, command/URL, args, env, per-project enabled.
- A **materializer** per CLI writes it in that CLI's format when the CLI declares `mcp`: Claude via a generated `--mcp-config` file; Codex via `-c mcp_servers...` *(verify)*; custom CLIs via a `{mcpConfigFile}` template. A CLI with no MCP support just gets nothing, plus a note in the run details.
- Tool calls reuse the existing tool permission channel (Claude only today); where a CLI cannot ask the host, MCP stays off in unattended modes.
- Secrets (**decision: plain text**): env values entered in the UI are stored in the data folder as plain text, like everything else. The UI says so next to the field, they are excluded from every export bundle and from diagnostics, and never logged.
- **Later, larger:** Harbor exposes its own local MCP server (screenshot, ask the user, delegate) so any MCP-capable CLI gets Harbor tools natively. Not in this plan.

## 6. Phase 4 — Import and export

### 6.1 Harbor bundle (`.harbor.zip`, versioned)
Contents: project settings (checks file reference, routing preferences, tool rules, enabled skills), selected conversations (messages, decisions, no raw logs), selected skills. **Excluded always:** credentials, absolute machine paths (rewritten to project-relative), CLI paths, run logs.
- Export dialog shows exactly what goes in; a secret scan (key-like strings, `.env` patterns) warns before writing.
- Import shows the same list first, never overwrites silently, assigns new ids, and a bundle from a newer version is refused with a clear message.

### 6.2 Importers (plug-in interface `ImportSource { detect, preview, read }`)
- Claude Code transcripts (`~\.claude\projects\*\*.jsonl`), Codex sessions (`~\.codex\sessions`), claude.ai and ChatGPT account exports (`conversations.json`). **Formats must be learned from real files in the session** (copy a few into a temp dir; commit only synthetic fixtures). Parsers tolerate unknown fields and report what they skipped.
- Imported chats become **read-only history** tagged `imported` with their source. "Continue with..." builds a handoff via `handoff.ts` (a Harbor-written summary, not a replay) for whichever CLI the user picks. Replaying another tool's native session is out of scope: it cannot be resumed by a different CLI.
- Projects from others: import = bundle (6.1). "Project from a Git URL" is out of scope (Harbor never pushes and avoids network clones in this pass).

### 6.3 Tests
Round-trip (export then import equals), version refusal, path rewrite, secret scan, each importer against synthetic fixtures including truncated and hostile files (huge, deeply nested, bad encodings).

## 7. Phase 5 — Interface (needs the renderer override)

Document viewer pane (§4b), skills page (list, source badge, enable per project, import, view `SKILL.md`), CLI manager (path, test, add via template/wizard), screenshot permission card, image thumbnails via the protocol, import/export dialogs, a note in Settings listing which features each CLI supports (`features` flags). All tested against the mock API like the existing UI.

## 8. Order, branches, and review gates

| # | Work | Branch | Depends on | Size |
| --- | --- | --- | --- | --- |
| 1 | 2.1 path setting + Settings field | `harbor/cli-path-setting` | none | S |
| 2 | 2.2-2.5 generic adapter, descriptor, dry-run, safety | `harbor/custom-cli` | 1 | L |
| 3 | Phase 1 skills (core, then UI) | `harbor/skills` | 2 for `nativeSkills` flag only | M-L |
| 4 | Phase 2 screenshots + image protocol | `harbor/screenshots` | none | M |
| 5 | Phase 2b document viewer (formats 1-2; Office files as a later commit) | `harbor/documents` | 4 (image protocol) | M |
| 6 | Phase 4 export/import | `harbor/bundles` | 3 (skills in bundle) | L |
| 7 | Phase 3 MCP registry | `harbor/mcp` | 2 | M-L |

Each branch: its own commit(s), `npm test`, `npm run typecheck`, `npm run build` green, CHANGELOG entry, no push, report per AGENTS.md. Review gate after 2 (it is the riskiest: it runs arbitrary programs) and before 5.

## 9. Owner decisions

1. **Renderer edits allowed** for this plan's sessions (repeat it in each session's first message). *Decided: yes.*
2. **Custom CLI with no read-only mode:** no unattended read-only roles unless the user accepts it. *Decided: yes.*
3. **Skills in worktrees:** shared library path with read access, no copies (§3.3). *Decided.*
4. **Screenshots:** any window and any screen, requested by leads and helpers, each with a per-request yes (§4.2). *Decided.*
5. **GitHub skill import:** allowed, with the download safeguards in §3.4. *Decided.*
6. **MCP secrets:** plain text (§5). *Decided.*
7. **Still open: Gemini as the first shipped template** (it is detected already but has no sign-in check). Default if you do not answer: ship it only if its flags verify cleanly with `--help`, otherwise skip.
8. **New, from the document request, still open:** Office files (`.docx`, `.xlsx`, `.pptx`) need a converter dependency. Default if you do not answer: skip them in this pass and use "Open in default app".

## 10. Known unknowns (must be verified in the session, not assumed)

Real flags of Gemini CLI and any template CLI; whether Codex has a native skills folder and what it is called; Codex's MCP config flag; the exact `~\.claude\projects` and `~\.codex\sessions` line formats; how Claude Code handles MCP tools in headless `acceptEdits` runs; `desktopCapturer` behaviour for other windows on Windows 11; whether `--add-dir` style read access exists for each CLI (needed for the shared skills library); whether Electron's PDF viewer works under Harbor's CSP and window hardening (`windowSecurity.ts`). The docs already mark images, full-access mode and permission prompts as unverified on both built-in CLIs, so the screenshot-to-model path inherits that risk.

## 11. Prompt for the implementation session (Opus 5.5)

> You are implementing `PLAN-open-cli-and-skills.md` in `C:\Users\andrei\Documents\RoutingManager`. Read `AGENTS.md`, `HANDOFF.md`, `docs/architecture.md` and the plan first. Implement **only the phase I name**, on its own branch `harbor/<name>` from `main`; do not push, do not touch `main`, do not edit `README.md` or `docs/**` (propose lines instead). Follow the contract rules (optional fields, CHANGELOG, `INVOKE_METHODS`, service implementation, tests). Verify third-party CLI flags with `--help` before using them and record anything you could not verify in the file header. Done means `npm test`, `npm run typecheck` and `npm run build` pass. Finish with: files changed, checks and results, unresolved issues, branch and commit, and what you did not verify. Renderer work (`src/renderer/**`) is allowed for this plan only for the screens it names, and only if the owner repeats that in the first message. Decisions already made are in §9: do not re-ask them. Start with phase: **<N>**.
