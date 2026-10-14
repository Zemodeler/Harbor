import { runHeadless } from './headless';

// Entry for `npm run headless` (tsx). Kept apart from headless.ts so importing that module runs nothing.
const io = { out: (l: string) => process.stdout.write(`${l}\n`), err: (l: string) => process.stderr.write(`${l}\n`) };
process.on('unhandledRejection', (reason) => io.err(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`));
runHeadless(process.argv.slice(2), io).then((r) => {
  if (typeof r === 'number') { process.exitCode = r; return; }
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    io.err('Stopping Harbor (running agents are stopped; their work stays in the worktrees)...');
    void r.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}, (e: unknown) => { io.err(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
