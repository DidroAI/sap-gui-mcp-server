/**
 * The decoder on damaged and unusual traffic: lost and garbled bytes, joining
 * in the middle, odd chunking, several modes, large messages, and a fuzz run.
 * All streams are synthetic (test/diag/build.ts).
 */
import { describe, expect, test } from "bun:test";
import { DiagDecoder } from "../../src/diag/decoder.js";
import type { DiagScreen } from "../../src/diag/screen.js";
import { diagView } from "../../src/diag/view.js";
import { NiFramer } from "../../src/diag/wire.js";
import { END, elem, elementList, idItem, keys, menus, message, RESET, rfcCall, rfcItem, screenHead, sessionInfo } from "./build.js";

type Rec = [0 | 1, Buffer];

const act = (command: string, mode = 0): Rec => [0, message([idItem(0x0c, 0x04, command), END], { info: 0, mode })];
function screen(name: string, o: { mode?: number; compress?: boolean; more?: Buffer[] } = {}): Rec {
  const body = [...screenHead({ title: name }), ...(o.more ?? []), RESET, elementList(elem.label(1, 1, name), elem.field(1, 20, `${name} value`, { width: 16 }), elem.name(1, 20, "ZF-VALUE"))];
  return [1, message([...body, END], { mode: o.mode ?? 0, compress: o.compress ?? false })];
}

/** A large screen sent inside an RFC call, in two parts, as SAP does for big screens. */
function largeScreen(): Rec[] {
  const inner = Buffer.concat([...screenHead({ title: "Large", program: "ZBIG", dynpro: "0200" }), RESET, elementList(...Array.from({ length: 40 }, (_, i) => elem.label(i % 20, (i >> 1) * 4, `L${i}`)))]);
  const blob = rfcCall("GUICORE_BLOB_DIAG_PARSER", { STREAM: inner });
  const cut = Math.floor(blob.length / 2);
  return [
    [1, message([sessionInfo(0x02, "XYZ"), rfcItem(4, blob.subarray(0, cut)), END], { compress: true })],
    [0, message([rfcItem(4, Buffer.alloc(0)), END], { info: 0 })],
    [1, message([rfcItem(6, blob.subarray(cut)), END], { info: 2, compress: true })],
    [1, message([], { info: 1 })],
  ];
}

/** Steps whose damage the tests look at; then the tail, two clean steps the decoder must read whatever came before. */
const BODY: Rec[] = [
  [0, message([idItem(0x0c, 0x04, "/nZT01"), END], { info: 0, dp: true })],
  screen("One", { compress: true }),
  act("/00"),
  screen("Two", { more: [menus(1, [[[1], "Order"]]), keys(4, [[3, "Back"]])] }),
  act("/00"),
  ...largeScreen(),
  act("/00", 1),
  screen("Other mode", { mode: 1 }),
  act("/00"),
  screen("Three", { compress: true }),
];
/** The last screen sends its menus and keys again, as SAP does when the GUI status changes. */
const TAIL: Rec[] = [act("/00"), screen("Last", { compress: true }), act("/00"), screen("Final", { more: [menus(1, [[[1], "Order"]]), keys(4, [[3, "Back"]])] })];
const SESSION = [...BODY, ...TAIL];

function feed(recs: Rec[], split?: (b: Buffer) => Buffer[]): { decoder: DiagDecoder; screens: DiagScreen[] } {
  const decoder = new DiagDecoder();
  const screens: DiagScreen[] = [];
  decoder.onScreen = (s) => {
    diagView(s); // the view must build on whatever the decoder made
    screens.push(s);
  };
  for (const [dir, bytes] of recs) for (const piece of split ? split(bytes) : [bytes]) decoder.push(dir, piece);
  return { decoder, screens };
}

const clean = feed(SESSION);
const finalScreen = (d: DiagDecoder) => d.screen(0);
/** What the last screen shows, without the step counter (a lost step changes it). */
const shown = (s: DiagScreen | undefined) => (s ? diagView({ ...s, step: 0 }) : "");
const cleanEnd = finalScreen(clean.decoder) as DiagScreen;

/**
 * The decoder read the last screen again after the damage: its classic part
 * (sent in full at every step) is as without damage, and the whole view is
 * too, unless the screen says that parts of it may be old (menus and keys
 * are only sent when they change, so a lost change stays lost).
 */
function recovered(d: DiagDecoder): boolean {
  const end = finalScreen(d);
  if (end?.windows[0]?.title !== "Final") return false;
  if (JSON.stringify(end.windows[0]?.elements) !== JSON.stringify(cleanEnd.windows[0]?.elements)) return false;
  return end.damaged === true || shown(end) === shown(cleanEnd);
}

