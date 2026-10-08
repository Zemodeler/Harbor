# Background routing and settings

## Purpose

Automatically assign project work to suitable AI CLIs, coordinate their contributions, and adapt effort to the task and available subscription allowance.

Routing runs behind the conversation interface. Users configure policy in settings and inspect decisions through execution details.

Routing works with automatic discovery and sensible defaults from the first launch. Users do not need to configure a routing policy to begin. The router selects from ready, signed-in CLIs and accounts for their project-relevant native skills and plugins.

## Routing sequence

1. The main agent receives the request and delegates substantive interpretation or investigation when needed.
2. A planning subagent defines a coordinated plan when needed; an already clear task can be assigned directly.
3. Identify eligible CLI adapters and their supported capabilities.
4. Refresh usage information where supported and necessary.
5. Obtain work and uncertainty estimates from the planning subagent, using adapter usage signals.
6. Automatically choose a CLI, model, effort level, and safe concurrency for each subagent assignment within policy.
7. The main agent dispatches focused subagents, passes structured handoffs, and monitors their reports.
8. Delegate replanning when scope changes; refresh routing when availability or allowance changes.
9. The main agent consolidates subagent reports into a coherent result in the original conversation.

Small requests should not pay the overhead of unnecessary planning or multi-CLI coordination. Multiple CLIs are available from the start, but each task uses as many as it needs.

## Decision inputs

- Task type, complexity, and acceptance criteria.
- Existing conversation and native CLI session continuity.
- Relevant project context and instructions.
- User preferences and project overrides.
- Adapter capabilities and current connection state.
- Native skills and plugins available in the project, including their setup and permission requirements.
- Remaining allowance, reset time, and reading freshness when available.
- Estimated effort and consumption uncertainty.
- Workspace ownership and concurrent editing constraints.
- API fallback permission and spending limits.
- Model availability, model-specific limits, shared account usage, reset windows, and any confirmed optional reset entitlement.

Avoid hard-coded claims that one provider is always best for a category. Role preferences should be configurable and informed by supported capabilities and, eventually, observed outcomes.

## Continuity before unnecessary switching

Prefer the current eligible CLI and native session when they retain useful context and can complete the assignment within policy. Include context transfer, session setup, lost extension state, and rework in the estimated cost of switching. A small allowance or effort advantage alone should not cause repeated handoffs.

Switch when required capabilities, connection failure, insufficient usable allowance, explicit user preferences, or a material expected benefit justify it. Record the reason and checkpoint before transferring work. Avoid switching back on every usage refresh; reconsider when a material input changes. Continuity never overrides hard limits or required capabilities.

## Work queue and interactive capacity

Maintain an application-wide schedule across project queues. Users can prioritize tasks, request "do this next," pause, resume, or cancel queued work. Dependencies still apply: a higher priority cannot start an assignment before its required inputs are ready. Queue ordering changes do not silently interrupt active writers; interruptions use the normal checkpoint and stop process.

Show why a task is waiting, such as a dependency, workspace ownership, concurrency, or allowance. Use explicit user priority first, then dependency readiness and waiting time to prevent indefinite starvation. Cancelling a prerequisite marks its dependents blocked and explains the missing input; it does not declare them complete or silently cancel unrelated tasks.

Reserve configurable execution capacity and usable allowance for responding to the user and handling steering while background work runs. This interactive headroom is distinct from a general subscription reserve. At low concurrency, checkpoint or pause suitable background work when necessary rather than making the user wait behind the entire backlog. When allowance cannot be measured, use conservative concurrency and allocation policies rather than claiming an exact reserve. Explain when provider limits prevent an immediate response.

## Subscription usage

Each allowance reading should preserve its provider's units, window, timestamp, and source. Providers may expose separate limits for different models or overlapping time windows.

Represent usage information in three forms:

| Form | Meaning | Routing behavior |
| --- | --- | --- |
| Reported | Allowance obtained through a supported source. | Use within its stated window and freshness limits. |
| Estimated | Approximation from available usage signals or user input. | Apply conservative assumptions and show uncertainty. |
| Unknown | No reliable allowance information is available. | Follow the configured unknown-usage policy. |

A missing reading never means unlimited allowance or zero remaining allowance. Old readings must be identified as stale.

