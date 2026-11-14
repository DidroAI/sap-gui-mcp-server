import { describe, expect, test } from "bun:test";
import type { Action, Risk } from "../../src/core/types.js";
import { assess, commitCode, commitWord } from "../../src/sapgui/assess.js";
import type { Control } from "../../src/sapgui/facts.js";
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
  ["button 'Create with Reference'", "va01", { do: "press", id: "wnd[0]/tbar[1]/btn[8]" }, "navigate"],
  ["Back", "va01", { do: "press", id: "wnd[0]/tbar[0]/btn[3]" }, "navigate"],
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
    expect(assess(screen("va01"), { do: "okcode", value: "/11" }).reason).toBe("okcode /11: Save (Ctrl+S)");
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
});
