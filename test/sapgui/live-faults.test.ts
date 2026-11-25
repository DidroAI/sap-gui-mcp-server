/**
 * Faults first seen on a real SAP GUI (ECC 6.0, SAP GUI 8.00), played here
 * with made-up screens of the same shape. No SAP data.
 */
import { describe, expect, test } from "bun:test";
import type { Control, Screen, Transport } from "../../src/sapgui/facts.js";
import { HostError } from "../../src/sapgui/host.js";
import { sapguiSurface } from "../../src/sapgui/index.js";

/** A driver over a host that always shows `screen`, and the actions it was sent. */
async function on(screen: Screen) {
  const acts: unknown[] = [];
  const host: Transport = {
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      if (op === "screen") return structuredClone(screen) as T;
      if (op === "describe") return { found: false } as T;
      if (op === "act") {
        acts.push(params.action);
        return { done: true } as T;
      }
      throw new HostError(`UNKNOWN_OP: ${op}`);
    },
    close() {},
  };
  const d = await sapguiSurface({}, { platform: "win32", transport: host }).open({ id: "sapgui:/app/con[0]/ses[0]", surface: "sapgui", where: "test" });
  return { d, acts };
}

const one = (controls: Control[], program = "ZSEL", dynpro = "1000"): Screen => ({
  transaction: "ZT01",
  program,
  screen: dynpro,
  language: "EN",
  activeWindow: "wnd[0]",
  windows: [{ id: "wnd[0]", title: "Synthetic", controls: [{ id: "wnd[0]", type: "GuiMainWindow", name: "wnd[0]", text: "Synthetic" }, ...controls] }],
});

describe("sapgui: a selection screen is no list", () => {
  // SAP GUI gives a selection screen's user area a vertical scrollbar (VA05, MMBE, ME23N: maximum 214, page 571).
  const selection = one([
    { id: "wnd[0]/usr", type: "GuiUserArea", name: "usr", scroll: { position: 0, maximum: 214, pageSize: 571 } },
    { id: "wnd[0]/usr/ctxtSKUNNR-LOW", type: "GuiCTextField", name: "SKUNNR-LOW", text: "", label: "Sold-To Party", changeable: true },
    { id: "wnd[0]/usr/radPVBALL", type: "GuiRadioButton", name: "PVBALL", text: "All", selected: true, changeable: true },
  ]);
  test("its user area gives no list line", async () => {
    const { d } = await on(selection);
    for (const compact of [true, false]) {
      const view = await d.look({ compact });
      expect(view).not.toContain("list");
      expect(view).not.toContain("785");
      expect(view).toContain("SKUNNR-LOW");
    }
  });
  test("scroll without an id finds nothing to scroll, and scroll on usr is refused", async () => {
    const { d, acts } = await on(selection);
    expect(d.act({ do: "scroll", to: "next" })).rejects.toThrow("Nothing on this screen scrolls");
    expect(d.act({ do: "scroll", id: "usr", to: "next" })).rejects.toThrow("does not scroll");
    expect(acts).toEqual([]);
  });
  test("a classic list that scrolls keeps its list line", async () => {
    const list = one(
      [
        { id: "wnd[0]/usr", type: "GuiUserArea", name: "usr", scroll: { position: 0, maximum: 167, pageSize: 34 } },
        { id: "wnd[0]/usr/lbl[1,1]", type: "GuiLabel", name: "", text: "Line one" },
        { id: "wnd[0]/usr/lbl[1,2]", type: "GuiLabel", name: "", text: "Line two" },
      ],
      "SAPMSSY0",
      "120",
    );
    const { d } = await on(list);
    expect(await d.look({ compact: false })).toContain("wnd[0]/usr  list  201 rows (visible 34; scroll for the others)");
  });
});

