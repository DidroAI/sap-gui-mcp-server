import { describe, expect, test } from "bun:test";
import { normalizeAction } from "../src/core/action.js";
import { decide, policyFromEnv } from "../src/core/guard.js";
import type { Action, Risk } from "../src/core/types.js";
import { searchButton } from "../src/core/words.js";
import { assessAction as fioriAction, assessControl } from "../src/fiori/risk.js";
import type { ControlFacts } from "../src/fiori/ui5.js";
import { assess } from "../src/sapgui/assess.js";
import type { Control, Screen } from "../src/sapgui/facts.js";
import { resolve } from "../src/sapgui/resolve.js";
import { assessAction } from "../src/webgui/assess.js";

// Guard over-refusals with SAP_WRITE=off found by eval-design's master-data validation (2026-11-22):
// S/4 transaction BP ("Open BP", the locator's "Start") and the OK of Fiori's "Adapt Filters" dialog
// (Manage Prices - Sales). Synthetic screens built like the live ones (S/4 Web GUI and launchpad, checked
// live the same day). Each screen offers Create, so nothing here rides on the display-screen rule.

const off = policyFromEnv({});
const lines = (...l: string[]) => l.join("\n");
const LOC = "wnd[0]/usr/subSCREEN_3000_RESIZING_AREA:SAPLBUS_LOCATOR:2240/subSCREEN_1010_LEFT_AREA:SAPLBUS_LOCATOR:3100/tabsGS_SCREEN_3100_TABSTRIP/tabpBUS_LOCATOR_TAB_02/ssubSCREEN_3100_TABSTRIP_AREA:SAPLBUS_LOCATOR:3202/subSCREEN_3200_SEARCH_AREA:SAPLBUS_LOCATOR:3211/subSCREEN_3200_SEARCH_BUTTON_AREA:SAPLBUS_LOCATOR:3240";

describe("words: a search button by its SAP name", () => {
  test("names that start a search", () => {
    for (const id of [`${LOC}/btnBUS_LOCA_SRCH01-GO`, "wnd[0]/usr/btnZ_SEARCH", "wnd[1]/usr/btnP_FIND"]) expect([id, searchButton(id)]).toEqual([id, true]);
  });
  test("other buttons, toolbars and fields do not", () => {
    for (const id of [`${LOC}/btnBUS_LOCA_SRCH01-CLEAR`, "wnd[0]/tbar[1]/btn[8]", "wnd[0]/usr/txtZ_SEARCH", "wnd[0]/usr/btnGOODS_ISSUE", "wnd[0]/usr/btnPOST_GO_LIVE"]) expect([id, searchButton(id)]).toEqual([id, false]);
  });
});

// ---- Web GUI: S/4 transaction BP, its first screen --------------------------------------------------------

const BP = lines(
  "TRANSACTION BP  PROGRAM SAPLBUS_LOCATOR  SCREEN 3000  SYSTEM XYZ (100) host",
  'WINDOW wnd[0]  "Maintain Business Partner"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[0]  button  Enter (Enter)",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[1]/btn[5]  button  Person  (Create Person (F5))",
  "wnd[0]/tbar[1]/btn[17]  button  Open BP  ((Shift+F5))",
  `${LOC.replace(/\/subSCREEN_3200_SEARCH_BUTTON_AREA.*$/, "")}/subSCREEN_3200_SEARCH_FIELDS_AREA:SAPLBUS_LOCATOR:3212/txtBUS_JOEL_SEARCH-PARTNER_NUMBER  field  Business Partner Number = "17100002"  (edit)`,
  `${LOC}/btnBUS_LOCA_SRCH01-GO  button  Start`,
  `${LOC}/btnBUS_LOCA_SRCH01-CLEAR  button  Delete Search Field Contents`,
);
const web = (action: Action, view = BP, language = "EN"): Risk => assessAction(action, view, [], { language }).risk;

describe("Web GUI: BP opens and finds partners with writing off", () => {
  test("Open BP and the locator's Start run", () => {
    for (const action of [{ do: "press", id: "wnd[0]/tbar[1]/btn[17]" }, { do: "press", id: `${LOC}/btnBUS_LOCA_SRCH01-GO` }] as Action[])
      expect([action.id, decide(off, normalizeAction(action), assessAction(action, BP, [], { language: "EN" })).run]).toEqual([action.id, true]);
  });
  test("Create Person is still a write", () => {
    expect(web({ do: "press", id: "wnd[0]/tbar[1]/btn[5]" })).toBe("commit");
  });
  test("a search button named as acting is held back; the name works in any language", () => {
    expect(web({ do: "press", id: `${LOC}/btnBUS_LOCA_SRCH01-GO` }, BP.replace("button  Start", "button  Execute mass run"))).toBe("commit");
    expect(web({ do: "press", id: `${LOC}/btnBUS_LOCA_SRCH01-GO` }, BP, "JA")).toBe("navigate");
    // "Open BP" is safe by its words only in a covered language.
    expect(web({ do: "press", id: "wnd[0]/tbar[1]/btn[17]" }, BP, "JA")).toBe("commit");
  });
});

