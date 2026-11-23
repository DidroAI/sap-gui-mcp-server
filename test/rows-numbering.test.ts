/**
 * One row number everywhere (live test of 2026-11-23, notes P2, P3, P4, P10):
 * the number the view prints is the one "rows" and the actions take; a read
 * leaves a table control where it was; rows a range skips are said; lists
 * take "cols"; an empty list cell keeps its place; a cell printed twice is
 * printed once; a cell of a table control is found by row and column.
 */
import { Views } from "../src/core/views.js";
import { hintsOnce } from "../src/core/views.js";
import { describe, expect, test } from "bun:test";
import { compact } from "../src/core/compact.js";
import { readRows, type RowSource } from "../src/core/rows.js";
import { gridColumnId, listCellId, listScreenRow, tableAt, tableCellId, tableColumn } from "../src/webgui/lists.js";
import { FBL5N, listSource, listView, ME2L } from "./fixtures/lists.js";

const FRAME = ["TRANSACTION MM03  PROGRAM SAPLMGMM  SCREEN 70", 'WINDOW wnd[1]  "Select View(s)"'];
const T = "wnd[1]/usr/tblSAPLMGMMTC_VIEW";
const VIEWS = ["Basic Data 1", "Basic Data 2", "Classification", "Sales: Sales Org. Data 1", "Sales: Sales Org. Data 2", "Sales: General/Plant Data", "Foreign Trade: Export Data", "Sales Text", "Purchasing", "Foreign Trade: Import Data", "Purchase Order Text", "MRP 1", "MRP 2", "MRP 3", "MRP 4", "Forecasting", "Work Scheduling", "Plant Data / Storage 1", "Plant Data / Storage 2", "Warehouse Management 1", "Warehouse Management 2", "Quality Management", "Accounting 1", "Accounting 2", "Costing 1"];

/**
 * MM03's views as Web GUI showed them: 41 rows of which 25 hold a view, 25 shown at a time, display cells
 * only (a blank row has none). `first` is where it is scrolled to.
 */
function views(start = 0): RowSource & { scrolls: number[]; at: () => number } {
  let first = start;
  const scrolls: number[] = [];
  const block = () =>
    [
      ...FRAME,
      `${T}  table  rows 41 (visible 25${first ? `, first ${first}` : ""}); rows can be selected; columns: View`,
      ...Array.from({ length: 25 }, (_, i) => first + i)
        .filter((n) => n < VIEWS.length)
        .map((n) => `${T}/txtMSICHTAUSW-DYTXT[0,${n - first}]  field  View = "${VIEWS[n]}"  (read-only)`),
    ].join("\n");
  return {
    scrolls,
    at: () => first,
    scrollTo: async (row) => {
      scrolls.push(row);
      first = Math.max(0, Math.min(row, 41 - 25));
    },
    block: async () => ({ block: block(), screen: block() }),
  };
}

const rowLines = (out: string) => out.split("\n").filter((l) => /^ {2}rows? \d+/.test(l));

