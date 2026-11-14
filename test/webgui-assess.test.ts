import { describe, expect, test } from "bun:test";
import type { Action } from "../src/core/types.js";
import { type AssessContext, assessAction, findControl, keyName, parseView } from "../src/webgui/assess.js";
import type { MenuEntry } from "../src/webgui/page.js";

// Synthetic screens in the reader's full format: no SAP data.
const EDIT = [
  "TRANSACTION ZT02  PROGRAM ZPROG  SCREEN 200  SYSTEM XYZ (100) host",
  'WINDOW wnd[0]  "Change Synthetic Order: Overview"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[0]/btn[15]  button  Exit (Shift+F3)",
  "wnd[0]/tbar[1]/btn[8]  button  Execute (F8)",
  "wnd[0]/tbar[1]/btn[13]  button  Generate (Shift+F1)",
  "wnd[0]/tbar[1]/btn[14]  button  Delete (Shift+F2)",
  "wnd[0]/tbar[1]/btn[20]  button  Release  (Release order (Shift+F8))",
  'wnd[0]/usr/ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)',
  "wnd[0]/usr/chkZHDR-DONE  checkbox  [ ] Complete",
  'wnd[0]/usr/cmbZHDR-BLOCK  dropdown  Block = "" ',
  "wnd[0]/usr/tabsTS/tabpT\\01  tab  Sales (selected)",
  "wnd[0]/usr/tabsTS/tabpT\\02  tab  Shipping",
  "wnd[0]/usr/btnBT_DETAIL  button  Display item details",
  "wnd[0]/usr/btnBT_DEL  button  Delete item",
  "wnd[0]/usr/btnBT_POST  button  Post",
  "wnd[0]/usr/btnBT_CANC  button  Cancel document",
  "wnd[0]/usr/btnBT_STAT  button  Change status",
  "wnd[0]/usr/btnBT_SICH  button  Sichern",
  "wnd[0]/usr/cntlGRID/shellcont/shell  grid  1 rows; columns: A=Col A",
  "  row 0: a",
  "wnd[0]/usr/cntlGRID/shellcont/shell/&MB_FILTER  button  Set Filter",
  "wnd[0]/usr/cntlHTML/shellcont/shell  html-viewer",
  "wnd[0]/usr/cntlHTML/shellcont/shell/html[1]  link  Approve request",
  "wnd[0]/usr/cntlHTML/shellcont/shell/html[2]  link  Show details",
  "wnd[0]/sbar  status  S: Document was saved",
  "wnd[0]/mbar  menubar  Order {menu[0]}, Edit {menu[1]}",
].join("\n");

const MENUS: MenuEntry[] = [
  { sid: "wnd[0]/mbar/menu[0]/menu[0]", text: "Display", key: "" },
  { sid: "wnd[0]/mbar/menu[0]/menu[1]", text: "Save", key: "CTRL_S" },
  { sid: "wnd[0]/mbar/menu[0]/menu[2]", text: "Delete", key: "" },
  { sid: "wnd[0]/mbar/menu[1]/menu[0]", text: "Reverse document", key: "CTRL_F9" },
  { sid: "wnd[0]/mbar/menu[1]/menu[1]", text: "Incompletion log", key: "CTRL_F8" },
];

const SAVE_POPUP = [
  ...EDIT.split("\n"),
  'WINDOW wnd[1]  "Exit Order Processing"',
  "wnd[1]/usr/txtSPOP-TEXTLINE1  label  Do you wish to save your data",
  "wnd[1]/usr/txtSPOP-TEXTLINE2  label  first?",
  "wnd[1]/usr/btnSPOP-OPTION1  button  Yes",
  "wnd[1]/usr/btnSPOP-OPTION2  button  No",
  "wnd[1]/usr/btnSPOP-OPTION_CAN  button  Cancel",
].join("\n");

const INFO_POPUP = [
  ...EDIT.split("\n"),
  'WINDOW wnd[1]  "Information"',
  "wnd[1]/usr/txtMESSTXT1  label  The document was saved and posted",
  "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)",
].join("\n");