Do not combine unlike quota units into a misleading single percentage. The planner should evaluate whether each provider can support its assigned work using that provider's available signals.

Prefer supported usage reporting mechanisms. Do not assume access to private subscription endpoints or universal quota APIs.

Maintain one application-wide usage ledger so projects and agents sharing a subscription cannot each assume the same allowance is available. Track work, estimates, reported consumption, pending reservations, and reset windows. Account for main-agent coordination, subagent conversations, retries, tools, and handoffs as well as implementation. See [Usage and resets](usage-and-resets.md).

The objective is to keep useful, authorized work progressing through the current allowance window and subsequent resets. Pace or reroute work as needed. Use the existing allowance effectively before proposing an optional reset; do not generate unnecessary work to consume it.

## Estimating work

Estimate each step before execution, then update the estimate using observed progress. Consider context size, likely tool work, required iterations, verification, and handoff overhead.

Subscription consumption may not map directly to API token counts. Use a calibrated range in supported units when possible, or a qualitative estimate with confidence when it is not.

Keep planned consumption separate from reported actual consumption. Mark unknown values explicitly. Never promise that a task will fit solely because an estimate says it should.

## Effort policy

Offer three understandable presets:

- **Adaptive:** choose effort according to complexity, consequence of errors, and available headroom.
- **Conserve allowance:** minimize unnecessary iterations and expensive steps while retaining essential checks.
- **Prioritize quality:** favor stronger reasoning and review where useful, within configured limits.

Map effort to native provider controls when supported. If an adapter has no effort setting, the app can adjust task decomposition, context selection, or verification strategy, but must not claim it changed a native reasoning control.

Difficulty and budget should both inform effort. A tight budget should not silently remove verification needed for a reliable result. If the available resources cannot reasonably support the requested work, explain the tradeoff in the conversation.

## Multi-CLI coordination

CLI, model, and effort are assigned automatically per subagent. Consider the single responsibility, complexity, extension requirements, available models, allowance headroom, reset time, and usage estimates. No per-agent setup is required. Settings can constrain eligible models or override preferences. Record supported effective settings rather than implying that every adapter exposes identical controls.

Each project has one main agent that coordinates its assignments and user-facing conversations. The main agent performs no substantive task work. Planning, estimation, investigation, implementation, verification, and integration are assigned to focused subagents. Background routing selects their CLI sessions under the configured policy.

All subagents are direct children of the main agent. A subagent cannot spawn agents through native CLI tools, plugins, or app controls. It requests a sibling through the main agent instead. Enforcing this rule is an adapter requirement; an adapter that cannot reliably constrain native spawning must be marked unsupported for this managed agent mode.

Each implementation assignment names one feature or bounded change and provides its specification. Broad design and research are separate assignments. See [Project agents](project-agents.md) for the assignment and reporting contract.

A handoff includes the objective, relevant context, completed work, changed files, unresolved issues, and acceptance criteria. Transfer only context needed for the next step.

Sequential work is appropriate when later steps depend on earlier changes. Parallel work is appropriate for independent investigation or isolated implementation. Avoid concurrent edits to the same working files; use separate workspaces or worktrees when supported and integrate results deliberately.

Any integration or conflict resolution is performed by a designated subagent, never by the main agent. Direct user prompts are recorded in the subagent conversation and surfaced to the main agent so dependencies, scope, and workspace ownership remain consistent.

Sibling agents communicate directly through project-scoped threads, regardless of their selected CLI. The application records file claims, dependencies, handoff acknowledgements, and material agreements. Parallel scheduling considers these records so an agent can do independent work while waiting for a shared file or upstream result. The main agent receives meaningful changes rather than relaying every exchange. See [Agent collaboration](agent-collaboration.md).

Provider switching should preserve the conversation while retaining the identity and history of each underlying CLI session. Native session resume is used only when the adapter supports it.

Limit retries, repeated review cycles, and coordination overhead. Stop and ask for input when a task requires a substantive user decision.

## Configurable settings

