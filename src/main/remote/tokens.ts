import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Id, RemoteScope, RemoteTokenInfo } from '../../shared/api';

export const REMOTE_SCOPES: readonly RemoteScope[] = ['read-only', 'answer-permissions', 'full'];
/** Every token starts with this, so logs and diagnostics can redact it (logger.ts) and users can recognise one. */
export const TOKEN_PREFIX = 'hbt_';
const MAX_TOKENS = 50;

interface StoredToken extends RemoteTokenInfo { hash: string }

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * Per-device bearer tokens for the remote API. Only a SHA-256 of each token is kept: a token is 32 random bytes, so a slow
 * hash adds nothing, and a copy of the file cannot be replayed. The clear token exists only in the createToken result.
 */
export class RemoteTokens {
  private tokens: StoredToken[] = [];
  private listeners = new Set<(id: Id) => void>();

  /** `file` undefined = in memory only (tests). */
  constructor(private file?: string, private now: () => number = Date.now) {
    if (file && existsSync(file)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const list = Array.isArray((raw as { tokens?: unknown })?.tokens) ? (raw as { tokens: unknown[] }).tokens : [];
        this.tokens = list.filter(isStored);
      } catch { this.tokens = []; } // unreadable file: no token works, which fails closed
    }
  }

  create(name: string, scope: RemoteScope): { token: string; info: RemoteTokenInfo } {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean || clean.length > 80 || /[\0-\x1f]/.test(clean)) throw new Error('Name the device in 1 to 80 characters.');
    if (!REMOTE_SCOPES.includes(scope)) throw new Error(`Scope must be one of: ${REMOTE_SCOPES.join(', ')}.`);
    if (this.tokens.length >= MAX_TOKENS) throw new Error(`At most ${MAX_TOKENS} remote tokens; revoke one first.`);
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const info: RemoteTokenInfo = { id: randomBytes(8).toString('hex'), name: clean, scope, created: this.now() };
    this.tokens.push({ ...info, hash: sha256(token).toString('hex') });
    this.save();
    return { token, info };
  }

  list(): RemoteTokenInfo[] { return this.tokens.map(({ hash: _h, ...info }) => info); }

  revoke(id: Id): void {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length === before) return;
    this.save();
    for (const l of this.listeners) l(id);
  }

  has(id: Id): boolean { return this.tokens.some((t) => t.id === id); }

  /** Called with the id of every revoked token (the server closes its connections). */
  onRevoke(cb: (id: Id) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }

  /**
   * The token's info, or undefined. Every stored hash is compared in constant time and the loop never exits early, so the
   * time taken does not tell how close a guess was or which entry matched.
   */
  verify(token: unknown): RemoteTokenInfo | undefined {
    if (typeof token !== 'string' || token.length > 200) return undefined;
    const h = sha256(token);
    let found: StoredToken | undefined;
    for (const t of this.tokens) {
      const stored = Buffer.from(t.hash, 'hex');
      if (stored.length === h.length && timingSafeEqual(stored, h) && !found) found = t;
    }
    if (!found) return undefined;
    found.lastUsed = this.now();
    this.saveSoon();
    const { hash: _h, ...info } = found;
    return info;
  }

  private timer: ReturnType<typeof setTimeout> | undefined;
  /** lastUsed changes on every request; write it at most every few seconds. */
  private saveSoon(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.save(); }, 5_000);
    this.timer.unref?.();
  }

  /** Writes a pending lastUsed update now (quitting). */
  flush(): void { if (!this.timer) return; clearTimeout(this.timer); this.timer = undefined; this.save(); }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // mode only matters off Windows; on Windows the data folder under the user's profile is already user-only.
    writeFileSync(tmp, JSON.stringify({ v: 1, tokens: this.tokens }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function isStored(v: unknown): v is StoredToken {
  const t = v as Partial<StoredToken> | null;
  return !!t && typeof t.id === 'string' && typeof t.name === 'string' && REMOTE_SCOPES.includes(t.scope as RemoteScope)
    && typeof t.created === 'number' && typeof t.hash === 'string' && /^[0-9a-f]{64}$/.test(t.hash);
}
