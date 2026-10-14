import { lstatSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { ZipRefused, readZip } from '../skills/zip';
import { CHAT_LIMITS, Skips, clipMessage, decodeUtf8, isObj, parseTime, readCapped, titleFrom } from './common';
import type { ImportedChat, ImportedMessage, ImportSource, SourceEntry, SourceListing } from './types';

/**
 * Account exports: the `conversations.json` inside a claude.ai or ChatGPT data export (the .zip itself, or the file taken out of it).
 *
 * UNVERIFIED: no real export existed on the development machine, so both parsers follow the publicly described shapes and tolerate
 * anything else (unknown fields are ignored, missing ones skipped, a wrong shape is reported, nothing is ever thrown at the user):
 * - claude.ai: an array of `{ uuid, name, created_at, updated_at, chat_messages: [{ sender: "human"|"assistant", text, content?: [{
 *   type: "text", text } | { type: "thinking"|"tool_use"|"tool_result", ... }], created_at, attachments?, files? }] }`.
 * - ChatGPT: an array of `{ title, create_time, update_time (epoch seconds), mapping: { <node id>: { message?: { author: { role },
 *   content: { content_type, parts?: [string | object], text? }, create_time, recipient?, metadata? }, parent?, children: [] } },
 *   current_node }`. The shown conversation is the path from `current_node` up to the root; other branches (edits, regenerations) are
 *   counted as skipped. Only `user` and `assistant` text is imported; system, tool, hidden and tool-call messages are skipped.
 * Verify against a real export before relying on these, and update this header when that is done.
 */

const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_EXPORT_LISTED = 5000;
const MAX_NODES = 50_000;

type Kind = 'claude' | 'chatgpt';
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The conversations array of an export file, or problems. Hostile input (size, nesting, encoding) becomes a problem or a skip. */
export function readExportFile(path: unknown): { items?: unknown[]; problems: string[]; skipped: string[]; name: string } {
  const problems: string[] = [];
  const skips = new Skips();
  if (typeof path !== 'string' || !path.trim() || /[\0\r\n]/.test(path) || !isAbsolute(path.trim())) return { problems: ['Choose the export file by its full path.'], skipped: [], name: '' };
  const file = path.trim();
  const name = basename(file);
  let st;
  try { st = lstatSync(file); } catch { return { problems: [`${name} does not exist.`], skipped: [], name }; }
  if (st.isSymbolicLink()) return { problems: [`${name} is a link; choose the file it points to.`], skipped: [], name };
  if (!st.isFile()) return { problems: [`${name} is not a file.`], skipped: [], name };
  let json: Buffer;
  if (/\.zip$/i.test(file)) {
    if (st.size > MAX_ARCHIVE) return { problems: [`The archive is larger than ${MAX_ARCHIVE / 1024 / 1024} MB. Take conversations.json out of it and choose that file instead.`], skipped: [], name };
    let found;
    try {
      found = readZip(readCapped(file, MAX_ARCHIVE).buf, { maxEntries: 60000, maxFileBytes: CHAT_LIMITS.maxExportBytes, maxTotalBytes: CHAT_LIMITS.maxExportBytes, maxArchiveBytes: MAX_ARCHIVE },
        { only: (p) => /(^|\/)conversations\.json$/i.test(p) });
    } catch (e) { if (e instanceof ZipRefused) return { problems: [e.message], skipped: [], name }; throw e; }
    const pick = found.sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
    if (!pick) return { problems: ['The archive holds no conversations.json. Is this a claude.ai or ChatGPT data export?'], skipped: [], name };
    json = pick.data;
  } else {
    if (st.size > CHAT_LIMITS.maxExportBytes) return { problems: [`The file is larger than ${CHAT_LIMITS.maxExportBytes / 1024 / 1024} MB.`], skipped: [], name };
    json = readCapped(file, CHAT_LIMITS.maxExportBytes).buf;
  }
  const text = decodeUtf8(json, skips, 'file with invalid UTF-8 (shown with replacement characters)');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    problems.push(e instanceof RangeError ? 'The file is nested too deeply to read.' : 'The file is not valid JSON (it may be cut off or not a conversations.json).');
    return { problems, skipped: skips.list(), name };
  }
  const items = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw['conversations']) ? raw['conversations'] : undefined;
  if (!items) return { problems: ['The file does not hold a list of conversations.'], skipped: skips.list(), name };
  return { items, problems, skipped: skips.list(), name };
}

function kindOf(items: unknown[]): Kind | undefined {
  let c = 0, g = 0;
  for (const it of items.slice(0, 200)) { if (isObj(it) && Array.isArray(it['chat_messages'])) c++; else if (isObj(it) && isObj(it['mapping'])) g++; }
  return c === 0 && g === 0 ? undefined : c >= g ? 'claude' : 'chatgpt';
}

