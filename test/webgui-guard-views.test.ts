import { describe, expect, test } from "bun:test";
import { normalizeAction } from "../src/core/action.js";
import { decide, policyFromEnv } from "../src/core/guard.js";
import type { Action, Assessment } from "../src/core/types.js";
import { type AssessContext, assessAction, popupButton, SAFE_KEYS } from "../src/webgui/assess.js";
import type { MenuEntry } from "../src/webgui/page.js";

// Regression tests for the guard, built from full views saved from live screens of the bench of
// 2026-11-15 (ECC sandbox, IDES demo data; bench/findings md.md MD-03, key.md KEY-02/03, p2p.md
// P2P-10). Each view is cut down to the lines the rules read. With writing off, every "navigate"
// below was refused before ("this action may write to SAP"), which blocked display transactions.

const EN: AssessContext = { language: "EN" };
const judge = (action: Action, view: string, menus: MenuEntry[] = [], ctx: AssessContext = EN): Assessment => assessAction(normalizeAction(action), view, menus, ctx);
const risk = (action: Action, view: string, menus: MenuEntry[] = [], ctx: AssessContext = EN) => judge(action, view, menus, ctx).risk;
const lines = (...l: string[]) => l.join("\n");

// MM03 initial screen and its menus (Goto holds Organizational Levels and Data).
const MM03_INIT = lines(
  "TRANSACTION MM03  PROGRAM SAPLMGMM  SCREEN 60  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Display Material (Initial Screen)"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[0]/btn[12]  button  Cancel (Escape)",
  "wnd[0]/tbar[1]/btn[5]  button  Select View(s) (F5)",
  "wnd[0]/tbar[1]/btn[6]  button  Org. Levels (F6)",
  "wnd[0]/tbar[1]/btn[7]  button  Data (F7)",
  'wnd[0]/usr/ctxtRMMG1-MATNR  field  Material = ""  (edit)',
  "wnd[0]/mbar  menubar  Material {menu[0]}, Edit {menu[1]}, Goto {menu[2]}, Defaults {menu[3]}, System {menu[4]}, Help {menu[5]}",
);
const MM03_MENUS: MenuEntry[] = [
  { sid: "wnd[0]/mbar/menu[0]", text: "Material", key: "" },
  { sid: "wnd[0]/mbar/menu[0]/menu[0]", text: "Other Material", key: "SHIFT_F5" },
  { sid: "wnd[0]/mbar/menu[0]/menu[4]", text: "Flag for deletion", key: "" },
  { sid: "wnd[0]/mbar/menu[0]/menu[4]/menu[0]", text: "Immediately", key: "" },
  { sid: "wnd[0]/mbar/menu[0]/menu[5]", text: "Save", key: "" },
  { sid: "wnd[0]/mbar/menu[2]", text: "Goto", key: "" },
  { sid: "wnd[0]/mbar/menu[2]/menu[0]", text: "Select View(s)...", key: "F5" },
  { sid: "wnd[0]/mbar/menu[2]/menu[1]", text: "Organizational Levels...", key: "F6" },
  { sid: "wnd[0]/mbar/menu[2]/menu[2]", text: "Data", key: "F7" },
  { sid: "wnd[0]/mbar/menu[2]/menu[3]", text: "Back", key: "F3" },
  { sid: "wnd[0]/mbar/menu[4]", text: "System", key: "" },
  { sid: "wnd[0]/mbar/menu[4]/menu[8]", text: "Log Off", key: "" },
];

// MM03's Select View(s) popup over the initial screen.
const MM03_VIEWS = lines(
  ...MM03_INIT.split("\n"),
  'WINDOW wnd[1]  "Select View(s)"',
  "wnd[1]/usr/tblSAPLMGMMTC_VIEW  table  rows 41 (visible 17); columns: View",
  "wnd[1]/usr/chkUSRM1-AAUSW  checkbox  [ ] View selection only on request",
  "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)",
  "wnd[1]/tbar[0]/btn[6]  button  Org. Levels (F6)",
  "wnd[1]/tbar[0]/btn[7]  button  Data (F7)",
  "wnd[1]/tbar[0]/btn[20]  button  Select All (Shift+F8)",
  "wnd[1]/tbar[0]/btn[14]  button  Default Setting  (Save as Default Values (Shift+F2))",
  "wnd[1]/tbar[0]/btn[12]  button  Cancel (Escape)",
);

