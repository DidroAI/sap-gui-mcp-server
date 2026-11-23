import { describe, expect, test } from "bun:test";
import { normalizeAction } from "../src/core/action.js";
import { decide, policyFromEnv, unknownEffect } from "../src/core/guard.js";
import type { Action, Assessment, Risk } from "../src/core/types.js";
import { displayScreen, removesViewCriterion, safeWord, viewDialog } from "../src/core/words.js";
import { assessAction as fioriAssess } from "../src/fiori/risk.js";
import type { ControlFacts } from "../src/fiori/ui5.js";
import { assess } from "../src/sapgui/assess.js";
import type { Control, Screen } from "../src/sapgui/facts.js";
import { resolve } from "../src/sapgui/resolve.js";
import { assessAction as webAssess } from "../src/webgui/assess.js";

// Over-refusals with SAP_WRITE=off seen in the Haiku pilot of 2026-11-23 (F-L08, P2P-06, F-N05, G-L08, MD-03,
// REP-07.ecc and their neighbours): ids that are not on the screen refused as writes, navigation on display
// transactions and list functions refused, and a refusal text that told the agent to give up. Screens are
// rebuilt from the runs' views.

const off = policyFromEnv({});
const lines = (...l: string[]) => l.join("\n");
const refusedText = (a: Assessment, action: Action = { do: "press", id: "x" }): string => {
  const v = decide(off, normalizeAction(action), a);
  return !v.run && "refused" in v ? v.refused : "";
};

// ---- 1. an id that is not on the screen -------------------------------------------------------

