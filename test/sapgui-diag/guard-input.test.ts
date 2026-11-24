/**
 * The DIAG method's guard and planner judge the input that will reach SAP
 * GUI, not the verb of the action: synthetic screens, no SAP GUI.
 */
import { describe, expect, test } from "bun:test";
import type { Action } from "../../src/core/types.js";
import type { DiagControl, DiagElement, DiagScreen, DiagTable, DiagWindow } from "../../src/diag/index.js";
import { cellMetrics, cellPoint, type HostWindow, pickWindow } from "../../src/sapgui-diag/geometry.js";
import { DiagDecoder } from "../../src/diag/index.js";
import { assessDiag, DiagDriver, findTarget, noTargetText, resolveTarget } from "../../src/sapgui-diag/index.js";
import { DEFAULT_WAIT, Traffic, waitNote } from "../../src/sapgui-diag/traffic.js";
import { idItem, message, windowStart } from "../diag/build.js";
import { type Geometry, namedControl, planGrid, planPage, planPlain, planToolbar } from "../../src/sapgui-diag/plan.js";
import { TYPED_VKEYS } from "../../src/sapgui/keys.js";

function el(e: Partial<DiagElement> & { name: string; row: number; col: number }): DiagElement {
  return { kind: "field", text: "", width: 10, input: true, hidden: false, path: [], etype: 130, ...e } as DiagElement;
}

const cell = (column: number, text: string, kind: DiagElement["kind"] = "field") => ({ column, text, kind, input: true, hidden: false });

/** A table scrolled to row 10: rows 10 to 12 on show. Its first column is a checkbox. */
const TABLE: DiagTable = {
  name: "TC_ITEMS",
  program: "ZPROG",
  title: "Items",
  row: 20,
  col: 1,
  width: 80,
  height: 6,
  columns: [
    { index: 0, position: 0, name: "ZPOS-SEL", title: "Sel", width: 2, col: 2, visible: true },
    { index: 1, position: 1, name: "ZPOS-MATNR", title: "Material", width: 18, col: 6, visible: true },
    { index: 2, position: 2, name: "ZPOS-TYPE", title: "Type", width: 4, col: 26, visible: true },
  ],
  rows: [10, 11, 12].map((i) => ({ index: i, row: 12 + i, empty: false, cells: [cell(0, "", "checkbox"), cell(1, `M-${i}`), { ...cell(2, "A", "dropdown"), key: "A" }] })),
  totalRows: 30,
  visibleRows: 3,
  path: [],
};

const GRID: DiagControl = {
  id: 9,
  kind: "grid",
  type: "SAPGUI.GridViewCtrl.1",
  container: "GRID_CONT",
  area: { row: 4, col: 50, width: 100, height: 14 },
  grid: { columns: [{ name: "VBELN", title: "Document", titles: ["Document"], tooltip: "", width: 10, position: 0 }], rows: [{ index: 0, cells: ["100"] }], totalRows: 5 },
};

function main(over: Partial<DiagWindow> = {}): DiagWindow {
  return {
    index: 0,
    modal: false,
    title: "Synthetic Order: Change",
    program: "ZPROG",
    dynpro: "0100",
    guiStatus: "S",
    guiStatusProgram: "ZPROG",
    size: { rows: 30, cols: 156 },
    menus: [],
    toolbar: [],
    keys: [
      { vkey: 3, key: "F3", text: "Back", tooltip: "", icon: "", enabled: true },
      { vkey: 11, key: "Ctrl+S", text: "Save", tooltip: "", icon: "", enabled: true },
    ],
    elements: [
      el({ name: "ZHDR-NOTE", row: 1, col: 20 }),
      el({ kind: "button", name: "BT_DEL", text: "Delete", fcode: "DELE", row: 2, col: 2, width: 8 }),
      el({ kind: "checkbox", name: "ZHDR-RUSH", text: "Rush", fcode: "RUSH", row: 3, col: 2, width: 6 }),
      el({ kind: "checkbox", name: "ZHDR-FLAG", text: "Flag", row: 3, col: 20, width: 6 }),
      el({ kind: "other", name: "", text: "Post", row: 5, col: 2, width: 4, etype: 119 }),
    ],
    tabstrips: [{ name: "TABS", row: 6, col: 0, width: 150, height: 1, path: [], tabs: [{ id: "T\\01", name: "T1", text: "Items", fcode: "T\\01", active: true, index: 0, row: 6, col: 2 }] }],
    tables: [TABLE],
    controls: [GRID],
    containers: [],
    ...over,
  } as DiagWindow;
}

