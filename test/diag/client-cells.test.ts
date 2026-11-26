/**
 * SAP GUI sends the cells of a table control typed into with its request (item 09/09: per cell its line on
 * show, its column, both 1-based, and its text). In FB50's captured requests the D/C cell went out blank
 * right after a choice in it (2026-11-25): the choice had not reached the cell. The decoder reads these
 * cells: the table holds what SAP GUI sent, and the driver can tell "SAP GUI did not have it" from "SAP
 * did not take it".
 */
import { describe, expect, test } from "bun:test";
import { DiagDecoder } from "../../src/diag/decoder.js";
import { areaLevel, areaName, END, idItem, message, RESET, screenHead, tableControl } from "./build.js";

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
/** SAP GUI's table cells in a request: line and column (1-based), 0x65, the text, NUL. */
const cells = (...c: [number, number, string][]) => idItem(0x09, 0x09, Buffer.concat(c.map(([line, col, text]) => Buffer.concat([u16(line), u16(col), Buffer.from([0x65]), Buffer.from(text, "latin1"), Buffer.from([0])]))));

const screen = () =>
  message([
    ...screenHead({ tcode: "FB50", program: "SAPMF05A", dynpro: "1001" }),
    RESET,
    areaLevel(5, 11, 1, 90, 6),
    areaName("TABLE", "SAPLFSKB", "0100"),
    ...tableControl({ program: "SAPLFSKB", name: "TABLE", title: "", columns: [{ name: "ACGL_ITEM-HKONT", title: "G/L acct", width: 10 }, { name: "ACGL_ITEM-SHKZG", title: "D/C", width: 8 }, { name: "ACGL_ITEM-WRBTR", title: "Amount", width: 16 }], rows: [{ values: ["", "", ""] }, { values: ["", "", ""] }], first: 0 }),
    END,
  ]);

describe("table cells in SAP GUI's request", () => {
  test("are the cells' text, and the decoder keeps the last request's cells", () => {
    const d = new DiagDecoder();
    d.push(1, screen());
    d.push(0, message([RESET, areaLevel(5, 11, 1, 90, 6), cells([1, 1, "476000    "], [1, 2, " "], [2, 1, "113100    "])], { info: 0 }));
    const t = d.screen()?.windows[0]?.tables[0];
    expect(t?.rows[0]?.cells[0]?.text).toBe("476000");
    expect(t?.rows[1]?.cells[0]?.text).toBe("113100");
    expect(d.sentCells(0)).toEqual([
      { table: "TABLE", index: 0, column: 0, text: "476000" },
      { table: "TABLE", index: 0, column: 1, text: "" },
      { table: "TABLE", index: 1, column: 0, text: "113100" },
    ]);
  });
});