/** A copy of the records with `count` bytes removed at `offset` of record `r`. */
function without(recs: Rec[], r: number, offset: number, count = 1): Rec[] {
  return recs.map(([dir, b], i) => (i === r ? [dir, Buffer.concat([b.subarray(0, offset), b.subarray(offset + count)])] : [dir, b]));
}

test("the synthetic session reads clean, in any chunks", () => {
  expect(clean.screens.map((s) => s.windows[s.windows.length - 1]?.title)).toEqual(["One", "Two", "Large", "Other mode", "Three", "Last", "Final"]);
  expect(clean.screens.some((s) => s.damaged)).toBe(false);
  expect(clean.decoder.losses).toBe(0);
  const views = clean.screens.map((s) => diagView(s));
  // split each record in two at every byte boundary, and in 1-byte chunks
  let splits = 0;
  for (const [, bytes] of SESSION)
    for (let at = 1; at < bytes.length; at++) {
      const split = feed(SESSION, (b) => (b === bytes ? [b.subarray(0, at), b.subarray(at)] : [b]));
      expect(split.screens.map((s) => diagView(s))).toEqual(views);
      splits++;
    }
  expect(splits).toBeGreaterThan(2000);
  const ones = feed(SESSION, (b) => Array.from({ length: b.length }, (_, i) => b.subarray(i, i + 1)));
  expect(ones.screens.map((s) => diagView(s))).toEqual(views);
});

describe("lost and garbled bytes", () => {
  test("one byte lost anywhere: never throws, the loss is noticed, and the screens after it read as without the loss", () => {
    let checked = 0;
    for (const [r, [, bytes]] of BODY.entries())
      for (let offset = 0; offset < bytes.length; offset++) {
        const { decoder, screens } = feed(without(SESSION, r, offset));
        expect(recovered(decoder)).toBe(true);
        expect(decoder.losses > 0 || screens.some((s) => s.damaged)).toBe(true);
        checked++;
      }
    expect(checked).toBeGreaterThan(1000);
  });

  test("the screen right after a loss says so, in the model and in the view", () => {
    // lose a byte in the middle of the compressed screen "Three": its message no longer decompresses
    const r = BODY.length - 1;
    const { screens } = feed(without(SESSION, r, 40));
    const hit = screens.find((s) => s.damaged);
    expect(hit).toBeDefined();
    expect(diagView(hit as DiagScreen)).toContain("note  bytes were lost on the connection");
    expect(screens.at(-1)?.windows[0]?.title).toBe("Final");
    expect(diagView(screens.at(-1) as DiagScreen)).not.toContain("bytes were lost");
  });

  test("a garbled length (too long, too short, past the limit) does not swallow the frames after it", () => {
    for (const [r, [, bytes]] of BODY.entries()) {
      if (bytes.length < 8) continue;
      for (const [at, mask] of [
        [0, 0x80],
        [1, 0x08],
        [2, 0x01],
        [3, 0x02],
      ] as const) {
        const b = Buffer.from(bytes);
        b[at] = (b[at] as number) ^ mask;
        const recs = SESSION.map((x, i): Rec => (i === r ? [x[0], b] : x));
        const { decoder } = feed(recs);
        expect(recovered(decoder)).toBe(true);
      }
    }
  });

  test("a whole lost frame: the next steps still read", () => {
    for (let r = 0; r < BODY.length; r++) {
      // A whole frame lost leaves no trace in the framing: the screens after it read, but nothing can say that a menu change was lost.
      const { decoder } = feed(SESSION.filter((_, i) => i !== r));
      expect(finalScreen(decoder)?.windows[0]?.elements).toEqual(cleanEnd.windows[0]?.elements as never);
    }
  });
});

test("joining in the middle of a connection, at any byte: the next full screen reads", () => {
  const stream = SESSION.slice(0, BODY.length);
  for (const [r, [, bytes]] of stream.entries())
    for (let offset = 0; offset < bytes.length; offset += 3) {
      const late: Rec[] = [[stream[r]?.[0] as 0 | 1, bytes.subarray(offset)], ...SESSION.slice(r + 1)];
      const { decoder, screens } = feed(late);
      expect(recovered(decoder)).toBe(true);
      // joined inside a frame of the server: the first screen may lack what came before, and says so
      if (offset > 0 && stream[r]?.[0] === 1) expect(screens[0]?.damaged).toBe(true);
    }
});

