/**
 * compare.ts <capture.bin> <ranges.json | --steps> [base-ref]: replays a
 * relay log through the decoder of this working tree and through the decoder
 * of `base-ref` (default `main`), and compares, for each screen of
 * ranges.json, the text view and the screen model as they stand at the end
 * of the screen's byte range; with `--steps`, the screen of every dialog
 * step instead. Prints "same" or the lines that differ, then the notes (what
 * was not understood) of both decoders.
 *
 * The capture and ranges.json have the format replay.ts reads. Captures
 * hold real SAP data: they stay out of Git, and so does what this prints.
 *
 *   bun scripts/diag-dev/compare.ts <capture.bin> <ranges.json> [base-ref]
 *
 * The base decoder is taken with `git archive <base-ref> src/diag` into a
 * temporary folder, so the working tree is not touched.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mine from "../../src/diag/index.js";

const [capture, rangesFile, baseRef = "main"] = process.argv.slice(2);
if (!capture || !rangesFile) {
  console.error("usage: bun scripts/diag-dev/compare.ts <capture.bin> <ranges.json | --steps> [base-ref]");
  process.exit(2);
}

type Diag = typeof mine;

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const dir = mkdtempSync(join(tmpdir(), "diag-base-"));
const tar = execFileSync("git", ["-C", root, "archive", baseRef, "src/diag"]);
execFileSync("tar", ["-x", "-C", dir], { input: tar });
const base = (await import(join(dir, "src/diag/index.ts"))) as Diag;

const data = readFileSync(capture);
const steps = rangesFile === "--steps";
const ranges = steps ? {} : (JSON.parse(readFileSync(rangesFile, "utf8")) as Record<string, [number, number]>);

interface Out {
  views: Map<string, string>;
  models: Map<string, string>;
  notes: Map<string, number>;
}

function replay(diag: Diag): Out {
  const decoder = new diag.DiagDecoder();
  const out: Out = { views: new Map(), models: new Map(), notes: decoder.notes };
  if (steps)
    decoder.onScreen = (screen, mode) => {
      const name = `step ${out.views.size + 1} (mode ${mode})`;
      out.views.set(name, diag.diagView(screen));
      out.models.set(name, JSON.stringify(screen, null, 1));
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
      out.views.set(name, screen ? diag.diagView(screen) : "(no screen)");
      out.models.set(name, screen ? JSON.stringify(screen, null, 1) : "(no screen)");
    }
  }
  return out;
}

/** The lines only in a and only in b, with their counts (order kept). */
function lineDiff(a: string, b: string): { gone: string[]; added: string[] } {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const l of s.split("\n")) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const gone = a.split("\n").filter((l) => {
    const n = cb.get(l) ?? 0;
    if (n > 0) {
      cb.set(l, n - 1);
      return false;
    }
    return true;
  });
  const added = b.split("\n").filter((l) => {
    const n = ca.get(l) ?? 0;
    if (n > 0) {
      ca.set(l, n - 1);
      return false;
    }
    return true;
  });
  return { gone, added };
}

const before = replay(base);
const after = replay(mine);
rmSync(dir, { recursive: true, force: true });

let differences = 0;
const names = steps ? [...new Set([...before.views.keys(), ...after.views.keys()])] : Object.keys(ranges);
if (steps) console.log(`${before.views.size} dialog steps with ${baseRef}, ${after.views.size} with this tree`);
for (const name of names) {
  for (const [what, a, b] of [["view", before.views.get(name) ?? "", after.views.get(name) ?? ""] as const, ["model", before.models.get(name) ?? "", after.models.get(name) ?? ""] as const]) {
    if (a === b) {
      console.log(`${name} ${what}: same (${a.split("\n").length} lines)`);
      continue;
    }
    differences++;
    const { gone, added } = lineDiff(a, b);
    console.log(`${name} ${what}: ${gone.length} line(s) only in ${baseRef}, ${added.length} only in this tree`);
    for (const l of gone) console.log(`  - ${l}`);
    for (const l of added) console.log(`  + ${l}`);
  }
}
const notes = (o: Out) => [...o.notes].sort((x, y) => y[1] - x[1]).map(([w, n]) => `×${n} ${w}`);
console.log(`\nnotes of ${baseRef}:`);
for (const n of notes(before)) console.log(`  ${n}`);
console.log("notes of this tree:");
for (const n of notes(after)) console.log(`  ${n}`);
console.log(differences ? `\n${differences} difference(s)` : "\nno difference");
