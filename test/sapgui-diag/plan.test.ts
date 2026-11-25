/**
 * Action planning of the DIAG method on synthetic screens: which keys and
 * points the input host gets for which action, and what is expected of
 * SAP. No SAP GUI, no SAP data.
 */
import { describe, expect, test } from "bun:test";
import type { Action } from "../../src/core/types.js";
import type { DiagControl, DiagElement, DiagScreen, DiagTable, DiagWindow } from "../../src/diag/index.js";
import { assessDiag, resolveTarget } from "../../src/sapgui-diag/index.js";
import { cellMetrics, cellPoint, cellsFromEnv, type HostWindow, pickWindow } from "../../src/sapgui-diag/geometry.js";
import { type Geometry, namedControl, planCombo, planGrid, planGridScroll, planPage, planPlain, planTableRow, planToolbar, planTree, position, scrollTarget, VK } from "../../src/sapgui-diag/plan.js";

function el(e: Partial<DiagElement> & { name: string; row: number; col: number }): DiagElement {
  return { kind: "field", text: "", width: 10, input: true, hidden: false, path: [], etype: 130, ...e } as DiagElement;
}

const TREE: DiagControl = {
  id: 7,
  kind: "tree",
  type: "SAPGUI.TreeCtrl.1",
  container: "TREE_CONT",
  area: { row: 4, col: 0, width: 40, height: 10 },
  tree: {
    headers: [],
    nodes: [
      { key: "R", parent: "", depth: 0, text: "Root", items: {}, folder: true, expanded: true, hidden: false, disabled: false },
      { key: "A", parent: "R", depth: 1, text: "Texts", items: {}, folder: true, expanded: false, hidden: false, disabled: false },
      { key: "A1", parent: "A", depth: 2, text: "Header note", items: {}, folder: false, expanded: false, hidden: false, disabled: false },
      { key: "B", parent: "R", depth: 1, text: "Partners", items: {}, folder: true, expanded: false, hidden: false, disabled: false },
      { key: "C", parent: "R", depth: 1, text: "Dates", items: {}, folder: false, expanded: false, hidden: false, disabled: false },
    ],
  },
};

const GRID: DiagControl = {
  id: 9,
  kind: "grid",
  type: "SAPGUI.GridViewCtrl.1",
  container: "GRID_CONT",
  area: { row: 4, col: 50, width: 100, height: 14 },
  grid: {
    columns: [
      { name: "VBELN", title: "Document", titles: ["Document", "Doc."], tooltip: "", width: 10, position: 0 },
      { name: "KUNNR", title: "Customer", titles: ["Customer"], tooltip: "", width: 10, position: 1 },
      { name: "NETWR", title: "Net value", titles: ["Net value"], tooltip: "", width: 15, position: 2 },
    ],
    rows: [
      { index: 0, cells: ["100", "C1", "10,00"] },
      { index: 1, cells: ["101", "C2", "20,00"] },
      { index: 2, cells: ["102", "C3", "30,00"] },
    ],
    totalRows: 40,
  },
};

const TABLE: DiagTable = {
  name: "TC_ITEMS",
  program: "ZPROG",
  title: "Items",
  row: 20,
  col: 1,
  width: 80,
  height: 6,
  columns: [
    { index: 0, position: 0, name: "POSNR", title: "Item", width: 6, col: 3, visible: true },
    { index: 1, position: 1, name: "MATNR", title: "Material", width: 18, col: 10, visible: true },
  ],
  rows: [
    { index: 10, row: 22, empty: false, cells: [{ column: 0, text: "110", kind: "field", input: false, hidden: false }, { column: 1, text: "M-01", kind: "field", input: true, hidden: false }] },
    { index: 11, row: 23, empty: false, cells: [{ column: 0, text: "120", kind: "field", input: false, hidden: false }, { column: 1, text: "M-02", kind: "field", input: true, hidden: false }] },
    { index: 12, row: 24, empty: false, cells: [{ column: 0, text: "130", kind: "field", input: false, hidden: false }, { column: 1, text: "M-03", kind: "dropdown", key: "A", input: true, hidden: false }] },
  ],
  totalRows: 30,
  visibleRows: 3,
  path: [],
};

