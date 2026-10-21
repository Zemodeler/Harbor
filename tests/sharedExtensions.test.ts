import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSharedChoices } from '../src/main/skills/shared';
import { SkillManager } from '../src/main/skills/library';
import { Store } from '../src/main/store';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-ext-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const skill = (root: string, name: string) => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nDo it.\n`);
};
const shared = (project: string, body: unknown) => { mkdirSync(join(project, '.harbor'), { recursive: true }); writeFileSync(join(project, '.harbor', 'extensions.json'), typeof body === 'string' ? body : JSON.stringify(body)); };

describe('.harbor/extensions.json (project-shared skill choices)', () => {
  it('reads only boolean choices and survives a broken file', () => {
    const p = tmp();
    expect(loadSharedChoices(p)).toEqual({});
    shared(p, { skills: { 'library:a': true, 'library:b': false, 'library:c': 'yes', 'x\ny': true } });
    expect(loadSharedChoices(p)).toEqual({ 'library:a': true, 'library:b': false });
    shared(p, '{ not json');
    expect(loadSharedChoices(p)).toEqual({});
  });

  it('sits between the user\'s own project choice and the global default', () => {
    const data = tmp(), project = tmp(), claude = tmp();
    skill(join(data, 'skills'), 'lib');
    skill(join(claude, 'skills'), 'pdf');
    shared(project, { skills: { 'library:lib': false, 'claude:user/pdf': true } });
    const state = new Store();
    const m = new SkillManager({ libraryDir: join(data, 'skills'), homes: { claude }, state });
    const proj = { id: 'p1', path: project };
    const by = () => Object.fromEntries(m.list(proj).map((s) => [s.id, s.enabled]));
    // The shared file switches the library skill off and the Claude skill on for this project only.
    expect(by()).toMatchObject({ 'library:lib': false, 'claude:user/pdf': true });
    expect(Object.fromEntries(m.list({ id: 'p2', path: tmp() }).map((s) => [s.id, s.enabled]))).toMatchObject({ 'library:lib': true, 'claude:user/pdf': false });
    // The user's own choice for the project wins over the file.
    m.setEnabled('library:lib', true, proj);
    expect(by()['library:lib']).toBe(true);
    // Back to inherit: the file applies again.
    m.setEnabled('library:lib', null, proj);
    expect(by()['library:lib']).toBe(false);
  });
});
