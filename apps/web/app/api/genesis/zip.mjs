// A small, dependency-free ZIP writer for the hosted website export.
// STORE method only (no compression), correct CRC-32, UTF-8 names, and a fixed
// DOS timestamp so the same files always produce the same bytes. Pure: it runs
// in the Worker and in Node and touches no file system.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of a byte array. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00, the earliest DOS time: reproducible archives.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
const encoder = new TextEncoder();

/** Names must be relative, forward-slash, with no traversal, control characters or duplicates. */
function checkName(name, seen) {
  if (typeof name !== "string" || name === "" || name.length > 500) throw new TypeError("Invalid ZIP entry name.");
  if (name.startsWith("/") || name.endsWith("/") || name.includes("\\") || /[\u0000-\u001f\u007f]/u.test(name)) throw new TypeError(`Unsafe ZIP entry name: ${name}`);
  if (name.split("/").some((part) => part === "" || part === "." || part === "..")) throw new TypeError(`Unsafe ZIP entry name: ${name}`);
  if (seen.has(name)) throw new TypeError(`Duplicate ZIP entry name: ${name}`);
  seen.add(name);
}

/**
 * @param {{ name: string, data: string | Uint8Array }[]} entries  written in the order given
 * @returns {Uint8Array}
 */
export function writeZip(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new TypeError("Too many ZIP entries.");
  const seen = new Set();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    checkName(entry.name, seen);
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    if (!(data instanceof Uint8Array)) throw new TypeError("ZIP entry data must be a string or Uint8Array.");
    if (data.length > MAX_BYTES || offset > MAX_BYTES) throw new RangeError("ZIP64 is not supported; the archive is too large.");
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, 0, true); // STORE
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // version made by
    header.setUint16(6, 20, true);
    header.setUint16(8, UTF8_FLAG, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, DOS_TIME, true);
    header.setUint16(14, DOS_DATE, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.length, true);
    header.setUint32(24, data.length, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);
    parts.push(new Uint8Array(local.buffer), name, data);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize > MAX_BYTES) throw new RangeError("ZIP64 is not supported; the archive is too large.");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
}
