import { describe, expect, test } from "bun:test";
import { compact, controlBlock } from "../src/core/compact.js";

// Synthetic screen: no SAP data.
const FULL = [
  "TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100) host",
  'WINDOW wnd[0]  "Synthetic Order: Overview"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[1]/btn[3]  button  Other (Shift+F3)",
  'wnd[0]/usr/ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)',
  "wnd[0]/usr/subA:ZPROG:0110/chkZHDR-DONE  checkbox  [x] Complete",
  'wnd[0]/usr/subA:ZPROG:0110/txtZHDR-NOTE  field  Note = ""  (read-only)',
  'wnd[0]/usr/subB:ZPROG:0120/txtZHDR-NOTE  field  Note 2 = "x"  (read-only)',
  'wnd[0]/usr/tblZPROGTC_ITEMS  table  rows 2 (visible 2) "All items"; columns: Item | Material | Qty | Done',
  'wnd[0]/usr/tblZPROGTC_ITEMS/txtZITM-POSNR[0,0]  field  Item = "10"  (read-only)',
  'wnd[0]/usr/tblZPROGTC_ITEMS/ctxtZITM-MATNR[1,0]  field  Material = "WIDGET-1"  (edit)',
  'wnd[0]/usr/tblZPROGTC_ITEMS/txtZITM-QTY[2,0]  field  Qty = ""  (edit)',
  "wnd[0]/usr/tblZPROGTC_ITEMS/chkZITM-DONE[3,0]  checkbox  [x] ",
  'wnd[0]/usr/tblZPROGTC_ITEMS/txtZITM-POSNR[0,1]  field  Item = ""  (edit)',
  "wnd[0]/usr/tblZPROGTC_ITEMS/chkZITM-DONE[3,1]  checkbox  [ ] ",
  "wnd[0]/usr/cntlGRID/shellcont/shell  grid  2 rows; columns: A=Col A | B=Col B",
  "  row 0: a | b",
  "  row 1: c | d",
  "wnd[0]/sbar  status  S: Ready",
  "wnd[0]/mbar  menubar  Order {menu[0]}, Edit {menu[1]}",
  'WINDOW wnd[1]  "Information"',
  "wnd[1]/usr/txtMESSTXT1  label  Something happened",
  "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)",
].join("\n");

// The same screen without its popup: behind a popup the compact view keeps less (tested below).
const MAIN = FULL.split("\n").slice(0, -3).join("\n");

describe("compact", () => {
  const out = compact(MAIN).split("\n");

  test("keeps the header, window and row lines as they are", () => {
    expect(out[0]).toBe("TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100) host");
    expect(out).toContain('WINDOW wnd[0]  "Synthetic Order: Overview"');
    expect(out).toContain("  row 1: c | d");
  });

  test("cuts ids to their last segment when it is unique", () => {
    expect(out).toContain("okcd  command-field");
    expect(out).toContain('ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)');
    expect(out).toContain("chkZHDR-DONE  checkbox  [x] Complete");
    expect(out).toContain("sbar  status  S: Ready");
    const popup = compact(FULL).split("\n");
    expect(popup).toContain("txtMESSTXT1  label  Something happened");
  });

  test("keeps enough of the id when the last segment is not unique", () => {
    expect(out).toContain('subA:ZPROG:0110/txtZHDR-NOTE  field  Note = ""  (read-only)');
    expect(out).toContain('subB:ZPROG:0120/txtZHDR-NOTE  field  Note 2 = "x"  (read-only)');
  });

  test("a shell keeps the container that names it", () => {
    expect(out).toContain("cntlGRID/shell  grid  2 rows; columns: A=Col A | B=Col B");
  });

  test("a toolbar is one line: each button by name, with the id to press", () => {
    // The same button number in two toolbars: the id says which.
    expect(out).toContain("tbar[0]  toolbar  Back (F3) {tbar[0]/btn[3]}");
    expect(out).toContain("tbar[1]  toolbar  Other (Shift+F3) {tbar[1]/btn[3]}");
    expect(out.some((l) => l.includes("  button  Back"))).toBe(false);
    // A popup's toolbar: the popup's buttons, by their own short ids.
    expect(compact(FULL).split("\n")).toContain("tbar[0]  toolbar  Continue (Enter) {btn[0]}");
  });

  test("writes a table control as one line per row, with the filled cells only", () => {
    expect(out).toContain(
      'tblZPROGTC_ITEMS  table  rows 2 (visible 2) "All items"; columns: Item | Material | Qty | Done  (cell ids: <field>[col,row], e.g. tblZPROGTC_ITEMS/<ctl><FIELD>[0,0])',
    );
    expect(out).toContain("  row 0: Item=10; Material=WIDGET-1; Done [x]");
    expect(out).toContain("  row 1: (empty)");
    expect(out.some((l) => l.includes("[0,0]  field"))).toBe(false);
  });

  test("uses the field name when the table has no column title", () => {
    const t = ['wnd[0]/usr/tblT  table  rows 1 (visible 1); columns:  | B', 'wnd[0]/usr/tblT/txtZX-A[0,0]  field   = "1"  (edit)'].join("\n");
    expect(compact(t).split("\n")[1]).toBe("  row 0: ZX-A=1");
  });

  test("a table control that is scrolled says which row its row 0 is", () => {
    const t = ['wnd[0]/usr/tblT  table  rows 171 (visible 13, first 60); columns: A', 'wnd[0]/usr/tblT/txtZX-A[0,0]  field  A = "1"  (edit)'].join("\n");
    expect(compact(t).split("\n")[0]).toBe("tblT  table  rows 171 (visible 13, first 60); columns: A  (cell ids: <field>[col,row], e.g. tblT/<ctl><FIELD>[0,0]; row 0 here is row 60 of the table)");
  });

  test("is shorter than the full view and leaves a view without ids alone", () => {
    expect(compact(FULL).length).toBeLessThan(FULL.length);
    expect(compact("hello\nworld")).toBe("hello\nworld");
  });

  test("with every rule off, the view is the one of before: full ids for buttons and shells, the table id on each row", () => {
    const plain = compact(MAIN, { handles: false, toolbars: false, dropdowns: false, lists: false, emptyColumns: false, shortRows: false, maxChars: 0 }).split("\n");
    expect(plain).toContain("wnd[0]/tbar[0]/btn[3]  button  Back (F3)");
    expect(plain).toContain("cntlGRID/shellcont/shell  grid  2 rows; columns: A=Col A | B=Col B");
    expect(plain).toContain("  tblZPROGTC_ITEMS row 0: Item=10; Material=WIDGET-1; Done [x]");
  });
});

