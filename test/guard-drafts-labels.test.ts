import { describe, expect, test } from "bun:test";
import { normalizeAction } from "../src/core/action.js";
import { decide, policyFromEnv } from "../src/core/guard.js";
import type { Action, Risk } from "../src/core/types.js";
import { deletesLines, draftDocument, draftEdit, itemViewButton } from "../src/core/words.js";
import { assess } from "../src/sapgui/assess.js";
import type { Control, Screen } from "../src/sapgui/facts.js";
import { resolve } from "../src/sapgui/resolve.js";
import { assessAction } from "../src/webgui/assess.js";
import { buttonLine, shortcutText } from "../src/webgui/labels.js";

// Live run of 2026-11-23 (NOTES P5, P7, P10): S/4 Web GUI button names "Company Code  ((Ctrl+F2))", "Enter
// Emphasized ((Enter))" and a menu button's screen-reader hint; ME21N / VA01 item buttons refused with writes off.

const off = policyFromEnv({});
const lines = (...l: string[]) => l.join("\n");
const EN = { language: "EN" };

// ---- P10 / P5: button names ---------------------------------------------------------------------------

describe("Web GUI button lines of S/4HANA 2025", () => {
  test("a tooltip that is only the shortcut joins the name", () => {
    expect(buttonLine("btn[26]  button  Company Code  ((Ctrl+F2))")).toBe("btn[26]  button  Company Code (Ctrl+F2)");
    expect(buttonLine("wnd[0]/tbar[1]/btn[37]  button  Header Output Preview  ((Ctrl+Shift+F1))")).toBe("wnd[0]/tbar[1]/btn[37]  button  Header Output Preview (Ctrl+Shift+F1)");
    expect(buttonLine("btn[12]  button  Cancel  ((Escape))")).toBe("btn[12]  button  Cancel (Escape)");
  });
  test("the screen-reader word of an emphasized button goes", () => {
    expect(buttonLine("btn[0]  button  Enter Emphasized  ((Enter))")).toBe("btn[0]  button  Enter (Enter)");
    expect(buttonLine("btn[11]  button  Save Emphasized  ((Ctrl+S))")).toBe("btn[11]  button  Save (Ctrl+S)");
  });
  test("a menu button's screen-reader hint gives way to its tooltip", () => {
    expect(buttonLine("wnd[0]/usr/cntlGRID/shellcont/shell/&MB_FILTER  button  Press Enter to trigger an action and Arrow Down to open the menu.  (Set Filter...)")).toBe(
      "wnd[0]/usr/cntlGRID/shellcont/shell/&MB_FILTER  button  Set Filter...",
    );
  });
  test("the reader's notes stay; ECC lines and other lines are unchanged", () => {
    expect(buttonLine('btn[9]  button  Locator On/Off  ((F9))  (behind ">>")  (greyed out: SAP does not offer it now)')).toBe('btn[9]  button  Locator On/Off (F9)  (behind ">>")  (greyed out: SAP does not offer it now)');
    for (const l of [
      "btn[3]  button  Back (F3)",
      "btn[5]  button  PO History  (Purchase Order History (F5))",
      "btn[30]  button  Sort (Ascending)",
      'txtX  field  Note = "Emphasized  ((Enter))"  (edit)',
      "btn[1]  button  Emphasized",
    ])
      expect(buttonLine(l)).toBe(l);
  });
  test("the shortcut a name carries, in every form", () => {
    expect(shortcutText("Back (F3)")).toBe("F3");
    expect(shortcutText("Company Code  ((Ctrl+F2))")).toBe("Ctrl+F2");
    expect(shortcutText("PO History  (Purchase Order History (F5))")).toBe("F5");
    expect(shortcutText('Save As Template  (Saves Current Selection as Template (Ctrl+F10))  (behind ">>")')).toBe("Ctrl+F10");
    expect(shortcutText("Save (Ctrl+S)  (greyed out: SAP does not offer it now)")).toBe("Ctrl+S");
    expect(shortcutText("Sort (Ascending)")).toBeUndefined();
    expect(shortcutText("Type (A)")).toBeUndefined();
  });
});

