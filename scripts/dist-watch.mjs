// Repackage Harbor after source changes: `npm run dist:watch`.
// Waits for edits to settle, and never builds while Harbor.exe is running (the build would fail with EBUSY
// because it replaces dist\win-unpacked). Instead it waits for you to close the app, then builds once.
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const WATCH = ['src', 'build', 'electron-builder.yml', 'package.json'];
const IGNORE = /(^|[\\/])(node_modules|out|dist|\.git)([\\/]|$)/;
const SETTLE_MS = 4000, POLL_MS = 3000;

let timer, building = false, dirty = false, announcedWait = false;
const log = (m) => console.log(`[dist:watch ${new Date().toLocaleTimeString()}] ${m}`);
const harborRunning = () => /Harbor\.exe/i.test(spawnSync('tasklist', ['/FI', 'IMAGENAME eq Harbor.exe', '/NH'], { encoding: 'utf8' }).stdout ?? '');

function schedule(delay = SETTLE_MS) { clearTimeout(timer); timer = setTimeout(tick, delay); }

function tick() {
  if (building || !dirty) return;
  if (harborRunning()) {
    if (!announcedWait) { log('changes pending; close Harbor and I will repackage'); announcedWait = true; }
    return schedule(POLL_MS);
  }
  announcedWait = false; dirty = false; building = true;
  log('packaging…');
  const p = spawn('npm', ['run', 'dist'], { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (d) => { tail = (tail + d).slice(-4000); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  p.on('close', (code) => {
    building = false;
    if (code === 0) log('done: dist\\win-unpacked\\Harbor.exe and the installer are up to date');
    else { log(`failed (exit ${code}); last output:\n${tail}`); }
    if (dirty) schedule();
  });
}

for (const target of WATCH) {
  try {
    watch(join(root, target), { recursive: true }, (_e, file) => {
      if (file && IGNORE.test(file)) return;
      dirty = true; schedule();
    });
  } catch (e) { log(`cannot watch ${target}: ${e.message}`); }
}
log(`watching ${WATCH.join(', ')}. Ctrl+C to stop.`);
