/** sap_look with "id", "rows" and "cols" on the DIAG method, on synthetic screens and a fake scroll. */
import { describe, expect, test } from "bun:test";
import type { DiagControl, DiagScreen, DiagTable, DiagTableRow, DiagWindow } from "../../src/diag/index.js";
import { lookControl } from "../../src/sapgui-diag/rows.js";

const grid = (sent: number[]): DiagControl => ({
  id: 9,
  kind: "grid",
  type: "SAPGUI.GridViewCtrl.1",
  container: "GRID_CONT",
  area: { row: 2, col: 0, width: 100, height: 10 },
  grid: {
    columns: [
      { name: "VBELN", title: "Document", titles: ["Document"], tooltip: "", width: 10, position: 0 },
      { name: "NETWR", title: "Net value", titles: ["Net value"], tooltip: "", width: 10, position: 1 },
    ],
    rows: sent.map((i) => ({ index: i, cells: [`D${i}`, `${i},00`] })),
    totalRows: 100,
  },
});

const tree: DiagControl = {
  id: 7,
  kind: "tree",
  type: "SAPGUI.TreeCtrl.1",
  container: "TREE_CONT",
  area: { row: 2, col: 0, width: 40, height: 10 },
  tree: {
    headers: [],
    nodes: [
      { key: "R", parent: "", depth: 0, text: "Root", items: {}, folder: true, expanded: true, hidden: false, disabled: false },
      { key: "A", parent: "R", depth: 1, text: "Alpha", items: {}, folder: false, expanded: false, hidden: false, disabled: false },
      { key: "B", parent: "R", depth: 1, text: "Beta", items: {}, folder: false, expanded: false, hidden: false, disabled: false },
    ],
  },
};

const tableAt = (first: number): DiagTable => ({
  name: "TC_ITEMS",
  program: "ZPROG",
  title: "Items",
  row: 5,
  col: 0,
  width: 60,
  height: 4,
  columns: [
    { index: 0, position: 0, name: "POSNR", title: "Item", width: 6, col: 1, visible: true },
    { index: 1, position: 1, name: "MATNR", title: "Material", width: 18, col: 8, visible: true },
  ],
  rows: [0, 1, 2].map((i): DiagTableRow => ({ index: first + i, row: 6 + i, empty: false, cells: [{ column: 0, text: String((first + i) * 10), kind: "field", input: false, hidden: false }, { column: 1, text: `M-${first + i}`, kind: "field", input: true, hidden: false }] })),
  totalRows: 9,
  visibleRows: 3,
  path: [],
});

const screen = (over: Partial<DiagWindow>): DiagScreen =>
  ({
    mode: 0,
    step: 1,
    session: { system: "XYZ", client: "100" },
    message: { type: "S", text: "not part of a control's view" },
    windows: [{ index: 0, modal: false, title: "Synthetic", program: "ZPROG", dynpro: "0100", guiStatus: "", guiStatusProgram: "", size: { rows: 20, cols: 100 }, menus: [], toolbar: [], keys: [], elements: [], tabstrips: [], tables: [], controls: [], containers: [], ...over }],
  }) as DiagScreen;

describe("look at one control", () => {
  test("a grid, some rows SAP has sent, some columns: nothing scrolled", async () => {
    const scrolls: number[] = [];
    const s = screen({ controls: [grid([0, 1, 2, 3, 4])] });
    const out = await lookControl({ screen: () => s, scrollTo: async (_id, r) => void scrolls.push(r) }, { compact: true, id: "grid_cont", rows: { from: 1, to: 3 }, cols: ["Net value"] });
    expect(scrolls).toEqual([]);
    expect(out).toContain("row 1: 1,00");
    expect(out).toContain("row 3: 3,00");
    expect(out).not.toContain("row 4");
    expect(out).not.toContain("D1");
    expect(out).not.toContain("not part of");
  });
  test("grid rows SAP has not sent: the grid is scrolled there, then read", async () => {
    let s = screen({ controls: [grid([0, 1, 2])] });
    const scrolls: number[] = [];
    const out = await lookControl(
      {
        screen: () => s,
        scrollTo: async (_id, r) => {
          scrolls.push(r);
          s = screen({ controls: [grid([0, 1, 2, 40, 41, 42, 43])] });
        },
      },
      { compact: true, id: "GRID_CONT", rows: { from: 40, to: 42 } },
    );
    expect(scrolls).toEqual([40]);
    expect(out).toContain("row 42: D42 | 42,00");
  });
  test("a tree: a range of the nodes on show, from the traffic", async () => {
    const out = await lookControl({ screen: () => screen({ controls: [tree] }), scrollTo: async () => {} }, { compact: true, id: "TREE_CONT", rows: { from: 1, to: 2 } });
    expect(out).toContain("Alpha");
    expect(out).toContain("Beta");
    expect(out).not.toContain("Root");
  });
  test("a table control: page by page with the scroll, rows by the table's own numbers", async () => {
    let first = 0;
    const scrolls: number[] = [];
    const out = await lookControl(
      {
        screen: () => screen({ tables: [tableAt(first)] }),
        scrollTo: async (_id, r) => {
          scrolls.push(r);
          first = Math.min(r, 6);
        },
      },
      { compact: true, id: "TC_ITEMS", rows: { from: 2, to: 7 }, cols: ["Material"] },
    );
    expect(scrolls).toEqual([3, 6]);
    for (const n of [2, 3, 4, 5, 6, 7]) expect(out).toContain(`row ${n} `);
    expect(out).not.toContain("row 8 ");
    expect(out).toContain("Material=[M-7]");
    expect(out).not.toContain("Item=");
    expect(out).toContain("rows 2 to 7 of 9");
  });
  test("a classic list of 30 lines read whole: every page, not only the last", async () => {
    let first = 0;
    const page = (f: number) => ({ rows: Array.from({ length: 10 }, (_, i) => ({ row: 2 + i, cells: [{ col: 1, text: `LINE-${f + i}`, width: 8 }] })), totalRows: 30, firstRow: f });
    const out = await lookControl(
      {
        screen: () => screen({ list: page(first) }),
        scrollTo: async (_id, r) => {
          first = Math.min(r, 20);
        },
      },
      { compact: true, id: "list", rows: { from: 0, to: 29 } },
    );
    for (const n of [0, 9, 10, 19, 20, 29]) expect(out).toContain(`LINE-${n}`);
  });
  test("an unknown id lists what the screen has", async () => {
    await expect(lookControl({ screen: () => screen({ controls: [tree] }), scrollTo: async () => {} }, { compact: true, id: "NOPE" })).rejects.toThrow("It has: TREE_CONT");
  });
});
