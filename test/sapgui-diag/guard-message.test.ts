/**
 * The Enter key of a message popup (an error, warning or information shown in a popup: message lines, no
 * input, no button in its body) only acknowledges the message, also when SAP GUI labels it "Confirm": the
 * rule of the scripting and Web GUI surfaces (sapgui/assess.ts isMessagePopup). Seen live in MI24 with
 * SAP_WRITE=off (2026-11-25): the "Error" popup "Which items are to be printed?" offered only "Confirm",
 * the guard refused it as a write, and the run could not go on. Anything else on such a popup, and any
 * popup that asks or takes input, is judged as before.
 */
import { describe, expect, test } from "bun:test";
import type { Action } from "../../src/core/types.js";
import type { DiagElement, DiagScreen, DiagWindow } from "../../src/diag/index.js";
import { assessDiag, resolveTarget } from "../../src/sapgui-diag/index.js";

function el(e: Partial<DiagElement> & { name: string; row: number; col: number }): DiagElement {
  return { kind: "field", text: "", width: 10, input: false, hidden: false, path: [], etype: 130, ...e } as DiagElement;
}

function win(over: Partial<DiagWindow>): DiagWindow {
  return {
    index: 0,
    modal: false,
    title: "Physical Inventory List",
    program: "RM07IDIFH",
    dynpro: "1000",
    guiStatus: "",
    guiStatusProgram: "",
    size: { rows: 20, cols: 156 },
    menus: [],
    toolbar: [],
    keys: [{ vkey: 11, key: "Ctrl+S", text: "Save", tooltip: "", icon: "", enabled: true }],
    elements: [],
    tabstrips: [],
    tables: [],
    controls: [],
    containers: [],
    ...over,
  } as DiagWindow;
}

const messagePopup = (title: string, text: string, extra: DiagElement[] = []): DiagWindow =>
  win({
    index: 1,
    modal: true,
    title,
    program: "SAPMSDYP",
    dynpro: "0010",
    toolbar: [
      { vkey: 0, key: "Enter", text: "Confirm", tooltip: "", icon: "", enabled: true },
      { vkey: 1, key: "F1", text: "Help", tooltip: "", icon: "", enabled: true },
    ],
    keys: [{ vkey: 12, key: "F12", text: "Cancel", tooltip: "", icon: "", enabled: true }],
    elements: [el({ name: "IK1", text: "@1B\\QError message@", row: 0, col: 0, width: 4 }), el({ name: "MESSTXT1", text, row: 0, col: 5, width: 50 }), ...extra],
  });

const screen = (popup: DiagWindow): DiagScreen => ({ mode: 0, step: 1, session: { system: "ABA", client: "800", user: "U", language: "E" }, windows: [win({}), popup] }) as DiagScreen;
const risk = (s: DiagScreen, a: Action) => assessDiag(s, a, resolveTarget(s, a)).risk;

describe("the Enter key of a message popup", () => {
  test("acknowledges an error, also when labelled Confirm", () => {
    const s = screen(messagePopup("Error", "Which items are to be printed?"));
    expect(risk(s, { do: "key", key: 0 })).toBe("navigate");
    expect(assessDiag(s, { do: "key", key: 0 }).reason).toContain("acknowledges the message");
    expect(risk(s, { do: "press", id: "Confirm" })).toBe("navigate");
    expect(risk(s, { do: "okcode", value: "" })).toBe("navigate");
  });
  test("Save on it stays a write", () => {
    const s = screen(messagePopup("Error", "Which items are to be printed?"));
    expect(risk(s, { do: "key", key: 11 })).toBe("commit");
  });
  test("a message that names a write is not acknowledged blindly", () => {
    expect(risk(screen(messagePopup("Information", "Do you want to post the document?")), { do: "key", key: 0 })).toBe("commit");
    expect(risk(screen(messagePopup("Save document", "Continue?")), { do: "key", key: 0 })).toBe("commit");
  });
  test("a popup with input or a button in its body is a dialog, not a message", () => {
    const withField = messagePopup("Error", "Which items are to be printed?", [el({ name: "ZFIELD", input: true, row: 1, col: 5 })]);
    expect(risk(screen(withField), { do: "key", key: 0 })).toBe("commit");
    const withButton = messagePopup("Error", "Which items are to be printed?", [el({ kind: "button", name: "B1", text: "Print", fcode: "PRNT", input: true, row: 2, col: 5 })]);
    expect(risk(screen(withButton), { do: "key", key: 0 })).toBe("commit");
    const withBox = messagePopup("Error", "Which items are to be printed?", [el({ kind: "checkbox", name: "C1", text: "All", input: true, row: 2, col: 5 })]);
    expect(risk(screen(withBox), { do: "key", key: 0 })).toBe("commit");
  });
  test("the main window's Confirm is judged as before", () => {
    const s = { mode: 0, step: 1, session: { system: "ABA", client: "800", user: "U", language: "E" }, windows: [win({ toolbar: [{ vkey: 0, key: "Enter", text: "Confirm", tooltip: "", icon: "", enabled: true }], elements: [el({ name: "MESSTXT1", text: "x", row: 0, col: 0 })] })] } as DiagScreen;
    expect(risk(s, { do: "key", key: 0 })).toBe("commit");
  });
});
