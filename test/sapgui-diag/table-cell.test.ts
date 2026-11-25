/**
 * A table cell named the way sap_act's description gives it, "id (the table), row, col", as on the other
 * surfaces: {"do":"set","id":"TABLE","row":0,"col":"G/L acct","value":"476000"}. The column by its SAP
 * name (with or without the table part), its title, or its place; the row is the table's own row number,
 * as the view prints it. Seen live in FB50 (2026-11-25): "No control TABLE on this screen", and the run
 * spent ten steps finding the FIELD[n] form.
 */
import { describe, expect, test } from "bun:test";
import type { DiagElement, DiagScreen, DiagTable, DiagWindow } from "../../src/diag/index.js";
import { resolveTarget, tableCell } from "../../src/sapgui-diag/index.js";

const cell = (column: number, text: string, kind: DiagElement["kind"] = "field") => ({ column, text, kind, input: true, hidden: false });

const TABLE: DiagTable = {
  name: "TABLE",
  program: "SAPLFSKB",
  title: "0 Items",
  row: 11,
  col: 1,
  width: 150,
  height: 5,
  columns: [
    { index: 0, position: 0, name: "ACGL_ITEM-HKONT", title: "G/L acct", width: 10, col: 4, visible: true },
    { index: 1, position: 1, name: "ACGL_ITEM-SHKZG", title: "D/C", width: 8, col: 16, visible: true },
    { index: 2, position: 2, name: "ACGL_ITEM-WRBTR", title: "Amount in doc.curr.", width: 16, col: 26, visible: true },
  ],
  rows: [0, 1].map((i) => ({ index: i, row: 12 + i, empty: true, cells: [cell(0, ""), { ...cell(1, "", "dropdown"), key: "" }, cell(2, "")] })),
  totalRows: 12,
  visibleRows: 5,
  path: [],
} as DiagTable;

const w = {
  index: 0,
  modal: false,
  title: "Enter G/L Account Document",
  program: "SAPMF05A",
  dynpro: "1001",
  guiStatus: "",
  guiStatusProgram: "",
  size: { rows: 20, cols: 156 },
  menus: [],
  toolbar: [],
  keys: [],
  elements: [],
  tabstrips: [],
  tables: [TABLE],
  controls: [],
  containers: [],
} as unknown as DiagWindow;
const s = { mode: 0, step: 1, session: { system: "ABA", client: "800", user: "U", language: "E" }, windows: [w] } as DiagScreen;

describe("a table cell by the table, row and col", () => {
  test("the column by title, SAP name, its last part or its place", () => {
    expect(tableCell(s, { do: "set", id: "TABLE", row: 0, col: "G/L acct", value: "476000" })).toEqual({ do: "set", id: "ACGL_ITEM-HKONT[0]", value: "476000" });
    expect(tableCell(s, { do: "set", id: "TABLE", row: 1, col: "ACGL_ITEM-WRBTR", value: "1" }).id).toBe("ACGL_ITEM-WRBTR[1]");
    expect(tableCell(s, { do: "set", id: "tblSAPLFSKBTABLE", row: 1, col: "wrbtr", value: "1" }).id).toBe("ACGL_ITEM-WRBTR[1]");
    expect(tableCell(s, { do: "combo", id: "TABLE", row: 0, col: "d/c", key: "Debit" }).id).toBe("ACGL_ITEM-SHKZG[0]");
    expect(tableCell(s, { do: "set", id: "TABLE", row: 0, col: "2", value: "1" }).id).toBe("ACGL_ITEM-WRBTR[0]");
    expect(resolveTarget(s, tableCell(s, { do: "set", id: "TABLE", row: 1, col: "G/L acct", value: "1" }))?.what).toBe("ACGL_ITEM-HKONT in row 1");
  });
  test("an unknown column is refused with the table's columns", () => {
    expect(() => tableCell(s, { do: "set", id: "TABLE", row: 0, col: "Cost center", value: "1" })).toThrow('The table TABLE has no column "Cost center": G/L acct ACGL_ITEM-HKONT, D/C ACGL_ITEM-SHKZG, Amount in doc.curr. ACGL_ITEM-WRBTR');
  });
  test("other shapes are left as they are", () => {
    const select = { do: "select", id: "TABLE", row: 1 };
    expect(tableCell(s, select)).toBe(select);
    const field = { do: "set", id: "ACGL_ITEM-HKONT[0]", value: "1" };
    expect(tableCell(s, field)).toBe(field);
    const other = { do: "set", id: "NOT_A_TABLE", row: 0, col: "x", value: "1" };
    expect(tableCell(s, other)).toBe(other);
  });
});
