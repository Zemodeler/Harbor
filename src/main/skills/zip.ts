import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

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

/**
 * Reads every regular file of the archive into memory, or throws ZipRefused with the first reason found. With `only`, entries it
 * rejects are still checked (path, link, encryption) but neither read nor counted against the size caps: an account export holds
 * one wanted file beside many images.
 */
export function readZip(buf: Buffer, limits: ZipLimits, opts: { only?: (path: string) => boolean } = {}): ZipFile[] {
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
    if (opts.only && !opts.only(checked.path)) continue;
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

/**
 * Writes a plain .zip that readZip accepts: UTF-8 names (checked like on reading), deflate when it helps, stored otherwise, no
 * ZIP64 (Harbor's own bundles stay far below 4 GB and 65535 entries), no links, no permissions, no extra fields.
 */
export function writeZip(files: Array<{ path: string; data: Buffer }>, time = new Date()): Buffer {
  if (files.length >= 0xffff) throw new Error('Too many files for one archive.');
  const dosTime = (time.getHours() << 11) | (time.getMinutes() << 5) | Math.floor(time.getSeconds() / 2);
  const dosDate = ((Math.max(1980, time.getFullYear()) - 1980) << 9) | ((time.getMonth() + 1) << 5) | time.getDate();
  const locals: Buffer[] = [], central: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const f of files) {
    const checked = checkArchivePath(f.path);
    if (!checked.path || checked.path.endsWith('/')) throw new Error(`Refused archive path ${f.path}: ${checked.why ?? 'a folder'}.`);
    if (seen.has(checked.path.toLowerCase())) throw new Error(`Two files named ${checked.path}.`);
    seen.add(checked.path.toLowerCase());
    const name = Buffer.from(checked.path, 'utf8');
    const deflated = deflateRawSync(f.data);
    const method = deflated.length < f.data.length ? 8 : 0;
    const body = method === 8 ? deflated : f.data;
    const crc = crc32(f.data) >>> 0;
    if (offset + body.length > 0xfffffff0) throw new Error('The archive would be larger than 4 GB.');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(SIG_LOC, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x800, 6); loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(dosTime, 10); loc.writeUInt16LE(dosDate, 12); loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18); loc.writeUInt32LE(f.data.length, 22); loc.writeUInt16LE(name.length, 26); loc.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    central.push(cen, name);
    offset += loc.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export const fmtBytes =(n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) ? 1 : 0)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