describe("P2. table controls: one number, a read leaves the table where it was", () => {
  test("MM03 views scrolled to 10: the view says row 12 is MRP 2, and prints no cell row", () => {
    const full = [...FRAME, `${T}  table  rows 41 (visible 25, first 10); rows can be selected; selected rows 12; columns: View`, `${T}/txtMSICHTAUSW-DYTXT[0,2]  field  View = "MRP 2"  (read-only)`, `${T}/txtMSICHTAUSW-DYTXT[0,12]  field  View = "Plant Data / Storage 2"  (read-only)`].join("\n");
    const lines = compact(full).split("\n");
    expect(lines).toContain("  row 12 (selected): View=MRP 2");
    expect(lines).toContain("  row 22: View=Plant Data / Storage 2");
    expect(lines.some((l) => l.includes("cell row"))).toBe(false);
    expect(lines.find((l) => l.startsWith("tblSAPLMGMMTC_VIEW  table"))).toContain("txtMSICHTAUSW-DYTXT[0,0] is row 10");
  });
  test('rows "0-40" read every view, say the blank rows, and scroll the table back to 10', async () => {
    const src = views(10);
    const before = (await src.block())?.block ?? "";
    const out = await readRows(src, "tblSAPLMGMMTC_VIEW", 0, 40, undefined, { block: before, screen: before });
    const rows = rowLines(out);
    expect(rows.length).toBe(25);
    expect(rows[0]).toBe("  row 0: View=Basic Data 1");
    expect(rows[24]).toBe("  row 24: View=Costing 1");
    expect(src.scrolls.at(-1)).toBe(10);
    expect(src.at()).toBe(10);
    const note = out.split("\n").at(-1) ?? "";
    expect(note).toStartWith("  (rows 0 to 24 of 41; the table is scrolled back to row 10, as it was. Rows 25 to 40 hold nothing: SAP counts 41 rows in this table, blank lines included.");
    expect(note).toContain("<id>[col,0] is row 10 now");
    expect(out).not.toContain("row 0 here");
    expect(out.split("\n")[2]).toStartWith(`${T.replace(/^.*\//, "")}  table  rows 41 (visible 25, first 10);`);
  });
  test("a table read where it already is: no scroll back", async () => {
    const src = views(0);
    const before = (await src.block())?.block ?? "";
    const out = await readRows(src, "tblSAPLMGMMTC_VIEW", 0, 5, undefined, { block: before, screen: before });
    expect(src.scrolls).toEqual([0]);
    expect(out.split("\n").at(-1)).toStartWith("  (rows 0 to 5 of 41; the table is now scrolled there.");
  });
});