describe("unusual but valid traffic", () => {
  test("several modes, with an RFC call of one mode cut into parts around a screen of the other", () => {
    const [part, ack, last, done] = largeScreen() as [Rec, Rec, Rec, Rec];
    const { decoder, screens } = feed([part, screen("Mode two", { mode: 2 }), ack, last, act("/00", 2), screen("Mode two again", { mode: 2 }), done]);
    expect(screens.map((s) => [s.mode, s.windows[0]?.title])).toEqual([
      [2, "Mode two"],
      [2, "Mode two again"],
      [0, "Large"],
    ]);
    expect(decoder.screen(0)?.windows[0]?.elements.length).toBe(40);
    expect(decoder.notes.size).toBe(0);
  });

  test("a large screen: a compressed message over 64 KB, and an RFC call in many parts", () => {
    const labels = Array.from({ length: 3000 }, (_, i) => elem.label(i % 200, (i % 7) * 12, `Label number ${i}`));
    const items = [...screenHead({ title: "Big" }), RESET, elementList(...labels), END];
    expect(Buffer.concat(items).length).toBeGreaterThan(65536);
    const big = message(items, { compress: true });
    // an RFC parameter holds at most 64 KB: the inner stream is smaller, the call in many parts all the same
    const inner = Buffer.concat([...screenHead({ title: "Parts" }), RESET, elementList(...labels.slice(0, 1500))]);
    const blob = rfcCall("GUICORE_BLOB_DIAG_PARSER", { STREAM: inner });
    expect(blob.length).toBeGreaterThan(50_000);
    const recs: Rec[] = [[1, big]];
    const size = 1000;
    for (let i = 0; i < blob.length; i += size) {
      const lastPart = i + size >= blob.length;
      recs.push([1, message([rfcItem(lastPart ? 6 : 4, blob.subarray(i, i + size)), END], { info: lastPart ? 2 : 0, compress: true })]);
      if (!lastPart) recs.push([0, message([rfcItem(4, Buffer.alloc(0)), END], { info: 0 })]);
    }
    recs.push([1, message([], { info: 1 })]);
    const { screens } = feed(recs, (b) => Array.from({ length: Math.ceil(b.length / 1460) }, (_, i) => b.subarray(i * 1460, (i + 1) * 1460)));
    expect(screens.map((s) => [s.windows[0]?.title, s.windows[0]?.elements.length])).toEqual([
      ["Big", 3000],
      ["Parts", 1500],
    ]);
  });

  test("what the decoder does not know is on the screen it was met on, then gone", () => {
    const odd = screen("Odd", { more: [idItem(0x33, 0x01, "?"), RESET, elementList(elem.unknown(2, 1, "strange"))] });
    const { decoder, screens } = feed([odd, act("/00"), screen("Plain")]);
    expect(screens[0]?.unread).toEqual(["item 10/33/01", "element type 99"]);
    expect(diagView(screens[0] as DiagScreen)).toContain("note  parts of this screen were not read: item 10/33/01; element type 99");
    expect(screens[1]?.unread).toBeUndefined();
    expect(diagView(screens[1] as DiagScreen)).not.toContain("note");
    expect(decoder.notes.get("element type 99")).toBe(1);
  });
});

describe("bounded memory", () => {
  test("a frame announced longer than the limit is taken as garbled; the framer holds little", () => {
    const framer = new NiFramer();
    const huge = Buffer.from([0x7f, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1]); // 2 GB, then a header
    framer.read(huge);
    for (let i = 0; i < 200; i++) framer.read(Buffer.alloc(65536, i));
    expect(framer.buffered).toBeLessThan(2 << 20);
    const after = framer.read(message([...screenHead({ title: "After" }), END]));
    expect(after.some((e) => "payload" in e)).toBe(true);
    expect(after.some((e) => "lost" in e)).toBe(true);
  });

  test("garbage for a long time: the framer never holds more than about a megabyte, and the notes stay few", () => {
    const decoder = new DiagDecoder();
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    let most = 0;
    for (let i = 0; i < 400; i++) {
      const junk = Buffer.alloc(8192);
      for (let j = 0; j < junk.length; j++) junk[j] = rnd() & 0xff;
      // now and then a lone zero run, which looks like the start of a length
      if (i % 7 === 0) junk.fill(0, 100, 103);
      decoder.push(1, junk);
      most = Math.max(most, (decoder as unknown as { framers: NiFramer[] }).framers[1]?.buffered ?? 0);
    }
    expect(most).toBeLessThan((1 << 20) + 65536);
    decoder.push(1, screen("Back")[1]);
    expect(decoder.screen()?.windows[0]?.title).toBe("Back");
    expect(decoder.notes.size).toBeLessThanOrEqual(201);
  });
});

