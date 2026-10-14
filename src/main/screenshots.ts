import { rmSync } from 'node:fs';
import type { AgentRole, Attachment, Id, PendingPermission, ScreenshotSource } from '../shared/api';
import { newId } from './store';

/**
 * Screenshots an agent asks for with a `HARBOR_SCREENSHOT` line (plan section 4.2). Owner decisions applied here: any window or
 * any screen may be captured and helpers may ask as well as leads, so every capture needs the user's explicit yes, the card shows a
 * live preview before anything is given to a model, the target is what the USER picks in the card (the agent's words are only a
 * hint), "allow for this conversation" exists for windows only, is off by default and never covers a screen, at most one capture
 * per agent per minute without a fresh yes, one journal line per capture, never silent and never while Harbor is in the background.
 *
 * The capture itself sits behind `Capturer`; the real one (Electron desktopCapturer) lives only in index.ts, so everything here is
 * tested with a fake. Image bytes never reach the journal, logs or diagnostics: the journal gets the kind of source and the agent,
 * not even the window title (titles can name private documents or chats).
 */

export interface CapturedSource { id: string; name: string; kind: 'screen' | 'window'; thumbnail?: string }
export interface Capturer {
  /** Every window and screen now, each with a thumbnail scaled to fit `size` (0 x 0 = no thumbnails). */
  list(size: { width: number; height: number }): Promise<CapturedSource[]>;
  /** A full-size PNG of one source; undefined when it is gone or cannot be captured. */
  capture(sourceId: string): Promise<Buffer | undefined>;
}

/** What a HARBOR_SCREENSHOT line asked for. */
export interface ScreenshotLine { target: 'screen' | 'window'; title?: string; why: string }

const oneLine = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A HARBOR_SCREENSHOT payload, or undefined (garbage, an unknown target, no reason). */
export function toScreenshotLine(j: unknown): ScreenshotLine | undefined {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const r = j as Record<string, unknown>;
  const target = r['target'];
  if (target !== 'screen' && target !== 'window') return undefined;
  const why = oneLine(r['why'] ?? r['reason'], 300);
  if (!why) return undefined;
  const title = target === 'window' ? oneLine(r['title'], 200) : '';
  return { target, why, ...(title ? { title } : {}) };
}

export const SCREENSHOT_TIMEOUT_MS = 5 * 60_000;
/** One capture per agent per minute; a request within it always asks, even when the window is allowed for the conversation. */
export const SCREENSHOT_RATE_MS = 60_000;
export const PREVIEW_SIZE = { width: 320, height: 200 };
export const DETAIL_SIZE = { width: 960, height: 600 };
/** A capture larger than this is refused (a full 8K screen as PNG stays well below it). */
export const MAX_SCREENSHOT_BYTES = 40 * 1024 * 1024;

export type ShotOutcome =
  | { kind: 'captured'; attachment: Attachment; source: { kind: 'screen' | 'window'; name: string }; how: 'approved' | 'conversation' }
  | { kind: 'denied'; why: 'user' | 'timeout' | 'cancelled' | 'failed' | 'unavailable'; detail: string };

export interface ShotRequest {
  agentId: Id; agentRole: AgentRole; agentTitle: string;
  projectId: Id; projectName: string;
  /** Where the request and the image are shown (a helper's own conversation, or the lead's). */
  conversationId: Id;
  /** The user's session (the lead conversation): the scope of "allow this window for this conversation". */
  sessionId: Id;
  line: ScreenshotLine;
}

export interface ScreenshotDeps {
  /** Absent (tests without one, or a platform without capture): every request is refused with a note, nothing is asked. */
  capturer?: Capturer;
  /** Writes the PNG into the conversation's attachments folder and returns the attachment (with its harbor-file URL). */
  save(conversationId: Id, png: Buffer, name: string): Attachment;
  emit(e: PendingPermission): void;
  journal(e: { projectId: Id; conversationId: Id; agentId: Id; text: string }): void;
  /** Whether Harbor's window is visible now: a conversation shortcut never captures while Harbor is in the background. Default: yes. */
  foreground?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  timeoutMs?: number;
  rateMs?: number;
}

interface ShotAsk {
  req: ShotRequest;
  event: PendingPermission;
  deadline: number;
  /** Source ids (and their kind and name) this request's preview showed: only these may be captured. */
  previewed: Map<string, { kind: 'screen' | 'window'; name: string }>;
  capturing: boolean;
  settle(o: ShotOutcome): void;
  rearm(): void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const who = (r: ShotRequest) => (r.agentRole === 'main' ? 'The lead agent' : `Helper "${r.agentTitle}"`);
const minutesText = (ms: number) => { const n = Math.max(1, Math.round(ms / 60_000)); return `${n} minute${n === 1 ? '' : 's'}`; };

export class ScreenshotBroker {
  private asks = new Map<Id, ShotAsk>();
  /** Per session: the one window the user allowed for the rest of that conversation (in memory; a restart forgets it). */
  private grants = new Map<Id, { sourceId: string; name: string }>();
  private lastCapture = new Map<Id, number>();
  private working = 0;

