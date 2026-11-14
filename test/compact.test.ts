import { describe, expect, test } from "bun:test";
import { compact } from "../src/core/compact.js";

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

describe("compact", () => {
  const out = compact(FULL).split("\n");

  test("keeps the header, window and row lines as they are", () => {
    expect(out[0]).toBe("TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100) host");
    expect(out).toContain('WINDOW wnd[1]  "Information"');
    expect(out).toContain("  row 1: c | d");
  });

  test("cuts ids to their last segment when it is unique", () => {
    expect(out).toContain("okcd  command-field");
    expect(out).toContain('ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)');
    expect(out).toContain("chkZHDR-DONE  checkbox  [x] Complete");
    expect(out).toContain("sbar  status  S: Ready");
    expect(out).toContain("txtMESSTXT1  label  Something happened");
  });

  test("keeps enough of the id when the last segment is not unique", () => {
    expect(out).toContain('subA:ZPROG:0110/txtZHDR-NOTE  field  Note = ""  (read-only)');
    expect(out).toContain('subB:ZPROG:0120/txtZHDR-NOTE  field  Note 2 = "x"  (read-only)');
  });

  test("never shortens toolbar buttons, shells and menus", () => {
    expect(out).toContain("wnd[0]/tbar[0]/btn[3]  button  Back (F3)");
    expect(out).toContain("wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)");
    expect(out).toContain("cntlGRID/shellcont/shell  grid  2 rows; columns: A=Col A | B=Col B");
  });

  test("writes a table control as one line per row, with the filled cells only", () => {
    expect(out).toContain(
      'tblZPROGTC_ITEMS  table  rows 2 (visible 2) "All items"; columns: Item | Material | Qty | Done  (cell ids: <field>[col,row], e.g. tblZPROGTC_ITEMS/<ctl><FIELD>[0,0])',
    );
    expect(out).toContain("  tblZPROGTC_ITEMS row 0: Item=10; Material=WIDGET-1; Done [x]");
    expect(out).toContain("  tblZPROGTC_ITEMS row 1: (empty)");
    expect(out.some((l) => l.includes("[0,0]  field"))).toBe(false);
  });

  test("uses the field name when the table has no column title", () => {
    const t = ['wnd[0]/usr/tblT  table  rows 1 (visible 1); columns:  | B', 'wnd[0]/usr/tblT/txtZX-A[0,0]  field   = "1"  (edit)'].join("\n");
    expect(compact(t).split("\n")[1]).toBe("  tblT row 0: ZX-A=1");
  });

  test("is shorter than the full view and leaves a view without ids alone", () => {
    expect(compact(FULL).length).toBeLessThan(FULL.length);
    expect(compact("hello\nworld")).toBe("hello\nworld");
  });
});
