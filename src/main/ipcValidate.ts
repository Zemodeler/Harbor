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
      const [id, text, attachments] = args;
      if (!isId(id)) bad('conversation id must be a short non-empty string');
      if (typeof text !== 'string' || text.length > MAX_TEXT) bad(`text must be a string of at most ${MAX_TEXT} characters`);
      if (attachments !== undefined && attachments !== null) {
        if (!Array.isArray(attachments) || attachments.length > 6) bad('attachments must be a list of at most 6 images');
        for (const a of attachments as unknown[]) {
          const o = a as { name?: unknown; mime?: unknown; dataBase64?: unknown } | null;
          if (!o || typeof o !== 'object' || typeof o.name !== 'string' || o.name.length > 260 || typeof o.mime !== 'string' || o.mime.length > 100 || typeof o.dataBase64 !== 'string') bad('each attachment needs a name, mime type and base64 data');
        }
      }
      break;
    }
    case 'answerQuestion':
      if (!isId(args[0])) bad('request id must be a short non-empty string');
      if (typeof args[1] !== 'string' || args[1].length > MAX_ANSWER) bad(`answer must be a string of at most ${MAX_ANSWER} characters`);
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
    case 'addProject':
      if (args[0] !== undefined && args[0] !== null && (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > MAX_PATH || args[0].includes('\0'))) bad('path must be a folder path');
      break;
  }
}
