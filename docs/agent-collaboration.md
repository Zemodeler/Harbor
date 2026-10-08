# Direct subagent collaboration

## Goal

Let sibling agents work as a coordinated team. They should communicate directly about shared files, dependencies, existing interfaces, findings, and handoffs, without requiring the main agent to relay every exchange.

Each agent retains one clear assignment. The main agent remains responsible for assignment, monitoring, and agent creation. Collaboration does not permit nested agents or unplanned scope expansion.

## Project communication

Provide direct messages and small shared threads between agents in the same project. Agents can discover relevant siblings through an assignment directory showing role, scope, status, owned files, and dependencies.

Messages use a common application channel across different CLIs. Native provider sessions remain distinct. The application delivers relevant peer messages through a supported adapter mechanism at a safe execution boundary and records delivery and acknowledgement. Sending a message does not itself transfer file ownership.

Each message identifies its sender, recipients, assignment revisions, purpose, and relevant files, contracts, or output references. Support ordinary discussion alongside explicit requests, replies, agreements, blockers, and handoff events.

Agents can ask one another questions, share available results, coordinate edit order, and clarify already specified behavior. New design decisions go to a planner through the main agent; new assignments and sibling creation always go through the main agent.

## Working on shared files

Before editing, an agent declares the affected files and intended change. The application checks active ownership and expected overlaps, then alerts relevant siblings when coordination is needed.

Use these strategies:

| Situation | Collaboration strategy |
| --- | --- |
| Independent files | Work in parallel, sharing interface updates when relevant. |
| Same file in one workspace | One writer at a time, with an explicit handoff. Other agents can read or work elsewhere. |
| Same file in isolated workspaces | Exchange intended changes and baseline revisions, then have an integrator combine outputs deliberately. |
| Shared interface or schema | Use a versioned contract from the planner; notify consumers when a revision is proposed. |
| Unresolved overlap | Pause only conflicting work and escalate ownership or planning decisions to the main agent. |

The initial design uses whole-file write ownership in a shared workspace. Different sections of the same file are not automatically safe for simultaneous edits. Coordination messages alone cannot prevent overwrites; the application must enforce ownership through supported workspace controls. If an adapter cannot enforce shared-workspace ownership, use isolated workspaces or serialize execution instead.

Claims must cover the actual affected resources, including generated files or shared configuration. Unexpected edits outside a claim require coordination before continuing. Workspace isolation remains useful even when sibling agents communicate well.

## Ownership handoff

1. The requesting agent names the file, intended edit, and dependency.
2. The current owner acknowledges and identifies a safe handoff point.
3. The owner finishes or checkpoints its change and reports the exact baseline revision and relevant checks.
4. The application confirms the writer has stopped and releases ownership.
5. The next agent acknowledges the handoff, reads the current file, and acquires ownership before editing.
6. The application records the transfer and updates affected dependencies.

A queued message or timeout must not automatically grant ownership. If an agent crashes, stop or confirm its underlying execution state before releasing its claim. Do not let two agents believe they own the same shared file.

## Efficient teamwork

- Share concise findings and output references instead of copying entire conversations.
- Reuse existing investigation and planning results rather than repeating them.
- Agree on versioned inputs and outputs early so independent implementation can proceed in parallel.
- Publish useful partial results at clear checkpoints when another assignment can consume them safely.
- Continue independent in-scope work while waiting; block only the dependent portion.
- Notify affected siblings when an interface, specification, or user instruction changes.
- Batch nonurgent updates and avoid repeated unchanged status messages.
- Escalate unanswered blocking requests after a bounded wait; avoid message loops and mutual waits.

The application detects circular dependencies and prolonged waiting. The main agent resolves scheduling or dispatches a planner to resolve a substantive conflict. It never implements the fix itself.

## Shared agreements and context

Keep material agreements in a project coordination record: participating agents, assignment revisions, decision, affected files or interfaces, prerequisites, and acknowledgement status.

A conversational suggestion is not an agreed contract. When a planner revises a contract, notify affected agents and record whether they have acknowledged it. Results produced against an older revision need reassessment before integration.

Direct user instructions remain visible to the main agent. If they affect a sibling, notify that sibling before it proceeds with incompatible dependent work. A peer message cannot override an explicit user instruction or silently enlarge an assignment.

## Main agent visibility

The main agent can inspect all collaboration threads. It receives concise events for material agreements, dependency changes, ownership disputes, scope changes, blockers, and completed handoffs.

Routine questions and answers do not require main-agent approval. Within assigned scope and existing contracts, siblings coordinate freely. This preserves the main agent's monitoring role while avoiding a central message bottleneck.

Subagents continue to report completion and blockers to the main agent, even when they have already discussed them with peers.

## Usage and interface

Account for peer communication and any resulting model calls in the shared usage ledger. Deliver only relevant context and avoid broadcasting every message to every agent or waking every agent for each update.

The interface remains a project-based chat app. Users can open a subagent's conversation, expand its collaboration activity, inspect shared-file ownership, and add clarification. The main conversation presents concise team progress instead of a constant stream of internal messages.

## Example: two features need one settings file

The project picker agent and the session persistence agent both need to update `project-settings.ts`.

The app detects the overlap. The picker agent tells its sibling which field it is adding and references the planner's settings contract. The persistence agent acknowledges and works on its independent storage code while the picker agent owns the shared file.

After its edit, the picker agent releases the file with a revision reference. The persistence agent acknowledges, acquires ownership, reads the updated file, and applies its own bounded change. A testing agent later verifies the combined behavior.

If the shared contract is missing a needed field, the agents request planning help through the main agent instead of improvising conflicting designs. The main agent monitors the handoff and receives reports; it performs no edits.

## Acceptance criteria

- Siblings on different CLIs can communicate directly within their project.
- Users can inspect peer conversations and add clarification.
- Agents can discover relevant siblings without reading every conversation.
- Shared files have one active writer per shared workspace.
- Ownership transfers require acknowledgement and a current baseline.
- Isolated changes receive deliberate integration rather than silent overwriting.
- Material agreements and dependencies are visible to the main agent.
- Collaboration preserves each agent's role and the prohibition on nested spawning.
- Blocked agents can continue independent work without duplicating their siblings' efforts.
- Communication overhead is tracked and unnecessary broadcasts are avoided.

Design only. Messaging, delivery guarantees, workspace controls, and adapter enforcement remain requirements for later implementation.
