/**
 * `check` sets a box to the state asked for ("value", true when left out), as on the other surfaces: a box
 * already in that state is not clicked (a click would turn it the other way). Seen live in MI24's status
 * popup (2026-11-25): three checks with true, false, false clicked all three boxes, and SAP refused the
 * selection.
 */
import { describe, expect, test } from "bun:test";
import type { Action } from "../../src/core/types.js";
import type { DiagElement, DiagScreen, DiagTable, DiagWindow } from "../../src/diag/index.js";
import { cellMetrics, cellPoint } from "../../src/sapgui-diag/geometry.js";
import { resolveTarget, withTyped } from "../../src/sapgui-diag/index.js";
import { type Geometry, planPlain } from "../../src/sapgui-diag/plan.js";

function el(e: Partial<DiagElement> & { name: string; row: number; col: number }): DiagElement {
  return { kind: "field", text: "", width: 10, input: true, hidden: false, path: [], etype: 130, ...e } as DiagElement;
}

const TABLE: DiagTable = {
  name: "TC",
  program: "ZPROG",
  title: "",
  row: 10,
  col: 1,
  width: 40,
  height: 3,
  columns: [{ index: 0, position: 0, name: "ZPOS-SEL", title: "Sel", width: 2, col: 2, visible: true }],
  rows: [
    { index: 0, row: 11, empty: false, cells: [{ column: 0, text: "", kind: "checkbox", input: true, hidden: false, checked: true }] },
    { index: 1, row: 12, empty: false, cells: [{ column: 0, text: "", kind: "checkbox", input: true, hidden: false, checked: false }] },
  ],
  totalRows: 2,
  visibleRows: 2,
  path: [],
} as DiagTable;

const popup: DiagWindow = {
  index: 0,
  modal: false,
  title: "Status of Physical Inventory Item",
  program: "RM07IDIFH",
  dynpro: "0100",
  guiStatus: "",
  guiStatusProgram: "",
  size: { rows: 20, cols: 80 },
  menus: [],
  toolbar: [],
  keys: [],
  elements: [
    el({ kind: "checkbox", name: "IX-SELP1", text: "Not yet counted", row: 0, col: 0, width: 20, checked: true }),
    el({ kind: "checkbox", name: "IX-SELP2", text: "Only cntd.", row: 1, col: 0, width: 20, checked: false }),
    el({ kind: "radio", name: "R1", text: "One", row: 3, col: 0, width: 10, checked: true }),
  ],
  tabstrips: [],
  tables: [TABLE],
  controls: [],
  containers: [],
} as DiagWindow;

const s = { mode: 0, step: 1, session: { system: "XYZ", client: "100", user: "U", language: "E" }, windows: [popup] } as DiagScreen;
const AREA: [number, number, number, number] = [8, 128, 800, 600];
const CELLS = cellMetrics(AREA, { rows: 20, cols: 80 }, { cw: 8, ch: 27 });
const geo: Geometry = { at: (w, row, col, width = 1) => cellPoint(AREA, w.size, row, col, width, CELLS), cells: CELLS, controls: [] };
const plan = (sc: DiagScreen, a: Action) => planPlain(sc, a, resolveTarget(sc, a), geo);

describe("check: to the state asked for", () => {
  test("a box already in that state is not clicked", () => {
    expect(plan(s, { do: "check", id: "IX-SELP1", value: true }).steps).toEqual([]);
    expect(plan(s, { do: "check", id: "IX-SELP1" }).note).toContain("already ticked");
    expect(plan(s, { do: "check", id: "IX-SELP2", value: false }).steps).toEqual([]);
    expect(plan(s, { do: "check", id: "IX-SELP2", value: "false" }).note).toContain("already unticked");
    expect(plan(s, { do: "check", id: "ZPOS-SEL[0]", value: "X" }).steps).toEqual([]);
    expect(plan(s, { do: "check", id: "ZPOS-SEL[1]", value: false }).steps).toEqual([]);
  });
  test("a box in the other state is clicked once", () => {
    expect(plan(s, { do: "check", id: "IX-SELP1", value: false }).steps.map((x) => x.do)).toEqual(["click"]);
    expect(plan(s, { do: "check", id: "IX-SELP2", value: true }).steps.map((x) => x.do)).toEqual(["click"]);
    expect(plan(s, { do: "check", id: "ZPOS-SEL[1]" }).steps.map((x) => x.do)).toEqual(["click"]);
  });
  test("a box ticked earlier in this step counts as ticked", () => {
    const ticked = withTyped(s, [{ step: 1, window: 0, program: "RM07IDIFH", dynpro: "0100", name: "IX-SELP2", row: 1, col: 0, value: "", checked: true }]);
    expect(plan(ticked, { do: "check", id: "IX-SELP2", value: true }).steps).toEqual([]);
    expect(plan(ticked, { do: "check", id: "IX-SELP2", value: false }).steps.map((x) => x.do)).toEqual(["click"]);
  });
  test("a radio button is not turned off by a click", () => {
    expect(() => plan(s, { do: "check", id: "R1", value: false })).toThrow("another one of its group");
    expect(plan(s, { do: "check", id: "R1" }).steps).toEqual([]);
  });
});