describe("compact: toolbars and repeated buttons", () => {
  const view = (lines: string[]) => compact(["TRANSACTION Z  PROGRAM Z  SCREEN 1", 'WINDOW wnd[0]  "Z"', ...lines].join("\n")).split("\n").slice(2);
  test("each button keeps its whole name: its text, and its tooltip with the function key", () => {
    expect(
      view([
        "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
        "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
        "wnd[0]/tbar[1]/btn[13]  button  Orders  (List of sales orders (Shift+F1))",
        "wnd[0]/tbar[1]/btn[8]  button  Execute   (F8)",
      ]),
    ).toEqual(["tbar[0]  toolbar  Save (Ctrl+S) {btn[11]}, Back (F3) {btn[3]}", "tbar[1]  toolbar  Orders  (List of sales orders (Shift+F1)) {btn[13]}, Execute   (F8) {btn[8]}"]);
  });
  test("buttons of the screen that differ only by their field share a line, the names in braces", () => {
    expect(
      view([
        'wnd[0]/usr/ctxtSVBELN-LOW  field  Document = ""  (edit)',
        "wnd[0]/usr/btn%_SVBELN_%_APP_%-VALU_PUSH  button  Multiple selection",
        'wnd[0]/usr/ctxtSAUART-LOW  field  Order Type = ""  (edit)',
        "wnd[0]/usr/btn%_SAUART_%_APP_%-VALU_PUSH  button  Multiple selection",
        'wnd[0]/usr/ctxtSKUNNR-LOW  field  Sold-To Party = ""  (edit)',
        "wnd[0]/usr/btn%_SKUNNR_%_APP_%-VALU_PUSH  button  Multiple selection",
        "wnd[0]/usr/btnOTHER  button  Search",
      ]),
    ).toEqual([
      'ctxtSVBELN-LOW  field  Document = ""  (edit)',
      "btn%_S{VBELN,AUART,KUNNR}_%_APP_%-VALU_PUSH  button  Multiple selection  (3 buttons: one id per name in braces)",
      'ctxtSAUART-LOW  field  Order Type = ""  (edit)',
      'ctxtSKUNNR-LOW  field  Sold-To Party = ""  (edit)',
      "btnOTHER  button  Search",
    ]);
  });
  test("two buttons with one text, or ids with nothing in common, stay as they are", () => {
    expect(view(["wnd[0]/usr/btnA_1  button  Go", "wnd[0]/usr/btnA_2  button  Go"])).toEqual(["btnA_1  button  Go", "btnA_2  button  Go"]);
    expect(view(["wnd[0]/usr/btnX  button  Go", "wnd[0]/usr/btnYY  button  Go", "wnd[0]/usr/btnZZZ  button  Go"])).toEqual(["btnX  button  Go", "btnYY  button  Go", "btnZZZ  button  Go"]);
  });
});

