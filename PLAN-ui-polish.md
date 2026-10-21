# PLAN: UI polish pass (2026-10-16)

Branch: `harbor/ui-polish` (never pushed to main; the owner merges).
Scope owner override: the owner asked for this work in chat on 2026-10-16, which covers `src/renderer/**` for this pass only (AGENTS.md: UI owns the renderer; core agents otherwise do not edit it). `README.md`, `docs/**` and `src/shared/**` are untouched; no contract change, so no `CHANGELOG.md` entry.

Skills consulted: `impeccable` (Operate mode: scanability, consistency and the real usage scene beat expression; brand lives in precise details; refinement preserves identity, behaviour and copy), `design-system` (three-layer tokens: primitive -> semantic -> component, no raw values in components). The impeccable launcher was not present on this machine, so PRODUCT.md/DESIGN.md do not exist; the direction below is derived from the code and the 2026-10-16 review.

## Direction

Harbor is an operating tool for one person who watches agents work. Mode = **Operate**. Keep the existing identity (anchor logo, teal harbor palette family, ten palettes, three layouts, light/dark/high-contrast). Do not add palettes or layouts. The aim is a calmer, clearer hierarchy, not a new look:

1. One primary action per state; everything else is quiet.
2. Structure and rhythm: a real type scale, spacing scale, radius scale and two elevation levels.
3. Make state legible: status pills, result cards, verification evidence.
4. Settings stops being one long form.
5. Nothing may regress accessibility (focus, contrast, reduced motion, forced colors, 44px touch targets <= 760px).

## Constraints that shape the work

- Every palette defines 13 tokens in `appearance.ts` and `paletteTokens()` writes them to `:root`. New semantic tokens must derive from those (`color-mix`) so all ten palettes and high contrast keep working. `--success`/`--warning` are already referenced in CSS; verify they are defined, define fallbacks if not.
- Renderer tests (`src/renderer/tests`, vitest + RTL) query by role/name/text. Keep accessible names, roles and visible labels of existing controls stable. Where a control is restructured (Settings tabs -> vertical tablist), keep `role=tab`, names and keyboard behaviour and extend the test.
- CSS is one big module plus a few small modules. Later rules override earlier ones (the file is append-only history). New work goes into one new module `src/renderer/ui.module.css`... only if the cascade requires it; prefer editing the existing rule in place so there is one truth per selector.
- Windows, Electron, no remote fonts (README: no remote fonts). Fonts stay system: Segoe UI Variable / Segoe UI; mono = Cascadia Mono / Consolas.

## Phases

### P0 Baseline (before any edit)
- Branch `harbor/ui-polish` off current `main` (working tree already has unrelated core edits; commit only renderer files).
- Run `npm --prefix src/renderer test` and `npm --prefix src/renderer run build`; record pass/fail.
- Screenshots (demo build, `npm run dev:renderer`): conversation, Live activity, Settings > Connections, Appearance, Git, narrow (390), dark + light, in the default `command` palette. Kept in the scratchpad, not committed.

### P1 Design tokens (foundation, no visual surprises)
Add to the first `:root` block in `Harbor.module.css`, semantic layer only (palette tokens stay as primitives):
- Type scale: `--fs-xs 12px`, `--fs-sm 13px`, `--fs-md 14px`, `--fs-lg 16px`, `--fs-xl 20px`, `--fs-2xl 28px`; `--font-mono: 'Cascadia Mono','Cascadia Code',Consolas,monospace`.
- Spacing: `--sp-1 4px` ... `--sp-8 40px` (4/8/12/16/20/24/32/40).
- Radius: `--r-sm 6px`, `--r-md 8px`, `--r-lg 12px`, `--r-pill 999px`.
- Elevation: `--elev-1` (composer, popovers: 1px line + soft shadow), `--elev-2` (modals, menus). Shadow colour from `color-mix(in srgb, var(--ink) X%, transparent)` so it works on every palette.
- Status tones derived from palette: `--ok`, `--warn`, `--bad` plus `--ok-wash`, `--warn-wash`, `--bad-wash` (mix with `--bg`). Fallback for `--success`/`--warning` aliasing these.
- `--muted` contrast: verify each palette's `muted` on `bg`, `surface`, `sidebar` >= 4.5:1; fix offenders in `appearance.ts` (data only) only where they fail.
- Replace the magic radii/sizes in the rules we touch with the tokens; do not mass-rewrite untouched areas.

### P2 Buttons and controls (hierarchy)
- Default `button` stays outlined but lighter (border at `--line`, hover wash). Add classes: `.primary` (exists), `.quiet` (borderless text/icon button, hover wash), `.danger` (destructive confirm), `.pill` (status/tag).
- One filled primary per view region. Audit and downgrade: Live activity actions, Conversation "Review current changes", workspace summary, header Git/Live activity (-> quiet icon+label).
- Toggle switch component (`Switch.tsx` + css, `role=switch` on a native checkbox) replacing `Enable <CLI>` checkboxes. Label text unchanged so `getByLabelText('Enable Codex')` keeps working.
- Inputs: consistent height 36px, radius `--r-md`, visible focus ring using accent + offset, error state styling.
- Hover/pressed/disabled states defined for every variant (design-system spec table); replace `filter: brightness` hovers with token-based mixes.
- Tooltips: `title` on every icon-only button (attach, image, templates, project options, close) and keep `aria-label`.

