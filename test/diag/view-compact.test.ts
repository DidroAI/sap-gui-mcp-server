/**
 * The compact view (sap_look without full, and the answer of sap_act) says less where saying more costs
 * every later step of a run its tokens (live 2026-11-25: a DIAG run read 2.2 times the tokens of a
 * scripting run of the same scenario). What it leaves out is still in the full view, and in a look by id:
 * - a grid names each column by its id and its long title only (any of its titles still names it in an
 *   action), and the columns empty in every row on show by id only;
 * - a table control names, right of what SAP GUI shows, the columns open for input by title only;
 * - the function keys every screen has (Help, Possible Entries, Find, Print, the page keys, New GUI Window),
 *   and on SAP Easy Access every key: the command field is what is used there;
 * - a selection screen's texts (%_SAUART_%_APP_%-TEXT) as plain text: they are labels;
 * - an icon with a quick info (@5D\QRelease possible@) as its text.
 * A grid's rows read by range say which rows they are, not "49 more rows (22 sent so far)".
 */
import { describe, expect, test } from "bun:test";
import type { DiagControl, DiagElement, DiagKey, DiagScreen, DiagTable, DiagWindow } from "../../src/diag/screen.js";
import { diagView } from "../../src/diag/view.js";

const key = (vkey: number, k: string, text: string, tooltip = ""): DiagKey => ({ vkey, key: k, text, tooltip, icon: "", enabled: true });

function screenOf(over: Partial<DiagWindow>): DiagScreen {
  return {
    mode: 0,
    step: 1,
    session: { system: "ABA", client: "800", user: "U", tcode: "X" },
    windows: [{ index: 0, modal: false, title: "T", program: "ZPROG", dynpro: "0100", guiStatus: "", guiStatusProgram: "", size: { rows: 20, cols: 156 }, menus: [], toolbar: [], keys: [], elements: [], tabstrips: [], tables: [], controls: [], containers: [], ...over }],
  } as unknown as DiagScreen;
}

const GRID: DiagControl = {
  id: 132,
  kind: "grid",
  type: "SAPGUI.GridViewCtrl.1",
  container: "GRIDCONTROL",
  area: { row: 11, col: 0, width: 118, height: 8 },
  grid: {
    columns: [
      { name: "STATUSICON", title: "Status", titles: ["Status"], tooltip: "", width: 4, position: 0 },
      { name: "BNFPO", title: "Item of requisition", titles: ["Item of requisition", "Item", "Requisn. item", "Req. item"], tooltip: "", width: 5, position: 1 },
      { name: "MATNR", title: "Material", titles: ["Material"], tooltip: "", width: 18, position: 2 },
      { name: "ICON", title: "Status", titles: ["Status"], tooltip: "", width: 18, position: 3 },
    ],
    rows: [{ index: 0, cells: ["", "10", "DPC2015", "@5D\\QRelease possible@"] }],
    totalRows: 1,
  },
};

describe("a grid in the compact view", () => {
  test("one title per column; the empty ones by id after the others; an icon's quick info as text", () => {
    const lines = diagView(screenOf({ controls: [GRID] }), { compact: true }).split("\n");
    expect(lines).toContain("r11  grid GRIDCONTROL (shell 132)  1 rows, 4 columns: BNFPO=Item of requisition | MATNR=Material | ICON=Status; empty in the rows on show: STATUSICON");
    expect(lines).toContain("  row 0: 10 | DPC2015 | Release possible");
  });
  test("the full view keeps every title and every column", () => {
    const lines = diagView(screenOf({ controls: [GRID] })).split("\n");
    expect(lines).toContain("r11  grid GRIDCONTROL (shell 132)  1 rows, 4 columns: STATUSICON=Status | BNFPO=Item of requisition / Item / Requisn. item / Req. item | MATNR=Material | ICON=Status");
    expect(lines).toContain("  row 0:  | 10 | DPC2015 | @5D\\QRelease possible@");
  });
  test("rows read by range say which rows they are", () => {
    const g = { ...GRID, grid: { ...GRID.grid, totalRows: 71, rows: [49, 50, 51].map((i) => ({ index: i, cells: ["", String(i), "M", ""] })) } } as DiagControl;
    const lines = diagView(screenOf({ controls: [g] }), { maxRows: 1000 }).split("\n");
    expect(lines.at(-1)).toBe("  (rows 49 to 51 of 71)");
    // From the first row, the rest is counted as before.
    const first = { ...GRID, grid: { ...GRID.grid, totalRows: 71, rows: [0, 1].map((i) => ({ index: i, cells: ["", String(i), "M", ""] })) } } as DiagControl;
    expect(diagView(screenOf({ controls: [first] })).split("\n").at(-1)).toBe("  ... 69 more rows (2 sent so far; the grid loads the others when scrolled)");
  });
});

