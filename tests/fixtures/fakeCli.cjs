// A stand-in for any third-party CLI, driven by the generic adapter in tests. `--mode <name>` picks the behaviour; every other
// argument is ignored except where a mode reports it. The prompt arrives on stdin (or as the file after `--prompt-file`).
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mode = opt('--mode') || 'text';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', run);

function run() {
  switch (mode) {
    case 'version': return console.log('fakecli 1.2.3');
    case 'status-out': console.log('Error: not logged in'); return process.exit(1);
    case 'text': return process.stdout.write(`para one\nline two\n\npara two: ${input.length}\n`);
    case 'echo': return out({ argv: args, input, env: Object.keys(process.env), ...(opt('--mcp-config') ? { mcp: JSON.parse(readFileSync(opt('--mcp-config'), 'utf8')) } : {}) });
    case 'file': return out({ file: readFileSync(opt('--prompt-file'), 'utf8'), path: opt('--prompt-file'), stdin: input });
    case 'answer': return out({ answer: 'Hi from fakecli' });
    case 'jsonl':
      out({ type: 'init', session_id: 'sess-42' });
      process.stdout.write('not json at all\n');
      out({ type: 'message', text: 'Hello' });
      out({ type: 'message', text: 'OK' });
      return out({ type: 'result', usage: { in: 120, out: 7 } });
    case 'jsonl-error':
      out({ type: 'init', session_id: 'sess-43' });
      return out({ type: 'result', error: { message: 'usage limit reached' } });
    case 'jsonl-cut': out({ type: 'message', text: 'partial' }); return;
    case 'noisy':
      for (let i = 0; i < 200; i++) process.stderr.write(`warning ${i}: something noisy\n`);
      return console.log('OK');
    case 'fail': process.stderr.write('boom: rate limit reached\n'); return process.exit(1);
    case 'slow': return setTimeout(() => console.log('late OK'), 800);
    case 'forever': {
      // A child that would outlive a plain kill: the tree kill must end both.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(`pids ${process.pid} ${child.pid}`);
      return setInterval(() => {}, 1000);
    }
    default: process.stderr.write(`unknown mode ${mode}\n`); return process.exit(2);
  }
}