/** The popup that asks to save: Yes {OPT1}, No {OPT2}. */
function question(): DiagWindow {
  return main({
    index: 1,
    modal: true,
    title: "Save changes",
    program: "SAPLSPO1",
    dynpro: "0500",
    keys: [{ vkey: 12, key: "F12", text: "Cancel", tooltip: "", icon: "", enabled: true }],
    elements: [
      el({ kind: "label", name: "SPOP-TEXT", text: "Do you want to save the changes?", row: 1, col: 2, input: false, width: 40 }),
      el({ kind: "button", name: "SPOP-OPTION1", text: "Yes", fcode: "OPT1", row: 3, col: 2, width: 8 }),
      el({ kind: "button", name: "SPOP-OPTION2", text: "No", fcode: "OPT2", row: 3, col: 12, width: 8 }),
    ],
    tabstrips: [],
    tables: [],
    controls: [],
  });
}

const screen = (windows: DiagWindow[] = [main()]): DiagScreen => ({ mode: 0, step: 1, session: { system: "XYZ", client: "100", user: "U", language: "E" }, windows }) as DiagScreen;

const AREA: [number, number, number, number] = [8, 128, 1264, 837];
const CELLS = cellMetrics(AREA, { rows: 30, cols: 156 }, { cw: 8, ch: 27 });
const GRID_RECT: [number, number, number, number] = [8 + 3 + 8 * 50, 128 + 27 * 4 + 30, 800, 360];
const geo: Geometry = { at: (w, row, col, width = 1) => cellPoint(AREA, w.size, row, col, width, CELLS), cells: CELLS, controls: [{ cls: "SAPALVGrid", rect: GRID_RECT }] };

const assess = (s: DiagScreen, a: Action) => assessDiag(s, a, resolveTarget(s, a));
const plan = (s: DiagScreen, a: Action) => planPlain(s, a, resolveTarget(s, a), geo);

describe("finding 1: every action on a push button is judged as pressing it", () => {
  const s = screen([main(), question()]);
  test("press, focus, f4, check, set, click on Yes of a save question: all commit", () => {
    for (const d of ["press", "focus", "f4", "check", "set", "click", "dblclick", "select"]) expect([d, assess(s, { do: d, id: "{OPT1}", value: "x" }).risk]).toEqual([d, "commit"]);
  });
  test("focus, f4, check and set on a button are refused before any input: they would click it", () => {
    expect(() => plan(s, { do: "focus", id: "{OPT1}" })).toThrow('"focus" on button "Yes" was not done');
    expect(() => plan(s, { do: "f4", id: "{OPT1}" })).toThrow("Value help is for fields");
    expect(() => plan(s, { do: "check", id: "{OPT1}" })).toThrow("is not a checkbox or a radio button");
    expect(() => plan(s, { do: "set", id: "SPOP-OPTION1", value: "x" })).toThrow("does not take text");
  });
  test("the same on a Delete button of the main screen, and on a toolbar key", () => {
    const m = screen();
    expect(assess(m, { do: "focus", id: "{DELE}" }).risk).toBe("commit");
    expect(assess(m, { do: "focus", id: "Save" }).risk).toBe("commit");
    expect(() => plan(m, { do: "focus", id: "Save" })).toThrow("was not done");
    // A key named for focus used to be pressed at once.
    expect(() => plan(m, { do: "focus", id: "Back" })).toThrow("was not done");
  });
  test("a checkbox with a function code is pressed by a click: judged as its button; one without only changes input", () => {
    const m = screen();
    expect(assess(m, { do: "check", id: "ZHDR-RUSH" }).risk).toBe("commit");
    expect(plan(m, { do: "check", id: "ZHDR-RUSH" }).answer).toBe("yes");
    expect(assess(m, { do: "check", id: "ZHDR-FLAG" }).risk).toBe("navigate");
    expect(plan(m, { do: "check", id: "ZHDR-FLAG" }).answer).toBe("no");
    expect(() => plan(m, { do: "focus", id: "ZHDR-FLAG" })).toThrow("changes it");
  });
  test("focus on a tab or a list line is refused; on a field it is a click, nothing else", () => {
    const m = screen();
    expect(() => plan(m, { do: "focus", id: "{T\\01}" })).toThrow("was not done");
    expect(() => plan(m, { do: "focus", id: "@29,40" })).toThrow("a hotspot");
    expect(plan(m, { do: "focus", id: "ZHDR-NOTE" })).toMatchObject({ steps: [{ do: "click" }], answer: "no" });
    expect(assess(m, { do: "focus", id: "ZHDR-NOTE" }).risk).toBe("read");
  });
  test("set and check on table cells follow the cell's kind", () => {
    const m = screen();
    expect(() => plan(m, { do: "set", id: "ZPOS-SEL[10]", value: "X" })).toThrow('Use {"do":"check"');
    expect(plan(m, { do: "set", id: "ZPOS-MATNR[10]", value: "X" }).steps[0]?.do).toBe("set");
    expect(plan(m, { do: "check", id: "ZPOS-SEL[11]" }).steps[0]?.do).toBe("click");
  });
});

