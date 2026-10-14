import { CHAT_LIMITS, Skips, clipMessage, isObj, jsonLines, joinPath, parseTime, plainEntries, readCapped, statOf, tildify, titleFrom } from './common';
import type { ImportedChat, ImportedMessage, ImportSource, SourceEntry } from './types';

/**
 * Claude Code transcripts: `~\.claude\projects\<encoded cwd>\<session id>.jsonl`, one JSON object per line.
 *
 * Learned from real transcripts on the development machine (Claude Code 2.1.x, October 2026; structure only, no content kept). Lines
 * have a `type`. Conversation lines: `user` and `assistant` with `message.role` and `message.content` (a string, or blocks: `text`,
 * `thinking`, `tool_use`, `tool_result`, `image`), plus `timestamp` (ISO), `uuid`, `parentUuid`, `sessionId`, `cwd`, `isSidechain`
 * (subagent work) and `isMeta` (injected context). One assistant reply is often split over several lines sharing `message.id`.
 * Titles: `custom-title` lines (`customTitle`); older files have `summary` lines. Everything else (`attachment`, `system`,
 * `file-history-*`, `queue-operation`, `last-prompt`, `cost-state`, ...) is bookkeeping. Subfolders (`subagents`, `tool-results`,
 * `memory`) are not chats and are not listed. Only visible text is imported: thinking, tool calls and tool results are counted as
 * skipped. Unknown types and fields are ignored.
 */

const WRAPPED = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder|user-prompt-submit-hook)\b/;
const REMINDER = /<system-reminder>[\s\S]{0,200000}?<\/system-reminder>/g;

function textOf(content: unknown, skips: Skips, role: 'user' | 'assistant'): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content.slice(0, 500)) {
    if (!isObj(b)) continue;
    if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text']);
    else if (b['type'] === 'thinking' || b['type'] === 'redacted_thinking') skips.add('thinking block');
    else if (b['type'] === 'tool_use') skips.add('tool call');
    else if (b['type'] === 'tool_result') skips.add('tool result');
    else if (b['type'] === 'image') skips.add(role === 'user' ? 'attached image' : 'image');
    else skips.add('other content block');
  }
  return parts.join('\n\n');
}

export function parseClaudeTranscript(buf: Buffer, truncated: boolean): ImportedChat {
  const skips = new Skips();
  const messages: ImportedMessage[] = [];
  let customTitle: string | undefined, summary: string | undefined;
  let tooMany = false;
  for (const o of jsonLines(buf, skips, truncated)) {
    if (!isObj(o)) { skips.add('unreadable line'); continue; }
    const type = o['type'];
    if (type === 'custom-title' && typeof o['customTitle'] === 'string') { customTitle = o['customTitle'].slice(0, 160); continue; }
    if (type === 'summary' && typeof o['summary'] === 'string') { summary = o['summary'].slice(0, 160); continue; }
    if (type !== 'user' && type !== 'assistant') { skips.add('bookkeeping entry'); continue; }
    if (o['isSidechain'] === true) { skips.add('subagent entry'); continue; }
    if (o['isMeta'] === true) { skips.add('injected context entry'); continue; }
    const msg = isObj(o['message']) ? o['message'] : undefined;
    if (!msg) { skips.add('unreadable line'); continue; }
    const role = type as 'user' | 'assistant';
    let text = textOf(msg['content'], skips, role).replace(REMINDER, '').trim();
    if (role === 'user' && WRAPPED.test(text)) { skips.add('command or notification entry'); continue; }
    const time = parseTime(o['timestamp']);
    if (!text) continue; // a line with only tool use or results
    text = clipMessage(text, skips);
    const prev = messages.at(-1);
    // One reply streamed over several lines, or text between tool calls: shown as one assistant message.
    if (role === 'assistant' && prev?.role === 'assistant') { prev.text = clipMessage(`${prev.text}\n\n${text}`, skips); continue; }
    if (messages.length >= CHAT_LIMITS.maxMessages) { tooMany = true; continue; }
    messages.push({ role, text, ...(time ? { time } : {}) });
  }
  if (tooMany) skips.add(`message past the first ${CHAT_LIMITS.maxMessages}`);
  const times = messages.map((m) => m.time).filter((t): t is number => t !== undefined);
  return {
    title: customTitle || summary || titleFrom(messages.find((m) => m.role === 'user')?.text, 'Claude Code session'),
    ...(times.length ? { started: Math.min(...times), ended: Math.max(...times) } : {}),
    messages, skipped: skips.list()
  };
}

/** `C--Users-me-Documents-app` (Claude's encoding of the session's folder) shown with the home folder as ~. */
function folderLabel(folder: string, home?: string): string {
  const enc = home ? home.replace(/[^A-Za-z0-9]/g, '-') : '';
  return enc && folder.toLowerCase().startsWith(enc.toLowerCase()) ? `~${folder.slice(enc.length)}` : folder;
}

export const claudeCodeSource: ImportSource = {
  id: 'claude-code', name: 'Claude Code', kind: 'folder', verified: true,
  note: 'Sessions in ~\\.claude\\projects. Harbor lists the session files; it reads only the ones you choose.',
  detect(env) {
    const dir = env.claudeHome ? joinPath(env.claudeHome, 'projects') : undefined;
    const ok = !!dir && plainEntries(env.claudeHome!).some((e) => e.isDirectory() && e.name === 'projects');
    return { available: ok, ...(dir ? { location: tildify(dir, env.home) } : {}) };
  },
  preview(env) {
    const root = env.claudeHome ? joinPath(env.claudeHome, 'projects') : undefined;
    if (!root || !this.detect(env).available) return { label: 'Claude Code', entries: [], problems: ['No Claude Code sessions folder (~\\.claude\\projects) was found.'], skipped: [] };
    const found: Array<SourceEntry & { mtime: number }> = [];
    let truncated = false;
    for (const d of plainEntries(root)) {
      if (!d.isDirectory()) continue;
      for (const f of plainEntries(joinPath(root, d.name))) {
        if (!f.isFile() || !f.name.toLowerCase().endsWith('.jsonl')) continue;
        if (found.length >= CHAT_LIMITS.maxListed * 2) { truncated = true; break; }
        const path = joinPath(root, d.name, f.name);
        const st = statOf(path);
        if (!st) continue;
        found.push({ id: `${d.name}/${f.name}`, title: folderLabel(d.name, env.home), detail: f.name.replace(/\.jsonl$/i, ''), updated: Math.round(st.mtime), bytes: st.size, ref: path, mtime: st.mtime });
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    if (found.length > CHAT_LIMITS.maxListed) truncated = true;
    return { label: 'Claude Code', entries: found.slice(0, CHAT_LIMITS.maxListed).map(({ mtime: _m, ...e }) => e), problems: [], skipped: [], ...(truncated ? { truncated } : {}) };
  },
  read(_env, entry) {
    const { buf, truncated } = readCapped(String(entry.ref), CHAT_LIMITS.maxFileBytes);
    const chat = parseClaudeTranscript(buf, truncated);
    if (truncated) chat.skipped.push(`the part of the file past ${CHAT_LIMITS.maxFileBytes / 1024 / 1024} MB`);
    return chat;
  }
};
