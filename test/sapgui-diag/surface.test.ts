import { describe, expect, test } from "bun:test";
import type { DiagElement, DiagScreen, DiagWindow } from "../../src/diag/index.js";
import { assessDiag, cellPoint, findTarget, greyedRefusal, noTargetText, resolveTarget, typedMisses, withTyped } from "../../src/sapgui-diag/index.js";
import { diagView } from "../../src/diag/index.js";

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
    toolbar: [{ vkey: 8, key: "F8", text: "Create with Reference", tooltip: "", icon: "", enabled: true }],
    keys: [
      { vkey: 3, key: "F3", text: "Back", tooltip: "", icon: "", enabled: true },
      { vkey: 11, key: "Ctrl+S", text: "Save", tooltip: "", icon: "", enabled: true },
    ],
    elements: [
      el({ kind: "label", name: "RV45A-TXT_AUART", text: "Order Type", row: 2, col: 1, input: false, width: 20 }),
      el({ name: "VBAK-AUART", row: 2, col: 22, width: 4 }),
      el({ kind: "button", name: "BT_POAN", text: "Create item", fcode: "POAN", row: 12, col: 4, width: 3 }),
      el({ kind: "button", name: "BT_SUCH", text: "Search", fcode: "SUCH", row: 12, col: 1, width: 20 }),
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

/** A screen with a table control, a field and its label, a field twice, and greyed-out things. */
function richWin(): DiagWindow {
  const w = win();
  w.toolbar.push({ vkey: 17, key: "Shift+F5", text: "Assign", tooltip: "Assign users", icon: "", enabled: false });
  w.elements.push(
    el({ kind: "label", name: "VBAK-VBELN", text: "Order", row: 3, col: 1, input: false, width: 10 }),
    el({ name: "VBAK-VBELN", text: "4711", row: 3, col: 22, input: false }),
    el({ name: "VBKD-BSTKD", text: "", row: 4, col: 22 }),
    el({ name: "VBKD-BSTKD", text: "", row: 6, col: 22 }),
    el({ kind: "button", name: "BT_POLO", text: "Delete item", fcode: "POLO", row: 12, col: 7, input: false, width: 3 }),
    el({ kind: "checkbox", name: "RV45A-FLAG", text: "Complete", row: 8, col: 1, input: false, checked: true, width: 10 }),
  );
  const cells = (a: string, b: string) => [
    { column: 0, text: a, kind: "field", input: false, hidden: false },
    { column: 1, text: b, kind: "field", input: true, hidden: false },
  ];
  w.tables.push({
    name: "TC_ITEMS",
    program: "SAPMV45A",
    title: "",
    row: 14,
    col: 0,
    width: 80,
    height: 4,
    columns: [
      { index: 0, position: 0, name: "VBAP-POSNR", title: "Item", width: 6, col: 1, visible: true },
      { index: 1, position: 1, name: "RV45A-MABNR", title: "Material", width: 18, col: 8, visible: true },
    ],
    rows: [
      { index: 0, row: 15, empty: false, cells: cells("10", "M-01") },
      { index: 1, row: 16, empty: false, cells: cells("20", "M-02") },
      { index: 2, row: 17, empty: true, cells: cells("", "") },
    ],
    path: [],
  } as never);
  w.controls.push({ id: 9, kind: "tree", type: "SAP.TableTreeControl.1", container: "NAV", area: { row: 2, col: 100, width: 40, height: 10 }, tree: { headers: [], nodes: [{ key: "N1", parent: "", depth: 0, text: "Locked", items: {}, folder: false, expanded: false, hidden: false, disabled: true }] } });
  return w;
}

describe("ids written nearly right resolve by the shared rule (core/ids.ts)", () => {
  const s = screen([richWin()]);
  const what = (a: Record<string, unknown>) => resolveTarget(s, a as never)?.what;
  test("another case, for names and function codes", () => {
    expect(what({ do: "set", id: "vbak-auart", value: "OR" })).toBe("field VBAK-AUART");
    expect(what({ do: "press", id: "{poan}" })).toBe('button "Create item"');
  });
  test("a scripting id or handle names the field", () => {
    expect(what({ do: "set", id: "wnd[0]/usr/ctxtVBAK-AUART", value: "OR" })).toBe("field VBAK-AUART");
    expect(what({ do: "set", id: "ctxtVBAK-AUART", value: "OR" })).toBe("field VBAK-AUART");
  });
  test("a table cell by field name and row, whatever the column", () => {
    expect(what({ do: "set", id: "RV45A-MABNR[1]", value: "X" })).toBe("RV45A-MABNR in row 1");
    expect(what({ do: "set", id: "RV45A-MABNR[3,1]", value: "X" })).toBe("RV45A-MABNR in row 1");
    expect(what({ do: "set", id: "ctxtrv45a-mabnr[0,1]", value: "X" })).toBe("RV45A-MABNR in row 1");
  });
  test("a table's own name with [col,row]: the cell at that column and row", () => {
    expect(what({ do: "set", id: "TC_ITEMS[1,0]", value: "X" })).toBe("RV45A-MABNR in row 0");
    expect(what({ do: "click", id: "tc_items[0,1]" })).toBe("VBAP-POSNR in row 1");
  });
  test("NAME[0] on a field that is not in a table: the field", () => {
    expect(what({ do: "set", id: "VBAK-AUART[0]", value: "OR" })).toBe("field VBAK-AUART");
    expect(resolveTarget(s, { do: "set", id: "VBAK-AUART[1]", value: "OR" } as never)).toBeUndefined();
  });
  test("the field a label is named after is meant", () => {
    expect(what({ do: "click", id: "VBAK-VBELN" })).toBe("field VBAK-VBELN");
  });
  test("a name two fields share is refused with both places; @row,col names one", () => {
    expect(findTarget(s, { do: "set", id: "VBKD-BSTKD", value: "1" } as never)).toEqual({ several: ["@4,22 (field VBKD-BSTKD)", "@6,22 (field VBKD-BSTKD)"] });
    expect(() => resolveTarget(s, { do: "set", id: "VBKD-BSTKD", value: "1" } as never)).toThrow('"VBKD-BSTKD" names 2 elements on this screen: @4,22 (field VBKD-BSTKD), @6,22 (field VBKD-BSTKD). Use one of these ids (@row,col).');
    const t = resolveTarget(s, { do: "set", id: "@6,25", value: "1" } as never);
    expect(t?.kind === "element" && t.element.row).toBe(6);
  });
  test("a near miss that means several things is not guessed", () => {
    expect(resolveTarget(s, { do: "set", id: "vbkd-bstkd", value: "1" } as never)).toBeUndefined();
  });
  test("an id that means nothing is refused with the closest ids of the screen", () => {
    expect(resolveTarget(s, { do: "set", id: "VBAK-AURT", value: "OR" } as never)).toBeUndefined();
    expect(noTargetText(s, "VBAK-AURT")).toStartWith('No control "VBAK-AURT" on this screen (closest: VBAK-AUART, ');
  });
});

describe("what SAP greys out is refused at once", () => {
  const s = screen([richWin()]);
  const refusal = (a: Record<string, unknown>) => greyedRefusal(s, a as never, resolveTarget(s, a as never));
  test("a greyed-out push button, toolbar button, key and tree node", () => {
    expect(refusal({ do: "press", id: "{POLO}" })).toStartWith('button "Delete item" is greyed out: SAP does not offer it on this screen now');
    expect(refusal({ do: "press", id: "Assign" })).toStartWith('button "Assign" is greyed out');
    expect(refusal({ do: "key", key: "Shift+F5" })).toStartWith('key Shift+F5 "Assign" is greyed out');
    // Toolbar buttons carry no function code in the traffic: an okcode cannot be matched to one.
    expect(refusal({ do: "okcode", value: "assg" })).toBeUndefined();
    expect(refusal({ do: "dblclick", id: "{N1}" })).toStartWith('tree node "Locked" is greyed out');
  });
  test("a read-only checkbox stays as it is", () => {
    expect(refusal({ do: "check", id: "RV45A-FLAG" })).toBe("checkbox RV45A-FLAG cannot be changed here: it is greyed out (read-only). It stays checked.");
  });
  test("what is offered goes through", () => {
    expect(refusal({ do: "press", id: "{POAN}" })).toBeUndefined();
    expect(refusal({ do: "key", key: 3 })).toBeUndefined();
    expect(refusal({ do: "okcode", value: "/nVA03" })).toBeUndefined();
    expect(refusal({ do: "set", id: "VBAK-AUART", value: "OR" })).toBeUndefined();
  });
  test("the view marks them", () => {
    const v = diagView(s);
    expect(v).toContain("<Delete item>{POLO}@7 (greyed out)");
    expect(v).toContain("greyed out (SAP does not offer it on this screen): Assign: Assign users (Shift+F5)");
    expect(v).toContain("Locked (greyed out)  {N1}");
  });
});

describe("typed values in the view and after the step", () => {
  const s = screen([richWin()]);
  const typed = [
    { step: 1, window: 0, program: "SAPMV45A", dynpro: "0101", name: "VBAK-AUART", row: 2, col: 22, value: "or" },
    { step: 1, window: 0, program: "SAPMV45A", dynpro: "0101", name: "RV45A-MABNR", row: 17, col: 8, table: { name: "TC_ITEMS", index: 2, column: 1 }, value: "M-03" },
  ];
  test("a field and a table cell show the typed value, marked; the screen itself is not changed", () => {
    const v = diagView(withTyped(s, typed));
    expect(v).toContain("VBAK-AUART@22=[or] (typed, sent with the next Enter)");
    expect(v).toContain("  row 2 r17: Material=[M-03] (typed, sent with the next Enter)");
    expect(diagView(s)).not.toContain("typed");
  });
  test("after the step: a value SAP shows otherwise is reported, case and leading zeros aside", () => {
    const after = screen([richWin()]);
    const w = after.windows[0] as DiagWindow;
    (w.elements.find((e) => e.name === "VBAK-AUART") as DiagElement).text = "OR";
    (w.tables[0]?.rows[2]?.cells[1] as { text: string }).text = "M-03";
    expect(typedMisses(typed, after)).toEqual([]);
    (w.elements.find((e) => e.name === "VBAK-AUART") as DiagElement).text = "TA";
    expect(typedMisses(typed.slice(0, 1), after)).toEqual(['VBAK-AUART shows "TA" after this step, not the typed "or": SAP changed it or did not take it.']);
    // Another screen: nothing to compare.
    w.dynpro = "4001";
    expect(typedMisses(typed, after)).toEqual([]);
  });
});
