import { createContext, useContext, type ReactNode } from 'react';
import { isPathLike, splitPaths } from './paths';
import d from './Documents.module.css';

/** Opens a file in the document viewer; provided by App. Without a provider, paths stay plain text (tests, other screens). */
export interface DocumentOpener { open(path: string, opts?: { agentId?: string; title?: string }): void }
export const DocumentLinks = createContext<DocumentOpener | null>(null);
/** The agent whose worktree relative paths in this message belong to (its own messages); undefined = the project folder. */
export const LinkAgent = createContext<string | undefined>(undefined);

function PathButton({ path, children }: { path: string; children: ReactNode }) {
  const opener = useContext(DocumentLinks);
  const agentId = useContext(LinkAgent);
  return <button type="button" className={d.pathLink} title={`Open ${path} in Harbor's viewer`} onClick={() => opener?.open(path, agentId ? { agentId } : undefined)}>{children}</button>;
}

/** A file name in a list (changed files, the Git panel) that opens in the viewer; plain text when there is no viewer or nothing to open. */
export function OpenFileButton({ path, agentId, disabled, children }: { path: string; agentId?: string; disabled?: boolean; children: ReactNode }) {
  const opener = useContext(DocumentLinks);
  if (!opener || disabled) return <>{children}</>;
  return <button type="button" className={d.pathLink} title={`Open ${path} in Harbor's viewer`} onClick={() => opener.open(path, agentId ? { agentId } : undefined)}>{children}</button>;
}

/** Inline code that names a file opens it; any other code span is plain. */
export function PathCode({ text }: { text: string }) {
  const opener = useContext(DocumentLinks);
  if (!opener || !isPathLike(text)) return <code>{text}</code>;
  return <PathButton path={text.trim()}><code>{text}</code></PathButton>;
}

/** Prose with file paths (with a folder separator) made clickable. */
export function PathText({ text }: { text: string }) {
  const opener = useContext(DocumentLinks);
  if (!opener || !/[\\/]/.test(text)) return <>{text}</>;
  const parts = splitPaths(text);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((p, i) => i % 2 ? <PathButton key={i} path={p}>{p}</PathButton> : p)}</>;
}
