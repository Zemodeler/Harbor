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
        if (!Array.isArray(attachments) || attachments.length > 6) bad('attachments must be a list of at most 6 images');
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
    case 'addProject':
      if (args[0] !== undefined && args[0] !== null && (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > MAX_PATH || args[0].includes('\0'))) bad('path must be a folder path');
      break;
  }
}