describe("compact: dropdowns", () => {
  const line = 'wnd[0]/usr/cmbZHDR-BLOCK  dropdown  Delivery block = "01" Credit limit  3 options: :No block, 01:Credit limit, 02:Political reasons';
  test("the current entry and how many entries there are", () => {
    expect(compact(line)).toBe('cmbZHDR-BLOCK  dropdown  Delivery block = "01" Credit limit  (3 options)');
  });
  test("a dropdown without entries, and the entries on request, stay as the full view has them", () => {
    expect(compact('wnd[0]/usr/cmbZ  dropdown  Usage = "" ')).toBe('cmbZ  dropdown  Usage = "" ');
    expect(compact(line, { dropdowns: false })).toBe('cmbZHDR-BLOCK  dropdown  Delivery block = "01" Credit limit  3 options: :No block, 01:Credit limit, 02:Political reasons');
  });
});

describe("compact: classic lists", () => {
  // As SAP GUI gives a value-help hit list: labels named by column and line, no line for the list itself.
  const SAPGUI = [
    "TRANSACTION ZT01  PROGRAM ZHELP  SCREEN 120",
    'WINDOW wnd[1]  "Type (1) 3 Entries found"',
    "wnd[1]/tbar[0]/btn[0]  button  Copy   (Enter)",
    "wnd[1]/usr/lbl[1,1]  label  Type",
    "wnd[1]/usr/lbl[6,1]  label  Description",
    "wnd[1]/usr/lbl[1,3]  label  AA",
    "wnd[1]/usr/lbl[6,3]  label  First kind",
    "wnd[1]/usr/lbl[1,4]  label  BB",
    "wnd[1]/usr/lbl[6,4]  label  Second kind",
  ].join("\n");
  test("one line per row of the list; rows that share their columns are written without them", () => {
    expect(compact(SAPGUI).split("\n").slice(2)).toEqual([
      "tbar[0]  toolbar  Copy   (Enter) {btn[0]}",
      "wnd[1]/usr  list  3 rows  (cell ids: wnd[1]/usr/lbl[col,row], col in braces; rows without braces have their cells in columns 1,6; a checkbox is chk[col,row])",
      "  row 1: Type | Description",
      "  row 3: AA | First kind",
      "  row 4: BB | Second kind",
    ]);
  });
  test("the reader's own line for the list, checkboxes, fields and rows with other columns", () => {
    const webgui = [
      "TRANSACTION ZT02  PROGRAM ZLIST  SCREEN 120",
      'WINDOW wnd[0]  "Synthetic list"',
      "wnd[0]/usr  list  201 rows (visible 34, first 34, below 2 title rows; scroll for the others)",
      "wnd[0]/usr/lbl[0,0]  label  Entries",
      'wnd[0]/usr/txt[20,0]  field   = "3"  (edit)',
      "wnd[0]/usr/chk[1,2]  checkbox  [ ] ",
      "wnd[0]/usr/lbl[3,2]  label  AA",
      "wnd[0]/usr/chk[1,3]  checkbox  [x] ",
      "wnd[0]/usr/lbl[3,3]  label  BB",
      "wnd[0]/usr/chk[1,4]  checkbox  [ ] ",
      "wnd[0]/usr/lbl[3,4]  label  CC",
    ].join("\n");
    expect(compact(webgui).split("\n").slice(2)).toEqual([
      "usr  list  201 rows (visible 34, first 34, below 2 title rows; scroll for the others)  (cell ids: usr/lbl[col,row], col in braces; rows without braces have their cells in columns 1,3; a checkbox is chk[col,row])",
      '  row 0: Entries {0} | "3" {20}',
      "  row 2: [ ] | AA",
      "  row 3: [x] | BB",
      "  row 4: [ ] | CC",
    ]);
    // One list alone, whole.
    expect(controlBlock(webgui, "wnd[0]/usr")?.split("\n").length).toBe(11);
  });
});