function win(over: Partial<DiagWindow> = {}): DiagWindow {
  return {
    index: 0,
    modal: false,
    title: "Synthetic Order: Overview",
    program: "ZPROG",
    dynpro: "0100",
    guiStatus: "S",
    guiStatusProgram: "ZPROG",
    size: { rows: 30, cols: 156 },
    menus: [],
    toolbar: [{ vkey: 28, key: "Ctrl+F4", text: "Sort ascending", tooltip: "", icon: "", enabled: true }],
    keys: [{ vkey: 3, key: "F3", text: "Back", tooltip: "", icon: "", enabled: true }],
    elements: [
      el({ kind: "dropdown", name: "ZHDR-TYPE", key: "OR", valueList: "LIST1", row: 1, col: 20, width: 12 }),
      el({ kind: "dropdown", name: "ZHDR-MODE", key: "A", valueList: "LIST2", fcode: "MODE", row: 2, col: 20, width: 12 }),
    ],
    tabstrips: [{ name: "TABS", row: 3, col: 0, width: 150, height: 1, path: [], tabs: [{ id: "T\\01", name: "T1", text: "Header", fcode: "T\\01", active: true, index: 0, row: 3, col: 2 }] }],
    tables: [TABLE],
    controls: [TREE, GRID],
    containers: [],
    list: { rows: [{ row: 2, cells: [{ col: 1, text: "line", width: 4 }] }], totalRows: 200, firstRow: 0 },
    ...over,
  } as DiagWindow;
}

const screen = (windows: DiagWindow[] = [win()]): DiagScreen => ({ mode: 0, step: 1, session: { system: "XYZ", client: "100", user: "U", language: "E" }, windows }) as DiagScreen;

/** Quartz 100% as measured on screen: an area at (8,128), 8 x 27 px cells. Trees and grids sit where the cells say. */
const AREA: [number, number, number, number] = [8, 128, 1264, 837];
const CELLS = cellMetrics(AREA, { rows: 30, cols: 156 }, { cw: 8, ch: 27 });
const geo: Geometry = {
  at: (w, row, col, width = 1) => cellPoint(AREA, w.size, row, col, width, CELLS),
  cells: CELLS,
  controls: [
    { cls: "SAPTreeList", rect: [8, 128 + 27 * 4, 320, 270] },
    { cls: "SAPALVGrid", rect: [8 + 3 + 8 * 50, 128 + 27 * 4 + 30, 800, 360] },
  ],
};

const plan = (a: Action, s = screen()) => {
  switch (a.do) {
    case "tree":
      return planTree(s, a, geo);
    case "grid":
      return planGrid(s, a, geo);
    case "combo":
      return planCombo(s, a, geo);
    default:
      return planPlain(s, a, resolveTarget(s, a), geo);
  }
};
const keysOf = (p: { steps: { do: string; vk?: number; key?: number; count?: number; ctrl?: boolean; shift?: boolean }[] }) =>
  p.steps.map((x) => (x.do === "vk" ? `vk${x.ctrl ? "^" : ""}${x.shift ? "+" : ""}${x.vk}${x.count ? `x${x.count}` : ""}` : x.do === "key" ? `key${x.key}` : x.do));

describe("cells", () => {
  test("the cell size SAP GUI reports wins over the area's size, and gives the points measured at Quartz 100%", () => {
    const fromArea = cellMetrics([8, 128, 1264, 571], { rows: 20, cols: 156 });
    const fromTraffic = cellMetrics([8, 128, 1264, 571], { rows: 20, cols: 156 }, { cw: 8, ch: 27 });
    expect([fromArea.cw, fromArea.ch, fromArea.x0, fromArea.y0]).toEqual([8, 27, 3, 25]);
    expect([fromTraffic.cw, fromTraffic.ch, fromTraffic.source]).toEqual([8, 27, "traffic"]);
    // The same point as before the change, for VA01's order type (row 2, col 22, width 4).
    expect(cellPoint([8, 128, 1264, 571], { rows: 20, cols: 156 }, 2, 22, 4, fromTraffic)).toEqual(cellPoint([8, 128, 1264, 571], { rows: 20, cols: 156 }, 2, 22, 4));
  });
  test("a larger font (125% scaling) moves the points with it", () => {
    const c = cellMetrics([10, 160, 1580, 714], { rows: 20, cols: 156 }, { cw: 10, ch: 34 });
    expect(cellPoint([10, 160, 1580, 714], { rows: 20, cols: 156 }, 2, 22, 4, c)).toEqual([10 + 4 + 220 + 20, 160 + 68 + 31]);
  });
  test("a calibration by hand", () => {
    expect(cellsFromEnv("9,30")).toMatchObject({ cw: 9, ch: 30, x0: 3, y0: 27, source: "env" });
    expect(cellsFromEnv("9,30,5,12")).toMatchObject({ x0: 5, y0: 12 });
    expect(cellsFromEnv("x")).toBeUndefined();
  });
});

