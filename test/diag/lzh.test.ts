import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { isLzh, LzhError, lzhCompress, lzhDecompress } from "../../src/diag/lzh.js";

const TEXT = Buffer.from("Synthetic order ZT01, item 10, widget WIDGET-1. ".repeat(40));

describe("SAP LZH", () => {
  test("round trip, with every number of padding bits", () => {
    for (const padding of [0, 1, 2, 3]) {
      const block = lzhCompress(TEXT, padding);
      expect((block[8] ?? 0) & 3).toBe(padding);
      expect(lzhDecompress(block).equals(TEXT)).toBe(true);
    }
  });

  test("the header: length, algorithm, magic", () => {
    const block = lzhCompress(TEXT);
    expect(block.readUInt32LE(0)).toBe(TEXT.length);
    expect(block[4]).toBe(0x12);
    expect([block[5], block[6]]).toEqual([0x1f, 0x9d]);
    expect(isLzh(block)).toBe(true);
    expect(isLzh(TEXT)).toBe(false);
  });

  test("the stream is deflate behind a two-bit count and that many padding bits", () => {
    // Built by hand: two prefix bits "10" (n = 1, lowest bit first), one padding bit set, then the deflate bits.
    const deflated = deflateRawSync(TEXT, { windowBits: 14 });
    const bits: number[] = [1, 0, 1];
    for (const byte of deflated) for (let i = 0; i < 8; i++) bits.push((byte >> i) & 1);
    const stream = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((bit, i) => {
      stream[i >> 3] = (stream[i >> 3] ?? 0) | (bit << (i & 7));
    });
    const head = Buffer.from([0, 0, 0, 0, 0x12, 0x1f, 0x9d, 0x02]);
    head.writeUInt32LE(TEXT.length, 0);
    expect(lzhDecompress(Buffer.concat([head, stream])).equals(TEXT)).toBe(true);
  });

  test("empty data, binary data, data larger than the 16 KB window", () => {
    expect(lzhDecompress(lzhCompress(Buffer.alloc(0))).length).toBe(0);
    const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 73 + (i >> 3)) & 0xff));
    expect(lzhDecompress(lzhCompress(binary, 2)).equals(binary)).toBe(true);
    const large = Buffer.concat([binary, Buffer.alloc(30000, 7), binary]);
    expect(lzhDecompress(lzhCompress(large)).equals(large)).toBe(true);
  });

  test("what is not LZH, or is cut, is an LzhError", () => {
    expect(() => lzhDecompress(Buffer.from([1, 2, 3]))).toThrow(LzhError);
    expect(() => lzhDecompress(Buffer.from("no magic bytes here at all"))).toThrow(LzhError);
    const lzc = lzhCompress(TEXT);
    lzc[4] = 0x11;
    expect(() => lzhDecompress(lzc)).toThrow(/not LZH/);
    const cut = lzhCompress(TEXT).subarray(0, 30);
    expect(() => lzhDecompress(cut)).toThrow(LzhError);
  });
});
