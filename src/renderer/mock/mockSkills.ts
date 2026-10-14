import type { HarborApi, Skill, SkillDetail, SkillFile, SkillImportCandidate, SkillImportPreview } from '../../shared/api';

type SkillMethods = Required<Pick<HarborApi, 'listSkills' | 'readSkill' | 'setSkillEnabled' | 'previewSkillImport' | 'importSkills' | 'removeSkill' | 'browseSkillSource'>>;
interface DemoSkill { skill: Skill; text: string; fileList: SkillFile[]; projectId?: string }

const DEFAULT_ON = { library: true, project: true, claude: false, codex: false } as const;
const md = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

function demo(id: string, source: Skill['source'], name: string, description: string, path: string, fileList: SkillFile[], extra: Partial<Skill> = {}, projectId?: string): DemoSkill {
  return {
    skill: { id, name, description, source, path, readOnly: source !== 'library', enabled: DEFAULT_ON[source], defaultEnabled: DEFAULT_ON[source], files: fileList.length, bytes: fileList.reduce((n, f) => n + f.bytes, 0), hasScripts: fileList.some(f => f.script), ...extra },
    text: md(name, description, `# ${name}\n\nSample instructions. Demo only: no skill is read from disk.`), fileList, projectId
  };
}

/** Demo skills: the same rules as Harbor for what the UI shows (sources, defaults, per-project choices, two-step GitHub import). Nothing touches the disk or the network. */
export function createMockSkills(pause: () => Promise<void>): SkillMethods {
  const copy = <T,>(v: T): T => structuredClone(v);
  let skills: DemoSkill[] = [
    demo('library:pdf-tools', 'library', 'pdf-tools', 'Extract text and tables from PDF files and summarise them.', 'C:\\Users\\you\\AppData\\Roaming\\Harbor\\skills\\pdf-tools',
      [{ path: 'SKILL.md', bytes: 1840 }, { path: 'scripts/extract.py', bytes: 920, script: true }], { hash: '3f9a1c0d2b7e4a65f1e0c9b8a7d6e5f4c3b2a1908f7e6d5c4b3a291807f6e5d4', importedFrom: 'github.com/example/skills@1a2b3c4d5e6f/pdf-tools', importedAt: Date.now() - 86400000 }),
    demo('project:release-notes', 'project', 'release-notes', 'Write release notes from the commits since the last tag, in the project\'s house style.', 'C:\\Projects\\Storefront\\.harbor\\skills\\release-notes', [{ path: 'SKILL.md', bytes: 1210 }], {}, 'store'),
    demo('claude:user/frontend-design', 'claude', 'frontend-design', 'Distinctive, intentional visual design for new UI.', 'C:\\Users\\you\\.claude\\skills\\frontend-design', [{ path: 'SKILL.md', bytes: 5300 }]),
    demo('codex:user/design-taste', 'codex', 'design-taste', 'Anti-template frontend direction for landing pages and portfolios.', 'C:\\Users\\you\\.codex\\skills\\design-taste', [{ path: 'SKILL.md', bytes: 7400 }])
  ];
  const global = new Map<string, boolean>();
  const projects = new Map<string, Map<string, boolean>>();
  const stages = new Map<string, { source: string; skills: SkillImportCandidate[]; github?: string; downloaded?: boolean }>();

  const visible = (projectId?: string) => skills.filter(s => s.skill.source !== 'project' && !(s.skill.source === 'claude' && s.skill.id.startsWith('claude:project/')) || (projectId && s.projectId === projectId));
  const resolve = (s: DemoSkill, projectId?: string): Skill => {
    const def = global.get(s.skill.id) ?? DEFAULT_ON[s.skill.source];
    const chosen = projectId ? projects.get(projectId)?.get(s.skill.id) ?? def : def;
    return { ...copy(s.skill), defaultEnabled: def, enabled: chosen && !s.skill.problems?.length };
  };
  const list = (projectId?: string) => visible(projectId).map(s => resolve(s, projectId));
  const find = (id: string, projectId?: string) => {
    const s = visible(projectId).find(x => x.skill.id === id);
    if (!s) throw new Error('That skill is no longer available.');
    return s;
  };
  const folderName = (name: string, taken: Set<string>) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
    let n = base;
    for (let i = 2; taken.has(n); i++) n = `${base}-${i}`;
    taken.add(n);
    return n;
  };
  const libraryNames = () => new Set(skills.filter(s => s.skill.source === 'library').map(s => s.skill.id.slice('library:'.length)));
  const candidate = (name: string, taken: Set<string>, full: boolean): SkillImportCandidate => {
    const files: SkillFile[] = [{ path: 'SKILL.md', bytes: 1600 }, { path: 'scripts/run.ps1', bytes: 410, script: true }];
    return { name, description: full ? `Sample skill "${name}" (demo only).` : '', dir: '', targetName: folderName(name, taken), files, bytes: 2010, hasScripts: true, ...(full ? { text: md(name, `Sample skill "${name}" (demo only).`, 'Run scripts/run.ps1 to set things up.'), hash: '9c1e7b0a5d3f2e6b8a4c0d9e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c' } : {}) };
  };
  const scripts = (c: SkillImportCandidate[]) => c.filter(x => x.hasScripts).map(x => `${x.name} contains scripts or programs (${x.files.filter(f => f.script).map(f => f.path).join(', ')}). Harbor never runs them; an agent could run them only through its normal tool permissions.`);
  const stage = (source: string, c: SkillImportCandidate[], extra: { github?: string; downloaded?: boolean } = {}): SkillImportPreview => {
    const token = crypto.randomUUID();
    stages.set(token, { source, skills: c, ...extra });
    return { token, source, ...(extra.github && !extra.downloaded ? { needsDownload: true } : {}), fileCount: c.reduce((n, x) => n + x.files.length, 0), totalBytes: c.reduce((n, x) => n + x.bytes, 0), skills: copy(c), ...(extra.github && !extra.downloaded ? {} : { warnings: scripts(c) }) };
  };

  return {
    async listSkills(projectId) { await pause(); return list(projectId); },
    async readSkill(id, projectId): Promise<SkillDetail> {
      const s = find(id, projectId);
      return { ...resolve(s, projectId), text: s.text, fileList: copy(s.fileList), ...(s.skill.hash ? { currentHash: s.skill.hash, modified: false } : {}) };
    },
    async setSkillEnabled(id, enabled, projectId) {
      find(id, projectId);
      const map = projectId ? (projects.get(projectId) ?? projects.set(projectId, new Map()).get(projectId)!) : global;
      if (enabled === null) map.delete(id); else map.set(id, enabled);
      return list(projectId);
    },
    async previewSkillImport(source, opts) {
      await pause();
      if (source.kind === 'github') {
        const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/(?:tree\/[^/]+\/)?(.+))?$/.exec(source.ref.trim());
        if (!m) throw new Error('Enter a GitHub address such as owner/repo or https://github.com/owner/repo/tree/main/skills/name.');
        const label = `github.com/${m[1]}/${m[2]}@0123456789ab${m[3] ? `/${m[3]}` : ''}`;
        const name = (m[3] ?? m[2]).split('/').pop()!;
        if (!opts?.confirmDownload) return stage(label, [candidate(name, libraryNames(), false)], { github: source.ref.trim() });
        const st = stages.get(opts.confirmDownload);
        if (!st?.github || st.downloaded) throw new Error('That GitHub listing has expired. Check the address again first.');
        if (st.github !== source.ref.trim()) throw new Error('The address changed since it was checked. Check it again first.');
        stages.delete(opts.confirmDownload);
        return stage(label, [candidate(name, libraryNames(), true)], { github: st.github, downloaded: true });
      }
      const path = source.path.trim();
      if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) throw new Error(`Choose the ${source.kind === 'zip' ? '.zip file' : 'folder'} by its full path.`);
      if (/link/i.test(path)) return { source: path, fileCount: 0, totalBytes: 0, skills: [], problems: [source.kind === 'zip' ? 'The archive contains a symbolic link (skill/link); links are not imported.' : 'That folder is a link; choose the folder it points to.'] };
      const name = path.split(/[\\/]/).filter(Boolean).pop()!.replace(/\.zip$/i, '');
      return stage(path, [candidate(name, libraryNames(), true)]);
    },
    async importSkills(token, opts) {
      const st = stages.get(token);
      if (!st) throw new Error('That import preview has expired. Check the source again.');
      if (st.github && !st.downloaded) throw new Error('Download the files first: only names and sizes are known.');
      stages.delete(token);
      const taken = libraryNames();
      const chosen = st.skills.filter(c => !c.problems?.length && (!opts?.names || opts.names.includes(c.name)));
      const added = chosen.map(c => {
        const folder = folderName(c.name, taken);
        const s = demo(`library:${folder}`, 'library', c.name, c.description, `C:\\Users\\you\\AppData\\Roaming\\Harbor\\skills\\${folder}`, c.files, { hash: c.hash, importedFrom: st.source, importedAt: Date.now() });
        s.text = c.text ?? s.text;
        return s;
      });
      skills = [...skills, ...added];
      return added.map(s => resolve(s));
    },
    async removeSkill(id) {
      const s = skills.find(x => x.skill.id === id);
      if (!s || s.skill.source !== 'library') throw new Error('Only skills in Harbor\'s library can be removed; other sources belong to the project or another tool.');
      skills = skills.filter(x => x !== s);
      return list();
    },
    async browseSkillSource(kind) { await pause(); return kind === 'zip' ? 'C:\\Downloads\\sample-skill.zip' : 'C:\\Downloads\\sample-skill'; }
  };
}
