// Minimal dependency-free ZIP writer (store method, no compression — the
// payload is a handful of small text files). Enough of the spec for every
// unzip tool: local file headers + central directory + EOCD, CRC-32, UTF-8
// names. Timestamps are fixed so the same tabs always produce the same zip.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  bytes(b) {
    this.chunks.push(b);
    this.length += b.length;
  }
  u16(v) {
    this.bytes(new Uint8Array([v & 0xff, (v >> 8) & 0xff]));
  }
  u32(v) {
    this.bytes(new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]));
  }
  blob() {
    return new Blob(this.chunks, { type: 'application/zip' });
  }
}

// DOS date/time for 2026-01-01 00:00:00 — fixed for reproducible zips.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * entries: [{ name: string, text: string }] — names may contain '/'.
 * Returns a Blob ready for a download link.
 */
export function buildZip(entries) {
  const enc = new TextEncoder();
  const w = new ByteWriter();
  const central = [];

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = enc.encode(entry.text);
    const crc = crc32(data);
    const offset = w.length;

    w.u32(0x04034b50); // local file header
    w.u16(20);         // version needed
    w.u16(0x0800);     // flags: UTF-8 names
    w.u16(0);          // method: store
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(crc);
    w.u32(data.length);
    w.u32(data.length);
    w.u16(nameBytes.length);
    w.u16(0);          // extra len
    w.bytes(nameBytes);
    w.bytes(data);

    central.push({ nameBytes, data, crc, offset });
  }

  const centralStart = w.length;
  for (const e of central) {
    w.u32(0x02014b50); // central directory header
    w.u16(20);         // version made by
    w.u16(20);         // version needed
    w.u16(0x0800);
    w.u16(0);
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(e.crc);
    w.u32(e.data.length);
    w.u32(e.data.length);
    w.u16(e.nameBytes.length);
    w.u16(0); // extra
    w.u16(0); // comment
    w.u16(0); // disk
    w.u16(0); // internal attrs
    w.u32(0); // external attrs
    w.u32(e.offset);
    w.bytes(e.nameBytes);
  }
  const centralSize = w.length - centralStart;

  w.u32(0x06054b50); // end of central directory
  w.u16(0);
  w.u16(0);
  w.u16(central.length);
  w.u16(central.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0);

  return w.blob();
}
