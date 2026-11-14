import { describe, expect, test } from "bun:test";
import type { Action } from "../src/core/types.js";
import { assessAction, findControl, keyName, parseView } from "../src/webgui/assess.js";
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

const risk = (action: Action, view = EDIT, menus = MENUS) => assessAction(action, view, menus).risk;

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
    expect(assessAction({ do: "press", id: "wnd[0]/tbar[0]/btn[11]" }, EDIT, MENUS).reason).toContain('"Save (Ctrl+S)"');
    expect(assessAction({ do: "okcode", value: "/11" }, EDIT, MENUS).reason).toContain("okcode /11");
  });
  test("Save is a commit even on a screen that shows no Save button", () => {
    expect(risk({ do: "key", key: 11 }, "TRANSACTION X  PROGRAM Y  SCREEN 1", [])).toBe("commit");
  });
});

describe("assess: buttons", () => {
  test("a button whose text or tooltip means save, post, delete, release... is a commit", () => {
    for (const id of ["btnBT_DEL", "btnBT_POST", "btnBT_CANC", "btnBT_STAT", "btnBT_SICH", "wnd[0]/tbar[1]/btn[14]", "wnd[0]/tbar[1]/btn[20]"])
      expect([id, risk({ do: "press", id })]).toEqual([id, "commit"]);
  });
  test("other buttons, tabs and fields navigate", () => {
    expect(risk({ do: "press", id: "btnBT_DETAIL" })).toBe("navigate");
    expect(risk({ do: "press", id: "wnd[0]/tbar[1]/btn[8]" })).toBe("navigate");
    expect(risk({ do: "press", id: "wnd[0]/tbar[0]/btn[3]" })).toBe("navigate");
    expect(risk({ do: "select", id: "tabpT\\02" })).toBe("navigate");
    expect(risk({ do: "set", id: "ZHDR-TYPE", value: "CD" })).toBe("navigate");
    expect(risk({ do: "check", id: "chkZHDR-DONE", value: true })).toBe("navigate");
    expect(risk({ do: "combo", id: "cmbZHDR-BLOCK", key: "01" })).toBe("navigate");
  });
  test("value help, focus and expanding a tree node only read", () => {
    expect(risk({ do: "f4", id: "ctxtZHDR-TYPE" })).toBe("read");
    expect(risk({ do: "focus", id: "ctxtZHDR-TYPE" })).toBe("read");
    expect(risk({ do: "tree", id: "shell", node: "1", how: "expand" })).toBe("read");
    expect(risk({ do: "tree", id: "shell", node: "1", how: "double" })).toBe("navigate");
    expect(risk({ do: "grid", id: "shell", row: 0, col: "A" })).toBe("navigate");
  });
  test("grid toolbar buttons and HTML viewer links follow their text", () => {
    expect(risk({ do: "toolbar", id: "cntlGRID/shellcont/shell", button: "&MB_FILTER" })).toBe("navigate");
    expect(risk({ do: "toolbar", id: "cntlGRID/shellcont/shell", button: "&DELETE_ROW" })).toBe("commit");
    expect(risk({ do: "press", id: "html[1]" })).toBe("commit");
    expect(risk({ do: "press", id: "html[2]" })).toBe("navigate");
  });
  test("words in a message do not count: only the control acted on does", () => {
    expect(risk({ do: "key", key: 0 })).toBe("navigate"); // the status bar says "saved"
  });
});

describe("assess: keys and okcodes", () => {
  test("a function key is what its button does", () => {
    expect(risk({ do: "key", key: 8 })).toBe("navigate"); // Execute (F8)
    expect(risk({ do: "key", key: 14 })).toBe("commit"); // Delete (Shift+F2)
    expect(risk({ do: "key", key: 20 })).toBe("commit"); // Release order (Shift+F8)
    expect(risk({ do: "okcode", value: "/14" })).toBe("commit");
  });
  test("a function key without a button is what its menu entry does", () => {
    expect(risk({ do: "key", key: 33 })).toBe("commit"); // Ctrl+F9: Reverse document
    expect(risk({ do: "key", key: 32 })).toBe("navigate"); // Ctrl+F8: Incompletion log
  });
  test("standard keys navigate; a key nothing on screen explains cannot be ruled out", () => {
    for (const key of [0, 3, 4, 12, 15, 82]) expect([key, risk({ do: "key", key })]).toEqual([key, "navigate"]);
    expect(risk({ do: "key", key: 9 })).toBe("commit");
    expect(assessAction({ do: "key", key: 9 }, EDIT, MENUS).reason).toContain("unknown");
  });
  test("transaction and session commands navigate", () => {
    for (const value of ["/nZT03", "/oZT03", "/n", "/nex", "/i", "ZT03"]) expect([value, risk({ do: "okcode", value })]).toEqual([value, "navigate"]);
  });
});

describe("assess: menus", () => {
  test("a menu entry follows its text and shortcut", () => {
    expect(risk({ do: "select", id: "wnd[0]/mbar/menu[0]/menu[1]" })).toBe("commit");
    expect(risk({ do: "select", id: "menu[0]/menu[2]" })).toBe("commit");
    expect(risk({ do: "select", id: "menu[0]/menu[0]" })).toBe("navigate");
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
    expect(assessAction({ do: "press", id: "btnSPOP-OPTION1" }, SAVE_POPUP, MENUS).reason).toContain("save your data");
  });
  test("an information popup that only reports a save is not a commit", () => {
    expect(risk({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, INFO_POPUP)).toBe("navigate");
    expect(risk({ do: "key", key: 0 }, INFO_POPUP)).toBe("navigate");
  });
  test("while a popup is open, a key means the popup's button, not the main window's", () => {
    expect(risk({ do: "key", key: 14 }, INFO_POPUP)).toBe("commit"); // unknown on the popup: cannot be ruled out
    expect(assessAction({ do: "key", key: 14 }, INFO_POPUP, MENUS).reason).toContain("unknown");
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
