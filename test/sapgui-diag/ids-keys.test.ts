/**
 * Ids the other surfaces take and the tool's description gives, which the DIAG method refused (Haiku runs,
 * 2026-11-25, about 20 wasted steps in 6 runs): "btn[N]" is function key N ("press id ... btn[N] is
 * function key N"), also as a scripting path (wnd[0]/tbar[1]/btn[5]); a toolbar button by its text with
 * the key the view prints after it ("Display Document (F2)"); a tab by its text ("Administration").
 */
import { describe, expect, test } from "bun:test";
import type { DiagScreen, DiagWindow } from "../../src/diag/index.js";
import { assessDiag, resolveTarget } from "../../src/sapgui-diag/index.js";

const w = {
  index: 0,
  modal: false,
  title: "Display Outbound Delivery 80015432: Overview",
  program: "SAPMV50A",
  dynpro: "1000",
  guiStatus: "",
  guiStatusProgram: "",
  size: { rows: 20, cols: 156 },
  menus: [],
  toolbar: [
    { vkey: 2, key: "F2", text: "Display Document", tooltip: "", icon: "", enabled: true },
    { vkey: 5, key: "F5", text: "", tooltip: "Header Details", icon: "", enabled: true },
  ],
  keys: [
    { vkey: 3, key: "F3", text: "Back", tooltip: "", icon: "", enabled: true },
    { vkey: 11, key: "Ctrl+S", text: "Save", tooltip: "", icon: "", enabled: true },
    { vkey: 13, key: "Shift+F1", text: "Other Delivery", tooltip: "", icon: "", enabled: false },
  ],
  elements: [],
  tabstrips: [{ name: "TAXI", row: 5, col: 0, width: 150, height: 10, path: [], tabs: [{ id: "T\\01", name: "T1", text: "Item Overview", fcode: "T\\01", active: true, index: 0, row: 5, col: 1 }, { id: "T\\07", name: "T7", text: "Administration", fcode: "T\\07", active: false, index: 1, row: 5, col: 20 }] }],
  tables: [],
  controls: [],
  containers: [],
} as unknown as DiagWindow;
const s = { mode: 0, step: 1, session: { system: "ABA", client: "800", user: "U", language: "E" }, windows: [w] } as DiagScreen;
const t = (id: string, d = "press") => resolveTarget(s, { do: d, id });

describe("more of the ids the other surfaces take", () => {
  test("btn[N] is function key N, also as a scripting path", () => {
    expect(t("btn[2]")).toMatchObject({ kind: "key", key: { vkey: 2 } });
    expect(t("wnd[0]/tbar[1]/btn[5]")).toMatchObject({ kind: "key", key: { vkey: 5 } });
    expect(t("btn[3]")).toMatchObject({ kind: "key", key: { vkey: 3 } });
    expect(t("btn[40]")).toBeUndefined();
    // Save stays a write, whatever names it.
    expect(assessDiag(s, { do: "press", id: "btn[11]" }, t("btn[11]")).risk).toBe("commit");
  });
  test("a button by its text with the key the view prints after it, or by its tooltip", () => {
    expect(t("Display Document (F2)")).toMatchObject({ kind: "key", key: { vkey: 2 } });
    expect(t("Header Details")).toMatchObject({ kind: "key", key: { vkey: 5 } });
    expect(t("Header Details (F5)")).toMatchObject({ kind: "key", key: { vkey: 5 } });
  });
  test("a tab by its text", () => {
    expect(t("Administration", "select")).toMatchObject({ kind: "tab", text: "Administration" });
    expect(t("administration", "press")).toMatchObject({ kind: "tab" });
  });
});