// A material's data screen in create mode (MMH1): navigation next to functions that write.
const MMH1_BASIC = lines(
  "TRANSACTION MMH1  PROGRAM SAPLMGMM  SCREEN 4004  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Create Trading Goods 50066115"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[1]/btn[17]  button  Other Material (Shift+F5)",
  "wnd[0]/tbar[1]/btn[30]  button  Additional Data  (Go to Additional Data (Ctrl+F6))",
  "wnd[0]/tbar[1]/btn[13]  button  Org. Levels (Shift+F1)",
  "wnd[0]/tbar[1]/btn[19]  button  Check Screen Data (Shift+F7)",
  "wnd[0]/tbar[1]/btn[37]  button  Lock material (Ctrl+Shift+F1)",
  "wnd[0]/usr/tabsTABSPR1/tabpSP01  tab  Basic Data 1 (selected)",
  "wnd[0]/usr/tabsTABSPR1/tabpSP01/ssubTABFRA1:SAPLMGMM:2004/subSUB1:SAPLMGD1:1002/btnRMMZU_REVLP  button  Create revision level",
);

// XD03's initial popup (sales area), and the address screen with XD03's Goto menu.
const XD03_INIT = lines(
  "TRANSACTION XD03  PROGRAM SAPMF02D  SCREEN 101  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Customer Display: Initial Screen"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  'WINDOW wnd[1]  "Customer Display: Initial Screen"',
  "wnd[1]/usr/btnSEARCH_CUSTOMER  button  Find",
  'wnd[1]/usr/ctxtRF02D-KUNNR  field  Customer Account Number = ""  (edit)',
  "wnd[1]/usr/btnBUTTON1  button  All sales areas...",
  "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)",
  "wnd[1]/tbar[0]/btn[14]  button  Check consistency of entry (Shift+F2)",
  "wnd[1]/tbar[0]/btn[7]  button  Create (F7)",
  "wnd[1]/tbar[0]/btn[8]  button  Change (F8)",
  "wnd[1]/tbar[0]/btn[12]  button  Cancel (Escape)",
);
const XD03_ADDR = lines(
  "TRANSACTION XD03  PROGRAM SAPMF02D  SCREEN 7000  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Display Customer: General Data"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[1]/btn[17]  button  Other Customer  (Choose another customer (Shift+F5))",
  "wnd[0]/tbar[1]/btn[26]  button  Company Code Data (Ctrl+F2)",
  "wnd[0]/tbar[1]/btn[27]  button  Sales Area Data (Ctrl+F3)",
  "wnd[0]/tbar[1]/btn[8]  button  Display next tab page (F8)",
  "wnd[0]/usr/subSUBTAB:SAPLATAB:0100/tabsTABSTRIP100/tabpTAB01  tab  Address (selected)",
);
const XD03_MENUS: MenuEntry[] = [
  { sid: "wnd[0]/mbar/menu[0]", text: "Customer", key: "" },
  { sid: "wnd[0]/mbar/menu[0]/menu[2]", text: "Save", key: "" },
  { sid: "wnd[0]/mbar/menu[2]", text: "Goto", key: "" },
  { sid: "wnd[0]/mbar/menu[2]/menu[1]", text: "Next Tab Page", key: "F8" },
  { sid: "wnd[0]/mbar/menu[2]/menu[3]", text: "Company Code Data", key: "" },
  { sid: "wnd[0]/mbar/menu[2]/menu[4]", text: "Sales Area Data", key: "" },
  { sid: "wnd[0]/mbar/menu[3]", text: "Extras", key: "" },
  { sid: "wnd[0]/mbar/menu[3]/menu[3]", text: "Confirmation of Change", key: "" },
];

// Web GUI's search help (F4 on Material Group).
const F4_SEARCH_HELP = lines(
  ...MMH1_BASIC.split("\n"),
  'WINDOW wnd[1]  "Material Group (1)"',
  "wnd[1]/shell/critcol  tab  Restrictions",
  "wnd[1]/shell/gridRESULT  grid  448 rows; columns: MATKL=Matl Group | WGBEZ=Material Group Desc.",
  "  row 0: 001 | Metal processing",
  "wnd[1]/shell/btnSEARCH  button  Find",
  "wnd[1]/shell/gridRESULT/tbar/btnCOPY  button  Copy",
  "wnd[1]/shell/gridRESULT/tbar/btnPRINT  button  Print (Server)",
  "wnd[1]/shell/tbar/btnCLOSE  button  Cancel",
);