describe("finding 7: an element this reader cannot classify is never rated safer than a button", () => {
  const m = screen();
  test("a click or press on it: a write, with a short look for SAP's answer", () => {
    expect(assess(m, { do: "click", id: "@5,3" }).risk).toBe("commit");
    expect(assess(m, { do: "press", id: "@5,3" }).reason).toContain("cannot classify");
    expect(plan(m, { do: "click", id: "@5,3" }).answer).toBe("maybe");
    expect(() => plan(m, { do: "focus", id: "@5,3" })).toThrow("cannot classify");
  });
});

describe("finding 2: reads and scrolls click no data cell, checkbox or dropdown", () => {
  test("a grid gets the focus by a click on its header, not on its first data row", () => {
    const p = planGrid(screen(), { do: "grid", id: "GRID_CONT", row: 0, how: "cell" }, geo);
    const click = p.steps[0] as { do: string; x: number; y: number };
    expect(click.do).toBe("click");
    // The header line: above the first data row (pitch 26).
    expect(click.y).toBeLessThan(GRID_RECT[1] + 26);
    expect(click.y).toBeGreaterThanOrEqual(GRID_RECT[1]);
  });
  test("a table control pages after a click into its first plain field, never its checkbox column", () => {
    const n = namedControl(screen(), "TC_ITEMS");
    if (!n) throw new Error("no table");
    const p = planPage(n, 13, geo);
    const click = p?.steps[0] as { x: number; y: number };
    const [x] = geo.at(main(), 22, 6, 18);
    expect(click.x).toBe(x);
  });
  test("a table whose first row has no plain field is not paged", () => {
    const only = { ...TABLE, columns: [TABLE.columns[0], TABLE.columns[2]], rows: TABLE.rows.map((r) => ({ ...r, cells: [r.cells[0], r.cells[1], r.cells[2]] })) } as DiagTable;
    only.columns = [TABLE.columns[0] as DiagTable["columns"][number], TABLE.columns[2] as DiagTable["columns"][number]];
    const n = namedControl(screen([main({ tables: [only] })]), "TC_ITEMS");
    if (!n) throw new Error("no table");
    expect(() => planPage(n, 13, geo)).toThrow("no plain field");
  });
});

describe("finding 3: FIELD[n] is the table's own row, never the n-th row on show", () => {
  test("a dropdown cell of a row not on show names nothing", () => {
    expect(namedControl(screen(), "ZPOS-TYPE[1]")).toBeUndefined();
    expect(namedControl(screen(), "ZPOS-TYPE[11]")).toMatchObject({ kind: "dropdown", element: { row: 23 } });
  });
});

