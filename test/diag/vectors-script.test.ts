import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lzhCompress } from "../../src/diag/lzh.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/diag-dev/vectors.ts", import.meta.url));

/** A made-up vectors folder: one compressed block, one message of two items. */
function folder(expectedSid: number): string {
  const dir = mkdtempSync(join(tmpdir(), "diag-vectors-"));
  for (const d of ["lzh", "frames", "diag", "synthetic"]) mkdirSync(join(dir, d));
  const plain = Buffer.from("Order 4711 ".repeat(40));
  writeFileSync(join(dir, "lzh", "000.in.bin"), lzhCompress(plain, 1));
  writeFileSync(join(dir, "lzh", "000.out.bin"), plain);
  // an LZC block (algorithm 1 in the header): counted, not checked
  writeFileSync(join(dir, "synthetic", "x.in.bin"), plain);
  writeFileSync(join(dir, "synthetic", "x.lzc.bin"), Buffer.from("000001b8111f9d8d00", "hex"));
  // DIAG header (not compressed), an APPL item 04/26 with four bytes, the end-of-message item
  writeFileSync(join(dir, "frames", "A-001.bin"), Buffer.from("0000000000010000" + "100426000400000007" + "0c", "hex"));
  writeFileSync(join(dir, "diag", "A-001.json"), JSON.stringify({ items: [{ type: 16, id: 4, sid: expectedSid, value_hex: "00000007" }, { type: 12, value_hex: "" }] }));
  return dir;
}

function run(dir: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", SCRIPT, dir]);
  return { code: p.exitCode, out: p.stdout.toString() };
}

describe("scripts/diag-dev/vectors.ts", () => {
  test("vectors the decoder agrees with: exit 0 and the counts", () => {
    const r = run(folder(0x26));
    expect(r.out).toContain("blocks from traffic (lzh/): 1 of 1 agree");
    expect(r.out).toContain("messages (frames/*.bin against diag/*.json): 1 of 1 agree");
    expect(r.out).toContain("LZC (synthetic/*.lzc.bin): 1 not checked");
    expect(r.code).toBe(0);
  });
  test("a vector that says otherwise: exit 1 and where", () => {
    const r = run(folder(0x27));
    expect(r.out).toContain("0 of 1 agree");
    expect(r.out).toContain("A-001: item 0");
    expect(r.code).toBe(1);
  });
});