// XD01: an error message in a popup over the initial popup.
const ERROR_POPUP = lines(
  ...XD03_INIT.split("\n").map((l) => l.replace("XD03", "XD01").replace("Customer Display", "Customer Create")),
  'WINDOW wnd[2]  "Error"',
  "wnd[2]/usr/txtMESSTXT1  label  Acct group General customers uses ext. no.",
  "wnd[2]/usr/txtMESSTXT2  label  assignment. Specify an account number",
  "wnd[2]/tbar[0]/btn[0]  button  Confirm (Enter)",
  "wnd[2]/tbar[0]/btn[1]  button  Help (F1)",
);

// XD02: Cancel (F12) after a change asks whether to throw the input away.
const LOSS_POPUP = lines(
  "TRANSACTION XD02  PROGRAM SAPMF02D  SCREEN 7000  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Change Customer: General Data"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
  'wnd[0]/usr/txtKNA1-BAHNE  field  Express station = "DIDRO"  (edit)',
  'WINDOW wnd[1]  "Cancel Customer"',
  "wnd[1]/usr/txtSPOP-DIAGNOSE  label  Data will be lost.",
  "wnd[1]/usr/txtSPOP-TEXTLINE1  label  Do you want to cancel processing",
  "wnd[1]/usr/txtSPOP-TEXTLINE2  label  of this customer?",
  "wnd[1]/usr/btnSPOP-OPTION1  button  Yes",
  "wnd[1]/usr/btnSPOP-OPTION2  button  No",
);

// XD02: a warning in a popup, with a second button.
const WARNING_POPUP = lines(
  "TRANSACTION XD02  PROGRAM SAPMF02D  SCREEN 101  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Customer Change: Initial Screen"',
  'WINDOW wnd[2]  "Warning"',
  "wnd[2]/usr/txtMESSTXT1  label  No sales area data has been maintained for",
  "wnd[2]/usr/txtMESSTXT2  label  customer 3451",
  "wnd[2]/tbar[0]/btn[0]  button  Continue (Enter)",
  "wnd[2]/tbar[0]/btn[5]  button  New entry (F5)",
  "wnd[2]/tbar[0]/btn[1]  button  Help (F1)",
);

// MM02 left with unsaved changes: the save question (Yes saves).
const SAVE_QUESTION = lines(
  "TRANSACTION MM02  PROGRAM SAPLMGMM  SCREEN 4004  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Change Material 50066115 (Trading goods)"',
  "wnd[0]/tbar[0]/okcd  command-field",
  'WINDOW wnd[1]  "Exit"',
  "wnd[1]/usr/txtSPOP-DIAGNOSE1  label  You are about to exit.",
  "wnd[1]/usr/txtSPOP-TEXTLINE1  label  Do you want to save your data",
  "wnd[1]/usr/txtSPOP-TEXTLINE2  label  for this material first?",
  "wnd[1]/usr/btnSPOP-OPTION1  button  Yes",
  "wnd[1]/usr/btnSPOP-OPTION2  button  No",
  "wnd[1]/usr/btnSPOP-OPTION_CAN  button  Cancel",
);

// /i: Web GUI asks before logging off.
const LOGOFF_POPUP = lines(
  "TRANSACTION VA03  PROGRAM SAPMV45A  SCREEN 102  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Display Sales Order: Initial Screen"',
  'WINDOW wnd[1]  "Log Off"',
  "wnd[1]/usr/txtSPOP-TEXTLINE1  label  Unsaved data will be lost.",
  "wnd[1]/usr/txtSPOP-TEXTLINE2  label  Do you want to log off?",
  "wnd[1]/usr/btnSPOP-OPTION1  button  Yes",
  "wnd[1]/usr/btnSPOP-OPTION2  button  No",
);

// MB5B: a report's selection screen.
const MB5B = lines(
  "TRANSACTION MB5B  PROGRAM RM07MLBD  SCREEN 1000  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Stock on Posting Date"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[11]  button  Save as Variant... (Ctrl+S)",
  "wnd[0]/tbar[1]/btn[8]  button  Execute (F8)",
  "wnd[0]/tbar[1]/btn[17]  button  Get Variant... (Shift+F5)",
  'wnd[0]/usr/ctxtMATNR-LOW  field  Material Number = ""  (edit)',
  "wnd[0]/usr/btn%_MATNR_%_APP_%-VALU_PUSH  button  Multiple selection",
  "wnd[0]/usr/btnPB_LIU  button  Category",
);