// ---------------------------------------------------------------- claude.ai

export function parseClaudeExportConversation(item: unknown): ImportedChat {
  const skips = new Skips();
  const messages: ImportedMessage[] = [];
  const it = isObj(item) ? item : {};
  const list = Array.isArray(it['chat_messages']) ? it['chat_messages'] : [];
  for (const m of list) {
    if (messages.length >= CHAT_LIMITS.maxMessages) { skips.add(`message past the first ${CHAT_LIMITS.maxMessages}`); break; }
    if (!isObj(m)) { skips.add('unreadable message'); continue; }
    const role = m['sender'] === 'human' || m['sender'] === 'user' ? 'user' : m['sender'] === 'assistant' ? 'assistant' : undefined;
    if (!role) { skips.add('message from another sender'); continue; }
    const parts: string[] = [];
    if (Array.isArray(m['content']) && m['content'].length) {
      for (const b of m['content'].slice(0, 500)) {
        if (!isObj(b)) continue;
        if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text']);
        else if (b['type'] === 'thinking') skips.add('thinking block');
        else if (b['type'] === 'tool_use') skips.add('tool call');
        else if (b['type'] === 'tool_result') skips.add('tool result');
        else skips.add('other content block');
      }
    } else if (typeof m['text'] === 'string') parts.push(m['text']);
    const files = (Array.isArray(m['attachments']) ? m['attachments'].length : 0) + (Array.isArray(m['files']) ? m['files'].length : 0);
    if (files) skips.add('attached file', files);
    const text = parts.join('\n\n').trim();
    if (!text) continue;
    const time = parseTime(m['created_at']);
    messages.push({ role, text: clipMessage(text, skips), ...(time ? { time } : {}) });
  }
  const times = messages.map((m) => m.time).filter((t): t is number => t !== undefined);
  const started = parseTime(it['created_at']) ?? (times.length ? Math.min(...times) : undefined);
  const ended = parseTime(it['updated_at']) ?? (times.length ? Math.max(...times) : undefined);
  return { title: (typeof it['name'] === 'string' && it['name'].trim().slice(0, 160)) || titleFrom(messages.find((m) => m.role === 'user')?.text, 'claude.ai conversation'), ...(started ? { started } : {}), ...(ended ? { ended } : {}), messages, skipped: skips.list() };
}

// ---------------------------------------------------------------- ChatGPT

/** The shown branch of a ChatGPT mapping, root first: current_node up its parents (cycles and missing nodes stop the walk). */
function chatgptPath(mapping: Record<string, unknown>, current: unknown): Record<string, unknown>[] {
  let cur = typeof current === 'string' && has(mapping, current) ? current : undefined;
  if (!cur) {
    // No current node: the newest leaf.
    let best: { id: string; t: number } | undefined;
    for (const id of Object.keys(mapping).slice(0, MAX_NODES)) {
      const n = mapping[id];
      if (!isObj(n) || (Array.isArray(n['children']) && n['children'].length)) continue;
      const t = isObj(n['message']) ? parseTime(n['message']['create_time']) ?? 0 : 0;
      if (!best || t >= best.t) best = { id, t };
    }
    cur = best?.id;
  }
  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur) && path.length < MAX_NODES) {
    seen.add(cur);
    const n = has(mapping, cur) ? mapping[cur] : undefined;
    if (!isObj(n)) break;
    path.push(n);
    cur = typeof n['parent'] === 'string' ? n['parent'] : undefined;
  }
  return path.reverse();
}

