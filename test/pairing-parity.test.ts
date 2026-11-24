/**
 * The pairing code is read in three places that cannot share code: the server
 * (src/browser/extension/pairing.ts), the extension (extension/code.js) and its
 * helper (native-host/host.mjs, copied alone next to the pairing file). They
 * must agree on every code, or pairing fails.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import * as server from "../src/browser/extension/pairing.js";

interface Pairing {
  normalizeCode(s: string): string;
  formatCode(s: string): string;
  CODE_LENGTH: number;
}
// A path in a variable: tsc does not look for the types of these plain .js files.
const load = (rel: string) => import(resolve(import.meta.dir, rel)) as Promise<Pairing>;

const VECTORS: [input: string, normalized: string, formatted: string][] = [
  ["", "", ""],
  ["abcde", "ABCDE", "ABCDE"],
  ["abcdef", "ABCDEF", "ABCDE-F"],
  // look-alikes: I and L are 1, O is 0
  ["iLoO", "1100", "1100"],
  ["ABCDE-FGHJK-MNPQR-STVWX-YZ012-3", "ABCDEFGHJKMNPQRSTVWXYZ0123", "ABCDE-FGHJK-MNPQR-STVWX-YZ012-3"],
  // spaces, dashes, line breaks and anything else outside [0-9A-Z] go
  [" abcde fghjk\nmnpqr_stvwx.yz012!3 \r\n", "ABCDEFGHJKMNPQRSTVWXYZ0123", "ABCDE-FGHJK-MNPQR-STVWX-YZ012-3"],
  // toUpperCase turns ß into SS: all three do it
  ["äbc-ß-é", "BCSS", "BCSS"],
  ["0123456789", "0123456789", "01234-56789"],
];

describe("pairing code: server, extension and helper agree", () => {
  test.each(["../extension/code.js", "../native-host/host.mjs"])("%s", async (rel) => {
    const other = await load(rel);
    expect(other.CODE_LENGTH).toBe(server.CODE_LENGTH);
    for (const [input, normalized, formatted] of VECTORS) {
      expect([server.normalizeCode(input), server.formatCode(input)]).toEqual([normalized, formatted]);
      expect([other.normalizeCode(input), other.formatCode(input)]).toEqual([normalized, formatted]);
    }
  });
});
