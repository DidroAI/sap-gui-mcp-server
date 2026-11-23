/**
 * Table controls, ALV grid cells and the keys without a virtual key: what the
 * driver sends to the host (the host itself needs SAP GUI and is checked live).
 */
import { describe, expect, test } from "bun:test";
import type { Control, Screen, Transport } from "../../src/sapgui/facts.js";
import { sapguiSurface } from "../../src/sapgui/index.js";
import { cellParts, localKey, nextField, tableCell, tableColumn } from "../../src/sapgui/table.js";

const TBL = "wnd[1]/usr/tblSAPLMGMMTC_VIEW";
const GRID = "wnd[0]/usr/subSUB0:SAPLMEGUI:0013/subSUB2:SAPLMEVIEWS:1100/subSUB2:SAPLMEVIEWS:1200/subSUB1:SAPLMEGUI:3212/cntlGRIDCONTROL/shellcont/shell";

/** The MM02 "Select View(s)" popup: a table control with row selectors, 4 of its 6 rows on screen from `first`. */
function views(first = 0, focus?: string): Screen {
  const names = ["Basic Data 1", "Basic Data 2", "Purchasing", "MRP 1", "MRP 2", "Accounting 1"];
  const cells: Control[] = [];
  for (let v = 0; v < 4; v++) cells.push({ id: `${TBL}/txtMSICHTAUSW-DYTXT[0,${v}]`, type: "GuiTextField", name: "MSICHTAUSW-DYTXT", text: names[first + v] ?? "", changeable: false });
  return {
    transaction: "MM02",
    program: "SAPLMGMM",
    screen: "0070",
    language: "EN",
    activeWindow: "wnd[1]",
    ...(focus ? { focus } : {}),
    windows: [
      { id: "wnd[0]", title: "Change Material (Initial Screen)", controls: [{ id: "wnd[0]/usr/ctxtRMMG1-MATNR", type: "GuiCTextField", name: "RMMG1-MATNR", text: "M-01", changeable: true }] },
      {
        id: "wnd[1]",
        title: "Select View(s)",
        controls: [
          { id: TBL, type: "GuiTableControl", name: "SAPLMGMMTC_VIEW", rowCount: 6, visibleRowCount: 4, firstRow: first, columns: ["View"] },
          ...cells,
          { id: "wnd[1]/usr/chkRMMG1_FLAG-DEFAULT", type: "GuiCheckBox", name: "RMMG1_FLAG-DEFAULT", text: "Default", selected: false, changeable: true },
          { id: "wnd[1]/tbar[0]/btn[0]", type: "GuiButton", name: "btn[0]", text: "", tip: "Continue (Enter)", changeable: true },
        ],
      },
    ],
  };
}

/** ME51N's item overview: an ALV grid that takes input. */
const ME51N: Screen = {
  transaction: "ME51N",
  program: "SAPLMEGUI",
  screen: "0014",
  language: "EN",
  activeWindow: "wnd[0]",
  windows: [
    {
      id: "wnd[0]",
      title: "Create Purchase Requisition",
      controls: [
        {
          id: GRID,
          type: "GuiShell",
          name: "shell",
          sub: "GridView",
          grid: { cols: ["BNFPO", "MATNR", "MENGE", "WERKS"], titles: ["Item", "Material", "Quantity", "Plant"], rowCount: 3, rows: [["", "", "", ""]], first: 0 },
        },
      ],
    },
  ],
};

