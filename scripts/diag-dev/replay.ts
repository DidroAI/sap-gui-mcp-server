/**
 * replay.ts [capture] [ranges.json] [outdir]: replays a relay log through
 * DiagDecoder and writes, for each screen of ranges.json, the two views the
 * surface gives (<outdir>/diag/<screen>/view.txt as sap_look shows it,
 * full.txt with every row, as sap_look full=true) and the model
 * (<outdir>/json/<screen>.json) as they stand at the end of the screen's byte
 * range, to compare the decoder's output with what SAP GUI showed.
 *
 * The relay log: records of direction (1 byte: 0 SAP GUI to server, 1 server
 * to SAP GUI), time (float64 LE), length (uint32 LE), bytes. ranges.json:
 * { "<screen>": [startOffset, endOffset] } in bytes of the log. Captures hold
 * real SAP data: they stay out of Git, and so does what this writes.
 *
 * A capture comes from the server run with SAP_DIAG_CAPTURE=<folder>.
 *
 *   bun scripts/diag-dev/replay.ts <capture.bin> <ranges.json> [outdir]
 *
 * outdir defaults to a new diag-obs-* folder in the temp directory, that only
 * this user can open (the screens hold SAP data). Its path is printed.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagDecoder, diagView } from "../../src/diag/index.js";

const [capture, rangesFile, outArg] = process.argv.slice(2);
if (!capture || !rangesFile) {
  console.error("usage: bun scripts/diag-dev/replay.ts <capture.bin> <ranges.json> [outdir]");
  process.exit(2);
}
// mkdtemp makes the folder 0700 with a name no one else can guess beforehand.
const outdir = outArg ?? mkdtempSync(join(tmpdir(), "diag-obs-"));
console.log(`writing to ${outdir}`);
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
    writeFileSync(join(outdir, "diag", name, "full.txt"), diagView(screen, { maxRows: 100_000 }));
    writeFileSync(join(outdir, "json", `${name}.json`), JSON.stringify(screen, null, 1));
    console.log(`${name}: ${view.length} characters, ${view.split("\n").length} lines`);
  }
}
console.log(`${steps} dialog steps, ${decoder.screens().size} mode(s)`);
for (const [what, count] of [...decoder.notes].sort((a, b) => b[1] - a[1])) console.log(`  note ×${count}: ${what}`);
