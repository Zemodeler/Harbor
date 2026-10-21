const MAX_TEXT = 200_000;
const MAX_ANSWER = 20_000;
const MAX_PATH = 1024;
const MAX_DESCRIPTOR = 64_000;
const CONTROL = /[\0\r\n]/;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 200 && !CONTROL.test(v);
const isSkillId = (v: unknown): v is string => typeof v === 'string' && v.length >= 3 && v.length <= 400 && !CONTROL.test(v);

/**
 * Shape check for the methods whose arguments reach disk, git or a CLI prompt. It runs after the sender check and
 * throws a readable message; the service still validates meaning (does the id exist, is the file an image).
 */
export function validateInvoke(method: string, args: unknown[]): void {
  const bad = (what: string): never => { throw new Error(`Invalid request to ${method}: ${what}.`); };
  switch (method) {
    case 'send': {
      const [id, text, attachments, opts] = args;
      if (!isId(id)) bad('conversation id must be a short non-empty string');
      if (typeof text !== 'string' || text.length > MAX_TEXT) bad(`text must be a string of at most ${MAX_TEXT} characters`);
      if (attachments !== undefined && attachments !== null) {
        // The service enforces the finer rule (6 images, 10 files in total); this only keeps absurd lists out.
        if (!Array.isArray(attachments) || attachments.length > 10) bad('attachments must be a list of at most 6 images or 10 files');
        for (const a of attachments as unknown[]) {
          const o = a as { name?: unknown; mime?: unknown; dataBase64?: unknown } | null;
          if (!o || typeof o !== 'object' || typeof o.name !== 'string' || o.name.length > 260 || typeof o.mime !== 'string' || o.mime.length > 100 || typeof o.dataBase64 !== 'string') bad('each attachment needs a name, mime type and base64 data');
        }
      }
      if (opts !== undefined && opts !== null && (typeof opts !== 'object' || Array.isArray(opts) || ((opts as { steer?: unknown }).steer !== undefined && typeof (opts as { steer?: unknown }).steer !== 'boolean'))) bad('options must be an object with an optional boolean steer');
      break;
    }
    case 'answerQuestion':
      if (!isId(args[0])) bad('request id must be a short non-empty string');
      if (typeof args[1] !== 'string' || args[1].length > MAX_ANSWER) bad(`answer must be a string of at most ${MAX_ANSWER} characters`);
      break;
    case 'setConversationDeadline':
      if (!isId(args[0])) bad('conversation id must be a short non-empty string');
      if (args[1] !== null && (typeof args[1] !== 'number' || !Number.isFinite(args[1]) || args[1] <= 0)) bad('deadline must be an epoch time in milliseconds, or null to clear it');
      break;
    case 'setAgentPriority':
      if (!isId(args[0])) bad('agent id must be a short non-empty string');
      if (typeof args[1] !== 'number' || !Number.isInteger(args[1]) || Math.abs(args[1]) > 1_000_000) bad('priority must be a whole number');
      break;
    case 'mergeSession':
      if (!isId(args[0])) bad('conversation id must be a short non-empty string');
      break;
    case 'integrateBranches':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (!Array.isArray(args[1]) || args[1].length < 1 || args[1].length > 50 || !args[1].every(isId)) bad('agentIds must be a list of 1 to 50 agent ids');
      if (args[2] !== undefined && args[2] !== null && (typeof args[2] !== 'string' || !args[2].trim() || args[2].length > 250 || CONTROL.test(args[2]))) bad('target must be a branch name');
      break;
    case 'openWorkspace': {
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (args[1] !== 'terminal' && args[1] !== 'editor' && args[1] !== 'folder') bad('action must be terminal, editor or folder');
      const o = args[2] as { agentId?: unknown; file?: unknown } | undefined | null;
      if (o !== undefined && o !== null) {
        if (typeof o !== 'object') bad('options must be an object');
        if (o.agentId !== undefined && !isId(o.agentId)) bad('agent id must be a short non-empty string');
        if (o.file !== undefined && (typeof o.file !== 'string' || o.file.length > MAX_PATH || CONTROL.test(o.file))) bad('file must be a relative path');
      }
      break;
    }
    case 'testCliPath':
      if (!isId(args[0])) bad('CLI id must be a short non-empty string');
      if (typeof args[1] !== 'string' || !args[1].trim() || args[1].length > MAX_PATH || CONTROL.test(args[1])) bad('path must be an executable path');
      break;
    case 'dryRunCustomCli':
    case 'saveCustomCli': {
      const [d, o] = args;
      if (!d || typeof d !== 'object' || Array.isArray(d)) bad('descriptor must be an object');
      let size = Infinity;
      try { size = JSON.stringify(d).length; } catch { /* cyclic: rejected below */ }
      if (size > MAX_DESCRIPTOR) bad(`descriptor must be plain JSON of at most ${MAX_DESCRIPTOR} characters`);
      const c = o as { confirmExe?: unknown; replace?: unknown } | null | undefined;
      if (!c || typeof c !== 'object' || typeof c.confirmExe !== 'string' || c.confirmExe.length > MAX_PATH || CONTROL.test(c.confirmExe)) bad('options must carry confirmExe, the executable path the user approved');
      if (c!.replace !== undefined && typeof c!.replace !== 'boolean') bad('replace must be true or false');
      break;
    }
    case 'removeCustomCli':
      if (!isId(args[0])) bad('CLI id must be a short non-empty string');
      break;
    case 'readSkill':
    case 'removeSkill':
    case 'setSkillEnabled':
      if (!isSkillId(args[0])) bad('skill id must be a short non-empty string');
      if (method === 'setSkillEnabled' && args[1] !== null && typeof args[1] !== 'boolean') bad('enabled must be true, false or null');
      if (method !== 'removeSkill') { const p = args[method === 'setSkillEnabled' ? 2 : 1]; if (p !== undefined && p !== null && !isId(p)) bad('project id must be a short non-empty string'); }
      break;
    case 'listSkills':
    case 'listMods':
      if (args[0] !== undefined && args[0] !== null && !isId(args[0])) bad('project id must be a short non-empty string');
      break;
    case 'previewSkillImport': {
      const s = args[0] as { kind?: unknown; path?: unknown; ref?: unknown } | null;
      if (!s || typeof s !== 'object' || Array.isArray(s)) bad('source must be an object');
      if (s!.kind === 'folder' || s!.kind === 'zip') { if (typeof s!.path !== 'string' || !s!.path.trim() || s!.path.length > MAX_PATH || CONTROL.test(s!.path)) bad('path must be a folder or file path'); }
      else if (s!.kind === 'github') { if (typeof s!.ref !== 'string' || !s!.ref.trim() || s!.ref.length > 500 || CONTROL.test(s!.ref)) bad('ref must be a GitHub address'); }
      else bad('kind must be folder, zip or github');
      const o = args[1] as { confirmDownload?: unknown } | undefined | null;
      if (o !== undefined && o !== null && (typeof o !== 'object' || (o.confirmDownload !== undefined && !isId(o.confirmDownload)))) bad('options must be an object with an optional confirmDownload token');
      break;
    }
    case 'importSkills': {
      if (!isId(args[0])) bad('token must be a short non-empty string');
      const o = args[1] as { names?: unknown } | undefined | null;
      if (o !== undefined && o !== null && (typeof o !== 'object' || (o.names !== undefined && (!Array.isArray(o.names) || o.names.length > 100 || !o.names.every(isId))))) bad('names must be a list of skill names');
      break;
    }
    case 'browseSkillSource':
      if (args[0] !== 'folder' && args[0] !== 'zip') bad('kind must be folder or zip');
      break;
    case 'listMcpServers':
    case 'listCliMcpServers':
      if (args[0] !== undefined && args[0] !== null && !isId(args[0])) bad('project id must be a short non-empty string');
      break;
    case 'saveMcpServer':
    case 'testMcpServer': {
      const [srv, o] = args;
      if (!srv || typeof srv !== 'object' || Array.isArray(srv)) bad('server must be an object');
      let size = Infinity;
      try { size = JSON.stringify(srv).length; } catch { /* cyclic: rejected below */ }
      if (size > MAX_DESCRIPTOR) bad(`server must be plain JSON of at most ${MAX_DESCRIPTOR} characters`);
      if (o !== undefined && o !== null) {
        if (typeof o !== 'object' || Array.isArray(o)) bad('options must be an object');
        const x = o as { previousName?: unknown; projectId?: unknown; confirmCommand?: unknown };
        if (method === 'saveMcpServer' && x.previousName !== undefined && !isId(x.previousName)) bad('previousName must be a server name');
        if (method === 'saveMcpServer' && x.projectId !== undefined && x.projectId !== null && !isId(x.projectId)) bad('project id must be a short non-empty string');
        if (method === 'testMcpServer' && x.confirmCommand !== undefined && (typeof x.confirmCommand !== 'string' || x.confirmCommand.length > MAX_PATH || CONTROL.test(x.confirmCommand))) bad('confirmCommand must be the command the user approved');
      }
      break;
    }
    case 'removeMcpServer':
    case 'setMcpServerEnabled': {
      if (!isId(args[0])) bad('server name must be a short non-empty string');
      if (method === 'setMcpServerEnabled' && args[1] !== null && typeof args[1] !== 'boolean') bad('enabled must be true, false or null');
      const p = method === 'setMcpServerEnabled' ? args[2] : (args[1] as { projectId?: unknown } | null | undefined)?.projectId;
      if (method === 'removeMcpServer' && args[1] !== undefined && args[1] !== null && (typeof args[1] !== 'object' || Array.isArray(args[1]))) bad('options must be an object');
      if (p !== undefined && p !== null && !isId(p)) bad('project id must be a short non-empty string');
      break;
    }
    case 'previewScreenshot': {
      if (!isId(args[0])) bad('request id must be a short non-empty string');
      const o = args[1] as { sourceId?: unknown } | undefined | null;
      if (o !== undefined && o !== null && (typeof o !== 'object' || Array.isArray(o) || (o.sourceId !== undefined && !isId(o.sourceId)))) bad('options must be an object with an optional sourceId');
      break;
    }
    case 'answerScreenshot': {
      if (!isId(args[0])) bad('request id must be a short non-empty string');
      const a = args[1] as { allow?: unknown; sourceId?: unknown; forConversation?: unknown } | null;
      if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.allow !== 'boolean') bad('answer must be an object with a boolean allow');
      if (a!.sourceId !== undefined && !isId(a!.sourceId)) bad('sourceId must be a short non-empty string');
      if (a!.forConversation !== undefined && typeof a!.forConversation !== 'boolean') bad('forConversation must be true or false');
      break;
    }
    case 'openDocument':
    case 'documentAction': {
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (typeof args[1] !== 'string' || !args[1].trim() || args[1].length > MAX_PATH || CONTROL.test(args[1])) bad('path must be a file path');
      if (method === 'documentAction' && args[2] !== 'openExternal' && args[2] !== 'reveal') bad('action must be openExternal or reveal');
      const o = args[method === 'documentAction' ? 3 : 2] as { agentId?: unknown; since?: unknown } | undefined | null;
      if (o !== undefined && o !== null) {
        if (typeof o !== 'object' || Array.isArray(o)) bad('options must be an object');
        if (o.agentId !== undefined && !isId(o.agentId)) bad('agent id must be a short non-empty string');
        if (method === 'openDocument' && o.since !== undefined && (typeof o.since !== 'number' || !Number.isFinite(o.since))) bad('since must be a time in milliseconds');
      }
      break;
    }
    case 'pickDocument':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      break;
    case 'previewBundleExport': {
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      const s = args[1] as Record<string, unknown> | null;
      if (!s || typeof s !== 'object' || Array.isArray(s)) bad('selection must be an object');
      for (const k of ['settings', 'toolRules', 'skillChoices', 'images']) if (s![k] !== undefined && typeof s![k] !== 'boolean') bad(`${k} must be true or false`);
      if (s!['conversations'] !== undefined && (!Array.isArray(s!['conversations']) || s!['conversations'].length > 200 || !s!['conversations'].every(isId))) bad('conversations must be a list of at most 200 conversation ids');
      if (s!['skills'] !== undefined && (!Array.isArray(s!['skills']) || s!['skills'].length > 50 || !s!['skills'].every(isSkillId))) bad('skills must be a list of at most 50 skill ids');
      break;
    }
    case 'exportBundle': {
      if (!isId(args[0])) bad('token must be a short non-empty string');
      const o = args[1] as { keepSecrets?: unknown; redactSecrets?: unknown } | undefined | null;
      if (o !== undefined && o !== null && (typeof o !== 'object' || Array.isArray(o) || (o.keepSecrets !== undefined && typeof o.keepSecrets !== 'boolean') || (o.redactSecrets !== undefined && typeof o.redactSecrets !== 'boolean'))) bad('options must be an object with optional boolean keepSecrets and redactSecrets');
      break;
    }
    case 'browseImportFile':
      if (args[0] !== 'bundle' && args[0] !== 'chatExport') bad('kind must be bundle or chatExport');
      break;
    case 'previewBundle':
      if (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > MAX_PATH || CONTROL.test(args[0])) bad('path must be a file path');
      break;
    case 'importBundle': {
      if (!isId(args[0])) bad('token must be a short non-empty string');
      const o = args[1] as Record<string, unknown> | null;
      if (!o || typeof o !== 'object' || Array.isArray(o) || !isId(o['projectId'])) bad('options must name a project');
      for (const k of ['settings', 'replaceSettings', 'toolRules', 'skillChoices']) if (o![k] !== undefined && typeof o![k] !== 'boolean') bad(`${k} must be true or false`);
      for (const k of ['skills', 'conversations']) if (o![k] !== undefined && (!Array.isArray(o![k]) || (o![k] as unknown[]).length > 200 || !(o![k] as unknown[]).every(isId))) bad(`${k} must be a list of names from the preview`);
      break;
    }
    case 'previewImport': {
      if (!['claude-code', 'codex', 'claude-export', 'chatgpt-export'].includes(args[0] as string)) bad('source must be claude-code, codex, claude-export or chatgpt-export');
      const o = args[1] as { path?: unknown } | undefined | null;
      if (o !== undefined && o !== null && (typeof o !== 'object' || Array.isArray(o) || (o.path !== undefined && (typeof o.path !== 'string' || o.path.length > MAX_PATH || CONTROL.test(o.path))))) bad('options must be an object with an optional file path');
      break;
    }
    case 'importConversation':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (!isId(args[1])) bad('token must be a short non-empty string');
      if (!Array.isArray(args[2]) || args[2].length < 1 || args[2].length > 200 || !args[2].every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 600 && !CONTROL.test(x))) bad('entryIds must be a list of 1 to 200 entries from the preview');
      break;
    case 'continueImported': {
      if (!isId(args[0])) bad('conversation id must be a short non-empty string');
      const o = args[1] as { cli?: unknown } | null;
      if (!o || typeof o !== 'object' || Array.isArray(o) || !isId(o.cli)) bad('options must name a CLI');
      break;
    }
    case 'createRemoteToken':
      if (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > 80 || /[\x00-\x1f]/.test(args[0])) bad('name must be 1 to 80 characters');
      if (args[1] !== 'read-only' && args[1] !== 'answer-permissions' && args[1] !== 'full') bad('scope must be read-only, answer-permissions or full');
      break;
    case 'renameProject':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (typeof args[1] !== 'string' || !args[1].trim() || args[1].length > 120 || CONTROL.test(args[1])) bad('name must be 1 to 120 characters');
      break;
    case 'revokeRemoteToken':
      if (!isId(args[0])) bad('token id must be a short non-empty string');
      break;
    case 'answerPermission':
      if (!isId(args[0])) bad('request id must be a short non-empty string');
      if (typeof args[1] !== 'boolean') bad('allow must be true or false');
      if (args[2] !== undefined && args[2] !== null && (typeof args[2] !== 'object' || Array.isArray(args[2]))) bad('options must be an object');
      break;
    case 'getSpendStatus':
      if (args[0] !== undefined && args[0] !== null && !isId(args[0])) bad('project id must be a short non-empty string');
      if (args[1] !== undefined && args[1] !== null && !isId(args[1])) bad('conversation id must be a short non-empty string');
      break;
    case 'getTaskReport':
      if (!isId(args[0])) bad('conversation id must be a short non-empty string');
      break;
    case 'rateResult':
      if (!isId(args[0])) bad('target must be an agent or message id');
      if (args[1] !== 'up' && args[1] !== 'down' && args[1] !== 'redo-stronger') bad('rating must be up, down or redo-stronger');
      if (args[2] !== undefined && args[2] !== null && (typeof args[2] !== 'string' || args[2].length > 1000)) bad('note must be text of at most 1000 characters');
      break;
    case 'listRatings':
    case 'getRatingSummary':
    case 'replayRouting': {
      const o = args[0] as Record<string, unknown> | undefined | null;
      if (o === undefined || o === null) break;
      if (typeof o !== 'object' || Array.isArray(o)) bad('options must be an object');
      for (const k of ['projectId', 'conversationId']) if (o[k] !== undefined && !isId(o[k])) bad(`${k} must be a short non-empty string`);
      if (o['by'] !== undefined && o['by'] !== 'cli' && o['by'] !== 'model' && o['by'] !== 'need') bad('by must be cli, model or need');
      if (o['limit'] !== undefined && (typeof o['limit'] !== 'number' || !Number.isFinite(o['limit']))) bad('limit must be a number');
      if (o['catalog'] !== undefined && (!Array.isArray(o['catalog']) || o['catalog'].length > 200)) bad('catalog must be a list of at most 200 entries');
      if (o['settings'] !== undefined && (typeof o['settings'] !== 'object' || o['settings'] === null || Array.isArray(o['settings']))) bad('settings must be an object');
      break;
    }
    case 'listProjectNotes':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      break;
    case 'removeProjectNote':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (!isId(args[1])) bad('note id must be a short non-empty string');
      break;
    case 'createProject': {
      const d = (args[0] ?? {}) as Record<string, unknown>;
      if (!args[0] || typeof d !== 'object' || Array.isArray(d)) bad('the new project must be an object');
      if (typeof d['name'] !== 'string' || !d['name'].trim() || d['name'].length > 80 || CONTROL.test(d['name'])) bad('name must be 1 to 80 characters');
      if (d['parentDir'] !== undefined && (typeof d['parentDir'] !== 'string' || !d['parentDir'].trim() || d['parentDir'].length > MAX_PATH || d['parentDir'].includes('\0'))) bad('parentDir must be a folder path');
      if (d['template'] !== undefined && !['empty', 'node-ts', 'python', 'static-web'].includes(d['template'] as string)) bad('unknown template');
      if (d['userTemplate'] !== undefined && !isId(d['userTemplate'])) bad('userTemplate must be a template id');
      if (d['firstPrompt'] !== undefined && (typeof d['firstPrompt'] !== 'string' || d['firstPrompt'].length > 20000)) bad('firstPrompt must be text of at most 20000 characters');
      const g = (d['github'] ?? {}) as Record<string, unknown>;
      if (d['github'] !== undefined) {
        if (d['github'] === null || typeof g !== 'object' || Array.isArray(g) || typeof g['create'] !== 'boolean') bad('github must say whether to create a repository');
        if (g['create'] && g['visibility'] !== 'private' && g['visibility'] !== 'public') bad('visibility must be private or public');
        if (g['owner'] !== undefined && (typeof g['owner'] !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(g['owner']))) bad('owner must be a GitHub account name');
      }
      break;
    }
    case 'cloneProject': {
      const d = (args[0] ?? {}) as Record<string, unknown>;
      if (!args[0] || typeof d !== 'object' || Array.isArray(d)) bad('the clone request must be an object');
      if (typeof d['url'] !== 'string' || !d['url'].trim() || d['url'].length > 500 || CONTROL.test(d['url'])) bad('url must be an https or ssh URL');
      if (d['name'] !== undefined && (typeof d['name'] !== 'string' || !d['name'].trim() || d['name'].length > 80 || CONTROL.test(d['name']))) bad('name must be 1 to 80 characters');
      if (d['parentDir'] !== undefined && (typeof d['parentDir'] !== 'string' || !d['parentDir'].trim() || d['parentDir'].length > MAX_PATH || d['parentDir'].includes('\0'))) bad('parentDir must be a folder path');
      if (d['firstPrompt'] !== undefined && (typeof d['firstPrompt'] !== 'string' || d['firstPrompt'].length > 20000)) bad('firstPrompt must be text of at most 20000 characters');
      break;
    }
    case 'listGithubRepos': {
      const o = args[0] as Record<string, unknown> | undefined | null;
      if (o === undefined || o === null) break;
      if (typeof o !== 'object' || Array.isArray(o)) bad('options must be an object');
      if (o['owner'] !== undefined && (typeof o['owner'] !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o['owner']))) bad('owner must be a GitHub account name');
      if (o['limit'] !== undefined && (typeof o['limit'] !== 'number' || !Number.isFinite(o['limit']))) bad('limit must be a number');
      if (o['refresh'] !== undefined && typeof o['refresh'] !== 'boolean') bad('refresh must be true or false');
      break;
    }
    case 'setProjectFlags': {
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      const o = args[1] as Record<string, unknown> | undefined | null;
      if (!o || typeof o !== 'object' || Array.isArray(o)) bad('flags must be an object');
      for (const k of ['archived', 'pinned']) if ((o as Record<string, unknown>)[k] !== undefined && typeof (o as Record<string, unknown>)[k] !== 'boolean') bad(`${k} must be true or false`);
      break;
    }
    case 'searchAll': {
      if (typeof args[0] !== 'string' || args[0].length > 500 || CONTROL.test(args[0])) bad('query must be short text');
      const o = args[1] as Record<string, unknown> | undefined | null;
      if (o === undefined || o === null) break;
      if (typeof o !== 'object' || Array.isArray(o)) bad('options must be an object');
      for (const k of ['offset', 'limit']) if (o[k] !== undefined && (typeof o[k] !== 'number' || !Number.isFinite(o[k]))) bad(`${k} must be a number`);
      if (o['projectId'] !== undefined && !isId(o['projectId'])) bad('projectId must be a short non-empty string');
      break;
    }
    case 'previewTemplate':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      break;
    case 'saveProjectAsTemplate':
    case 'updateTemplate': {
      if (!isId(args[0])) bad(method === 'updateTemplate' ? 'template id must be a short non-empty string' : 'project id must be a short non-empty string');
      const d = args[1] as Record<string, unknown> | undefined | null;
      if (!d || typeof d !== 'object' || Array.isArray(d)) bad('the template must be an object');
      const t = d as Record<string, unknown>;
      const needName = method === 'saveProjectAsTemplate';
      if ((needName || t['name'] !== undefined) && (typeof t['name'] !== 'string' || !t['name'].trim() || t['name'].length > 60 || CONTROL.test(t['name']))) bad('name must be 1 to 60 characters');
      if (t['description'] !== undefined && (typeof t['description'] !== 'string' || t['description'].length > 300 || t['description'].includes('\0'))) bad('description must be at most 300 characters');
      if (t['checks'] !== undefined && (!Array.isArray(t['checks']) || t['checks'].length > 10 || !t['checks'].every((c) => typeof c === 'string' && c.length <= 500 && !CONTROL.test(c)))) bad('checks must be at most 10 one-line commands');
      break;
    }
    case 'deleteTemplate':
      if (!isId(args[0])) bad('template id must be a short non-empty string');
      break;
    case 'getPullRequestStatus':
    case 'rerunFailedChecks':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (typeof args[1] !== 'string' || !args[1].trim() || args[1].length > 250 || args[1].startsWith('-') || CONTROL.test(args[1])) bad('branch must be a branch name');
      break;
    case 'mergePullRequest': {
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      const o = args[1] as Record<string, unknown> | undefined | null;
      if (!o || typeof o !== 'object' || Array.isArray(o)) bad('the merge request must be an object');
      const m = o as Record<string, unknown>;
      if (typeof m['branch'] !== 'string' || !m['branch'].trim() || m['branch'].length > 250 || m['branch'].startsWith('-') || CONTROL.test(m['branch'])) bad('branch must be a branch name');
      if (!Number.isInteger(m['number']) || (m['number'] as number) < 1) bad('number must be a pull request number');
      if (!Number.isInteger(m['confirmNumber'])) bad('confirmNumber must repeat the pull request number');
      if (m['method'] !== 'merge' && m['method'] !== 'squash' && m['method'] !== 'rebase') bad('method must be merge, squash or rebase');
      if (m['overrideChecks'] !== undefined && typeof m['overrideChecks'] !== 'boolean') bad('overrideChecks must be true or false');
      break;
    }
    case 'previewReleaseTag':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      break;
    case 'createReleaseTag': {
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      const o = args[1] as Record<string, unknown> | undefined | null;
      if (!o || typeof o !== 'object' || Array.isArray(o)) bad('the tag must be an object');
      const t = o as Record<string, unknown>;
      if (typeof t['name'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(t['name'])) bad('name must be a plain tag name');
      if (t['message'] !== undefined && (typeof t['message'] !== 'string' || t['message'].length > 500 || t['message'].includes('\0'))) bad('message must be text of at most 500 characters');
      if (t['ref'] !== undefined && (typeof t['ref'] !== 'string' || !t['ref'].trim() || t['ref'].length > 250 || t['ref'].startsWith('-') || CONTROL.test(t['ref']))) bad('ref must be a branch or commit');
      if (t['push'] !== undefined && typeof t['push'] !== 'boolean') bad('push must be true or false');
      break;
    }
    case 'previewDeleteProject':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      break;
    case 'deleteProject':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (args[1] !== 'forget' && args[1] !== 'worktrees' && args[1] !== 'folder') bad('scope must be forget, worktrees or folder');
      if (args[2] !== undefined && args[2] !== null && (typeof args[2] !== 'string' || args[2].length > 200)) bad('confirmName must be text');
      if (args[3] !== undefined && args[3] !== null) {
        const o = args[3] as Record<string, unknown>;
        if (typeof o !== 'object' || Array.isArray(o)) bad('options must be an object');
        if (o['permanent'] !== undefined && typeof o['permanent'] !== 'boolean') bad('permanent must be true or false');
        if (o['confirmPermanent'] !== undefined && (typeof o['confirmPermanent'] !== 'string' || o['confirmPermanent'].length > 200)) bad('confirmPermanent must be text');
      }
      break;
    case 'previewPush':
    case 'pushBranch':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (typeof args[1] !== 'string' || !args[1].trim() || args[1].length > 250 || args[1].startsWith('-') || CONTROL.test(args[1])) bad('branch must be a branch name');
      if (method === 'pushBranch' && args[2] !== undefined && args[2] !== null && (typeof args[2] !== 'object' || Array.isArray(args[2]))) bad('options must be an object');
      break;
    case 'createPullRequest': {
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      const d = (args[1] ?? {}) as Record<string, unknown>;
      if (!args[1] || typeof d !== 'object' || Array.isArray(d)) bad('the pull request must be an object');
      if (typeof d['branch'] !== 'string' || !d['branch'].trim() || d['branch'].length > 250 || d['branch'].startsWith('-') || CONTROL.test(d['branch'])) bad('branch must be a branch name');
      if (d['base'] !== undefined && (typeof d['base'] !== 'string' || !d['base'].trim() || d['base'].length > 250 || d['base'].startsWith('-') || CONTROL.test(d['base']))) bad('base must be a branch name');
      if (typeof d['title'] !== 'string' || !d['title'].trim() || d['title'].length > 256 || CONTROL.test(d['title'])) bad('title must be one line of 1 to 256 characters');
      if (d['body'] !== undefined && (typeof d['body'] !== 'string' || d['body'].length > 65000)) bad('body must be text');
      break;
    }
    case 'cleanupWorktrees':
      if (args[0] !== undefined && args[0] !== null && (!Array.isArray(args[0]) || args[0].length > 500 || !args[0].every((x) => typeof x === 'string' && x.length >= 1 && x.length <= MAX_PATH && !x.includes(' ')))) bad('paths must be a list of folder paths');
      break;
    case 'setRemote':
      if (!isId(args[0])) bad('project id must be a short non-empty string');
      if (typeof args[1] !== 'string' || !args[1].trim() || args[1].length > 500 || CONTROL.test(args[1])) bad('url must be an https or ssh URL');
      break;
    case 'addProject':
      if (args[0] !== undefined && args[0] !== null && (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > MAX_PATH || args[0].includes('\0'))) bad('path must be a folder path');
      break;
  }
}
