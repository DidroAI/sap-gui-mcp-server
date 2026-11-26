import { describe, expect, test } from "bun:test";
import { normalizeAction } from "../src/core/action.js";
import { decide, policyFromEnv } from "../src/core/guard.js";
import type { Action, Risk } from "../src/core/types.js";
import { layoutMenu, safeCode, safeWord } from "../src/core/words.js";
import { assess } from "../src/sapgui/assess.js";
import type { Control, Screen } from "../src/sapgui/facts.js";
import { resolve } from "../src/sapgui/resolve.js";
import { assessAction } from "../src/webgui/assess.js";
import type { MenuEntry } from "../src/webgui/page.js";

// Guard over-refusals with SAP_WRITE=off on list functions that only change the view (eval-design's
// procedure validation, 2026-11-22: ECC REP-07 adds a column through "Change Layout..."). Changing or
// choosing a layout and opening more selection criteria navigate; saving or deleting a layout still writes.
// Synthetic screens in both formats. Each screen offers Save, so the "screen that only displays" rule
// does not carry these cases: the words and codes must.

const off = policyFromEnv({ SAP_WRITE: "off" });
const lines = (...l: string[]) => l.join("\n");

describe("words: list layouts and selection criteria", () => {
  test("changing, choosing or managing a layout is safe; saving or deleting one is not", () => {
    for (const t of ["Change Layout...", "Change Layout (Ctrl+F8)", "Layout ändern...", "Manage Layouts...", "Modifier la mise en forme"])
      expect([t, safeWord("EN", t)]).toEqual([t, "list layout"]);
    expect(safeWord("EN", "Select Layout...")).toBe("choose or select");
    for (const t of ["Save Layout...", "Layout sichern...", "Delete Layout"]) expect([t, safeWord("EN", t)]).toEqual([t, undefined]);
    // In a language the words do not cover, a text proves nothing.
    expect(safeWord("JA", "Change Layout...")).toBeUndefined();
  });
  test("more selection criteria are safe", () => {
    for (const t of ["Further Sel. Criteria", "Further Sel. Criteria (Shift+F4)", "Further sel.criteria (Shift+F8)", "Dynamic Selections", "Weitere Selektionskriterien"])
      expect([t, safeWord("EN", t)]).toEqual([t, "selection criteria and variants"]);
  });
  test("the classic ALV codes for changing and choosing a layout are safe; saving one is not", () => {
    expect(safeCode("&OL0")).toBe(true);
    expect(safeCode("&OAD")).toBe(true);
    expect(safeCode("&AVE")).toBe(false);
  });
  test("a layout menu", () => {
    expect(layoutMenu("EN", "Layout", "Settings")).toBe(true);
    expect(layoutMenu("DE", "Layout", "Einstellungen")).toBe(true);
    expect(layoutMenu("EN", "Settings")).toBe(false);
    expect(layoutMenu("EN", "Save Layout")).toBe(false);
    expect(layoutMenu("JA", "Layout")).toBe(false);
  });
});

// ---- Web GUI: full views ----------------------------------------------------------------------

