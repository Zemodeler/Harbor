# Project main agent and focused subagents

## Core model

Every project has one main agent. Its entire job is to assign work, monitor subagents, receive reports, and keep the user informed. It always delegates substantive work and never takes over a subagent's task.

All subagents are siblings under that main agent. Each has one clear responsibility. Users can talk to the main agent or open any subagent's conversation and prompt it directly.

Sibling agents can also communicate directly. They coordinate shared files, clarify existing contracts, exchange results, and unblock dependencies without routing every message through the main agent. Material agreements and blockers update the coordination record automatically. See [Agent collaboration](agent-collaboration.md).

This remains a project-first chat experience. Agent coordination happens behind the familiar interface and requires no setup wizard.

## Main agent responsibilities

- Receive user requests and maintain the project assignment register.
- Delegate planning or investigation when a request needs it.
- Dispatch clear assignments using background routing.
- Track ownership, dependencies, progress, resource limits, and blockers.
- Receive progress, completion, and failure reports.
- Handle requests for sibling agents, reusing an appropriate idle agent or creating one when needed.
- Relay decisions and relevant context between agents.
- Monitor direct sibling collaboration and resolve scheduling or ownership disputes; delegate substantive design disputes to a planner.
- Consolidate reports for the user, preserving their source and evidence.
- Pause, cancel, retry, or reassign work under the user's instructions and project policy.

The main agent must not write code, research the solution, design features, run verification, review changes, resolve conflicts, or integrate outputs. If such work is needed, it assigns a subagent. Monitoring and summarizing received reports are coordination; independently verifying their claims is a separate review or testing assignment.

There is one logical main agent per project, even if its underlying CLI session needs to restart or change provider. Its assignment register and report history must survive such changes. Multiple project conversations share that coordinator rather than spawning competing main agents.

## One responsibility per subagent

| Role | Single responsibility | Output |
| --- | --- | --- |
| Planner | Think through one requested feature or task. | Specification, acceptance criteria, proposed assignments, dependencies, and usage estimates. |
| Investigator | Answer one bounded technical or factual question. | Findings and supporting evidence. |
| Feature implementer | Implement one designated feature or bounded change from a specification. | Changes, implementation report, and any unresolved blockers. |
| Reviewer | Review a defined change against its specification. | Findings or a review result with evidence. |
| Tester | Verify a defined behavior or change. | Check results and failure evidence. |
| Integrator | Combine approved changes into a coherent workspace result. | Integrated changes and a report of conflicts or remaining issues. |

These are available assignment types, not mandatory stages for every request. A small, fully specified change may need only an implementer and appropriate verification. Do not create agents just to fill roles.

An implementation agent receives the feature definition before it starts. “No thinking” means no separate planning, exploratory research, architectural invention, or scope expansion in that assignment. Ordinary reasoning needed to execute the supplied specification is unavoidable; an unresolved design question goes back to the main agent for a planning or investigation assignment.

This restriction applies to implementation work, not to conversation. All subagents can talk normally with the user and other agents: explain their work, answer questions, discuss findings, clarify instructions, and report blockers. Communication does not authorize a different work role or independent scope expansion. Planning subagents explicitly perform the thinking and design needed for their assigned task.

A planner does not implement its plan. An implementer does not become a reviewer or integrator halfway through its assignment. Narrow execution checks may accompany implementation when explicitly included in its scope; independent verification remains a separate role.

## Assignment contract

Every assignment records:

- Assignment identifier and revision.
- Project and parent task.
- One responsibility and a concrete deliverable.
- Specification and acceptance criteria.
- Included scope and explicit exclusions.
- Relevant context, instructions, skills, and plugins.
- Dependencies and required inputs.
- Workspace and file ownership boundaries.
- Related sibling assignments, shared contracts, and any file handoff dependencies.
- Automatically selected CLI, model, effort, and resource limits, with the reason for selection.
- Required reporting and completion evidence.

If the assignment is too vague to implement, the main agent sends it to a planner. If it contains several independent features, the planner proposes separate sibling assignments. Do not use prompts such as “handle everything else.”

