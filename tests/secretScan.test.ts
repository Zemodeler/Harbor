import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeScript } from '../src/main/adapters/fake';
import type { Chunk, RunOptions } from '../src/main/adapters/types';
import type { ResolvedCli } from '../src/main/clis/discovery';
import { evidenceText } from '../src/main/prompts';
import {
  ALLOW_MARKER, SECRET_TOOL, applyAllowlist, describeFindings, findingsFingerprint, globToRegExp, scanDiff, scanLine, scanPath, scanText
} from '../src/main/secretScan';
import { createHarborService } from '../src/main/service';
import type { HarborEvent } from '../src/shared/api';

// Fake secrets are assembled at run time so this file itself does not look like it holds any.
const AWS = ['AKIA', 'Z7Q2', 'XW4N', 'P8LM', 'K3RT'].join('');
const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const PEM = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const PASSWORD = ['s3cr', 'Et-V4lue', '-91x'].join('');

describe('secret scan (pure)', () => {
  it('finds keys, tokens, private keys and secret assignments by type', () => {
    expect(scanLine(`const k = "${AWS}";`)).toEqual(['aws-access-key']);
    expect(scanLine(`token: ${GH}`)).toEqual(['github-token']);
    expect(scanLine(PEM)).toEqual(['private-key']);
    expect(scanLine(`url = "postgres://app:${PASSWORD}@db.local/x"`)).toEqual(['password-in-url']);
    expect(scanLine(`DB_PASSWORD=${PASSWORD}`)).toEqual(['secret-assignment']);
    expect(scanLine(`"apiKey": "${PASSWORD}"`)).toEqual(['secret-assignment']);
    expect(scanLine(['xoxb', '1234567890', 'abcdefghij'].join('-'))).toEqual(['slack-token']);
    expect(scanLine(`sk_live_${'Ab12'.repeat(6)}`)).toEqual(['stripe-key']);
    expect(scanLine(`sk-ant-${'x1Y2'.repeat(8)}`)).toEqual(['anthropic-key']);
  });

  it('ignores placeholders, references to the environment and marked lines', () => {
    for (const line of [
      'password = process.env.DB_PASSWORD', 'token: ${GITHUB_TOKEN}', 'API_KEY=changeme', 'secret: "<your secret>"', 'password: "password"',
      'const token = getToken();', 'apiKey: string;', 'url = "postgres://user:${PASS}@db/x"', 'tokenizer = "wordpiece"',
      `const k = "${AWS}"; // ${ALLOW_MARKER}`
    ]) expect(scanLine(line), line).toEqual([]);
  });

  it('flags .env and credential files by name, but not templates', () => {
    expect(scanPath('.env')).toBe('env-file');
    expect(scanPath('config/.env.production')).toBe('env-file');
    expect(scanPath('.env.example')).toBeUndefined();
    expect(scanPath('keys/id_rsa')).toBe('credential-file');
    expect(scanPath('certs\\server.pem')).toBe('credential-file');
    expect(scanPath('src/environment.ts')).toBeUndefined();
  });

  it('scans the added lines of a diff with new-file line numbers, and added credential files', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts',
      '@@ -3,2 +3,3 @@ x', ' keep', `-const old = "${AWS}";`, '+const ok = 1;', `+const key = "${AWS}";`,
      'diff --git a/.env b/.env', 'new file mode 100644', 'index 0..3', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1,2 @@', '+DEBUG=1', `+DB_PASSWORD=${PASSWORD}`,
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', `-${PEM}`,
      'diff --git a/img.png b/img.png', 'Binary files /dev/null and b/img.png differ'
    ].join('\n');
    const r = scanDiff(diff);
    expect(r.findings).toEqual([
      { type: 'aws-access-key', file: 'src/a.ts', line: 5 },
      { type: 'env-file', file: '.env', line: 0 },
      { type: 'secret-assignment', file: '.env', line: 2 }
    ]);
    expect(r.total).toBe(3);
    expect(scanText('notes.md', `a\n${GH}`)).toEqual([{ type: 'github-token', file: 'notes.md', line: 2 }]);
  });

  it('never puts the value in a description', () => {
    const { findings } = scanDiff(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -0,0 +1 @@', `+k="${AWS}"`].join('\n'));
    const text = describeFindings(findings);
    expect(text).toBe('aws-access-key at x:1');
    expect(text).not.toContain(AWS);
    expect(JSON.stringify(findings)).not.toContain(AWS);
  });

  it('allowlists by path glob or by type@glob; fingerprints are order-independent and tied to the commit', () => {
    const f = [{ type: 'jwt' as const, file: 'docs/auth.md', line: 3 }, { type: 'aws-access-key' as const, file: 'tests/fixtures/keys.ts', line: 1 }, { type: 'aws-access-key' as const, file: 'src/x.ts', line: 9 }];
    const r = applyAllowlist(f, ['tests/fixtures/**', 'jwt@docs/**', '# comment', 'aws-access-key@docs/**']);
    expect(r.kept).toEqual([f[2]]);
    expect(r.allowed).toHaveLength(2);
    expect(globToRegExp('*.snap').test('a/b/c.snap')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/deep/x.ts')).toBe(false);
    expect(findingsFingerprint('c1', f)).toBe(findingsFingerprint('c1', [...f].reverse()));
    expect(findingsFingerprint('c1', f)).not.toBe(findingsFingerprint('c2', f));
  });

  it('shows the scan in the evidence the lead and reviewers read', () => {
    const a = { checks: undefined, result: undefined, secretScan: { commit: 'abcdef1234567', findings: [{ type: 'aws-access-key' as const, file: 'src/x.ts', line: 2 }], total: 1, allowed: 1 } };
    expect(evidenceText(a as never)).toBe('Secret scan Harbor ran on abcdef1234: 1 possible secret (aws-access-key at src/x.ts:2), blocks integration until removed, allowlisted or allowed by the user; 1 allowlisted\n');
  });
});