const LIST = lines(
  "TRANSACTION ZREP7  PROGRAM ZREP7  SCREEN 120  SYSTEM XYZ (100) host",
  'WINDOW wnd[0]  "Customer Items"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[0]  button  Enter (Enter)",
  "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[1]/btn[29]  button  Set Filter (Ctrl+F5)",
  "wnd[0]/tbar[1]/btn[32]  button  Change Layout... (Ctrl+F8)",
  "wnd[0]/tbar[1]/btn[33]  button  Select Layout... (Ctrl+F9)",
  "wnd[0]/tbar[1]/btn[34]  button  Save Layout... (Ctrl+F10)",
  "wnd[0]/tbar[1]/btn[16]  button  Further Sel. Criteria (Shift+F4)",
  "wnd[0]/usr/lbl[1,3]  label  1400000003",
  "wnd[0]/mbar  menubar  List {menu[0]}, Settings {menu[1]}",
);
const MENUS: MenuEntry[] = [
  { sid: "wnd[0]/mbar/menu[1]", text: "Settings", key: "" },
  { sid: "wnd[0]/mbar/menu[1]/menu[0]", text: "Layout", key: "" },
  { sid: "wnd[0]/mbar/menu[1]/menu[0]/menu[0]", text: "Current...", key: "" },
  { sid: "wnd[0]/mbar/menu[1]/menu[0]/menu[1]", text: "Change...", key: "CTRL_F8" },
  { sid: "wnd[0]/mbar/menu[1]/menu[0]/menu[2]", text: "Save...", key: "CTRL_F10" },
  { sid: "wnd[0]/mbar/menu[1]/menu[0]/menu[3]", text: "Delete...", key: "" },
  { sid: "wnd[0]/mbar/menu[1]/menu[0]/menu[4]", text: "Print Out", key: "" },
  { sid: "wnd[0]/mbar/menu[1]/menu[1]", text: "Change...", key: "" },
];
const LAYOUT_POPUP = lines(
  ...LIST.split("\n"),
  'WINDOW wnd[1]  "Change Layout"',
  "wnd[1]/usr/tblSAPLSKBHTC_WRITE_LIST  table  rows 5 (visible 5); columns: Column Name",
  '  row 0: Column Name = "Document Number"',
  "wnd[1]/usr/btnAPP_WL_SING  button  Hide Selected Fields",
  "wnd[1]/usr/btnAPP_FL_SING  button  Show Selected Fields",
  "wnd[1]/tbar[0]/btn[0]  button  Copy (Enter)",
  "wnd[1]/tbar[0]/btn[11]  button  Save Layout (Ctrl+S)",
  "wnd[1]/tbar[0]/btn[12]  button  Cancel (F12)",
);

const web = (action: Action, view = LIST, language = "EN"): Risk => assessAction(action, view, MENUS, { language }).risk;
const runs = (action: Action, view = LIST) => decide(off, normalizeAction(action), assessAction(action, view, MENUS, { language: "EN" })).run;