test("fuzz: truncations, bit flips, inserted and repeated bytes, random chunks: never throws, never hangs, and reads again", () => {
  let seed = Number(process.env.DIAG_FUZZ_SEED ?? 20261119);
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const runs = 400;
  let recoveredWhole = 0;
  let recoveredSplit = 0;
  const started = performance.now();
  for (let k = 0; k < runs; k++) {
    const recs = BODY.map(([d, b]): Rec => [d, Buffer.from(b)]);
    for (let m = 1 + rnd(3); m > 0; m--) {
      const r = rnd(recs.length);
      const [dir, b] = recs[r] as Rec;
      const at = rnd(Math.max(1, b.length));
      switch (rnd(4)) {
        case 0: // truncation
          recs[r] = [dir, b.subarray(0, at)];
          break;
        case 1: // bit flip
          if (b.length) b[at] = (b[at] as number) ^ (1 << rnd(8));
          break;
        case 2: // inserted bytes
          recs[r] = [dir, Buffer.concat([b.subarray(0, at), Buffer.from(Array.from({ length: 1 + rnd(6) }, () => rnd(256))), b.subarray(at)])];
          break;
        default: // a repeated piece
          recs[r] = [dir, Buffer.concat([b.subarray(0, at), b.subarray(Math.max(0, at - 1 - rnd(20)))])];
      }
    }
    const t = performance.now();
    const whole = feed([...recs, ...TAIL]);
    const split = feed([...recs, ...TAIL], (b) => {
      const out: Buffer[] = [];
      for (let i = 0; i < b.length; ) {
        const n = 1 + rnd(200);
        out.push(b.subarray(i, i + n));
        i += n;
      }
      return out;
    });
    expect(performance.now() - t).toBeLessThan(1000);
    if (recovered(whole.decoder)) recoveredWhole++;
    if (finalScreen(split.decoder)?.windows[0]?.title === "Final") recoveredSplit++;
  }
  expect(performance.now() - started).toBeLessThan(20_000);
  // Fed as the sender wrote it, the tail always reads. Cut at random, a garbled length can hold the tail
  // inside a frame that has not ended yet (until enough traffic follows): allowed, but rare.
  if (process.env.DIAG_FUZZ_REPORT) console.log(`fuzz: ${recoveredWhole} of ${runs} recovered fed whole, ${recoveredSplit} in random chunks`);
  expect(recoveredWhole).toBe(runs);
  expect(recoveredSplit).toBeGreaterThan(runs * 0.9);
});

describe("the NI framer", () => {
  const a = message([...screenHead({ title: "A" }), END]);
  const b = message([...screenHead({ title: "B" }), END], { compress: true });
  const c = message([...screenHead({ title: "C" }), END]);

  test("a byte lost inside a frame: that frame is handed out as suspect, the loss is counted, the next one is whole", () => {
    const framer = new NiFramer();
    const damaged = Buffer.concat([a.subarray(0, 30), a.subarray(31)]);
    const events = framer.read(Buffer.concat([damaged, b, c]));
    expect(events.map((e) => ("lost" in e ? `lost ${e.lost}` : e.suspect ? "suspect" : e.payload.length))).toEqual(["suspect", `lost ${b.length - 1}`, c.length - 4]);
    expect(framer.lost).toBe(b.length - 1);
  });

  test("a frame is held until the next one starts, unless the bytes end with it", () => {
    const framer = new NiFramer();
    expect(framer.read(Buffer.concat([a, b.subarray(0, 2)])).length).toBe(0);
    expect(framer.read(b.subarray(2)).map((e) => ("payload" in e ? e.payload.length : -1))).toEqual([a.length - 4, b.length - 4]);
  });
});

test("doctor counts what the decoders could not read", async () => {
  const { decodingCheck } = await import("../../src/sapgui-diag/index.js");
  expect(decodingCheck([])).toBeUndefined();
  const fine = feed(SESSION).decoder;
  expect(decodingCheck([{ decoder: fine }])).toEqual({ ok: true, check: "DIAG decoding", detail: "no traffic lost; everything read" });
  const hurt = feed(without(SESSION, 1, 30)).decoder;
  const check = decodingCheck([{ decoder: fine }, { decoder: hurt }]);
  expect(check?.ok).toBe(true);
  expect(check?.detail).toMatch(/^\d+ bytes lost or garbled in transit, 1 time\(s\): the decoder found its place again; \d+ note\(s\) on what was not read: /);
  const snc = new DiagDecoder();
  snc.push(1, Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from([0, 0, 0, 0, 0, 1, 0, 2, 1, 2, 3, 4])]));
  expect(decodingCheck([{ decoder: snc }])?.ok).toBe(false);
});
