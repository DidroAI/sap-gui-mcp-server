import { describe, expect, test } from "bun:test";
import { pageOf, readRows, type RowSource } from "../src/core/rows.js";
import { ActionError } from "../src/core/types.js";

const FRAME = ["TRANSACTION ZT05  PROGRAM ZLIST  SCREEN 500", 'WINDOW wnd[0]  "Synthetic list (93 entries)"'];

/** A made-up grid of `total` rows that shows `visible` at a time, as a reader would write it. */
function grid(total: number, visible: number): RowSource & { scrolls: number[] } {
  let first = 0;
  const scrolls: number[] = [];
  return {
    scrolls,
    scrollTo: async (row) => {
      scrolls.push(row);
      first = Math.max(0, Math.min(row, total - visible));
    },
    block: async () => {
      const block = [...FRAME, `wnd[0]/usr/cntlG/shellcont/shell  grid  ${total} rows; columns: A=Doc | B=Type`, ...Array.from({ length: Math.min(visible, total) }, (_, i) => `  row ${first + i}: ${1000 + first + i} | OR`), `  ... ${total - visible} more rows (shown: ${first} to ${first + visible - 1}; scroll for the others)`].join("\n");
      return { block, screen: block };
    },
  };
}

describe("pageOf: the rows of a control, numbered in the whole list", () => {
  test("a grid's rows carry their own numbers", () => {
    const p = pageOf([...FRAME, "wnd[0]/usr/cntlG/shellcont/shell  grid  93 rows; columns: A=Doc", "  row 25: 1025", "  row 26: 1026", "  ... 91 more rows (shown: 25 to 26; scroll for the others)"].join("\n"));
    expect(p.kind).toBe("grid");
    expect(p.total).toBe(93);
    expect(p.rows).toEqual([
      { n: 25, text: "  row 25: 1025" },
      { n: 26, text: "  row 26: 1026" },
    ]);
  });
  test("a table control counts rows on the screen: `first` is added", () => {
    const p = pageOf([...FRAME, "wnd[0]/usr/tblT  table  rows 171 (visible 2, first 60); columns: Name", 'wnd[0]/usr/tblT/txtZ-NAME[0,0]  field  Name = "sixty"  (read-only)', 'wnd[0]/usr/tblT/txtZ-NAME[0,1]  field  Name = "sixty-one"  (read-only)'].join("\n"));
    expect(p.kind).toBe("table");
    expect(p.total).toBe(171);
    expect(p.rows).toEqual([
      { n: 60, text: "  row 60: Name=sixty" },
      { n: 61, text: "  row 61: Name=sixty-one" },
    ]);
  });
  test("a list keeps its title rows apart: they do not scroll", () => {
    const p = pageOf([...FRAME, "wnd[0]/usr  list  201 rows (visible 2, first 34, below 1 title rows; scroll for the others)", "wnd[0]/usr/lbl[3,0]  label  Type", "wnd[0]/usr/lbl[3,1]  label  AA", "wnd[0]/usr/lbl[3,2]  label  BB"].join("\n"));
    expect(p.kind).toBe("list");
    expect(p.titles).toEqual(["  title 0: Type {3}"]);
    expect(p.rows).toEqual([
      { n: 34, text: "  row 34: AA {3}" },
      { n: 35, text: "  row 35: BB {3}" },
    ]);
  });
  test("a tree's nodes are counted from the first one shown", () => {
    const p = pageOf([...FRAME, "wnd[0]/usr/cntlT/shellcont/shell  tree  2 nodes shown of 900 (first 300; scroll for the others)", "  A  {node 1}", "  B  {node 2}"].join("\n"));
    expect(p.kind).toBe("tree");
    expect(p.total).toBe(900);
    expect(p.rows.map((r) => r.n)).toEqual([300, 301]);
  });
});

describe("readRows: a range, read by scrolling", () => {
  test("scrolls page by page and gives exactly the rows asked for", async () => {
    const g = grid(93, 25);
    const out = (await readRows(g, "cntlG/shell", 30, 59)).split("\n");
    expect(g.scrolls).toEqual([30, 55]);
    expect(out.slice(0, 3)).toEqual([...FRAME, "cntlG/shell  grid  93 rows; columns: A=Doc | B=Type"]);
    expect(out[3]).toBe("  row 30: 1030 | OR");
    expect(out[32]).toBe("  row 59: 1059 | OR");
    expect(out[33]).toBe("  (rows 30 to 59 of 93; the control is now scrolled there.)");
    expect(out.length).toBe(34);
  });
  test("a range that runs past the end stops at the last row", async () => {
    const g = grid(93, 25);
    const out = (await readRows(g, "cntlG/shell", 80, 120)).split("\n");
    expect(out.filter((l) => l.startsWith("  row ")).length).toBe(13);
    expect(out.at(-1)).toBe("  (rows 80 to 92 of 93; the control is now scrolled there.)");
    expect(g.scrolls).toEqual([80]);
  });
  test("a range the list does not have says so", async () => {
    expect((await readRows(grid(93, 25), "cntlG/shell", 200, 220)).split("\n").at(-1)).toBe("  (no rows 200 to 220: the control has 93 rows)");
  });
  test("a control that is gone, or one without rows, is an error for the agent", async () => {
    const gone: RowSource = { scrollTo: async () => {}, block: async () => undefined };
    expect(readRows(gone, "cntlG/shell", 0, 9)).rejects.toThrow(ActionError);
    const one = [...FRAME, 'wnd[0]/usr/ctxtZ  field  Z = "1"  (edit)'].join("\n");
    const field: RowSource = { scrollTo: async () => {}, block: async () => ({ block: one, screen: one }) };
    expect(readRows(field, "ctxtZ", 0, 9)).rejects.toThrow("has no rows to read");
  });
});