describe("Web GUI: list functions that only change the view run with writing off", () => {
  const RUN: [string, Action, string?][] = [
    ["Change Layout...", { do: "press", id: "wnd[0]/tbar[1]/btn[32]" }],
    ["Change Layout by okcode &OL0", { do: "okcode", value: "&OL0" }],
    ["Select Layout by okcode &OAD", { do: "okcode", value: "&OAD" }],
    ["Further Sel. Criteria", { do: "press", id: "wnd[0]/tbar[1]/btn[16]" }],
    ["Set Filter (already allowed)", { do: "press", id: "wnd[0]/tbar[1]/btn[29]" }],
    ["Select Layout (already allowed)", { do: "press", id: "wnd[0]/tbar[1]/btn[33]" }],
    ["Settings > Layout > Change...", { do: "select", id: "wnd[0]/mbar/menu[1]/menu[0]/menu[1]" }],
    ["Settings > Layout > Current...", { do: "select", id: "wnd[0]/mbar/menu[1]/menu[0]/menu[0]" }],
    ["Change Layout: Hide Selected Fields", { do: "press", id: "wnd[1]/usr/btnAPP_WL_SING" }, LAYOUT_POPUP],
    ["Change Layout: Show Selected Fields", { do: "press", id: "wnd[1]/usr/btnAPP_FL_SING" }, LAYOUT_POPUP],
    ["Change Layout: Copy (Enter)", { do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, LAYOUT_POPUP],
  ];
  for (const [name, action, view] of RUN) test(name, () => expect([name, runs(action, view ?? LIST)]).toEqual([name, true]));

  test("saving or deleting a layout is still a write", () => {
    expect(web({ do: "press", id: "wnd[0]/tbar[1]/btn[34]" })).toBe("commit");
    expect(web({ do: "okcode", value: "&AVE" })).toBe("commit");
    expect(web({ do: "select", id: "wnd[0]/mbar/menu[1]/menu[0]/menu[2]" })).toBe("commit");
    expect(web({ do: "select", id: "wnd[0]/mbar/menu[1]/menu[0]/menu[3]" })).toBe("commit");
    expect(web({ do: "press", id: "wnd[1]/tbar[0]/btn[11]" }, LAYOUT_POPUP)).toBe("commit");
  });
  test("a function named as acting in the layout menu, or a menu entry outside it, is not carried by the layout menu", () => {
    expect(web({ do: "select", id: "wnd[0]/mbar/menu[1]/menu[0]/menu[4]" })).toBe("commit");
    expect(web({ do: "select", id: "wnd[0]/mbar/menu[1]/menu[1]" })).toBe("commit");
  });
  test("in a language the words do not cover, only the codes are trusted", () => {
    expect(web({ do: "press", id: "wnd[0]/tbar[1]/btn[32]" }, LIST, "JA")).toBe("commit");
    expect(web({ do: "okcode", value: "&OL0" }, LIST, "JA")).toBe("navigate");
  });
});

// ---- SAP GUI for Windows: the host's facts --------------------------------------------------------

const btn = (id: string, tip: string, text = ""): Control => ({ id, type: "GuiButton", name: id.slice(id.lastIndexOf("/") + 1), text, tip, changeable: true });
const menu = (id: string, text: string): Control => ({ id, type: "GuiMenu", name: id.slice(id.lastIndexOf("/") + 1), text, tip: "", changeable: true });

function sapgui(language = "EN"): Screen {
  const main: Control[] = [
    { id: "wnd[0]", type: "GuiMainWindow", name: "wnd[0]", text: "Customer Items", tip: "", changeable: false },
    { id: "wnd[0]/tbar[0]/okcd", type: "GuiOkCodeField", name: "okcd" },
    btn("wnd[0]/tbar[0]/btn[0]", "Enter   (Enter)"),
    btn("wnd[0]/tbar[0]/btn[11]", "Save   (Ctrl+S)"),
    btn("wnd[0]/tbar[0]/btn[3]", "Back   (F3)"),
    btn("wnd[0]/tbar[1]/btn[32]", "Change Layout...   (Ctrl+F8)"),
    btn("wnd[0]/tbar[1]/btn[34]", "Save Layout...   (Ctrl+F10)"),
    btn("wnd[0]/tbar[1]/btn[16]", "Further Sel. Criteria   (Shift+F4)", "Further Sel. Criteria"),
    menu("wnd[0]/mbar/menu[1]", "Settings"),
    menu("wnd[0]/mbar/menu[1]/menu[0]", "Layout"),
    menu("wnd[0]/mbar/menu[1]/menu[0]/menu[1]", "Change..."),
    menu("wnd[0]/mbar/menu[1]/menu[0]/menu[2]", "Save..."),
    menu("wnd[0]/mbar/menu[1]/menu[1]", "Change..."),
  ];
  return { transaction: "ZREP7", program: "ZREP7", screen: "0120", language, activeWindow: "wnd[0]", windows: [{ id: "wnd[0]", title: "Customer Items", controls: main }] };
}
const gui = (action: Action, s = sapgui()): Risk => assess(s, action, action.id ? resolve(s, action.id) : undefined).risk;

describe("SAP GUI: list functions that only change the view run with writing off", () => {
  test("Change Layout, &OL0, Further Sel. Criteria, Settings > Layout > Change...", () => {
    expect(gui({ do: "press", id: "wnd[0]/tbar[1]/btn[32]" })).toBe("navigate");
    expect(gui({ do: "okcode", value: "&OL0" })).toBe("navigate");
    expect(gui({ do: "press", id: "wnd[0]/tbar[1]/btn[16]" })).toBe("navigate");
    expect(gui({ do: "select", id: "wnd[0]/mbar/menu[1]/menu[0]/menu[1]" })).toBe("navigate");
  });
  test("saving a layout is still a write, and Change... outside the layout menu is not carried", () => {
    expect(gui({ do: "press", id: "wnd[0]/tbar[1]/btn[34]" })).toBe("commit");
    expect(gui({ do: "select", id: "wnd[0]/mbar/menu[1]/menu[0]/menu[2]" })).toBe("commit");
    expect(gui({ do: "select", id: "wnd[0]/mbar/menu[1]/menu[1]" })).toBe("commit");
  });
});
