import { describe, expect, test } from "bun:test";
import type { DiagElement, DiagScreen, DiagWindow } from "../../src/diag/index.js";
import { assessDiag, cellPoint, resolveTarget } from "../../src/sapgui-diag/index.js";

function el(e: Partial<DiagElement> & { name: string; row: number; col: number }): DiagElement {
  return { kind: "field", text: "", width: 10, input: true, hidden: false, path: [], etype: 130, ...e } as DiagElement;
}

function win(over: Partial<DiagWindow> = {}): DiagWindow {
  return {
    index: 0,
    modal: false,
    title: "Create Sales Order: Initial Screen",
    program: "SAPMV45A",
    dynpro: "0101",
    guiStatus: "A0",
    guiStatusProgram: "SAPMV45B",
    size: { rows: 20, cols: 156 },
    menus: [],
    toolbar: [{ vkey: 8, key: "F8", text: "Create with Reference", tooltip: "", icon: "", enabled: true, fcode: "COPY" }],
    keys: [
      { vkey: 3, key: "F3", text: "Back", tooltip: "", icon: "", enabled: true, fcode: "BACK" },
      { vkey: 11, key: "Ctrl+S", text: "Save", tooltip: "", icon: "", enabled: true, fcode: "SICH" },
    ],
    elements: [
      el({ kind: "label", name: "RV45A-TXT_AUART", text: "Order Type", row: 2, col: 1, input: false, width: 20 }),
      el({ name: "VBAK-AUART", row: 2, col: 22, width: 4 }),
      el({ kind: "button", name: "BT_POAN", text: "Create item", fcode: "POAN", row: 12, col: 4, input: false, width: 3 }),
      el({ kind: "button", name: "BT_SUCH", text: "Search", fcode: "SUCH", row: 12, col: 1, input: false, width: 20 }),
    ],
    tabstrips: [{ name: "TAXI", row: 5, col: 0, width: 150, height: 10, tabs: [{ id: "T\\06", name: "TAB06", text: "Shipping", fcode: "T\\06", active: false, index: 5, row: 5, col: 72 }] }],
    tables: [],
    controls: [],
    containers: [],
    ...over,
  } as DiagWindow;
}

function screen(windows: DiagWindow[]): DiagScreen {
  return { mode: 0, step: 1, session: { system: "ABA", client: "800", user: "U", language: "E" }, windows } as DiagScreen;
}

describe("cellPoint", () => {
  test("matches SAP GUI's grid measured on VA01 (Quartz, 100%)", () => {
    // area at (8,128), 1264 x 571 px, 20 x 156 cells: x = 3 + 8 col, row middle = 27 (row + 1)
    const [x, y] = cellPoint([8, 128, 1264, 571], { rows: 20, cols: 156 }, 2, 22, 4);
    expect(x).toBeGreaterThanOrEqual(8 + 179);
    expect(x).toBeLessThan(8 + 179 + 4 * 8);
    expect(y).toBeGreaterThan(128 + 69);
    expect(y).toBeLessThan(128 + 69 + 24);
  });
});

describe("resolveTarget", () => {
  const s = screen([win()]);
  test("a field by its SAP name, the input one for set", () => {
    const t = resolveTarget(s, { do: "set", id: "VBAK-AUART", value: "OR" });
    expect(t?.kind).toBe("element");
  });
  test("a button or tab by function code", () => {
    expect(resolveTarget(s, { do: "press", id: "{POAN}" })?.what).toBe('button "Create item"');
    expect(resolveTarget(s, { do: "select", id: "{T\\06}" })?.kind).toBe("tab");
  });
  test("a toolbar button by its text", () => {
    expect(resolveTarget(s, { do: "press", id: "Back" })?.kind).toBe("key");
  });
  test("nothing for an unknown id", () => {
    expect(resolveTarget(s, { do: "set", id: "NOPE-NOPE" })).toBeUndefined();
  });
});

describe("assessDiag", () => {
  const s = screen([win()]);
  const risk = (a: Record<string, unknown>) => assessDiag(s, a as never, resolveTarget(s, a as never)).risk;
  test("typing and value help do not write", () => {
    expect(risk({ do: "set", id: "VBAK-AUART", value: "OR" })).toBe("navigate");
    expect(risk({ do: "f4", id: "VBAK-AUART" })).toBe("read");
  });
  test("Save, Create and unknown buttons are writes", () => {
    expect(risk({ do: "key", key: 11 })).toBe("commit");
    expect(risk({ do: "press", id: "{POAN}" })).toBe("commit");
    expect(risk({ do: "key", key: 8 })).toBe("commit"); // F8 is safe, but here it is "Create with Reference"
  });
  test("safe buttons and transactions navigate", () => {
    expect(risk({ do: "press", id: "{SUCH}" })).toBe("navigate");
    expect(risk({ do: "key", key: 3 })).toBe("navigate");
    expect(risk({ do: "okcode", value: "/nVA03" })).toBe("navigate");
    expect(risk({ do: "okcode", value: "/nex" })).toBe("commit");
    expect(risk({ do: "select", id: "{T\\06}" })).toBe("navigate");
  });
  test("a click on something the reader cannot see is a write", () => {
    expect(risk({ do: "click", id: "@30,30" })).toBe("navigate"); // a position: a line or a field
    expect(risk({ do: "click", id: "{NOPE}" })).toBe("commit");
  });
  test("Enter on a popup that asks to save is a write, Cancel is not", () => {
    const pop = win({ index: 1, modal: true, title: "Save Document", keys: [{ vkey: 12, key: "F12", text: "Cancel", tooltip: "", icon: "", enabled: true }], elements: [el({ kind: "button", name: "BUTTON_1", text: "Yes", row: 3, col: 2, input: false })], tabstrips: [] });
    const p = screen([win(), pop]);
    expect(assessDiag(p, { do: "key", key: 0 } as never).risk).toBe("commit");
    expect(assessDiag(p, { do: "key", key: 12 } as never).risk).toBe("navigate");
  });
});