describe('secret scan gates integration', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'harbor-secret-')); dirs.push(d); return d; };
  afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ } } });
  const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
  const say = (text: string): Chunk[] => [{ kind: 'text', text }];
  const result = (r: object) => `HARBOR_RESULT: ${JSON.stringify(r)}`;

  async function setup(content: string, answer: (allow: boolean) => boolean, settings: Record<string, unknown> = {}) {
    const repo = tmp();
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'index.ts'), 'export {};');
    writeFileSync(join(repo, 'README.md'), 'hi'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    let delegated = false;
    const plan = [
      { ref: 'a', title: 'Write a', role: 'implementer', instructions: 'write config', complexity: 'low', files: ['src/config.ts'] },
      { ref: 'ra', title: 'Review a', role: 'reviewer', instructions: 'review', complexity: 'low', dependsOn: ['a'] },
      { role: 'integrator', ref: 'i', sources: ['a'] }
    ];
    const reviewerPrompts: string[] = [];
    const script: FakeScript = (prompt, o: RunOptions) => {
      const sys = o.systemPrompt ?? '';
      if (sys.includes('front desk')) return say(JSON.stringify({ escalate: { complexity: 'medium', needs: ['code'], ack: '' } }));
      if (sys.includes('LEAD agent')) {
        if (delegated) return say('ok');
        delegated = true;
        return say(['go', ...plan.map((t) => `HARBOR_DELEGATE: ${JSON.stringify(t)}`)].join('\n'));
      }
      if (o.permission === 'edit') {
        writeFileSync(join(o.cwd, 'src', 'config.ts'), content);
        return say(['Done', result({ outcome: 'done', summary: 'Written.', checks: [] })].join('\n'));
      }
      reviewerPrompts.push(prompt);
      return say(['Reviewed.', result({ outcome: 'done', summary: 'Reviewed.', verdict: 'approve', checks: [] })].join('\n'));
    };
    const adapter = new FakeAdapter('claude', script);
    const cli: ResolvedCli = { id: 'claude', name: 'claude', installed: true, signedIn: true, authState: 'signedIn', models: ['default'], path: '/fake/claude' };
    const svc = createHarborService({ discover: async () => [cli], adapterFor: () => adapter, autoApproveChecks: true, worktreesRoot: join(tmp(), 'wt'), maxActivePerProject: 4 });
    const asks: Array<Extract<HarborEvent, { type: 'permission' }>> = [];
    svc.onEvent((e) => { if (e.type === 'permission' && e.tool === SECRET_TOOL) { asks.push(e); void svc.answerPermission(e.requestId, answer(asks.length === 1)); } });
    const project = (await svc.addProject(repo))!;
    if (Object.keys(settings).length) await svc.setSettings({ projectOverrides: { [project.id]: settings } });
    const [conv] = await svc.listConversations(project.id);
    await svc.send(conv!.id, 'do the work');
    await svc.whenIdle();
    const integrator = () => svc.store.listAgentRecords(project.id).find((a) => a.integration)!;
    const find = (title: string) => svc.store.listAgentRecords(project.id).find((a) => a.title === title)!;
    const everything = () => JSON.stringify({ messages: svc.store.listConversations(project.id).flatMap((c) => svc.store.listMessages(c.id)), journal: svc.orchestrator.journal.list(project.id), agents: svc.store.listAgentRecords(project.id) });
    return { svc, repo, project, asks, integrator, find, everything, reviewerPrompts };
  }

  it('blocks on a hit until the user says yes, shows only type, file and line, and remembers the yes for that exact head', async () => {
    const t = await setup(`export const key = "${AWS}";\n`, (first) => !first);
    // First answer: no. The integration is refused and nothing reached main.
    const i = t.integrator();
    expect(t.asks).toHaveLength(1);
    expect(t.asks[0]!.prompt).toContain('1 possible secret: aws-access-key at src/config.ts:1');
    expect(i.state).toBe('failed');
    expect(i.error).toMatch(/^Secret scan: Secret scan found 1 possible secret: aws-access-key at src\/config.ts:1/);
    await expect(t.svc.applyIntegration(i.id)).rejects.toThrow();
    // The helper's own scan is evidence for the lead and the reviewer.
    expect(t.find('Write a').report).toContain('WARNING: Secret scan (Harbor)');
    expect(t.reviewerPrompts.join('\n')).toContain('Secret scan Harbor ran on');
    // Run again: this time the user allows exactly these findings.
    const ic = await t.svc.openAgentConversation(i.id);
    await t.svc.send(ic.id, 'run again');
    await t.svc.whenIdle();
    expect(t.asks).toHaveLength(2);
    expect(t.integrator().state).toBe('done');
    expect(t.integrator().report).toContain('You allowed integrating these');
    // Applying the same head does not ask again.
    await t.svc.applyIntegration(i.id);
    expect(t.asks).toHaveLength(2);
    expect(git(t.repo, 'show', 'main:src/config.ts')).toContain('export const key');
    // Never the value: not in messages, the journal, reports or agent records.
    expect(t.everything()).not.toContain(AWS);
    expect(t.svc.orchestrator.journal.list(t.project.id).some((e) => e.kind === 'secret-scan')).toBe(true);
  });

  it('does not ask when the project allowlist covers the finding, or when nothing is found', async () => {
    const allowed = await setup(`export const key = "${AWS}";\n`, () => false, { secretAllowlist: ['src/config.ts'] });
    expect(allowed.asks).toHaveLength(0);
    expect(allowed.integrator().state).toBe('done');
    expect(allowed.integrator().report).toContain('nothing found (1 allowlisted)');
    const clean = await setup('export const answer = 42;\n', () => false);
    expect(clean.asks).toHaveLength(0);
    expect(clean.integrator().state).toBe('done');
  });
});