describe("guard on saved live views: navigation is not a write (MD-03)", () => {
  const NAV: [string, string, Action, MenuEntry[]][] = [
    ["MM03 Org. Levels", MM03_INIT, { do: "press", id: "btn[6]" }, []],
    ["MM03 Org. Levels by key", MM03_INIT, { do: "key", key: 6 }, []],
    ["MM03 Data: its Goto menu entry", MM03_INIT, { do: "press", id: "btn[7]" }, MM03_MENUS],
    ["MM03 Data by key", MM03_INIT, { do: "key", key: 7 }, MM03_MENUS],
    ["MM03 Goto > Organizational Levels", MM03_INIT, { do: "select", id: "wnd[0]/mbar/menu[2]/menu[1]" }, MM03_MENUS],
    ["Select View(s): Org. Levels", MM03_VIEWS, { do: "press", id: "wnd[1]/tbar[0]/btn[6]" }, MM03_MENUS],
    ["Select View(s): Data, the main window's Data again", MM03_VIEWS, { do: "press", id: "wnd[1]/tbar[0]/btn[7]" }, MM03_MENUS],
    ["Select View(s): Data by key", MM03_VIEWS, { do: "key", key: 7 }, MM03_MENUS],
    ["Other Material", MMH1_BASIC, { do: "press", id: "btn[17]" }, []],
    ["Org. Levels on a data screen", MMH1_BASIC, { do: "press", id: "btn[13]" }, []],
    ["Check Screen Data", MMH1_BASIC, { do: "press", id: "btn[19]" }, []],
    ["XD03 Check consistency of entry", XD03_INIT, { do: "press", id: "wnd[1]/tbar[0]/btn[14]" }, []],
    ["XD03 Change (F8) only switches mode", XD03_INIT, { do: "press", id: "wnd[1]/tbar[0]/btn[8]" }, []],
    ["XD03 Company Code Data (Goto)", XD03_ADDR, { do: "press", id: "btn[26]" }, XD03_MENUS],
    ["XD03 Sales Area Data by key (Goto)", XD03_ADDR, { do: "key", key: 27 }, XD03_MENUS],
    ["XD03 Goto > Sales Area Data", XD03_ADDR, { do: "select", id: "wnd[0]/mbar/menu[2]/menu[4]" }, XD03_MENUS],
    ["search help Copy", F4_SEARCH_HELP, { do: "press", id: "btnCOPY" }, []],
    ["search help Print the hit list", F4_SEARCH_HELP, { do: "press", id: "btnPRINT" }, []],
    ["Confirm (Enter) on an error message", ERROR_POPUP, { do: "press", id: "wnd[2]/tbar[0]/btn[0]" }, []],
    ["Enter on an error message", ERROR_POPUP, { do: "key", key: 0 }, []],
    ["okcode Enter on it", ERROR_POPUP, { do: "okcode", value: "/0" }, []],
    ["Yes on Data will be lost", LOSS_POPUP, { do: "press", id: "btnSPOP-OPTION1" }, []],
    ["No on it", LOSS_POPUP, { do: "press", id: "btnSPOP-OPTION2" }, []],
    ["New entry (F5) on a warning", WARNING_POPUP, { do: "press", id: "wnd[2]/tbar[0]/btn[5]" }, []],
    ["its key", WARNING_POPUP, { do: "key", key: 5 }, []],
    ["MB5B Multiple selection", MB5B, { do: "press", id: "btn%_MATNR_%_APP_%-VALU_PUSH" }, []],
    ["MB5B Get Variant...", MB5B, { do: "press", id: "btn[17]" }, []],
    ["MB5B Category (a selection-screen pushbutton)", MB5B, { do: "press", id: "btnPB_LIU" }, []],
    ["F8 by key on a report", MB5B, { do: "key", key: 8 }, []],
  ];
  for (const [name, view, action, menus] of NAV)
    test(name, () => {
      expect([name, judge(action, view, menus).risk]).toEqual([name, "navigate"]);
    });

  test("F8 is safe as a key name too: SAFE_KEYS follows SAFE_VKEYS", () => {
    for (const k of ["F8", "ENTER", "F3", "ESCAPE", "SHIFT_F3", "CTRL_F", "PAGEDOWN"]) expect([k, SAFE_KEYS.has(k)]).toEqual([k, true]);
    const bare = lines("TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100) host", 'WINDOW wnd[0]  "Report"', "wnd[0]/tbar[0]/okcd  command-field");
    expect(risk({ do: "key", key: 8 }, bare)).toBe("navigate");
    expect(risk({ do: "key", key: "F8" }, bare)).toBe("navigate");
  });
});

