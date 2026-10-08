import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vite = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js');
const builder = resolve(root, 'build/node_modules/electron-builder/cli.js');
if (!existsSync(vite) || !existsSync(builder)) {
  console.error('Install the root app dependencies and build/ packaging dependencies before running dist.');
  process.exit(1);
}
for (const [script, args] of [[vite, ['build']], [builder, ['--win', '--x64', '--config', 'electron-builder.yml', '--publish', 'never']]]) {
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  delete env.CSC_LINK;
  delete env.WIN_CSC_LINK;
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
