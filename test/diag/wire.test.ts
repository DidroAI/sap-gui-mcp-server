import { describe, expect, test } from "bun:test";
import { parseRfc } from "../../src/diag/rfc.js";
import { NiFramer, parseItems, parseMessage } from "../../src/diag/wire.js";
import { idItem, END, message, rfcCall, windowStart, title, u32 } from "./build.js";

describe("NI frames", () => {
  test("frames are found whatever the chunks", () => {
    const a = message([title("One")]);
    const b = message([title("Two"), END], { compress: true });
    const stream = Buffer.concat([a, b]);
    for (const size of [1, 3, 7, stream.length]) {
      const framer = new NiFramer();
      const out: Buffer[] = [];
      for (let i = 0; i < stream.length; i += size) out.push(...framer.push(stream.subarray(i, i + size)));
      expect(out.map((p) => p.length)).toEqual([a.length - 4, b.length - 4]);
    }
  });
});

describe("DIAG messages", () => {
  const payload = (frame: Buffer) => frame.subarray(4);

  test("plain, compressed, and behind the DP header", () => {
    const items = [windowStart(), title("Synthetic"), idItem(0x09, 0x02, Buffer.alloc(70000)), END];
    for (const o of [{}, { compress: true }, { compress: true, padding: 3 }, { dp: true }, { dp: true, compress: true }]) {
      const m = parseMessage(payload(message(items, { mode: 2, ...o })));
      expect(m?.problem).toBeUndefined();
      expect(m?.dp).toBe(o.dp === true);
      expect(m?.header[0]).toBe(2);
      expect(m?.items.map((i) => i.type)).toEqual([0x01, 0x10, 0x12, 0x0c]);
      expect(m?.items[1]?.value.toString()).toBe("Synthetic");
      expect(m?.items[2]?.value.length).toBe(70000);
    }
  });

  test("keep-alives are not DIAG", () => {
    expect(parseMessage(Buffer.from("NI_PING\0"))).toBeUndefined();
  });

  test("an unknown item type or a cut item stops the parsing, with what was read", () => {
    const unknown = parseItems(Buffer.concat([title("Kept"), Buffer.from([0x77, 1, 2, 3])]));
    expect(unknown.items.length).toBe(1);
    expect(unknown.problem).toMatch(/unknown item type 0x77/);
    const cut = parseItems(title("Cut short").subarray(0, 8));
    expect(cut.items.length).toBe(0);
    expect(cut.problem).toMatch(/cut/);
  });

  test("an encrypted or broken message gives a problem, not an exception", () => {
    const snc = payload(message([title("x")]));
    snc[7] = 2;
    expect(parseMessage(snc)?.problem).toMatch(/encrypted/);
    const broken = payload(message([title("x")], { compress: true }));
    broken[12] = 0x10;
    expect(parseMessage(broken)?.problem).toBeDefined();
    expect(parseMessage(Buffer.from([1, 2, 3]))?.problem).toMatch(/shorter/);
  });
});

describe("RFC payloads", () => {
  test("function, parameters, tables as rows and as compressed chunks", () => {
    const rows = Array.from({ length: 40 }, (_, i) => Buffer.from(`row ${String(i).padStart(3, "0")} `.padEnd(60)));
    const call = parseRfc(
      rfcCall("Z_SYNTHETIC", { NAME: "value", EMPTY: "" }, [
        { name: "PLAIN", rowLength: 60, rows: rows.slice(0, 2) },
        { name: "PACKED", rowLength: 60, rows, packed: true, padding: 2 },
        { name: "NONE", rowLength: 12, rows: [] },
      ]),
    );
    expect(call.problem).toBeUndefined();
    expect(call.function).toBe("Z_SYNTHETIC");
    expect(call.params.get("NAME")?.toString()).toBe("value");
    expect(call.tables.get("PLAIN")?.rows.length).toBe(2);
    expect(call.tables.get("PACKED")?.count).toBe(40);
    expect(call.tables.get("PACKED")?.rows.map((r) => r.toString().trim())[39]).toBe("row 039");
    expect(call.tables.get("NONE")?.rows).toEqual([]);
  });

  test("a payload that breaks off says so", () => {
    const whole = rfcCall("Z_SYNTHETIC", { NAME: "value" });
    const call = parseRfc(whole.subarray(0, whole.length - 5));
    expect(call.function).toBe("Z_SYNTHETIC");
    expect(call.problem).toMatch(/breaks off/);
    expect(parseRfc(Buffer.concat([u32(7), u32(9)])).problem).toBeDefined();
  });
});

describe("NI frames after a loss: time stays linear", () => {
  test("a restart candidate held for 900 KB of small chunks does not copy the held bytes again with every chunk", () => {
    const framer = new NiFramer();
    // A garbled length starts a search; then a plausible frame of 900 KB whose end has not come yet keeps its bytes held.
    const start = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0x7f]), u32(900_000), Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0x10])]);
    framer.read(start);
    const chunk = Buffer.alloc(128);
    const t0 = performance.now();
    for (let i = 0; i < 7000; i++) framer.read(chunk);
    const ms = performance.now() - t0;
    expect(framer.buffered).toBeGreaterThan(800_000);
    // Copying the held bytes with every chunk is about 3 GB here: about a second. Linear is a few milliseconds.
    expect(ms).toBeLessThan(250);
  });
});