describe("guard on saved live views: what may write stays a commit", () => {
  const COMMIT: [string, string, Action, MenuEntry[]][] = [
    ["Save", MMH1_BASIC, { do: "press", id: "btn[11]" }, []],
    ["Lock material", MMH1_BASIC, { do: "press", id: "btn[37]" }, []],
    ["Create revision level", MMH1_BASIC, { do: "press", id: "btnRMMZU_REVLP" }, []],
    ["Default Setting (Save as Default Values)", MM03_VIEWS, { do: "press", id: "wnd[1]/tbar[0]/btn[14]" }, MM03_MENUS],
    ["XD03 Create (F7): a create word, not ruled out", XD03_INIT, { do: "press", id: "wnd[1]/tbar[0]/btn[7]" }, []],
    ["Material > Flag for deletion > Immediately", MM03_INIT, { do: "select", id: "wnd[0]/mbar/menu[0]/menu[4]/menu[0]" }, MM03_MENUS],
    ["Yes on 'save your data first?'", SAVE_QUESTION, { do: "press", id: "btnSPOP-OPTION1" }, []],
    ["Enter there, with the focus unknown", SAVE_QUESTION, { do: "key", key: 0 }, []],
    ["Save as Variant (Ctrl+S)", MB5B, { do: "press", id: "btn[11]" }, []],
    ["a function key no button or menu entry carries", MM03_INIT, { do: "key", key: 9 }, MM03_MENUS],
  ];
  for (const [name, view, action, menus] of COMMIT)
    test(name, () => {
      expect([name, judge(action, view, menus).risk]).toEqual([name, "commit"]);
    });

  test("an unknown language trusts no word, no Goto menu and no popup text", () => {
    const de = { language: "JA" };
    expect(risk({ do: "press", id: "btn[13]" }, MMH1_BASIC, [], de)).toBe("commit");
    expect(risk({ do: "press", id: "btn[26]" }, XD03_ADDR, XD03_MENUS, de)).toBe("commit");
  });

  test("Confirm on a popup that is not a plain message keeps its meaning", () => {
    const ask = lines(
      "TRANSACTION ZT02  PROGRAM ZPROG  SCREEN 200  SYSTEM XYZ (100) host",
      'WINDOW wnd[0]  "Synthetic"',
      'WINDOW wnd[1]  "Confirm Entries"',
      "wnd[1]/usr/txtLINE1  label  The document will be released for payment",
      "wnd[1]/tbar[0]/btn[0]  button  Confirm (Enter)",
    );
    expect(risk({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, ask)).toBe("commit");
    const withField = lines(
      "TRANSACTION ZT02  PROGRAM ZPROG  SCREEN 200  SYSTEM XYZ (100) host",
      'WINDOW wnd[0]  "Synthetic"',
      'WINDOW wnd[1]  "Confirmation"',
      'wnd[1]/usr/txtQTY  field  Yield = "10"  (edit)',
      "wnd[1]/tbar[0]/btn[0]  button  Confirm (Enter)",
    );
    expect(risk({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, withField)).toBe("commit");
  });

  test("'Check in' is a commit, 'Check' alone is not", () => {
    const v = lines("TRANSACTION CV02N  PROGRAM SAPLCV110  SCREEN 101  SYSTEM XYZ (100) host", 'WINDOW wnd[0]  "Change Document"', "wnd[0]/usr/btnCHECKIN  button  Check In", "wnd[0]/usr/btnCHECK  button  Check");
    expect(risk({ do: "press", id: "btnCHECKIN" }, v)).toBe("commit");
    expect(risk({ do: "press", id: "btnCHECK" }, v)).toBe("navigate");
  });
});

describe("a key on a popup is the button it presses (KEY-03)", () => {
  test("Enter on a popup with btn[0] is that button, and its reason names it", () => {
    expect(popupButton(ERROR_POPUP, 0)?.control?.id).toBe("wnd[2]/tbar[0]/btn[0]");
    expect(popupButton(ERROR_POPUP, "Enter")?.control?.id).toBe("wnd[2]/tbar[0]/btn[0]");
    expect(popupButton(WARNING_POPUP, 5)?.control?.id).toBe("wnd[2]/tbar[0]/btn[5]");
    expect(judge({ do: "key", key: 5 }, WARNING_POPUP).reason).toContain('"New entry (F5)"');
  });
  test("Enter on Yes / No is the answer that has the focus", () => {
    expect(popupButton(SAVE_QUESTION, 0, "wnd[1]/usr/btnSPOP-OPTION1")?.control?.id).toBe("wnd[1]/usr/btnSPOP-OPTION1");
    const yes = judge({ do: "key", key: 0 }, SAVE_QUESTION, [], { ...EN, focus: { sid: "wnd[1]/usr/btnSPOP-OPTION1", type: "GuiButton" } });
    expect(yes.risk).toBe("commit");
    expect(yes.reason).toContain('"Yes"');
    const no = judge({ do: "key", key: 0 }, SAVE_QUESTION, [], { ...EN, focus: { sid: "wnd[1]/usr/btnSPOP-OPTION2", type: "GuiButton" } });
    expect(no.risk).toBe("navigate");
    expect(no.reason).toContain('"No"');
  });
  test("without the focus on an answer, Enter would press a default the server cannot tell", () => {
    const hit = popupButton(SAVE_QUESTION, 0);
    expect(hit?.asksDefault).toBe(true);
    expect(hit?.control).toBeUndefined();
    expect(judge({ do: "key", key: 0 }, SAVE_QUESTION).reason).toContain("cannot tell");
    // The reader then refuses and lists the answers; a popup that asks nothing that writes is no commit.
    expect(risk({ do: "key", key: 0 }, LOSS_POPUP)).toBe("navigate");
  });
  test("a key with no button on the main window goes to the screen, not to a popup button", () => {
    expect(popupButton(MM03_INIT, 0)).toBeUndefined();
    expect(popupButton(SAVE_QUESTION, "Tab")).toBeUndefined();
  });
});

describe("closing the logon is its own risk (KEY-02)", () => {
  const off = policyFromEnv({});
  const on = policyFromEnv({ SAP_WRITE: "on" });
  const allowed = policyFromEnv({ SAP_ALLOW_LOGOFF: "on" });
  for (const value of ["/nex", "/nend", "/i", "/i3", "/NEX"])
    test(`okcode ${value} is refused, also with writing on`, () => {
      const action = normalizeAction({ do: "okcode", value });
      const a = judge(action, MM03_INIT);
      expect(a).toMatchObject({ risk: "commit", closes: true });
      for (const p of [off, on]) {
        const v = decide(p, action, a);
        expect(v.run).toBe(false);
        expect("refused" in v && v.refused).toContain("SAP_ALLOW_LOGOFF=on");
      }
      expect(decide(allowed, action, a)).toEqual({ run: true });
    });
  test("System > Log Off, and Yes or Enter on the Log Off popup, close the logon; No does not", () => {
    expect(judge({ do: "select", id: "wnd[0]/mbar/menu[4]/menu[8]" }, MM03_INIT, MM03_MENUS).closes).toBe(true);
    expect(judge({ do: "press", id: "btnSPOP-OPTION1" }, LOGOFF_POPUP).closes).toBe(true);
    expect(judge({ do: "key", key: 0 }, LOGOFF_POPUP).closes).toBe(true);
    expect(judge({ do: "press", id: "btnSPOP-OPTION2" }, LOGOFF_POPUP)).toMatchObject({ risk: "navigate" });
    expect(judge({ do: "key", key: 0 }, LOGOFF_POPUP, [], { ...EN, focus: { sid: "wnd[1]/usr/btnSPOP-OPTION2", type: "GuiButton" } }).risk).toBe("navigate");
  });
  test("SAP_ALLOW_LOGOFF takes on or off", () => {
    expect(off.allowLogoff).toBe(false);
    expect(allowed.allowLogoff).toBe(true);
    expect(() => policyFromEnv({ SAP_ALLOW_LOGOFF: "yes" })).toThrow("SAP_ALLOW_LOGOFF");
  });
});

describe("an action on a control needs its id (P2P-10)", () => {
  for (const verb of ["press", "click", "select", "set", "check", "combo", "f4", "focus", "dblclick", "tree", "grid", "toolbar"])
    test(`${verb} without id is refused`, () => {
      expect(() => normalizeAction({ do: verb })).toThrow(`${verb} needs "id"`);
      expect(() => normalizeAction({ do: verb, id: "  " })).toThrow('needs "id"');
    });
  test("key, okcode and scroll need none", () => {
    expect(normalizeAction({ do: "key", key: 0 }).do).toBe("key");
    expect(normalizeAction({ do: "okcode", value: "/n" }).do).toBe("okcode");
    expect(normalizeAction({ do: "scroll" }).do).toBe("scroll");
  });
});
