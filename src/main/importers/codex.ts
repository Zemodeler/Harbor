import { CHAT_LIMITS, Skips, clipMessage, decodeUtf8, isObj, jsonLines, joinPath, parseTime, plainEntries, readCapped, statOf, tildify, titleFrom } from './common';
import type { ImportedChat, ImportedMessage, ImportSource, SourceEntry } from './types';

/**
 * Codex sessions: `$CODEX_HOME\sessions\YYYY\MM\DD\rollout-<time>-<id>.jsonl` (default `~\.codex`), one JSON object per line.
 *
 * Learned from real session files on the development machine (codex-cli 0.16x, October 2026; structure only, no content kept). Each
 * line is `{ timestamp, type, payload }`. `session_meta` (payload `id`, `timestamp`, `cwd`, `cli_version`, ...) opens the file.
 * Conversation: `response_item` lines whose payload is `{ type: "message", role: "user"|"assistant"|"developer", content: [{ type:
 * "input_text"|"output_text", text }] }`. `developer` messages are Codex's own instructions; user messages that start with
 * `<environment_context>` or an AGENTS.md block are context Codex injects. Reasoning (`reasoning`, encrypted), tool calls
 * (`function_call`, `custom_tool_call` and their outputs), `event_msg`, `turn_context`, `token_usage_record` and `world_state` are not
 * chat text and are counted as skipped. Older files without the `response_item` wrapper (`{ type: "message", role, content }`) are read
 * the same way. Titles come from `$CODEX_HOME\session_index.jsonl` (`{ id, thread_name, updated_at }`) when it names the session.
 */

const INJECTED = /^\s*(<environment_context>|<user_instructions>|<permissions|<collaboration_mode|# AGENTS\.md instructions|<INSTRUCTIONS>)/;
const ID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function parseCodexSession(buf: Buffer, truncated: boolean, title?: string): ImportedChat {
  const skips = new Skips();
  const messages: ImportedMessage[] = [];
  let started: number | undefined, tooMany = false;
  for (const o of jsonLines(buf, skips, truncated)) {
    if (!isObj(o)) { skips.add('unreadable line'); continue; }
    const payload = o['type'] === 'response_item' && isObj(o['payload']) ? o['payload'] : o['type'] === 'message' ? o : undefined;
    if (o['type'] === 'session_meta' && isObj(o['payload'])) { started = parseTime(o['payload']['timestamp']) ?? parseTime(o['timestamp']); continue; }
    if (!payload) { skips.add('bookkeeping entry'); continue; }
    const ptype = payload['type'];
    if (ptype === 'reasoning') { skips.add('reasoning entry'); continue; }
    if (typeof ptype === 'string' && /call/.test(ptype)) { skips.add(/output/.test(ptype) ? 'tool result' : 'tool call'); continue; }
    if (ptype !== 'message') { skips.add('other entry'); continue; }
    const role = payload['role'];
    if (role === 'developer' || role === 'system') { skips.add('instruction message from Codex'); continue; }
    if (role !== 'user' && role !== 'assistant') { skips.add('other entry'); continue; }
    const parts: string[] = [];
    for (const b of Array.isArray(payload['content']) ? payload['content'].slice(0, 200) : []) {
      if (!isObj(b)) continue;
      if ((b['type'] === 'input_text' || b['type'] === 'output_text' || b['type'] === 'text') && typeof b['text'] === 'string') {
        if (role === 'user' && INJECTED.test(b['text'])) { skips.add('Codex context block'); continue; }
        parts.push(b['text']);
      } else if (b['type'] === 'input_image') skips.add('attached image');
      else skips.add('other content block');
    }
    let text = parts.join('\n\n').trim();
    if (!text) continue;
    text = clipMessage(text, skips);
    const time = parseTime(o['timestamp']);
    const prev = messages.at(-1);
    // Codex streams commentary and the final answer as separate assistant messages: shown as one.
    if (role === 'assistant' && prev?.role === 'assistant') { prev.text = clipMessage(`${prev.text}\n\n${text}`, skips); continue; }
    if (messages.length >= CHAT_LIMITS.maxMessages) { tooMany = true; continue; }
    messages.push({ role, text, ...(time ? { time } : {}) });
  }
  if (tooMany) skips.add(`message past the first ${CHAT_LIMITS.maxMessages}`);
  const times = messages.map((m) => m.time).filter((t): t is number => t !== undefined);
  return {
    title: title || titleFrom(messages.find((m) => m.role === 'user')?.text, 'Codex session'),
    ...(times.length || started ? { started: Math.min(...times, ...(started ? [started] : [])), ended: Math.max(...times, ...(started ? [started] : [])) } : {}),
    messages, skipped: skips.list()
  };
}

/** Thread names by session id from session_index.jsonl (names only; the last entry for an id wins). */
function threadNames(codexHome: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const { buf } = readCapped(joinPath(codexHome, 'session_index.jsonl'), 8 * 1024 * 1024);
    for (const line of decodeUtf8(buf).split('\n')) {
      try { const o = JSON.parse(line) as unknown; if (isObj(o) && typeof o['id'] === 'string' && typeof o['thread_name'] === 'string') out.set(o['id'].toLowerCase(), o['thread_name'].slice(0, 160)); } catch { /* skip */ }
    }
  } catch { /* no index: titles come from the first message */ }
  return out;
}