describe("finding 10: scripting's FIELD[col,row] counts from the first row on show", () => {
  test("with the table scrolled to row 10, [c,1] is row 11", () => {
    expect(resolveTarget(screen(), { do: "set", id: "ZPOS-MATNR[1,1]", value: "X" })?.what).toBe("ZPOS-MATNR in row 11");
    expect(resolveTarget(screen(), { do: "set", id: "TC_ITEMS[1,0]", value: "X" })?.what).toBe("ZPOS-MATNR in row 10");
    expect(resolveTarget(screen(), { do: "set", id: "wnd[0]/usr/tblZPROGTC_ITEMS/ctxtZPOS-MATNR[1,2]", value: "X" })?.what).toBe("ZPOS-MATNR in row 12");
  });
});

describe("finding 6: toolbar buttons and keys carry no function code", () => {
  test("{CODE} of a key is refused with what the screen offers", () => {
    const s = screen();
    expect("none" in findTarget(s, { do: "press", id: "{BACK}" })).toBe(true);
    const text = noTargetText(s, "{BACK}");
    expect(text).toContain("cannot be named by a function code");
    expect(text).toContain('F3 "Back"');
    expect(text).toContain('{"do":"okcode"');
  });
  test("a key is still found by its text", () => {
    expect(resolveTarget(screen(), { do: "press", id: "Back" })?.kind).toBe("key");
  });
});

describe("finding 8: a grid toolbar button is found by its whole name, or by a known ALV code's words", () => {
  const buttons = [
    { name: "Exit to list", tip: "", enabled: true, x: 470, y: 250 },
    { name: "Delete row", tip: "", enabled: true, x: 500, y: 250 },
    { name: "Details", tip: "Details (Ctrl+Shift+F3)", enabled: true, x: 530, y: 250 },
  ];
  const tb = (b: string) => planToolbar(screen(), { do: "toolbar", id: "GRID_CONT", button: b }, geo, buttons);
  test("the agent's text is never a prefix", () => {
    expect(() => tb("E")).toThrow('No toolbar button "E"');
    expect(() => tb("Del")).toThrow('No toolbar button "Del"');
  });
  test("an ALV code's words may start the name; the plan says which button it presses", () => {
    expect(tb("&DETAIL")).toMatchObject({ steps: [{ do: "press", name: "Details" }], pressed: ["Details", "Details (Ctrl+Shift+F3)"] });
    expect(tb("Delete row")).toMatchObject({ pressed: ["Delete row", ""] });
  });
});

describe("finding 11: a window is bound only without doubt", () => {
  const routedMinimized: HostWindow[] = [
    { hwnd: 11, kind: "session", title: "SAP Easy Access", minimized: true },
    { hwnd: 22, kind: "session", title: "SAP Easy Access", foreground: true },
  ];
  test("the routed session minimized and another connection's window with the same title: refused, nothing bound", () => {
    const bound = new Map<number, string>();
    expect(pickWindow(routedMinimized, { key: "0:0", title: "SAP Easy Access", routed: 1 }, bound, () => true)).toContain("nothing tells which one is this session");
    expect(bound.size).toBe(0);
  });
  test("a window whose status bar shows another system or client is never the session", () => {
    const w: HostWindow[] = [{ hwnd: 22, kind: "session", title: "SAP Easy Access", info: "Ready | ABC (1) 200 | host1" }];
    expect(pickWindow(w, { key: "0:0", title: "SAP Easy Access", system: "XYZ", client: "100" }, new Map(), () => true)).toContain("show another system or client");
  });
  test("the status bar's system field confirms the right one; a minimized match is refused, not used", () => {
    const w: HostWindow[] = [
      { hwnd: 11, kind: "session", title: "SAP Easy Access", info: "XYZ (1) 100" },
      { hwnd: 22, kind: "session", title: "SAP Easy Access", info: "ABC (1) 200" },
    ];
    const bound = new Map<number, string>();
    expect(pickWindow(w, { key: "0:0", title: "SAP Easy Access", system: "XYZ", client: "100" }, bound, () => true)).toMatchObject({ hwnd: 11 });
    expect(bound.get(11)).toBe("0:0");
    const min = [{ ...(w[0] as HostWindow), minimized: true }, w[1] as HostWindow];
    expect(pickWindow(min, { key: "0:1", title: "SAP Easy Access", system: "XYZ", client: "100" }, new Map(), () => true)).toContain("is minimized");
  });
});

