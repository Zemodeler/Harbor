import { runCli } from '../src/main/remote/cli';

// `npm run harbor -- <command>`: the remote API client. Logic lives in src/main/remote/cli.ts (tested there).
const readStdin = (): Promise<string> => new Promise((resolve) => {
  const parts: Buffer[] = [];
  process.stdin.on('data', (c: Buffer) => parts.push(c));
  process.stdin.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
});
runCli(process.argv.slice(2), {
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  stdin: readStdin,
  onStop: (stop) => process.once('SIGINT', stop)
}).then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
