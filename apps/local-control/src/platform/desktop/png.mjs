import { deflateSync } from "node:zlib";

/**
 * Minimal PNG encoding so every desktop driver hands the session the same
 * image format (the companion's DesktopSession stores evidence as .png).
 * Truecolor RGB, 8 bits per channel, filter 0 on every row.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {Buffer} rgb width*height*3 bytes, row-major */
export function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Parses an XWD header (big-endian) far enough to decode a TrueColor ZPixmap. */
export function parseXwdHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) return null;
  const f = (i) => buffer.readUInt32BE(i * 4);
  const headerSize = f(0);
  if (f(1) !== 7 || headerSize < 100 || headerSize > buffer.length) return null;
  return {
    headerSize, pixmapFormat: f(2), depth: f(3), width: f(4), height: f(5), byteOrder: f(7), bitsPerPixel: f(11), bytesPerLine: f(12),
    redMask: f(14), greenMask: f(15), blueMask: f(16), ncolors: f(19),
  };
}

function shiftOf(mask) {
  let shift = 0;
  while (mask && !(mask & 1)) { mask >>>= 1; shift += 1; }
  return shift;
}

/** Converts a 24/32-bpp TrueColor XWD (what Xvfb's -fbdir framebuffer is) into PNG. */
export function xwdToPng(buffer) {
  const h = parseXwdHeader(buffer);
  if (!h || h.pixmapFormat !== 2 || (h.bitsPerPixel !== 32 && h.bitsPerPixel !== 24)) return null;
  const offset = h.headerSize + h.ncolors * 12;
  if (offset + h.bytesPerLine * h.height > buffer.length) return null;
  const rgb = Buffer.alloc(h.width * h.height * 3);
  const bytes = h.bitsPerPixel / 8;
  const [rs, gs, bs] = [shiftOf(h.redMask), shiftOf(h.greenMask), shiftOf(h.blueMask)];
  for (let y = 0; y < h.height; y += 1) {
    for (let x = 0; x < h.width; x += 1) {
      const at = offset + y * h.bytesPerLine + x * bytes;
      let p = 0;
      if (h.byteOrder === 0) for (let i = bytes - 1; i >= 0; i -= 1) p = p * 256 + buffer[at + i];
      else for (let i = 0; i < bytes; i += 1) p = p * 256 + buffer[at + i];
      const o = (y * h.width + x) * 3;
      rgb[o] = (p & h.redMask) >>> rs;
      rgb[o + 1] = (p & h.greenMask) >>> gs;
      rgb[o + 2] = (p & h.blueMask) >>> bs;
    }
  }
  return encodePng(h.width, h.height, rgb);
}