// ---- the driver, with a fake decoder, traffic and input host ----

interface Fake {
  d: DiagDriver;
  log: Record<string, unknown>[];
  traffic: Traffic;
  show(s: DiagScreen): void;
}

function fake(s: DiagScreen, buttons: { name: string; tip: string; enabled: boolean; x: number; y: number }[] = [], areas?: Record<string, unknown>[]): Fake {
  let current = s;
  const traffic = new Traffic();
  const conn = { n: 0, target: { host: "h", service: "3200" }, decoder: { screen: () => current, screens: () => new Map([[0, current]]) }, open: true, traffic, steps: new Map(), typed: new Map() };
  const log: Record<string, unknown>[] = [];
  const host = {
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      log.push({ op, ...params });
      const title = current.windows[0]?.title ?? "";
      if (op === "windows") return { windows: [{ hwnd: 1, kind: "session", title, foreground: true }] } as T;
      if (op === "area") return { windows: areas ?? [{ hwnd: 1, kind: "session", title, area: AREA, controls: [{ cls: "SAPALVGrid", rect: GRID_RECT }] }] } as T;
      if (op === "buttons") return { buttons } as T;
      return {} as T;
    },
    close() {},
  };
  const d = new DiagDriver({ id: "sapgui:diag:0:0", surface: "sapgui" } as never, conn as never, 0, host as never, { bound: new Map(), live: () => true, env: { SAP_DIAG_REQUEST_MS: "50" } });
  return { d, log, traffic, show: (x) => (current = x) };
}

const acts = (f: Fake) => f.log.filter((x) => x.op === "act").map((x) => (x.action as { do: string }).do);

describe("finding 2: a scroll or a read never sends values typed and not sent", () => {
  test("after a set, scroll and sap_look with rows are refused, and nothing is sent", async () => {
    const f = fake(screen());
    await f.d.act({ do: "set", id: "ZPOS-MATNR[10]", value: "M-99" });
    expect(acts(f)).toEqual(["set"]);
    await expect(f.d.act({ do: "scroll", id: "TC_ITEMS", to: "next" })).rejects.toThrow("not reached SAP yet");
    await expect(f.d.look({ compact: true, id: "TC_ITEMS", rows: { from: 20, to: 25 } })).rejects.toThrow("would send it");
    expect(acts(f)).toEqual(["set"]);
  });
});

describe("finding 3: a FIELD[n] row the page keys did not bring is refused", () => {
  test("a dropdown in row 1 of a table on rows 10 to 12 that does not move: nothing is chosen in row 11", async () => {
    const f = fake(screen());
    await expect(f.d.act({ do: "combo", id: "ZPOS-TYPE[1]", key: "B" })).rejects.toThrow("Row 1 of the table TC_ITEMS is not on show after scrolling");
    // Only the scroll's inputs went out (a click into a plain field, a page key), no choice in a dropdown.
    expect(acts(f)).toEqual(["click", "key"]);
  });
});

describe("finding 8: the grid toolbar button found is judged again", () => {
  test("an ALV code rated safe whose words start a button that deletes: refused, nothing pressed", async () => {
    const f = fake(screen(), [{ name: "Sort ascending and delete duplicates", tip: "", enabled: true, x: 600, y: 250 }]);
    expect(assessDiag(screen(), { do: "toolbar", id: "GRID_CONT", button: "&SORT_ASC" }).risk).toBe("navigate");
    await expect(f.d.act({ do: "toolbar", id: "GRID_CONT", button: "&SORT_ASC" })).rejects.toThrow("which may write to SAP: nothing was pressed");
    expect(acts(f)).toEqual([]);
  });
});