describe("windows of several sessions", () => {
  const two: HostWindow[] = [
    { hwnd: 11, kind: "session", title: "SAP Easy Access", status: "" },
    { hwnd: 22, kind: "session", title: "SAP Easy Access", status: "Order 4711 saved", foreground: true },
  ];
  test("one window with the title: matched and remembered", () => {
    const bound = new Map<number, string>();
    const w = pickWindow([{ hwnd: 11, kind: "session", title: "VA03" }, { hwnd: 22, kind: "session", title: "SAP Easy Access" }], { key: "0:0", title: "VA03" }, bound, () => true);
    expect(w).toMatchObject({ hwnd: 11 });
    expect(bound.get(11)).toBe("0:0");
  });
  test("two windows with the same title and two routed modes that show it: the remembered one, not the one in front", () => {
    const bound = new Map([[11, "0:0"]]);
    expect(pickWindow(two, { key: "0:0", title: "SAP Easy Access", routed: 2 }, bound, () => true)).toMatchObject({ hwnd: 11 });
    // the other mode gets the other window, without a guess
    expect(pickWindow(two, { key: "0:1", title: "SAP Easy Access", routed: 2 }, bound, () => true)).toMatchObject({ hwnd: 22 });
    expect(bound.get(22)).toBe("0:1");
  });
  test("two unbound windows: the status bar tells them apart, else a refusal (the window in front is no proof)", () => {
    expect(pickWindow(two, { key: "0:1", title: "SAP Easy Access", status: "Order 4711 saved" }, new Map(), () => true)).toMatchObject({ hwnd: 22 });
    const front = new Map<number, string>();
    expect(pickWindow(two, { key: "0:1", title: "SAP Easy Access" }, front, () => true)).toContain("nothing tells which one is this session");
    expect(front.size).toBe(0);
  });
  test("a binding of a closed mode is dropped", () => {
    const bound = new Map([[11, "0:0"]]);
    expect(pickWindow([two[0] as HostWindow], { key: "1:0", title: "SAP Easy Access" }, bound, (k) => k !== "0:0")).toMatchObject({ hwnd: 11 });
    expect(bound.get(11)).toBe("1:0");
  });
  test("no window with the title", () => {
    expect(pickWindow(two, { key: "0:0", title: "VA01" }, new Map(), () => true)).toContain('No SAP GUI window titled "VA01"');
  });
});

describe("trees: the keyboard from the first line", () => {
  test("expand a closed folder: click the first line, Home, Down to its line, Right", () => {
    const p = plan({ do: "tree", id: "TREE_CONT", node: "A", how: "expand" });
    expect(keysOf(p)).toEqual(["click", `vk${VK.HOME}`, `vk${VK.DOWN}x1`, `vk${VK.RIGHT}`]);
    expect(p.answer).toBe("maybe"); // its children are in the traffic: SAP GUI opens it itself
    expect(p.tree).toEqual({ shell: 7, node: "A", expanded: true });
    const click = p.steps[0] as { x: number; y: number };
    expect(click.y).toBeGreaterThan(128 + 27 * 4);
    expect(click.y).toBeLessThan(128 + 27 * 4 + 24);
  });
  test("a folder whose children SAP has not sent: SAP GUI must ask, so a request is expected", () => {
    expect(plan({ do: "tree", id: "TREE_CONT", node: "B", how: "expand" }).answer).toBe("yes");
  });
  test("double-click a node: its line counted among the nodes on show, then Enter", () => {
    const p = plan({ do: "tree", id: "tree_cont", node: "C" });
    expect(keysOf(p)).toEqual(["click", `vk${VK.HOME}`, `vk${VK.DOWN}x3`, `vk${VK.ENTER}`]);
    expect(p.answer).toBe("yes");
  });
  test("a node in a closed folder is refused with the folder to open; after a keyboard expand it is reachable", () => {
    expect(() => plan({ do: "tree", id: "TREE_CONT", node: "A1", how: "select" })).toThrow("expand {A} first");
    const p = planTree(screen(), { do: "tree", id: "TREE_CONT", node: "A1", how: "select" }, geo, new Map([["A", true]]));
    expect(keysOf(p)).toEqual(["click", `vk${VK.HOME}`, `vk${VK.DOWN}x2`]);
  });
  test("a tree drawn below the top of its container (MMBE: HTML header, toolbar, column headers above it) is found", () => {
    const low: Geometry = { ...geo, controls: [{ cls: "SAPTreeList", rect: [8 + 11, 128 + 27 * 4 + 111, 300, 150] }] };
    const p = planTree(screen(), { do: "tree", id: "TREE_CONT", node: "C" }, low);
    const click = p.steps[0] as { x: number; y: number };
    expect(click.y).toBeGreaterThan(128 + 27 * 4 + 111);
    // A tree list outside the container is not taken for it.
    const away: Geometry = { ...geo, controls: [{ cls: "SAPTreeList", rect: [900, 700, 300, 150] }] };
    expect(() => planTree(screen(), { do: "tree", id: "TREE_CONT", node: "C" }, away)).toThrow("was not found on the screen");
  });
  test("already open, not a folder, unknown key", () => {
    expect(plan({ do: "tree", id: "TREE_CONT", node: "R", how: "expand" }).steps).toEqual([]);
    expect(() => plan({ do: "tree", id: "TREE_CONT", node: "C", how: "collapse" })).toThrow("not a folder");
    expect(() => plan({ do: "tree", id: "TREE_CONT", node: "Z" })).toThrow("No node {Z}");
  });
  test("a click on a node id ({KEY}) is a select, a double-click opens it", () => {
    expect(keysOf(plan({ do: "click", id: "{B}" }))).toEqual(["click", `vk${VK.HOME}`, `vk${VK.DOWN}x2`]);
    expect(keysOf(plan({ do: "dblclick", id: "{C}" })).at(-1)).toBe(`vk${VK.ENTER}`);
  });
});

