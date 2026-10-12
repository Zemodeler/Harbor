# Known limitations

Written from reading the code and the repository's own notes (`BACKLOG.md`, `HANDOFF.md`, `HARDENING-PLAN.md`). Other agents were changing `src/` while this was written, so an item marked "in progress" may already be merged and one marked missing may have landed. Check the code and `src/shared/CHANGELOG.md` before relying on a line here.

## Estimates, not measurements

- **Usage is mostly a guess.** Without a provider-reported window, Harbor counts the runs it started, weighted by their reported cost (or, when a run reports none, by a per-model weight in the catalog), and divides by a budget. Once two provider readings of one window exist, the budget is calibrated from them; until then it is a fallback guess (200 average runs per 5 hours, 120 per 7 days, measured once on one account) and the window is flagged `calibrated: false` and labeled "uncalibrated". A budget you set yourself counts every run as one. It cannot see anything you do outside Harbor, which makes a calibrated budget look smaller than it is. The numbers are labeled "estimated from Harbor runs only" and must never be read as your provider quota.
- **Reported windows can be stale.** Claude's account limits are seen only when Harbor itself runs Claude (from the `rate_limit_event` in its stream) and are persisted until their reset time; per-model limit names are inferred from a naming pattern, not verified for every plan. Codex limits are read from the newest of the five latest session logs under `~/.codex/sessions`, so they are as fresh as the last Codex use of any kind. Gemini has no usage reading and gets no window.
- **Pacing constants are reasoned, not measured.** Headroom routing (move work when one subscription has clearly more room in its tighter window, 5h or weekly) uses a points curve, a 28-point stickiness, a pace discount and a 25% "low headroom" threshold chosen by reasoning and tests against synthetic usage. Nothing has been checked against real week-long usage of a Claude and a Codex subscription. Codex's weekly and 5h numbers come from its local logs and can be stale; where either is only Harbor's estimate it counts at half. A high-complexity request can still move to Codex's single (standard) model when Claude is nearly spent, because the headroom penalty can exceed the tier-fit penalty.
- **Weekly pacing assumes a linear week.** It treats the allowance as a straight-line budget over the 7 days before a known reset, so a CLI you use in bursts (heavy on weekdays, idle at weekends) looks underspent or overspent when it is not. It acts only on a reset time Harbor knows; Claude's is seen only when Harbor itself runs Claude, so it can be old (trust falls with the age of the reading, and a reset that has passed is ignored). Use outside Harbor is invisible, so a CLI may have less left than the surplus suggests. Its constants (the 36h spend-freely window, the +35 and -20 caps, the urgency curve) are reasoned, not measured on real accounts.
- **Complexity from wording is a heuristic.** `estimateComplexity` reads keywords, length and paths, so it can rate a short but hard request low (a front-desk rating is only raised by it, never lowered; a request that skips the front desk is rated by it alone).
- **Routing quality is unproven.** The capability catalog (which model suits which need) is editable data, not benchmark results. There is no evaluation comparing Harbor's routing or delegation with a single agent on the same tasks, so "routing saves allowance" is a design hypothesis, not a measured result.
- **The concierge guesses.** It decides, with a cheap model, whether a message is simple and how hard the work is. It can answer wrongly or under-rate the work; code guards catch the obvious cases. `/deep` forces a strong lead.
- **Spawn failures and overload** are no longer counted as runs in the usage ledger: a CLI that failed to start (missing executable, unsupported flag) is skipped, and an overload (HTTP 529) is retried once on the same CLI without a cooldown. A rate limit that names no model cools the whole CLI.

## Cost of delegation

Delegation spends more of your subscription than one agent doing the same job in one session. This is an estimate from reading the code, not a measurement:

- Every helper is a new CLI session with no memory of the lead's reading. It loads the project instructions, the role contract and its assignment, and re-reads the files it needs. A planner, an implementer and a reviewer working on one feature read much of the same code three times.
- Harbor wakes the lead when a planner that nothing waits on finishes, a helper fails, or the last active helper finishes; each wake-up resumes the lead's whole session (re-reading its accumulated context) to receive reports of up to about 6,000 characters each. Wake-ups within about 400 ms are batched into one, and a planner whose implementers are already queued on its spec does not wake the lead (its report rides the final wake). A lead turn still costs a full resume.
- A reviewer after every implementer, an integrator's checks, and retries add further runs. A retry spends more only after a reviewer asked for changes or a Harbor check failed (a stronger tier first, high effort only when already on the top tier); a failure of the infrastructure retries at the same tier. One lead turn starts at most 4 helpers and 1 planner unless you ask for more. Goal mode can add up to 8 automatic continuations.
- Each user message also costs a concierge call unless Harbor skips it for obvious work. The Claude concierge runs without tools, MCP servers, skills or a saved session, in an empty folder; how much that saves was not measured.

