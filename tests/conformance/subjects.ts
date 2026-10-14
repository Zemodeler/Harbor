import type { CustomCliDescriptor } from '../../src/shared/api';
import { ClaudeAdapter } from '../../src/main/adapters/claude';
import { CodexAdapter } from '../../src/main/adapters/codex';
import { GenericAdapter } from '../../src/main/adapters/generic';
import type { ConformanceSubject } from './harness';

/** The adapters Harbor ships, described for the conformance suite. Event shapes follow the parsers' verified formats (see each adapter's header). */

const j = (o: unknown) => JSON.stringify(o);
const after = (argv: string[], flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

const CLAUDE_GRANTS = ['acceptEdits', 'bypassPermissions', '--allowedTools', '--dangerously-skip-permissions', '--permission-prompt-tool'];

const claudeLines: ConformanceSubject['lines'] = {
  session: (id) => [j({ type: 'system', subtype: 'init', session_id: id, model: 'claude-test', tools: [] })],
  text: (text) => [j({ type: 'assistant', message: { id: `msg_${text.length}`, content: [{ type: 'text', text }], usage: { input_tokens: 3, output_tokens: 5 } } })],
  success: (text) => [j({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: undefined, total_cost_usd: 0.001, usage: { input_tokens: 3, output_tokens: 5 } })],
  failure: (message) => [j({ type: 'result', subtype: 'error_during_execution', is_error: true, result: message })]
};

export const claudeSubject: ConformanceSubject = {
  name: 'Claude Code (claude -p stream-json)',
  make: (launcher, o) => new ClaudeAdapter('claude', { launcher, ...o }),
  lines: claudeLines,
  terminalEvent: true,
  resumes: (argv, id) => after(argv, '--resume') === id,
  editGrants: (argv) => argv.filter((a) => CLAUDE_GRANTS.includes(a))
};

/** Claude with a host permission handler: stdin stays open for control messages and carries the prompt as a JSON user line. */
export const claudeControlledSubject: ConformanceSubject = {
  ...claudeSubject,
  name: 'Claude Code, controlled mode (--input-format stream-json)',
  baseOptions: { onToolPermission: async () => ({ allow: true }) },
  waitStdin: true
};

const CODEX_GRANTS = /^(sandbox_mode=(workspace-write|danger-full-access)|approval_policy=never|--dangerously-bypass-approvals-and-sandbox|--full-auto|sandbox_workspace_write\.)/;

export const codexSubject: ConformanceSubject = {
  name: 'Codex (codex exec --json)',
  make: (launcher, o) => new CodexAdapter('codex', { launcher, ...o }),
  lines: {
    session: (id) => [j({ type: 'thread.started', thread_id: id })],
    text: (text) => [j({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })],
    success: () => [j({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } })],
    failure: (message) => [j({ type: 'turn.failed', error: { message } })]
  },
  terminalEvent: true,
  resumes: (argv, id) => argv[1] === 'resume' && argv[2] === id,
  editGrants: (argv) => argv.filter((a) => CODEX_GRANTS.test(a))
};

const descriptor = (output: NonNullable<CustomCliDescriptor['run']['output']>): CustomCliDescriptor => ({
  id: 'fakecli', name: 'Fake CLI', exe: 'C:\\tools\\fakecli.exe',
  run: {
    args: ['run', '{permissionArgs}', '{resumeArgs}'],
    output,
    resume: { args: ['--resume', '{sessionId}'] },
    permissions: { 'read-only': ['--read-only'], edit: ['--allow-edits'], full: ['--allow-edits', '--yolo'] }
  }
});
const genericGrants = (argv: string[]) => argv.filter((a) => a === '--allow-edits' || a === '--yolo');

export const genericJsonlSubject: ConformanceSubject = {
  name: 'custom CLI, JSONL output (GenericAdapter)',
  make: (launcher, o) => new GenericAdapter(descriptor({ format: 'jsonl', map: { session: '$.session_id', text: '$.text', done: '$.type==result', error: '$.error', usage: { input: '$.usage.in', output: '$.usage.out' } } }), { launcher, env: {}, ...o }),
  lines: {
    session: (id) => [j({ type: 'init', session_id: id })],
    text: (text) => [j({ type: 'message', text })],
    success: () => [j({ type: 'result', usage: { in: 10, out: 2 } })],
    failure: (message) => [j({ type: 'result', error: { message } })]
  },
  terminalEvent: true,
  resumes: (argv, id) => after(argv, '--resume') === id,
  editGrants: genericGrants
};

export const genericTextSubject: ConformanceSubject = {
  name: 'custom CLI, plain text output (GenericAdapter)',
  make: (launcher, o) => new GenericAdapter(descriptor({ format: 'text' }), { launcher, env: {}, ...o }),
  lines: {
    session: () => [],
    // A blank line ends a paragraph, which is when text mode emits it.
    text: (text) => [text, ''],
    success: () => []
  },
  terminalEvent: false,
  editGrants: genericGrants
};

export const SUBJECTS: ConformanceSubject[] = [claudeSubject, claudeControlledSubject, codexSubject, genericJsonlSubject, genericTextSubject];