const EN = { language: "EN" };
const risk = (action: Action, view = EDIT, menus = MENUS, ctx: AssessContext = EN) => assessAction(action, view, menus, ctx).risk;
const reason = (action: Action, view = EDIT, menus = MENUS, ctx: AssessContext = EN) => assessAction(action, view, menus, ctx).reason;

// The screens of the reading probe, synthetic: an entry screen, a tree, an ALV list with its toolbar, a value help.
const ENTRY = [
  "TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 101  SYSTEM XYZ (100) host",
  'WINDOW wnd[0]  "Create Synthetic Order: Initial Screen"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[0]  button  Enter (Enter)",
  "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  'wnd[0]/usr/ctxtZHDR-TYPE  field  Order Type = ""  (edit)',
  'wnd[0]/usr/cmbZHDR-BLOCK  dropdown  Block = ""   options: 01:Credit, 02:Other',
  "wnd[0]/usr/tabsTS/tabpT\\01  tab  Sales (selected)",
  "wnd[0]/usr/tabsTS/tabpT\\02  tab  Shipping",
  "wnd[0]/usr/cntlTREE/shellcont/shell  tree  2 nodes shown",
  "  [+] Objects  {node 1}",
  "    Program  {node 2}",
  "wnd[0]/mbar  menubar  Order {menu[0]}",
].join("\n");

const LIST = [
  "TRANSACTION ZT05  PROGRAM SAPLSLVC_FULLSCREEN  SCREEN 500  SYSTEM XYZ (100) host",
  'WINDOW wnd[0]  "List of Synthetic Orders"',
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[0]/btn[71]  button  Find (Ctrl+F)",
  "wnd[0]/tbar[0]/btn[82]  button  Next page (Page Down)",
  "wnd[0]/tbar[1]/btn[2]  button  Details (F2)",
  "wnd[0]/tbar[1]/btn[28]  button  Sort in ascending order (Ctrl+F4)",
  "wnd[0]/tbar[1]/btn[29]  button  Set filter (Ctrl+F5)",
  "wnd[0]/tbar[1]/btn[33]  button  Choose layout... (Ctrl+F9)",
  "wnd[0]/tbar[1]/btn[36]  button  Save layout... (Ctrl+F12)",
  "wnd[0]/tbar[1]/btn[46]  button  Print preview (Ctrl+Shift+F10)",
  "wnd[0]/tbar[1]/btn[9]  button  Mail recipient (F9)",
  "wnd[0]/usr/cntlGRID1/shellcont/shell  grid  2 rows; columns: VBELN=Doc | NETWR=Net value",
  "  row 0: 4711 | 10.00",
  "  row 1: 4712 | 20.00",
  "wnd[0]/usr/cntlGRID1/shellcont/shell/&DETAIL  button  Details",
  "wnd[0]/usr/cntlGRID1/shellcont/shell/&MB_FILTER  button  Set Filter",
  "wnd[0]/usr/cntlGRID1/shellcont/shell/&DELETE_FILTER  button  Delete Filter",
  "wnd[0]/usr/cntlGRID1/shellcont/shell/&SORT_ASC  button  Sort in Ascending Order",
  "wnd[0]/usr/cntlGRID1/shellcont/shell/&FIND  button  Find",
  "wnd[0]/usr/cntlGRID1/shellcont/shell/&PRINT_BACK_PREVIEW  button  Print Preview",
  "wnd[0]/usr/cntlGRID1/shellcont/shell/&LOCAL&DELETE_ROW  button  Delete Row",
  "wnd[0]/usr/cntlGRID1/shellcont/shell/ZPOST  button  Do it",
].join("\n");

const F4 = [
  ...ENTRY.split("\n"),
  'WINDOW wnd[1]  "Delivery Block (1) 3 Entries found"',
  "wnd[1]/usr/lbl[1,1]  label  Type",
  "wnd[1]/usr/lbl[1,3]  label  01",
  "wnd[1]/usr/lbl[5,3]  label  Release pending",
  "wnd[1]/tbar[0]/btn[0]  button  Copy (Enter)",
  "wnd[1]/tbar[0]/btn[12]  button  Cancel (F12)",
].join("\n");