export function parseChatgptConversation(item: unknown): ImportedChat {
  const skips = new Skips();
  const messages: ImportedMessage[] = [];
  const it = isObj(item) ? item : {};
  const mapping = isObj(it['mapping']) ? it['mapping'] : {};
  const path = chatgptPath(mapping, it['current_node']);
  const withMessage = Object.keys(mapping).slice(0, MAX_NODES).filter((k) => { const n = mapping[k]; return isObj(n) && isObj(n['message']); }).length;
  const onPath = path.filter((n) => isObj(n['message'])).length;
  if (withMessage > onPath) skips.add('message on an edited or regenerated branch', withMessage - onPath);
  for (const n of path) {
    const m = isObj(n['message']) ? n['message'] : undefined;
    if (!m) continue;
    if (messages.length >= CHAT_LIMITS.maxMessages) { skips.add(`message past the first ${CHAT_LIMITS.maxMessages}`); break; }
    const role = isObj(m['author']) ? m['author']['role'] : undefined;
    const meta = isObj(m['metadata']) ? m['metadata'] : {};
    if (meta['is_visually_hidden_from_conversation'] === true) { skips.add('hidden message'); continue; }
    if (role === 'system') { skips.add('system message'); continue; }
    if (role === 'tool') { skips.add('tool message'); continue; }
    if (role !== 'user' && role !== 'assistant') { skips.add('message from another sender'); continue; }
    if (role === 'assistant' && typeof m['recipient'] === 'string' && m['recipient'] !== 'all') { skips.add('tool call'); continue; }
    const content = isObj(m['content']) ? m['content'] : {};
    const ctype = content['content_type'];
    if (ctype === 'user_editable_context' || ctype === 'model_editable_context') { skips.add('custom instructions block'); continue; }
    if (ctype === 'thoughts' || ctype === 'reasoning_recap') { skips.add('thinking block'); continue; }
    const parts: string[] = [];
    if (Array.isArray(content['parts'])) {
      for (const p of content['parts'].slice(0, 200)) {
        if (typeof p === 'string') parts.push(p);
        else if (isObj(p) && typeof p['text'] === 'string') parts.push(p['text']);
        else if (isObj(p)) skips.add(p['content_type'] === 'image_asset_pointer' ? 'image' : 'other content part');
      }
    } else if (typeof content['text'] === 'string') parts.push(ctype === 'code' ? `\`\`\`\n${content['text']}\n\`\`\`` : content['text']);
    else if (ctype !== undefined) skips.add('other content type');
    const text = parts.join('\n').trim();
    if (!text) continue;
    const time = parseTime(m['create_time']);
    messages.push({ role, text: clipMessage(text, skips), ...(time ? { time } : {}) });
  }
  const times = messages.map((m) => m.time).filter((t): t is number => t !== undefined);
  const started = parseTime(it['create_time']) ?? (times.length ? Math.min(...times) : undefined);
  const ended = parseTime(it['update_time']) ?? (times.length ? Math.max(...times) : undefined);
  return { title: (typeof it['title'] === 'string' && it['title'].trim().slice(0, 160)) || titleFrom(messages.find((m) => m.role === 'user')?.text, 'ChatGPT conversation'), ...(started ? { started } : {}), ...(ended ? { ended } : {}), messages, skipped: skips.list() };
}

// ---------------------------------------------------------------- sources

function listing(kind: Kind, label: string, path: unknown): SourceListing {
  const r = readExportFile(path);
  if (!r.items) return { label, entries: [], problems: r.problems, skipped: r.skipped };
  const found = kindOf(r.items);
  const other = kind === 'claude' ? 'ChatGPT' : 'claude.ai';
  if (r.items.length && !found) return { label, entries: [], problems: ['No conversations in a known shape were found in this file.'], skipped: r.skipped };
  if (found && found !== kind) return { label, entries: [], problems: [`This looks like a ${other} export. Choose "${other} export" instead.`], skipped: r.skipped };
  const skips = new Skips();
  const entries: SourceEntry[] = [];
  r.items.slice(0, MAX_EXPORT_LISTED).forEach((it, i) => {
    if (!isObj(it)) { skips.add('unreadable conversation'); return; }
    const count = kind === 'claude' ? (Array.isArray(it['chat_messages']) ? it['chat_messages'].length : 0) : (isObj(it['mapping']) ? Object.keys(it['mapping']).length : 0);
    const title = typeof (kind === 'claude' ? it['name'] : it['title']) === 'string' ? String(kind === 'claude' ? it['name'] : it['title']).trim().slice(0, 160) : '';
    const started = parseTime(kind === 'claude' ? it['created_at'] : it['create_time']);
    const updated = parseTime(kind === 'claude' ? it['updated_at'] : it['update_time']);
    entries.push({ id: String(i), title: title || `Untitled conversation ${i + 1}`, ...(started ? { started } : {}), ...(updated ? { updated } : {}), messages: count, ref: it });
  });
  return { label: `${label} (${r.name})`, entries, problems: [], skipped: [...r.skipped, ...skips.list()], ...(r.items.length > MAX_EXPORT_LISTED ? { truncated: true } : {}) };
}

export const claudeExportSource: ImportSource = {
  id: 'claude-export', name: 'claude.ai export', kind: 'file', verified: false,
  note: 'The conversations.json of a claude.ai data export (Settings > Privacy > Export data), or the export .zip. Not yet checked against a real export.',
  detect: () => ({ available: true }),
  preview: (_env, input) => listing('claude', 'claude.ai export', input.path),
  read: (_env, entry) => parseClaudeExportConversation(entry.ref)
};

export const chatgptExportSource: ImportSource = {
  id: 'chatgpt-export', name: 'ChatGPT export', kind: 'file', verified: false,
  note: 'The conversations.json of a ChatGPT data export (Settings > Data controls > Export data), or the export .zip. Not yet checked against a real export.',
  detect: () => ({ available: true }),
  preview: (_env, input) => listing('chatgpt', 'ChatGPT export', input.path),
  read: (_env, entry) => parseChatgptConversation(entry.ref)
};
