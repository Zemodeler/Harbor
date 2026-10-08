# Usage accounting and reset-aware execution

## Goal

Keep authorized project work progressing by assigning suitable CLIs, models, and effort automatically and making effective use of available subscription allowance until it resets.

Track the whole application, not just individual agents. Every project main agent draws on a shared resource view when its team uses the same account or subscription.

## Automatic assignment

For each subagent assignment, select the CLI, model, and effort together. Consider responsibility, specification, complexity, native extensions, model availability, estimated consumption, remaining allowance, and time until reset.

Planning can justify a different model and effort from implementation. An implementer follows its specification and delegates unresolved design questions through the main agent; this does not require a universally minimal effort setting. All subagents remain able to converse normally.

Users can constrain selection in settings, but ordinary assignments require no manual choices. Record requested settings, confirmed effective settings, selection reasons, and any adapter limitations. A provider change must preserve required capabilities and task context.

## Shared usage ledger

Record usage by account or subscription, provider, model where known, allowance window, project, task, agent, assignment revision, and session. Include timestamps and source quality.

Track all observable activity: coordination, planning, implementation, conversation, review, tests, integration, retries, and handoffs. Record tokens, requests, cost, duration, or provider quota units only where available. Tool activity can contribute to consumption but must not be counted as an extra billable unit without evidence.

Keep these values separate:

- Planned consumption: an estimate for queued work.
- Reserved consumption: headroom provisionally allocated to active work.
- Observed consumption: measured activity from execution.
- Provider-reported allowance: authoritative snapshots where supported.
- Estimated external consumption: inferred account use outside Harbor, where possible.

Reconcile reservations when work completes, fails, or stops. Do not double-count an execution event and the provider snapshot that already includes it. Preserve history across restarts and resets. Mark missing information unknown rather than fabricating an exact count.

Shared account snapshots may include use outside Harbor without identifying its source. Show any attribution gap rather than assigning all account usage to app agents.

## Reset windows

Track each provider's window separately, including rolling windows and concurrent short-term, weekly, or model-specific limits when exposed. A reset in one window may leave another limit exhausted.

Record the known reset time, its source, freshness, and uncertainty. Do not invent a countdown when reset timing is unavailable. Refresh allowance after a reset instead of assuming full capacity.

When a provider grants a new allowance window, retain the earlier window's accounting and start the new period's records. Rolling windows must retain their actual semantics rather than being treated as a single fixed reset.

## Pacing useful work

Use the authorized backlog and planning estimates to decide which work can proceed now, which should use another eligible connection, and which must wait.

Avoid exhausting capacity early through unnecessary high effort or excessive concurrency. Conversely, use expiring allowance effectively for useful queued work when doing so fits the task and policy. Reassess estimates from observed results instead of relying on the initial plan indefinitely.

“Max it out before resetting” means obtaining useful work from the existing allowance before consuming an optional reset. It does not mean creating filler tasks, repeating checks without cause, or intentionally triggering failed requests. A small unusable remainder need not be forced to exactly zero.

Configured reserves remain explicit. Defaults should support effective use of allowance; a reserve is not a reason to silently abandon authorized work. If a user-set reserve prevents progress, explain the choice rather than silently bypassing it.

When resources are insufficient, checkpoint active work, preserve reports, and queue dependent assignments. Eligible alternatives can continue under policy. Resume queued authorized work after a confirmed scheduled reset when the app is running; respect explicit pauses and cancellations. Do not promise background execution while the computer or app is unavailable.

## Optional free resets

Some integrations may expose a reset entitlement. This is an optional adapter capability, not an assumed feature of every subscription. Distinguish a scheduled automatic refresh from consuming a discretionary reset entitlement.

Before offering a free reset:

1. Confirm the entitlement exists, is available to this account, and is actually free using a supported source.
2. Establish which allowance it restores and whether other limits will still block work.
3. Use the current allowance effectively for useful authorized work first.
4. Compare the reset with waiting for the scheduled refresh or using another eligible CLI.
5. Check that the remaining backlog can benefit from the restored capacity.
6. Ask the user before consuming the entitlement.

The approval names the affected account and window, remaining usable allowance, entitlement count if known, expected restoration, next scheduled refresh, and the useful work it would unblock. An entitlement count or effect that cannot be confirmed is labeled unknown; do not market an uncertain action as a verified free reset.

Permission applies to the stated reset, not unlimited future resets. Declining or deferring does not imply approval later. Keep working within available resources or wait according to policy without repeated unchanged prompts.

After approval, use a supported reset action if available. If the action is only possible in the provider's own interface, guide the user to it and verify refreshed allowance afterward. Record the approval, outcome, updated entitlement, and usage snapshot. An inconclusive result must be checked before retrying to avoid consuming a second entitlement.

## Acceptance criteria

- CLI, model, and effort are assigned automatically for every subagent.
- General conversation and coordination consumption are included where observable.
- Shared subscriptions cannot be independently overallocated by different projects.
- Reported, estimated, reserved, and unknown usage remain distinguishable.
- Reset windows retain their provider-specific semantics.
- The scheduler favors useful progress through the current allowance period.
- Existing allowance is used effectively before a discretionary free reset is proposed.
- No discretionary reset is consumed without explicit permission.
- A scheduled refresh can unblock queued work without erasing history or resuming cancelled tasks.

Design only. Provider reporting, model controls, and reset capabilities require verification during implementation.
