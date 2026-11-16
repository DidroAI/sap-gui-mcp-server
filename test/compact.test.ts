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

  test("toolbar buttons keep a line each, their whole name and key, and a short id", () => {
    // The same button number in two toolbars: the id says which.
    expect(out).toContain("tbar[0]/btn[3]  button  Back (F3)");
    expect(out).toContain("tbar[1]/btn[3]  button  Other (Shift+F3)");
    // A popup's button, by its own short id: the screen behind is not in the way.
    expect(compact(FULL).split("\n")).toContain("btn[0]  button  Continue (Enter)");
  });

  test("writes a table control as one line per row, with the filled cells and every checkbox", () => {
    expect(out).toContain('tblZPROGTC_ITEMS  table  rows 2 (visible 2) "All items"  (cell id: <id>[col,row], e.g. txtZITM-POSNR[0,0])');
    // The id of each column once, from its cells (also empty ones), with where it cannot be changed.
    expect(out).toContain("  columns: 0 Item=txtZITM-POSNR (read-only in rows 0), 1 Material=ctxtZITM-MATNR, 2 Qty=txtZITM-QTY, 3 Done=chkZITM-DONE");
    expect(out).toContain("  row 0: Item=10; Material=WIDGET-1; Done [x]");
    // An unchecked box is a box to tick: it is shown.
    expect(out).toContain("  row 1: Done [ ]");
    expect(out.some((l) => l.includes("[0,0]  field"))).toBe(false);
  });

  test("uses the field name when the table has no column title", () => {
    const t = ['wnd[0]/usr/tblT  table  rows 1 (visible 1); columns:  | B', 'wnd[0]/usr/tblT/txtZX-A[0,0]  field   = "1"  (edit)'].join("\n");
    expect(compact(t).split("\n")[2]).toBe("  row 0: ZX-A=1");
  });

  test("two columns with one title are told apart by their number in the rows", () => {
    const t = [
      "wnd[0]/usr/tblTAX  table  rows 1 (visible 1); columns: Country | Country | Tax category",
      'wnd[0]/usr/tblTAX/txtT005T-LANDX[1,0]  field  Country = "Argentina"  (read-only)',
      'wnd[0]/usr/tblTAX/ctxtZTAX-ALAND[0,0]  field  Country = "AR"  (read-only)',
      'wnd[0]/usr/tblTAX/ctxtZTAX-TATYP[2,0]  field  Tax category = "J1AU"  (read-only)',
    ].join("\n");
    expect(compact(t).split("\n")).toContain("  row 0: Country [col 0]=AR; Country [col 1]=Argentina; Tax category=J1AU");
  });

  test("a table control none of whose rows holds a value says so (its line counts SAP's blank lines)", () => {
    const t = ["wnd[0]/usr/tblT  table  rows 6 (visible 7); rows can be selected; columns: Item | Amount", "wnd[0]/usr/txtZ-TOTAL  label  0"].join("\n");
    expect(compact(t).split("\n")).toEqual([
      "tblT  table  rows 6 (visible 7); rows can be selected  (cell id: <id>[col,row], e.g. tblT/<id>[0,0])",
      "  columns: 0 Item, 1 Amount",
      "  (no row is filled: every row on screen is blank and takes no input. The rows its line counts are SAP's blank lines.)",
      "txtZ-TOTAL  label  0",
    ]);
    // A table with a cell line, filled or empty, has its rows in the view: no such note.
    const filled = ["wnd[0]/usr/tblT  table  rows 6 (visible 7); columns: Item", 'wnd[0]/usr/tblT/txtZX-A[0,0]  field  Item = ""  (edit)'].join("\n");
    expect(compact(filled)).not.toContain("no row is filled");
  });

  test("a table control that is scrolled says which row its row 0 is", () => {
    const t = ['wnd[0]/usr/tblT  table  rows 171 (visible 13, first 60); columns: A', 'wnd[0]/usr/tblT/txtZX-A[0,0]  field  A = "1"  (edit)'].join("\n");
    expect(compact(t).split("\n")[0]).toBe("tblT  table  rows 171 (visible 13, first 60)  (cell id: <id>[col,row], e.g. txtZX-A[0,0]; row 0 here is row 60 of the table)");
  });

  test("a table control: selected rows marked, empty rows in a run on one line, columns scrolled out named", () => {
    const t = [
      "wnd[0]/usr/tblT  table  rows 9 (visible 5); rows can be selected; selected rows 1; columns: Item | Material | Stock type | Net value | Currency",
      'wnd[0]/usr/tblT/txtZ-POSNR[0,0]  field  Item = "10"  (read-only)',
      'wnd[0]/usr/tblT/ctxtZ-MATNR[1,0]  field  Material = "M-1"  (read-only)',
      'wnd[0]/usr/tblT/cmbZ-STYPE[2,0]  dropdown  Stock type = "F" Unrestricted use  (edit)',
      'wnd[0]/usr/tblT/txtZ-POSNR[0,1]  field  Item = "20"  (read-only)',
      'wnd[0]/usr/tblT/ctxtZ-MATNR[1,1]  field  Material = "M-2"  (read-only)',
      'wnd[0]/usr/tblT/cmbZ-STYPE[2,1]  dropdown  Stock type = "" (edit)',
      'wnd[0]/usr/tblT/txtZ-POSNR[0,2]  field  Item = ""  (edit)',
      'wnd[0]/usr/tblT/txtZ-POSNR[0,3]  field  Item = ""  (edit)',
      'wnd[0]/usr/tblT/txtZ-POSNR[0,4]  field  Item = ""  (edit)',
    ].join("\n");
    expect(compact(t).split("\n")).toEqual([
      "tblT  table  rows 9 (visible 5); rows can be selected; selected rows 1  (cell id: <id>[col,row], e.g. txtZ-POSNR[0,0])",
      '  columns: 0 Item=txtZ-POSNR (read-only in rows 0,1), 1 Material=ctxtZ-MATNR (read-only), 2 Stock type=cmbZ-STYPE; 2 more to the right (scroll "to":"right"): Net value, Currency',
      "  row 0: Item=10; Material=M-1; Stock type=Unrestricted use",
      "  row 1 (selected): Item=20; Material=M-2",
      "  rows 2 to 4: (empty)",
    ]);
  });

  test("behind a popup a table keeps its line, so its rows keep their titles", () => {
    const t = [
      'WINDOW wnd[0]  "Main"',
      "wnd[0]/usr/tblT  table  rows 1 (visible 1); columns: Item",
      'wnd[0]/usr/tblT/txtZ-POSNR[0,0]  field  Item = "10"  (read-only)',
      'WINDOW wnd[1]  "Question"',
      "wnd[1]/usr/btnYES  button  Yes",
    ].join("\n");
    expect(compact(t).split("\n")).toContain("  row 0: Item=10");
  });

  test("is shorter than the full view and leaves a view without ids alone", () => {
    expect(compact(FULL).length).toBeLessThan(FULL.length);
    expect(compact("hello\nworld")).toBe("hello\nworld");
  });

  test("with every rule off, the view is the one of before: full ids for buttons and shells, the table id on each row", () => {
    const plain = compact(MAIN, { handles: false, repeatedButtons: false, dropdowns: false, lists: false, emptyColumns: false, shortRows: false, maxChars: 0 }).split("\n");
    expect(plain).toContain("wnd[0]/tbar[0]/btn[3]  button  Back (F3)");
    expect(plain).toContain("cntlGRID/shellcont/shell  grid  2 rows; columns: A=Col A | B=Col B");
    expect(plain).toContain("  tblZPROGTC_ITEMS row 0: Item=10; Material=WIDGET-1; Done [x]");
    expect(plain).toContain("  tblZPROGTC_ITEMS row 1: Done [ ]");
  });
});

