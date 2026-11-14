/**
 * Long lists, dropdown entries and handles on the SAP GUI surface, against a
 * host that plays a grid, a table control and a long tree. No SAP GUI and no
 * SAP data: the screen is made up.
 */
import { describe, expect, test } from "bun:test";
import type { Control, Screen, Transport } from "../../src/sapgui/facts.js";
import { HostError } from "../../src/sapgui/host.js";
import { sapguiSurface } from "../../src/sapgui/index.js";
import { controlLines } from "../../src/sapgui/format.js";
import { resolveStrict } from "../../src/sapgui/resolve.js";

const GRID = "wnd[0]/usr/cntlGRID1/shellcont/shell";
const TREE = "wnd[0]/usr/cntlSPLIT/shellcont/shell/shellcont[0]/shell";
const EDITOR = "wnd[0]/usr/cntlSPLIT/shellcont/shell/shellcont[1]/shell";
const TABLE = "wnd[0]/usr/tblZPROGTC_ITEMS";
const COMBO = "wnd[0]/usr/cmbZHDR-COUNTRY";

/** A host whose grid has 120 rows and shows 20, and whose tree has 700 nodes and gives 300 at a time, as ps/host-lib.ps1 does. */
function world() {
  const state = { gridFirst: 0, tableFirst: 0 };
  const asked: { op: string; params: Record<string, unknown> }[] = [];
  const countries: [string, string][] = Array.from({ length: 40 }, (_, i) => [`C${i}`, `Country ${i}`]);
  const screen = (treeFrom: Record<string, number> = {}): Screen => {
    const first = Math.max(0, Math.min(state.gridFirst, 120 - 50));
    const from = treeFrom[TREE] ?? 0;
    return {
      transaction: "ZT05",
      program: "ZLIST",
      screen: "500",
      language: "EN",
      activeWindow: "wnd[0]",
      windows: [
        {
          id: "wnd[0]",
          title: "Synthetic list",
          controls: [
            { id: "wnd[0]/usr/cntlGRID1", type: "GuiCustomControl", name: "GRID1" },
            { id: GRID, type: "GuiShell", name: "shell", sub: "GridView", grid: { cols: ["DOC", "TYPE"], titles: ["Doc", "Type"], rowCount: 120, first, rows: Array.from({ length: 50 }, (_, i) => [String(1000 + first + i), "OR"]) } },
            { id: TREE, type: "GuiShell", name: "shell", sub: "Tree", tree: { shown: 700, headers: [], first: from, nodes: Array.from({ length: Math.min(300, 700 - from) }, (_, i) => ({ key: String(from + i), depth: 0, text: `Node ${from + i}`, items: null })) } },
            { id: EDITOR, type: "GuiShell", name: "shell", sub: "TextEdit", text: "note" },
            { id: TABLE, type: "GuiTableControl", name: "ZPROGTC_ITEMS", rowCount: 60, visibleRowCount: 2, firstRow: state.tableFirst, columns: ["Item"] },
            { id: `${TABLE}/txtZITM-POSNR[0,0]`, type: "GuiTextField", name: "ZITM-POSNR", text: String((state.tableFirst + 1) * 10), changeable: false },
            { id: `${TABLE}/txtZITM-POSNR[0,1]`, type: "GuiTextField", name: "ZITM-POSNR", text: String((state.tableFirst + 2) * 10), changeable: false },
            { id: COMBO, type: "GuiComboBox", name: "ZHDR-COUNTRY", label: "Country", key: "C1", text: "Country 1", changeable: true, entries: countries },
            { id: "wnd[0]/tbar[0]/btn[3]", type: "GuiButton", name: "btn[3]", text: "", tip: "Back   (F3)", changeable: true },
          ],
        },
      ],
    };
  };
  const host: Transport = {
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      asked.push({ op, params });
      if (op === "screen") return screen((params.treeFrom as Record<string, number> | undefined) ?? {}) as T;
      if (op === "describe") return { found: false } as T;
      if (op === "act") {
        const a = params.action as { do: string; id: string; to?: number | string; row?: number };
        if (a.do === "scroll" && a.id === GRID) {
          const from = state.gridFirst;
          const to = typeof a.to === "number" ? a.to : a.to === "next" ? from + 20 : a.to === "prev" ? from - 20 : a.to === "last" ? 100 : 0;
          state.gridFirst = Math.max(0, Math.min(to, 100));
          return { done: true, from, first: state.gridFirst, visible: 20, total: 120 } as T;
        }
        if (a.do === "scroll" && a.id === TABLE) {
          const from = state.tableFirst;
          state.tableFirst = Math.max(0, Math.min(Number(a.to), 58));
          return { done: true, from, first: state.tableFirst, visible: 2, total: 60 } as T;
        }
        if (a.do === "scroll") throw new HostError(`NO_SCROLL: ${a.id} does not scroll`);
        if (a.do === "grid" && (a.row ?? 0) >= 120) throw new HostError(`NOT_FOUND: row ${a.row}: the grid has 120 rows (0 to 119)`);
        return { done: true } as T;
      }
      throw new HostError(`UNKNOWN_OP: ${op}`);
    },
    close() {},
  };
  const surface = sapguiSurface({}, { platform: "win32", transport: host });
  const open = () => surface.open({ id: "sapgui:/app/con[0]/ses[0]", surface: "sapgui", where: "test" });
  const acts = () => asked.filter((x) => x.op === "act").map((x) => x.params.action);
  return { asked, acts, open, screen };
}