describe("grids: Ctrl+Home, then the arrow keys", () => {
  test("double-click a cell: Down to the row, Right to the column, F2", () => {
    const p = plan({ do: "grid", id: "GRID_CONT", row: 2, col: "NETWR" });
    expect(keysOf(p)).toEqual(["click", `vk^${VK.HOME}`, `vk${VK.DOWN}x2`, `vk${VK.RIGHT}x2`, "key2"]);
    expect(p.answer).toBe("yes");
  });
  test("a column by its title; the cursor only; a row number past the end", () => {
    expect(keysOf(plan({ do: "grid", id: "GRID_CONT", row: 0, col: "Customer", how: "cell" }))).toEqual(["click", `vk^${VK.HOME}`, `vk${VK.RIGHT}x1`]);
    expect(() => plan({ do: "grid", id: "GRID_CONT", row: 40, col: "VBELN" })).toThrow("has 40 rows");
    expect(() => plan({ do: "grid", id: "GRID_CONT", row: 1, col: "NOPE" })).toThrow("No column");
  });
  test("select a row on the first page: its row selector by mouse, at the row's line", () => {
    const p = plan({ do: "grid", id: "GRID_CONT", row: 3, how: "select" });
    expect(keysOf(p)).toEqual(["click", `vk^${VK.HOME}`, "click"]);
    const sel = p.steps[2] as { x: number; y: number };
    expect(sel.x).toBe(8 + 3 + 400 + 4);
    expect(sel.y).toBe(128 + 108 + 30 + 26 * 4 + 13);
  });
  test("select a row further down: the keyboard, Shift+Space", () => {
    expect(keysOf(plan({ do: "grid", id: "GRID_CONT", row: 30, how: "select" })).slice(-1)).toEqual([`vk+${VK.SPACE}`]);
  });
  test("select with a row (the other surfaces' shape) and GRID[n] ids land on the same plan", () => {
    const viaId = plan({ do: "dblclick", id: "GRID_CONT[1]" });
    expect(keysOf(viaId)).toEqual(["click", `vk^${VK.HOME}`, `vk${VK.DOWN}x1`, "key2"]);
  });
  test("the value help's hit list: Down and Enter, no mouse", () => {
    const vh: DiagControl = { id: 3, kind: "grid", type: "SAP.TABControl.1", dynpro: { program: "SAPLSDH4", number: 100 }, grid: { columns: [], rows: [{ index: 0, cells: ["a"] }], totalRows: 5 } };
    const s = screen([win(), win({ index: 1, modal: true, controls: [vh], tables: [], elements: [] })]);
    expect(keysOf(planGrid(s, { do: "grid", id: "value-help", row: 3 }, geo))).toEqual([`vk${VK.DOWN}x3`, "key0"]);
  });
  test("scroll a grid to a row: Ctrl+Home and Down; next page: Page Down from the top row on show", () => {
    const n = namedControl(screen(), "GRID_CONT");
    if (n?.kind !== "grid") throw new Error("no grid");
    expect(keysOf(planGridScroll(n, 25, geo))).toEqual(["click", `vk^${VK.HOME}`, `vk${VK.DOWN}x25`]);
    expect(keysOf(planGridScroll(n, "next", geo))).toEqual(["click", `vk${VK.PAGEDOWN}`]);
    expect(keysOf(planGridScroll(n, "last", geo))).toEqual(["click", `vk^${VK.HOME}`, `vk^${VK.END}`]);
  });
});

