// DR Compass — minimal ZIP writer (STORE method, no compression).
//
// The DR Package is assembled in the browser, and the app ships no npm
// dependencies to the client, so this is a hand-rolled writer for the small
// slice of the PKZIP spec (APPNOTE 6.3.x) we need:
//   - local file headers + STORE (method 0) payloads
//   - a central directory + end-of-central-directory record
//   - CRC-32 (table-based), DOS date/time from "now"
//   - UTF-8 file names (general-purpose bit 11)
//
// Archives produced here open in macOS Archive Utility, `unzip`, Windows
// Explorer, and Python's zipfile. Zip64 is NOT implemented: entries and the
// archive must stay under 4 GiB (a DR package is a few MB at most).
//
// ISOMORPHIC: no DOM, no browser-only globals apart from Blob (used only when
// blob() is called) — so it can be unit-tested in plain Node.
//
//   import { createZip, crc32 } from './zip.js';
//   const z = createZip();
//   z.add('README.md', '# hi');
//   z.add('data/x.bin', someUint8Array);
//   const blob = z.blob();          // browser download
//   const bytes = z.bytes();        // Node / tests

// ---------------------------------------------------------------- CRC-32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3) of a byte array. "123456789" → 0xCBF43926. */
export function crc32(bytes) {
  const b = toBytes(bytes);
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ------------------------------------------------------------- conversion

const encoder = new TextEncoder();

/** string | ArrayBuffer | TypedArray | DataView | null → Uint8Array. */
export function toBytes(data) {
  if (data === null || data === undefined) return new Uint8Array(0);
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

// ---------------------------------------------------------------- helpers

// Normalize an entry path: forward slashes, no leading '/', no '.'/'..'
// segments, no empty segments. ZIP stores relative paths only.
function normalizePath(path) {
  const parts = String(path == null ? '' : path)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/');
}

// MS-DOS date/time (FAT): 2-second resolution, epoch 1980.
function dosDateTime(d) {
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01 00:00
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

// Little-endian writer over a fixed-size buffer.
function writer(size) {
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let off = 0;
  return {
    buf,
    u16(v) { view.setUint16(off, v & 0xFFFF, true); off += 2; return this; },
    u32(v) { view.setUint32(off, v >>> 0, true); off += 4; return this; },
    bytes(b) { buf.set(b, off); off += b.length; return this; },
  };
}

const SIG_LOCAL = 0x04034B50;
const SIG_CENTRAL = 0x02014B50;
const SIG_EOCD = 0x06054B50;
const FLAG_UTF8 = 0x0800;        // general purpose bit 11: names are UTF-8
const VERSION_NEEDED = 20;       // 2.0 — STORE/DEFLATE, folders
const VERSION_MADE_BY = 0x031E;  // UNIX (3) << 8 | 3.0
const EXTERNAL_FILE_ATTR = 0o100644 << 16 >>> 0; // regular file, rw-r--r--
const MAX = 0xFFFFFFFF;

// ------------------------------------------------------------------- API

/**
 * Create an in-memory ZIP builder.
 * @returns {{ add: (path: string, data?: any) => string,
 *             has: (path: string) => boolean,
 *             entries: () => Array<{path:string,bytes:number}>,
 *             totalBytes: () => number,
 *             bytes: () => Uint8Array,
 *             blob: () => Blob }}
 */
export function createZip({ date = new Date() } = {}) {
  const parts = [];      // Uint8Array chunks, in file order
  const central = [];    // central-directory records
  const used = new Set();
  const listed = [];
  let offset = 0;

  const push = (chunk) => { parts.push(chunk); offset += chunk.length; };

  // Two files with the same path make a confusing archive — de-duplicate by
  // suffixing the basename ("x.md" → "x-2.md") rather than silently clobbering.
  function uniquePath(path) {
    if (!used.has(path)) return path;
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash + 1);
    const base = slash < 0 ? path : path.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 2; i < 1000; i++) {
      const candidate = `${dir}${stem}-${i}${ext}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${dir}${stem}-${Date.now()}${ext}`;
  }

  function add(path, data) {
    const clean = uniquePath(normalizePath(path));
    if (!clean) throw new Error('zip.add: empty path');
    const body = toBytes(data);
    if (body.length > MAX) throw new Error(`zip.add: "${clean}" exceeds 4 GiB (zip64 not supported)`);
    const name = encoder.encode(clean);
    const { time, date: dosDate } = dosDateTime(date);
    const crc = crc32(body);
    const localOffset = offset;

    const local = writer(30 + name.length);
    local.u32(SIG_LOCAL).u16(VERSION_NEEDED).u16(FLAG_UTF8).u16(0)
      .u16(time).u16(dosDate)
      .u32(crc).u32(body.length).u32(body.length)
      .u16(name.length).u16(0).bytes(name);
    push(local.buf);
    if (body.length) push(body);

    const cd = writer(46 + name.length);
    cd.u32(SIG_CENTRAL).u16(VERSION_MADE_BY).u16(VERSION_NEEDED).u16(FLAG_UTF8).u16(0)
      .u16(time).u16(dosDate)
      .u32(crc).u32(body.length).u32(body.length)
      .u16(name.length).u16(0).u16(0)   // name / extra / comment lengths
      .u16(0).u16(0)                    // disk number start / internal attrs
      .u32(EXTERNAL_FILE_ATTR).u32(localOffset)
      .bytes(name);
    central.push(cd.buf);

    used.add(clean);
    listed.push({ path: clean, bytes: body.length });
    return clean;
  }

  function finish() {
    const cdOffset = offset;
    const chunks = parts.slice();
    let cdSize = 0;
    for (const c of central) { chunks.push(c); cdSize += c.length; }
    const eocd = writer(22);
    eocd.u32(SIG_EOCD).u16(0).u16(0)
      .u16(central.length).u16(central.length)
      .u32(cdSize).u32(cdOffset).u16(0);
    chunks.push(eocd.buf);
    return chunks;
  }

  return {
    add,
    has: (path) => used.has(normalizePath(path)),
    entries: () => listed.map((e) => ({ ...e })),
    totalBytes: () => offset,
    bytes() {
      const chunks = finish();
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      return out;
    },
    blob() {
      return new Blob(finish(), { type: 'application/zip' });
    },
  };
}

export default { createZip, crc32, toBytes };