  constructor(private d: ScreenshotDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }
  /** Whether anything can be captured at all (a capturer was given). */
  get available(): boolean { return !!this.d.capturer; }
  get timeoutMs(): number { return this.d.timeoutMs ?? SCREENSHOT_TIMEOUT_MS; }

  private log(r: ShotRequest, text: string): void {
    this.d.journal({ projectId: r.projectId, conversationId: r.sessionId, agentId: r.agentId, text: `${r.agentRole === 'main' ? 'lead' : `${r.agentRole} "${r.agentTitle}"`}: ${text}` });
  }

  /** The window allowed for this session, if any (for a system message or the renderer). */
  grantFor(sessionId: Id): { sourceId: string; name: string } | undefined { return this.grants.get(sessionId); }
  revokeGrant(sessionId: Id): void { this.grants.delete(sessionId); }

  /**
   * Ask the user for one capture, or (a window request, the window allowed for this conversation, Harbor in front, and no capture
   * by this agent in the last minute) capture that window at once. Resolves with what happened; never rejects.
   */
  async request(req: ShotRequest): Promise<ShotOutcome> {
    if (!this.d.capturer) return { kind: 'denied', why: 'unavailable', detail: 'screen capture is not available in this Harbor (it needs the desktop app)' };
    // One open request per agent: a newer one replaces the older (the agent only waits for its latest).
    for (const [id, a] of [...this.asks]) if (a.req.agentId === req.agentId) this.finish(id, { kind: 'denied', why: 'cancelled', detail: 'a newer screenshot request from the same agent replaced it' }, 'cancelled: replaced by a newer request');
    const recent = this.now() - (this.lastCapture.get(req.agentId) ?? -Infinity) < (this.d.rateMs ?? SCREENSHOT_RATE_MS);
    const grant = req.line.target === 'window' ? this.grants.get(req.sessionId) : undefined;
    if (grant && !recent && (this.d.foreground?.() ?? true)) {
      this.working++;
      try {
        const shot = await this.captureSource(req, grant.sourceId, { kind: 'window', name: grant.name }, 'conversation').catch(() => undefined);
        if (shot && shot.kind === 'captured') return shot;
      } finally { this.working--; }
      // The allowed window is gone (or failed): ask instead, and forget the shortcut.
      this.grants.delete(req.sessionId);
    }
    return this.ask(req, recent);
  }

  /** Requests being checked or captured right now (not those waiting for the user): work in flight for whenIdle. */
  active(): number { return this.working + [...this.asks.values()].filter((a) => a.capturing).length; }

  private ask(req: ShotRequest, recent: boolean): Promise<ShotOutcome> {
    const requestId = newId();
    const timeoutMs = this.timeoutMs;
    const target = req.line.target === 'screen' ? 'a screen' : req.line.title ? `the window "${req.line.title}"` : 'a window';
    const prompt = `${who(req)} asks for a screenshot of ${target}: ${req.line.why}`;
    return new Promise<ShotOutcome>((resolve) => {
      let cancelTimer = (): void => {};
      const deadline = this.now() + timeoutMs;
      const timedOut = (): void => { this.finish(requestId, { kind: 'denied', why: 'timeout', detail: `no answer within ${minutesText(timeoutMs)}` }, 'denied: no answer in time'); };
      const arm = (ms: number): void => { cancelTimer(); cancelTimer = (this.d.setTimer ?? defaultTimer)(timedOut, ms); };
      const event: PendingPermission = {
        type: 'permission', requestId, kind: 'screenshot', prompt, agentId: req.agentId, conversationId: req.conversationId, expiresAt: deadline,
        screenshot: { target: req.line.target, ...(req.line.title ? { title: req.line.title } : {}), why: req.line.why, agentRole: req.agentRole, agentTitle: req.agentTitle, projectId: req.projectId, projectName: req.projectName, ...(recent ? { recent: true } : {}) }
      };
      this.asks.set(requestId, {
        req, event, deadline, previewed: new Map(), capturing: false,
        settle: (o) => { cancelTimer(); resolve(o); },
        rearm: () => { const left = deadline - this.now(); if (left <= 0) timedOut(); else arm(left); }
      });
      arm(timeoutMs);
      this.log(req, `asked the user for a screenshot of ${req.line.target === 'screen' ? 'a screen' : 'a window'}`);
      this.d.emit(event);
    });
  }

