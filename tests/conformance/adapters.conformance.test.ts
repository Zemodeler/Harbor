/**
 * Adapter conformance suite: every CliAdapter Harbor ships must pass it. No real CLI and no real process is started.
 *
 * What it checks (harness.ts `conformance`): exactly one `done` chunk, always last; the prompt and role text on stdin, never in
 * argv; a read-only run never gets edit or approval grants; the reported session id resumes that session; garbage, malformed and
 * event-shaped stderr lines never throw or leak into output; exit 0 without the CLI's terminal event; non-zero exits with the
 * stderr tail; rate limits from stderr and from failure events; abort (before and during a run, and a process that ignores the
 * kill); a consumer that stops iterating early; spawn failures; a 3 MB line; a newline-free flood; lines split mid UTF-8 character
 * with CRLF endings; duplicate terminal events. Every chunk is also checked against the field types in adapters/types.ts.
 *
 * AUTHORING GUIDE: plugging a new adapter in
 * 1. Spawn only through `streamLines` (adapters/stream.ts) and pass it `launcher` and `forceResolveMs` from an
 *    `AdapterProcessOptions` constructor argument (call `onLine` for every raw line too). Production code passes nothing and gets
 *    `realLauncher` (proc.ts: .cmd shims, PID tracking, tree kill). Never call child_process yourself: the suite cannot see it.
 * 2. Keep parsing in a pure `parse<Cli>Line(line): Chunk[]` that never throws: guard non-object JSON (`null`, numbers, arrays)
 *    and type-check every field you copy into a chunk (ids are non-empty strings, counts finite numbers).
 * 3. In `run`: hold the line generator in a variable and `await gen.return()` in `finally` (an early `break` by the consumer
 *    must kill the process); yield nothing after the first `done`; when the stream ends without one, yield a failed `done` with
 *    `exitCode` (null when aborted or never spawned) and the stderr tail as the error; catch setup errors (temp files) into a done.
 * 4. Describe the CLI in subjects.ts as a `ConformanceSubject`: how it prints a session id, text, success and failure, whether it
 *    has a terminal event, how argv resumes a session, and which arguments grant edits. Add it to `SUBJECTS`. Event shapes must
 *    be the CLI's real ones: check them against `<cli> --help` and a real run, and say in the adapter header what was verified.
 * 5. Record a real transcript (`npm run smoke -- <cli> --record`, see transcripts.ts for the format), review it for anything
 *    private, and add it under tests/fixtures/transcripts/ with an `expect` block; transcripts.test.ts replays every file there.
 * A failure here is a bug in the adapter, not in the suite: fix the adapter (or explain in the subject why a check cannot apply).
 */
import { conformance } from './harness';
import { SUBJECTS } from './subjects';

for (const s of SUBJECTS) conformance(s);