describe("Web GUI: a key reaches its button in S/4's \"((key))\" form (MD-03, BP display)", () => {
  const BP = (name: string) =>
    lines(
      "TRANSACTION BP  PROGRAM SAPLBUS_LOCATOR  SCREEN 3000",
      'WINDOW wnd[0]  "Display Organization: 17300031, role Supplier (Fin.Accounting)"',
      "wnd[0]/tbar[0]/okcd  command-field",
      "wnd[0]/tbar[0]/btn[0]  button  Enter (Enter)",
      "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
      "wnd[0]/tbar[1]/btn[6]  button  Switch Between Display and Change  ((F6))",
      `wnd[0]/tbar[1]/btn[26]  button  ${name}`,
    );
  test("as the reader now prints it, and as it was printed before", () => {
    for (const view of [BP("Company Code (Ctrl+F2)"), BP("Company Code  ((Ctrl+F2))")]) {
      const a = assessAction({ do: "key", key: "Ctrl+F2" }, view, [], EN);
      expect(a.risk).toBe("navigate");
      expect(a.reason).not.toContain("has no button");
      expect(decide(off, normalizeAction({ do: "key", key: "Ctrl+F2" }), a).run).toBe(true);
      expect(assessAction({ do: "key", key: "Control+F2" }, view, [], EN).risk).toBe("navigate");
    }
  });
  test("a key carried by a tooltip that names it, or by a button behind \">>\", is that button", () => {
    const view = lines(
      "TRANSACTION ME2L  PROGRAM RM06EL00  SCREEN 1000",
      'WINDOW wnd[0]  "Purchasing Documents per Supplier"',
      "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
      "wnd[0]/tbar[1]/btn[34]  button  Save As Template  (Saves Current Selection as Template (Ctrl+F10))  (behind \">>\")",
    );
    const a = assessAction({ do: "key", key: "Ctrl+F10" }, view, [], EN);
    expect(a.risk).toBe("commit");
    expect(a.reason).toContain("Save As Template");
  });
});

// ---- P7: new documents before their first save --------------------------------------------------------

describe("words: new documents", () => {
  const none = new Map<string, string>();
  test("draftDocument: a create transaction, a create title, no number", () => {
    expect(draftDocument("EN", "Create Purchase Order", "ME21N", new Map([["MEPO_TOPLINE-EBELN", ""]]))).toBe(true);
    expect(draftDocument("EN", "Create Standard Order: Overview", "VA01", none)).toBe(true);
    expect(draftDocument("DE", "Terminauftrag anlegen: Übersicht", "VA01", none)).toBe(true);
    // A number, another title, another transaction, an uncovered language.
    expect(draftDocument("EN", "Create Purchase Order", "ME21N", new Map([["MEPO_TOPLINE-EBELN", "4500000061"]]))).toBe(false);
    expect(draftDocument("EN", "Standard PO 4500000061 Change", "ME21N", none)).toBe(false);
    expect(draftDocument("EN", "Change Standard Order 5000: Overview", "VA02", none)).toBe(false);
    expect(draftDocument("EN", "Create Standard Order: Overview", "VA02", none)).toBe(false);
    expect(draftDocument("EN", "Display Purchase Order", "ME21N", none)).toBe(false);
    expect(draftDocument("JA", "Create Purchase Order", "ME21N", none)).toBe(false);
  });
  test("draftEdit: deleting, adding, copying or blocking a line; nothing else", () => {
    for (const t of ["Delete", "Copy Item", "Create item", "Block", "Unblock/Undelete", "Position löschen", "Delete item"]) expect([t, draftEdit(t)]).toEqual([t, true]);
    for (const t of ["Save", "Hold", "Park", "Post", "Release", "Send", "Print item", "Copy and print", "Fast Change", "Catalog", ""]) expect([t, draftEdit(t)]).toEqual([t, false]);
  });
  test("deletesLines: a question about lines, not about a template", () => {
    expect(deletesLines("EN", "Do you really want to delete the item?")).toBe(true);
    expect(deletesLines("DE", "Position löschen?")).toBe(true);
    expect(deletesLines("EN", "Delete template?")).toBe(false);
    expect(deletesLines("EN", "Save the item before deleting?")).toBe(false);
    expect(deletesLines("JA", "Do you really want to delete the item?")).toBe(false);
  });
  test("itemViewButton: by program and SAP name, and not when its text writes", () => {
    expect(itemViewButton("SAPMV45A", "BT_PEIN", "Schedule Lines for Item")).toBe(true);
    expect(itemViewButton("SAPLMEGUI", "DETAIL", "Choose PO Item")).toBe(true);
    expect(itemViewButton("SAPMV45A", "BT_POLO", "Delete item")).toBe(false);
    expect(itemViewButton("ZPROG", "BT_PEIN", "Schedule Lines for Item")).toBe(false);
    expect(itemViewButton("SAPMV45A", "BT_PEIN", "Delete schedule lines")).toBe(false);
  });
});

