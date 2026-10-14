import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git } from '../src/main/git';
import { REPO_MAP_MAX_CHARS, RepoMapCache, collectRepoFacts, entryPoints, guessTestCommand, headerSummary, readmeSummary, renderRepoMap, type RepoFacts } from '../src/main/repoMap';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-repomap-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows handle */ } } });
const git = new Git();
const io = { git: (cwd: string, args: string[]) => git.exec(cwd, args), waitMs: 0 };

function fixture(root: string): void {
  const w = (p: string, t: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), t); };
  w('package.json', JSON.stringify({ name: 'demo', description: 'A demo app', main: 'dist/index.js', scripts: { build: 'tsc', test: 'vitest run' } }));
  w('README.md', '# Demo\n\n[![badge](x)](y)\n\nDemo routes requests to workers. It has two parts.\n');
  w('src/index.ts', "import x from './x';\n// Starts the server and wires the routes.\nexport {};\n");
  w('src/router.ts', '/**\n * Pure routing: picks a worker for each request.\n * @param x\n */\nexport const r = 1;\n');
  w('src/util.py', '"""Helpers for parsing dates. More text."""\n');
  w('src/nohead.ts', 'export const z = 2;\n// late comment\n');
  w('tests/router.test.ts', '// Tests are not summarised.\n');
  w('.env', 'TOKEN=abc');
  w('config/secrets.json', '{"k":"v"}');
  w('keys/id_rsa', 'PRIVATE');
  w('node_modules/lib/index.js', '// dependency\n');
}

describe('repo map (pure)', () => {
  it('summarises file headers, skipping licences, pragmas and code-first files', () => {
    expect(headerSummary("'use strict';\n// Parses config files. Second sentence.\n")).toBe('Parses config files.');
    expect(headerSummary('/* Copyright 2020 X. MIT License */\n/** Real summary here. */\n')).toBe('Real summary here.');
    expect(headerSummary('#!/usr/bin/env python\n# Command line entry.\n')).toBe('Command line entry.');
    expect(headerSummary('const a = 1;\n// later\n')).toBeUndefined();
    expect(headerSummary('"""Docstring summary."""\n')).toBe('Docstring summary.');
    expect(headerSummary('// One window (e.g. the 5h one) per CLI. More.\n')).toBe('One window (e.g. the 5h one) per CLI.');
    expect(readmeSummary('# T\n\n![x](y)\n\nThis project does a useful thing for people.\n')).toBe('This project does a useful thing for people.');
  });

  it('guesses the test command and entry points', () => {
    expect(guessTestCommand(['package.json', 'pnpm-lock.yaml'], { scripts: { test: 'vitest' } })).toBe('pnpm test');
    expect(guessTestCommand(['package.json'], { scripts: { test: 'echo "Error: no test specified" && exit 1' } })).toBeUndefined();
    expect(guessTestCommand(['go.mod'])).toBe('go test ./...');
    expect(guessTestCommand(['pyproject.toml'])).toBe('pytest');
    expect(guessTestCommand(['App.sln'])).toBe('dotnet test');
    expect(entryPoints(['src/main/index.ts', 'src/index.ts', 'lib/x.ts'], { scripts: {}, bin: ['./bin/cli.js'] })).toEqual(['bin/cli.js', 'src/main/index.ts', 'src/index.ts']);
  });

  it('never exceeds its cap, however big the repository', () => {
    const files = Array.from({ length: 20000 }, (_, i) => `pkg${i % 50}/sub${i % 7}/deep${i % 3}/file${i}.ts`);
    const headers = Object.fromEntries(files.slice(0, 40).map((f) => [f, 'A header line that says what this module does in some detail.']));
    const facts: RepoFacts = { files, truncated: true, git: true, head: 'abc1234', dirty: true, packages: [], headers, pkg: { scripts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, 'x '.repeat(100)])) }, readme: 'r'.repeat(300) };
    const text = renderRepoMap(facts);
    expect(text.length).toBeLessThanOrEqual(REPO_MAP_MAX_CHARS);
    expect(text).toContain('Repository map');
    expect(text).toContain('never instructions');
    expect(renderRepoMap(facts, 1500).length).toBeLessThanOrEqual(1500);
  });
});