// ---- SAP GUI for Windows: the same screen as the host's facts ---------------------------------------------

const btn = (id: string, tip: string, text = ""): Control => ({ id, type: "GuiButton", name: id.slice(id.lastIndexOf("/") + 1), text, tip, changeable: true });
const bp: Screen = {
  transaction: "BP",
  program: "SAPLBUS_LOCATOR",
  screen: "3000",
  language: "EN",
  activeWindow: "wnd[0]",
  windows: [
    {
      id: "wnd[0]",
      title: "Maintain Business Partner",
      controls: [
        { id: "wnd[0]", type: "GuiMainWindow", name: "wnd[0]", text: "Maintain Business Partner", tip: "", changeable: false },
        { id: "wnd[0]/tbar[0]/okcd", type: "GuiOkCodeField", name: "okcd" },
        btn("wnd[0]/tbar[1]/btn[5]", "Create Person   (F5)", "Person"),
        btn("wnd[0]/tbar[1]/btn[17]", "Open BP   (Shift+F5)", "Open BP"),
        btn(`${LOC}/btnBUS_LOCA_SRCH01-GO`, "Start", "Start"),
      ],
    },
  ],
};
const gui = (id: string): Risk => assess(bp, { do: "press", id }, resolve(bp, id)).risk;

describe("SAP GUI: BP opens and finds partners with writing off", () => {
  test("Open BP and Start run; Create Person is still a write", () => {
    expect(gui("wnd[0]/tbar[1]/btn[17]")).toBe("navigate");
    expect(gui(`${LOC}/btnBUS_LOCA_SRCH01-GO`)).toBe("navigate");
    expect(gui("wnd[0]/tbar[1]/btn[5]")).toBe("commit");
  });
});

// ---- Fiori: OK of the Adapt Filters dialog ----------------------------------------------------------------

const APP = "application-PricesInSales-manage-component---worklist--smartFilterBar";
// The dialog's text is its field list; scrolled, "Release Status" is among the first lines the reader keeps.
const FIELDS = "Adapt Filters Reset All Show Values Field Active Release Status Condition Type Valid On Previously Approved Condition Record";
const dlg = (title: string, more: Partial<NonNullable<ControlFacts["dialog"]>> = {}) => ({ type: "sap.m.Dialog", title, text: `${title} ${FIELDS}`, ...more });
const okOf = (dialog: NonNullable<ControlFacts["dialog"]>, id = `${APP}-adapt-filters-dialog-confirmBtn`): ControlFacts => ({ type: "sap.m.Button", id, text: "OK", buttonType: "Emphasized", dialog });
const EN = { language: "en-US" };

describe("Fiori: OK of a filter, sort or layout dialog only agrees to it", () => {
  test("Adapt Filters: by its opener, or by its title in a covered language", () => {
    expect(assessControl(okOf(dlg("Adapt Filters", { openedBy: `${APP}-btnFilters` })), EN).risk).toBe("navigate");
    expect(assessControl(okOf(dlg("Adapt Filters")), EN).risk).toBe("navigate");
    expect(assessControl(okOf(dlg("Filter anpassen", { openedBy: `${APP}-btnFilters` })), { language: "ja" }).risk).toBe("navigate");
    const action: Action = { do: "press", id: `${APP}-adapt-filters-dialog-confirmBtn` };
    expect(decide(off, normalizeAction(action), fioriAction(action, okOf(dlg("Adapt Filters")), EN)).run).toBe(true);
  });
  test("Enter in the dialog presses that OK: it runs too", () => {
    expect(fioriAction({ do: "key", key: "Enter" }, undefined, { ...EN, dialogDefault: okOf(dlg("Adapt Filters")) }).risk).toBe("navigate");
  });
  test("a dialog that asks to release or delete keeps its OK a write", () => {
    expect(assessControl(okOf({ type: "sap.m.Dialog", title: "Release", text: "Release the condition records?" }, "__button9"), EN).risk).toBe("commit");
    expect(assessControl(okOf({ type: "sap.m.Dialog", title: "Delete Filter Variant", text: "Delete?" }, "__button9"), EN).risk).toBe("commit");
    // A title in an uncovered language proves nothing without an opener that says so.
    expect(assessControl(okOf({ type: "sap.m.Dialog", title: "Adapt Filters", text: FIELDS }, "__button9"), { language: "ja" }).risk).toBe("commit");
  });
});
