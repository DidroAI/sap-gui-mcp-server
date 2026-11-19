import { describe, expect, test } from "bun:test";
import { DiagDecoder } from "../../src/diag/decoder.js";
import { diagView } from "../../src/diag/view.js";
import { elem, elementList, areaLevel, areaName, END, keys, listCell, listHead, menus, message, Queue, sessionInfo, RESET, rfcItem, screenHead, windowStart, areaSize, tabList, tableControl, tabstripHeader, title } from "./build.js";

function view(frames: Buffer[], options = {}): string[] {
  const decoder = new DiagDecoder();
  for (const f of frames) decoder.push(1, f);
  const screen = decoder.screen();
  if (!screen) throw new Error("no screen");
  return diagView(screen, options).split("\n");
}

const SCREEN = [
  ...screenHead(),
  menus(1, [
    [[1], "Order"],
    [[2], "Edit"],
  ]),
  keys(3, [[8, "@14@ Copy", "Copy the order"]]),
  keys(4, [
    [3, "Back"],
    [8, "Copy"],
  ]),
  RESET,
  areaLevel(3, 1, 0, 100, 4),
  areaName("HEADER", "ZPROG", "0110"),
  elementList(
    elem.field(0, 0, "Order", { output: true, width: 16 }),
    elem.name(0, 0, "ZHDR-TXT"),
    elem.field(0, 17, "4711", { width: 10, readOnly: true }),
    elem.name(0, 17, "ZHDR-ID"),
    elem.label(0, 40, "Net value"),
    elem.field(0, 56, "  1.250,00", { readOnly: true }),
    elem.name(0, 56, "ZHDR-NETWR"),
    elem.field(0, 78, "EUR", { readOnly: true }),
    elem.name(0, 78, "ZHDR-WAERK"),
    elem.label(1, 0, "Customer"),
    elem.field(1, 17, "", { width: 10 }),
    elem.name(1, 17, "ZHDR-KUNNR"),
    elem.field(1, 29, "", { output: true, width: 30 }),
    elem.name(1, 29, "ZHDR-NAME"),
    elem.button(1, 60, "@0Y\\QCreate customer@", "NEWC"),
    elem.frame(2, 0, 2, 60, "Shipping"),
    elem.check(3, 1, "Complete", true),
    elem.name(3, 1, "ZHDR-DONE"),
    elem.label(3, 20, "Block"),
    elem.dropdown(3, 30, "07"),
    elem.name(3, 30, "ZHDR-LIFSK"),
    elem.field(3, 40, "?", { width: 4 }),
    elem.name(3, 40, "ZHDR-TYPE"),
    elem.field(3, 50, "secret", { hidden: true }),
    elem.name(3, 50, "ZHDR-PWD"),
  ),
  RESET,
  areaLevel(8, 6, 0, 100, 12),
  areaName("TABS", "ZPROG", "0100"),
  tabstripHeader("TABS", "T\\02", 2),
  tabList(elem.tab(0, "Sales", "T\\01"), elem.tab(1, "Items", "T\\02")),
  RESET,
  areaLevel(8, 6, 0, 100, 12),
  areaName("TABS", "ZPROG", "0100"),
  areaLevel(9, 2, 1, 98, 9),
  areaName("BODY", "ZPROG", "0130"),
  areaLevel(5, 1, 0, 90, 6),
  areaName("TC_ITEMS", "ZPROG", "0130"),
  ...tableControl({
    program: "ZPROG",
    name: "TC_ITEMS",
    title: "All items",
    columns: [
      { name: "ZITM-POSNR", title: "Item", width: 6, etype: 131 },
      { name: "ZITM-MATNR", title: "Material", width: 18 },
      { name: "ZITM-DONE", title: "D", width: 1, etype: 124 },
      { name: "ZITM-TEXT1", title: "Text", width: 10, etype: 131 },
      { name: "ZITM-TEXT2", title: "Text", width: 10, etype: 131 },
    ],
    rows: [{ values: ["    10", "WIDGET-1", "X", "one", ""] }, { values: ["    20", "WIDGET-2", " ", "", "two"], readOnly: true }, { values: ["", "", " ", "", ""] }],
    total: 2,
  }),
  sessionInfo(0x0b, "S: Order 4711 saved"),
  END,
];