For features that use several helpers, a rough multiplier of **2.5x to 5x** the allowance of one well-run single-agent session is a reasonable expectation, and more with planner plus several implementers plus reviewers. A task the lead does alone, with no helpers, costs about what a single CLI session costs plus a small constant overhead (the concierge call and Harbor's own system prompt); that overhead is not measured either. Delegation can still be worth it for wall-clock time (parallel work), for an independent review, or for work that would flood the lead's context, but it does not save quota. The estimate assumes similar models; Harbor tries to put cheap models on cheap work, which offsets some of it, by an unknown amount. Treat the numbers as a prompt to measure on your own tasks, not as a promise.

## Platform and distribution

- **Windows only.** Opening a login terminal (`cmd`), the `.cmd` shim handling, process-tree cleanup with `taskkill`, CLI discovery paths, the tray and the installer assume Windows. There is no macOS or Linux build and no plan yet.
- **The installer is not code-signed.** SmartScreen warns on first install, and update integrity rests on the GitHub account and release (see [Safety](safety.md)). Code signing is deliberately deferred.
- **Auto-update has not been exercised against a real release**, and the release workflow itself has not been seen running on GitHub (see [RELEASING.md](../RELEASING.md)). The repository must be public for unauthenticated update checks. The `autoUpdate` setting is read but is not in the typed settings or the UI; `HARBOR_NO_UPDATE=1` is the working switch.
- **No license file** is in the repository yet.
- **Provider terms.** Harbor drives subscription CLIs headlessly and sometimes in parallel. Whether that is within each provider's terms for your plan has not been decided or researched here; that decision is open (`BACKLOG.md`, product-owner requests). Check them yourself.

## Providers and adapters

- Two adapters: Claude Code and Codex. Gemini CLI is detected and shown but has no headless adapter and is never assigned work. There is no baseline terminal adapter for other CLIs and no API-key fallback.
- Codex: the run, resume and event-stream basics were checked on codex-cli 0.160.0; named model ids were not, so Harbor uses only Codex's default model. There are no host permission prompts for Codex (no approval channel), none of the Claude deny rules, and no confirmed way to disable any native sub-agent feature. Codex as a lead or concierge, and Codex in a real multi-helper run, have not been tried.
- Claude: the permission-prompt control channel and the deny-rule syntax are documented behavior that was not confirmed on a live turn. If either behaves differently on your CLI version, the prompts or the git denials may not work as described.
- No discovery or routing on native skills and plugins. They work inside each CLI's own session if installed there, but Harbor does not list them or route on them.

## Behavior that surprises people

- **The lead edits your project folder directly,** not a worktree. Helpers work from the committed `HEAD` in their own worktrees and do not see your uncommitted edits (Harbor warns once at delegation). Two leads in one project take turns to edit the folder; they cannot see each other's uncommitted changes.
- **Verification is only as good as `.harbor/checks.json`.** Without it nothing is run by Harbor. Reviewers are AI readers that cannot run tests; their verdict is advisory and covers only the commit they examined.
- **A helper's report is not proof.** The lead is told so, but it is still a model reading text.
- **Restarts interrupt work.** Running helpers become `stopped` (their work so far is committed to their branches), the lead needs a new message, and pending permission requests and questions are lost. Resume a helper from its saved session explicitly.
- **Direct messages to a running helper** are delivered after its current step, not mid-step. There is no hold-and-acknowledge protocol for instruction changes that affect dependent work (`BACKLOG.md`, item 15).
- **Streaming is per CLI message,** not per token.
- **Rollback is narrow.** It reverses the merge commits Harbor's integrations made (or recognizable older merges), one task at a time, only on a local branch, and it cannot be started by the lead. Work that arrived by fast-forward, squash or cherry-pick is reported as unsupported. External effects are never undone.
- **Concurrency is per project.** The default limit is 4 helpers at a time per project, and there is no application-wide queue, no reserved headroom for your interactive messages, and no priority across projects. Pause, resume and priority exist in the API and only order work within a project.
- **The `routing: manual` setting has no effect** on routing in the code I read; the connection on/off toggles do. Per-conversation CLI choice is not available (a message can name a CLI: "use codex").
- **Storage is one JSON file.** Messages grow without a cap until paging lands; `state.json` is written atomically with a rolling backup, and an unreadable file is kept aside and Harbor starts empty with a notice.

## Interface gaps

The committed renderer lagged the engine. Screens for integrate, apply and rollback, queue controls, resume of stopped helpers, the list of always-allowed tools, the routing, effort and reserve settings with per-project overrides, an export-diagnostics button and a confirmation before enabling `auto` mode were uncommitted work in progress when this was written; treat them as unverified until merged. Still not built: application-wide queue view, conversation-level CLI choice, skills and plugins area, and image thumbnails (the CSP blocks local files). Details: [Interface design](interface-design.md) and `BACKLOG.md`.

## Hardening still in progress

`HARDENING-PLAN.md` lists the waves. As far as I could see when this was written, these were not yet wired (the pure parts may exist): the per-turn protocol tag in prompts; a note to the next CLI after a started edit run fails over; a global or per-project cap on concurrent leads beyond the single edit slot; and paged message and git-log methods in the service (the contract and IPC list them, the service did not yet honor them). Do not treat any of these as present until the code and tests show it.