describe("table controls and lists: SAP's page keys", () => {
  test("FIELD[n] is the table's own row number, as the view prints it", () => {
    const t = resolveTarget(screen(), { do: "set", id: "MATNR[11]", value: "X" });
    expect(t).toMatchObject({ kind: "cell", row: 23 });
    expect(resolveTarget(screen(), { do: "set", id: "MATNR[1]", value: "X" })).toBeUndefined();
  });
  test("position, and the target of a scroll", () => {
    const n = namedControl(screen(), "TC_ITEMS");
    if (!n) throw new Error("no table");
    const p = position(n);
    expect(p).toEqual({ first: 10, visible: 3, total: 30 });
    if (!p) return;
    expect(scrollTarget("next", p)).toBe(13);
    expect(scrollTarget("prev", p)).toBe(7);
    expect(scrollTarget("last", p)).toBe(27);
    expect(scrollTarget(11, p)).toBe(10); // on show: no scroll
    expect(scrollTarget(25, p)).toBe(25);
  });
  test("a page down: a click into the table's first row, then Page Down; up, first and last pages", () => {
    const n = namedControl(screen(), "TC_ITEMS");
    if (!n) throw new Error("no table");
    expect(keysOf(planPage(n, 13, geo) as never)).toEqual(["click", "key82"]);
    expect(keysOf(planPage(n, 7, geo) as never)).toEqual(["click", "key81"]);
    expect(keysOf(planPage(n, 0, geo) as never)).toEqual(["click", "key80"]);
    expect(keysOf(planPage(n, 27, geo) as never)).toEqual(["click", "key83"]);
    expect(planPage(n, 11, geo)).toBeUndefined();
  });
  test("a list pages without a click", () => {
    const n = namedControl(screen(), "list");
    if (!n) throw new Error("no list");
    expect(keysOf(planPage(n, 1, geo) as never)).toEqual(["key82"]);
  });
  test("select a table row: its row selector, left of the first column, on the row's line", () => {
    const n = namedControl(screen(), "TC_ITEMS");
    if (n?.kind !== "table") throw new Error("no table");
    const p = planTableRow(n, 11, geo);
    const [x, y] = cellPoint(AREA, { rows: 30, cols: 156 }, 23, 2, 1, CELLS);
    expect(p.steps).toEqual([{ do: "click", x: x - 3, y, settle: 100 }]);
    expect(() => planTableRow(n, 20, geo)).toThrow("scroll to it first");
  });
});

describe("dropdowns", () => {
  test("without a key: what the traffic knows, and nothing sent", () => {
    const p = plan({ do: "combo", id: "ZHDR-TYPE" });
    expect(p.steps).toEqual([]);
    expect(p.note).toContain('shows "OR"');
    expect(p.note).toContain("LIST1");
  });
  test("choose: click (opens the list), type the text, Enter; checked on the next screen", () => {
    const p = plan({ do: "combo", id: "ZHDR-TYPE", key: "Rush order" });
    expect(keysOf(p)).toEqual(["click", "type", `vk${VK.ENTER}`]);
    expect(p.answer).toBe("no");
    const next = (key: string) => screen([win({ elements: [el({ kind: "dropdown", name: "ZHDR-TYPE", key, row: 1, col: 20 })] })]);
    expect(p.later?.(next("OR"))).toContain("still has");
    expect(p.later?.(next("RO"))).toContain('now has the key "RO"');
  });
  test("a dropdown with a function code sends the choice at once", () => {
    const p = plan({ do: "combo", id: "ZHDR-MODE", key: "B" });
    expect(p.answer).toBe("yes");
    expect(p.confirm?.(screen([win({ elements: [el({ kind: "dropdown", name: "ZHDR-MODE", key: "B", row: 2, col: 20 })] })]), true)).toBe('ZHDR-MODE now has "B"');
  });
  test("a dropdown in a table cell, by the table's row number", () => {
    expect(namedControl(screen(), "MATNR[12]")).toMatchObject({ kind: "dropdown", element: { key: "A", row: 24 } });
  });
  test("already chosen; not a dropdown", () => {
    expect(plan({ do: "combo", id: "ZHDR-TYPE", key: "or" }).steps).toEqual([]);
    expect(() => plan({ do: "combo", id: "TC_ITEMS", key: "X" })).toThrow("not a dropdown");
  });
});

