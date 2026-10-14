import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { INVOKE_METHODS, channel } from '../src/shared/ipc';
import { registerIpc, UNTRUSTED_SENDER, type IpcHost, type IpcTarget } from '../src/main/ipc';
import type { HarborService } from '../src/main/service';
import { appDocument, type FrameRef, type InvokeEventRef } from '../src/main/windowSecurity';

const indexFile = join(resolve('C:/Harbor/out'), 'renderer/index.html');
const doc = appDocument(indexFile);
const appUrl = pathToFileURL(indexFile).href;

function setup() {
  const handlers = new Map<string, (event: InvokeEventRef, ...args: unknown[]) => unknown>();
  const host: IpcHost = { handle: (c, l) => { handlers.set(c, l); }, removeHandler: c => { handlers.delete(c); } };
  const service = Object.fromEntries(INVOKE_METHODS.map(m => [m, vi.fn(async () => ({ ok: m }))])) as unknown as HarborService;
  service.onEvent = () => () => undefined;
  const main: { -readonly [K in keyof FrameRef]: FrameRef[K] } = { url: appUrl, parent: null, processId: 3, routingId: 1 };
  const win: IpcTarget = { id: 1, mainFrame: main, isDestroyed: () => false, send: vi.fn() };
  registerIpc(service, host, () => win, doc);
  const event: InvokeEventRef = { sender: win, senderFrame: main };
  const invoke = (m: string, ...args: unknown[]) => handlers.get(channel(m as never))!(event, ...args);
  return { service, invoke, handlers, win, main };
}

const rejected: Array<[string, unknown[]]> = [
  ['send', [42, 'hi']], ['send', ['c1', 7]], ['send', ['c1', 'x'.repeat(200_001)]], ['send', ['c1', 'hi', 'img']], ['send', ['c1', 'hi', [{ name: 'a' }]]],
  ['send', ['c1', 'hi', Array.from({ length: 7 }, () => ({ name: 'a.png', mime: 'image/png', dataBase64: 'AA==' }))]],
  ['answerQuestion', ['', 'yes']], ['answerQuestion', ['r1', { a: 1 }]], ['answerQuestion', ['r1', 'x'.repeat(20_001)]],
  ['setAgentPriority', ['a1', '5']], ['setAgentPriority', ['a1', 1.5]], ['setAgentPriority', ['a1', Number.NaN]], ['setAgentPriority', [{}, 1]],
  ['integrateBranches', ['p1', []]], ['integrateBranches', ['p1', 'a1']], ['integrateBranches', ['p1', ['a1', 3]]], ['integrateBranches', ['p1', ['a1'], 5]], ['integrateBranches', ['p1', ['a1'], 'x\ny']],
  ['addProject', [42]], ['addProject', ['']], ['addProject', ['a\0b']], ['addProject', ['x'.repeat(1025)]],
  ['testCliPath', ['', 'C:\\tools\\x.exe']], ['testCliPath', ['claude', 5]], ['testCliPath', ['claude', ' ']], ['testCliPath', ['claude', 'C:\\a\nb.exe']], ['testCliPath', ['claude', 'x'.repeat(1025)]],
  ['saveCustomCli', [{ id: 'x' }]], ['saveCustomCli', [{ id: 'x' }, {}]], ['saveCustomCli', ['x', { confirmExe: 'C:\\x.exe' }]], ['saveCustomCli', [{ id: 'x' }, { confirmExe: 'C:\\x.exe', replace: 'yes' }]],
  ['saveCustomCli', [{ big: 'x'.repeat(64_001) }, { confirmExe: 'C:\\x.exe' }]], ['dryRunCustomCli', [[], { confirmExe: 'C:\\x.exe' }]], ['dryRunCustomCli', [{ id: 'x' }, { confirmExe: 'a\nb' }]],
  ['removeCustomCli', ['']], ['removeCustomCli', [7]],
  ['listSkills', [5]], ['readSkill', ['']], ['readSkill', ['library:x', 7]], ['setSkillEnabled', ['library:x', 'yes']], ['setSkillEnabled', ['library:x', true, {}]], ['removeSkill', [['library:x']]],
  ['previewSkillImport', [null]], ['previewSkillImport', [{ kind: 'ftp', path: 'x' }]], ['previewSkillImport', [{ kind: 'folder', path: 'a\0b' }]], ['previewSkillImport', [{ kind: 'github', ref: '' }]],
  ['previewSkillImport', [{ kind: 'github', ref: 'o/r' }, { confirmDownload: 5 }]], ['importSkills', ['']], ['importSkills', ['t', { names: 'x' }]], ['browseSkillSource', ['exe']]
];

describe('registerIpc argument validation', () => {
  it.each(rejected)('rejects malformed %s arguments before the service runs', (m, args) => {
    const s = setup();
    expect(() => s.invoke(m, ...args)).toThrow(/Invalid request to/);
    expect(s.service[m as keyof HarborService]).not.toHaveBeenCalled();
  });

  it('accepts well-formed arguments, including optional ones', async () => {
    const s = setup();
    await expect(s.invoke('addProject')).resolves.toBeTruthy();
    await expect(s.invoke('addProject', 'C:/work/app')).resolves.toBeTruthy();
    await expect(s.invoke('send', 'c1', '', [{ name: 'a.png', mime: 'image/png', dataBase64: 'AA==' }])).resolves.toBeTruthy();
    await expect(s.invoke('setAgentPriority', 'a1', -3)).resolves.toBeTruthy();
    await expect(s.invoke('integrateBranches', 'p1', ['a1', 'a2'], 'main')).resolves.toBeTruthy();
    await expect(s.invoke('answerQuestion', 'r1', 'yes')).resolves.toBeTruthy();
    await expect(s.invoke('listSkills')).resolves.toBeTruthy();
    await expect(s.invoke('setSkillEnabled', 'claude:user/pdf', null, 'p1')).resolves.toBeTruthy();
    await expect(s.invoke('previewSkillImport', { kind: 'github', ref: 'owner/repo/skills/x' }, { confirmDownload: 'tok' })).resolves.toBeTruthy();
    await expect(s.invoke('importSkills', 'tok', { names: ['pdf'] })).resolves.toBeTruthy();
    await expect(s.invoke('browseSkillSource', 'zip')).resolves.toBeTruthy();
  });

  it('still checks the sender first', () => {
    const s = setup();
    s.main.url = 'https://evil.example/';
    expect(() => s.invoke('send', 42)).toThrow(UNTRUSTED_SENDER);
  });
});