// ME21N as the live run read it (S/4 Web GUI, 2026-11-23), cut down.
const ITEMS = "wnd[0]/usr/subSUB0:SAPLMEGUI:0013/subSUB2:SAPLMEVIEWS:1100/subSUB2:SAPLMEVIEWS:1200/subSUB1:SAPLMEGUI:1211";
const ME21N = (title = "Create Purchase Order", number = "") =>
  lines(
    "TRANSACTION ME21N  PROGRAM SAPLMEGUI  SCREEN 14",
    `WINDOW wnd[0]  "${title}"`,
    "wnd[0]/tbar[0]/okcd  command-field",
    "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
    "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
    "wnd[0]/tbar[1]/btn[16]  button  Hold (Shift+F4)",
    "wnd[0]/tbar[1]/btn[14]  button  Park (Shift+F2)",
    "wnd[0]/tbar[1]/btn[17]  button  Other Purchase Order (Shift+F5)",
    `wnd[0]/usr/subSUB0:SAPLMEGUI:0013/subSUB0:SAPLMEGUI:0030/subSUB1:SAPLMEGUI:1105/txtMEPO_TOPLINE-EBELN  field  Purchasing Document = "${number}"  (edit)`,
    `${ITEMS}/tblSAPLMEGUITC_1211  table  rows 15 (visible 8); rows can be selected`,
    `${ITEMS}/btnDETAIL  button  Choose PO Item`,
    `${ITEMS}/btnDELETE  button  Delete`,
    `${ITEMS}/btnLOCK  button  Block`,
    `${ITEMS}/btnITEMCOPY  button  Copy Item`,
    `${ITEMS}/btnSCHNELLAEND  button  Fast Change`,
    `${ITEMS}/btnPOSTX  button  Post Goods Receipt`,
    `${ITEMS}/btnPRINTX  button  Print Item`,
    `${ITEMS}/btnSORTUP  button  Sort (Ascending)`,
  );
const web = (action: Action, view: string, language = "EN"): Risk => assessAction(action, view, [], { language }).risk;