describe("sapgui: scrolling", () => {
  test("a grid scrolls to a row, and the view then holds the rows from there", async () => {
    const w = world();
    const d = await w.open();
    expect(await d.act({ do: "scroll", id: "cntlGRID1/shell", to: 60 })).toBe(`scrolled ${GRID}: rows 60 to 79 of 120`);
    expect(w.acts()).toEqual([{ do: "scroll", id: GRID, to: 60 }]);
    const view = await d.look({ compact: true });
    expect(view).toContain("  row 60: 1060 | OR");
    expect(view).toContain("  ... 70 more rows (shown: 60 to 109; scroll for the others)");
    expect(await d.act({ do: "scroll", id: "cntlGRID1/shell", to: "last" })).toBe(`scrolled ${GRID}: rows 100 to 119 of 120`);
    expect(await d.act({ do: "scroll", id: "cntlGRID1/shell", to: "last" })).toBe(`${GRID} is already there: rows 100 to 119 of 120`);
  });
  test("scrolling is a read for the guard", async () => {
    const d = await world().open();
    expect((await d.assess({ do: "scroll", id: "cntlGRID1/shell", to: "next" })).risk).toBe("read");
  });
  test("a table control scrolls by its scrollbar; the view says which row its row 0 is", async () => {
    const w = world();
    const d = await w.open();
    expect(await d.act({ do: "scroll", id: "tblZPROGTC_ITEMS", to: 30 })).toBe(`scrolled ${TABLE}: rows 30 to 31 of 60`);
    const view = await d.look({ compact: true });
    expect(view).toContain("tblZPROGTC_ITEMS  table  rows 60 (visible 2, first 30); columns: Item  (cell ids: <field>[col,row], e.g. tblZPROGTC_ITEMS/<ctl><FIELD>[0,0]; row 0 here is row 30 of the table)");
    expect(view).toContain("  row 0: Item=310");
  });
  test("a tree longer than one read is paged, until an action moves on", async () => {
    const w = world();
    const d = await w.open();
    expect(await d.look({ compact: true })).toContain("shellcont[0]/shell  tree  700 nodes shown (300 listed, first 0; scroll for the others)");
    expect(await d.act({ do: "scroll", id: "shellcont[0]/shell", to: "next" })).toBe(`scrolled ${TREE}: nodes 300 to 599 of 700`);
    // Paging a tree is the server's own bookkeeping: nothing is sent to SAP GUI but the next read.
    expect(w.acts()).toEqual([]);
    const view = await d.look({ compact: true });
    expect(view).toContain("tree  700 nodes shown (300 listed, first 300; scroll for the others)");
    expect(view).toContain("  Node 300  {node 300}");
    expect(w.asked.at(-1)).toEqual({ op: "screen", params: { session: "/app/con[0]/ses[0]", treeFrom: { [TREE]: 300 } } });
    await d.act({ do: "key", key: 0 });
    expect(await d.look({ compact: true })).toContain("first 0; scroll for the others");
  });
  test("a control that does not scroll says so", async () => {
    const d = await world().open();
    expect(d.act({ do: "scroll", id: "cmbZHDR-COUNTRY", to: "next" })).rejects.toThrow('does not scroll: "scroll" works on a grid, a table control, a tree or a list');
    expect(d.act({ do: "scroll", to: "next" })).rejects.toThrow('scroll needs "id": one of');
  });
  test("a grid row the grid does not have is an error with the grid's size", async () => {
    const d = await world().open();
    expect(d.act({ do: "grid", id: "cntlGRID1/shell", row: 500, col: "DOC" })).rejects.toThrow("row 500: the grid has 120 rows (0 to 119)");
  });
});

