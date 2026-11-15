/**
 * replay.ts [capture] [ranges.json] [outdir]: replays a relay log through
 * DiagDecoder and writes, for each screen of ranges.json, the view
 * (<outdir>/diag/<screen>/view.txt) and the model (<outdir>/json/<screen>.json)
 * as they stand at the end of the screen's byte range. The outdir is an
 * "obsdir" for the no-scripting probe's score.py.
 *
 * The relay log: records of direction (1 byte: 0 SAP GUI to server, 1 server
 * to SAP GUI), time (float64 LE), length (uint32 LE), bytes. ranges.json:
 * { "<screen>": [startOffset, endOffset] } in bytes of the log. Captures hold
 * real SAP data: they stay out of Git, and so does what this writes.
 *
 *   bun scripts/diag-dev/replay.ts ~/didro-work/testing/no-scripting/diag/cap-1.bin \
 *     ~/didro-work/testing/no-scripting/diag/ranges-all.json /tmp/obs
 *   python score.py <refdir> /tmp/obs/diag
 *
 * Without arguments: that capture and those ranges, into the temp directory.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DiagDecoder, diagView } from "../../src/diag/index.js";

const base = join(homedir(), "didro-work/testing/no-scripting/diag");
const [capture = join(base, "cap-1.bin"), rangesFile = join(base, "ranges-all.json"), outdir = join(tmpdir(), "diag-obs")] = process.argv.slice(2);
const data = readFileSync(capture);
const ranges = JSON.parse(readFileSync(rangesFile, "utf8")) as Record<string, [number, number]>;

const decoder = new DiagDecoder();
let steps = 0;
decoder.onScreen = () => {
  steps++;
};
let at = 0;
while (at + 13 <= data.length) {
  const dir = data[at] === 0 ? 0 : 1;
  const n = data.readUInt32LE(at + 9);
  decoder.push(dir, data.subarray(at + 13, at + 13 + n));
  at += 13 + n;
  for (const [name, [, end]] of Object.entries(ranges)) {
    if (end !== at) continue;
    const screen = decoder.screen();
    if (!screen) {
      console.log(`${name}: no screen at ${at}`);
      continue;
    }
    const view = diagView(screen);
    mkdirSync(join(outdir, "diag", name), { recursive: true });
    mkdirSync(join(outdir, "json"), { recursive: true });
    writeFileSync(join(outdir, "diag", name, "view.txt"), view);
    writeFileSync(join(outdir, "json", `${name}.json`), JSON.stringify(screen, null, 1));
    console.log(`${name}: ${view.length} characters, ${view.split("\n").length} lines`);
  }
}
console.log(`${steps} dialog steps, ${decoder.screens().size} mode(s)`);
for (const [what, count] of [...decoder.notes].sort((a, b) => b[1] - a[1])) console.log(`  note ×${count}: ${what}`);