describe("assess: Save", () => {
  test("key 11, Ctrl+S, okcode /11 and SAVE, and the Save button are commits", () => {
    expect(risk({ do: "key", key: 11 })).toBe("commit");
    expect(risk({ do: "key", key: "Control+s" })).toBe("commit");
    expect(risk({ do: "okcode", value: "/11" })).toBe("commit");
    expect(risk({ do: "okcode", value: "SAVE" })).toBe("commit");
    expect(risk({ do: "okcode", value: "=SICH" })).toBe("commit");
    expect(risk({ do: "press", id: "wnd[0]/tbar[0]/btn[11]" })).toBe("commit");
  });
  test("the reason names what was found", () => {
    expect(reason({ do: "press", id: "wnd[0]/tbar[0]/btn[11]" })).toContain('"Save (Ctrl+S)"');
    expect(reason({ do: "okcode", value: "/11" })).toContain("okcode /11");
  });
  test("Save is a commit even on a screen that shows no Save button", () => {
    expect(risk({ do: "key", key: 11 }, "TRANSACTION X  PROGRAM Y  SCREEN 1", [])).toBe("commit");
  });
});

describe("assess: buttons fail closed", () => {
  test("a button whose text or tooltip means save, post, delete, release... is a commit", () => {
    for (const id of ["btnBT_DEL", "btnBT_POST", "btnBT_CANC", "btnBT_STAT", "btnBT_SICH", "wnd[0]/tbar[1]/btn[14]", "wnd[0]/tbar[1]/btn[20]"])
      expect([id, risk({ do: "press", id })]).toEqual([id, "commit"]);
  });
  test("a button that is not known to be safe is a commit, and the reason says so", () => {
    expect(risk({ do: "press", id: "wnd[0]/tbar[1]/btn[8]" })).toBe("navigate"); // Execute (F8): safe by choice, see SAFE_VKEYS
    expect(risk({ do: "press", id: "wnd[0]/tbar[1]/btn[13]" })).toBe("commit");
    expect(reason({ do: "press", id: "wnd[0]/tbar[1]/btn[13]" })).toContain("not known to be safe");
    expect(risk({ do: "press", id: "wnd[0]/tbar[1]/btn[9]" }, LIST)).toBe("commit"); // Mail recipient
    expect(risk({ do: "toolbar", id: "cntlGRID1/shellcont/shell", button: "ZPOST" }, LIST)).toBe("commit");
    expect(risk({ do: "press", id: "html[1]" })).toBe("commit"); // link "Approve request"
  });
  test("a control the view does not show cannot be ruled safe", () => {
    for (const d of ["press", "select", "click", "dblclick"]) expect([d, risk({ do: d, id: "btnNOT_THERE" })]).toEqual([d, "commit"]);
    expect(reason({ do: "press", id: "btnNOT_THERE" })).toContain("not on the screen");
    expect(risk({ do: "toolbar", id: "cntlGRID1/shellcont/shell", button: "ZNOPE" }, LIST)).toBe("commit");
  });
  test("known safe: Back, Exit, Enter, Display, tabs", () => {
    expect(risk({ do: "press", id: "btnBT_DETAIL" })).toBe("navigate"); // "Display item details"
    expect(risk({ do: "press", id: "wnd[0]/tbar[0]/btn[3]" })).toBe("navigate");
    expect(risk({ do: "press", id: "wnd[0]/tbar[0]/btn[15]" })).toBe("navigate");
    expect(risk({ do: "press", id: "wnd[0]/tbar[0]/btn[0]" }, ENTRY)).toBe("navigate");
    expect(risk({ do: "select", id: "tabpT\\02" })).toBe("navigate");
    expect(risk({ do: "press", id: "html[2]" })).toBe("navigate"); // link "Show details"
  });
  test("a display-only list toolbar stays usable", () => {
    for (const n of [3, 71, 82, 2, 28, 29, 46]) expect([n, risk({ do: "press", id: `wnd[0]/tbar[${n === 3 || n === 71 || n === 82 ? 0 : 1}]/btn[${n}]` }, LIST)]).toEqual([n, "navigate"]);
    for (const button of ["&DETAIL", "&MB_FILTER", "&DELETE_FILTER", "&SORT_ASC", "&FIND", "&PRINT_BACK_PREVIEW"])
      expect([button, risk({ do: "toolbar", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", button }, LIST)]).toEqual([button, "navigate"]);
    expect(risk({ do: "press", id: "wnd[0]/usr/cntlGRID1/shellcont/shell/&MB_FILTER" }, LIST)).toBe("navigate");
    // What writes on that toolbar is still a commit.
    expect(risk({ do: "press", id: "wnd[0]/tbar[1]/btn[36]" }, LIST)).toBe("commit"); // Save layout
    expect(risk({ do: "toolbar", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", button: "&LOCAL&DELETE_ROW" }, LIST)).toBe("commit");
    expect(risk({ do: "toolbar", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", button: "&DATA_SAVE" }, LIST)).toBe("commit");
  });
  test("words in a message do not count: only the control acted on does", () => {
    expect(risk({ do: "key", key: 0 })).toBe("navigate"); // the status bar says "saved"
  });
});

describe("assess: the flows of the reading probe stay open", () => {
  test("typing, a dropdown, a checkbox", () => {
    expect(risk({ do: "set", id: "ctxtZHDR-TYPE", value: "OR" }, ENTRY)).toBe("navigate");
    expect(risk({ do: "set", id: "ZHDR-TYPE", value: "CD" })).toBe("navigate");
    expect(risk({ do: "combo", id: "cmbZHDR-BLOCK", key: "01" }, ENTRY)).toBe("navigate");
    expect(risk({ do: "check", id: "chkZHDR-DONE", value: true })).toBe("navigate");
    expect(risk({ do: "key", key: 0 }, ENTRY)).toBe("navigate");
  });
  test("tabs", () => {
    expect(risk({ do: "select", id: "tabpT\\02" }, ENTRY)).toBe("navigate");
    expect(risk({ do: "select", id: "wnd[0]/usr/tabsTS/tabpT\\02" }, ENTRY)).toBe("navigate");
  });
  test("tree double-click and expand, ALV double-click", () => {
    expect(risk({ do: "tree", id: "shell", node: "2", how: "double" }, ENTRY)).toBe("navigate");
    expect(risk({ do: "tree", id: "shell", node: "1", how: "expand" }, ENTRY)).toBe("read");
    expect(risk({ do: "dblclick", id: "shell", node: "2" }, ENTRY)).toBe("navigate");
    expect(risk({ do: "grid", id: "shell", row: 0, col: "VBELN", how: "double" }, LIST)).toBe("navigate");
    expect(risk({ do: "dblclick", id: "shell", row: 1, col: "VBELN" }, LIST)).toBe("navigate");
  });
  test("value help: open it, pick an entry, or take it with Enter or Copy", () => {
    expect(risk({ do: "f4", id: "ctxtZHDR-TYPE" }, ENTRY)).toBe("read");
    expect(risk({ do: "key", key: 4 }, ENTRY)).toBe("navigate");
    expect(risk({ do: "dblclick", id: "wnd[1]/usr/lbl[1,3]" }, F4)).toBe("navigate");
    // The list holds the word "Release" and the title "Block": a hit list is not a question.
    expect(risk({ do: "key", key: 0 }, F4)).toBe("navigate");
    expect(risk({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, F4)).toBe("navigate");
    expect(risk({ do: "press", id: "wnd[1]/tbar[0]/btn[12]" }, F4)).toBe("navigate");
    expect(risk({ do: "key", key: 12 }, F4)).toBe("navigate");
  });
  test("starting a transaction", () => {
    for (const value of ["/nVA03", "/nVA05", "/nSE80", "/n"]) expect([value, risk({ do: "okcode", value }, ENTRY)]).toEqual([value, "navigate"]);
  });
  test("the same flows in a language the word table does not cover", () => {
    const ja = { language: "JA" };
    expect(risk({ do: "set", id: "ctxtZHDR-TYPE", value: "OR" }, ENTRY, MENUS, ja)).toBe("navigate");
    expect(risk({ do: "select", id: "tabpT\\02" }, ENTRY, MENUS, ja)).toBe("navigate");
    expect(risk({ do: "tree", id: "shell", node: "2", how: "double" }, ENTRY, MENUS, ja)).toBe("navigate");
    expect(risk({ do: "grid", id: "shell", row: 0, col: "VBELN" }, LIST, MENUS, ja)).toBe("navigate");
    expect(risk({ do: "dblclick", id: "wnd[1]/usr/lbl[1,3]" }, F4, MENUS, ja)).toBe("navigate");
    expect(risk({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, F4, MENUS, ja)).toBe("navigate");
    expect(risk({ do: "combo", id: "cmbZHDR-BLOCK", key: "01" }, ENTRY, MENUS, ja)).toBe("navigate");
    expect(risk({ do: "toolbar", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", button: "&MB_FILTER" }, LIST, MENUS, ja)).toBe("navigate");
  });
});

describe("assess: the logon language", () => {
  test("in a language the table does not cover, a text is never proof: only ids, keys and codes are", () => {
    for (const ctx of [{ language: "JA" }, { language: "PT" }, {}]) {
      expect(risk({ do: "press", id: "btnBT_DETAIL" }, EDIT, MENUS, ctx)).toBe("commit"); // "Display item details": by text only
      expect(risk({ do: "press", id: "html[2]" }, EDIT, MENUS, ctx)).toBe("commit"); // "Show details"
      expect(risk({ do: "select", id: "menu[0]/menu[0]" }, EDIT, MENUS, ctx)).toBe("commit"); // menu entry "Display"
      expect(risk({ do: "press", id: "wnd[0]/tbar[0]/btn[3]" }, EDIT, MENUS, ctx)).toBe("navigate"); // Back, by its id
      expect(risk({ do: "key", key: 3 }, EDIT, MENUS, ctx)).toBe("navigate");
      expect(risk({ do: "press", id: "btnBT_SICH" }, EDIT, MENUS, ctx)).toBe("commit");
    }
  });
});

describe("assess: keys and okcodes", () => {
  test("a function key is what its button does", () => {
    expect(risk({ do: "key", key: 8 })).toBe("navigate"); // Execute (F8): safe by choice, see SAFE_VKEYS
    expect(risk({ do: "key", key: 14 })).toBe("commit"); // Delete (Shift+F2)
    expect(risk({ do: "key", key: 20 })).toBe("commit"); // Release order (Shift+F8)
    expect(risk({ do: "okcode", value: "/14" })).toBe("commit");
    expect(risk({ do: "key", key: 28 }, LIST)).toBe("navigate"); // Sort in ascending order (Ctrl+F4)
    expect(risk({ do: "key", key: 46 }, LIST)).toBe("navigate"); // Print preview
    expect(risk({ do: "key", key: 36 }, LIST)).toBe("commit"); // Save layout
  });
  test("a function key without a button is what its menu entry does", () => {
    expect(risk({ do: "key", key: 33 })).toBe("commit"); // Ctrl+F9: Reverse document
    expect(risk({ do: "key", key: 32 })).toBe("commit"); // Ctrl+F8: Incompletion log, not known to be safe
    expect(risk({ do: "key", key: 31 }, EDIT, [...MENUS, { sid: "wnd[0]/mbar/menu[1]/menu[2]", text: "Display log", key: "CTRL_F7" }])).toBe("navigate");
  });
  test("standard keys navigate; a key nothing on screen explains cannot be ruled out", () => {
    for (const key of [0, 3, 4, 12, 15, 82, "Tab", "Shift+Tab", "ArrowDown"]) expect([key, risk({ do: "key", key })]).toEqual([key, "navigate"]);
    expect(risk({ do: "key", key: 9 })).toBe("commit");
    expect(reason({ do: "key", key: 9 })).toContain("unknown");
    expect(risk({ do: "key", key: 99 })).toBe("commit");
  });
  test("transactions navigate", () => {
    for (const value of ["/nZT03", "/oZT03", "/n", "/*ZT03"]) expect([value, risk({ do: "okcode", value })]).toEqual([value, "navigate"]);
  });
  test("/nex, /nend and /i close sessions: a commit, with that reason", () => {
    for (const value of ["/nex", "/NEX", "/nend", "/i", "/i2"]) {
      const a = assessAction({ do: "okcode", value }, EDIT, MENUS, EN);
      expect([value, a.risk]).toEqual([value, "commit"]);
      expect(a.reason).toContain("closes SAP sessions; unsaved data is lost");
    }
  });
  test("a function code is a commit unless it is known to be safe", () => {
    for (const value of ["&DATA_SAVE", "ACTI", "YES", "ZZDO", "=ZZDO", "/h", "/$sync", "ZT03"]) expect([value, risk({ do: "okcode", value })]).toEqual([value, "commit"]);
    for (const value of ["BACK", "=BACK", "ENTR", "&ETA"]) expect([value, risk({ do: "okcode", value })]).toEqual([value, "navigate"]);
  });
  test("on SAP Easy Access a plain word is a transaction code", () => {
    const easy = 'TRANSACTION SMEN  PROGRAM SAPLSMTR_NAVIGATION  SCREEN 101  SYSTEM XYZ (100)\nWINDOW wnd[0]  "SAP Easy Access"';
    expect(risk({ do: "okcode", value: "va03" }, easy, [])).toBe("navigate");
    expect(risk({ do: "okcode", value: "SAVE" }, easy, [])).toBe("commit");
    expect(risk({ do: "okcode", value: "/nex" }, easy, [])).toBe("commit");
  });
  test("on SAP Easy Access, Exit is Log Off: the button and its key are commits", () => {
    const easy = [
      "TRANSACTION SMEN  PROGRAM SAPLSMTR_NAVIGATION  SCREEN 101  SYSTEM XYZ (100)",
      'WINDOW wnd[0]  "SAP Easy Access"',
      "wnd[0]/tbar[0]/btn[15]  button  Log Off (Shift+F3)",
      "wnd[0]/tbar[1]/btn[35]  button  SAP menu (Ctrl+F11)",
      "wnd[0]/tbar[1]/btn[42]  button  Add to favorites (Ctrl+Shift+F6)",
      "wnd[0]/usr/cntlIMAGE_CONTAINER/shellcont/shell/shellcont[0]/shell  tree  2 nodes shown",
    ].join("\n");
    expect(risk({ do: "press", id: "wnd[0]/tbar[0]/btn[15]" }, easy, [])).toBe("commit");
    expect(risk({ do: "key", key: 15 }, easy, [])).toBe("commit");
    expect(risk({ do: "press", id: "wnd[0]/tbar[1]/btn[35]" }, easy, [])).toBe("navigate"); // SAP menu
    expect(risk({ do: "press", id: "wnd[0]/tbar[1]/btn[42]" }, easy, [])).toBe("commit"); // Add to favorites
    expect(risk({ do: "tree", id: "shell", node: "F00002", how: "double" }, easy, [])).toBe("navigate");
    expect(risk({ do: "tree", id: "shell", node: "F00002", how: "expand" }, easy, [])).toBe("read");
  });
  test("an action the surface does not know cannot be ruled safe", () => {
    expect(risk({ do: "drag", id: "ctxtZHDR-TYPE" })).toBe("commit");
  });
});

describe("assess: Enter and Space press the control that has the focus", () => {
  const focus = (sid: string, type = "GuiButton"): AssessContext => ({ language: "EN", focus: { sid, type } });
  test("on a button that writes, both are commits", () => {
    for (const key of [0, "Enter", "Space"]) {
      const a = assessAction({ do: "key", key }, EDIT, MENUS, focus("wnd[0]/usr/btnBT_POST"));
      expect([key, a.risk]).toEqual([key, "commit"]);
      expect(a.reason).toContain('would press the button "Post"');
    }
    expect(risk({ do: "key", key: "Space" }, EDIT, MENUS, focus("wnd[0]/tbar[0]/btn[11]"))).toBe("commit");
    expect(risk({ do: "okcode", value: "/0" }, EDIT, MENUS, focus("wnd[0]/usr/btnBT_DEL"))).toBe("commit");
  });
  test("on a button that is not known to be safe, both are commits", () => {
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, focus("wnd[0]/tbar[1]/btn[8]"))).toBe("navigate");
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, focus("wnd[0]/tbar[1]/btn[13]"))).toBe("commit");
    expect(risk({ do: "key", key: "Space" }, EDIT, MENUS, focus("wnd[0]/usr/btnGONE"))).toBe("commit"); // not in the view
  });
  test("on a safe button, a field, a checkbox or a tab they navigate", () => {
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, focus("wnd[0]/usr/btnBT_DETAIL"))).toBe("navigate");
    expect(risk({ do: "key", key: "Space" }, EDIT, MENUS, focus("wnd[0]/tbar[0]/btn[3]"))).toBe("navigate");
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, focus("wnd[0]/usr/ctxtZHDR-TYPE", "GuiCTextField"))).toBe("navigate");
    expect(risk({ do: "key", key: "Space" }, EDIT, MENUS, focus("wnd[0]/usr/chkZHDR-DONE", "GuiCheckBox"))).toBe("navigate");
    expect(risk({ do: "key", key: "Space" }, EDIT, MENUS, focus("wnd[0]/usr/radX", "GuiRadioButton"))).toBe("navigate");
  });
  test("on an open menu entry they choose it", () => {
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, focus("wnd[0]/mbar/menu[0]/menu[2]", "GuiMenu"))).toBe("commit"); // Delete
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, focus("wnd[0]/mbar/menu[0]/menu[0]", "GuiMenu"))).toBe("navigate"); // Display
    expect(risk({ do: "key", key: "Space" }, EDIT, MENUS, focus("wnd[0]/mbar/menu[9]/menu[9]", "GuiMenu"))).toBe("commit"); // not read
  });
  test("inside an HTML viewer: a button or link follows its text", () => {
    const html = (pressable: boolean, text: string): AssessContext => ({ language: "EN", focus: { sid: "wnd[0]/usr/cntlHTML/shellcont/shell", type: "html", pressable, text } });
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, html(true, "Approve request"))).toBe("commit");
    expect(risk({ do: "key", key: "Space" }, EDIT, MENUS, html(true, "Do something"))).toBe("commit");
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, html(true, "Show details"))).toBe("navigate");
    expect(risk({ do: "key", key: 0 }, EDIT, MENUS, html(false, ""))).toBe("navigate");
  });
  test("Space with the focus unknown cannot be ruled safe; Enter is still Enter", () => {
    expect(risk({ do: "key", key: "Space" })).toBe("commit");
    expect(risk({ do: "key", key: 0 })).toBe("navigate");
  });
  test("typing, ticking and value help aimed at a button are assessed as pressing it", () => {
    expect(risk({ do: "set", id: "btnBT_POST", value: "x" })).toBe("commit");
    expect(risk({ do: "check", id: "btnBT_DEL", value: true })).toBe("commit");
    expect(risk({ do: "combo", id: "wnd[0]/tbar[0]/btn[11]", key: "x" })).toBe("commit");
    expect(risk({ do: "focus", id: "btnBT_POST" })).toBe("read");
    expect(risk({ do: "f4", id: "ctxtZHDR-TYPE" })).toBe("read");
    expect(risk({ do: "focus", id: "ctxtZHDR-TYPE" })).toBe("read");
  });
});