  /** Live preview for a pending request: every source with a small thumbnail, or one source larger. Remembers what was shown. */
  async preview(requestId: Id, sourceId?: string): Promise<ScreenshotSource[]> {
    const a = this.asks.get(requestId);
    if (!a) throw new Error('This screenshot request is no longer pending.');
    if (sourceId !== undefined && (typeof sourceId !== 'string' || !sourceId || sourceId.length > 200)) throw new Error('Choose a window or screen from the list.');
    const all = await this.d.capturer!.list(sourceId ? DETAIL_SIZE : PREVIEW_SIZE);
    if (!this.asks.has(requestId)) throw new Error('This screenshot request is no longer pending.');
    const list = sourceId ? all.filter((s) => s.id === sourceId) : all;
    if (sourceId && !list.length) throw new Error('That window or screen is no longer available. Choose another one.');
    for (const s of list) a.previewed.set(s.id, { kind: s.kind, name: s.name });
    const want = a.req.line;
    const title = want.title?.toLowerCase();
    const firstScreen = list.find((s) => s.kind === 'screen')?.id;
    return list.map((s) => ({
      id: s.id, name: s.name, kind: s.kind, ...(s.thumbnail ? { thumbnail: s.thumbnail } : {}),
      ...((want.target === 'window' && title && s.kind === 'window' && s.name.toLowerCase().includes(title)) || (want.target === 'screen' && s.id === firstScreen) ? { suggested: true } : {})
    }));
  }

  /** The user's answer from the card. Allow needs a source this request's preview showed; the conversation shortcut is for windows only. */
  async answer(requestId: Id, ans: { allow: boolean; sourceId?: string; forConversation?: boolean }): Promise<void> {
    const a = this.asks.get(requestId);
    if (!a) throw new Error('This screenshot request is no longer pending.');
    if (a.capturing) throw new Error('Harbor is already capturing for this request.');
    if (ans.allow !== true) { this.finish(requestId, { kind: 'denied', why: 'user', detail: 'the user declined' }, 'denied by the user'); return; }
    const chosen = typeof ans.sourceId === 'string' ? a.previewed.get(ans.sourceId) : undefined;
    if (!chosen) throw new Error('Choose what to capture from the preview first: Harbor captures only a window or screen you have seen in this card.');
    if (ans.forConversation === true && chosen.kind !== 'window') throw new Error('"Allow for this conversation" is available for a window only, never for a whole screen.');
    a.capturing = true;
    let outcome: ShotOutcome;
    try { outcome = await this.captureSource(a.req, ans.sourceId!, chosen, 'approved'); }
    catch { outcome = { kind: 'denied', why: 'failed', detail: 'the capture failed' }; }
    if (!this.asks.has(requestId)) {
      // Stopped or timed out while capturing: that outcome stands; the image is not handed over and not kept.
      if (outcome.kind === 'captured' && outcome.attachment.path) { try { rmSync(outcome.attachment.path, { force: true }); } catch { /* best effort */ } }
      return;
    }
    if (outcome.kind === 'captured' && ans.forConversation === true) {
      this.grants.set(a.req.sessionId, { sourceId: ans.sourceId!, name: chosen.name });
      this.log(a.req, 'the user allowed this window for the rest of the conversation');
    }
    this.finish(requestId, outcome, outcome.kind === 'captured' ? undefined : 'capture failed');
  }

  private async captureSource(req: ShotRequest, sourceId: string, src: { kind: 'screen' | 'window'; name: string }, how: 'approved' | 'conversation'): Promise<ShotOutcome> {
    const png = await this.d.capturer!.capture(sourceId);
    if (!png || !png.length) return { kind: 'denied', why: 'failed', detail: `the ${src.kind} could not be captured (it may have been closed or minimised)` };
    if (png.length > MAX_SCREENSHOT_BYTES) return { kind: 'denied', why: 'failed', detail: 'the capture was too large' };
    const attachment = this.d.save(req.conversationId, png, src.kind === 'screen' ? 'screenshot-screen.png' : 'screenshot-window.png');
    this.lastCapture.set(req.agentId, this.now());
    this.log(req, `captured a ${src.kind} (${how === 'approved' ? 'approved by the user in the preview' : 'window allowed for this conversation'})`);
    return { kind: 'captured', attachment, source: src, how };
  }

  private finish(id: Id, o: ShotOutcome, journalText?: string): boolean {
    const a = this.asks.get(id);
    if (!a) return false;
    this.asks.delete(id);
    if (journalText) this.log(a.req, journalText);
    a.settle(o);
    return true;
  }

  /** Withdraws matching requests (the agent or conversation stopped, Harbor quits): denied, nothing captured. */
  cancel(match: (r: ShotRequest) => boolean, why: string): void {
    for (const [id, a] of [...this.asks]) if (match(a.req)) this.finish(id, { kind: 'denied', why: 'cancelled', detail: why }, `cancelled: ${why}`);
  }

  has(requestId: Id): boolean { return this.asks.has(requestId); }
  pending(): PendingPermission[] { return [...this.asks.values()].map((a) => a.event); }
  pendingFor(agentId: Id): boolean { return [...this.asks.values()].some((a) => a.req.agentId === agentId); }
  /** After sleep: re-arm each request for what is left of its deadline. */
  rearm(): void { for (const a of [...this.asks.values()]) a.rearm(); }
}