| Setting | Intended behavior |
| --- | --- |
| Allowed CLIs | Restrict which connections a project or conversation may use. |
| Allowed models | Constrain automatic model selection within each supported CLI. |
| Role preferences | Prefer selected CLIs for planning, implementation, review, or other work. |
| Effort policy | Select adaptive, conservation, or quality-focused behavior. |
| Subscription reserve | Preserve a configurable portion of measurable allowance. |
| Reset pacing | Pace authorized work against known reset windows and shared allowance. |
| Free reset prompts | Ask before consuming a confirmed optional free reset; allow dismissal or deferral. |
| Unknown-usage policy | Allow with caution, require confirmation, or exclude affected providers. |
| Low-allowance policy | Switch CLI, defer work, reduce optional effort, or ask the user. |
| Multi-CLI policy | Allow automatic coordination or constrain the eligible roles and providers. |
| Concurrency limit | Bound simultaneous sessions and workspace activity. |
| Active subagent limit | Bound active sibling agents per project; queue excess assignments. |
| Queue priority | Order authorized work across projects while preserving dependencies and preventing starvation. |
| Interactive headroom | Preserve execution capacity and usable allowance for user responses and steering. |
| Retry limits | Bound repeated execution and recovery attempts. |
| API fallback | Disabled, ask before use, or allowed within explicit limits. |
| API spending limits | Bound fallback spending per task and over a configured period. |
| Context transfer | Govern what project context can pass between connected providers. |

Scope precedence is: explicit task override, conversation override, project override, then global defaults. Overrides remain subject to any configured hard spending or execution limits.

Preset values and numeric defaults remain open design decisions.

## API fallback

Prefer CLI execution when a suitable CLI is available and can perform the work within policy. API tokens are an optional alternative when explicitly configured.

Do not silently start paid API execution unless the user has enabled that behavior and set applicable limits. If fallback requires approval, ask in the conversation and explain the reason and estimated cost range when available.

Fallback is disabled until the user adds an API key. After that it defaults to asking before use. Allowing it without asking requires explicit per-task and per-period limits chosen by the user, and those limits are hard stops.

## Adapter capabilities

Provide a baseline terminal adapter for connecting additional CLIs and dedicated adapters for richer integrations.

An adapter declares capabilities such as launch, input, output streaming, cancellation, terminal interaction, structured events, native session resume, effort controls, usage reporting, and workspace selection.

Adapters also declare installation discovery, authentication status checking, native skills and plugin discovery, extension invocation or native delegation, and preservation of native configuration. These capabilities can differ by tool and version.

The app must degrade gracefully when capabilities are absent. Interactive CLIs may require a real terminal surface rather than a fabricated structured transcript. Broad compatibility is a design goal; identical behavior across every CLI is not assumed.

## Visibility and interruption

Routine planning, provider selection, and allowance checks stay in the background. Execution details record the decision inputs and reasons so the user can inspect them.

Surface events that materially affect the user: a required decision, a blocked connection, an exhausted allowance, a significant scope change, a spending approval, or an execution failure.

Background operation does not mean hiding who receives project context, concealing spending, or losing the ability to stop work.

## Design acceptance criteria

- A user can complete ordinary work without manually choosing a CLI.
- A project retains its own conversations and linked CLI sessions.
- One task can involve multiple CLIs without splitting the user-facing conversation.
- Routing uses allowance information when available and clearly handles missing or stale information.
- Effort responds to both task needs and configured resource policy.
- Users can inspect why a provider was chosen and override applicable preferences.
- API fallback follows the configured permission and spending policy.
- Project switching does not mix context or silently stop active sessions.
- The default interface remains a project-based coding assistant conversation.
- An installed, signed-in supported CLI is usable without mandatory configuration.
- Settings distinguish installed tools that need login from ready tools and inconclusive checks.
- Compatible native skills and plugins remain usable in their owning CLI sessions.
- Each project has one coordinating main agent; all substantive work is delegated.
- Subagents have one clear assignment and cannot create nested agents.
- Users can prompt subagents directly, with changes visible to the main agent.
- Each subagent receives an automatically selected CLI, model, and effort level.
- Shared account usage and pending consumption are tracked across all projects.
- Optional free resets require explicit permission and are proposed only when useful after effective use of current allowance.
- Sibling communication, shared file ownership, and acknowledged handoffs support efficient parallel work.
- Routing preserves useful session continuity and records material reasons for provider handoffs.
- Users can control queued work across projects without bypassing dependencies or losing active changes.
- Background scheduling preserves interactive capacity for user messages and steering where resources permit.
