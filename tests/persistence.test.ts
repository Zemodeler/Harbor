import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarborService } from '../src/main/service';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('restart persistence', () => {
  it('keeps projects, their images, conversations and messages after the app restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-data-')), proj = mkdtempSync(join(tmpdir(), 'harbor-proj-'));
    try {
      const first = createHarborService({ dataDir: dir, discover: async () => [] });
      const p = (await first.addProject(proj))!;
      await first.setProjectImage(p.id, PNG);
      await first.newConversation(p.id);
      const before = (await first.listConversations(p.id)).map((x) => x.id);
      first.shutdown(); // what before-quit does

      const second = createHarborService({ dataDir: dir, discover: async () => [] });
      const projects = await second.listProjects();
      expect(projects.map((x) => x.id)).toEqual([p.id]);
      expect(projects[0].image).toBe(PNG);
      expect((await second.listConversations(p.id)).map((x) => x.id).sort()).toEqual([...before].sort());
      expect(before.length).toBeGreaterThanOrEqual(2);
      second.shutdown();
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });

  it('validates and clears project images', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'harbor-proj-'));
    try {
      const svc = createHarborService({ discover: async () => [] });
      const p = (await svc.addProject(proj))!;
      await expect(svc.setProjectImage(p.id, 'https://example.com/x.png')).rejects.toThrow();
      expect((await svc.setProjectImage(p.id, PNG)).image).toBe(PNG);
      expect((await svc.setProjectImage(p.id, null)).image).toBeUndefined();
    } finally { rmSync(proj, { recursive: true, force: true }); }
  });
});