describe("Web GUI: ME21N, a new purchase order before its first save", () => {
  test("Delete and Copy Item on a new item run with writes off", () => {
    for (const id of ["btnDELETE", "btnITEMCOPY", "btnLOCK"]) {
      const a = assessAction({ do: "press", id }, ME21N(), [], EN);
      expect([id, a.risk]).toEqual([id, "navigate"]);
      expect(decide(off, normalizeAction({ do: "press", id }), a).run).toBe(true);
    }
    expect(assessAction({ do: "press", id: "btnDELETE" }, ME21N(), [], EN).reason).toContain("not saved yet");
  });
  test("Save, Hold and Park stay refused, by button and by key; so do posting, printing and unknown functions", () => {
    for (const id of ["wnd[0]/tbar[0]/btn[11]", "wnd[0]/tbar[1]/btn[16]", "wnd[0]/tbar[1]/btn[14]", "btnPOSTX", "btnPRINTX", "btnSCHNELLAEND"]) expect([id, web({ do: "press", id }, ME21N())]).toEqual([id, "commit"]);
    for (const key of [11, 16, 14, "Ctrl+S", "Shift+F4"]) expect([key, web({ do: "key", key }, ME21N())]).toEqual([key, "commit"]);
  });
  test("an existing order (a number, a change title), an uncovered language, a popup over it: Delete stays a write", () => {
    expect(web({ do: "press", id: "btnDELETE" }, ME21N("Create Purchase Order", "4500000061"))).toBe("commit");
    expect(web({ do: "press", id: "btnDELETE" }, ME21N("Standard PO 4500000061 Change", "4500000061"))).toBe("commit");
    expect(web({ do: "press", id: "btnITEMCOPY" }, ME21N().replace("TRANSACTION ME21N", "TRANSACTION ME22N"))).toBe("commit");
    expect(web({ do: "press", id: "btnDELETE" }, ME21N(), "JA")).toBe("commit");
    expect(web({ do: "press", id: "btnDELETE" }, `${ME21N()}\nWINDOW wnd[1]  "Templates"\nwnd[1]/usr/btnX  button  Delete`)).toBe("commit");
  });
  test("item navigation runs in any mode", () => {
    for (const view of [ME21N(), ME21N("Standard PO 4500000061 Change", "4500000061")]) expect(web({ do: "press", id: "btnDETAIL" }, view)).toBe("navigate");
  });
  test("\"Delete the item?\" over the new order runs; over a saved one, or about a template, it is a write", () => {
    const ask = (main: string, question: string) => `${main}\nWINDOW wnd[1]  "Delete"\nwnd[1]/usr/txtQ  label  ${question}\nwnd[1]/usr/btnSPOP-OPTION1  button  Yes\nwnd[1]/usr/btnSPOP-OPTION2  button  No`;
    expect(web({ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }, ask(ME21N(), "Do you really want to delete the item?"))).toBe("navigate");
    expect(web({ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }, ask(ME21N("Standard PO 4500000061 Change", "4500000061"), "Do you really want to delete the item?"))).toBe("commit");
    expect(web({ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }, ask(ME21N(), "Do you really want to delete the template?"))).toBe("commit");
  });
});

const VA01 = (title = "Create Standard Order: Overview", tcode = "VA01") =>
  lines(
    `TRANSACTION ${tcode}  PROGRAM SAPMV45A  SCREEN 4001`,
    `WINDOW wnd[0]  "${title}"`,
    "wnd[0]/tbar[0]/okcd  command-field",
    "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
    "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
    'wnd[0]/usr/subSUBSCREEN_HEADER:SAPMV45A:4021/txtVBAK-VBELN  field  Standard Order = ""  (read-only)',
    "wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\01/ssubSUBSCREEN_BODY:SAPMV45A:4400/subSUBSCREEN_TC:SAPMV45A:4900/btnBT_PEIN  button  Schedule Lines for Item",
    "wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\01/ssubSUBSCREEN_BODY:SAPMV45A:4400/subSUBSCREEN_TC:SAPMV45A:4900/btnBT_PKON  button  Item conditions",
    "wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\01/ssubSUBSCREEN_BODY:SAPMV45A:4400/subSUBSCREEN_TC:SAPMV45A:4900/btnBT_POLO  button  Delete item",
  );

describe("Web GUI: VA01, VA02", () => {
  test("Schedule Lines for Item and Item conditions navigate, also in change mode", () => {
    for (const view of [VA01(), VA01("Change Standard Order 5000: Overview", "VA02")]) {
      expect(web({ do: "press", id: "btnBT_PEIN" }, view)).toBe("navigate");
      expect(web({ do: "press", id: "btnBT_PKON" }, view)).toBe("navigate");
    }
  });
  test("Delete item runs on a new order only", () => {
    expect(web({ do: "press", id: "btnBT_POLO" }, VA01())).toBe("navigate");
    expect(web({ do: "press", id: "btnBT_POLO" }, VA01("Change Standard Order 5000: Overview", "VA02"))).toBe("commit");
    expect(web({ do: "press", id: "btnBT_POLO" }, VA01().replace('Standard Order = ""', 'Standard Order = "5000"'))).toBe("commit");
    expect(web({ do: "press", id: "wnd[0]/tbar[0]/btn[11]" }, VA01())).toBe("commit");
  });
});