describe("sapgui: a range of rows", () => {
  test("rows of a grid are read by scrolling, page by page", async () => {
    const w = world();
    const d = await w.open();
    const out = (await d.look({ compact: true, id: "cntlGRID1/shell", rows: { from: 40, to: 99 } })).split("\n");
    expect(out[2]).toBe("cntlGRID1/shell  grid  120 rows; columns: DOC=Doc | TYPE=Type");
    expect(out[3]).toBe("  row 40: 1040 | OR");
    expect(out[62]).toBe("  row 99: 1099 | OR");
    expect(out[63]).toBe("  (rows 40 to 99 of 120; the control is now scrolled there.)");
    expect(w.acts()).toEqual([
      { do: "scroll", id: GRID, to: 40 },
      { do: "scroll", id: GRID, to: 90 },
    ]);
  });
  test("rows of a table control are numbered in the whole table", async () => {
    const d = await world().open();
    const out = (await d.look({ compact: true, id: "tblZPROGTC_ITEMS", rows: { from: 10, to: 13 } })).split("\n");
    expect(out.slice(3, 7)).toEqual(["  row 10: Item=110", "  row 11: Item=120", "  row 12: Item=130", "  row 13: Item=140"]);
  });
  test("one control alone: its lines, and nothing else of the screen", async () => {
    const d = await world().open();
    const out = (await d.look({ compact: true, id: "shellcont[1]/shell" })).split("\n");
    // Under the handle the screen's view gives it.
    expect(out).toEqual(["TRANSACTION ZT05  PROGRAM ZLIST  SCREEN 500", 'WINDOW wnd[0]  "Synthetic list"', 'cntlSPLIT/shellcont[1]/shell  text-editor  "note"']);
    expect(d.look({ compact: true, id: "cntlNONE/shell" })).rejects.toThrow('No control "cntlNONE/shell" on this screen');
  });
});

describe("sapgui: dropdown entries on request", () => {
  test("the view gives the current entry and the count", async () => {
    const d = await world().open();
    expect(await d.look({ compact: true })).toContain('cmbZHDR-COUNTRY  dropdown  Country = "C1" Country 1  (40 options)');
    // The full view lists the first thirty and says there are more.
    expect((await d.look({ compact: false })).split("\n").find((l) => l.includes("cmbZHDR-COUNTRY"))).toMatch(/ {2}40 options: C0:Country 0, .*C29:Country 29, \.\.\.$/);
  });
  test("combo without a key lists every entry, changes nothing, and is a read", async () => {
    const w = world();
    const d = await w.open();
    expect((await d.assess({ do: "combo", id: "cmbZHDR-COUNTRY" })).risk).toBe("read");
    const note = await d.act({ do: "combo", id: "cmbZHDR-COUNTRY" });
    expect(note).toStartWith(`${COMBO} has 40 entries: C0:Country 0, C1:Country 1, `);
    expect(note).toEndWith("C39:Country 39");
    expect(w.acts()).toEqual([]);
    expect((await d.assess({ do: "combo", id: "cmbZHDR-COUNTRY", key: "C2" })).risk).toBe("navigate");
  });
  test("sap_look with the dropdown's id gives every entry", async () => {
    const d = await world().open();
    const out = await d.look({ compact: true, id: "cmbZHDR-COUNTRY" });
    expect(out.split("\n")[2]).toMatch(/^cmbZHDR-COUNTRY {2}dropdown {2}Country = "C1" Country 1 {2}40 options: C0:Country 0, .*C39:Country 39$/);
  });
});

