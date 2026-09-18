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

export function createZipArchive(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(sanitizeEntryName(entry.name), "utf8");
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), "utf8");
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