describe("finding 9: a lost answer never leaves the session refused for good", () => {
  const request = () => message([windowStart(), idItem(0x04, 0x26, [0, 0, 0, 1])], { info: 0 });
  test("the next action is refused at once with what to do; a look recovers, and actions go on", async () => {
    const f = fake(screen());
    f.traffic.client(request());
    f.traffic.trouble(0);
    const t0 = Date.now();
    await expect(f.d.act({ do: "key", key: 0 })).rejects.toThrow("any sap_look, with or without an id");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(await f.d.look({ compact: true })).toContain("NOTE SAP's answer to the last step was lost");
    expect(f.traffic.pending(0)).toBe(false);
    await f.d.act({ do: "key", key: 3 });
    expect(acts(f)).toEqual(["key"]);
  });
  test("the wait for a damaged answer ends once the server is quiet, and says the state is unknown", async () => {
    const t = new Traffic();
    const mark = t.mark();
    t.client(request());
    t.server();
    t.trouble(0);
    const t0 = Date.now();
    const r = await t.wait(0, mark, Date.now(), { requestMs: 100, answerMs: 10_000, quietMs: 0, maxSettleMs: 0, lostMs: 150 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ requested: true, answered: false, unknown: true });
    expect(waitNote(r, DEFAULT_WAIT, true)).toContain("the session state is unknown");
  });
  test("the decoder says when a server message that ends a step cannot be read", () => {
    const d = new DiagDecoder();
    const said: (number | undefined)[] = [];
    d.onTrouble = (m) => said.push(m);
    // a compressed message whose deflate stream is garbled: it does not decompress
    const bad = message([idItem(0x0c, 0x09, "x".repeat(200))], { info: 1, mode: 2, compress: true });
    bad.fill(0xff, 4 + 8 + 8 + 1);
    d.push(1, bad);
    expect(said).toContain(2);
  });
});

describe("finding 12: the wait ends on the answer to the last input", () => {
  const request = () => message([windowStart(), idItem(0x04, 0x26, [0, 0, 0, 1])], { info: 0 });
  test("an earlier request answered, then the last input's request 200 ms later: the wait ends after its answer", async () => {
    const t = new Traffic();
    const mark = t.mark();
    t.client(request()); // rows fetched while the arrows moved
    const last = t.mark();
    setTimeout(() => t.screen(0), 10);
    setTimeout(() => t.client(request()), 200); // F2
    setTimeout(() => t.screen(0), 260);
    const t0 = Date.now();
    const r = await t.wait(0, mark, Date.now(), { requestMs: 1000, answerMs: 2000, quietMs: 60, maxSettleMs: 1500 }, last);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r).toMatchObject({ answered: true, requests: 2 });
  });
});

describe("recheck: a push button or an unknown cell in a table-control row", () => {
  const rowButtons = (): DiagScreen => {
    const t = structuredClone(TABLE);
    t.columns.push({ index: 3, position: 3, name: "ZPOS-DEL", title: "Delete", width: 4, col: 32, visible: true }, { index: 4, position: 4, name: "ZPOS-ODD", title: "Odd", width: 4, col: 38, visible: true });
    for (const r of t.rows) r.cells.push({ ...cell(3, "Delete", "button") }, { ...cell(4, "?", "other") });
    return screen([main({ tables: [t] })]);
  };
  test("press or click on it is a write, and the plan waits for SAP's answer; set and focus are refused", () => {
    const s = rowButtons();
    expect(assess(s, { do: "press", id: "ZPOS-DEL[11]" }).risk).toBe("commit");
    expect(assess(s, { do: "click", id: "ZPOS-ODD[11]" }).risk).toBe("commit");
    expect(plan(s, { do: "press", id: "ZPOS-DEL[11]" }).answer).toBe("yes");
    expect(plan(s, { do: "click", id: "ZPOS-ODD[11]" }).answer).toBe("maybe");
    expect(() => plan(s, { do: "set", id: "ZPOS-DEL[11]", value: "x" })).toThrow("does not take text");
    expect(() => plan(s, { do: "focus", id: "ZPOS-ODD[11]" })).toThrow("cannot classify");
  });
});

