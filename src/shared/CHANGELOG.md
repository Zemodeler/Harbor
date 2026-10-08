# Contract changelog (src/shared/api.ts)

Only optional fields and new methods may be added after the initial contract. Newest first.

- 0.1.1 — `CliStatus.authState?` (optional): `signedIn`, `signedOut`, or `unknown`. `signedIn` stays false when unknown, so show "status unknown" (not "login required") when authState is `unknown` and installed.
- 0.1.0 — initial contract, identical to the spec.