describe("P3. classic lists: list rows only, skipped rows said, cols, empty cells keep their place", () => {
  const webME2L = { ...ME2L, webgui: true };
  test("ME2L: the first view ends at row 15; a read of 20-47 says rows 16 to 19 were skipped", async () => {
    const before = listView(webME2L, 0);
    const out = await readRows(listSource(webME2L), "usr", 20, 46, undefined, { block: before, screen: before });
    expect(rowLines(out)[0] ?? "").toStartWith("  row 20: ");
    // Said near the top, right under the list's line, not after the rows (live 2026-11-23: last line of 3.4 KB).
    const lines = out.split("\n");
    expect(lines[lines.findIndex((l) => l.startsWith("usr  list")) + 1]).toBe('  (The screen showed rows up to 15: rows 16 to 19 are not in this read ("rows":"16-19" reads them).)');
    // The list goes back to where the screen had it; the header lines above the heading are not repeated.
    expect(lines.at(-1)).toContain("the list is scrolled back to line 0, as it was.");
    expect(lines.filter((l) => l.startsWith("  title ")).length).toBe(1);
    // Read on from where the screen ends: nothing to say.
    const next = await readRows(listSource(webME2L), "usr", 16, 30, undefined, { block: before, screen: before });
    expect(next).not.toContain("not in this read");
  });
  test("a list read starts at the row asked for, with a stable count (FBL5N rows 16-60)", async () => {
    const f = { ...FBL5N, webgui: true };
    const out = await readRows(listSource(f), "usr", 16, 60);
    expect(rowLines(out)[0] ?? "").toStartWith("  row 16: ");
    expect(out.split("\n").at(-1)).toStartWith("  (rows 16 to 55 of 56;");
  });
  test("Web GUI: a title count that would number a line past the list's end is one too small", async () => {
    // Ten lines, all on the screen, below 17 title rows of which the last is blank; the head says 16.
    const lines = Array.from({ length: 10 }, (_, i) => `wnd[0]/usr/lbl[1,${17 + i}]  label  Item ${i}`);
    const block = ["TRANSACTION ZL  PROGRAM Z  SCREEN 1", 'WINDOW wnd[0]  "L"', "wnd[0]/usr  list  10 rows (visible 16, below 16 title rows; scroll for the others)", "wnd[0]/usr/lbl[0,15]  label  Head", ...lines].join("\n");
    const src: RowSource = { scrollTo: async () => {}, block: async () => ({ block, screen: block }) };
    const out = await readRows(src, "usr", 0, 20);
    expect(rowLines(out)).toEqual(Array.from({ length: 10 }, (_, i) => `  row ${i}: Item ${i} {1}`));
    expect(out.split("\n").at(-1)).toStartWith("  (rows 0 to 9 of 10;");
  });
  test('"cols" keeps the columns named by heading title or position (FBL5N "Type,DocumentNo")', async () => {
    const f = { ...FBL5N, webgui: true };
    const out = await readRows(listSource(f), "usr", 0, 3, ["Type", "DocumentNo"]);
    expect(rowLines(out)).toEqual(["  row 0: RV {11} | 100007678 {78}", "  row 1: RV {11} | 100007664 {78}", "  row 2: RV {11} | 100007654 {78}", "  row 3: DZ {11} | 1400002650 {78}"]);
    const byPos = await readRows(listSource(f), "usr", 0, 0, ["53"]);
    expect(rowLines(byPos)).toEqual(["  row 0: 130.005,98 {53}"]);
    await expect(readRows(listSource(f), "usr", 0, 3, ["Plant"])).rejects.toThrow("none of the columns Plant is in this list: name a column by a title of the list's heading");
  });
  test("rows without the columns asked for are left out, and said", async () => {
    const out = await readRows(listSource({ ...FBL5N, webgui: true }), "usr", 30, 40, ["DocumentNo"]);
    expect(out.split("\n").at(-1)).toMatch(/ \d+ rows that hold none of these columns are left out\./);
  });
  test("a line with an empty cell keeps its values under their columns (FBL5N open item, no clearing date)", () => {
    const item = (r: number, clear: boolean) => [`wnd[0]/usr/chk[1,${r}]  checkbox  [ ] `, `wnd[0]/usr/lbl[6,${r}]  label  icon "Open"`, `wnd[0]/usr/lbl[11,${r}]  label  RV`, `wnd[0]/usr/lbl[20,${r}]  label  12.07.2012`, `wnd[0]/usr/lbl[31,${r}]  label  12.07.2012`, ...(clear ? [`wnd[0]/usr/lbl[42,${r}]  label  01.08.2012`] : []), `wnd[0]/usr/lbl[53,${r}]  label  708,00`, `wnd[0]/usr/lbl[72,${r}]  label  EUR`, `wnd[0]/usr/lbl[78,${r}]  label  14000000${60 + r}`];
    const full = ["TRANSACTION FBL5N  PROGRAM SAPMSSY0  SCREEN 120", 'WINDOW wnd[0]  "Customer Line Item Display"', "wnd[0]/usr  list  4 rows (visible 4, below 1 title rows; scroll for the others)", "wnd[0]/usr/lbl[11,0]  label  Type", ...item(1, true), ...item(2, true), ...item(3, true), ...item(4, false)].join("\n");
    const lines = compact(full).split("\n");
    expect(lines).toContain('  row 0: [ ] | icon "Open" | RV | 12.07.2012 | 12.07.2012 | 01.08.2012 | 708,00 | EUR | 1400000061');
    expect(lines).toContain('  row 3: [ ] | icon "Open" | RV | 12.07.2012 | 12.07.2012 |  | 708,00 | EUR | 1400000064');
  });
  test("no item cleared: the heading's empty column still holds its place (FBL5N live 2026-11-23: 708,00 under Clearing)", () => {
    const item = (r: number) => [`wnd[0]/usr/chk[1,${r}]  checkbox  [ ] `, `wnd[0]/usr/lbl[6,${r}]  label  icon "Open"`, `wnd[0]/usr/lbl[11,${r}]  label  RV`, `wnd[0]/usr/lbl[20,${r}]  label  12.07.2012`, `wnd[0]/usr/lbl[31,${r}]  label  12.07.2012`, `wnd[0]/usr/lbl[53,${r}]  label  708,00`, `wnd[0]/usr/lbl[72,${r}]  label  EUR`, `wnd[0]/usr/lbl[78,${r}]  label  14000000${60 + r}`];
    const head = [6, 11, 20, 31, 42, 53, 72, 78].map((c, i) => `wnd[0]/usr/lbl[${c},0]  label  ${["Stat", "Type", "Doc. Date", "Net due dt", "Clearing", "Amt in loc.cur.", "LCurr", "DocumentNo"][i]}`);
    const full = ["TRANSACTION FBL5N  PROGRAM SAPMSSY0  SCREEN 120", 'WINDOW wnd[0]  "Customer Line Item Display"', "wnd[0]/usr  list  4 rows (visible 4, below 1 title rows; scroll for the others)", ...head, ...item(1), ...item(2), ...item(3), ...item(4)].join("\n");
    const lines = compact(full).split("\n");
    expect(lines.find((l) => l.startsWith("usr  list"))).toContain("rows without braces have their cells in columns 1,6,11,20,31,42,53,72,78");
    expect(lines).toContain('  row 0: [ ] | icon "Open" | RV | 12.07.2012 | 12.07.2012 |  | 708,00 | EUR | 1400000061');
  });
});

