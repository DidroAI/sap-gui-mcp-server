import { describe, expect, test } from "bun:test";
import type { Action, Risk } from "../../src/core/types.js";
import { assess, commitCode, commitWord } from "../../src/sapgui/assess.js";
import { isLogonScreen } from "../../src/core/words.js";
import type { Control, Screen } from "../../src/sapgui/facts.js";
import { vkeyNumber } from "../../src/sapgui/keys.js";
import { resolve } from "../../src/sapgui/resolve.js";
import { type Name, screen } from "./fixtures.js";

const TEXTS = "wnd[0]/usr/tabsTAXI_TABSTRIP_HEAD/tabpT\\08/cntlSPLITTER_CONTAINER/shellcont/shell";
const MENU_SAVE: Control = { id: "wnd[0]/mbar/menu[0]/menu[1]", type: "GuiMenu", name: "menu[1]", text: "Save", tip: "" };
const MENU_EXIT: Control = { id: "wnd[0]/mbar/menu[0]/menu[2]", type: "GuiMenu", name: "menu[2]", text: "Exit", tip: "" };

function risk(name: Name, action: Action, target?: Control): Risk {
  const s = screen(name);
  return assess(s, action, target ?? (action.id ? resolve(s, action.id) : undefined)).risk;
}

// One row per case: screen, action, expected risk.
const CASES: [string, Name, Action, Risk][] = [
  // Save, however it is asked for.
  ["key 11", "va01", { do: "key", key: 11 }, "commit"],
  ["okcode /11", "va01", { do: "okcode", value: "/11" }, "commit"],
  ["okcode SAVE", "va03", { do: "okcode", value: "SAVE" }, "commit"],
  ["okcode =SICH", "va03", { do: "okcode", value: "=SICH" }, "commit"],
  ["the Save button, full id", "va01", { do: "press", id: "wnd[0]/tbar[0]/btn[11]" }, "commit"],
  ["the Save button, short id", "va01", { do: "press", id: "tbar[0]/btn[11]" }, "commit"],
  // Buttons by what they say.
  ["button with a delete tooltip", "ask", { do: "press", id: "wnd[0]/tbar[1]/btn[14]" }, "commit"],
  ["its function key", "ask", { do: "okcode", value: "/14" }, "commit"],
  ["button 'Reject document'", "ask", { do: "press", id: "wnd[0]/tbar[1]/btn[20]" }, "commit"],
  ["button 'Activate'", "se80", { do: "press", id: "wnd[0]/tbar[1]/btn[27]" }, "commit"],
  ["key of 'Activate'", "se80", { do: "key", key: 27 }, "commit"],
  ["button 'Create with Reference'", "va01", { do: "press", id: "wnd[0]/tbar[1]/btn[8]" }, "commit"],
  ["its function key F8", "va01", { do: "key", key: 8 }, "commit"],
  ["a button nobody knows ('Sales')", "va01", { do: "press", id: "wnd[0]/tbar[1]/btn[5]" }, "commit"],
  ["a function key with no button", "va01", { do: "key", key: 9 }, "commit"],
  ["okcode of a function key with no button", "va01", { do: "okcode", value: "/9" }, "commit"],
  ["an action nobody knows", "va01", { do: "fly", id: "ctxtVBAK-AUART" }, "commit"],
  ["Back", "va01", { do: "press", id: "wnd[0]/tbar[0]/btn[3]" }, "navigate"],
  ["Back by its key", "va01", { do: "key", key: 3 }, "navigate"],
  ["Back by its key's name", "va01", { do: "key", key: "F3" }, "navigate"],
  ["Exit by its key's name", "va01", { do: "key", key: "Shift+F3" }, "navigate"],
  ["Save by its key's name", "va01", { do: "key", key: "Control+s" }, "commit"],
  ["a key SAP GUI does not have", "va01", { do: "key", key: "Space" }, "commit"],
  ["Enter button", "va01", { do: "press", id: "wnd[0]/tbar[0]/btn[0]" }, "navigate"],
  ["click is press", "va01", { do: "click", id: "wnd[0]/tbar[0]/btn[11]" }, "commit"],
  ["Cancel (F12) leaves, it does not cancel a document", "va01", { do: "press", id: "wnd[0]/tbar[0]/btn[12]" }, "navigate"],
  ["a button that opens details", "va03", { do: "press", id: "btnBT_HEAD" }, "navigate"],
  // The popup that asks whether to save.
  ["Yes on 'Do you want to save'", "ask", { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }, "commit"],
  ["Enter on it", "ask", { do: "key", key: 0 }, "commit"],
  ["No on it", "ask", { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION2" }, "navigate"],
  ["Cancel on it", "ask", { do: "press", id: "btnSPOP-OPTION_CAN" }, "navigate"],
  ["F12 on it", "ask", { do: "key", key: 12 }, "navigate"],
  // A value-help popup is not a question.
  ["Copy in the value help", "f4", { do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, "navigate"],
  ["Enter in the value help", "f4", { do: "key", key: 0 }, "navigate"],
  ["pick an entry", "f4", { do: "dblclick", id: "wnd[1]/usr/lbl[1,3]" }, "navigate"],
  // Menu entries are read from SAP GUI when asked.
  ["menu entry Save", "va01", { do: "select", id: MENU_SAVE.id }, "commit"],
  ["menu entry Exit", "va01", { do: "select", id: MENU_EXIT.id }, "navigate"],
  // Toolbars inside containers: the button id is the function code.
  ["toolbar button 'Delete text'", "va03-texts", { do: "toolbar", id: `${TEXTS}/shellcont[1]/shell`, button: "TB_DELETE" }, "commit"],
  ["toolbar button 'Detail'", "va03-texts", { do: "toolbar", id: `${TEXTS}/shellcont[1]/shell`, button: "TB_DETAIL" }, "navigate"],
  ["toolbar button by code only", "va05", { do: "toolbar", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", button: "&DATA_SAVE" }, "commit"],
  // Moving around and typing.
  ["set a field", "va01", { do: "set", id: "ctxtVBAK-AUART", value: "RE" }, "navigate"],
  ["Enter", "va01", { do: "key", key: 0 }, "navigate"],
  ["start a transaction", "va03", { do: "okcode", value: "/nVA05" }, "navigate"],
  ["a transaction code on SAP Easy Access", "easy", { do: "okcode", value: "va03" }, "navigate"],
  ["a harmless function code", "va03", { do: "okcode", value: "BACK" }, "navigate"],
  ["a function code nobody knows", "va03", { do: "okcode", value: "ZZDO" }, "commit"],
  ["a function code with & nobody knows", "va03", { do: "okcode", value: "&XYZ" }, "commit"],
  ["a known ALV function code", "va05", { do: "okcode", value: "&ETA" }, "navigate"],
  ["a plain word outside the menu", "va03", { do: "okcode", value: "VA05" }, "commit"],
  ["/h", "va03", { do: "okcode", value: "/h" }, "commit"],
  ["/nex", "va03", { do: "okcode", value: "/nex" }, "commit"],
  ["/nend", "easy", { do: "okcode", value: "/nend" }, "commit"],
  ["/i", "va03", { do: "okcode", value: "/i" }, "commit"],
  ["/n", "va03", { do: "okcode", value: "/n" }, "navigate"],
  ["a standard ALV toolbar function by code", "va05", { do: "toolbar", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", button: "&MB_FILTER" }, "navigate"],
  ["a toolbar function nobody knows", "va05", { do: "toolbar", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", button: "ZDO" }, "commit"],
  ["select a grid row", "va05", { do: "grid", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", row: 1, col: "VBELN", how: "select" }, "navigate"],
  ["double-click a grid row by dblclick", "va05", { do: "dblclick", id: "shell", row: 1, col: "VBELN" }, "navigate"],
  ["Cancel in the value help", "f4", { do: "press", id: "wnd[1]/tbar[0]/btn[12]" }, "navigate"],
  ["a tab", "va03", { do: "select", id: "tabpT\\02" }, "navigate"],
  ["a checkbox", "va03", { do: "check", id: "chkVBAK-AUTLF", value: false }, "navigate"],
  ["a dropdown", "va03", { do: "combo", id: "cmbVBAK-LIFSK", key: "01" }, "navigate"],
  ["open a tree node", "va03-texts", { do: "tree", id: `${TEXTS}/shellcont[0]/shell`, node: "3", how: "double" }, "navigate"],
  ["open a grid row", "va05", { do: "grid", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", row: 0, col: "VBELN" }, "navigate"],
  // Reading.
  ["value help", "va01", { do: "f4", id: "ctxtVBAK-AUART" }, "read"],
  ["F4", "va01", { do: "key", key: 4 }, "read"],
  ["focus", "va01", { do: "focus", id: "ctxtVBAK-AUART" }, "read"],
  ["expand a tree node", "va03-texts", { do: "tree", id: `${TEXTS}/shellcont[0]/shell`, node: "4", how: "expand" }, "read"],
];

describe("sapgui assess", () => {
  for (const [what, name, action, want] of CASES)
    test(`${what} is ${want}`, () => {
      const target = action.id === MENU_SAVE.id ? MENU_SAVE : action.id === MENU_EXIT.id ? MENU_EXIT : undefined;
      expect(risk(name, action, target)).toBe(want);
    });

  test("a menu entry that could not be read is a commit", () => {
    expect(assess(screen("va01"), { do: "select", id: "wnd[0]/mbar/menu[1]/menu[7]" }).risk).toBe("commit");
  });

  test("the reason names what the user would confirm", () => {
    const s = screen("ask");
    expect(assess(s, { do: "press", id: "btnSPOP-OPTION1" }, resolve(s, "btnSPOP-OPTION1")).reason).toBe(
      '"Yes" on the popup "Exit Document Data will be lost. Do you want to save the document?"',
    );
    expect(assess(screen("va01"), { do: "key", key: 11 }).reason).toBe("key 11: Save (Ctrl+S)");
  });
  test("a control that is not on the screen is named as missing, not as a write", () => {
    expect(() => assess(screen("va01"), { do: "press", id: "wnd[0]/usr/btnNOPE" })).toThrow('No control "wnd[0]/usr/btnNOPE"');
    expect(assess(screen("va01"), { do: "okcode", value: "/11" }).reason).toBe("okcode /11: Save (Ctrl+S)");
    const s1 = screen("va01");
    expect(assess(s1, { do: "press", id: "wnd[0]/tbar[1]/btn[5]" }, resolve(s1, "wnd[0]/tbar[1]/btn[5]")).reason).toBe('button "Sales" is not known to be safe, so it is treated as a write');
    expect(assess(screen("va03"), { do: "okcode", value: "/nex" }).reason).toBe("okcode /nex closes SAP sessions; unsaved data is lost");
  });

  test("in a logon language the word table does not cover, a text proves nothing", () => {
    const menu = (text: string): Control => ({ id: "wnd[0]/mbar/menu[0]/menu[2]", type: "GuiMenu", name: "menu[2]", text, tip: "" });
    for (const language of ["JA", "PT", "", undefined]) {
      const s = { ...screen("va03"), language } as Screen;
      // "Display document header details" is safe by its text only.
      expect(assess(s, { do: "press", id: "btnBT_HEAD" }, resolve(s, "btnBT_HEAD")).risk).toBe("commit");
      expect(assess(s, { do: "select", id: "x" }, menu("Exit")).risk).toBe("commit");
      // Back, Enter, tabs, typing, value help: by id, key and type.
      expect(assess(s, { do: "press", id: "wnd[0]/tbar[0]/btn[3]" }, resolve(s, "wnd[0]/tbar[0]/btn[3]")).risk).toBe("navigate");
      expect(assess(s, { do: "key", key: 0 }).risk).toBe("navigate");
      expect(assess(s, { do: "select", id: "tabpT\\02" }, resolve(s, "tabpT\\02")).risk).toBe("navigate");
      expect(assess(s, { do: "okcode", value: "BACK" }).risk).toBe("navigate");
      // A commit word is read in every language.
      expect(assess(s, { do: "select", id: "x" }, menu("Gravar")).risk).toBe("commit");
    }
    const en = screen("va03");
    expect(assess(en, { do: "press", id: "btnBT_HEAD" }, resolve(en, "btnBT_HEAD")).risk).toBe("navigate");
    expect(assess(en, { do: "select", id: "x" }, menu("Incompletion log")).risk).toBe("commit");
    expect(assess(en, { do: "select", id: "x" }, menu("Status")).risk).toBe("navigate"); // System > Status only shows
    expect(assess(en, { do: "select", id: "x" }, menu("Change Status")).risk).toBe("commit");
  });

  test("the popup that asks whether to save: only No and Cancel decline, and only where the words can be read", () => {
    const ja = { ...screen("ask"), language: "JA" } as Screen;
    expect(assess(ja, { do: "press", id: "btnSPOP-OPTION2" }, resolve(ja, "btnSPOP-OPTION2")).risk).toBe("commit"); // "No", unreadable
    expect(assess(ja, { do: "press", id: "btnSPOP-OPTION_CAN" }, resolve(ja, "btnSPOP-OPTION_CAN")).risk).toBe("navigate"); // tooltip "(F12)"
    expect(assess(ja, { do: "key", key: 12 }).risk).toBe("navigate");
  });

  test("Enter with the focus on a button is assessed as pressing that button", () => {
    const on = (name: Name, focus: string): Screen => ({ ...screen(name), focus });
    const reject = assess(on("ask", "wnd[0]/tbar[1]/btn[20]"), { do: "key", key: 0 });
    expect(reject.risk).toBe("commit");
    const main = { ...on("ask", "wnd[0]/tbar[1]/btn[20]"), activeWindow: "wnd[0]", windows: screen("ask").windows.slice(0, 1) };
    expect(assess(main, { do: "key", key: 0 }).reason).toBe('key 0 with the focus on the button "Reject document"');
    expect(assess(main, { do: "okcode", value: "/0" }).risk).toBe("commit");
    expect(assess(on("va01", "wnd[0]/tbar[1]/btn[5]"), { do: "key", key: 0 }).risk).toBe("commit"); // "Sales": not known to be safe
    expect(assess(on("va01", "wnd[0]/tbar[1]/btn[5]"), { do: "key", key: "Enter" }).risk).toBe("commit");
    expect(assess(on("va01", "wnd[0]/tbar[0]/btn[3]"), { do: "key", key: 0 }).risk).toBe("navigate"); // Back
    expect(assess(on("va01", "wnd[0]/usr/ctxtVBAK-AUART"), { do: "key", key: 0 }).risk).toBe("navigate"); // a field
    expect(assess(on("va01", "wnd[0]/mbar/menu[0]/menu[1]"), { do: "key", key: 0 }).risk).toBe("commit"); // a menu entry that is not read
    // Other keys do not press the focused control.
    expect(assess(on("va01", "wnd[0]/tbar[1]/btn[5]"), { do: "key", key: 3 }).risk).toBe("navigate");
  });

  test("the logon screen is told from the start menu of the same program", () => {
    expect(isLogonScreen("SAPMSYST", "0020")).toBe(true);
    expect(isLogonScreen("SAPMSYST", "0040")).toBe(false);
  });

  test("words: what a label means", () => {
    expect(commitWord("Save   (Ctrl+S)")).toBe("save");
    expect(commitWord("Sichern")).toBe("save");
    expect(commitWord("Post")).toBe("post");
    expect(commitWord("Buchen")).toBe("post");
    expect(commitWord("", "Delete   (Shift+F2)")).toBe("delete");
    expect(commitWord("Löschen")).toBe("delete");
    expect(commitWord("Release")).toBe("release");
    expect(commitWord("Approve")).toBe("approve or reject");
    expect(commitWord("Reverse")).toBe("reverse");
    expect(commitWord("Cancel document")).toBe("cancel a document");
    expect(commitWord("Cancel")).toBeUndefined();
    expect(commitWord("Cancel   (F12)")).toBeUndefined();
    expect(commitWord("Do not save")).toBeUndefined();
    expect(commitWord("Nicht sichern")).toBeUndefined();
    expect(commitWord("Post without reference")).toBe("post");
    expect(commitWord("Postal code")).toBeUndefined();
    expect(commitWord("Posting date")).toBeUndefined();
    expect(commitWord("Display <-> Change")).toBeUndefined();
    expect(commitWord("Execute   (F8)")).toBeUndefined();
  });

  test("function codes", () => {
    for (const code of ["SAVE", "=SICH", "BU", "&DATA_SAVE", "TB_DELETE", "%_GC_DELE", "FREI"]) expect(commitCode(code)).toBe(true);
    for (const code of ["BACK", "ENTR", "&ETA", "VA03", "TB_DETAIL", ""]) expect(commitCode(code)).toBe(false);
  });

  test("key names give SAP's virtual key numbers", () => {
    const cases: [unknown, number | undefined][] = [[0, 0], ["Enter", 0], ["F8", 8], ["Shift+F3", 15], ["Control+F3", 27], ["Control+Shift+F9", 45], ["Control+s", 11], ["Escape", 12], ["Back", 3], ["PageDown", 82], ["Space", undefined], ["Tab", undefined], [100, undefined], [1.5, undefined]];
    for (const [key, n] of cases) expect([key, vkeyNumber(key)]).toEqual([key, n]);
  });
});

describe("SAP GUI: the popup rules match Web GUI's", () => {
  const ctl = (id: string, type: string, text = "", extra: Partial<Control> = {}): Control => ({ id, type, name: id.slice(id.lastIndexOf("/") + 1), text, tip: "", ...extra });
  const on = (popup: { title: string; controls: Control[] }): Screen => ({
    transaction: "XD02",
    program: "SAPMF02D",
    screen: "7000",
    language: "EN",
    activeWindow: "wnd[1]",
    windows: [
      { id: "wnd[0]", title: "Change Customer", controls: [ctl("wnd[0]", "GuiMainWindow")] },
      { id: "wnd[1]", title: popup.title, controls: [ctl("wnd[1]", "GuiModalWindow", popup.title), ...popup.controls] },
    ],
  });
  const ERROR = on({
    title: "Error",
    controls: [ctl("wnd[1]/usr/txtMESSTXT1", "GuiTextField", "Specify an account number", { changeable: false }), ctl("wnd[1]/tbar[0]/btn[0]", "GuiButton", "", { tip: "Confirm   (Enter)" })],
  });
  const LOSS = on({
    title: "Cancel Customer",
    controls: [
      ctl("wnd[1]/usr/txtSPOP-DIAGNOSE", "GuiTextField", "Data will be lost.", { changeable: false }),
      ctl("wnd[1]/usr/txtSPOP-TEXTLINE1", "GuiTextField", "Do you want to cancel processing?", { changeable: false }),
      ctl("wnd[1]/usr/btnSPOP-OPTION1", "GuiButton", "Yes"),
      ctl("wnd[1]/usr/btnSPOP-OPTION2", "GuiButton", "No"),
    ],
  });
  const LOGOFF = on({
    title: "Log Off",
    controls: [ctl("wnd[1]/usr/txtSPOP-TEXTLINE1", "GuiTextField", "Unsaved data will be lost.", { changeable: false }), ctl("wnd[1]/usr/btnSPOP-OPTION1", "GuiButton", "Yes"), ctl("wnd[1]/usr/btnSPOP-OPTION2", "GuiButton", "No")],
  });
  const target = (s: Screen, id: string) => s.windows.flatMap((w) => w.controls).find((c) => c.id === id);
  test("Confirm (Enter) on an error message acknowledges it", () => {
    expect(assess(ERROR, { do: "press", id: "wnd[1]/tbar[0]/btn[0]" }, target(ERROR, "wnd[1]/tbar[0]/btn[0]")).risk).toBe("navigate");
    expect(assess(ERROR, { do: "key", key: 0 }).risk).toBe("navigate");
  });
  test("Yes on 'Data will be lost' discards input", () => {
    expect(assess(LOSS, { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }, target(LOSS, "wnd[1]/usr/btnSPOP-OPTION1")).risk).toBe("navigate");
  });
  test("logging off is flagged for the guard", () => {
    expect(assess(LOSS, { do: "okcode", value: "/nex" })).toMatchObject({ risk: "commit", closes: true });
    expect(assess(LOGOFF, { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }, target(LOGOFF, "wnd[1]/usr/btnSPOP-OPTION1"))).toMatchObject({ risk: "commit", closes: true });
    expect(assess(LOGOFF, { do: "press", id: "wnd[1]/usr/btnSPOP-OPTION2" }, target(LOGOFF, "wnd[1]/usr/btnSPOP-OPTION2")).risk).toBe("navigate");
  });
});