describe("assess: menus", () => {
  test("a menu entry follows its text and shortcut", () => {
    expect(risk({ do: "select", id: "wnd[0]/mbar/menu[0]/menu[1]" })).toBe("commit");
    expect(risk({ do: "select", id: "menu[0]/menu[2]" })).toBe("commit");
    expect(risk({ do: "select", id: "menu[0]/menu[0]" })).toBe("navigate"); // Display
    expect(risk({ do: "select", id: "menu[1]/menu[1]" })).toBe("commit"); // Incompletion log: not known to be safe
  });
  test("an entry with entries below it only opens its submenu", () => {
    const menus: MenuEntry[] = [...MENUS, { sid: "wnd[0]/mbar/menu[0]", text: "Order", key: "" }, { sid: "wnd[0]/mbar/menu[1]", text: "Edit", key: "" }];
    expect(risk({ do: "select", id: "wnd[0]/mbar/menu[0]" }, EDIT, menus)).toBe("navigate");
  });
  test("a menu entry that is not known cannot be ruled out", () => {
    expect(risk({ do: "select", id: "menu[3]/menu[9]" })).toBe("commit");
  });
});

describe("assess: popups", () => {
  test("Yes, and Enter, on a popup that asks whether to save are commits; No and Cancel are not", () => {
    expect(risk({ do: "press", id: "btnSPOP-OPTION1" }, SAVE_POPUP)).toBe("commit");
    expect(risk({ do: "key", key: 0 }, SAVE_POPUP)).toBe("commit");
    expect(risk({ do: "press", id: "btnSPOP-OPTION2" }, SAVE_POPUP)).toBe("navigate");
    expect(risk({ do: "press", id: "btnSPOP-OPTION_CAN" }, SAVE_POPUP)).toBe("navigate");
    expect(risk({ do: "key", key: 12 }, SAVE_POPUP)).toBe("navigate");
    expect(reason({ do: "press", id: "btnSPOP-OPTION1" }, SAVE_POPUP)).toContain("save your data");
  });
  test("in a language that is not covered, every answer of such a popup but its Cancel key is a commit", () => {
    const ja = { language: "JA" };
    expect(risk({ do: "press", id: "btnSPOP-OPTION2" }, SAVE_POPUP, MENUS, ja)).toBe("commit");
    expect(risk({ do: "key", key: 12 }, SAVE_POPUP, MENUS, ja)).toBe("navigate");
  });
  test("an information popup that only reports a save is not a commit", () => {
    expect(risk({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, INFO_POPUP)).toBe("navigate");
    expect(risk({ do: "key", key: 0 }, INFO_POPUP)).toBe("navigate");
  });
  test("while a popup is open, a key means the popup's button, not the main window's", () => {
    expect(risk({ do: "key", key: 14 }, INFO_POPUP)).toBe("commit"); // unknown on the popup: cannot be ruled out
    expect(reason({ do: "key", key: 14 }, INFO_POPUP)).toContain("unknown");
  });
});

describe("assess: reading the view", () => {
  test("parseView groups control lines by window and skips rows", () => {
    const w = parseView(SAVE_POPUP);
    expect(w.map((x) => [x.number, x.title])).toEqual([
      [0, "Change Synthetic Order: Overview"],
      [1, "Exit Order Processing"],
    ]);
    expect(w[1]?.controls.map((c) => c.kind)).toEqual(["label", "label", "button", "button", "button"]);
    expect(w[0]?.controls.some((c) => c.text.startsWith("row 0"))).toBe(false);
  });
  test("findControl resolves full ids, id tails and SAP names, the topmost window first", () => {
    const w = parseView(SAVE_POPUP);
    expect(findControl(w, "wnd[0]/usr/ctxtZHDR-TYPE")?.kind).toBe("field");
    expect(findControl(w, "ctxtZHDR-TYPE")?.id).toBe("wnd[0]/usr/ctxtZHDR-TYPE");
    expect(findControl(w, "ZHDR-TYPE")?.id).toBe("wnd[0]/usr/ctxtZHDR-TYPE");
    expect(findControl(w, "SPOP-OPTION1")?.window).toBe(1);
    expect(findControl(w, "nothing")).toBeUndefined();
  });
  test("keyName gives one spelling to every way a shortcut is written", () => {
    expect(keyName("Control+s")).toBe("CTRL_S");
    expect(keyName("Ctrl+S")).toBe("CTRL_S");
    expect(keyName("Shift+F3")).toBe("SHIFT_F3");
    expect(keyName("CTRL_SHIFT_F9")).toBe("CTRL_SHIFT_F9");
  });
});