describe("P10. a cell printed twice is printed once", () => {
  test("a display cell and the label in it: one value", () => {
    const full = [...FRAME, `${T}  table  rows 2 (visible 2); columns: View`, `${T}/txtMSICHTAUSW-DYTXT[0,0]  field  View = "Basic Data 1"  (read-only)`, `${T}/lblMSICHTAUSW-DYTXT[0,0]  label  Basic Data 1`].join("\n");
    expect(compact(full).split("\n")).toContain("  row 0: View=Basic Data 1");
  });
});

describe("P4. a cell of a Web GUI table control by row and column", () => {
  const VA01 = [
    "TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 4001",
    'WINDOW wnd[0]  "Create Standard Order: Overview"',
    "wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG  table  rows 20 (visible 5, first 10) \"All items\"; rows can be selected; columns: Item | Material | Order Quantity",
    'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtVBAP-POSNR[0,0]  field  Item = ""  (edit)',
    'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]  field  Material = ""  (edit)',
    'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[2,0]  field  Order Quantity = ""  (edit)',
    'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,1]  field  Material = ""  (edit)',
  ].join("\n");
  const S = "wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG";
  test("col by title, field name (with or without its prefix, or the field alone) or number", () => {
    for (const col of ["Material", "material", "RV45A-MABNR", "ctxtRV45A-MABNR", "MABNR", "1", 1]) expect(tableColumn(VA01, S, col)).toBe(1);
    expect(tableCellId(VA01, S, 0, "Material", 10)).toBe(`${S}/ctxtRV45A-MABNR[1,0]`);
    expect(tableCellId(VA01, S, 1, "RV45A-MABNR", 11)).toBe(`${S}/ctxtRV45A-MABNR[1,1]`);
  });
  test("the row as the view numbers it: on screen when it is between first and first + visible", () => {
    expect(tableAt(VA01, S)).toEqual({ first: 10, visible: 5, total: 20 });
  });
  test("a column it does not have, or a row without that cell: the error names the columns or the cell id form", () => {
    expect(() => tableColumn(VA01, S, "Plant")).toThrow(`${S} has no column "Plant". "col" is a column number, title or field name: 0 Item=txtVBAP-POSNR, 1 Material=ctxtRV45A-MABNR, 2 Order Quantity=txtRV45A-KWMENG.`);
    expect(() => tableCellId(VA01, S, 1, "Order Quantity", 11)).toThrow(`row 11 of ${S} has no cell in column 2 on the screen`);
    expect(() => tableCellId(VA01, S, 1, "Order Quantity", 11)).toThrow(`Its cell id would be ${S}/txtRV45A-KWMENG[2,1]`);
  });
});

describe("P3. a list line by its number in actions", () => {
  const full = listView({ ...ME2L, webgui: true }, 10);
  test("row N is screen row N - first + title rows; off the screen: undefined", () => {
    expect(listScreenRow(full, "wnd[0]/usr", 10)).toBe(5);
    expect(listScreenRow(full, "wnd[0]/usr", 15)).toBe(10);
    expect(listScreenRow(full, "wnd[0]/usr", 9)).toBeUndefined();
    expect(listScreenRow(full, "wnd[0]/usr", 26)).toBeUndefined();
  });
  test("the cell: by position, the one that covers it, or the line's first text", () => {
    // Row 11, screen row 6, is PO 4500000614's first line: "4500000614 {1} | NB {12} | ...".
    expect(listCellId(full, "wnd[0]/usr", 6, undefined)).toBe("wnd[0]/usr/lbl[1,6]");
    expect(listCellId(full, "wnd[0]/usr", 6, 12)).toBe("wnd[0]/usr/lbl[12,6]");
    expect(listCellId(full, "wnd[0]/usr", 6, "5")).toBe("wnd[0]/usr/lbl[1,6]");
    expect(listCellId(full, "wnd[0]/usr", 6, 99)).toBeUndefined();
  });
});