describe("toolbars", () => {
  test("a full-screen ALV list's button is a key of the screen", () => {
    // By its text, or by the words of a known ALV code: the traffic gives toolbar buttons no function code.
    expect(planToolbar(screen(), { do: "toolbar", id: "GRID_CONT", button: "Sort ascending" }, geo)).toMatchObject({ steps: [{ do: "key", key: 28 }], answer: "yes" });
    expect(planToolbar(screen(), { do: "toolbar", id: "GRID_CONT", button: "&SORT_ASC" }, geo)).toMatchObject({ steps: [{ do: "key", key: 28 }], answer: "yes" });
  });
  test("a grid's own toolbar: the host's buttons inside the grid's place, by function code words or text", () => {
    expect(planToolbar(screen(), { do: "toolbar", id: "GRID_CONT", button: "&MB_FILTER" }, geo)).toBe("need-buttons");
    const buttons = [
      { name: "Set Filter", tip: "Set Filter (Ctrl+F5)", enabled: true, x: 470, y: 250 },
      { name: "Set Filter", tip: "", enabled: true, x: 1500, y: 900 },
      { name: "Export", tip: "", enabled: false, x: 520, y: 250 },
    ];
    const p = planToolbar(screen(), { do: "toolbar", id: "GRID_CONT", button: "&MB_FILTER" }, geo, buttons);
    expect(p).toMatchObject({ steps: [{ do: "press", name: "Set Filter" }], answer: "maybe" });
    expect(() => planToolbar(screen(), { do: "toolbar", id: "GRID_CONT", button: "&MB_EXPORT" }, geo, buttons)).toThrow("greyed out");
    expect(() => planToolbar(screen(), { do: "toolbar", id: "GRID_CONT", button: "Graphic" }, geo, buttons)).toThrow("Its buttons: Set Filter, Export");
  });
});

describe("the actions of before keep their plans", () => {
  test("a tab goes through the command field; a field click stays in SAP GUI; F4 and buttons go to SAP", () => {
    expect(plan({ do: "select", id: "{T\\01}" })).toMatchObject({ steps: [{ do: "okcode", value: "T\\01" }], answer: "yes" });
    expect(plan({ do: "key", key: 3 })).toMatchObject({ steps: [{ do: "key", key: 3 }], answer: "yes" });
    expect(plan({ do: "set", id: "MATNR[10]", value: "a\nb" })).toMatchObject({ steps: [{ do: "set", value: "a b" }], answer: "no" });
  });
});

describe("the guard for the new actions", () => {
  const risk = (a: Action) => assessDiag(screen(), a, resolveTarget(screen(), a)).risk;
  test("reading and moving", () => {
    expect(risk({ do: "combo", id: "ZHDR-TYPE" })).toBe("read");
    expect(risk({ do: "combo", id: "ZHDR-TYPE", key: "X" })).toBe("navigate");
    expect(risk({ do: "scroll", id: "TC_ITEMS", to: "next" })).toBe("read");
    expect(risk({ do: "tree", id: "TREE_CONT", node: "A", how: "expand" })).toBe("read");
    expect(risk({ do: "tree", id: "TREE_CONT", node: "C" })).toBe("navigate");
    expect(risk({ do: "grid", id: "GRID_CONT", row: 0, col: "VBELN" })).toBe("navigate");
    expect(risk({ do: "select", id: "TC_ITEMS", row: 11 })).toBe("navigate");
  });
  test("toolbar buttons by their words", () => {
    expect(risk({ do: "toolbar", id: "GRID_CONT", button: "&SORT_ASC" })).toBe("navigate");
    expect(risk({ do: "toolbar", id: "GRID_CONT", button: "Sort ascending" })).toBe("navigate");
    expect(risk({ do: "toolbar", id: "GRID_CONT", button: "&DATA_SAVE" })).toBe("commit");
    expect(risk({ do: "toolbar", id: "GRID_CONT", button: "ZFOO" })).toBe("commit");
  });
});