### P3 Conversation view
- Message structure: assistant turn gets a left rhythm (avatar + name + time byline at 13px), a max reading width of ~70ch inside the 860px column, 16px/1.65 body, clear 28px separation between turns. User bubble keeps `--surface`, radius `--r-lg`.
- "Execution details · why this model": replaced by a **model badge** pill in the byline (`Codex · implementer`) that expands the existing `RoutingDetails` in place. Keep `<details>` semantics for tests; only the summary presentation changes (text "Execution details · why this model" stays available as the accessible name).
- `AgentOutcome` becomes a **result card** (restyle in `Features.module.css`): outcome pill (Done / Partial / Blocked with tone colours), summary, then two clearly labelled groups: "Verified by Harbor" (pass/fail rows in mono, commit hash) and "Reported by the helper" (muted, dashed "says pass" pill). Same data, same strings used by tests.
- "Review current changes" becomes the card's single primary action when a result exists; the loose button below the stream is removed when the card is present (kept otherwise).
- Tool activity group: tighter, mono command text, consistent icon size, time right-aligned.
- Composer: elevated (`--elev-1`), mode picker as a compact segmented control, Send as the only filled button, hint line 12px.
- Empty states: no conversation -> centred brand, one-line purpose, three clickable example-prompt chips that fill the composer draft (copy to be reviewed by the owner); no project -> primary "Open a project" + the first-run guide link.

### P4 Live activity panel (Command layout)
- Width 320px, resizable is out of scope (listed in backlog); header with status pill instead of loose "Needs input" text.
- Agents list: avatar-less compact rows (name, role / cli, state pill, per-row Stop as an icon button with tooltip). Remove the stacked "Stop agent" text buttons.
- Outcome and checks live in a collapsible "Verification" section; recent tool activity in "Activity"; panel actions (`Open terminal`, `Open in editor`, `Show folder`, `Show changed files`, `Preview rollback`) collapse into one primary "Review changes" button plus a "More" menu (keyboard accessible, Escape closes, uses the same popover pattern as the sidebar row menu).
- Header action buttons (`Live activity`, `Git`) quiet, with icon.

### P5 Sidebar and rail
- Loading state: skeleton rows (reduced-motion safe) instead of inline "Loading conversations…" text; keep `role=status` text for tests/AT (visually hidden).
- Conversation row: title 13.5px (2-line clamp), status as a small pill line (size 12px, tone colours only for needs-input/failed/working), one `...` menu (Pin, Rename, Edit tags, Archive, Delete); the separate hover `x` delete button moves into the menu (Delete keeps the same confirmation dialog and busy-disable rules; test names for "Delete conversation <title>" preserved on the menu item).
- Footer anchored: Conversation history link + "Local workspace" label with consistent 12px muted type.
- Rail: tooltip labels on chips, active indicator kept, unread/attention dot for projects with a waiting agent (derive from existing state only; no API change; if the data is not available per project, skip and note in backlog).

### P6 Settings
- Layout: left vertical nav (grouped: General = Connections, Appearance, Workspace; Routing = Routing, Usage, Project; Integrations = Skills, MCP servers; Maintenance = Import & export, Diagnostics) and a content column (max 760px). Under 900px the nav becomes the current horizontal scrolling tab strip. Same tab names, `role=tablist` with `aria-orientation=vertical`, Up/Down plus Home/End keys (Left/Right kept for horizontal mode).
- Connections: each CLI is a card: name, version, state pill (Ready / Needs login / Not installed / Status unknown), `Enable` switch, primary action when relevant (Sign in). Path override, Test, Save path, Browse go in an "Advanced" `<details>` that auto-opens when a path is saved or invalid. Capabilities note (`CliFeaturesNote`) stays visible and compact.
- Page header: title + muted line, no oversized whimsical headline gap; `Refresh` quiet button.
- Appearance tab keeps its content; palette grid cards get consistent radius and selection ring (also fixes the radio overlapping the caption).
- Forms: `field` pattern with label above, helper text below, 12.5px.

### P7 Accessibility, motion, density, responsiveness
- Focus ring tokens used everywhere; verify in all themes incl. forced-colors and high contrast.
- Reduced motion: the new skeleton, disclosure and switch transitions respect `prefers-reduced-motion`.
- Density attribute (`data-density=compact`) extended to the new rows/cards.
- Touch targets >= 44px under 760px for new controls; verify 390px layout.
- Large text setting (`data-text-size=large`) still works with the type scale.

### P8 Verification (done = all pass)
- `npm --prefix src/renderer test` (new tests: Switch semantics, Settings vertical tablist keys, sidebar delete via menu, result card strings, empty-state chips fill the draft).
- `npm test`, `npm run typecheck`, `npm run build` (AGENTS.md definition of done). Serial, not parallel (a renderer test has a 5 s budget).
- Screenshots after: same set as P0, plus all 10 palettes spot-checked on conversation + settings, light/dark/high contrast, 1400, 1100, 760, 390 widths. Console errors none.
- Automated contrast spot check of muted/ink/accent/status tokens across palettes (script in the scratchpad, results summarised in the final report).

### P9 Close-out
- `BACKLOG.md` "UI requests": resizable Live activity panel, per-project attention dots if needing API, saved density per device, any copy changes the owner must approve.
- `src/renderer/README.md` structure section updated for new components (it lives under the renderer, so within scope).
- One commit per phase on `harbor/ui-polish`; message ends with the Claude co-author line. No push.

## Risks
- CSS cascade: this file layers overrides; a rule edited in the wrong layer silently loses. Mitigation: edit in place, grep every selector for later redefinitions before changing it.
- Test fragility on text. Mitigation: keep strings; add data attributes only for new hooks.
- Ten palettes: any new token must be derived, never hard-coded.
- Settings restructure touches `Settings.tsx` (95 dense lines); keep the split by tab into small components rather than growing the file.
- Unverified until run: real Electron window (only the browser demo is screenshotted); I will say so in the report.

## Out of scope
Resizable panels, new palettes/layouts, animation system, illustration, light/dark logo variants, any `src/main` / `src/shared` change.
