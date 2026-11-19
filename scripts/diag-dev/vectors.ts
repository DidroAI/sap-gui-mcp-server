/**
 * vectors.ts <folder>: checks the decoder of src/diag against test vectors
 * made with another DIAG tool, used as a black box. Development only.
 *
 * The folder may hold any of these (what is not there is skipped):
 *
 *   lzh/<n>.in.bin, lzh/<n>.out.bin
 *       a compressed block as found in traffic (8-byte header and bit
 *       stream) and the bytes the other tool gives for it;
 *   synthetic/<name>.in.bin, <name>.lzh.bin, <name>.lzc.bin
 *       made-up plain bytes and what SAP's compressor makes of them with
 *       each of its two algorithms (LZC files are only counted: the
 *       decoder reads LZH, the only algorithm seen in traffic);
 *   frames/<name>.bin, diag/<name>.json
 *       one NI payload (a DIAG message) and its items as the other tool
 *       reads them: { items: [{ type, id?, sid?, value_hex, atoms? }] };
 *       atoms, on the items that hold screen elements, is one entry per atom:
 *       { etype, row, col, attr_DIAG_BSD_PROTECTED, attr_DIAG_BSD_INVISIBLE,
 *       name_text: { hex }, field2_text: { hex } };
 *   diag/<name>.bin next to a diag/<name>.json without a frame
 *       a DIAG stream cut out of an RFC blob (it may run on past its end
 *       into other bytes) and its items.
 *
 * It prints one line per family: how many agree byte for byte, and the first
 * disagreements. Vectors cut from real traffic hold SAP data: they stay out
 * of Git, and so does what this prints about them beyond the counts.
 *
 *   bun scripts/diag-dev/vectors.ts <folder> [--list]
 *
 * --list names every vector that disagrees instead of the first five.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClassicState } from "../../src/diag/classic.js";
import { lzhDecompress } from "../../src/diag/lzh.js";
import { type DiagItem, parseItems, parseMessage, T } from "../../src/diag/wire.js";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--"));
const listAll = args.includes("--list");
if (!folder) {
  console.error("usage: bun scripts/diag-dev/vectors.ts <folder> [--list]");
  process.exit(2);
}

class Tally {
  ok = 0;
  bad: string[] = [];
  constructor(readonly name: string) {}
  add(vector: string, problem?: string): void {
    if (problem === undefined) this.ok++;
    else this.bad.push(`${vector}: ${problem}`);
  }
  print(): void {
    const total = this.ok + this.bad.length;
    if (!total) return console.log(`${this.name}: no vectors`);
    console.log(`${this.name}: ${this.ok} of ${total} agree`);
    for (const b of listAll ? this.bad : this.bad.slice(0, 5)) console.log(`  ${b}`);
    if (!listAll && this.bad.length > 5) console.log(`  ... ${this.bad.length - 5} more (--list)`);
  }
}

/** Why our decompression of `block` differs from `expected`, or undefined when it is the same. */
function decompressProblem(block: Buffer, expected: Buffer): string | undefined {
  let out: Buffer;
  try {
    out = lzhDecompress(block);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (out.equals(expected)) return undefined;
  if (out.length !== expected.length) return `${out.length} bytes, expected ${expected.length}`;
  let at = 0;
  while (out[at] === expected[at]) at++;
  return `first difference at byte ${at} of ${out.length}`;
}

const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
const tallies: Tally[] = [];
const algorithms = new Map<string, number>();
const algorithm = (block: Buffer): string => (block.length >= 8 && block[5] === 0x1f && block[6] === 0x9d ? ({ 1: "LZC", 2: "LZH" }[(block[4] ?? 0) & 0x0f] ?? `algorithm ${(block[4] ?? 0) & 0x0f}`) : "no compression header");

// Blocks from traffic.
{
  const dir = join(folder, "lzh");
  const t = new Tally("blocks from traffic (lzh/)");
  for (const f of files(dir)) {
    if (!f.endsWith(".in.bin")) continue;
    const out = join(dir, f.replace(/\.in\.bin$/, ".out.bin"));
    if (!existsSync(out)) continue;
    const block = readFileSync(join(dir, f));
    algorithms.set(algorithm(block), (algorithms.get(algorithm(block)) ?? 0) + 1);
    t.add(f, decompressProblem(block, readFileSync(out)));
  }
  tallies.push(t);
}

// Made-up inputs, compressed by SAP's compressor.
{
  const dir = join(folder, "synthetic");
  const lzh = new Tally("made-up inputs, LZH (synthetic/*.lzh.bin)");
  let lzc = 0;
  for (const f of files(dir)) {
    const m = /^(.*)\.(lzh|lzc)\.bin$/.exec(f);
    if (!m) continue;
    const plain = join(dir, `${m[1]}.in.bin`);
    if (!existsSync(plain)) continue;
    // lzh.ts reads LZH only: SAP GUI traffic has shown no LZC block so far, so LZC is counted, not checked.
    if (m[2] === "lzc") lzc++;
    else lzh.add(f, decompressProblem(readFileSync(join(dir, f)), readFileSync(plain)));
  }
  tallies.push(lzh);
  if (lzc) console.log(`made-up inputs, LZC (synthetic/*.lzc.bin): ${lzc} not checked (the decoder reads LZH only; no LZC block has been seen in traffic)`);
}

interface OtherAtom {
  atom_length?: number;
  etype: number;
  row: number;
  col: number;
  attr_DIAG_BSD_PROTECTED?: number;
  attr_DIAG_BSD_INVISIBLE?: number;
  name_text?: { hex?: string };
  field2_text?: { hex?: string };
}

interface OtherItem {
  type: number;
  id?: number | null;
  sid?: number | null;
  value_hex?: string;
  atoms?: OtherAtom[];
}

/** Items whose atoms the other tool read in part only. */
let partialAtoms = 0;
const NAME_ATOM = 114;
const BAG_ATOM = 120;
const TAB_ATOM = 116;
const FIELD_ATOMS = new Set([130, 131, 132]);
const fromHex = (h: { hex?: string } | undefined): string => Buffer.from(h?.hex ?? "", "hex").toString("utf8");
const squeeze = (s: string): string => s.replace(/[\u0000\s]+/g, " ").trim();

/**
 * One item of atoms, read alone by our screen reader, against the other
 * tool's atoms: the same elements in the same order, each with its type,
 * row, column, protected and invisible bits, SAP name and (for fields and
 * labels) text. Tabs are counted only: we keep them in their tabstrip.
 *
 * When the other tool's atoms do not add up to the item's length (it lost
 * its place: seen after a push button), only the elements before its last
 * one are compared, and `partial` is called.
 */
function atomsProblem(item: DiagItem, theirs: OtherAtom[], partial: () => void): string | undefined {
  const state = new ClassicState(() => {});
  state.apply([item]);
  const w = state.windows[0];
  const ours = w?.elements ?? [];
  const tabs = w?.tabstrips.reduce((n, t) => n + t.tabs.length, 0) ?? 0;
  const expected: (OtherAtom & { name: string })[] = [];
  let expectedTabs = 0;
  let lastTab = false;
  for (const a of theirs) {
    if (a.etype === NAME_ATOM) {
      const last = expected[expected.length - 1];
      if (last && !lastTab) last.name = squeeze(fromHex(a.name_text));
    } else if (a.etype === TAB_ATOM) {
      expectedTabs++;
      lastTab = true;
    } else if (a.etype !== BAG_ATOM) {
      expected.push({ ...a, name: "" });
      lastTab = false;
    }
  }
  const covered = theirs.reduce((n, a) => n + (a.atom_length ?? 0), 0);
  if (theirs.every((a) => a.atom_length !== undefined) && covered !== item.value.length) {
    partial();
    expected.pop();
    if (ours.length < expected.length) return `${ours.length} elements, expected at least ${expected.length}`;
  } else {
    if (tabs !== expectedTabs) return `${tabs} tabs, expected ${expectedTabs}`;
    if (ours.length !== expected.length) return `${ours.length} elements, expected ${expected.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    const a = ours[i] as (typeof ours)[number];
    const b = expected[i] as (typeof expected)[number];
    const where = `element ${i} (type ${b.etype} at ${b.row},${b.col})`;
    if (a.etype !== b.etype || a.row !== b.row || a.col !== b.col) return `${where}: we read type ${a.etype} at ${a.row},${a.col}`;
    if (a.name !== b.name) return `${where}: name differs`;
    if (a.hidden !== !!b.attr_DIAG_BSD_INVISIBLE) return `${where}: invisible bit differs`;
    if (!FIELD_ATOMS.has(b.etype)) continue;
    // A label is never open for input whatever its bit says; a field is when it is not protected.
    if (b.etype === 130 && a.input !== !b.attr_DIAG_BSD_PROTECTED) return `${where}: protected bit differs`;
    const text = squeeze(fromHex(b.field2_text));
    const mine = squeeze(a.text);
    // Ours drops the content of invisible fields, the "?" of an empty required field, and the icon code in front of a label.
    if (a.hidden || (a.required && text === "?")) continue;
    if (mine !== text && !(b.etype === 132 && text.endsWith(mine))) return `${where}: text differs`;
  }
  return undefined;
}

/** Runs atomsProblem over the items of one message that carry atoms. */
function checkAtoms(t: Tally, name: string, ours: DiagItem[], theirs: OtherItem[]): number {
  let n = 0;
  theirs.forEach((b, i) => {
    const a = ours[i];
    if (!b.atoms?.length || !a) return;
    n += b.atoms.length;
    t.add(
      `${name} item ${i}`,
      atomsProblem(a, b.atoms, () => partialAtoms++),
    );
  });
  return n;
}

/** Why our items differ from the other tool's, or undefined. Items without a type (what the other tool could not read) end the comparison. */
function itemsProblem(ours: DiagItem[], problem: string | undefined, theirs: OtherItem[]): string | undefined {
  const known = theirs.findIndex((x) => typeof x.type !== "number");
  const expected = known < 0 ? theirs : theirs.slice(0, known);
  for (let i = 0; i < expected.length; i++) {
    const a = ours[i];
    const b = expected[i] as OtherItem;
    if (!a) return `item ${i} missing (we read ${ours.length}${problem ? `, then: ${problem}` : ""}), expected type ${b.type}`;
    const appl = b.type === 0x10 || b.type === 0x12;
    if (a.type !== b.type || (appl && (a.id !== (b.id ?? 0) || a.sid !== (b.sid ?? 0)))) return `item ${i}: we read ${a.type}/${a.id}/${a.sid}, expected ${b.type}/${b.id ?? 0}/${b.sid ?? 0}`;
    if (b.value_hex !== undefined && a.value.toString("hex") !== b.value_hex) return `item ${i} (${a.type}/${a.id}/${a.sid}): value of ${a.value.length} bytes differs, expected ${b.value_hex.length / 2}`;
  }
  if (known < 0 && ours.length !== expected.length) return `we read ${ours.length} items, expected ${expected.length}`;
  if (known < 0 && problem) return problem;
  return undefined;
}

// Messages and inner streams.
{
  const frames = new Tally("messages (frames/*.bin against diag/*.json)");
  const inner = new Tally("streams cut out of RFC blobs (diag/*.bin against diag/*.json)");
  const atoms = new Tally("items of screen elements (atoms of diag/*.json)");
  let items = 0;
  let atomCount = 0;
  const dir = join(folder, "diag");
  for (const f of files(dir)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    const name = f.replace(/\.json$/, "");
    let other: { items?: OtherItem[] };
    try {
      other = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(other.items)) continue;
    const frame = join(folder, "frames", `${name}.bin`);
    const blob = join(dir, `${name}.bin`);
    if (existsSync(frame)) {
      const msg = parseMessage(readFileSync(frame));
      if (!msg) frames.add(name, "not read as a DIAG message");
      else {
        items += msg.items.length;
        frames.add(name, itemsProblem(msg.items, msg.problem, other.items));
        atomCount += checkAtoms(atoms, name, msg.items, other.items);
      }
    } else if (existsSync(blob)) {
      // The stream ends at its end-of-message item; what the file holds after it is not part of it.
      const read = parseItems(readFileSync(blob));
      const end = read.items.findIndex((it) => it.type === T.EOM);
      const mine = end < 0 ? read.items : read.items.slice(0, end + 1);
      const theirEnd = other.items.findIndex((it) => it.type === T.EOM);
      const theirs = theirEnd < 0 ? other.items : other.items.slice(0, theirEnd + 1);
      items += mine.length;
      inner.add(name, itemsProblem(mine, end < 0 ? read.problem : undefined, theirs));
      atomCount += checkAtoms(atoms, name, mine, theirs);
    }
  }
  tallies.push(frames, inner, atoms);
  if (items) console.log(`${items} items and ${atomCount} atoms compared`);
  if (partialAtoms) console.log(`${partialAtoms} items of screen elements: the other tool's atoms stop before the item's end, compared up to there`);
}

for (const t of tallies) t.print();
if (algorithms.size) console.log(`algorithms of the blocks from traffic: ${[...algorithms].map(([a, n]) => `${a} ${n}`).join(", ")}`);
process.exit(tallies.some((t) => t.bad.length) ? 1 : 0);
