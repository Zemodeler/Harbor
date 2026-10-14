import type { ChatImportEntry, ChatImportSourceId } from '../../shared/api';

/**
 * Chat importers (plan section 6.2) behind one interface. A source never writes anything and never runs anything: it lists chats
 * (`preview`) and turns one into plain messages (`read`). Everything it reads is untrusted data; parsers tolerate unknown fields,
 * truncated and hostile files (huge, deeply nested, bad encodings) and say what they skipped.
 */

export interface ImportedMessage { role: 'user' | 'assistant'; text: string; time?: number }
export interface ImportedChat { title: string; started?: number; ended?: number; messages: ImportedMessage[]; skipped: string[] }

/** One listed chat. `ref` is the source's own handle (a file it listed, or a chat it parsed); it never comes from the renderer. */
export interface SourceEntry extends ChatImportEntry { ref: unknown }
export interface SourceListing { label: string; entries: SourceEntry[]; problems: string[]; skipped: string[]; truncated?: boolean }

export interface ImportEnv {
  /** ~/.claude (Claude Code's folder). */
  claudeHome?: string;
  /** CODEX_HOME, default ~/.codex. */
  codexHome?: string;
  /** For showing locations with ~ instead of the user's name. */
  home?: string;
  now: () => number;
}

export interface ImportSource {
  id: ChatImportSourceId;
  name: string;
  kind: 'folder' | 'file';
  /** True when the format was learned from real files on a development machine; false = from documentation only. */
  verified: boolean;
  note?: string;
  /** Whether the source's folder exists. Reads no file. */
  detect(env: ImportEnv): { available: boolean; location?: string };
  /** Folder sources list files without reading them; file sources parse the picked file (`path`). */
  preview(env: ImportEnv, input: { path?: string }): SourceListing;
  /** One chat the user chose from this source's own listing. */
  read(env: ImportEnv, entry: SourceEntry): ImportedChat;
}