describe("recheck: the system field, not the status message", () => {
  test("a status message that looks like a system field does not refuse the only window", () => {
    const w: HostWindow[] = [{ hwnd: 22, kind: "session", title: "SAP Easy Access", status: "Order XYZ (1) 100 saved", info: "Order XYZ (1) 100 saved | ABA (1) 800" }];
    expect(pickWindow(w, { key: "0:0", title: "SAP Easy Access", system: "ABA", client: "800" }, new Map(), () => true)).toMatchObject({ hwnd: 22 });
    const msgOnly: HostWindow[] = [{ hwnd: 22, kind: "session", title: "SAP Easy Access", status: "Order XYZ (1) 100 saved", info: "Order XYZ (1) 100 saved" }];
    expect(pickWindow(msgOnly, { key: "0:0", title: "SAP Easy Access", system: "ABA", client: "800" }, new Map(), () => true)).toMatchObject({ hwnd: 22 });
  });
});

describe("recheck: any look recovers a lost answer", () => {
  const request = () => message([windowStart(), idItem(0x04, 0x26, [0, 0, 0, 1])], { info: 0 });
  test("sap_look with an id clears it too, and says so", async () => {
    const f = fake(screen());
    f.traffic.client(request());
    f.traffic.trouble(0);
    expect(await f.d.look({ compact: true, id: "TC_ITEMS" })).toContain("NOTE SAP's answer to the last step was lost");
    expect(f.traffic.pending(0)).toBe(false);
    await f.d.act({ do: "key", key: 3 });
    expect(acts(f)).toEqual(["key"]);
  });
});

describe("recheck: a loss is scoped to the session it hit", () => {
  const request = (mode: number) => message([windowStart(), idItem(0x04, 0x26, [0, 0, 0, 1])], { info: 0, mode });
  test("bytes lost on the connection do not cut another session's long step short", async () => {
    const t = new Traffic();
    const mark = t.mark();
    t.client(Buffer.concat([request(0), request(1)]));
    t.trouble(); // bytes lost: whose, nobody knows
    const t0 = Date.now();
    const r = await t.wait(1, mark, Date.now(), { requestMs: 100, answerMs: 600, quietMs: 0, maxSettleMs: 0, lostMs: 100 });
    expect(r.unknown).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    // ...and a look still recovers that session
    expect(t.troubled(1)).toBe(true);
  });
  test("a broken message of one session times that session by its own silence, not the connection's", async () => {
    const t = new Traffic();
    const mark = t.mark();
    t.client(Buffer.concat([request(0), request(1)]));
    t.trouble(0);
    // the other session keeps talking
    const busy = setInterval(() => {
      t.server();
      t.serverMessage(1);
    }, 30);
    try {
      const t0 = Date.now();
      const r = await t.wait(0, mark, Date.now(), { requestMs: 100, answerMs: 3000, quietMs: 0, maxSettleMs: 0, lostMs: 150 });
      expect(r.unknown).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(t.troubled(1)).toBe(false);
    } finally {
      clearInterval(busy);
    }
  });
});

describe("recheck: a box ticked and not sent is held back like a typed value", () => {
  test("after check on a box without a function code: the view marks it, scroll and look with rows are refused", async () => {
    const f = fake(screen());
    await f.d.act({ do: "check", id: "ZHDR-FLAG" });
    expect(acts(f)).toEqual(["click"]);
    expect(await f.d.look({ compact: true })).toContain("[x] Flag ZHDR-FLAG@20 (ticked, sent with the next Enter)");
    await expect(f.d.act({ do: "scroll", id: "TC_ITEMS", to: "next" })).rejects.toThrow("ZHDR-FLAG ticked) has not reached SAP yet");
    await expect(f.d.look({ compact: true, id: "TC_ITEMS", rows: { from: 20, to: 25 } })).rejects.toThrow("not reached SAP yet");
    expect(acts(f)).toEqual(["click"]);
  });
});