/** A host that shows `screens()` and records what it is asked; a scroll moves the table control to its target row. */
function hostFor(start: Screen) {
  const asked: { op: string; params: Record<string, unknown> }[] = [];
  let screen = start;
  const host: Transport = {
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      asked.push({ op, params });
      if (op === "screen") return screen as T;
      if (op === "describe") return { found: false } as T;
      const a = params.action as Record<string, unknown>;
      if (op === "act" && a.do === "scroll" && a.id === TBL) {
        const from = screen.windows[1]?.controls[0]?.firstRow ?? 0;
        const first = Math.min(Number(a.to), 2);
        screen = views(first);
        return { from, first, visible: 4, total: 6 } as T;
      }
      return { done: true } as T;
    },
    close() {},
  };
  const surface = sapguiSurface({}, { platform: "win32", transport: host });
  const acts = () => asked.filter((x) => x.op === "act").map((x) => x.params.action);
  return { asked, acts, open: () => surface.open({ id: "sapgui:/app/con[0]/ses[0]", surface: "sapgui", where: "test" }) };
}

describe("table control rows", () => {
  test("select with row selects the row by its row selector, not by a Select call on the table", async () => {
    const { acts, open } = hostFor(views());
    const d = await open();
    expect(await d.act({ do: "select", id: TBL, row: 3 })).toBe(`selected row 3 of ${TBL}`);
    expect(acts().at(-1)).toEqual({ do: "selectrow", id: TBL, row: 3, value: true });
    // By its short id, too, and "value":false unselects.
    await d.act({ do: "select", id: "tblSAPLMGMMTC_VIEW", row: 0, value: false });
    expect(acts().at(-1)).toEqual({ do: "selectrow", id: TBL, row: 0, value: false });
  });

  test("grid how:select on a table control is the same row selection", async () => {
    const { acts, open } = hostFor(views());
    const d = await open();
    await d.act({ do: "grid", id: TBL, row: 2, col: "MSICHTAUSW-DYTXT", how: "select" });
    expect(acts().at(-1)).toEqual({ do: "selectrow", id: TBL, row: 2, value: true });
  });

  test("a row the table does not have is refused before SAP GUI is asked", async () => {
    const { acts, open } = hostFor(views());
    const d = await open();
    await expect(d.act({ do: "select", id: TBL, row: 6 })).rejects.toThrow(`row 6: ${TBL} has 6 rows (0 to 5).`);
    await expect(d.act({ do: "select", id: TBL, row: -1 })).rejects.toThrow('"row" is a row number from 0');
    await expect(d.act({ do: "select", id: TBL })).rejects.toThrow('"select" needs "row"');
    expect(acts()).toEqual([]);
  });

  test("assess judges a row selection as navigation, not a write", async () => {
    const { open } = hostFor(views());
    const d = await open();
    expect((await d.assess({ do: "select", id: TBL, row: 3 })).risk).toBe("navigate");
  });
});

