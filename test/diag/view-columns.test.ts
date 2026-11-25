/**
 * The head of a table control names the columns a row can be filled in, not only those that hold
 * something: an agent filling FB50's item table needs "D/C ACGL_ITEM-SHKZG" and "Cost center
 * ACGL_ITEM-KOSTL" before they hold anything. Seen live (2026-11-25): the head listed "Loc.curr.amount |
 * Company code | (72 more, empty in the rows on show)" and the run could not find the columns to type in.
 * Columns that are empty and read-only in the rows on show are still only counted (VA03's 109).
 */
import { describe, expect, test } from "bun:test";
import type { DiagScreen, DiagTable } from "../../src/diag/screen.js";
import { diagView } from "../../src/diag/view.js";

const col = (index: number, name: string, title: string) => ({ index, position: index, name, title, width: 8, col: 2 + index * 10, visible: true });
const cell = (column: number, text: string, input: boolean) => ({ column, text, kind: "field" as const, input, hidden: false });

function screenWith(table: DiagTable): DiagScreen {
  return {
    mode: 0,
    step: 1,
    session: { system: "ABA", client: "800", user: "U", tcode: "FB50" },
    windows: [{ index: 0, modal: false, title: "Enter G/L Account Document", program: "SAPMF05A", dynpro: "1001", guiStatus: "", guiStatusProgram: "", size: { rows: 20, cols: 156 }, menus: [], toolbar: [], keys: [], elements: [], tabstrips: [], tables: [table], controls: [], containers: [] }],
  } as unknown as DiagScreen;
}

const head = (t: DiagTable) => diagView(screenWith(t), { chrome: false }).split("\n").find((l) => l.includes(" table ")) ?? "";

describe("the columns a table control's head names", () => {
  test("columns open for input are named even while empty", () => {
    const t = {
      name: "TABLE",
      program: "SAPLFSKB",
      title: "0 Items",
      row: 11,
      col: 1,
      width: 150,
      height: 3,
      columns: [col(0, "ACGL_ITEM-HKONT", "G/L acct"), col(1, "ACGL_ITEM-SHKZG", "D/C"), col(2, "ACGL_ITEM-DMBTR", "Loc.curr.amount"), col(3, "ACGL_ITEM-KOSTL", "Cost center"), col(4, "ACGL_ITEM-KOKRS", "Controlling area"), col(5, "ACGL_ITEM-BUKRS", "Company code")],
      rows: [0, 1].map((i) => ({ index: i, row: 12 + i, empty: false, cells: [cell(0, "", true), cell(1, "", true), cell(2, "0,00", false), cell(3, "", true), cell(4, "", false), cell(5, "1000", true)] })),
      totalRows: 12,
      visibleRows: 2,
      path: [],
    } as unknown as DiagTable;
    expect(head(t)).toBe('r11  table TABLE "0 Items"  12 rows (2 with data on show), 6 columns: G/L acct ACGL_ITEM-HKONT | D/C ACGL_ITEM-SHKZG | Loc.curr.amount ACGL_ITEM-DMBTR | Cost center ACGL_ITEM-KOSTL | Company code ACGL_ITEM-BUKRS | (1 more, empty and read-only in the rows on show)');
  });
  test("a display table names only what holds something", () => {
    const t = {
      name: "TC",
      program: "SAPMV45A",
      title: "",
      row: 5,
      col: 1,
      width: 150,
      height: 2,
      columns: [col(0, "VBAP-POSNR", "Item"), col(1, "VBAP-CHARG", "Batch"), col(2, "VBAP-MATNR", "Material")],
      rows: [{ index: 0, row: 6, empty: false, cells: [cell(0, "10", false), cell(1, "", false), cell(2, "P-109", false)] }],
      totalRows: 1,
      visibleRows: 2,
      path: [],
    } as unknown as DiagTable;
    expect(head(t)).toBe("r5  table TC  1 rows (1 with data on show), 3 columns: Item VBAP-POSNR | Material VBAP-MATNR | (1 more, empty and read-only in the rows on show)");
  });
});