describe("live 2026-11-20: ids an agent wrote the scripting way", () => {
  test("a table control by its scripting id (tbl<program><name>, with or without the path) is the table", () => {
    const s = screen();
    expect(namedControl(s, "tblZPROGTC_ITEMS")?.id).toBe("TC_ITEMS");
    expect(namedControl(s, "wnd[0]/usr/tblZPROGTC_ITEMS")?.id).toBe("TC_ITEMS");
    expect(assess(s, { do: "select", id: "wnd[0]/usr/tblZPROGTC_ITEMS", row: 11 }).risk).toBe("navigate");
    expect(namedControl(s, "tblOTHERTC_ITEMS")).toBeUndefined();
  });
  test("a list label lbl[col,row] is the place @row,col", () => {
    const s = screen([main({ list: { rows: [{ row: 5, cells: [{ col: 3, width: 3, text: "800" }, { col: 9, width: 4, text: "3000" }] }] } as never })]);
    const f = findTarget(s, { do: "dblclick", id: "lbl[9,5]" });
    expect("target" in f && f.target.kind).toBe("list");
    expect("target" in f && f.target.what).toBe('"3000"');
  });
  test("an id that names nothing is said so with the closest ids, not refused as a write", async () => {
    const f = fake(screen());
    await expect(f.d.assess({ do: "select", id: "ZHDR-NOTX" })).rejects.toThrow('No control "ZHDR-NOTX" on this screen (closest: ZHDR-NOTE');
    await expect(f.d.assess({ do: "dblclick", id: "lbl[9,40]" })).resolves.toMatchObject({ risk: "navigate" });
    expect(acts(f)).toEqual([]);
  });
});

describe("live 2026-11-20: a popup is found by its title among the session's windows", () => {
  test("an ownerless SAP GUI dialog listed before the popup does not hide the popup's screen area", async () => {
    const popup = main({ index: 1, modal: true, title: "Select View(s)", program: "SAPLMGMM", dynpro: "0070", size: { rows: 20, cols: 46 }, elements: [], tabstrips: [], controls: [], tables: [{ ...TABLE, rows: TABLE.rows.map((r, i) => ({ ...r, index: i, row: 1 + i })) }] });
    const s = screen([main(), popup]);
    const POPUP: [number, number, number, number] = [389, 129, 360, 566];
    const f = fake(s, [], [
      { hwnd: 1, kind: "session", title: "Synthetic Order: Change", area: AREA, controls: [] },
      { hwnd: 2, kind: "popup", title: "SAP GUI for Windows 800", area: null, controls: [] },
      { hwnd: 3, kind: "popup", title: "Select View(s)", area: POPUP, controls: [] },
    ]);
    await f.d.act({ do: "select", id: "TC_ITEMS", row: 0 });
    const click = f.log.find((x) => x.op === "act") as { action: { x: number; y: number } } | undefined;
    expect(click).toBeDefined();
    expect(click!.action.x).toBeGreaterThanOrEqual(POPUP[0]);
    expect(click!.action.x).toBeLessThan(POPUP[0] + POPUP[2]);
    expect(click!.action.y).toBeGreaterThanOrEqual(POPUP[1]);
  });
});

describe("live 2026-11-20: SE16's list moves sideways", () => {
  test("Ctrl+Shift+F11 on a toolbar button with only a tooltip, List Width Right: navigation, named by its tooltip", () => {
    const w = main({ toolbar: [{ vkey: 47, key: "Ctrl+Shift+F11", text: "", tooltip: "List Width Right", icon: "", enabled: true }], keys: [] });
    expect(assess(screen([w]), { do: "key", key: "Control+Shift+F11" })).toEqual({ risk: "navigate", reason: 'key 47 "List Width Right"' });
  });
});

describe("a key the input host cannot type is refused before the guard", () => {
  test("the keys Send-VKey knows: 0-48, 70, 71, 80-84, 86", () => {
    for (let n = 0; n <= 48; n++) expect(TYPED_VKEYS.has(n)).toBe(true);
    expect([...TYPED_VKEYS].filter((n) => n > 48)).toEqual([70, 71, 80, 81, 82, 83, 84, 86]);
  });
  test("key 77 (Ctrl+C): refused by assess and by act, nothing typed", async () => {
    const f = fake(screen());
    await expect(f.d.assess({ do: "key", key: 77 })).rejects.toThrow("Ctrl+C (virtual key 77) cannot be typed with the DIAG method");
    await expect(f.d.act({ do: "key", key: 77 })).rejects.toThrow("cannot be typed");
    expect(acts(f)).toEqual([]);
  });
  test("keys it can type still go through", async () => {
    const f = fake(screen());
    expect((await f.d.assess({ do: "key", key: "Control+F" })).risk).toBeDefined();
    expect((await f.d.assess({ do: "key", key: 86 })).risk).toBeDefined();
  });
});