describe("sapgui: handles", () => {
  test("the compact view names each shell by a short handle, and every action resolves it", async () => {
    const w = world();
    const d = await w.open();
    const view = await d.look({ compact: true });
    expect(view).toContain("cntlGRID1/shell  grid  120 rows");
    expect(view).toContain("cntlSPLIT/shellcont[0]/shell  tree  700 nodes shown");
    expect(view).toContain('cntlSPLIT/shellcont[1]/shell  text-editor  "note"');
    await d.act({ do: "tree", id: "cntlSPLIT/shellcont[0]/shell", node: "7", how: "select" });
    await d.act({ do: "set", id: "cntlSPLIT/shellcont[1]/shell", value: "new" });
    await d.act({ do: "grid", id: "cntlGRID1/shell", row: 3, col: "DOC", how: "select" });
    expect(w.acts()).toEqual([
      { do: "tree", id: TREE, node: "7", how: "select" },
      { do: "set", id: EDITOR, value: "new" },
      { do: "grid", id: GRID, row: 3, col: "DOC", how: "select" },
    ]);
  });
  test('"shell" alone names three controls here: refused with the list, nothing is sent', async () => {
    const w = world();
    const d = await w.open();
    expect(d.act({ do: "tree", id: "shell", node: "7" })).rejects.toThrow('"shell" names 3 controls on this screen: cntlGRID1/shell, cntlSPLIT/shellcont[0]/shell, cntlSPLIT/shellcont[1]/shell. Use one of these ids.');
    expect(d.assess({ do: "tree", id: "shell", node: "7" })).rejects.toThrow("names 3 controls");
    expect(w.acts()).toEqual([]);
  });
  test("a field and its label share a name: the field is meant, as before", () => {
    const controls: Control[] = [
      { id: "wnd[0]/usr/lblZHDR-TYPE", type: "GuiLabel", name: "ZHDR-TYPE", text: "Order Type" },
      { id: "wnd[0]/usr/ctxtZHDR-TYPE", type: "GuiCTextField", name: "ZHDR-TYPE", text: "", changeable: true },
    ];
    const screen: Screen = { transaction: "Z", program: "Z", screen: "1", activeWindow: "wnd[0]", windows: [{ id: "wnd[0]", title: "Z", controls }] };
    expect(resolveStrict(screen, "ZHDR-TYPE")).toEqual({ control: controls[1] as Control });
    expect(resolveStrict(screen, "ctxtZNONE")).toEqual({ none: true });
  });
});

describe("sapgui full view: what scrolling adds", () => {
  test("a classic list that scrolls gets a line of its own, before its cells", () => {
    expect(controlLines({ id: "wnd[0]/usr", type: "GuiUserArea", name: "usr", scroll: { position: 34, maximum: 167, pageSize: 34 } })).toEqual(["wnd[0]/usr  list  201 rows (visible 34, first 34; scroll for the others)"]);
    expect(controlLines({ id: "wnd[0]/usr", type: "GuiUserArea", name: "usr" })).toEqual([]);
  });
  test("a table control says where it is scrolled to, only when it is", () => {
    const t: Control = { id: "wnd[0]/usr/tblT", type: "GuiTableControl", name: "T", rowCount: 60, visibleRowCount: 13, columns: ["A"] };
    expect(controlLines(t)).toEqual(["wnd[0]/usr/tblT  table  rows 60 (visible 13); columns: A"]);
    expect(controlLines({ ...t, firstRow: 26 })).toEqual(["wnd[0]/usr/tblT  table  rows 60 (visible 13, first 26); columns: A"]);
  });
});
