import { crc32 } from "node:zlib";
import { deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer.
 *
 * This package carries no third-party dependencies on purpose, and archiving
 * an artifact set is not a good reason to take on a supply-chain risk. The
 * format written here is the widely-supported subset: local file headers,
 * deflate or stored entries, and a central directory. No ZIP64, so the
 * caller must keep archives under 4 GiB — which the tool bounds anyway.
 */
const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;

/**
 * The header fields these limits come from are 16 and 32 bits wide, and
 * without ZIP64 there is nowhere else to put a larger value. Node throws
 * ERR_OUT_OF_RANGE when one overflows, which is at least not silent, but it
 * names a byte offset rather than the entry that could not be written. These
 * checks fail in the same places with something an operator can act on.
 */
const MAX_NAME_BYTES = 0xffff;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

export function createZipArchive(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const list = [...entries];
  if (list.length > MAX_ENTRIES) {
    throw new Error(`An archive can hold ${MAX_ENTRIES} entries without ZIP64, and this one has ${list.length}.`);
  }

  for (const entry of list) {
    const name = Buffer.from(sanitizeEntryName(entry.name), "utf8");
    if (name.length > MAX_NAME_BYTES) {
      // Measured in bytes, not characters: a name well under the limit in
      // characters can exceed it once it is UTF-8.
      throw new Error(`Archive entry name is ${name.length} bytes, over the ${MAX_NAME_BYTES}-byte limit: ${String(entry.name).slice(0, 80)}...`);
    }
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), "utf8");
    if (raw.length > MAX_SIZE) {
      throw new Error(`Archive entry '${name.toString("utf8")}' is ${raw.length} bytes, over the 4 GiB this writer supports without ZIP64.`);
    }
    const deflated = deflateRawSync(raw);
    // Storing is smaller than deflating for incompressible input; pick whichever wins.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIGNATURE_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, body);
    central.push({ name, method, checksum, compressedSize: body.length, size: raw.length, offset });
    offset += local.length + name.length + body.length;
  }

  // Checked before the central directory is written rather than after: every
  // record in it carries a 32-bit offset, so the first overflow happens
  // there, not at the end record.
  if (offset > MAX_SIZE) {
    throw new Error(`The archive is ${offset} bytes, over the 4 GiB this writer supports without ZIP64.`);
  }
  const directoryStart = offset;
  for (const record of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIGNATURE_CENTRAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(record.method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(record.checksum, 16);
    header.writeUInt32LE(record.compressedSize, 20);
    header.writeUInt32LE(record.size, 24);
    header.writeUInt16LE(record.name.length, 28);
    header.writeUInt32LE(record.offset, 42);
    chunks.push(header, record.name);
    offset += header.length + record.name.length;
  }

  if (offset > MAX_SIZE) {
    throw new Error(`The archive is ${offset} bytes, over the 4 GiB this writer supports without ZIP64.`);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIGNATURE_END, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  chunks.push(end);

  return Buffer.concat(chunks);
}

/**
 * An archive entry name is a path that some other program will later extract.
 * An absolute path or a `..` segment in it is a zip-slip write outside the
 * extraction directory, so those are removed here rather than trusted.
 */
export function sanitizeEntryName(name) {
  const normalized = String(name).replaceAll("\\", "/");
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== "." && part !== "..");
  if (parts.length === 0) throw new Error(`Archive entry name is not usable: ${name}`);
  return parts.join("/");
}