describe("compact: grids", () => {
  const grid = [
    "wnd[0]/usr/cntlG/shellcont/shell  grid  500 rows; columns: A=Doc | B=Valid from | C=Type | D=Reason | E=Block | F=Value",
    "  row 0: 1 |  | OR |  |  | 5",
    "  row 1: 2 |  | OR |  |  | ",
    "  ... 498 more rows (shown: 0 to 1; scroll for the others)",
  ].join("\n");
  test("columns that are empty in every row shown are named once, with their titles", () => {
    expect(compact(grid).split("\n")).toEqual([
      "cntlG/shell  grid  500 rows; columns: A=Doc | C=Type | F=Value; empty in these rows: B=Valid from | D=Reason | E=Block",
      "  row 0: 1 | OR | 5",
      "  row 1: 2 | OR | ",
      "  ... 498 more rows (shown: 0 to 1; scroll for the others)",
    ]);
  });
  test("fewer than three empty columns, or a row that does not split into the columns: left alone", () => {
    const two = grid.replace("C=Type | D=Reason | E=Block", "C=Type | D=Reason").replace("OR |  |  | 5", "OR |  | 5").replace("OR |  |  | ", "OR |  | ");
    expect(compact(two).split("\n")[1]).toBe("  row 0: 1 |  | OR |  | 5");
    const odd = grid.replace("  row 1: 2 |  | OR |  |  | ", "  row 1: 2 | a | b | c | OR |  |  | ");
    expect(compact(odd).split("\n")[1]).toBe("  row 0: 1 |  | OR |  |  | 5");
  });
});

describe("compact: very large screens", () => {
  const big = ["TRANSACTION Z  PROGRAM Z  SCREEN 1", 'WINDOW wnd[0]  "Z"', "wnd[0]/usr/cntlG/shellcont/shell  grid  200 rows; columns: A=A | B=B", ...Array.from({ length: 200 }, (_, i) => `  row ${i}: ${"x".repeat(80)} | ${i}`), "wnd[0]/sbar  status  S: ok"].join("\n");
  test("row lines are cut to fit, with how many are left out and how to get them", () => {
    const c = compact(big, { maxChars: 4000 }).split("\n");
    expect(c.join("\n").length).toBeLessThan(4400);
    expect(c[2]).toBe("cntlG/shell  grid  200 rows; columns: A=A | B=B");
    expect(c.at(-1)).toBe("sbar  status  S: ok");
    const note = c.find((l) => l.startsWith("  ..."));
    expect(note).toMatch(/^ {2}\.\.\. \d+ more lines of cntlG\/shell are left out to keep the view short: sap_look with id "cntlG\/shell" shows it whole$/);
    const kept = c.filter((l) => l.startsWith("  row ")).length;
    expect(kept + Number(/\d+/.exec(note ?? "")?.[0])).toBe(200);
  });
  test("a view that fits, or no limit: nothing is cut", () => {
    expect(compact(big, { maxChars: 0 }).split("\n").length).toBe(204);
    expect(compact(big).split("\n").length).toBe(204);
  });
  test("controlBlock: one control with its rows, under the header and window lines", () => {
    const b = controlBlock(big, "wnd[0]/usr/cntlG/shellcont/shell")?.split("\n") ?? [];
    expect(b.slice(0, 3)).toEqual(["TRANSACTION Z  PROGRAM Z  SCREEN 1", 'WINDOW wnd[0]  "Z"', "wnd[0]/usr/cntlG/shellcont/shell  grid  200 rows; columns: A=A | B=B"]);
    expect(b.length).toBe(203);
    expect(controlBlock(big, "wnd[0]/usr/cntlNONE/shellcont/shell")).toBeUndefined();
  });
});

describe("compact: the screen behind a popup", () => {
  const full = [
    "TRANSACTION VA02  PROGRAM SAPMV45A  SCREEN 102  SYSTEM DEM (001)",
    'WINDOW wnd[0]  "Change Sales Order: Initial Screen"',
    "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
    'wnd[0]/usr/ctxtVBAK-VBELN  field  Order = "10792"  (read-only)',
    'wnd[0]/usr/ctxtRV45S-KUNNR  field  Sold-To Party = ""  (read-only)',
    "wnd[0]/sbar  status  W: Consider the subsequent documents",
    'WINDOW wnd[1]  "Information"',
    "wnd[1]/usr/txtMESSTXT1  label  Consider the subsequent documents",
    "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)",
  ].join("\n");
  test("keeps values and the status bar behind, the popup whole", () => {
    const c = compact(full);
    expect(c).toContain('ctxtVBAK-VBELN  field  Order = "10792"');
    expect(c).toContain("status  W: Consider");
    expect(c).not.toContain("Back (F3)");
    expect(c).not.toContain("Sold-To Party");
    expect(c).toContain("2 more lines behind the popup");
    expect(c).toContain("tbar[0]  toolbar  Continue (Enter) {btn[0]}");
  });
  test("leaves a screen without popup alone", () => {
    const one = full.split("\n").slice(0, 6).join("\n");
    expect(compact(one)).toContain("tbar[0]  toolbar  Back (F3) {btn[3]}");
  });
});
