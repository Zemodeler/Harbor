// Fake `claude -p --input-format stream-json` that speaks the control protocol on stdin/stdout.
// The scenario is the text of the first user message line. The result text is JSON: { argv, responses, ended }.
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const responses = [];
let scenario, buf = '', waiting;

const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: JSON.stringify({ argv: process.argv.slice(2), responses, ...extra }) });
const ask = (id, tool, input) => out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, display_name: tool, input, tool_use_id: 'tu_' + id, description: 'run it' } });
const nextResponse = () => new Promise((r) => { waiting = r; });

async function run() {
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  switch (scenario) {
    case 'allow':
    case 'deny':
    case 'throw':
      ask('req_1', 'Bash', { command: 'rm -rf build' });
      await nextResponse();
      return result();
    case 'git':
      ask('req_g', 'Bash', { command: 'git -C ../x push origin main' });
      await nextResponse();
      return result();
    case 'unknown':
      out({ type: 'control_request', request_id: 'req_u', request: { subtype: 'mystery' } });
      await nextResponse();
      return result();
    case 'cancel':
      ask('req_c', 'Write', { file_path: 'a.txt' });
      setTimeout(() => out({ type: 'control_cancel_request', request_id: 'req_c' }), 50);
      setTimeout(() => result(), 400);
      return;
    case 'hang':
      ask('req_h', 'Bash', { command: 'sleep 1000' });
      setInterval(() => {}, 1000);
      return;
    case 'noresult':
      ask('req_n', 'Bash', { command: 'ls' });
      await nextResponse();
      process.exit(2);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const j = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (scenario === undefined) {
      if (j.type !== 'user' || j.message?.role !== 'user') { process.stderr.write('first line is not a user message'); process.exit(9); }
      scenario = j.message.content;
      run();
    } else if (j.type === 'control_response') {
      responses.push(j.response);
      const w = waiting; waiting = undefined; w?.();
    }
  }
});
// Exits only when the host ends stdin, which proves the adapter closes it after the result.
process.stdin.on('end', () => process.exit(0));
