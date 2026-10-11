import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Event as ElectronEvent, Session, WebContents } from 'electron';
import { normPath } from './store';

/**
 * Which document the Harbor window is meant to show. Only this exact document may talk to the service or stay
 * loaded in the window: "any file://" or "anything on the dev host" would let a stray local file or another dev
 * page drive agents that edit the user's projects.
 */
export type AppDocument =
  | { kind: 'file'; path: string }
  | { kind: 'dev'; origin: string; pathname: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(url: string): URL | undefined {
  try { return new URL(url); } catch { return undefined; }
}

/** The packaged renderer file, or electron-vite's dev server; the dev server must be a loopback http(s) URL. */
export function appDocument(indexFile: string, devUrl?: string): AppDocument {
  if (!devUrl) return { kind: 'file', path: resolve(indexFile) };
  const u = parse(devUrl);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK_HOSTS.has(u.hostname) || u.username || u.password) {
    throw new Error(`Refusing renderer URL ${devUrl}: the dev server must be a loopback http(s) address`);
  }
  return { kind: 'dev', origin: u.origin, pathname: u.pathname };
}

/** True only for the app document itself (query and hash may differ: they do not change which document it is). */
export function isAppDocumentUrl(url: string, doc: AppDocument): boolean {
  const u = parse(url);
  if (!u || u.username || u.password) return false;
  if (doc.kind === 'dev') {
    if (u.origin !== doc.origin) return false;
    return u.pathname === doc.pathname || (doc.pathname.endsWith('/') && u.pathname === `${doc.pathname}index.html`);
  }
  // A host makes it a UNC share; encoded separators or NULs would be decoded into a different path than the URL shows.
  if (u.protocol !== 'file:' || u.host !== '' || /%(2f|5c|00)/i.test(u.pathname)) return false;
  let path: string;
  try { path = fileURLToPath(u); } catch { return false; }
  return normPath(resolve(path)) === normPath(doc.path);
}

/** An http(s) link that may be handed to the user's browser; everything else (javascript:, data:, file:, custom schemes) is refused. */
export function externalUrl(url: string, doc: AppDocument): string | undefined {
  const u = parse(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return undefined;
  // Other pages of the dev server are app-internal, not links for the browser.
  if (doc.kind === 'dev' && u.origin === doc.origin) return undefined;
  return u.href;
}

export type NavigationDecision = { action: 'allow' } | { action: 'deny'; openExternal?: string };

/** Frames may only (re)load the app document; a top-level click on a web link goes to the browser instead. */
export function navigationDecision(url: string, isMainFrame: boolean, doc: AppDocument): NavigationDecision {
  if (isAppDocumentUrl(url, doc)) return { action: 'allow' };
  const external = isMainFrame ? externalUrl(url, doc) : undefined;
  return external ? { action: 'deny', openExternal: external } : { action: 'deny' };
}

/** Harbor never opens a second window; window.open / target=_blank web links go to the browser. */
export function windowOpenDecision(url: string, doc: AppDocument): { action: 'deny'; openExternal?: string } {
  const external = externalUrl(url, doc);
  return external ? { action: 'deny', openExternal: external } : { action: 'deny' };
}

/** Permissions the renderer actually uses: copy buttons write the clipboard. Everything else is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

export function permissionAllowed(permission: string, requestingUrl: string | undefined, isMainFrame: boolean, doc: AppDocument): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isMainFrame && requestingUrl !== undefined && isAppDocumentUrl(requestingUrl, doc);
}

// Structural views of WebFrameMain / WebContents so the sender check is testable without Electron.
export interface FrameRef { readonly url: string; readonly parent: unknown; readonly processId: number; readonly routingId: number }
export interface ContentsRef { readonly id: number; readonly mainFrame: FrameRef; isDestroyed(): boolean }
export interface InvokeEventRef { readonly sender: ContentsRef; readonly senderFrame: FrameRef | null }

/** An invoke is trusted only from the main frame of Harbor's current window while it shows the app document. */
export function isTrustedInvoke(event: InvokeEventRef, current: ContentsRef | undefined, doc: AppDocument): boolean {
  if (!current || current.isDestroyed() || event.sender !== current || event.sender.id !== current.id) return false;
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  const main = current.mainFrame;
  if (frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
  return isAppDocumentUrl(frame.url, doc);
}

const hardenedSessions = new WeakSet<Session>();

/**
 * Applies the window policy to one WebContents (index.ts calls it for every one Electron creates).
 * Only Electron types are imported here; the runtime objects come from the caller.
 */
export function hardenContents(contents: WebContents, doc: AppDocument, openExternal: (url: string) => void): void {
  contents.setWindowOpenHandler(details => {
    const decision = windowOpenDecision(details.url, doc);
    if (decision.openExternal) openExternal(decision.openExternal);
    return { action: 'deny' };
  });
  const guard = (event: ElectronEvent<{ url: string; isMainFrame: boolean }>): void => {
    const decision = navigationDecision(event.url, event.isMainFrame, doc);
    if (decision.action === 'allow') return;
    event.preventDefault();
    if (decision.openExternal) openExternal(decision.openExternal);
  };
  // will-frame-navigate covers the main frame and subframes; redirects are a separate event.
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', event => { if (!isAppDocumentUrl(event.url, doc)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  const ses = contents.session;
  if (hardenedSessions.has(ses)) return;
  hardenedSessions.add(ses);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(permissionAllowed(permission, details.requestingUrl, details.isMainFrame, doc)));
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    permissionAllowed(permission, details.requestingUrl, details.isMainFrame, doc));
  ses.setDevicePermissionHandler(() => false);
}
