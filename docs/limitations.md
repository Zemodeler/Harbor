# Limitations

From the code and `BACKLOG.md` / `HARDENING-PLAN.md`; check the code and `src/shared/CHANGELOG.md` before relying on a line.

## Estimates

- **Usage is mostly a guess.** Without a provider-reported window Harbor counts its own runs against a budget (a fallback of 200 runs per 5h and 120 per week, measured once, until two provider readings calibrate it). It cannot see use outside Harbor. Never read it as your provider quota.
- **Reported windows can be stale.** Claude's are learned only when Harbor runs Claude; Codex's are as fresh as your last Codex use. Gemini has none.
- **Pacing constants are reasoned, not measured**, and weekly pacing assumes a linear week.
- **Complexity** from wording and from the cheap concierge is heuristic. `/deep` forces a strong lead.
- **Routing quality is unproven.** The catalog is data, not benchmarks.

## Cost of delegation

Delegation spends more than one agent in one session: each helper re-reads the code, each lead wake-up resumes its whole context, and reviews, checks and retries add runs. Expect roughly **2.5x to 5x** the allowance for multi-helper features (an estimate, not measured). A task the lead does alone costs about one session plus a small constant. Delegation can still pay for wall-clock time, independent review, or work that would flood the lead's context.

## Verified and not

| | Claude Code | Codex |
| --- | --- | --- |
| Discovery, sign-in, headless run, streaming, session id | Verified on 2.1.293, incl. a real `npm run smoke -- claude --full` | Run, session id, events verified on 0.160.0; sign-in check unverified |
| Resume, effort | Flags accepted; resume in smoke | Used; full resume and per-model effort unverified |
| Models | `haiku`, `sonnet`, `opus`; `claude-fable-5-1` unverified | Default model only |
| Permission prompts and deny rules | From SDK docs, not seen live | Impossible; sandbox only |
| Images, full-access mode, writable roots | Unverified | Unverified |
| Native sub-agents disabled | By flag | Unknown |
| Lead or concierge, real multi-helper run | Not tried | Not tried |

Also unverified: auto-update and the release workflow ([RELEASING.md](../RELEASING.md)), the UI against a live engine, and the "Open in terminal/editor" actions on a real desktop. If Claude's prompts or git denials fail on your version, see [Safety](safety.md).

## Platform and providers

- Windows only. The installer is unsigned.
- Whether headless, parallel use of subscription CLIs fits each provider's terms for your plan is unresearched. Check yourself.
- Only Claude Code and Codex have adapters; Gemini is detected but never used. No terminal adapter, no API fallback.
- Native skills and plugins work inside each CLI but Harbor does not list or route on them.
- "Open in editor" needs the editor installed and registered for its URL protocol.

## Surprises

- **The lead edits your folder directly.** Helpers start from the committed `HEAD` and don't see uncommitted edits (Harbor warns once). Two leads take turns.
- **Verification is only as good as `.harbor/checks.json`.** Reviewers can't run tests; their verdict covers one commit.
- **Restarts interrupt work.** Helpers become `stopped` (work committed), the lead needs a new message, pending prompts are lost.
- **Direct messages** reach a running helper after its current step. No hold-and-acknowledge for changed specs.
- **Streaming** is per CLI message, not per token.
- **Rollback** handles merge commits only, one task at a time, and the lead cannot start it.
- **Concurrency** is per project: no cross-project queue or reserved capacity for your messages.
- **`routing: manual`** has no effect. A message can name a CLI ("use codex").
- **Storage** is one JSON file and grows until paging lands.

## Interface gaps

Built but only tested against the in-memory mock: integrate, apply, rollback, queue controls, routing settings, tool rules, diagnostics export, auto-mode confirmation. Not built: cross-project queue view, per-conversation CLI override, skills area, image thumbnails (the CSP blocks local files), integrated terminal. Quality gaps (re-rendering, no virtualization, one global error string, accessibility audit) are in `BACKLOG.md`.

## Hardening in progress

See `HARDENING-PLAN.md`. Not wired when written: the per-turn protocol tag in prompts, a note to the next CLI after a started edit run fails over, a cap on concurrent leads, and paged message and git-log methods in the service.
