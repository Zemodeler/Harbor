# Automatic connections, skills, and plugins

## Core principle

Install Harbor and start working. Discovery, connection checks, and native configuration reuse happen automatically. Settings offer control without becoming a prerequisite for ordinary use.

This immediate-start path assumes at least one supported AI CLI is installed and signed in. When that is not true, the app explains the missing step and offers the shortest supported path to install or sign in.

## First launch

1. Open the project interface immediately.
2. Discover supported CLIs in the background using known executable names, configured paths, and supported installation locations.
3. Check availability and authentication with noninteractive, supported mechanisms where possible.
4. Discover project-relevant native skills and plugins where supported.
5. Enable ready connections for automatic routing under sensible defaults.

Do not install tools, change authentication, enable new plugins, or alter native configuration merely because they were discovered. A scan observes the existing environment.

## Connection states

| State | Meaning | User action |
| --- | --- | --- |
| Checking | Discovery or a status check is in progress. | Usually none. |
| Ready | Installed and authenticated through a supported check. | Start working. |
| Installed — login required | Installation found; authentication is confirmed missing or expired. | Use the native sign-in flow. |
| Installed — status unknown | Installation found; authentication cannot be established reliably. | Retry the check or open the native tool. |
| Unavailable | A previously discovered tool cannot currently run. | Inspect the reason or refresh discovery. |
| Not installed | A supported integration has no discovered installation. | Optional installation. |

Authentication and remaining allowance are separate states. A signed-in CLI may have exhausted allowance. Missing quota information does not mean the user is logged out.

Keep checks bounded and non-disruptive. Do not launch interactive login prompts during discovery or read and display credential secrets. Reuse native authentication through the CLI's supported execution path.

## Settings experience

List detected CLIs automatically, with name, status, installation path, version when available, and last check time. Make installed-but-not-logged-in tools easy to identify.

Offer refresh, native sign-in, connection enable or disable, and an optional manual executable path. Advanced adapter settings stay secondary. A user should not need to register a standard installed CLI manually.

Update discovery after relevant settings changes and connection failures. Avoid continuous expensive probing or creating sessions just to check installation.

## Native skills

Support skills already available to Claude and Codex through their native loading and invocation mechanisms. Preserve the relevant project folder, instructions, configuration, and supported skill locations when starting sessions.

Distinguish user-level skills from project-level skills. Project-specific skills apply only where their native scope permits. Isolated workspaces should retain the applicable skill context without indiscriminately copying private configuration or credentials.

When supported, let users explicitly invoke a native skill through its owning CLI's command syntax or an optional composer picker. The router can use discovered skill descriptions as a routing signal when relevant.

Discovery does not authorize execution. A skill's actions still follow the user's request, the native CLI's permissions, and any applicable application policy.

## Native plugins

Use existing installed and enabled Claude and Codex plugins through their owning native CLI environment where compatible. Preserve supported plugin configuration and tool connections.

Plugins may supply skills, commands, tools, or service integrations. Some may require native UI, additional authentication, account permissions, or capabilities unavailable through a desktop wrapper. Show such requirements clearly rather than claiming universal compatibility.

Do not automatically install, activate, or grant permissions to new plugins during scanning. If an existing plugin requires setup, expose the supported native management or setup flow when needed.

## Compatibility and routing

Native extensions belong to a provider environment. A Claude skill or plugin is not automatically a Codex extension, and vice versa.

The router should prefer the owning CLI when a request depends on a specific extension. Explicit invocation can constrain routing for that step. Other steps can still use different CLIs when appropriate.

At handoff, transfer relevant outputs and context rather than assuming the receiving CLI has the same extension, permissions, or connected services. Preserve session continuity when an extension depends on native session state.

If allowance is low on the only CLI that supports a required extension, explain the constraint. Switching providers must not silently discard a capability needed to fulfill the task.

## Extension states

| State | Meaning |
| --- | --- |
| Available | Discovered and usable in the applicable native session. |
| Needs setup | Configuration, login, or permissions are missing. |
| Disabled | Native configuration or an application routing preference excludes it. |
| Unsupported | A known required capability is unavailable through the adapter. |
| Compatibility unknown | Discovery succeeded, but support has not been established. |

Do not claim that Harbor changed a native plugin's enabled state when it only excluded that extension from routing. Native state and application preferences should be distinguishable.

## Design acceptance criteria

- A user with a ready supported CLI can open a project and start without a connection wizard.
- Settings automatically list installed CLIs and clearly identify those needing login.
- Unknown authentication states are not mislabeled as logged out.
- Native authentication is reused without exposing secrets.
- Existing compatible Claude and Codex skills and plugins are available through their native sessions.
- Project scope and native extension configuration survive supported workspace isolation.
- Explicit extension requests reach a CLI that can fulfill them, or produce a clear explanation.
- Unsupported or unknown extension capabilities remain visible and accurately described.
- Configuration is optional for ordinary work and available for advanced control.

## Open design questions

- Which adapters can reliably report sign-in status without launching interactive sessions?
- Which native extensions are discoverable versus usable only through native delegation?
- Which extension actions should be surfaced in the composer?
- How should isolated workspaces inherit project extension configuration for each CLI?

These are design requirements. Exact discovery mechanisms and extension compatibility must be verified against the supported versions during implementation.