## Requesting a sibling

A subagent never creates another agent. When it needs help, it sends the main agent a request containing the reason, a proposed single responsibility, required inputs, expected output, and whether its own task is blocked.

The main agent decides whether to reuse a suitable agent, create a sibling, queue the request within concurrency limits, or seek clarification. It informs the requester and records the dependency.

No recursive delegation is allowed, including through native CLI subagent features or plugins. If the adapter cannot enforce that boundary, it must not silently offer the CLI as compatible with this managed mode.

## Direct user access

Users can inspect a subagent's conversation, send context or corrections, pause it, and request a different result within its assignment.

Direct prompts are delivered to the selected subagent and copied into the project's coordination record. The main agent receives a concise notification of material changes; users do not need to send the same message twice.

An in-scope instruction can proceed immediately. Instructions that affect another agent, conflict with ownership, or materially change the specification trigger coordination before dependent work continues. The main agent delegates substantive replanning instead of solving the new design itself.

Changing an assignment increments its revision. Reports identify the revision they fulfilled, so a result from an older specification cannot be mistaken for completion of the updated request.

## Reports

Direct sibling messages complement reports to the main agent. Agents may agree on execution order or exchange outputs within their existing assignments. They cannot use peer messages to create agents, grant themselves a new role, or silently change the specification.

Subagents send reports at meaningful milestones, on blockers or failures, and on completion. Avoid repetitive status messages with no new information.

A report includes the assignment and revision, status, work completed, outputs or changed files, evidence, unresolved issues, and any requested next action. Distinguish work performed from claims verified independently.

The main agent uses these reports to update progress and communicate outcomes. It does not present an unverified completion report as independently checked. Necessary verification is delegated to a reviewer or tester.

## Assignment lifecycle

Assignments move through queued, running, blocked, paused, ready for verification, complete, failed, or cancelled states as appropriate. A report alone does not complete dependent work if required checks or integration are outstanding.

When a CLI fails or exhausts allowance, the main agent can reassign the same bounded responsibility using the assignment record and latest report. Preserve history and avoid duplicate execution. Stopping an agent must end or confirm the status of its underlying activity before another agent takes its writable workspace.

## Example: add project switching

1. The user asks the project's main agent to add project switching.
2. The main agent assigns a planner to specify behavior and acceptance criteria.
3. The planner returns a focused specification and proposed assignments.
4. The main agent assigns one implementer the project picker and another the persistence behavior, if those changes can be isolated cleanly.
5. An implementer discovers an unresolved storage question and requests an investigation sibling through the main agent. It does not spawn one or redesign storage independently.
6. The user opens the picker agent and asks it to show the current project more clearly. The correction is recorded and the main agent is notified.
7. Implementers return reports. The main agent assigns integration and verification where needed.
8. The main agent summarizes the reported changes and check results for the user.

All feature work is performed by subagents. CLI, model, and effort selection are automatic under project policy. Users do not need to configure each agent manually. Record requested and effective settings separately when an adapter cannot apply or confirm a model or effort selection.

## Design acceptance criteria

- Each project has exactly one logical main agent.
- Every substantive user request is delegated, even when small.
- The main agent only coordinates, monitors, and reports.
- Each subagent has one clear responsibility and defined deliverable.
- Planning and implementation are separate assignments.
- Subagents request siblings through the main agent and cannot create nested agents.
- Users can directly prompt every subagent without duplicating instructions to the main agent.
- Material direct instructions update coordination and dependency records.
- Progress and completion reports return to the main agent and remain inspectable.
- Subscription limits and concurrency limits apply across the whole project team, including coordination overhead.
- All subagents can converse normally; implementation scope restrictions do not prohibit discussion.
- CLI, model, and effort are selected automatically for each assignment.
- Siblings communicate directly within the project and coordinate shared files without competing writes.
- Material peer agreements and blockers are visible to the main agent without requiring it to relay every message.

## Current stage

Design only. Agent roles, adapter enforcement, persistence, and communication behavior described here are requirements for later implementation.
