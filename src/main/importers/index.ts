import type { ChatImportSourceId } from '../../shared/api';
import { chatgptExportSource, claudeExportSource } from './accountExports';
import { claudeCodeSource } from './claudeCode';
import { codexSource } from './codex';
import type { ImportSource } from './types';

/** Every chat importer, in the order the import dialog shows them. A new source implements ImportSource and is added here. */
export const IMPORT_SOURCES: readonly ImportSource[] = [claudeCodeSource, codexSource, claudeExportSource, chatgptExportSource];

export function importSource(id: unknown): ImportSource | undefined {
  return IMPORT_SOURCES.find((s) => s.id === id);
}

export const SOURCE_LABEL: Record<ChatImportSourceId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'claude-export': 'claude.ai', 'chatgpt-export': 'ChatGPT' };
export type { ImportSource, ImportEnv, ImportedChat, ImportedMessage, SourceEntry, SourceListing } from './types';