describe("select on what cannot be selected", () => {
  test("a button is pressed, a checkbox ticked", async () => {
    const { acts, open } = hostFor(views());
    const d = await open();
    await d.act({ do: "select", id: "wnd[1]/tbar[0]/btn[0]" });
    expect(acts().at(-1)).toEqual({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" });
    await d.act({ do: "select", id: "chkRMMG1_FLAG-DEFAULT" });
    expect(acts().at(-1)).toEqual({ do: "check", id: "wnd[1]/usr/chkRMMG1_FLAG-DEFAULT", value: true });
  });

  test("a field is refused with the actions to use instead", async () => {
    const { acts, open } = hostFor(views());
    const d = await open();
    await expect(d.act({ do: "select", id: "wnd[0]/usr/ctxtRMMG1-MATNR" })).rejects.toThrow('cannot be selected: "select" takes a tab, a radio button, a menu entry, or a table or grid row with "row". Use "set" for a field');
    expect(acts()).toEqual([]);
  });
});

describe("set into a table control's cell", () => {
  test("by row and field name, on screen", async () => {
    const { acts, open } = hostFor(views());
    const d = await open();
    // The cells here are read-only in SAP, but the driver's routing is what is checked: the cell's own id.
    expect(await d.act({ do: "set", id: TBL, row: 1, col: "MSICHTAUSW-DYTXT", value: "x" })).toBe(`set ${TBL}/txtMSICHTAUSW-DYTXT[0,1] = "x"`);
    expect(acts().at(-1)).toEqual({ do: "set", id: `${TBL}/txtMSICHTAUSW-DYTXT[0,1]`, value: "x" });
    // By the column's title, its short field name, or its number.
    await d.act({ do: "set", id: TBL, row: 2, col: "View", value: "y" });
    expect(acts().at(-1)).toMatchObject({ id: `${TBL}/txtMSICHTAUSW-DYTXT[0,2]` });
    await d.act({ do: "set", id: TBL, row: 3, col: "DYTXT", value: "z" });
    expect(acts().at(-1)).toMatchObject({ id: `${TBL}/txtMSICHTAUSW-DYTXT[0,3]` });
    await d.act({ do: "set", id: TBL, row: 0, col: "0", value: "w" });
    expect(acts().at(-1)).toMatchObject({ id: `${TBL}/txtMSICHTAUSW-DYTXT[0,0]` });
  });

  test("a row below the screen is scrolled to first, then set by its row on screen", async () => {
    const { acts, open } = hostFor(views());
    const d = await open();
    expect(await d.act({ do: "set", id: TBL, row: 5, col: "View", value: "v" })).toBe(`set ${TBL}/txtMSICHTAUSW-DYTXT[0,3] = "v"`);
    expect(acts()).toEqual([
      { do: "scroll", id: TBL, to: 5 },
      { do: "set", id: `${TBL}/txtMSICHTAUSW-DYTXT[0,3]`, value: "v" },
    ]);
  });

  test("an unknown column or a missing row/col says what to give", async () => {
    const { acts, open } = hostFor(views());
    const d = await open();
    await expect(d.act({ do: "set", id: TBL, row: 0, col: "NOPE", value: "x" })).rejects.toThrow(`${TBL} has no column "NOPE". Give "col" as a field name, a column title or a column number: 0=MSICHTAUSW-DYTXT (View)`);
    await expect(d.act({ do: "set", id: TBL, value: "x" })).rejects.toThrow('is a table: give "row" (from 0) and "col"');
    expect(acts()).toEqual([]);
  });
});

describe("set into an ALV grid's cell", () => {
  test("modifies the cell by row and column id or title", async () => {
    const { acts, open } = hostFor(ME51N);
    const d = await open();
    expect(await d.act({ do: "set", id: GRID, row: 0, col: "MATNR", value: "M-01" })).toBe(`set row 0, column MATNR of ${GRID} = "M-01"`);
    expect(acts().at(-1)).toEqual({ do: "cell", id: GRID, row: 0, col: "MATNR", value: "M-01" });
    await d.act({ do: "set", id: "cntlGRIDCONTROL/shellcont/shell", row: 1, col: "Quantity", value: "5" });
    expect(acts().at(-1)).toEqual({ do: "cell", id: GRID, row: 1, col: "MENGE", value: "5" });
  });

  test("without row and col, or with an unknown column, it says what to give", async () => {
    const { acts, open } = hostFor(ME51N);
    const d = await open();
    await expect(d.act({ do: "set", id: GRID, value: "x" })).rejects.toThrow('is an ALV grid: "set" into one of its cells needs "row"');
    await expect(d.act({ do: "set", id: GRID, row: 0, col: "NOPE", value: "x" })).rejects.toThrow('has no column "NOPE". Give "col" as a column id: BNFPO=Item | MATNR=Material');
    expect(acts()).toEqual([]);
  });

  test("select with row on a grid selects the grid row", async () => {
    const { acts, open } = hostFor(ME51N);
    const d = await open();
    await d.act({ do: "select", id: GRID, row: 2 });
    expect(acts().at(-1)).toEqual({ do: "grid", id: GRID, row: 2, col: "", how: "select" });
  });
});

describe("keys without a virtual key", () => {
  test("Tab and Shift+Tab move the focus to the next or previous field that takes input", async () => {
    const screen: Screen = {
      ...views(0, "wnd[1]/usr/chkRMMG1_FLAG-DEFAULT"),
      activeWindow: "wnd[0]",
      focus: "wnd[0]/usr/ctxtA",
      windows: [
        {
          id: "wnd[0]",
          title: "x",
          controls: [
            { id: "wnd[0]/usr/ctxtA", type: "GuiCTextField", name: "A", text: "", changeable: true },
            { id: "wnd[0]/usr/txtRO", type: "GuiTextField", name: "RO", text: "", changeable: false },
            { id: "wnd[0]/usr/txtB", type: "GuiTextField", name: "B", text: "", changeable: true },
          ],
        },
      ],
    };
    const { acts, open } = hostFor(screen);
    const d = await open();
    expect(await d.act({ do: "key", key: "Tab" })).toBe("key Tab: focus wnd[0]/usr/txtB");
    await d.act({ do: "key", key: "Shift+Tab" });
    expect(acts().at(-1)).toEqual({ do: "focus", id: "wnd[0]/usr/txtB" });
    expect((await d.assess({ do: "key", key: "Tab" })).risk).toBe("read");
    expect(nextField(screen, false)?.id).toBe("wnd[0]/usr/txtB");
    expect(nextField({ ...screen, focus: "wnd[0]/usr/txtB" }, false)?.id).toBe("wnd[0]/usr/ctxtA");
  });

  test("Space in a table row selects that row; on a checkbox it ticks it", async () => {
    const { acts, open } = hostFor(views(2, `${TBL}/txtMSICHTAUSW-DYTXT[0,1]`));
    const d = await open();
    // Row 1 on screen, the table scrolled to row 2: row 3 of the table.
    expect(await d.act({ do: "key", key: "Shift+Space" })).toBe(`key Shift+Space: selected row 3 of ${TBL}`);
    expect(acts().at(-1)).toEqual({ do: "selectrow", id: TBL, row: 3, value: true });
    expect((await d.assess({ do: "key", key: "Space" })).risk).toBe("navigate");

    const box = hostFor(views(0, "wnd[1]/usr/chkRMMG1_FLAG-DEFAULT"));
    const b = await box.open();
    await b.act({ do: "key", key: "Space" });
    expect(box.acts().at(-1)).toEqual({ do: "check", id: "wnd[1]/usr/chkRMMG1_FLAG-DEFAULT", value: true });
  });

  test("Space elsewhere names the actions to use", async () => {
    const { acts, open } = hostFor(views(0, "wnd[1]/tbar[0]/btn[0]"));
    const d = await open();
    await expect(d.act({ do: "key", key: "Shift+Space" })).rejects.toThrow('Select a table row with {"do":"select","id":"<table>","row":N}');
    expect(acts()).toEqual([]);
  });

  test("localKey names", () => {
    expect(localKey("tab")).toBe("tab");
    expect(localKey("Shift + Tab")).toBe("backtab");
    expect(localKey("Space")).toBe("space");
    expect(localKey("Shift+Space")).toBe("rowselect");
    expect(localKey("Enter")).toBeUndefined();
    expect(localKey(0)).toBeUndefined();
  });
});

describe("cell ids", () => {
  test("parts of a cell id", () => {
    expect(cellParts(`${TBL}/chkMSICHTAUSW-KZSEL[1,7]`)).toEqual({ table: TBL, field: "MSICHTAUSW-KZSEL", col: 1, vrow: 7 });
    expect(cellParts("wnd[0]/usr/txtA")).toBeUndefined();
  });

  test("tableCell asks for a scroll when the row is above or below the screen", () => {
    const s = views(2);
    const t = s.windows[1]?.controls[0] as Control;
    expect(tableCell(s, t, 0, "View")).toEqual({ scroll: true });
    expect(tableCell(s, t, 5, "View")).toMatchObject({ cell: { id: `${TBL}/txtMSICHTAUSW-DYTXT[0,3]` } });
    expect(tableColumn(s, t, "view")).toBe(0);
  });
});
