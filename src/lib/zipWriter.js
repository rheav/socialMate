// A minimal, dependency-free ZIP writer. STORE only (method 0 — no compression).
//
// WHY hand-rolled: the extension ships no zip library, and pulling one in for
// this would add a dependency to a bundle that already carries onnxruntime and
// ffmpeg-wasm. WHY STORE and not DEFLATE: the payload is JPEG/PNG, which is
// already entropy-coded — deflating it costs CPU and typically SAVES under 1%.
// STORE also means every byte we write is a byte we already have, so an archive
// can be assembled incrementally without buffering a compressor's state.
//
// WHY the UTF-8 flag (general-purpose bit 11, 0x0800) is set on EVERY record:
// without it the spec says filenames are IBM Code Page 437, and Windows Explorer
// obeys that literally — "fb-Astra-Valé-123.jpg" arrives as "fb-Astra-ValÃ©".
// Brazilian display names are full of accents, so this is not optional here.
//
// NOT implemented: compression, encryption, data descriptors, and ZIP64. Without
// ZIP64 the format itself cannot express more than 65535 entries or offsets past
// 4 GiB, so add() throws rather than emitting an archive that silently truncates.

const ENC = new TextEncoder();

// CRC-32/ISO-HDLC — the reflected polynomial 0xedb88320, which is what PKZIP uses.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// `seed` lets a CRC be continued across chunks: crc32(b, crc32(a)) equals
// crc32(concat(a, b)), because the running register is the bitwise complement of
// the value this returns.
export function crc32(bytes, seed = 0) {
  let c = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return ~c >>> 0;
}

// MS-DOS packed date/time (the only timestamp a base ZIP record has room for).
// It has 2-second resolution and no room at all for years before 1980, so those
// clamp to 1980-01-01 00:00:00. A missing or invalid date means "now".
export function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

export const ZIP_SIG_LOCAL = 0x04034b50;
export const ZIP_SIG_CENTRAL = 0x02014b50;
export const ZIP_SIG_EOCD = 0x06054b50;
export const ZIP_FLAG_UTF8 = 0x0800;
export const ZIP_METHOD_STORE = 0;
export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

// Incremental builder. Each add() appends two chunks (local header, then the file
// bytes verbatim) to a parts array; nothing is concatenated until the caller asks
// for it. finish() returns the parts array, which the panel hands straight to
// `new Blob(parts)` — Chrome can spill a Blob to disk, whereas materialising one
// giant Uint8Array would pin the whole archive in the renderer's heap twice.
export class ZipBuilder {
  constructor({ date } = {}) {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
    this.stamp = dosDateTime(date);
  }

  get count() {
    return this.entries.length;
  }

  // Bytes written so far (file data + local headers). The central directory adds
  // ~46 bytes per entry on top, which finish() accounts for.
  get byteLength() {
    return this.offset;
  }

  add(name, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    if (this.entries.length >= ZIP_MAX_ENTRIES) throw new Error("ZIP cheio: máximo de 65535 arquivos");
    if (this.offset + data.length > ZIP_MAX_BYTES) throw new Error("ZIP cheio: máximo de 4 GB");

    const nameBytes = ENC.encode(String(name));
    const crc = crc32(data);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, ZIP_SIG_LOCAL, true);
    v.setUint16(4, 20, true); // version needed to extract: 2.0
    v.setUint16(6, ZIP_FLAG_UTF8, true);
    v.setUint16(8, ZIP_METHOD_STORE, true);
    v.setUint16(10, this.stamp.time, true);
    v.setUint16(12, this.stamp.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true); // compressed size == uncompressed (STORE)
    v.setUint32(22, data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true); // no extra field
    header.set(nameBytes, 30);

    this.entries.push({ nameBytes, crc, size: data.length, offset: this.offset });
    this.parts.push(header, data);
    this.offset += header.length + data.length;
    return this;
  }

  finish() {
    const cdOffset = this.offset;
    const chunks = [];
    let cdSize = 0;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.nameBytes.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, ZIP_SIG_CENTRAL, true);
      v.setUint16(4, 20, true); // version made by: 2.0, MS-DOS
      v.setUint16(6, 20, true); // version needed to extract
      v.setUint16(8, ZIP_FLAG_UTF8, true);
      v.setUint16(10, ZIP_METHOD_STORE, true);
      v.setUint16(12, this.stamp.time, true);
      v.setUint16(14, this.stamp.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.nameBytes.length, true);
      v.setUint16(30, 0, true); // extra length
      v.setUint16(32, 0, true); // comment length
      v.setUint16(34, 0, true); // disk number start
      v.setUint16(36, 0, true); // internal attributes
      v.setUint32(38, 0, true); // external attributes
      v.setUint32(42, e.offset, true);
      rec.set(e.nameBytes, 46);
      chunks.push(rec);
      cdSize += rec.length;
    }

    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, ZIP_SIG_EOCD, true);
    v.setUint16(4, 0, true); // this disk
    v.setUint16(6, 0, true); // disk with the central directory
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, cdOffset, true);
    v.setUint16(20, 0, true); // no archive comment

    return [...this.parts, ...chunks, eocd];
  }
}

export function concatParts(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Convenience for callers (and tests) that want the whole archive in one buffer.
// `entries` is [{ name, data }].
export function buildZip(entries, opts) {
  const zip = new ZipBuilder(opts);
  for (const e of entries || []) zip.add(e.name, e.data);
  return concatParts(zip.finish());
}
