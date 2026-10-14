import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A small, strict .zip reader for skill imports (plan section 3.4), built on Node's zlib so no archive dependency is needed.
 * It reads the central directory, refuses anything it does not fully understand, and never writes a file: the caller gets
 * names and bytes and decides. Refused: encryption, ZIP64, methods other than stored/deflate, symbolic links (Unix mode or a
 * Windows reparse-point attribute), absolute or drive paths, `..` segments, names Windows would alter or treat as devices,
 * names that differ only in case, too many entries, and anything over the size caps (declared sizes are checked before
 * inflating, and inflating is capped at the declared size, so a zip bomb stops early). Each file's CRC-32 must match.
 */

export interface ZipLimits { maxEntries: number; maxFileBytes: number; maxTotalBytes: number; maxArchiveBytes: number }
export interface ZipFile { path: string; data: Buffer; executable: boolean }
export class ZipRefused extends Error {}

const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
const S_IFMT = 0o170000, S_IFLNK = 0o120000, S_IFDIR = 0o040000;
const WIN_REPARSE = 0x400, WIN_DIRECTORY = 0x10;
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/** A relative archive path made safe, or the reason it is refused. Backslashes count as separators (Windows-made zips). */
export function checkArchivePath(raw: string): { path?: string; why?: string } {
  if (!raw || raw.includes('\0')) return { why: 'an empty or binary file name' };
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { why: `an absolute path (${raw})` };
  const segs = p.split('/');
  const dir = p.endsWith('/');
  const parts = dir ? segs.slice(0, -1) : segs;
  for (const s of parts) {
    if (s === '..') return { why: `a path that leaves the archive (${raw})` };
    if (s === '' || s === '.') return { why: `an irregular path (${raw})` };
    if (/[<>:"|?*\u0000-\u001f]/.test(s)) return { why: `a name Windows cannot store (${raw})` };
    if (/[. ]$/.test(s)) return { why: `a name ending in a dot or space (${raw})` };
    if (DEVICE.test(s)) return { why: `a reserved device name (${raw})` };
  }
  if (parts.length > 32 || p.length > 400) return { why: `a path that is too long (${raw.slice(0, 80)}...)` };
  return { path: parts.join('/') + (dir ? '/' : '') };
}

/** Reads every regular file of the archive into memory, or throws ZipRefused with the first reason found. */
export function readZip(buf: Buffer, limits: ZipLimits): ZipFile[] {
  if (buf.length > limits.maxArchiveBytes) throw new ZipRefused(`The archive is larger than ${fmtBytes(limits.maxArchiveBytes)}.`);
  // End of central directory: within the last 22 + 65535 bytes (the comment may be up to 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new ZipRefused('This is not a .zip archive (no central directory).');
  const disk = buf.readUInt16LE(eocd + 4), cdDisk = buf.readUInt16LE(eocd + 6);
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipRefused('ZIP64 archives are not supported.');
  if (disk !== 0 || cdDisk !== 0) throw new ZipRefused('Multi-part archives are not supported.');
  if (count > limits.maxEntries) throw new ZipRefused(`The archive holds ${count} entries; at most ${limits.maxEntries} are allowed.`);
  if (cdOffset + cdSize > eocd) throw new ZipRefused('The archive is damaged (central directory out of range).');

  const out: ZipFile[] = [];
  const seen = new Set<string>();
  let total = 0, pos = cdOffset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CEN) throw new ZipRefused('The archive is damaged (bad central directory entry).');
    const madeBy = buf.readUInt16LE(pos + 4) >> 8;
    const flags = buf.readUInt16LE(pos + 8), method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16), csize = buf.readUInt32LE(pos + 20), usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), commentLen = buf.readUInt16LE(pos + 32);
    const ext = buf.readUInt32LE(pos + 38), local = buf.readUInt32LE(pos + 42);
    const nameBuf = buf.subarray(pos + 46, pos + 46 + nameLen);
    const name = (flags & 0x800) ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
    pos += 46 + nameLen + extraLen + commentLen;

    const checked = checkArchivePath(name);
    if (!checked.path) throw new ZipRefused(`The archive contains ${checked.why}.`);
    const unixMode = madeBy === 3 ? ext >>> 16 : 0;
    if ((unixMode & S_IFMT) === S_IFLNK || (ext & WIN_REPARSE)) throw new ZipRefused(`The archive contains a symbolic link (${name}); links are not imported.`);
    if (flags & 0x1) throw new ZipRefused(`The archive is encrypted (${name}).`);
    const isDir = checked.path.endsWith('/') || (unixMode & S_IFMT) === S_IFDIR || (madeBy === 0 && (ext & WIN_DIRECTORY) !== 0);
    if (isDir) continue;
    if (csize === 0xffffffff || usize === 0xffffffff) throw new ZipRefused('ZIP64 archives are not supported.');
    const key = checked.path.toLowerCase();
    if (seen.has(key)) throw new ZipRefused(`The archive contains two files named ${checked.path} (names differ only in case or repeat).`);
    seen.add(key);
    if (usize > limits.maxFileBytes) throw new ZipRefused(`${checked.path} is larger than ${fmtBytes(limits.maxFileBytes)}.`);
    total += usize;
    if (total > limits.maxTotalBytes) throw new ZipRefused(`The files add up to more than ${fmtBytes(limits.maxTotalBytes)}.`);
    if (method !== 0 && method !== 8) throw new ZipRefused(`${checked.path} uses a compression method Harbor does not read (${method}).`);

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== SIG_LOC) throw new ZipRefused('The archive is damaged (bad local header).');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw new ZipRefused('The archive is damaged (file data out of range).');
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) });
    } catch { throw new ZipRefused(`${checked.path} could not be decompressed, or is larger than it claims.`); }
    if (data.length !== usize) throw new ZipRefused(`${checked.path} is not the size the archive claims.`);
    if ((crc32(data) >>> 0) !== crc) throw new ZipRefused(`${checked.path} is damaged (checksum mismatch).`);
    out.push({ path: checked.path, data, executable: (unixMode & 0o111) !== 0 });
  }
  return out;
}

export const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) ? 1 : 0)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
