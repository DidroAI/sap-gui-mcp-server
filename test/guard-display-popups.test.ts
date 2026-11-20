import { describe, expect, test } from "bun:test";
import { normalizeAction } from "../src/core/action.js";
import { decide, policyFromEnv } from "../src/core/guard.js";
import type { Action, Risk } from "../src/core/types.js";
import { assess } from "../src/sapgui/assess.js";
import type { Control, Screen } from "../src/sapgui/facts.js";
import { resolve } from "../src/sapgui/resolve.js";
import { assessAction } from "../src/webgui/assess.js";

// Guard false positives with SAP_WRITE=off on display transactions (bench smoke test of 2026-11-14:
// "Continue" on MM03's Select View(s) popup was refused as a possible write, and the lookup task failed).
// Synthetic screens, built like the live ones, in both formats: the Web GUI reader's full view and the
// SAP GUI host's facts. Each case says what SAP_WRITE=off does with it: a refused write, or it runs.

const off = policyFromEnv({});
const lines = (...l: string[]) => l.join("\n");

// ---- Web GUI: full views ----------------------------------------------------------------------

const MM03_INIT = lines(
  "TRANSACTION MM03  PROGRAM SAPLMGMM  SCREEN 60  SYSTEM XYZ (100) host",
  'WINDOW wnd[0]  "Display Material (Initial Screen)"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[0]  button  Enter (Enter)",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[0]/btn[15]  button  Exit (Shift+F3)",
  "wnd[0]/tbar[0]/btn[12]  button  Cancel (Escape)",
  "wnd[0]/tbar[1]/btn[5]  button  Select View(s) (F5)",
  "wnd[0]/tbar[1]/btn[6]  button  Org. Levels (F6)",
  "wnd[0]/tbar[1]/btn[7]  button  Data (F7)",
  'wnd[0]/usr/ctxtRMMG1-MATNR  field  Material = "P-109"  (edit)',
  "wnd[0]/mbar  menubar  Material {menu[0]}, Edit {menu[1]}, Goto {menu[2]}, Defaults {menu[3]}, System {menu[4]}, Help {menu[5]}",
);
const VIEWS_POPUP = [
  'WINDOW wnd[1]  "Select View(s)"',
  "wnd[1]/usr/tblSAPLMGMMTC_VIEW  table  rows 14 (visible 14); columns: View",
  '  row 0: View = "Basic Data 1"',
  '  row 1: View = "Basic Data 2"',
  '  row 2: View = "Sales: Sales Org. Data 1"',
  '  row 3: View = "MRP 1"',
  '  row 4: View = "Accounting 1"',
  "wnd[1]/usr/chkUSRM1-AAUSW  checkbox  [ ] View selection only on request",
  "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)",
  "wnd[1]/tbar[0]/btn[6]  button  Org. Levels (F6)",
  "wnd[1]/tbar[0]/btn[7]  button  Data (F7)",
  "wnd[1]/tbar[0]/btn[20]  button  Select All (Shift+F8)",
  "wnd[1]/tbar[0]/btn[21]  button  Deselect All (Shift+F9)",
  "wnd[1]/tbar[0]/btn[14]  button  Default Setting  (Save as Default Values (Shift+F2))",
  "wnd[1]/tbar[0]/btn[12]  button  Cancel (Escape)",
];
const MM03_VIEWS = lines(...MM03_INIT.split("\n"), ...VIEWS_POPUP);

// The same popup over MM01, which creates: Save is on offer, the title says Create, and the popup has its checkbox.
const MM01_VIEWS = lines(
  ...MM03_INIT.replace(/MM03/g, "MM01")
    .replace("Display Material (Initial Screen)", "Create Material (Initial Screen)")
    .split("\n"),
  "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
  ...VIEWS_POPUP,
  "wnd[1]/usr/chkRMMG1_REF-KZCRE  checkbox  [ ] Create views selected",
);

// A display screen whose Save is on offer after all: the title alone does not make it display-only.
const DISPLAY_WITH_SAVE = lines(...MM03_INIT.split("\n"), "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)", ...VIEWS_POPUP);