describe("diagView", () => {
  const lines = view([message(SCREEN, { compress: true })]);

  test("header, window, status, menus, keys and toolbar", () => {
    expect(lines.slice(0, 6)).toEqual(["TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100)  USER TESTER  MODE 0", "status  S: Order 4711 saved", 'WINDOW 0  "Synthetic Order: Overview"  area 20x100', "menu: Order | Edit", "keys: Back (F3)", "toolbar: Copy: Copy the order (F8)"]);
  });

  test("one line per screen row: labels, fields by SAP name and column, their state", () => {
    expect(lines).toContain('r1  ZHDR-TXT@0="Order"  ZHDR-ID@17="4711"  Net value  ZHDR-NETWR@56="1.250,00"  ZHDR-WAERK@78="EUR"');
    // An empty read-only field is left out; an empty input field is not.
    expect(lines).toContain("r2  Customer  ZHDR-KUNNR@17=[]  <Create customer>{NEWC}@60");
    expect(lines).toContain("r3  -- Shipping --");
    expect(lines).toContain("r4  [x] Complete ZHDR-DONE@1  Block  ZHDR-LIFSK@30=dropdown [07]  ZHDR-TYPE@40=[] (required)");
  });

  test("hidden content is not in the view", () => {
    expect(lines.join("\n")).not.toContain("secret");
    expect(lines.join("\n")).not.toContain("ZHDR-PWD");
  });

  test("tabs with the open one and their function codes", () => {
    expect(lines).toContain("r6  tabs TABS: Sales {T\\01} | Items (selected) {T\\02}");
  });

  test("a table control: columns with their SAP names, a line per row with what it holds", () => {
    const at = lines.findIndex((l) => l.startsWith("r9  table"));
    expect(lines.slice(at, at + 4)).toEqual([
      'r9  table TC_ITEMS "All items"  2 rows (2 with data on show), 5 columns: Item ZITM-POSNR | Material ZITM-MATNR | D ZITM-DONE | Text ZITM-TEXT1 | Text ZITM-TEXT2',
      "  row 0 r10: Item=10; Material=[WIDGET-1]; D=[x]; Text(ZITM-TEXT1)=one",
      "  row 1 r11: Item=20; Material=WIDGET-2; Text(ZITM-TEXT2)=two",
      "  (1 empty row below, from r12, open for input)",
    ]);
  });

  test("row sets are cut at maxRows, with what is left out; chrome can be left out", () => {
    const short = view([message(SCREEN)], { maxRows: 1, chrome: false });
    expect(short).toContain("  ... 1 more rows");
    expect(short.some((l) => l.startsWith("menu:") || l.startsWith("keys:") || l.startsWith("toolbar:"))).toBe(false);
  });

  test("a popup with a list: the window behind keeps its content, not its keys", () => {
    const cells = [...listCell(1, 1, "Type"), ...listCell(1, 6, "Description"), ...listCell(3, 1, "AA"), ...listCell(3, 6, "Standard order"), ...listCell(4, 1, "AB"), ...listCell(4, 6, "Rush order"), ...listCell(5, 2, "odd one")];
    const popup = [windowStart({ index: 1, row: 3, col: 24, rows: 12, cols: 34 }), areaSize(12, 34), sessionInfo(0x0d, "ZPOPUP".padEnd(40)), sessionInfo(0x0e, "0120"), keys(4, [[12, "Cancel"]]), title("Order Type (40 Entries)"), ...listHead(41), ...cells, END];
    const out = view([message([...screenHead(), menus(1, [[[1], "Order"]]), keys(4, [[3, "Back"]]), RESET, elementList(elem.label(2, 1, "Order Type"), elem.field(2, 20, "", { width: 4 }), elem.name(2, 20, "ZHDR-TYPE")), ...popup])]);
    expect(out.slice(1)).toEqual([
      'WINDOW 0  "Synthetic Order: Overview"  area 20x100',
      "menu: Order",
      "(behind the popup: its keys and toolbar are left out)",
      "r2  Order Type  ZHDR-TYPE@20=[]",
      'WINDOW 1 popup  "Order Type (40 Entries)"  ZPOPUP 0120  at r3 c24  area 12x34',
      "keys: Cancel (F12)",
      "list  41 rows, 4 on show; columns at c1 c6",
      "r1  Type | Description",
      "r3  AA | Standard order",
      "r4  AB | Rush order",
      "r5  odd one@2",
    ]);
  });

  test("a value help drawn by a control: the popup has its caption and its hits", () => {
    const q = new Queue();
    q.verb(q.object("2-"), "CreateControl", "C", [115, "SAP.TABControl.1", 0, 11], true);
    q.verb(q.object(7), "LinkControl", "C", [115, "ZHELP", 100]);
    const help = q.object(8);
    q.verb(help, "createTab", "C", ["Order Type (1)", 1]);
    q.table(
      "SAPR3://HITS",
      [
        { name: "F0001", length: 16, type: "C" },
        { name: "F0002", length: 80, type: "C" },
      ],
      [
        ["AA", "Standard order"],
        ["AB", "Rush order"],
        ["AC", "Returns"],
      ],
    );
    q.verb(q.object("2-"), "SetDataFromUrl", "C", ["A", "B", "SAPR3://HITS"]);
    q.verb(help, "createResultDialog", "C", [{ at: q.object("") }]);
    const popup = [windowStart({ index: 1, row: 1, col: 1, rows: 5, cols: 5 }), areaSize(5, 5), sessionInfo(0x0d, "ZHELP".padEnd(40)), sessionInfo(0x0e, "0100"), title("MCX_DUMMY_POPUP"), END];
    const out = view([message([rfcItem(6, q.build())], { info: 2 }), message([...screenHead(), ...popup])], { chrome: false, maxRows: 2 });
    expect(out.slice(2)).toEqual(['WINDOW 1 popup  "Order Type (1)"  ZHELP 0100  at r1 c1  area 5x5', "grid value-help (shell 115)  3 rows, 2 columns: F0001=F0001 | F0002=F0002", "  row 0: AA | Standard order", "  row 1: AB | Rush order", "  ... 1 more rows (all sent; a higher maxRows shows them)"]);
  });

  test("controls: a grid with its columns and rows, a tree with the nodes on show, a text editor", () => {
    const q = new Queue();
    const gui = q.object("2-");
    q.verb(gui, "CreateControl", "C", [101, "SAPGUI.CONTAINERCTRL.1", 0, 10], true);
    q.verb(gui, "LinkContainer", "C", [101, "BOX"]);
    const grid = q.verb(gui, "CreateControl", "C", [102, "SAPGUI.GridViewCtrl.1", 0, 101], true);
    const catalog = Array.from({ length: 17 }, (_, i) => ({ name: String(i + 1), length: [0, 3, 8, 14, 15, 16].includes(i) ? 30 : 4, type: [0, 3, 8, 14, 15, 16].includes(i) ? ("C" as const) : ("I" as const) }));
    q.table("SAPR3://CATALOG", catalog, [
      ["DOC", 0, 1, "Sales Document", 10, 0, 0, 0, "", 0, 0, 0, 0, 0, "Sales Doc.", "Doc", "Sales Doc."],
      ["QTY", 0, 2, "Quantity", 10, 0, 0, 0, "", 0, 0, 0, 0, 0, "Quantity", "Quantity", "Quantity"],
    ]);
    const data = q.verb(q.object("2-"), "SetDataFromUrl", "C", ["A", "B", "SAPR3://CATALOG"], true);
    q.verb(gui, "AssignProperty2", "C", [{ at: data }, "r3TableAutoObj", { at: grid }, "InfoTable"]);
    const cellFields = Array.from({ length: 13 }, (_, i) => ({ name: String(i + 1), length: i === 3 ? 40 : 4, type: i === 3 ? ("C" as const) : ("I" as const) }));
    q.table("SAPR3://CELLS", cellFields, [
      [1, 1, 0, "4711"],
      [2, 1, 0, "5"],
      [1, 2, 0, "4712"],
      [2, 2, 0, "12"],
    ]);
    const dp = q.verb(q.object("2-"), "CreateObject", "C", ["SAP.DataPOnDemand.1"], true);
    q.verb(dp, "Handle", "S", [1]);
    q.verb(q.object("2-"), "SetDataFromUrl", "C", ["A", "B", "SAPR3://CELLS"]);
    q.verb(dp, "InsertPacket", "C", [1, { at: data }]);
    q.verb(gui, "AssignDataObjToShell", "C", [1, 102]);
    q.verb(gui, "AssignProperty2", "C", [{ at: dp }, "", { at: grid }, "DataTableOnDemand"]);
    const ids = q.verb(q.object("2-"), "CreateObject", "C", ["SAP.DataPOnDemand.1"], true);
    q.verb(ids, "Handle", "S", [2]);
    q.verb(ids, "LineCount", "S", [30]);
    q.verb(gui, "AssignDataObjToShell", "C", [2, 102]);
    q.verb(gui, "AssignProperty2", "C", [{ at: ids }, "", { at: grid }, "RowIDNumericOnDemand"]);
    q.verb(gui, "CreateControl", "C", [103, "SAPGUI.CONTAINERCTRL.1", 0, 10], true);
    q.verb(gui, "LinkContainer", "C", [103, "SIDE"]);
    const tree = q.verb(gui, "CreateControl", "C", [104, "SAP.TableTreeControl.1", 0, 103], true);
    q.table(
      "SAPR3://NODES",
      [
        { name: "NODE_KEY", length: 12, type: "C" },
        { name: "RELATKEY", length: 12, type: "C" },
        { name: "RELATSHIP", length: 4, type: "I" },
        { name: "ISFOLDER", length: 1, type: "C" },
        { name: "TEXT", length: 30, type: "C" },
      ],
      [
        ["Root", "", 0, "X", "Menu"],
        ["N1", "Root", 6, "X", "Folder"],
        ["N11", "N1", 6, "", "Inside"],
        ["N2", "Root", 6, "", ""],
      ],
    );
    q.verb(q.object("2-"), "SetDataFromUrl", "C", ["A", "B", "SAPR3://NODES"]);
    q.verb(tree, "AddR3Table", "C", [{ at: q.object("") }]);
    q.verb(tree, "ABAPExpandNodes", "C", ["Root", 0]);
    q.verb(tree, "ABAPSelNodeKey", "S", ["N1"]);
    const editor = q.verb(gui, "CreateControl", "C", [105, "SAPGUI.TextEditCtrl.1", 0, 103], true);
    q.verb(editor, "ReadOnly", "S", [1]);
    q.verb(editor, "TextStream", "S", ['Deliver to "gate 1"']);
    const custom = (name: string, row: number) => [RESET, areaLevel(10, row, 1, 80, 5), areaName(name, "ZPROG", "0100")];
    const out = view([message([rfcItem(6, q.build())], { info: 2 }), message([...screenHead(), ...custom("BOX", 2), ...custom("SIDE", 8), END])], { chrome: false });
    expect(out.slice(2)).toEqual([
      "r2  grid BOX (shell 102)  30 rows, 2 columns: DOC=Sales Document / Sales Doc. / Doc | QTY=Quantity",
      "  row 0: 4711 | 5",
      "  row 1: 4712 | 12",
      "  ... 28 more rows (2 sent so far; the grid loads the others when scrolled)",
      "r8  tree SIDE (shell 104)  3 nodes on show",
      "  [-] Menu  {Root}",
      "    [+] Folder (selected)  {N1}",
      "    (no text)  {N2}",
      "  (1 more nodes in closed folders)",
      'r8  text-editor SIDE (shell 105) (read-only)  "Deliver to \\"gate 1\\""',
    ]);
  });
});