describe("P10. a grid column by its title in actions, as sap_look's cols takes it", () => {
  const full = ["TRANSACTION VA05  PROGRAM SAPMV75A  SCREEN 500", "wnd[0]/usr/cntlGRID1/shellcont/shell  grid  12 rows; columns: VBELN=Sales Document | BSTKD=Customer Reference | VBAP_NETWR=Net Value (Item)"].join("\n");
  const G = "wnd[0]/usr/cntlGRID1/shellcont/shell";
  test("title, id in any case; unknown names stay for the page to refuse", () => {
    expect(gridColumnId(full, G, "Net Value (Item)")).toBe("VBAP_NETWR");
    expect(gridColumnId(full, G, "net value (item)")).toBe("VBAP_NETWR");
    expect(gridColumnId(full, G, "vbeln")).toBe("VBELN");
    expect(gridColumnId(full, G, "NOPE")).toBe("NOPE");
    expect(gridColumnId(full, G, undefined)).toBeUndefined();
  });
});

describe("long hints once per visit to a screen (live 2026-11-23: 480 and 700 characters on every answer)", () => {
  test("a list's row hint, then its short form; a table's columns, then 'as listed before'; another screen, all again", () => {
    const cols = Array.from({ length: 12 }, (_, i) => `Column number ${i}`).join(" | ");
    const view = (screen: string) =>
      [
        `TRANSACTION FBL5N  PROGRAM SAPMSSY0  SCREEN ${screen}`,
        'WINDOW wnd[0]  "Customer Line Item Display"',
        'usr  list  40 rows (visible 16, below 17 title rows; scroll for the others)  (rows numbered in the whole list below its 17 title rows: "rows" and "row" in actions take these numbers, e.g. {"do":"dblclick","id":"usr","row":N,"col":<col>}; a cell id counts rows on the screen: row N is usr/lbl[col,N+17] now, col in braces; rows without braces have their cells in columns 1,6,11; a checkbox is chk[col,...])',
        `tblX  table  rows 2 (visible 2); columns: ${cols}  (cell id: <id>[col,row], e.g. ctxtA[0,0])`,
      ].join("\n");
    const memory = { screen: "", seen: new Set<string>() };
    expect(hintsOnce(view("120"), memory)).toBe(view("120"));
    const again = hintsOnce(view("120"), memory).split("\n");
    expect(again[2]).toBe("usr  list  40 rows (visible 16, below 17 title rows; scroll for the others)  (rows numbered in the whole list; row N is usr/lbl[col,N+17]; cells in columns 1,6,11; as explained before)");
    expect(again[3]).toBe("tblX  table  rows 2 (visible 2); columns: as listed before  (cell id: <id>[col,row], e.g. ctxtA[0,0])");
    expect(hintsOnce(view("100"), memory)).toBe(view("100"));
  });
});

describe("hints once, counted in what the agent is given (Views.present)", () => {
  const legend = `  columns: ${Array.from({ length: 14 }, (_, i) => `${i + 1} Col${i}=ctxtMEPO1211-F${i}`).join(", ")}`;
  const screen = (qty: string) =>
    [
      "TRANSACTION ME21N  PROGRAM SAPLMEGUI  SCREEN 14",
      'WINDOW wnd[0]  "Create Purchase Order"',
      'ctxtMEPO_TOPLINE-SUPERFIELD  field  Supplier = "1000"  (edit)',
      "tblSAPLMEGUITC_1211  table  rows 15 (visible 8); rows can be selected  (cell id: <id>[col,row], e.g. txtMEPO1211-EBELP[1,0])",
      legend,
      `  row 0: Material=100-100; PO Quantity=${qty}`,
    ].join("\n");
  test("the first answer has the columns whole; a diff of the table after it says 'as listed before' (ME21N #18, #19)", () => {
    const views = new Views("diff");
    expect(views.present("s", screen("5"))).toContain(legend);
    const d = views.present("s", screen("6"));
    expect(d).not.toContain(legend);
    expect(d).toContain("columns: as listed before");
  });
  test("a session's first answer on a screen has the whole hint, however often the server read the screen before", () => {
    const views = new Views("diff");
    expect(views.present("other", screen("5"))).toContain(legend);
    expect(views.present("s", screen("5"))).toContain(legend);
  });
});