const col = (index: number, name: string, title: string, at: number, visible = true) => ({ index, position: index, name, title, width: 8, col: at, visible });
const cell = (column: number, text: string, input = true) => ({ column, text, kind: "field" as const, input, hidden: false });
const TABLE = {
  name: "TABLE",
  program: "SAPLFSKB",
  title: "0 Items",
  row: 11,
  col: 1,
  width: 30,
  height: 3,
  columns: [col(0, "ACGL_ITEM-HKONT", "G/L acct", 3), col(1, "ACGL_ITEM-WRBTR", "Amount", 12), col(2, "ACGL_ITEM-ZUONR", "Assignment", 21), col(3, "ACGL_ITEM-KOSTL", "Cost center", 30, false), col(4, "ACGL_ITEM-AUFNR", "Order", 39, false), col(5, "ACGL_ITEM-DMBTR", "Loc.curr.amount", 48, false)],
  rows: [0, 1].map((i) => ({ index: i, row: 12 + i, empty: i > 0, cells: [cell(0, i ? "" : "476000"), cell(1, ""), cell(2, ""), cell(3, i ? "" : "1000"), cell(4, ""), cell(5, "", false)] })),
  totalRows: 12,
  visibleRows: 2,
  path: [],
} as unknown as DiagTable;

describe("a table control in the compact view", () => {
  test("right of the edge, the open columns by title only (cells that hold something keep their name)", () => {
    const head = diagView(screenOf({ tables: [TABLE] }), { compact: true }).split("\n").find((l) => l.includes(" table ")) ?? "";
    expect(head).toBe('r11  table TABLE "0 Items"  12 rows (1 with data on show), 6 columns: G/L acct ACGL_ITEM-HKONT | Amount ACGL_ITEM-WRBTR | Assignment ACGL_ITEM-ZUONR | Cost center ACGL_ITEM-KOSTL | right of the edge, open: Order | (1 more, empty and read-only in the rows on show)');
  });
  test("the full view names them all", () => {
    const head = diagView(screenOf({ tables: [TABLE] })).split("\n").find((l) => l.includes(" table ")) ?? "";
    expect(head).toContain("Cost center ACGL_ITEM-KOSTL | Order ACGL_ITEM-AUFNR | (1 more");
  });
});

describe("keys in the compact view", () => {
  const keys = [key(0, "Enter", "Enter"), key(1, "F1", "Help"), key(3, "F3", "Back"), key(4, "F4", "Possible Entries"), key(11, "F11", "Post"), key(71, "Ctrl+F", "Find"), key(84, "Ctrl+G", "Find Next"), key(86, "Ctrl+P", "Print"), key(74, "Ctrl+N", "New GUI Window"), key(82, "PageDown", "Next Page"), key(30, "Ctrl+F6", "Delete acct assg.template")];
  test("the keys every screen has are left out", () => {
    const lines = diagView(screenOf({ keys }), { compact: true }).split("\n");
    expect(lines.find((l) => l.startsWith("keys:"))).toBe("keys: Enter (Enter) | Back (F3) | Post (F11) | Delete acct assg.template (Ctrl+F6)");
    expect(diagView(screenOf({ keys })).split("\n").find((l) => l.startsWith("keys:"))).toContain("Possible Entries (F4)");
  });
  test("SAP Easy Access: no keys and no toolbar", () => {
    const lines = diagView(screenOf({ program: "SAPLSMTR_NAVIGATION", keys, toolbar: [key(35, "Ctrl+F11", "SAP menu")] }), { compact: true }).split("\n");
    expect(lines.some((l) => l.startsWith("keys:") || l.startsWith("toolbar:"))).toBe(false);
  });
});

describe("a selection screen's texts", () => {
  const el = (e: Partial<DiagElement>): DiagElement => ({ kind: "field", name: "", text: "", row: 2, col: 2, width: 10, input: false, hidden: false, path: [], etype: 130, ...e }) as DiagElement;
  test("are plain text in the compact view", () => {
    const elements = [el({ name: "%_SAUART_%_APP_%-TEXT", text: "Order Type", col: 2 }), el({ name: "SAUART-LOW", text: "", input: true, col: 34, width: 4 }), el({ name: "%_SAUART_%_APP_%-TO_TEXT", text: "to", col: 53, width: 2 }), el({ name: "SAUART-HIGH", input: true, col: 59, width: 4 })];
    expect(diagView(screenOf({ elements }), { compact: true }).split("\n")).toContain('r2  Order Type  SAUART-LOW@34=[]  to  SAUART-HIGH@59=[]');
    expect(diagView(screenOf({ elements })).split("\n")).toContain('r2  %_SAUART_%_APP_%-TEXT@2="Order Type"  SAUART-LOW@34=[]  %_SAUART_%_APP_%-TO_TEXT@53="to"  SAUART-HIGH@59=[]');
  });
});