describe("compact: repeated buttons", () => {
  const view = (lines: string[]) => compact(["TRANSACTION Z  PROGRAM Z  SCREEN 1", 'WINDOW wnd[0]  "Z"', ...lines].join("\n")).split("\n").slice(2);
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
      "btn[0]  button  Copy   (Enter)",
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
    expect(c).toContain("btn[0]  button  Continue (Enter)");
  });
  test("leaves a screen without popup alone", () => {
    const one = full.split("\n").slice(0, 6).join("\n");
    expect(compact(one)).toContain("btn[3]  button  Back (F3)");
  });
});

describe("buttons in table cells (ECCSCR-06)", () => {
  const T = "wnd[1]/usr/tblSEL";
  const POPUP = [
    "TRANSACTION ZT  PROGRAM ZP  SCREEN 1",
    'WINDOW wnd[1]  "Multiple Selection"',
    `${T}  table  rows 3 (visible 3); columns: Selection Options | Single value`,
    `${T}/btnSOP_I[0,0]  button  Select: Not equal to`,
    `${T}/ctxtSLOW_I[1,0]  field   = "M-17"  (edit)`,
    `${T}/btnSOP_I[0,1]  button  Select: Include pattern`,
    `${T}/ctxtSLOW_I[1,1]  field   = "M-1*"  (edit)`,
    `${T}/btnSOP_I[0,2]  button  Selection of Selection Options`,
    `${T}/ctxtSLOW_I[1,2]  field   = ""  (edit)`,
  ].join("\n");

  test("a button cell shows its text in a row that holds a value, when the column's buttons differ", () => {
    const out = compact(POPUP).split("\n");
    expect(out).toContain("  row 0: Selection Options=Select: Not equal to; Single value=M-17");
    expect(out).toContain("  row 1: Selection Options=Select: Include pattern; Single value=M-1*");
    // A row with its button only stays an empty row.
    expect(out).toContain("  row 2: (empty)");
  });

  test("a column of equal buttons is not repeated in the rows", () => {
    const same = POPUP.replace("Select: Not equal to", "Details").replace("Select: Include pattern", "Details").replace("Selection of Selection Options", "Details");
    expect(compact(same).split("\n")).toContain("  row 0: Single value=M-17");
  });

  test("the cells of a row come in the order of the columns", () => {
    const view = ["TRANSACTION ZT  PROGRAM ZP  SCREEN 1", 'WINDOW wnd[0]  "T"', "wnd[0]/usr/tblX  table  rows 1 (visible 1); columns: Item | Material | Next", 'wnd[0]/usr/tblX/txtN[2,0]  field  Next = "0"  (edit)', 'wnd[0]/usr/tblX/txtI[0,0]  field  Item = "10"  (edit)'].join("\n");
    expect(compact(view).split("\n")).toContain("  row 0: Item=10; Next=0");
  });
});
