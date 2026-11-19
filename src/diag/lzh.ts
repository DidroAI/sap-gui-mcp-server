/**
 * SAP's LZH compression, as DIAG and RFC tables use it.
 *
 * A compressed block is an 8-byte header and a bit stream:
 *
 *   bytes 0-3  length of the data once decompressed (little-endian)
 *   byte  4    algorithm: low nibble 2 = LZH (1 = LZC, not handled), high nibble = version
 *   bytes 5-6  magic 1f 9d
 *   byte  7    "special" byte (compression level, window size)
 *
 * The bit stream is a deflate stream (RFC 1951) with a short prefix. Bits are
 * read as deflate reads them, lowest bit of each byte first: the first two
 * bits are a number n (0 to 3), the next n bits are padding without meaning,
 * and the deflate blocks start right after. Real traffic uses all four
 * values of n. Nothing is byte-aligned after the prefix: the stream is
 * shifted down by 2 + n bits and given to zlib. The window is 16 KB: SAP's
 * decompressor refuses a match further back, so the compressor here keeps
 * to it.
 */
import { constants, deflateRawSync, inflateRawSync } from "node:zlib";

export const LZH_HEADER = 8;
/**
 * The largest block decompressed: the header's length is not trusted beyond
 * it (a garbled header could ask for 4 GB). A DIAG message or an RFC table
 * block is far smaller.
 */
export const MAX_LZH_OUTPUT = 64 << 20;

export class LzhError extends Error {}

/** Does this look like the header of a compressed block? */
export function isLzh(block: Uint8Array): boolean {
  return block.length >= LZH_HEADER && block[5] === 0x1f && block[6] === 0x9d && ((block[4] ?? 0) & 0x0f) === 2;
}

/** The bits of `data` from bit `skip` on (lowest bit of each byte first), as bytes. */
function shiftDown(data: Uint8Array, skip: number): Buffer {
  const bytes = skip >> 3;
  const bits = skip & 7;
  const out = Buffer.alloc(Math.max(0, data.length - bytes));
  for (let i = 0; i < out.length; i++) out[i] = (((data[i + bytes] ?? 0) >> bits) | ((data[i + bytes + 1] ?? 0) << (8 - bits))) & 0xff;
  return out;
}

/** Decompresses one block (header and bit stream). Throws LzhError when it is not LZH or does not inflate. */
export function lzhDecompress(block: Uint8Array): Buffer {
  if (block.length < LZH_HEADER) throw new LzhError("compressed block shorter than its header");
  const view = Buffer.from(block.buffer, block.byteOffset, block.length);
  const length = view.readUInt32LE(0);
  if (view[5] !== 0x1f || view[6] !== 0x9d) throw new LzhError("no compression magic");
  if (((view[4] ?? 0) & 0x0f) !== 2) throw new LzhError(`compression algorithm ${(view[4] ?? 0) & 0x0f} is not LZH`);
  if (length === 0) return Buffer.alloc(0);
  if (length > MAX_LZH_OUTPUT) throw new LzhError(`compressed block of ${length} bytes once decompressed, more than the ${MAX_LZH_OUTPUT >> 20} MB this reader accepts: not read`);
  const padding = (view[LZH_HEADER] ?? 0) & 3;
  let out: Buffer;
  try {
    // SYNC_FLUSH: a stream cut short gives what it has instead of an error.
    out = inflateRawSync(shiftDown(view.subarray(LZH_HEADER), 2 + padding), { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: Math.max(length, 1) });
  } catch (e) {
    throw new LzhError(`LZH stream does not inflate: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out.length !== length) throw new LzhError(`LZH stream gave ${out.length} bytes, header says ${length}`);
  return out;
}

/**
 * Compresses into a block SAP's decompressor accepts. Used to build test
 * fixtures and by anything that has to answer in DIAG; `padding` (0 to 3)
 * is the number of meaningless bits after the two-bit prefix (written as
 * zeros).
 */
export function lzhCompress(data: Uint8Array, padding = 0): Buffer {
  const deflated = deflateRawSync(data, { windowBits: 14 });
  const skip = 2 + (padding & 3);
  const out = Buffer.alloc(LZH_HEADER + deflated.length + 1);
  out.writeUInt32LE(data.length, 0);
  out[4] = 0x12;
  out[5] = 0x1f;
  out[6] = 0x9d;
  out[7] = 0x02;
  out[LZH_HEADER] = padding & 3;
  for (let i = 0; i < deflated.length; i++) {
    const b = deflated[i] ?? 0;
    out[LZH_HEADER + i] = ((out[LZH_HEADER + i] ?? 0) | (b << skip)) & 0xff;
    out[LZH_HEADER + i + 1] = b >> (8 - skip);
  }
  return out;
}
