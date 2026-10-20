import type { ProjectTemplate } from '../shared/api';

/** Small static starting points for a new project: plain strings, no dependencies. `empty` is the safe default. */
export const TEMPLATES: ProjectTemplate[] = ['empty', 'node-ts', 'python', 'static-web'];

const GITIGNORE_BASE = '.env\n.env.*\n!.env.example\n*.pem\n*.key\n.DS_Store\nThumbs.db\n';

/** Short conventions file so Claude, Codex and the other CLIs have something to read from the first turn. */
const agents = (name: string, how: string): string => `# AGENTS.md

${name} was started with Harbor. Conventions for any agent working here:

${how}
- Keep changes small and focused; explain why in comments, not what.
- Never commit secrets, tokens or \`.env\` files.
- Do not push; Harbor publishes branches for the owner.
`;

/** Folder-name-safe, lower-case package name. */
export const packageSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

/** Files (relative path to content) of a template. Paths use forward slashes. */
export function templateFiles(template: ProjectTemplate, name: string): Record<string, string> {
  const slug = packageSlug(name);
  switch (template) {
    case 'node-ts':
      return {
        'package.json': JSON.stringify({ name: slug, version: '0.1.0', private: true, type: 'module', scripts: { build: 'tsc', start: 'node dist/index.js', typecheck: 'tsc --noEmit' }, devDependencies: { typescript: '^5.6.0', '@types/node': '^22.0.0' } }, null, 2) + '\n',
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist', rootDir: 'src', skipLibCheck: true }, include: ['src'] }, null, 2) + '\n',
        'src/index.ts': `console.log('Hello from ${name.replace(/[\\'\r\n]/g, ' ')}');\n`,
        '.gitignore': `node_modules/\ndist/\n${GITIGNORE_BASE}`,
        'README.md': `# ${name}\n\nTypeScript starter. Run \`npm install\`, then \`npm run build\` and \`npm start\`.\n`,
        'AGENTS.md': agents(name, '- Node + TypeScript (strict). Check with `npm run typecheck` and `npm run build`.')
      };
    case 'python':
      return {
        'pyproject.toml': `[project]\nname = "${slug}"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n`,
        'main.py': `def main() -> None:\n    print("Hello from ${name.replace(/["\\\r\n]/g, ' ')}")\n\n\nif __name__ == "__main__":\n    main()\n`,
        '.gitignore': `__pycache__/\n*.pyc\n.venv/\n${GITIGNORE_BASE}`,
        'README.md': `# ${name}\n\nPython starter. Run \`python main.py\`.\n`,
        'AGENTS.md': agents(name, '- Python 3.10+. Run with `python main.py`; keep a virtual environment in `.venv/` (ignored).')
      };
    case 'static-web':
      return {
        'index.html': `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${name.replace(/[<>&"]/g, ' ')}</title>\n</head>\n<body>\n  <h1>${name.replace(/[<>&"]/g, ' ')}</h1>\n</body>\n</html>\n`,
        '.gitignore': GITIGNORE_BASE,
        'README.md': `# ${name}\n\nStatic web page. Open \`index.html\` in a browser.\n`,
        'AGENTS.md': agents(name, '- Plain HTML, CSS and JavaScript, no build step. Open `index.html` to check.')
      };
    default:
      return {
        'README.md': `# ${name}\n\nStarted with Harbor.\n`,
        '.gitignore': GITIGNORE_BASE,
        'AGENTS.md': agents(name, '- Read the README first; ask the owner before adding tools or dependencies.')
      };
  }
}