// ---- SAP GUI for Windows: the same rules ------------------------------------------------------------

const btn = (id: string, tip: string, text = ""): Control => ({ id, type: "GuiButton", name: id.slice(id.lastIndexOf("/") + 1), text, tip, changeable: true });
function gui(transaction: string, program: string, title: string, controls: Control[]): Screen {
  return { transaction, program, screen: "0014", language: "EN", activeWindow: "wnd[0]", windows: [{ id: "wnd[0]", title, controls: [{ id: "wnd[0]", type: "GuiMainWindow", name: "wnd[0]", text: title, tip: "", changeable: false }, ...controls] }] };
}
const risk = (s: Screen, action: Action): Risk => assess(s, action, action.id ? resolve(s, action.id) : undefined).risk;

describe("SAP GUI: ME21N and VA01 before the first save", () => {
  const me21n = (title: string, number: string) =>
    gui("ME21N", "SAPLMEGUI", title, [
      { id: "wnd[0]/tbar[0]/okcd", type: "GuiOkCodeField", name: "okcd" },
      btn("wnd[0]/tbar[0]/btn[11]", "Save   (Ctrl+S)"),
      btn("wnd[0]/tbar[1]/btn[16]", "Hold   (Shift+F4)", "Hold"),
      { id: `${ITEMS.replace(/SAPLMEGUI:1211$/, "SAPLMEGUI:1105")}/txtMEPO_TOPLINE-EBELN`, type: "GuiTextField", name: "MEPO_TOPLINE-EBELN", text: number, tip: "", changeable: true },
      btn(`${ITEMS}/btnDELETE`, "Delete"),
      btn(`${ITEMS}/btnITEMCOPY`, "Copy Item"),
    ]);
  test("Delete and Copy Item run; Save and Hold do not; an existing order keeps Delete a write", () => {
    const s = me21n("Create Purchase Order", "");
    expect(risk(s, { do: "press", id: "btnDELETE" })).toBe("navigate");
    expect(risk(s, { do: "press", id: "btnITEMCOPY" })).toBe("navigate");
    expect(risk(s, { do: "press", id: "wnd[0]/tbar[0]/btn[11]" })).toBe("commit");
    expect(risk(s, { do: "press", id: "wnd[0]/tbar[1]/btn[16]" })).toBe("commit");
    expect(risk(me21n("Create Purchase Order", "4500000061"), { do: "press", id: "btnDELETE" })).toBe("commit");
    expect(risk(me21n("Standard PO 4500000061 Change", "4500000061"), { do: "press", id: "btnDELETE" })).toBe("commit");
  });
  test("Yes on \"Delete the item?\" over the new order runs; over a saved order it is a write", () => {
    const ask = (main: Screen): Screen => ({
      ...main,
      activeWindow: "wnd[1]",
      windows: [
        ...main.windows,
        { id: "wnd[1]", title: "Delete", controls: [{ id: "wnd[1]/usr/txtQ", type: "GuiTextField", name: "Q", text: "Do you really want to delete the item?", tip: "", changeable: false }, btn("wnd[1]/usr/btnSPOP-OPTION1", "", "Yes"), btn("wnd[1]/usr/btnSPOP-OPTION2", "", "No")] },
      ],
    });
    expect(risk(ask(me21n("Create Purchase Order", "")), { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" })).toBe("navigate");
    expect(risk(ask(me21n("Create Purchase Order", "4500000061")), { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" })).toBe("commit");
  });
  test("VA02's Schedule Lines for Item navigates", () => {
    const s = gui("VA02", "SAPMV45A", "Change Standard Order 5000: Overview", [btn("wnd[0]/tbar[0]/btn[11]", "Save   (Ctrl+S)"), btn("wnd[0]/usr/btnBT_PEIN", "Schedule Lines for Item")]);
    expect(risk(s, { do: "press", id: "btnBT_PEIN" })).toBe("navigate");
  });
});
