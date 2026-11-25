/**
 * A table control narrower than its columns shows the left ones; the others are reached with its
 * horizontal scrollbar, which the DIAG method does not move. A click computed for a cell right of the edge
 * lands on another cell: seen live in ME21N (2026-11-25), where "set MEPO1211-BANFN[0]" answered "typed"
 * and the value went into another field. Such cells are refused before any input, for every action that
 * clicks, and dropdowns too.
 */
import { describe, expect, test } from "bun:test";
import type { Action } from "../../src/core/types.js";
import type { DiagScreen, DiagTable, DiagWindow } from "../../src/diag/index.js";
import { cellMetrics, cellPoint } from "../../src/sapgui-diag/geometry.js";
import { resolveTarget } from "../../src/sapgui-diag/index.js";
import { type Geometry, lastClickRow, planCombo, planPlain, planScreenScroll, planTabOn } from "../../src/sapgui-diag/plan.js";

const cell = (column: number, text: string, kind: "field" | "dropdown" | "checkbox" = "field") => ({ column, text, kind, input: true, hidden: false, ...(kind === "dropdown" ? { key: "", valueList: "0123456789ABCDEF0123456789ABCDEF" } : {}) });
const TABLE = {
  name: "TC_1211",
  program: "SAPLFSKB",
  title: "",
  row: 10,
  col: 1,
  width: 60,
  height: 4,
  columns: [
    { index: 0, position: 0, name: "MEPO1211-EMATN", title: "Material", width: 18, col: 3, visible: true },
    { index: 1, position: 1, name: "MEPO1211-MENGE", title: "PO Quantity", width: 13, col: 22, visible: true },
    { index: 2, position: 2, name: "MEPO1211-BANFN", title: "Purch.Req.", width: 10, col: 36, visible: true },
    { index: 3, position: 3, name: "MEPO1211-BNFPO", title: "Item of Requisition", width: 10, col: 64, visible: false },
    { index: 4, position: 4, name: "MEPO1211-KNTTP", title: "A", width: 2, col: 75, visible: false },
    { index: 5, position: 5, name: "MEPO1211-XFLAG", title: "F", width: 1, col: 78, visible: false },
  ],
  rows: [{ index: 0, row: 11, empty: false, cells: [cell(0, "M-01"), cell(1, ""), cell(2, ""), cell(3, ""), cell(4, "", "dropdown"), cell(5, "", "checkbox")] }],
  totalRows: 1,
  visibleRows: 4,
  path: [],
} as unknown as DiagTable;
const w = { index: 0, modal: false, title: "Create Purchase Order", program: "SAPLMEGUI", dynpro: "0014", guiStatus: "", guiStatusProgram: "", size: { rows: 20, cols: 156 }, menus: [], toolbar: [], keys: [], elements: [], tabstrips: [], tables: [TABLE], controls: [], containers: [] } as unknown as DiagWindow;
const s = { mode: 0, step: 1, session: { system: "ABA", client: "800", user: "U", language: "E" }, windows: [w] } as DiagScreen;
const AREA: [number, number, number, number] = [8, 128, 1264, 571];
const CELLS = cellMetrics(AREA, { rows: 20, cols: 156 }, { cw: 8, ch: 27 });
const geo: Geometry = { at: (win, row, col, width = 1) => cellPoint(AREA, win.size, row, col, width, CELLS), cells: CELLS, controls: [] };
const plan = (a: Action) => planPlain(s, a, resolveTarget(s, a), geo);

describe("a table cell right of what SAP GUI shows", () => {
  test("set reaches it with Tab from the nearest cell on show that takes text, one Tab per input cell", () => {
    const p = plan({ do: "set", id: "MEPO1211-XFLAG[0]", value: "X" });
    expect(p.steps.map((x) => (x.do === "vk" ? `vk${x.vk}${x.shift ? "+" : ""}${"count" in x && x.count ? `x${x.count}` : ""}` : x.do))).toEqual(["click", "vk9x3", "vk36", "vk35+", "vk46", "type"]);
    expect(p.sideways).toBe("TC_1211");
    expect(p.note).toContain("reached with Tab from MEPO1211-BANFN");
    const [x] = cellPoint(AREA, { rows: 20, cols: 156 }, 11, 36, 10, CELLS);
    expect(p.steps[0]).toMatchObject({ do: "click", x });
  });
  test("set is refused when no cell on show to its left takes text", () => {
    const noAnchor = { ...TABLE, rows: [{ ...TABLE.rows[0], cells: TABLE.rows[0]?.cells.map((c, i) => (i < 3 ? { ...c, input: false } : c)) }] } as DiagTable;
    const s2 = { ...s, windows: [{ ...w, tables: [noAnchor] }] } as DiagScreen;
    const a = { do: "set", id: "MEPO1211-BNFPO[0]", value: "10" };
    expect(() => planPlain(s2, a, resolveTarget(s2, a), geo)).toThrow('the column "Item of Requisition" is right of the part of the table TC_1211 that SAP GUI shows (up to "Purch.Req."), and this method cannot scroll a table sideways: nothing was done');
  });
  test("the other inputs are refused before any input", () => {
    for (const d of ["click", "focus", "f4", "dblclick"]) expect(() => plan({ do: d, id: "MEPO1211-BNFPO[0]" })).toThrow("cannot scroll a table sideways");
    expect(() => plan({ do: "check", id: "MEPO1211-XFLAG[0]" })).toThrow("cannot scroll a table sideways");
    expect(() => planCombo(s, { do: "combo", id: "MEPO1211-KNTTP[0]", key: "K" }, geo)).toThrow("cannot scroll a table sideways");
  });
  test("a cell on show is typed into as before", () => {
    expect(plan({ do: "set", id: "MEPO1211-BANFN[0]", value: "10000001" }).steps.map((x) => x.do)).toEqual(["set"]);
  });
});