export const codexSource: ImportSource = {
  id: 'codex', name: 'Codex', kind: 'folder', verified: true,
  note: 'Sessions in ~\\.codex\\sessions. Harbor lists the session files and their names; it reads only the ones you choose.',
  detect(env) {
    const dir = env.codexHome ? joinPath(env.codexHome, 'sessions') : undefined;
    const ok = !!dir && plainEntries(env.codexHome!).some((e) => e.isDirectory() && e.name === 'sessions');
    return { available: ok, ...(dir ? { location: tildify(dir, env.home) } : {}) };
  },
  preview(env) {
    if (!env.codexHome || !this.detect(env).available) return { label: 'Codex', entries: [], problems: ['No Codex sessions folder (~\\.codex\\sessions) was found.'], skipped: [] };
    const root = joinPath(env.codexHome, 'sessions');
    const names = threadNames(env.codexHome);
    const found: Array<SourceEntry & { mtime: number }> = [];
    let truncated = false;
    // YYYY\MM\DD\file: three folder levels, no links followed.
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop()!;
      for (const e of plainEntries(dir)) {
        const p = joinPath(dir, e.name);
        if (e.isDirectory() && depth < 3) stack.push({ dir: p, depth: depth + 1 });
        else if (e.isFile() && /^rollout-.*\.jsonl$/i.test(e.name)) {
          if (found.length >= CHAT_LIMITS.maxListed * 2) { truncated = true; continue; }
          const st = statOf(p);
          if (!st) continue;
          const id = ID_IN_NAME.exec(e.name)?.[1]?.toLowerCase();
          const rel = p.slice(root.length + 1).replace(/\\/g, '/');
          found.push({ id: rel, title: (id && names.get(id)) || e.name.replace(/^rollout-/i, '').replace(/\.jsonl$/i, ''), detail: rel, updated: Math.round(st.mtime), bytes: st.size, ref: { path: p, title: id ? names.get(id) : undefined }, mtime: st.mtime });
        }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    if (found.length > CHAT_LIMITS.maxListed) truncated = true;
    return { label: 'Codex', entries: found.slice(0, CHAT_LIMITS.maxListed).map(({ mtime: _m, ...e }) => e), problems: [], skipped: [], ...(truncated ? { truncated } : {}) };
  },
  read(_env, entry) {
    const ref = entry.ref as { path: string; title?: string };
    const { buf, truncated } = readCapped(ref.path, CHAT_LIMITS.maxFileBytes);
    const chat = parseCodexSession(buf, truncated, ref.title);
    if (truncated) chat.skipped.push(`the part of the file past ${CHAT_LIMITS.maxFileBytes / 1024 / 1024} MB`);
    return chat;
  }
};