describe("sapgui: a toolbar's menu button (ME23N's document overview, Selection variant)", () => {
  const TB = "wnd[0]/shellcont[1]/shell/shellcont[1]/shell[0]";
  const overview = one([
    {
      id: TB,
      type: "GuiShell",
      name: "shell",
      sub: "Toolbar",
      buttons: [
        { id: "SELECT", text: "", tip: "Selection variant", type: "Menu" },
        { id: "REFRESH", text: "", tip: "Refresh", type: "Button" },
      ],
    },
  ]);
  test("the view says it is a menu", async () => {
    const { d } = await on(overview);
    expect(await d.look({ compact: false })).toContain(`${TB}  toolbar  Selection variant {SELECT} (menu), Refresh {REFRESH}`);
  });
  test("without an entry: the host is asked for the menu, and the answer lists its entries", async () => {
    const acts: unknown[] = [];
    const host: Transport = {
      async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
        if (op === "screen") return structuredClone(overview) as T;
        if (op === "act") {
          acts.push(params.action);
          return { done: true, menu: [["PO_QUERY", "Purchase orders"], ["POS_BY_USER_QUERY", "My purchase orders"]] } as T;
        }
        return { found: false } as T;
      },
      close() {},
    };
    const d = await sapguiSurface({}, { platform: "win32", transport: host }).open({ id: "sapgui:/app/con[0]/ses[0]", surface: "sapgui", where: "test" });
    const answer = await d.act({ do: "toolbar", id: "shell[0]", button: "SELECT" });
    expect(acts).toEqual([{ do: "toolbar", id: TB, button: "SELECT" }]);
    expect(answer).toBe(`SELECT in ${TB} is a menu: Purchase orders, My purchase orders. Choose one with "value", e.g. {"do":"toolbar","id":"${TB}","button":"SELECT","value":"Purchase orders"}.`);
  });
  test("with an entry: it goes to the host as menu", async () => {
    const { d, acts } = await on(overview);
    await d.act({ do: "toolbar", id: "shell[0]", button: "SELECT", value: "My purchase orders" });
    expect(acts).toEqual([{ do: "toolbar", id: TB, button: "SELECT", menu: "My purchase orders" }]);
  });
  test("the guard judges the entry: a safe button's plain entry navigates, an entry that saves or deletes commits", async () => {
    const { d } = await on(overview);
    expect((await d.assess({ do: "toolbar", id: "shell[0]", button: "REFRESH", value: "Purchase orders" })).risk).toBe("navigate");
    expect((await d.assess({ do: "toolbar", id: "shell[0]", button: "REFRESH", value: "Delete" })).risk).toBe("commit");
    expect((await d.assess({ do: "toolbar", id: "shell[0]", button: "SELECT", value: "Purchase orders" })).risk).toBe("navigate");
  });
});

describe("sapgui: a field SAP keeps closed is refused with the reason (FB50, live 2026-11-25)", () => {
  const closed = (type: string, text: string) =>
    one([
      { id: "wnd[0]/usr/ctxtACGL_HEAD-BLDAT", type: "GuiCTextField", name: "ACGL_HEAD-BLDAT", text: "", label: "Document Date", changeable: true },
      { id: "wnd[0]/usr/txtACGL_HEAD-BKTXT", type: "GuiTextField", name: "ACGL_HEAD-BKTXT", text: "", label: "Doc.Header Text", changeable: false },
      { id: "wnd[0]/sbar", type: "GuiStatusbar", name: "sbar", text, messageType: type },
    ]);
  test("after an error: correct the field it names, then Enter; nothing is sent", async () => {
    const { d, acts } = await on(closed("E", "Enter valid date"));
    await expect(d.act({ do: "set", id: "txtACGL_HEAD-BKTXT", value: "X" })).rejects.toThrow('read-only now: after the error "Enter valid date" SAP keeps the other fields closed. Correct the field the message names, then Enter');
    expect(acts).toEqual([]);
  });
  test("after a warning: Enter accepts it", async () => {
    const { d } = await on(closed("W", "Check the tax code"));
    await expect(d.act({ do: "set", id: "txtACGL_HEAD-BKTXT", value: "X" })).rejects.toThrow("Enter accepts the warning");
  });
  test("without a message: a display field", async () => {
    const { d } = await on(closed("", ""));
    await expect(d.act({ do: "set", id: "txtACGL_HEAD-BKTXT", value: "X" })).rejects.toThrow("read-only on this screen");
  });
  test("a field that takes input is set as before", async () => {
    const { d, acts } = await on(closed("E", "Enter valid date"));
    await d.act({ do: "set", id: "ctxtACGL_HEAD-BLDAT", value: "25.11.2026" });
    expect(acts).toEqual([{ do: "set", id: "wnd[0]/usr/ctxtACGL_HEAD-BLDAT", value: "25.11.2026" }]);
  });
});

describe("sapgui: a click on a grid's cell selects its row (FB02, live 2026-11-25)", () => {
  const grid = one([
    {
      id: "wnd[0]/usr/cntlCTRL_CONTAINERBSEG/shellcont/shell",
      type: "GuiShell",
      name: "shell",
      sub: "GridView",
      grid: { cols: ["KTONR", "KOBEZ"], titles: ["Account", "Name"], rowCount: 3, rows: [["1000", "A"], ["1100", "B"], ["1200", "C"]] },
    },
  ]);
  test("click with row and col: the cursor on the cell, the row selected", async () => {
    const { d, acts } = await on(grid);
    expect(await d.act({ do: "click", id: "cntlCTRL_CONTAINERBSEG/shell", row: 1, col: "KTONR" })).toContain("grid select row 1");
    expect(acts).toEqual([{ do: "grid", id: "wnd[0]/usr/cntlCTRL_CONTAINERBSEG/shellcont/shell", row: 1, col: "KTONR", how: "select" }]);
  });
  test("press with row only: the row selected", async () => {
    const { d, acts } = await on(grid);
    await d.act({ do: "press", id: "cntlCTRL_CONTAINERBSEG/shell", row: 2 });
    expect(acts).toEqual([{ do: "grid", id: "wnd[0]/usr/cntlCTRL_CONTAINERBSEG/shellcont/shell", row: 2, col: "", how: "select" }]);
  });
  test("the guard judges it as selecting a row, not as an unknown press", async () => {
    const { d } = await on(grid);
    expect(await d.assess({ do: "click", id: "cntlCTRL_CONTAINERBSEG/shell", row: 1, col: "KTONR" })).toMatchObject({ risk: "navigate" });
    // Without a row it stays unknown: under writes off it is refused.
    expect((await d.assess({ do: "click", id: "cntlCTRL_CONTAINERBSEG/shell" })).risk).not.toBe("navigate");
  });
});