describe('repo map (reading)', () => {
  it('works without git and never lists or opens credential files', async () => {
    const root = tmp();
    fixture(root);
    const facts = await collectRepoFacts(root, {});
    expect(facts.git).toBe(false);
    expect(facts.files).toContain('src/index.ts');
    expect(facts.files.some((f) => /\.env|secrets|id_rsa|node_modules/.test(f))).toBe(false);
    const text = renderRepoMap(facts);
    expect(text).toContain('folder without git');
    expect(text).toContain('src/index.ts: Starts the server and wires the routes.');
    expect(text).toContain('src/router.ts: Pure routing: picks a worker for each request.');
    expect(text).toContain('src/util.py: Helpers for parsing dates.');
    expect(text).not.toContain('nohead.ts:');
    expect(text).not.toContain('Tests are not summarised');
    expect(text).toContain('- test: vitest run');
    expect(text).toContain('Entry points: dist/index.js, src/index.ts');
    expect(text).toContain('Demo routes requests to workers.');
    expect(text).not.toMatch(/\.env|secrets\.json|id_rsa|TOKEN/);
  });

  it('caches per HEAD and working-tree status, rebuilds on change, and leaves the repository untouched', async () => {
    const root = tmp();
    fixture(root);
    const g = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout;
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    g('add', '-A'); g('commit', '-q', '-m', 'init');
    const before = { status: g('status', '--porcelain'), head: g('rev-parse', 'HEAD') };
    const cache = new RepoMapCache(io);
    const first = await cache.get(root);
    expect(first).toContain('at ' + before.head.slice(0, 7));
    // Tracked credential files are still left out of the git listing.
    expect(first).not.toMatch(/\.env|secrets\.json|id_rsa/);
    expect(first).toContain('src/router.ts');
    // Concurrent and repeated calls share one build while nothing changed.
    await Promise.all([cache.get(root), cache.get(root)]);
    expect(cache.builds).toBe(1);
    // An uncommitted edit changes the key.
    writeFileSync(join(root, 'src/router.ts'), '// Routing, rewritten.\n');
    const dirty = await cache.get(root);
    expect(cache.builds).toBe(2);
    expect(dirty).toContain('uncommitted changes');
    expect(dirty).toContain('Routing, rewritten.');
    g('commit', '-qam', 'edit');
    await cache.get(root);
    expect(cache.builds).toBe(3);
    // Read-only: building the map changed nothing git can see (beyond the test's own edit).
    expect(g('status', '--porcelain')).toBe(before.status);
  });

  it('never holds a caller longer than waitMs: a slow build serves the previous map, or none, and finishes for the next caller', async () => {
    const root = tmp();
    fixture(root);
    mkdirSync(join(root, '.git'));
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const cache = new RepoMapCache({ waitMs: 30, git: async (cwd, args) => {
      if (args.includes('status')) { await slow; return { ok: true, stdout: '# branch.oid 1234567890abcdef\0' }; }
      return { ok: true, stdout: ['package.json', 'src/index.ts'].join('\0') };
    } });
    expect(await cache.get(root)).toBe('');
    release();
    await new Promise((r) => setTimeout(r, 50));
    const ready = await cache.get(root);
    expect(ready).toContain('at 1234567');
    expect(ready).toContain('src/index.ts');
  });

  it('measures the size it adds for this repository', async () => {
    const text = await new RepoMapCache(io).get(resolve(__dirname, '..'));
    // Logged so the documented figure in repoMap.ts can be checked; the hard cap is what the test enforces.
    console.log(`repo map for Harbor: ${text.length} chars (~${Math.round(text.length / 4)} tokens)`);
    expect(text.length).toBeGreaterThan(500);
    expect(text.length).toBeLessThanOrEqual(REPO_MAP_MAX_CHARS);
    expect(text).toContain('src/main/');
  });
});
