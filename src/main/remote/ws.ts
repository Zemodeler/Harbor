import { createHash, randomBytes } from 'node:crypto';

/**
 * Just enough RFC 6455 for a one-way event stream: the server sends text frames; a client only ever sends control frames
 * (close, ping, pong). Hand-written instead of a dependency because the surface is that small, and refusing everything else
 * (data frames from the client, fragments, extensions, large frames) keeps the parser small.
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const acceptKey = (key: string): string => createHash('sha1').update(key + GUID).digest('base64');
/** A Sec-WebSocket-Key is 16 random bytes in base64. */
export const isValidKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key);
export const newKey = (): string => randomBytes(16).toString('base64');

export const OP = { text: 0x1, close: 0x8, ping: 0x9, pong: 0xa } as const;

export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | opcode];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 0xff);
  else {
    head.push(m | 127, 0, 0, 0, 0);
    head.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ key[i & 3]!;
  return Buffer.concat([Buffer.from(head), key, body]);
}

export interface Frame { opcode: number; payload: Buffer }

/**
 * Incremental decoder. `requireMask` = the server side (client frames must be masked); `maxPayload` bounds what is buffered.
 * Throws on anything outside the subset above; the caller then drops the connection.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private requireMask: boolean, private maxPayload: number, private allowData: boolean) {}

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    for (;;) {
      // No overall buffer cap is needed: what stays buffered is one incomplete frame whose length was checked below.
      if (this.buf.length < 2) return out;
      const b0 = this.buf[0]!, b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      if ((b0 & 0x70) !== 0) throw new Error('reserved bits set');
      if (!fin) throw new Error('fragmented frames are not accepted');
      const control = opcode === OP.close || opcode === OP.ping || opcode === OP.pong;
      if (!control && !(this.allowData && opcode === OP.text)) throw new Error('unexpected opcode');
      if (masked !== this.requireMask) throw new Error(this.requireMask ? 'client frames must be masked' : 'server frames must not be masked');
      let len = b1 & 0x7f, off = 2;
      if (control && len > 125) throw new Error('control frame too large');
      if (len === 126) { if (this.buf.length < 4) return out; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return out;
        if (this.buf.readUInt32BE(2) !== 0) throw new Error('frame too large');
        len = this.buf.readUInt32BE(6); off = 10;
      }
      if (len > this.maxPayload) throw new Error('frame too large');
      const keyLen = masked ? 4 : 0;
      if (this.buf.length < off + keyLen + len) return out;
      const key = masked ? this.buf.subarray(off, off + 4) : undefined;
      const payload = Buffer.from(this.buf.subarray(off + keyLen, off + keyLen + len));
      if (key) for (let i = 0; i < len; i++) payload[i] = payload[i]! ^ key[i & 3]!;
      out.push({ opcode, payload });
      this.buf = this.buf.subarray(off + keyLen + len);
    }
  }
}