describe("sapgui: typing into fields does not read the screen again (FB50, live 2026-11-25: 23 s for 7 cells)", () => {
  /** A host that counts screen reads; acts change nothing it shows. */
  async function counting(screen: Screen) {
    let reads = 0;
    const acts: unknown[] = [];
    const host: Transport = {
      async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
        if (op === "screen") {
          reads++;
          return structuredClone(screen) as T;
        }
        if (op === "describe") return { found: false } as T;
        if (op === "act") acts.push(params.action);
        return { done: true } as T;
      },
      close() {},
    };
    const d = await sapguiSurface({}, { platform: "win32", transport: host }).open({ id: "sapgui:/app/con[0]/ses[0]", surface: "sapgui", where: "test" });
    return { d, acts, reads: () => reads };
  }
  const form = one([
    { id: "wnd[0]/tbar[0]/btn[11]", type: "GuiButton", name: "btn[11]", text: "Save", tip: "Save (Ctrl+S)", changeable: true },
    { id: "wnd[0]/usr/ctxtZ-A", type: "GuiCTextField", name: "Z-A", text: "", label: "A", changeable: true },
    { id: "wnd[0]/usr/txtZ-B", type: "GuiTextField", name: "Z-B", text: "", label: "B", changeable: true },
  ]);
  test("assess, set, look: one read, and the view shows what was typed", async () => {
    const { d, reads } = await counting(form);
    await d.assess({ do: "set", id: "ctxtZ-A", value: "1000" });
    await d.act({ do: "set", id: "ctxtZ-A", value: "1000" });
    const view = await d.look({ compact: true });
    expect(view).toContain('ctxtZ-A  field  A = "1000"');
    await d.assess({ do: "set", id: "txtZ-B", value: "x" });
    await d.act({ do: "set", id: "txtZ-B", value: "x" });
    expect(await d.look({ compact: true })).toContain('txtZ-B  field  B = "x"');
    expect(reads()).toBe(1);
  });
  test("after a key or a button the screen is read again", async () => {
    const { d, reads } = await counting(form);
    await d.act({ do: "set", id: "ctxtZ-A", value: "1000" });
    await d.act({ do: "key", key: 0 });
    await d.look({ compact: true });
    expect(reads()).toBe(2);
    // The fake shows the field empty: the view is SAP's, not what was typed.
    expect(await d.look({ compact: true })).toContain('ctxtZ-A  field  A = ""');
  });
  test("a plain look after a while reads again", async () => {
    const { d, reads } = await counting(form);
    await d.look({ compact: true });
    await d.look({ compact: true });
    expect(reads()).toBe(2);
  });
});

describe("sapgui: a table's dropdown cell and a pressed tab (FB50, MM02, live 2026-11-25)", () => {
  const T = "wnd[0]/usr/tblSAPLFSKBTABLE";
  const screen = one([
    { id: "wnd[0]/usr/tabsTABSPR1/tabpSP12", type: "GuiTab", name: "SP12", text: "MRP 1" },
    { id: T, type: "GuiTableControl", name: "SAPLFSKBTABLE", rowCount: 16, visibleRowCount: 2, firstRow: 0, columns: ["G/L acct", "D/C"] },
    { id: `${T}/ctxtACGL_ITEM-HKONT[1,0]`, type: "GuiCTextField", name: "ACGL_ITEM-HKONT", text: "", changeable: true },
    { id: `${T}/cmbACGL_ITEM-SHKZG[3,0]`, type: "GuiComboBox", name: "ACGL_ITEM-SHKZG", key: "", entries: [["S", "Debit"], ["H", "Credit"]], changeable: true },
  ]);
  test("combo with the table, row and col chooses the cell's entry", async () => {
    const { d, acts } = await on(screen);
    await d.act({ do: "combo", id: "tblSAPLFSKBTABLE", row: 0, col: "cmbACGL_ITEM-SHKZG", key: "S" });
    expect(acts).toEqual([{ do: "combo", id: `${T}/cmbACGL_ITEM-SHKZG[3,0]`, key: "S" }]);
  });
  test("press on a tab selects it", async () => {
    const { d, acts } = await on(screen);
    expect(await d.act({ do: "press", id: "tabpSP12" })).toBe("select wnd[0]/usr/tabsTABSPR1/tabpSP12");
    expect(acts).toEqual([{ do: "select", id: "wnd[0]/usr/tabsTABSPR1/tabpSP12" }]);
    expect((await d.assess({ do: "press", id: "tabpSP12" })).risk).toBe("navigate");
  });
});
