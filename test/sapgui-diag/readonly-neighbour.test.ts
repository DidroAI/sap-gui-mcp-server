/**
 * MIGO keeps a key in a read-only field and takes it typed into the field beside it, which shows the text
 * (GOITEM-LGORT "0001" read-only, GOITEM-LGOBE open: round 1, P2P-01, 2026-11-26: eight tries on LGORT, and S/4's
 * INV-02 the same with GODYNPRO-MATNR). A set into a read-only field names the open field next to it.
 */
import { describe, expect, test } from "bun:test";
import type { DiagElement, DiagScreen, DiagWindow } from "../../src/diag/index.js";
import { cellMetrics, cellPoint } from "../../src/sapgui-diag/geometry.js";
import { resolveTarget } from "../../src/sapgui-diag/index.js";
import { type Geometry, planPlain } from "../../src/sapgui-diag/plan.js";

const el = (e: Partial<DiagElement> & { name: string; row: number; col: number }): DiagElement => ({ kind: "field", text: "", width: 10, input: true, hidden: false, path: ["DETAIL"], etype: 130, ...e }) as DiagElement;
const w = { index: 0, modal: false, title: "Goods Receipt", program: "SAPLMIGO", dynpro: "0001", size: { rows: 20, cols: 124 }, menus: [], toolbar: [], keys: [], elements: [el({ kind: "label", name: "", text: "Stor. Location", row: 13, col: 2, input: false }), el({ name: "GOITEM-LGOBE", row: 13, col: 16, width: 16 }), el({ name: "GOITEM-LGORT", row: 13, col: 33, width: 4, input: false, text: "" }), el({ name: "GOITEM-WERKS", row: 12, col: 33, width: 4, input: false }), el({ name: "GODYNPRO-MAKTX", row: 15, col: 16, width: 40 }), el({ name: "GODYNPRO-MATNR", row: 16, col: 16, width: 18, input: false })], tabstrips: [], tables: [], controls: [], containers: [] } as unknown as DiagWindow;
const s = { mode: 0, step: 1, session: {}, windows: [w] } as DiagScreen;
const AREA: [number, number, number, number] = [8, 128, 1264, 571];
const CELLS = cellMetrics(AREA, { rows: 20, cols: 124 }, { cw: 8, ch: 27 });
const geo: Geometry = { at: (win, row, col, width = 1) => cellPoint(AREA, win.size, row, col, width, CELLS), cells: CELLS, controls: [] };

describe("set into a read-only field", () => {
  test("names the field beside it that takes input", () => {
    const a = { do: "set", id: "GOITEM-LGORT", value: "0001" };
    expect(() => planPlain(s, a, resolveTarget(s, a), geo)).toThrow("field GOITEM-LGORT is read-only. The field beside it that takes input is GOITEM-LGOBE (SAP may take the key typed there)");
  });
  test("or the one right above it (S/4's MIGO)", () => {
    const a = { do: "set", id: "GODYNPRO-MATNR", value: "RM20" };
    expect(() => planPlain(s, a, resolveTarget(s, a), geo)).toThrow("The field above it that takes input is GODYNPRO-MAKTX");
  });
  test("says nothing more when no open field is beside it", () => {
    const a = { do: "set", id: "GOITEM-WERKS", value: "1000" };
    expect(() => planPlain(s, a, resolveTarget(s, a), geo)).toThrow(/^field GOITEM-WERKS is read-only\.$/);
  });
});