// A question with a commit word over the display screen: its rules come first.
const SAVE_OVER_DISPLAY = lines(
  ...MM03_INIT.split("\n"),
  'WINDOW wnd[1]  "Save Changes"',
  "wnd[1]/usr/txtSPOP-TEXTLINE1  label  Do you want to save the changes?",
  "wnd[1]/usr/btnSPOP-OPTION1  button  Yes",
  "wnd[1]/usr/btnSPOP-OPTION2  button  No",
  "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)",
);

const web = (action: Action, view: string, language = "EN"): Risk => assessAction(normalizeAction(action), view, [], { language }).risk;

describe("Web GUI: MM03's Select View(s) popup runs with writing off", () => {
  const RUN: [string, Action][] = [
    ["Continue", { do: "press", id: "wnd[1]/tbar[0]/btn[0]" }],
    ["Continue by its short id", { do: "press", id: "btn[0]" }],
    ["Enter", { do: "key", key: 0 }],
    ["Enter by name", { do: "key", key: "Enter" }],
    ["Enter by okcode", { do: "okcode", value: "/0" }],
    ["Select All", { do: "press", id: "wnd[1]/tbar[0]/btn[20]" }],
    ["Select All by key", { do: "key", key: 20 }],
    ["Deselect All", { do: "press", id: "wnd[1]/tbar[0]/btn[21]" }],
    ["Org. Levels", { do: "press", id: "wnd[1]/tbar[0]/btn[6]" }],
    // No menus read: the popup's Data is the display screen's Data again.
    ["Data, without the menus", { do: "press", id: "wnd[1]/tbar[0]/btn[7]" }],
    ["Data by key, without the menus", { do: "key", key: 7 }],
    ["Cancel", { do: "press", id: "wnd[1]/tbar[0]/btn[12]" }],
    ["tick a view", { do: "select", id: "tblSAPLMGMMTC_VIEW", row: 3 }],
    ["the checkbox", { do: "check", id: "chkUSRM1-AAUSW", value: true }],
  ];
  for (const [name, action] of RUN)
    test(name, () => {
      const a = assessAction(normalizeAction(action), MM03_VIEWS, [], { language: "EN" });
      expect([name, a.risk, decide(off, normalizeAction(action), a).run]).toEqual([name, a.risk === "read" ? "read" : "navigate", true]);
    });

  test("Default Setting saves the user's default views: still a write", () => {
    expect(web({ do: "press", id: "wnd[1]/tbar[0]/btn[14]" }, MM03_VIEWS)).toBe("commit");
    expect(web({ do: "key", key: 14 }, MM03_VIEWS)).toBe("commit");
  });
  test("over MM01, which creates, the popup's Data is not ruled safe; Continue (Enter) stays Enter", () => {
    expect(web({ do: "press", id: "wnd[1]/tbar[0]/btn[7]" }, MM01_VIEWS)).toBe("commit");
    expect(web({ do: "press", id: "wnd[0]/tbar[1]/btn[7]" }, MM01_VIEWS)).toBe("commit");
    expect(web({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, MM01_VIEWS)).toBe("navigate");
  });
  test("a display title with Save on offer is not a display screen", () => {
    expect(web({ do: "press", id: "wnd[1]/tbar[0]/btn[7]" }, DISPLAY_WITH_SAVE)).toBe("commit");
  });
  test("a save question over a display screen: Yes, Continue and Enter are writes, No is not", () => {
    expect(web({ do: "press", id: "btnSPOP-OPTION1" }, SAVE_OVER_DISPLAY)).toBe("commit");
    expect(web({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, SAVE_OVER_DISPLAY)).toBe("commit");
    expect(web({ do: "key", key: 0 }, SAVE_OVER_DISPLAY)).toBe("commit");
    expect(web({ do: "press", id: "btnSPOP-OPTION2" }, SAVE_OVER_DISPLAY)).toBe("navigate");
  });
  test("in a language the words do not cover, the display rule does not hold", () => {
    expect(web({ do: "press", id: "wnd[1]/tbar[0]/btn[7]" }, MM03_VIEWS, "JA")).toBe("commit");
    // Continue and Enter are safe by their key in every language.
    expect(web({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, MM03_VIEWS, "JA")).toBe("navigate");
  });
});

// ---- SAP GUI for Windows: the host's facts --------------------------------------------------------

const btn = (id: string, tip: string, text = "", changeable = true): Control => ({ id, type: "GuiButton", name: id.slice(id.lastIndexOf("/") + 1), text, tip, changeable });

function sapgui(opts: { transaction?: string; title?: string; saveOn?: boolean; popup?: Control[]; popupTitle?: string; language?: string } = {}): Screen {
  const main: Control[] = [
    { id: "wnd[0]", type: "GuiMainWindow", name: "wnd[0]", text: opts.title ?? "Display Material (Initial Screen)", tip: "", changeable: false },
    { id: "wnd[0]/tbar[0]/okcd", type: "GuiOkCodeField", name: "okcd" },
    btn("wnd[0]/tbar[0]/btn[0]", "Enter   (Enter)"),
    // SAP GUI keeps the Save icon on every screen and greys it out where nothing can be saved.
    btn("wnd[0]/tbar[0]/btn[11]", "Save   (Ctrl+S)", "", opts.saveOn === true),
    btn("wnd[0]/tbar[0]/btn[3]", "Back   (F3)"),
    btn("wnd[0]/tbar[0]/btn[12]", "Cancel   (F12)"),
    btn("wnd[0]/tbar[1]/btn[5]", "Select View(s)   (F5)", "Select View(s)"),
    btn("wnd[0]/tbar[1]/btn[6]", "Org. Levels   (F6)", "Org. Levels"),
    btn("wnd[0]/tbar[1]/btn[7]", "Data   (F7)", "Data"),
    btn("wnd[0]/tbar[1]/btn[18]", "Print   (Shift+F6)", "Print"),
    { id: "wnd[0]/usr/ctxtRMMG1-MATNR", type: "GuiCTextField", name: "RMMG1-MATNR", text: "P-109", tip: "", changeable: true, label: "Material" },
  ];
  const windows = [{ id: "wnd[0]", title: opts.title ?? "Display Material (Initial Screen)", controls: main }];
  if (opts.popup) windows.push({ id: "wnd[1]", title: opts.popupTitle ?? "Select View(s)", controls: [{ id: "wnd[1]", type: "GuiModalWindow", name: "wnd[1]", text: opts.popupTitle ?? "Select View(s)", tip: "", changeable: false }, ...opts.popup] });
  return { transaction: opts.transaction ?? "MM03", program: "SAPLMGMM", screen: "0060", language: opts.language ?? "EN", activeWindow: opts.popup ? "wnd[1]" : "wnd[0]", windows };
}

const VIEWS_FACTS: Control[] = [
  { id: "wnd[1]/usr/tblSAPLMGMMTC_VIEW", type: "GuiTableControl", name: "SAPLMGMMTC_VIEW", rowCount: 14, visibleRowCount: 14, columns: ["View"] },
  { id: "wnd[1]/usr/tblSAPLMGMMTC_VIEW/txtMSICHTAUSW-DYTXT[0,0]", type: "GuiTextField", name: "MSICHTAUSW-DYTXT", text: "Basic Data 1", tip: "", changeable: false },
  { id: "wnd[1]/usr/tblSAPLMGMMTC_VIEW/txtMSICHTAUSW-DYTXT[0,1]", type: "GuiTextField", name: "MSICHTAUSW-DYTXT", text: "MRP 1", tip: "", changeable: false },
  { id: "wnd[1]/usr/chkUSRM1-AAUSW", type: "GuiCheckBox", name: "USRM1-AAUSW", text: "View selection only on request", tip: "", selected: false, changeable: true },
  btn("wnd[1]/tbar[0]/btn[0]", "Continue   (Enter)"),
  btn("wnd[1]/tbar[0]/btn[6]", "Org. Levels   (F6)", "Org. Levels"),
  btn("wnd[1]/tbar[0]/btn[7]", "Data   (F7)", "Data"),
  btn("wnd[1]/tbar[0]/btn[20]", "Select All   (Shift+F8)"),
  btn("wnd[1]/tbar[0]/btn[21]", "Deselect All   (Shift+F9)"),
  btn("wnd[1]/tbar[0]/btn[14]", "Save as Default Values   (Shift+F2)", "Default Setting"),
  btn("wnd[1]/tbar[0]/btn[12]", "Cancel   (F12)"),
];

const gui = (s: Screen, action: Action): Risk => assess(s, action, action.id ? resolve(s, action.id) : undefined).risk;

describe("SAP GUI: MM03's Select View(s) popup runs with writing off", () => {
  const s = sapgui({ popup: VIEWS_FACTS });
  const RUN: [string, Action][] = [
    ["Continue", { do: "press", id: "wnd[1]/tbar[0]/btn[0]" }],
    ["Enter", { do: "key", key: 0 }],
    ["Enter by okcode", { do: "okcode", value: "/0" }],
    ["Select All", { do: "press", id: "wnd[1]/tbar[0]/btn[20]" }],
    ["Deselect All", { do: "press", id: "wnd[1]/tbar[0]/btn[21]" }],
    ["Org. Levels", { do: "press", id: "wnd[1]/tbar[0]/btn[6]" }],
    ["Data: the display screen's Data again", { do: "press", id: "wnd[1]/tbar[0]/btn[7]" }],
    ["Data by key", { do: "key", key: 7 }],
    ["Cancel", { do: "press", id: "wnd[1]/tbar[0]/btn[12]" }],
  ];
  for (const [name, action] of RUN)
    test(name, () => {
      const a = assess(s, action, action.id ? resolve(s, action.id) : undefined);
      expect([name, a.risk, decide(off, normalizeAction(action), a).run]).toEqual([name, "navigate", true]);
    });
  test("Default Setting (Save as Default Values) is still a write", () => {
    expect(gui(s, { do: "press", id: "wnd[1]/tbar[0]/btn[14]" })).toBe("commit");
    expect(gui(s, { do: "key", key: 14 })).toBe("commit");
  });
});

describe("SAP GUI: a screen that only displays", () => {
  test("its own buttons navigate (Data, F7), but not one named as acting (Print)", () => {
    const s = sapgui();
    expect(gui(s, { do: "press", id: "wnd[0]/tbar[1]/btn[7]" })).toBe("navigate");
    expect(gui(s, { do: "key", key: 7 })).toBe("navigate");
    expect(gui(s, { do: "press", id: "wnd[0]/tbar[1]/btn[18]" })).toBe("commit");
  });
  test("Save on offer, a Create title or an uncovered language: not a display screen", () => {
    for (const s of [sapgui({ saveOn: true }), sapgui({ title: "Create Material (Initial Screen)", transaction: "MM01" }), sapgui({ language: "JA" })]) {
      expect(gui(s, { do: "press", id: "wnd[0]/tbar[1]/btn[7]" })).toBe("commit");
      expect(gui({ ...s, activeWindow: "wnd[1]", windows: [...s.windows, ...sapgui({ popup: VIEWS_FACTS }).windows.slice(1)] }, { do: "press", id: "wnd[1]/tbar[0]/btn[7]" })).toBe("commit");
    }
  });
  test("a save question over a display screen: Yes and Enter are writes, No is not", () => {
    const ask = sapgui({
      popupTitle: "Save Changes",
      popup: [
        { id: "wnd[1]/usr/txtSPOP-TEXTLINE1", type: "GuiTextField", name: "SPOP-TEXTLINE1", text: "Do you want to save the changes?", tip: "", changeable: false },
        btn("wnd[1]/usr/btnSPOP-OPTION1", "", "Yes"),
        btn("wnd[1]/usr/btnSPOP-OPTION2", "", "No"),
      ],
    });
    expect(gui(ask, { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" })).toBe("commit");
    expect(gui(ask, { do: "key", key: 0 })).toBe("commit");
    expect(gui(ask, { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION2" })).toBe("navigate");
  });
});