describe("a row under the scroll bars of SAP GUI's window", () => {
  // VA01's overview: a screen of 21 rows in a window that shows 20; the second item line is row 19.
  const va01 = { ...w, scroll: { rows: 21, cols: 156, firstRow: 0, firstCol: 0, visibleRows: 20, visibleCols: 156 }, tables: [{ ...TABLE, rows: [{ ...TABLE.rows[0], index: 0, row: 18 }, { ...TABLE.rows[0], index: 1, row: 19 }] }] } as unknown as DiagWindow;
  const s3 = { ...s, windows: [va01] } as DiagScreen;
  const p3 = (a: Action) => planPlain(s3, a, resolveTarget(s3, a), geo);
  test("is refused, with the scroll that brings the row up", () => {
    expect(lastClickRow(va01)).toBe(18);
    expect(lastClickRow(w)).toBe(19);
    // A popup's last row holds its answer buttons: on show.
    expect(lastClickRow({ ...va01, index: 1, modal: true } as DiagWindow)).toBe(Number.MAX_SAFE_INTEGER);
    expect(p3({ do: "set", id: "MEPO1211-EMATN[0]", value: "M-12" }).steps.map((x) => x.do)).toEqual(["set"]);
    expect(() => p3({ do: "set", id: "MEPO1211-EMATN[1]", value: "M-13" })).toThrow('under its scroll bars, where a click lands elsewhere: nothing was done. Scroll the table so that the row comes up ({"do":"scroll","id":"TC_1211","to":1})');
    expect(() => p3({ do: "click", id: "MEPO1211-EMATN[1]" })).toThrow("under its scroll bars");
  });
});

describe("a screen taller than SAP GUI's window", () => {
  // VA05's selection screen: 29 rows in a window of 20; after a wheel scroll SAP says the first row on show is 1.
  const sel = (firstRow: number) => ({ ...w, tables: [], elements: [{ kind: "field", name: "SVKORG-LOW", text: "1000", row: 19, col: 34, width: 4, input: true, hidden: false, path: [], etype: 130 }, { kind: "field", name: "SDOC-LOW", text: "", row: 0, col: 34, width: 10, input: true, hidden: false, path: [], etype: 130 }], scroll: { rows: 29, cols: 118, firstRow, firstCol: 0, visibleRows: 20, visibleCols: 156 } }) as unknown as DiagWindow;
  const p4 = (win: DiagWindow, a: Action) => {
    const sc = { ...s, windows: [win] } as DiagScreen;
    return planPlain(sc, a, resolveTarget(sc, a), geo);
  };
  test("a field below the window is refused with the screen's scroll; scrolled, it is in reach", () => {
    expect(() => p4(sel(0), { do: "set", id: "SVKORG-LOW", value: "" })).toThrow('Scroll the screen down ({"do":"scroll","id":"screen","to":"next"}), send Enter, then act on it.');
    expect(p4(sel(1), { do: "set", id: "SVKORG-LOW", value: "" }).steps.map((x) => x.do)).toEqual(["set"]);
    expect(() => p4(sel(1), { do: "set", id: "SDOC-LOW", value: "1" })).toThrow("above what SAP GUI's window shows");
  });
  test("the screen scrolls with the mouse wheel; a screen that fits does not", () => {
    expect(planScreenScroll(sel(0), "next", geo).steps).toMatchObject([{ do: "wheel", notches: -6 }]);
    expect(planScreenScroll(sel(1), "prev", geo).steps).toMatchObject([{ do: "wheel", notches: 6 }]);
    expect(() => planScreenScroll(w, "next", geo)).toThrow("does not scroll");
  });
});

describe("a second cell further right in the row the cursor is in", () => {
  // ME21N: the requisition number, then its item, two columns on (2026-11-25: SAP wants both in one step).
  test("goes on with Tab from the cell typed before, with no click", () => {
    const p = planTabOn(TABLE, 0, 2, 3, "MEPO1211-BNFPO in row 0", "10");
    expect(p?.steps.map((x) => x.do)).toEqual(["vk", "vk", "vk", "vk", "type"]);
    expect(p?.steps[0]).toMatchObject({ vk: 9, count: 1 });
    expect(planTabOn(TABLE, 0, 2, 5, "x", "X")?.steps[0]).toMatchObject({ count: 3 });
    expect(planTabOn(TABLE, 0, 3, 2, "x", "1")).toBeUndefined();
  });
});

describe("Tab reach only where it was checked", () => {
  test("ME21N's items (SAPLMEGUI): a cell right of the edge is refused, not reached with Tab", () => {
    const me21n = { ...TABLE, program: "SAPLMEGUI" } as DiagTable;
    const s5 = { ...s, windows: [{ ...w, tables: [me21n] }] } as DiagScreen;
    const a = { do: "set", id: "MEPO1211-BNFPO[0]", value: "10" };
    expect(() => planPlain(s5, a, resolveTarget(s5, a), geo)).toThrow("cannot scroll a table sideways");
    expect(planTabOn(me21n, 0, 2, 3, "x", "10")).toBeUndefined();
  });
});
