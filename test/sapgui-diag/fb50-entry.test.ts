/**
 * Entering G/L items in FB50's table control, as an agent writes it in one batch (live 2026-11-25, FIN-01:
 * 19 steps on the DIAG method against 6 on scripting):
 * - "set" on the D/C dropdown was refused ("does not take text"), where scripting and Web GUI take it: it now
 *   chooses the entry, as "combo" does;
 * - after a cell right of the table's edge was reached with Tab (SAP GUI scrolled the table sideways), a set
 *   in the next row was refused until Enter, also in the columns that do not move: FB50 keeps G/L account,
 *   D/C and amount fixed at the left, and those stay where they were.
 */
import { describe, expect, test } from "bun:test";
import { cell, type DiagTable, fakeDriver, screen, sent, win } from "./fake-driver.js";

const col = (index: number, name: string, title: string, width: number, at: number, visible = true) => ({ index, position: index, name, title, width, col: at, visible });

const TABLE: DiagTable = {
  name: "TABLE",
  program: "SAPLFSKB",
  title: "0 Items",
  row: 11,
  col: 1,
  width: 60,
  height: 5,
  columns: [
    col(0, "ACGL_ITEM-HKONT", "G/L acct", 10, 3),
    col(1, "ACGL_ITEM-SHKZG", "D/C", 8, 14),
    col(2, "ACGL_ITEM-WRBTR", "Amount in doc.curr.", 16, 23),
    col(3, "ACGL_ITEM-ZUONR", "Assignment", 18, 40),
    col(4, "ACGL_ITEM-SGTXT", "Text", 30, 59, false),
    col(5, "ACGL_ITEM-KOSTL", "Cost center", 10, 90, false),
  ],
  rows: [0, 1].map((i) => ({ index: i, row: 12 + i, empty: true, cells: [cell(0, ""), cell(1, "", "dropdown"), cell(2, ""), cell(3, ""), cell(4, ""), cell(5, "")] })),
  totalRows: 12,
  visibleRows: 5,
  fixedColumns: 3,
  path: [],
} as unknown as DiagTable;

const s = screen([win({ title: "Enter G/L Account Document", tables: [TABLE] })]);
const ENTRIES = [
  { key: "S", value: "Debit" },
  { key: "H", value: "Credit" },
];

describe("set on a dropdown chooses its entry", () => {
  test("a dropdown cell of a table: navigate for the guard, one choice for SAP GUI", async () => {
    const f = fakeDriver(s, ENTRIES);
    const a = { do: "set", id: "TABLE", row: 0, col: "D/C", value: "S" };
    expect((await f.d.assess(a)).risk).toBe("navigate");
    const said = await f.d.act(a);
    expect(sent(f)).toEqual(["combo"]);
    expect(said).toContain('chose S "Debit" in ACGL_ITEM-SHKZG[0]');
  });
  test("by the entry's text too, and a dropdown field of the screen", async () => {
    const field = screen([win({ elements: [{ kind: "dropdown", name: "ZHDR-SIDE", text: "", key: "", valueList: "LIST1", row: 2, col: 20, width: 10, input: true, hidden: false, path: [], etype: 0 }] })]);
    const f = fakeDriver(field, ENTRIES);
    expect((await f.d.assess({ do: "set", id: "ZHDR-SIDE", value: "Credit" })).risk).toBe("navigate");
    expect(await f.d.act({ do: "set", id: "ZHDR-SIDE", value: "Credit" })).toContain('chose H "Credit"');
    expect(sent(f)).toEqual(["combo"]);
  });
  test("an entry the dropdown does not have is refused with its entries, nothing sent", async () => {
    const f = fakeDriver(s, ENTRIES);
    await expect(f.d.act({ do: "set", id: "ACGL_ITEM-SHKZG[0]", value: "X" })).rejects.toThrow('has no entry "X"');
    expect(sent(f)).toEqual([]);
  });
});

describe("after a cell reached with Tab, the fixed columns of the table stay in reach", () => {
  test("cost center by Tab, then G/L account, D/C and amount of the next row; a column that moved is refused", async () => {
    const f = fakeDriver(s, ENTRIES);
    await f.d.act({ do: "set", id: "ACGL_ITEM-KOSTL[0]", value: "1000" });
    expect(sent(f)).toEqual(["click", "vk", "vk", "vk", "vk", "type"]);
    await f.d.act({ do: "set", id: "ACGL_ITEM-HKONT[1]", value: "113100" });
    await f.d.act({ do: "set", id: "TABLE", row: 1, col: "D/C", value: "H" });
    await f.d.act({ do: "set", id: "ACGL_ITEM-WRBTR[1]", value: "125,40" });
    expect(sent(f).slice(6)).toEqual(["set", "combo", "set"]);
    // Assignment is right of the fixed columns: SAP GUI moved it, so where it is is not known until SAP's next screen.
    await expect(f.d.act({ do: "set", id: "ACGL_ITEM-ZUONR[1]", value: "A" })).rejects.toThrow("scrolled the table TABLE sideways");
  });
});
