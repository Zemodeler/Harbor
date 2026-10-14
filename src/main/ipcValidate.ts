const MAX_TEXT = 200_000;
const MAX_ANSWER = 20_000;
const MAX_PATH = 1024;
const CONTROL = /[\0\r\n]/;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 200 && !CONTROL.test(v);

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
    case 'addProject':
      if (args[0] !== undefined && args[0] !== null && (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > MAX_PATH || args[0].includes('\0'))) bad('path must be a folder path');
      break;
  }
}