describe("an id the screen does not have fails as such, before any risk is judged", () => {
  const EN = { language: "en-US" };
  test("Fiori: a whole sap_look line pasted as the id names the id it holds", () => {
    expect(() => fioriAssess({ do: "press", id: "navpopover.SmartLink #__link0-__clone1" }, undefined, EN)).toThrow('the id is the text after #, "__link0-__clone1"');
    expect(() => fioriAssess({ do: "click", id: "ColumnListItem #:ColumnListItem-__clone19" }, undefined, EN)).toThrow('"ColumnListItem #:ColumnListItem-__clone19" is a line of sap_look, type and id: the id is the text after #, ":ColumnListItem-__clone19"');
  });
  test("Fiori: a shown text used as an id, and an id from an earlier screen", () => {
    expect(() => fioriAssess({ do: "dblclick", id: "Foreign US Supplier (DE) 1042S Withholdi" }, undefined, EN)).toThrow("An id has no spaces");
    for (const id of ["__tile69", "__mbox-btn-0", "ItemsFacet::gridTable-rows-row0-navigation"]) {
      let message = "";
      try {
        fioriAssess({ do: "press", id }, undefined, EN);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toStartWith(`No control "${id}" on this screen.`);
      expect(message).not.toContain("writes are off");
      expect(message).not.toContain("another way");
    }
  });
  test("SAP GUI: no control, not a write", () => {
    const s: Screen = { transaction: "XD03", program: "SAPMF02D", screen: "7000", language: "EN", activeWindow: "wnd[0]", windows: [{ id: "wnd[0]", title: "Display Customer: General Data", controls: [] }] };
    expect(() => assess(s, { do: "press", id: "btn[99]" }, undefined)).toThrow('No control "btn[99]" on this screen');
  });
  test("Web GUI: an id the view lacks is said to be missing (the reader then asks the page), and the guard does not tell the agent to give up", () => {
    const view = lines("TRANSACTION VA05  PROGRAM SAPLSLVC_FULLSCREEN  SCREEN 500", 'WINDOW wnd[0]  "List of Sales Orders"', "wnd[0]/tbar[0]/okcd  command-field");
    const a = webAssess({ do: "press", id: "btnGHOST" }, view, [], { language: "EN" });
    expect(a.reason).toContain("not on the screen the server read");
    const text = refusedText(a);
    expect(text).not.toContain("another way");
    expect(text).toContain("sap_look");
    expect(text).toContain("SAP_WRITE");
  });
});

// ---- 3. the refusal text ----------------------------------------------------------------------

describe("refusal text: firm for writes, not a dead end for what the server could not tell", () => {
  test("a real write still says not to look for another way", () => {
    const save: Assessment = { risk: "commit", reason: "key 11: Save" };
    expect(unknownEffect(save)).toBe(false);
    expect(refusedText(save, { do: "key", key: 11 })).toContain("do not look for another way");
  });
  test("a key no button carries: what would make it run, no give-up", () => {
    const a: Assessment = { risk: "commit", reason: "key 26 has no button on this screen, so what it does is unknown" };
    expect(unknownEffect(a)).toBe(true);
    const text = refusedText(a, { do: "key", key: 26 });
    expect(text).toContain("nothing was sent");
    expect(text).toContain("a key that has a button there");
    expect(text).not.toContain("another way");
  });
  test("confirm mode still asks for it", () => {
    const a: Assessment = { risk: "commit", reason: "key 26 has no button on this screen, so what it does is unknown" };
    expect(decide(policyFromEnv({ SAP_WRITE: "confirm" }), normalizeAction({ do: "key", key: 26 }), a)).toEqual({ run: false, confirm: a.reason });
  });
});

// ---- 2. reads: display transactions, list functions, Fiori rows and links -----------------------

describe("words", () => {
  test("totals and subtotals of a list", () => {
    for (const t of ["Total (Ctrl+F6)", "Subtotals... (Ctrl+F7)", "Zwischensummen...", "Sous-totaux"]) expect([t, safeWord("EN", t)]).toEqual([t, "totals"]);
    expect(safeWord("EN", "Post Total")).toBeUndefined();
  });
  test("removing a criterion from a view", () => {
    for (const t of ["Remove filter criterion (F6)", "Remove Condition", "Delete Sort Criterion", "Filterkriterium entfernen"]) expect([t, removesViewCriterion("EN", t)]).toEqual([t, true]);
    for (const t of ["Delete", "Remove Item", "Delete and save filter", "Save Condition"]) expect([t, removesViewCriterion("EN", t)]).toEqual([t, false]);
    expect(removesViewCriterion("JA", "Remove Condition")).toBe(false);
    expect(viewDialog("EN", "Filter")).toBe(true);
    expect(viewDialog("EN", "Define Sort Order")).toBe(true);
    expect(viewDialog("EN", "Save Layout")).toBe(false);
  });
  test("a display transaction is a display screen unless its title says it changes", () => {
    expect(displayScreen("EN", "Standard PO 4500000061 Created by Franz Musterman", "ME23N")).toBe(true);
    expect(displayScreen("EN", "Standard PO 4500000061 Change", "ME23N")).toBe(false);
    expect(displayScreen("EN", "Standard PO 4500000061 Created by Franz Musterman", "ME22N")).toBe(false);
    expect(displayScreen("JA", "Standard PO 4500000061", "ME23N")).toBe(false);
  });
});

// SAP GUI for Windows: the host's facts. Greyed out is changeable: false (Save on a display screen).
const btn = (id: string, tip: string, text = "", changeable = true): Control => ({ id, type: "GuiButton", name: id.slice(id.lastIndexOf("/") + 1), text, tip, changeable });
const label = (id: string, text: string): Control => ({ id, type: "GuiLabel", name: id.slice(id.lastIndexOf("/") + 1), text, tip: "", changeable: false });
const SYSTEM_TOOLBAR = (saveOn = false): Control[] => [
  { id: "wnd[0]/tbar[0]/okcd", type: "GuiOkCodeField", name: "okcd" },
  btn("wnd[0]/tbar[0]/btn[0]", "Enter   (Enter)"),
  btn("wnd[0]/tbar[0]/btn[11]", "Save   (Ctrl+S)", "", saveOn),
  btn("wnd[0]/tbar[0]/btn[3]", "Back   (F3)"),
];
function gui(transaction: string, title: string, controls: Control[], more: Partial<Screen> = {}): Screen {
  return { transaction, program: "SAPLX", screen: "0100", language: "EN", activeWindow: "wnd[0]", windows: [{ id: "wnd[0]", title, controls: [{ id: "wnd[0]", type: "GuiMainWindow", name: "wnd[0]", text: title, tip: "", changeable: false }, ...controls] }], ...more };
}
const risk = (s: Screen, action: Action): Risk => assess(s, action, action.id ? resolve(s, action.id) : undefined).risk;

describe("SAP GUI: navigation on display transactions runs with writes off", () => {
  const XD03 = gui("XD03", "Display Customer: General Data", [
    ...SYSTEM_TOOLBAR(),
    btn("wnd[0]/tbar[1]/btn[17]", "Choose another customer   (Shift+F5)", "Other Customer"),
    btn("wnd[0]/tbar[1]/btn[27]", "Sales Area Data   (Ctrl+F3)", "Sales Area Data"),
    btn("wnd[0]/tbar[1]/btn[5]", "Display -> Change   (F5)"),
  ]);
  test("G-L08 XD03: Sales Area Data, by button and by key", () => {
    expect(risk(XD03, { do: "press", id: "btn[27]" })).toBe("navigate");
    expect(risk(XD03, { do: "key", key: 27 })).toBe("navigate");
  });
  test("MD-03 BP in display mode: Company Code", () => {
    const BP = gui("BP", "Display Organization: 17300031, role Supplier (Fin.Accounting)", [
      ...SYSTEM_TOOLBAR(),
      btn("wnd[0]/tbar[1]/btn[6]", "Switch Between Display and Change   (F6)"),
      btn("wnd[0]/tbar[1]/btn[26]", "Company Code   (Ctrl+F2)", "Company Code"),
    ]);
    expect(risk(BP, { do: "press", id: "btn[26]" })).toBe("navigate");
    expect(risk(BP, { do: "key", key: 26 })).toBe("navigate");
  });
  test("ME23N, whose title names the order: a button of the transaction navigates; with Save on offer, or in ME22N, it does not", () => {
    const body = [btn("wnd[0]/tbar[1]/btn[9]", "Account Assignments   (Shift+F9)", "Account Assignments")];
    const title = "Standard PO 4500000061 Created by Franz Musterman";
    expect(risk(gui("ME23N", title, [...SYSTEM_TOOLBAR(), ...body]), { do: "press", id: "btn[9]" })).toBe("navigate");
    expect(risk(gui("ME23N", title, [...SYSTEM_TOOLBAR(true), ...body]), { do: "press", id: "btn[9]" })).toBe("commit");
    expect(risk(gui("ME22N", title, [...SYSTEM_TOOLBAR(), ...body]), { do: "press", id: "btn[9]" })).toBe("commit");
  });
  test("SE16's Table Contents (F7) and VA03's Schedule lines for item", () => {
    expect(risk(gui("SE16", "Data Browser: Initial Screen", [...SYSTEM_TOOLBAR(), btn("wnd[0]/tbar[1]/btn[7]", "Table Contents   (F7)")]), { do: "press", id: "btn[7]" })).toBe("navigate");
    const VA03 = gui("VA03", "Display Standard Order 5000: Overview", [...SYSTEM_TOOLBAR(), btn("wnd[0]/usr/btnBT_PEIN", "Schedule lines for item")]);
    expect(risk(VA03, { do: "press", id: "btnBT_PEIN" })).toBe("navigate");
  });
  test("a function that acts or writes is still held back on a display transaction", () => {
    const s = gui("VA03", "Display Standard Order 5000: Overview", [...SYSTEM_TOOLBAR(), btn("wnd[0]/tbar[1]/btn[20]", "Print   (Ctrl+P)", "Print"), btn("wnd[0]/tbar[1]/btn[21]", "Delete Order", "Delete Order")]);
    expect(risk(s, { do: "press", id: "btn[20]" })).toBe("commit");
    expect(risk(s, { do: "press", id: "btn[21]" })).toBe("commit");
  });
});

describe("SAP GUI: ALV list functions that only change the view run with writes off", () => {
  const VA05 = gui("VA05", "List of Sales Orders (9 Entries)", [
    ...SYSTEM_TOOLBAR(true),
    btn("wnd[0]/tbar[1]/btn[30]", "Total   (Ctrl+F6)", "Total"),
    btn("wnd[0]/tbar[1]/btn[31]", "Subtotals...   (Ctrl+F7)"),
    btn("wnd[0]/tbar[1]/btn[32]", "Change Layout...   (Ctrl+F8)"),
  ]);
  test("REP-01 / REP-07.ecc: Total, Subtotals, Change Layout", () => {
    expect(risk(VA05, { do: "press", id: "btn[30]" })).toBe("navigate");
    expect(risk(VA05, { do: "press", id: "btn[31]" })).toBe("navigate");
    expect(risk(VA05, { do: "press", id: "btn[32]" })).toBe("navigate");
  });
  test("REP-07.ecc: a screen button named as a grid toolbar button says how to press it", () => {
    expect(() => assess(VA05, { do: "toolbar", id: "btn[32]", button: "btn[32]" }, resolve(VA05, "btn[32]"))).toThrow('Press it: {"do":"press","id":"btn[32]"}');
  });
  test("REP-03: Remove filter criterion in the Filter dialog; the same words outside such a dialog stay a commit", () => {
    const filter: Screen = {
      ...VA05,
      activeWindow: "wnd[1]",
      windows: [
        ...VA05.windows,
        { id: "wnd[1]", title: "Filter", controls: [btn("wnd[1]/usr/btnAPP_FL_SING", "Remove filter criterion   (F6)", "Remove filter criterion (F6)"), btn("wnd[1]/tbar[0]/btn[0]", "Copy   (Enter)")] },
      ],
    };
    expect(risk(filter, { do: "press", id: "wnd[1]/usr/btnAPP_FL_SING" })).toBe("navigate");
    const pricing = gui("VA02", "Change Standard Order 5000: Item Data", [...SYSTEM_TOOLBAR(true), btn("wnd[0]/usr/btnDELETE_COND", "Remove Condition", "Remove Condition")]);
    expect(risk(pricing, { do: "press", id: "btnDELETE_COND" })).toBe("commit");
    const popup: Screen = { ...pricing, activeWindow: "wnd[1]", windows: [...pricing.windows, { id: "wnd[1]", title: "Conditions", controls: [label("wnd[1]/usr/txt", "Conditions"), btn("wnd[1]/usr/btnDEL", "Remove Condition", "Remove Condition")] }] };
    expect(risk(popup, { do: "press", id: "wnd[1]/usr/btnDEL" })).toBe("commit");
  });
});

// ---- Web GUI: full views ----------------------------------------------------------------------

const web = (action: Action, view: string): Risk => webAssess(action, view, [], { language: "EN" }).risk;

describe("Web GUI: the same reads", () => {
  test("ME23N's buttons navigate when Save is not on offer", () => {
    const view = lines(
      "TRANSACTION ME23N  PROGRAM SAPLMEGUI  SCREEN 14  SYSTEM XYZ (100) host",
      'WINDOW wnd[0]  "Standard PO 4500000061 Created by Franz Musterman"',
      "wnd[0]/tbar[0]/okcd  command-field",
      "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
      "wnd[0]/tbar[1]/btn[9]  button  Account Assignments (Shift+F9)",
    );
    expect(web({ do: "press", id: "wnd[0]/tbar[1]/btn[9]" }, view)).toBe("navigate");
    expect(web({ do: "press", id: "wnd[0]/tbar[1]/btn[9]" }, `${view}\nwnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)`)).toBe("commit");
  });
  test("ALV Total and the Filter dialog's Remove filter criterion", () => {
    const list = lines(
      "TRANSACTION VF05  PROGRAM SAPLSALV_CUL_CONFIGURATION  SCREEN 1500",
      'WINDOW wnd[0]  "List of Billing Documents"',
      "wnd[0]/tbar[0]/okcd  command-field",
      "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
      "wnd[0]/tbar[1]/btn[30]  button  Total (Ctrl+F6)",
    );
    expect(web({ do: "press", id: "wnd[0]/tbar[1]/btn[30]" }, list)).toBe("navigate");
    const filter = lines(list, 'WINDOW wnd[1]  "Filter"', "wnd[1]/usr/subSUB_CONFIGURATION:SAPLSALV_CUL_FILTER_CRITERIA:0600/btnAPP_FL_SING  button  Remove filter criterion (F6)", "wnd[1]/tbar[0]/btn[0]  button  Copy (Enter)");
    expect(web({ do: "press", id: "btnAPP_FL_SING" }, filter)).toBe("navigate");
  });
});

// ---- Fiori ------------------------------------------------------------------------------------

describe("Fiori: list rows and links that open an object page", () => {
  const EN = { language: "en-US" };
  const table: ControlFacts = { type: "sap.m.Table", id: "app::C_PurchaseOrderTP--responsiveTable", text: "Purchase Orders (2,726)", handlers: ["_onItemPress"] };
  test("F-L08 / P2P-06: a row of the list report, by the table and a row number", () => {
    expect(fioriAssess({ do: "dblclick", id: "C_PurchaseOrderTP--responsiveTable", row: 0 }, table, EN).risk).toBe("navigate");
    expect(fioriAssess({ do: "select", id: "C_PurchaseOrderTP--responsiveTable", row: 0 }, table, EN).risk).toBe("navigate");
    expect(fioriAssess({ do: "press", id: "x" }, { type: "sap.ui.table.AnalyticalTable", id: "t", text: "Line Items (23)" }, EN).risk).toBe("navigate");
  });
  test("a table whose press handler names a write is still a commit", () => {
    expect(fioriAssess({ do: "press", id: "t" }, { ...table, handlers: ["onDeleteItem"] }, EN).risk).toBe("commit");
  });
  test("F-L08: the PO type link of a row, and a row itself", () => {
    expect(fioriAssess({ do: "press", id: "__link0-__clone1" }, { type: "sap.ui.comp.navpopover.SmartLink", id: "__link0-__clone1", text: "Standard PO" }, EN).risk).toBe("navigate");
    expect(fioriAssess({ do: "press", id: ":ColumnListItem-__clone19" }, { type: "sap.m.ColumnListItem", id: "x:ColumnListItem-__clone19", text: "4500000509" }, EN).risk).toBe("navigate");
  });
  test("REP-05/06: Remove Condition in a value help removes a filter condition; outside one it stays a commit", () => {
    const remove: ControlFacts = { type: "sap.m.Button", id: "__button26", text: "Remove Condition", inValueHelp: true, dialog: { type: "sap.ui.comp.valuehelpdialog.ValueHelpDialog", title: "Journal Entry Date", text: "" } };
    expect(fioriAssess({ do: "press", id: "__button26" }, remove, EN).risk).toBe("read");
    expect(fioriAssess({ do: "press", id: "__button26" }, { type: "sap.m.Button", id: "__button26", text: "Remove Condition" }, EN).risk).toBe("commit");
  });
});
