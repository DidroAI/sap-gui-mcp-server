/**
 * A subscreen that scrolls on its own (XD01's address tab: the window fits, the tab page does not): the
 * decoder marks what lies outside its area "scrolled out of view". A click computed for such an element
 * lands on what SAP GUI draws there instead (MD-01, live 2026-11-25: the language field "sits under the
 * window edge, and clicks miss"). So:
 * - set, click, check, combo... on an element scrolled out of view are refused before any input, with
 *   the scroll that brings it up;
 * - scroll "screen" turns the mouse wheel over the part of that subscreen on show, and, as for a screen
 *   taller than the window, where its fields are is known again after SAP's next screen.
 */
import { describe, expect, test } from "bun:test";
import type { Action } from "../../src/core/types.js";
import type { DiagElement, DiagScreen, DiagWindow } from "../../src/diag/index.js";
import { cellMetrics, cellPoint } from "../../src/sapgui-diag/geometry.js";
import { resolveTarget } from "../../src/sapgui-diag/index.js";
import { type Geometry, planCombo, planPlain, planScreenScroll } from "../../src/sapgui-diag/plan.js";

const PATH = ["SUBTAB:SAPLATAB:0100", "TABSTRIP100", "SUBSC", "ADDRESS:SAPLSZA1:0300"];
const el = (e: Partial<DiagElement> & { name: string; row: number; col: number }): DiagElement => ({ kind: "field", text: "", width: 10, input: true, hidden: false, path: PATH, etype: 130, ...e }) as DiagElement;
const w = {
  index: 0,
  modal: false,
  title: "Create Customer: General Data",
  program: "SAPMF02D",
  dynpro: "7000",
  guiStatus: "",
  guiStatusProgram: "",
  size: { rows: 20, cols: 156 },
  scroll: { rows: 17, cols: 148, firstRow: 0, firstCol: 0, visibleRows: 20, visibleCols: 156 },
  menus: [],
  toolbar: [],
  keys: [],
  elements: [
    el({ name: "RF02D-KUNNR", row: 0, col: 16, input: false, path: ["SUBKOPF:SAPMF02D:7001"] }),
    el({ name: "ADDR1_DATA-NAME1", row: 7, col: 23 }),
    el({ name: "ADDR1_DATA-CITY1", row: 15, col: 34 }),
    el({ name: "ADDR1_DATA-COUNTRY", row: 16, col: 23, scrolledOut: true }),
    el({ kind: "dropdown", name: "ADDR1_DATA-LANGU", key: "EN", valueList: "L", row: 24, col: 23, scrolledOut: true }),
    el({ kind: "checkbox", name: "ADDR1_DATA-FLAG", row: 25, col: 23, scrolledOut: true }),
  ],
  tabstrips: [],
  tables: [],
  controls: [],
  containers: [],
} as unknown as DiagWindow;
const s = { mode: 0, step: 1, session: { system: "ABA", client: "800", user: "U", language: "E" }, windows: [w] } as DiagScreen;
const AREA: [number, number, number, number] = [8, 128, 1264, 571];
const CELLS = cellMetrics(AREA, { rows: 20, cols: 156 }, { cw: 8, ch: 27 });
const geo: Geometry = { at: (win, row, col, width = 1) => cellPoint(AREA, win.size, row, col, width, CELLS), cells: CELLS, controls: [] };
const plan = (a: Action) => planPlain(s, a, resolveTarget(s, a), geo);

