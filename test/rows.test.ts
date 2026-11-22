import { describe, expect, test } from "bun:test";
import { onlyColumns, type Page, pageOf, readRows, type RowSource } from "../src/core/rows.js";
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

describe("onlyColumns on a table control (live 2026-11-20, VA03 items)", () => {
  const legend = "  columns: 0 Item=txtVBAP-POSNR (read-only), 1 Material=ctxtRV45A-MABNR (read-only), 2 Order Quantity=txtRV45A-KWMENG (read-only), 4 Description=txtVBAP-ARKTX (read-only), 67 Description=txtTPRIT-BEZEI; 41 more to the right";
  const page = (): Page => ({
    head: "wnd[0]/usr/tblT  table  rows 5 (visible 2, first 0)",
    frame: FRAME,
    kind: "table",
    titles: [legend],
    rows: [{ n: 0, text: "  row 0: Item=10; Material=M-17; Order Quantity=3; Description [col 4]=Jotachi SN4000; Description [col 67]=Bulk" }],
    total: 5,
  });
  test("columns asked for by their cell ids, or by the SAP name in them, are kept (they came back empty)", () => {
    expect(onlyColumns(page(), ["txtVBAP-POSNR", "ctxtRV45A-MABNR", "txtRV45A-KWMENG"]).rows[0]?.text).toBe("  row 0: Item=10; Material=M-17; Order Quantity=3");
    expect(onlyColumns(page(), ["VBAP-POSNR", "RV45A-KWMENG"]).rows[0]?.text).toBe("  row 0: Item=10; Order Quantity=3");
  });
  test("by id, of two columns with one title only that one; by title, both, as before", () => {
    expect(onlyColumns(page(), ["txtVBAP-ARKTX"]).rows[0]?.text).toBe("  row 0: Description [col 4]=Jotachi SN4000");
    expect(onlyColumns(page(), ["Item", "Description"]).rows[0]?.text).toBe("  row 0: Item=10; Description [col 4]=Jotachi SN4000; Description [col 67]=Bulk");
  });
  test("no column of the table: said, with the columns it has", () => {
    expect(() => onlyColumns(page(), ["VBELN"])).toThrow("none of the columns VBELN is in this table: its columns are item=txtvbap-posnr");
  });
});

/**
 * A classic list as Web GUI shows it on ECC FBL5N (2026-11-22): 3 title rows that stay, 40 rows below them,
 * 22 on screen. Its scrollbar calls 22 rows a page at the top and 21 once the list has moved, while the same
 * 22 are drawn; the reader's head then says "below 4 title rows" instead of 3.
 */
function fbl5nList(total = 40, drawn = 22, titles = 3): RowSource & { scrolls: number[] } {
  let first = 0;
  const scrolls: number[] = [];
  return {
    scrolls,
    scrollTo: async (row) => {
      scrolls.push(row);
      first = Math.max(0, Math.min(row, total - drawn + 1));
    },
    block: async () => {
      const visible = first === 0 ? drawn : drawn - 1;
      const lines = Math.min(drawn, total - first);
      const last = titles + lines - 1;
      const head = `wnd[0]/usr  list  ${total} rows (visible ${visible}${first ? `, first ${first}` : ""}, below ${last + 1 - visible} title rows; scroll for the others)`;
      const block = [
        ...FRAME,
        head,
        ...Array.from({ length: titles }, (_, i) => `wnd[0]/usr/lbl[0,${i}]  label  Title ${i}`),
        ...Array.from({ length: lines }, (_, i) => `wnd[0]/usr/lbl[0,${titles + i}]  label  Item ${first + i}`),
      ].join("\n");
      return { block, screen: block };
    },
  };
}

describe("readRows: a classic list whose page shrinks once it moves (live 2026-11-22, ECC FBL5N)", () => {
  const items = (out: string) => [...out.matchAll(/^ {2}row (\d+): Item (\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]);
  test("every row once, under its own number, across the page boundary", async () => {
    const out = await readRows(fbl5nList(), "usr", 0, 100);
    const got = items(out);
    expect(got.length).toBe(40);
    expect(got.every(([n, item]) => n === item)).toBe(true);
    expect(out).toContain("  title 2: Title 2");
  });
  test("a range that starts below the top counts the title rows at the top first", async () => {
    const src = fbl5nList();
    const got = items(await readRows(src, "usr", 25, 39));
    expect(src.scrolls[0]).toBe(25);
    expect(src.scrolls[1]).toBe(0);
    expect(got.map(([n]) => n)).toEqual(Array.from({ length: 15 }, (_, i) => 25 + i));
    expect(got.every(([n, item]) => n === item)).toBe(true);
  });
  test("the boundary row that was lost: rows 21 to 23 of a list read from the top", async () => {
    const got = items(await readRows(fbl5nList(60), "usr", 0, 59));
    expect(got.map(([n]) => n)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(got.every(([n, item]) => n === item)).toBe(true);
  });
});
