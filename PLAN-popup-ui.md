# Plan: popup and dialog overhaul (src/renderer only)

Goal: one consistent, accessible dialog, toast and menu system. All work is in `src/renderer/**` (UI-owned). No contract changes.
Done = `npm run test:renderer`, `npm run build` and the renderer typecheck (`src/renderer/tsconfig.json`) pass.

## Findings that change the original list
- Toasts render below open modals: `showModal()` puts a dialog in the top layer, which beats `z-index: 50`. A question toast is invisible while any modal is open. Fix with `popover="manual"` on the toast region.
- Three destructive styles exist (`.danger` in Harbor, `p.danger` in ProjectSettings, `menuDelete`) and Delete conversation uses the accent `primary`. "Remove project" has two flows (App dialog, ProjectSettings).
- Inline confirms (`.fxConfirm` in CustomCli, McpServers, Skills; ModePicker; PermissionRequests; ProjectSettings) are hand-rolled each time.
- Sidebar menu is a `<details>` with no menu semantics; it pushes the list down with `padding-bottom: 136px/170px`.
- `title=` is the only tooltip (inaccessible on touch).
- Onboarding closes on Esc (finishes the guide).
- jsdom: setup stubs `showModal`/`close` only. No `cancel` event, `getAnimations`, `showPopover` or `transitionend`. Every animation or popover path needs a guarded fallback.

## Work packages
New folder `src/renderer/components/ui/` with `ui.module.css`; `components/Modal.tsx` becomes a shim re-export.

**P0 Foundation (first, alone).** `ui/Modal.tsx` (size sm/md/lg/full, `Modal.Body`/`Modal.Footer`, scrolling body with pinned footer, backdrop click, `@starting-style` open animation, closing state with sync fallback in jsdom, reduced-motion, bottom sheet at <=640px, optional `description`, `role="alertdialog"` for confirms only), `ui/ConfirmDialog.tsx`, `ui/InlineConfirm.tsx` (keeps `role="group"` and the existing names), danger tokens/button variant, z-index scale, `tests/setup.ts` stubs, new `tests/Modal.test.tsx`. Keep old `.modal`, `.modalHeader`, `.actions` until the final cleanup.

**Parallel after P0 (disjoint files):**
- P1 Toasts: `Toasts.tsx`, `hooks/useToasts.ts`, `toasts.ts`, toast block of `Navigation.module.css`. Per-toast icon, `role` (alert for failed/question), exit animation, pause on hover/focus, close button, cap 3 with "+N more", popover so it sits above modals. Keep region label "Notifications" and the `Open conversation: ...` / `Dismiss notification: ...` labels. Beware duplicate `getByRole('status'|'alert')` matches in tests.
- P2 Menu + Sidebar: `ui/Menu.tsx` (role=menu, arrows/Home/End/typeahead, Esc, focus return, separators, danger item, floating so no list padding hack), `Sidebar.tsx`, menu CSS in `Harbor.module.css` (lines ~236-240, 329-331, 680-684), update `Hardening.test.tsx` 374-388 and `App.test.tsx` 77-86. Delete uses `ConfirmDialog` with Keep as autofocus and a red Delete.
- P3 Inline confirms and project removal: `CustomCli`, `McpServers`, `Skills`, `ModePicker`, `PermissionRequests`(+css), `ProjectSettings`(+css), `Features.module.css` confirm block. Move to `InlineConfirm`/danger button. Update `Features.test.tsx` 36-50 and Mcp/Skills/CliConnections tests.
- P4 Modal callers: `Onboarding` (numbered step dots, status icons, fixed title, non-dismissible), `ReadyToApply` (non-modal bottom-right card, Later + Review changes), `RollbackDialog` (summary line, collapsed Files, danger apply step), `TagEditor` (chips), `CommandMenu` (own wide top-anchored layout, hint bar, group headings, keep listbox/option roles), palette CSS in `Navigation.module.css`. Rename dialog extracted to its own component (select text on open, counter near 160).

**Then P5 (after P2 and P4):** `App.tsx` + `hooks/useDialogStack.ts` + `ui/DialogHost.tsx`. Replaces the `!dialog && !renaming && !menu ...` conditions (App.tsx ~95, 201-212) with a priority stack so Ready to apply and Onboarding wait their turn. Add-project dialog: picker-first layout with path validation. Only this package edits `App.tsx`.

**Then P6 (optional):** `ui/Tooltip.tsx` replacing `title=` on icon buttons (Conversation, Sidebar, App).

**Final cleanup:** delete unused `.modal`/`.modalHeader`/`.actions`/`.danger` variants once no caller remains.

## Test constraints (must keep)
Dialog titles used by tests: Delete conversation?, Ready to apply, Preview rollback, Quick actions, Edit tags, Welcome to Harbor, Connect your tools, How Harbor works, Conversation history, Session details. Keep `aria-label`s `Options for ...`, `Delete conversation ...`, `Confirm Auto mode`. Renderer tests: `npm run test:renderer`; in git worktrees run `npm --prefix src/renderer install` first and avoid parallel test runs.

## Execution
Run P0 myself on `harbor/ui-polish`. Then P1-P4 as parallel helpers, each in its own worktree, each told its file list and to touch nothing else; merge, then P5, then P6, cleanup, full test/build.