describe("an element of a subscreen scrolled out of view", () => {
  test("set reaches it with Tab from the field on show before it, when only fields lie between (SAP GUI scrolls to it)", () => {
    // Round 3, MD-01: the country right after the city, which is on show.
    const p = plan({ do: "set", id: "ADDR1_DATA-COUNTRY", value: "DE" });
    expect(p.steps.map((x) => x.do)).toEqual(["click", "vk", "vk", "vk", "vk", "type"]);
    expect(p.steps[1]).toMatchObject({ vk: 9, count: 1 });
    expect(p.note).toContain("reached with Tab from ADDR1_DATA-CITY1");
    const [x] = cellPoint(AREA, w.size, 15, 34, 10, CELLS);
    expect(p.steps[0]).toMatchObject({ do: "click", x });
  });
  test("with a button between, set is refused with the scroll", () => {
    const withButton = { ...w, elements: [...w.elements.slice(0, 3), el({ kind: "button", name: "", text: "More fields", fcode: "$2OC", row: 15, col: 80, width: 4, scrolledOut: false }), ...w.elements.slice(3)] } as unknown as DiagWindow;
    const s2 = { ...s, windows: [withButton] } as DiagScreen;
    const a = { do: "set", id: "ADDR1_DATA-COUNTRY", value: "DE" };
    expect(() => planPlain(s2, a, resolveTarget(s2, a), geo)).toThrow('ADDR1_DATA-COUNTRY is in a part of the screen that SAP GUI has scrolled out of view, where a click lands elsewhere: nothing was done. Scroll it down ({"do":"scroll","id":"screen","to":"next"}), send Enter, then act on it.');
  });
  test("click and check are refused with the scroll that brings it up", () => {
    expect(() => plan({ do: "click", id: "ADDR1_DATA-COUNTRY" })).toThrow("scrolled out of view");
    expect(() => plan({ do: "check", id: "ADDR1_DATA-FLAG" })).toThrow("scrolled out of view");
  });
  test("a dropdown too", () => {
    expect(() => planCombo(s, { do: "combo", id: "ADDR1_DATA-LANGU", key: "DE" }, geo)).toThrow("scrolled out of view");
  });
  test("an element on show is typed into as before", () => {
    expect(plan({ do: "set", id: "ADDR1_DATA-CITY1", value: "Heidelberg" }).steps.map((x) => x.do)).toEqual(["set"]);
  });
});

describe("scroll screen on a window that fits, with a subscreen that scrolls", () => {
  test("the wheel turns over the part of the subscreen on show", () => {
    const p = planScreenScroll(w, "next", geo);
    expect(p.steps).toHaveLength(1);
    const [x, y] = cellPoint(AREA, w.size, 15, 34, 10, CELLS);
    expect(p.steps[0]).toMatchObject({ do: "wheel", x, y });
    expect((p.steps[0] as { notches: number }).notches).toBeLessThan(0);
    expect(p.note).toContain("send Enter");
    expect((planScreenScroll(w, "prev", geo).steps[0] as { notches: number }).notches).toBeGreaterThan(0);
  });
  test("a window with nothing scrolled out still does not scroll", () => {
    const fits = { ...w, elements: w.elements.filter((e) => !e.scrolledOut) } as DiagWindow;
    expect(() => planScreenScroll(fits, "next", geo)).toThrow("does not scroll");
  });
});

describe("the field that has the cursor, in a part scrolled out of view", () => {
  // Round 2, MD-01: after "Fill out all required entry fields" SAP puts the cursor on the country and SAP GUI scrolls
  // the address tab to it, while SAP's own scroll position (what the view lays out by) says it is out of view.
  test("is typed into where the cursor is, with no click, when nothing was input since SAP's screen", async () => {
    const { fakeDriver, sent } = await import("./fake-driver.js");
    const withFocus = { ...s, windows: [{ ...w, focus: { row: 16, col: 23, name: "ADDR1_DATA-COUNTRY" } }] } as DiagScreen;
    const f = fakeDriver(withFocus);
    expect(await f.d.act({ do: "set", id: "ADDR1_DATA-COUNTRY", value: "DE" })).toContain('set ADDR1_DATA-COUNTRY = "DE"');
    expect(sent(f)).toEqual(["vk", "vk", "vk", "type"]);
    // After an input the cursor may have moved: reached with Tab from the city instead.
    expect(await f.d.act({ do: "set", id: "ADDR1_DATA-COUNTRY", value: "DE" })).toContain('set ADDR1_DATA-COUNTRY = "DE"');
    expect(sent(f).slice(4)).toEqual(["click", "vk", "vk", "vk", "vk", "type"]);
  });
});
