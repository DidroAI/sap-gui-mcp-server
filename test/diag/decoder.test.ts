import { describe, expect, test } from "bun:test";
import { DiagDecoder } from "../../src/diag/decoder.js";
import type { DiagScreen } from "../../src/diag/screen.js";
import { appl, areaSize, atom_, atoms, container, containerName, EOM, keys, listCell, listHead, menus, message, Queue, queueAnswer, r3info, RESET, rfcCall, rfcItem, screenHead, scroll2, ses, tabButtons, tableControl, tabstripHeader, title } from "./build.js";

/** A decoder fed with server messages (or [direction, bytes] pairs); the screens it gave. */
function run(...frames: (Buffer | [0 | 1, Buffer])[]): { decoder: DiagDecoder; screens: DiagScreen[]; modes: number[] } {
  const decoder = new DiagDecoder();
  const screens: DiagScreen[] = [];
  const modes: number[] = [];
  decoder.onScreen = (s, mode) => {
    screens.push(s);
    modes.push(mode);
  };
  for (const f of frames) Array.isArray(f) ? decoder.push(f[0], f[1]) : decoder.push(1, f);
  return { decoder, screens, modes };
}

/** A header screen: fields in a subscreen, a nested subscreen, a tab strip with a page. */
const ORDER = [
  ...screenHead(),
  menus(1, [
    [[1], "Order"],
    [[2], "Edit"],
  ]),
  menus(2, [
    [[1, 1], "Create"],
    [[1, 2], "Display", 0x00],
    [[2, 1], "More", 0x06],
    [[2, 1, 1], "Deep"],
  ]),
  keys(3, [[8, "@14@ Copy", "Copy the order"]]),
  keys(4, [
    [3, "Back"],
    [15, "Exit"],
    [8, "Copy"],
  ]),
  RESET,
  container(3, 0, 0, 100, 4),
  containerName("HEADER", "ZPROG", "0110"),
  atoms(
    atom_.field(0, 0, "Order", { output: true, width: 16 }),
    atom_.name(0, 0, "ZHDR-TXT"),
    atom_.field(0, 17, "4711", { width: 10, readOnly: true, valueHelp: true }),
    atom_.name(0, 17, "ZHDR-ID"),
    atom_.tooltip(0, 17, "Order number"),
    atom_.label(0, 40, "Net value"),
    atom_.field(0, 56, "       1.250,00", { readOnly: true }),
    atom_.name(0, 56, "ZHDR-NETWR"),
    atom_.field(0, 78, "EUR", { readOnly: true }),
    atom_.name(0, 78, "ZHDR-WAERK"),
  ),
  RESET,
  container(3, 0, 0, 100, 4),
  containerName("HEADER", "ZPROG", "0110"),
  container(3, 1, 2, 80, 2),
  containerName("PARTNER", "ZPROG", "0120"),
  atoms(atom_.label(0, 0, "Customer"), atom_.field(0, 17, "", { width: 10 }), atom_.name(0, 17, "ZHDR-KUNNR"), atom_.button(0, 60, "@0Y\\QCreate customer@", "NEWC"), atom_.name(0, 60, "BT_NEWC"), atom_.check(1, 0, "Complete", true, true), atom_.name(1, 0, "ZHDR-DONE")),
  RESET,
  container(8, 5, 0, 100, 12),
  containerName("TABS", "ZPROG", "0100"),
  tabstripHeader("TABS", "T\\02", 2),
  tabButtons(atom_.tab(0, "Sales", "T\\01"), atom_.name(0, 0, "TABS-TAB01"), atom_.tab(1, "Items", "T\\02"), atom_.name(0, 1, "TABS-TAB02")),
  RESET,
  container(8, 5, 0, 100, 12),
  containerName("TABS", "ZPROG", "0100"),
  container(9, 2, 1, 98, 9),
  scroll2(11, 98, 0, 0, 9, 98),
  containerName("BODY", "ZPROG", "0130"),
  atoms(atom_.frame(0, 0, 5, 60, "Shipping"), atom_.label(1, 1, "Block"), atom_.dropdown(1, 17, "07"), atom_.name(1, 17, "ZHDR-LIFSK"), atom_.field(2, 17, "?", { width: 4 }), atom_.name(2, 17, "ZHDR-TYPE"), atom_.field(3, 17, "secret", { hidden: true }), atom_.name(3, 17, "ZHDR-PWD"), atom_.label(10, 1, "Far down"), atom_.unknown(4, 1, "odd")),
  appl(0x09, 0x0b, [1, 0, 1, 0, 19, 0, 0, 0, 0, 0]),
  EOM,
];

describe("DiagDecoder: a classic screen", () => {
  const { screens, decoder } = run(message(ORDER, { compress: true }));
  const s = screens[0] as DiagScreen;
  const w = s.windows[0];
  const el = (name: string) => w?.elements.find((e) => e.name === name);

  test("one screen for the step, with the session", () => {
    expect(screens.length).toBe(1);
    expect(s.mode).toBe(0);
    expect(s.step).toBe(1);
    expect(s.session).toMatchObject({ system: "XYZ", client: "100", user: "TESTER", tcode: "ZT01", host: "synthhost" });
    expect(w).toMatchObject({ index: 0, modal: false, title: "Synthetic Order: Overview", program: "ZPROG", dynpro: "0100", size: { rows: 20, cols: 100 } });
    expect(decoder.screen()).toBe(s);
  });

  test("fields with their SAP names, values, state and tooltip", () => {
    expect(el("ZHDR-ID")).toMatchObject({ kind: "field", text: "4711", input: false, valueHelp: true, tooltip: "Order number", width: 10 });
    expect(el("ZHDR-NETWR")?.text).toBe("1.250,00");
    expect(el("ZHDR-KUNNR")).toMatchObject({ kind: "field", text: "", input: true });
    expect(el("ZHDR-TYPE")).toMatchObject({ text: "", input: true, required: true });
    expect(el("ZHDR-LIFSK")).toMatchObject({ kind: "dropdown", key: "07", valueList: "0123456789ABCDEF0123456789ABCDEF" });
    expect(el("ZHDR-DONE")).toMatchObject({ kind: "checkbox", text: "Complete", checked: true, input: false });
    expect(el("BT_NEWC")).toMatchObject({ kind: "button", fcode: "NEWC", tooltip: "Create customer", icon: "0Y", text: "" });
  });

  test("a hidden field never gives its content", () => {
    expect(el("ZHDR-PWD")).toMatchObject({ hidden: true, text: "" });
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  test("positions are absolute: container origins are added along the chain", () => {
    expect([el("ZHDR-ID")?.row, el("ZHDR-ID")?.col]).toEqual([0, 17]);
    // PARTNER (row 1, col 2) inside HEADER (row 0).
    expect([el("ZHDR-KUNNR")?.row, el("ZHDR-KUNNR")?.col]).toEqual([1, 19]);
    expect([el("ZHDR-DONE")?.row, el("ZHDR-DONE")?.col]).toEqual([2, 2]);
    // Tab strip at row 5, its page at row 2, col 1 inside it.
    expect([el("ZHDR-LIFSK")?.row, el("ZHDR-LIFSK")?.col]).toEqual([8, 18]);
    expect(el("ZHDR-KUNNR")?.path).toEqual(["HEADER:ZPROG:0110", "PARTNER:ZPROG:0120"]);
    expect(el("ZHDR-LIFSK")?.path).toEqual(["TABS", "BODY"]);
  });

  test("what lies below the visible part of a tab page is marked", () => {
    const far = w?.elements.find((e) => e.text === "Far down");
    expect(far).toMatchObject({ row: 17, scrolledOut: true });
    expect(el("ZHDR-LIFSK")?.scrolledOut).toBeUndefined();
  });

  test("labels: the label to the left on the row, an output text at the start of a row", () => {
    expect(el("ZHDR-ID")?.label).toBe("Order");
    expect(el("ZHDR-NETWR")?.label).toBe("Net value");
    expect(el("ZHDR-WAERK")?.label).toBe("Net value");
    expect(el("ZHDR-KUNNR")?.label).toBe("Customer");
    expect(el("ZHDR-LIFSK")?.label).toBe("Block");
    expect(el("ZHDR-TYPE")?.label).toBeUndefined();
  });

  test("tabs with the open one, function codes and place", () => {
    const strip = w?.tabstrips[0];
    expect(strip).toMatchObject({ name: "TABS", row: 5, col: 0, width: 100, height: 12 });
    expect(strip?.tabs.map((t) => [t.text, t.id, t.fcode, t.active, t.name, t.index])).toEqual([
      ["Sales", "T\\01", "T\\01", false, "TABS-TAB01", 0],
      ["Items", "T\\02", "T\\02", true, "TABS-TAB02", 1],
    ]);
  });

  test("menus as a tree, toolbar and function keys", () => {
    expect(w?.menus.map((m) => m.text)).toEqual(["Order", "Edit"]);
    expect(w?.menus[0]?.children.map((m) => [m.text, m.enabled, m.path])).toEqual([
      ["Create", true, [1, 1]],
      ["Display", false, [1, 2]],
    ]);
    expect(w?.menus[1]?.children[0]?.children[0]).toMatchObject({ text: "Deep", path: [2, 1, 1] });
    expect(w?.toolbar).toEqual([{ vkey: 8, key: "F8", text: "Copy", tooltip: "Copy the order", icon: "14", enabled: true }]);
    expect(w?.keys.map((k) => `${k.text}=${k.key}`)).toEqual(["Back=F3", "Exit=Shift+F3", "Copy=F8"]);
  });

  test("the cursor, and what was not understood", () => {
    expect(w?.focus).toEqual({ row: 1, col: 19, name: "ZHDR-KUNNR" });
    expect(decoder.notes.get("element type 99")).toBe(1);
    expect(w?.elements.find((e) => e.etype === 99)?.text).toBe("odd");
  });
});

describe("DiagDecoder: steps and modes", () => {
  const first = message([...screenHead({ title: "First" }), EOM]);

  test("bytes may come in any chunks", () => {
    const stream = Buffer.concat([message(ORDER, { compress: true, padding: 2 }), first]);
    const decoder = new DiagDecoder();
    let count = 0;
    decoder.onScreen = () => count++;
    for (const b of stream) decoder.push(1, Buffer.from([b]));
    expect(count).toBe(2);
    expect(decoder.screen()?.windows[0]?.title).toBe("First");
    expect(decoder.screen()?.step).toBe(2);
  });

  test("a message that says more follows does not end the step", () => {
    const { screens } = run(message([...screenHead({ title: "Not yet" })], { info: 2 }));
    expect(screens.length).toBe(0);
  });

  test("a call to SAP GUI that wants an answer does not end the step; the screen comes after", () => {
    const call = rfcItem(0, rfcCall("Z_ASK_GUI", { WHAT: "x" }));
    const { screens, decoder } = run(message([...screenHead({ title: "Asked" }), call, EOM]), [0, message([rfcItem(1, rfcCall("")), EOM], { info: 0 })], message([EOM]));
    expect(screens.length).toBe(1);
    expect(screens[0]?.windows[0]?.title).toBe("Asked");
    expect(decoder.notes.get("RFC call Z_ASK_GUI")).toBe(1);
  });

  test("a large screen arrives inside an RFC call, in fragments, and ends with an empty message", () => {
    const inner = Buffer.concat([...screenHead({ title: "Large", program: "ZBIG", dynpro: "0200" }), RESET, atoms(atom_.label(3, 1, "Inside"))]);
    const blob = rfcCall("GUICORE_BLOB_DIAG_PARSER", { STREAM: inner });
    const cut = Math.floor(blob.length / 2);
    const { screens } = run(message([r3info(0x02, "XYZ"), rfcItem(4, blob.subarray(0, cut)), EOM], { compress: true }), [0, message([rfcItem(4, Buffer.alloc(0)), EOM], { info: 0 })], message([rfcItem(6, blob.subarray(cut)), EOM], { info: 2, compress: true }), message([], { info: 1 }));
    expect(screens.length).toBe(1);
    expect(screens[0]?.windows[0]).toMatchObject({ title: "Large", program: "ZBIG", dynpro: "0200" });
    expect(screens[0]?.windows[0]?.elements[0]).toMatchObject({ kind: "label", text: "Inside", row: 3, col: 1 });
  });

  test("each mode of the connection has its own screen", () => {
    const { decoder, modes } = run(message([...screenHead({ title: "Mode zero" }), EOM]), message([...screenHead({ title: "Mode one", tcode: "ZT02" }), EOM], { mode: 1 }), message([...screenHead({ title: "Mode zero again" }), EOM]));
    expect(modes).toEqual([0, 1, 0]);
    expect([...decoder.screens().keys()].sort()).toEqual([0, 1]);
    expect(decoder.screens().get(1)).toMatchObject({ mode: 1, step: 1, session: { tcode: "ZT02" } });
    expect(decoder.screens().get(0)?.windows[0]?.title).toBe("Mode zero again");
    expect(decoder.screen(1)?.windows[0]?.title).toBe("Mode one");
    expect(decoder.screen()?.mode).toBe(0);
  });

  test("the status bar belongs to its step; the command the user sent is kept", () => {
    const withMessage = message([...screenHead(), r3info(0x0b, "E: Enter a customer"), appl(0x0c, 0x03, ["E", "ZMSG".padEnd(20), "042", " "].join("\0")), EOM]);
    const { screens } = run(withMessage, [0, message([appl(0x0c, 0x04, "/nZT02"), EOM], { info: 0, dp: true })], message([...screenHead({ title: "Next" }), EOM]));
    expect(screens[0]?.message).toEqual({ type: "E", text: "Enter a customer", id: "ZMSG", number: "042" });
    expect(screens[1]?.message).toBeUndefined();
    expect(screens[1]?.lastCommand).toBe("/nZT02");
  });

  test("menus and keys stay when the server sends the window again without them", () => {
    const { screens } = run(message([...screenHead(), menus(1, [[[1], "Order"]]), keys(4, [[3, "Back"]]), EOM]), message([...screenHead({ title: "Again" }), EOM]));
    expect(screens[1]?.windows[0]?.title).toBe("Again");
    expect(screens[1]?.windows[0]?.menus.map((m) => m.text)).toEqual(["Order"]);
    expect(screens[1]?.windows[0]?.keys.map((k) => k.text)).toEqual(["Back"]);
  });

  test("garbage, unknown items and broken pieces never throw", () => {
    const decoder = new DiagDecoder();
    const junk = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 31 + 7) & 0xff));
    const framed = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, (b.length >> 8) & 0xff, b.length & 0xff]), b]);
    expect(() => {
      decoder.push(1, framed(junk));
      decoder.push(0, framed(junk));
      decoder.push(1, framed(Buffer.from([0, 0, 0, 0, 0, 1, 0, 1, 9, 9, 9])));
      decoder.push(1, message([appl(0x33, 0x44, "what"), appl(0x09, 0x02, Buffer.from([0, 5, 1, 2, 3]), true), appl(0x09, 0x0e, Buffer.alloc(8), true), appl(0x09, 0x08, "a\0b\0", true), rfcItem(0, Buffer.from("not an rfc call")), rfcItem(9, Buffer.alloc(3))]));
      decoder.push(1, message([...screenHead({ title: "Still alive" }), EOM]));
    }).not.toThrow();
    expect(decoder.screen()?.windows[0]?.title).toBe("Still alive");
    expect(decoder.notes.get("item 10/33/44")).toBe(1);
    expect(decoder.notes.size).toBeGreaterThan(2);
  });
});

describe("DiagDecoder: popup, list, table control", () => {
  test("a modal popup with a list over the main window", () => {
    const popup = [
      ses({ index: 1, row: 3, col: 24, rows: 12, cols: 34 }),
      areaSize(12, 34),
      r3info(0x0d, "ZPOPUP".padEnd(40)),
      r3info(0x0e, "0120"),
      keys(4, [[12, "Cancel"]]),
      title("Order Type (4 Entries)"),
      r3info(0x0b, "I: Choose one"),
      ...listHead(5),
      ...listCell(0, 0, "0444944442", true),
      ...listCell(1, 1, "@\\QOrder type@Type"),
      ...listCell(1, 6, "Description"),
      ...listCell(2, 0, "64444:44447", true),
      ...listCell(3, 1, "AA"),
      ...listCell(3, 6, "Standard order"),
      ...listCell(4, 1, "7"),
      ...listCell(4, 6, "Seven"),
      EOM,
    ];
    const { screens } = run(message([...screenHead(), RESET, atoms(atom_.label(2, 1, "Order Type")), ...popup], { compress: true }), message([...screenHead({ title: "Closed" }), EOM]));
    const s = screens[0] as DiagScreen;
    expect(s.windows.length).toBe(2);
    expect(s.windows[0]?.elements[0]?.text).toBe("Order Type");
    const p = s.windows[1];
    expect(p).toMatchObject({ index: 1, modal: true, title: "Order Type (4 Entries)", program: "ZPOPUP", dynpro: "0120", position: { row: 3, col: 24 }, size: { rows: 12, cols: 34 } });
    expect(s.message).toMatchObject({ type: "I", text: "Choose one" });
    expect(p?.list?.totalRows).toBe(5);
    expect(p?.list?.rows.map((r) => [r.row, ...r.cells.map((c) => `${c.col}:${c.text}`)])).toEqual([
      [1, "1:Type", "6:Description"],
      [3, "1:AA", "6:Standard order"],
      [4, "1:7", "6:Seven"],
    ]);
    expect(p?.list?.rows[0]?.cells[0]?.tooltip).toBe("Order type");
    // The main window sent again closes the popup.
    expect(screens[1]?.windows.length).toBe(1);
  });

  test("a table control: columns in display order, rows, cells by type", () => {
    const table = tableControl({
      program: "ZPROG",
      name: "TC_ITEMS",
      title: "All items",
      order: [1, 3, 2, 4, 5],
      columns: [
        { name: "ZITM-POSNR", title: "Item", width: 6 },
        { name: "ZITM-MATNR", title: "Material", width: 18 },
        { name: "ZITM-DONE", title: "@\\QDone already@D", width: 1, etype: 124 },
        { name: "ZITM-UNIT", title: "Un", width: 3, etype: 126 },
        { name: "ZITM-TEXT", title: "Description", width: 20, etype: 131 },
      ],
      rows: [{ values: ["    10", "WIDGET-1", "X", "PC", "A widget"], readOnly: true }, { values: ["    20", "WIDGET-2", " ", "", ""] }, { values: ["______", "__________________", " ", "__", "____________________"], hidden: true }],
      total: 7,
    });
    const { screens } = run(message([...screenHead(), RESET, container(3, 4, 2, 90, 8), containerName("ITEMS", "ZPROG", "0140"), container(5, 1, 0, 90, 6), containerName("TC_ITEMS", "ZPROG", "0140"), ...table, EOM], { compress: true }));
    const t = screens[0]?.windows[0]?.tables[0];
    expect(t).toMatchObject({ name: "TC_ITEMS", program: "ZPROG", title: "All items", row: 5, col: 2, width: 90, height: 6, totalRows: 7, visibleRows: 3, path: ["ITEMS:ZPROG:0140"] });
    expect(t?.columns.map((c) => [c.name, c.title, c.position, c.width])).toEqual([
      ["ZITM-POSNR", "Item", 0, 6],
      ["ZITM-MATNR", "Material", 2, 18],
      ["ZITM-DONE", "D", 1, 1],
      ["ZITM-UNIT", "Un", 3, 3],
      ["ZITM-TEXT", "Description", 4, 20],
    ]);
    expect(t?.columns[2]?.tooltip).toBe("Done already");
    // Columns start after the row selector, one cell apart, in display order.
    expect(t?.columns.map((c) => c.col)).toEqual([4, 13, 11, 32, 36]);
    expect(t?.columns.every((c) => c.visible)).toBe(true);
    expect(t?.rows.map((r) => [r.index, r.row, r.empty])).toEqual([
      [0, 6, false],
      [1, 7, false],
      [2, 8, true],
    ]);
    expect(t?.rows[0]?.cells.map((c) => [c.kind, c.text, c.input, c.checked])).toEqual([
      ["field", "10", false, undefined],
      ["field", "WIDGET-1", false, undefined],
      ["checkbox", "", false, true],
      ["dropdown", "PC", false, undefined],
      ["field", "A widget", false, undefined],
    ]);
    expect(t?.rows[1]?.cells.map((c) => c.input)).toEqual([true, true, true, true, false]);
    expect(t?.rows[2]?.cells.every((c) => c.hidden && c.text === "")).toBe(true);
  });
});

describe("DiagDecoder: controls", () => {
  const custom = (name: string, row: number) => [RESET, container(10, row, 1, 80, 10), containerName(name, "ZPROG", "0100")];

  /** A grid in container GRID1: field catalog and cells from the data provider. */
  function gridQueue(): Queue {
    const q = new Queue();
    const gui = q.object("2-");
    const box = q.verb(gui, "CreateControl", "C", [115, "SAPGUI.CONTAINERCTRL.1", 0, 10], true);
    q.verb(gui, "LinkContainer", "C", [115, "GRID1"]);
    const grid = q.verb(gui, "CreateControl", "C", [116, "SAPGUI.GridViewCtrl.1", 0, 115], true);
    q.verb(grid, "DeleteAllCells", "C");
    const catalog = Array.from({ length: 17 }, (_, i) => ({ name: String(i + 1), length: i === 0 ? 30 : [3, 8, 14, 15, 16].includes(i) ? 40 : 4, type: [0, 3, 8, 14, 15, 16].includes(i) ? ("C" as const) : ("I" as const) }));
    const column = (name: string, position: number, long: string, medium: string, short: string, width: number) => [name, 0, position, long, width, 0, 0, 0, long, 0, 0, 0, 0, 0, medium, short, medium];
    q.table("SAPR3://CATALOG", catalog, [column("QTY", 2, "Order Quantity", "Order Qty", "Qty", 10), column("DOC", 1, "Sales Document", "Sales Doc.", "Doc", 10)]);
    const provider = q.object("2-");
    const data = q.verb(provider, "SetDataFromUrl", "C", ["APPLICATION", "X-R3TABLE", "SAPR3://CATALOG"], true);
    q.verb(gui, "AssignProperty2", "C", [{ at: data }, "r3TableAutoObj", { at: grid }, "InfoTable"]);
    const cellFields = Array.from({ length: 13 }, (_, i) => ({ name: String(i + 1), length: i === 3 ? 40 : 4, type: i === 3 ? ("C" as const) : ("I" as const) }));
    const cell = (col: number, row: number, text: string) => [col, row, 0, text];
    q.table("SAPR3://CELLS", cellFields, [cell(-1, 1, "0000000001"), cell(1, 1, "4711"), cell(2, 1, "           5"), cell(-1, 2, "0000000002"), cell(1, 2, "4712"), cell(2, 2, "          12")]);
    const dp = q.verb(q.object("2-"), "CreateObject", "C", ["SAP.DataPOnDemand.1"], true);
    q.verb(dp, "Handle", "S", [3]);
    q.verb(dp, "LineCount", "S", [6]);
    q.verb(provider, "SetDataFromUrl", "C", ["APPLICATION", "X-R3TABLE", "SAPR3://CELLS"]);
    q.verb(dp, "InsertPacket", "C", [1, { at: data }]);
    q.verb(gui, "AssignDataObjToShell", "C", [3, 116]);
    q.verb(gui, "AssignProperty2", "C", [{ at: dp }, "", { at: grid }, "DataTableOnDemand"]);
    const ids = q.verb(q.object("2-"), "CreateObject", "C", ["SAP.DataPOnDemand.1"], true);
    q.verb(ids, "Handle", "S", [5]);
    q.verb(ids, "LineCount", "S", [40]);
    q.verb(gui, "AssignDataObjToShell", "C", [5, 116]);
    q.verb(gui, "AssignProperty2", "C", [{ at: ids }, "", { at: grid }, "RowIDNumericOnDemand"]);
    void box;
    return q;
  }

  test("an ALV grid: columns by position with their header texts, rows, total row count", () => {
    const { screens } = run(message([rfcItem(0, gridQueue().build()), EOM], { compress: true }), [0, message([rfcItem(1, queueAnswer({ 1: "10", 3: "11" })), EOM], { info: 0 })], message([...screenHead(), ...custom("GRID1", 2), EOM]));
    expect(screens.length).toBe(1);
    const controls = screens[0]?.windows[0]?.controls ?? [];
    const grid = controls.find((c) => c.kind === "grid");
    expect(grid).toMatchObject({ id: 116, type: "SAPGUI.GridViewCtrl.1", parent: 115, container: "GRID1", area: { row: 2, col: 1, width: 80, height: 10 } });
    expect(grid?.grid?.columns.map((c) => [c.name, c.title, c.titles])).toEqual([
      ["DOC", "Sales Document", ["Sales Document", "Sales Doc.", "Doc"]],
      ["QTY", "Order Quantity", ["Order Quantity", "Order Qty", "Qty"]],
    ]);
    expect(grid?.grid?.rows).toEqual([
      { index: 0, cells: ["4711", "5"] },
      { index: 1, cells: ["4712", "12"] },
    ]);
    expect(grid?.grid?.totalRows).toBe(40);
  });

  /** A tree and a text editor in the two halves of a splitter in container SPLIT. */
  function treeQueue(): Queue {
    const q = new Queue();
    const gui = q.object("2-");
    q.verb(gui, "CreateControl", "C", [101, "SAPGUI.CONTAINERCTRL.1", 0, 10], true);
    q.verb(gui, "LinkContainer", "C", [101, "SPLIT"]);
    const splitter = q.verb(gui, "CreateControl", "C", [102, "SAPGUI.SplitterCtrl.1", 0, 101], true);
    const left = q.verb(splitter, "GetContainer", "C", [1, 1], true);
    q.verb(gui, "CreateControl2", "C", [103, "SAPGUI.CONTAINERCTRL.1", 0, { at: left }], true);
    const tree = q.verb(gui, "CreateControl", "C", [105, "SAP.TableTreeControl.1", 0, 103], true);
    const headers = q.verb(tree, "Headers", "G", [], true);
    q.verb(headers, "Heading", "S", ["Text type"]);
    q.verb(headers, "Heading", "S", ["Lang."]);
    const nodeFields = [
      { name: "NODE_KEY", length: 12, type: "C" as const },
      { name: "RELATKEY", length: 12, type: "C" as const },
      { name: "RELATSHIP", length: 4, type: "I" as const },
      { name: "HIDDEN", length: 1, type: "C" as const },
      { name: "DISABLED", length: 1, type: "C" as const },
      { name: "ISFOLDER", length: 1, type: "C" as const },
    ];
    const itemFields = [
      { name: "NODE_KEY", length: 12, type: "C" as const },
      { name: "ITEM_NAME", length: 12, type: "C" as const },
      { name: "TEXT", length: 60, type: "C" as const },
    ];
    q.table("SAPR3://NODES", nodeFields, [
      ["Root", "", 0, "", "", "X"],
      ["N1", "Root", 6, "", "", "X"],
      ["N2", "Root", 6, "", "", ""],
      ["N11", "N1", 6, "", "", ""],
      ["Favo", "Root", 3, "", "", "X"],
      ["F1", "Favo", 6, "", "", ""],
      ["Gone", "Root", 6, "X", "", ""],
    ]);
    const provider = q.object("2-");
    q.verb(provider, "SetDataFromUrl", "C", ["APPLICATION", "X-R3TABLE", "SAPR3://NODES"]);
    q.verb(tree, "AddR3Table", "C", [{ at: q.object("") }]);
    q.table("SAPR3://ITEMS", itemFields, [
      ["Root", "1", "Menu"],
      ["N1", "1", "Folder one"],
      ["N2", "1", "Leaf two"],
      ["N2", "2", "EN"],
      ["N11", "1", "Leaf in folder one"],
      ["Favo", "1", "Favorites"],
      ["F1", "1", "A favorite"],
      ["Gone", "1", "Not shown"],
    ]);
    q.verb(provider, "SetDataFromUrl", "C", ["APPLICATION", "X-R3TABLE", "SAPR3://ITEMS"]);
    q.verb(tree, "AddItemTable", "C", [{ at: q.object("") }]);
    q.verb(tree, "ABAPExpandNodes", "C", ["Root", 0]);
    q.verb(tree, "ABAPSelNodeKey", "S", ["N2"]);
    const right = q.verb(splitter, "GetContainer", "C", [1, 2], true);
    q.verb(gui, "CreateControl2", "C", [104, "SAPGUI.CONTAINERCTRL.1", 0, { at: right }], true);
    const editor = q.verb(gui, "CreateControl", "C", [120, "SAPGUI.TextEditCtrl.1", 0, 104], true);
    q.verb(editor, "ReadOnly", "S", [0]);
    q.verb(editor, "TextStream", "S", ["First text"]);
    return q;
  }

  const TREE_ANSWER = queueAnswer({ 1: "10", 3: "11", 5: "12", 6: "13", 17: "14", 18: "15" });

  test("a tree: nodes in display order with depth, folders, expansion, item texts and headers", () => {
    const { screens } = run(message([rfcItem(0, treeQueue().build()), EOM]), [0, message([rfcItem(1, TREE_ANSWER), EOM], { info: 0 })], message([...screenHead(), ...custom("SPLIT", 3), EOM]));
    const tree = screens[0]?.windows[0]?.controls.find((c) => c.kind === "tree");
    expect(tree).toMatchObject({ id: 105, container: "SPLIT", area: { row: 3, col: 1 } });
    expect(tree?.tree?.headers).toEqual(["Text type", "Lang."]);
    expect(tree?.tree?.selected).toBe("N2");
    expect(tree?.tree?.nodes.map((n) => [n.key, n.depth, n.text, n.folder, n.expanded, n.hidden])).toEqual([
      ["Favo", 0, "Favorites", true, false, false],
      ["F1", 1, "A favorite", false, false, false],
      ["Root", 0, "Menu", true, true, false],
      ["N1", 1, "Folder one", true, false, false],
      ["N11", 2, "Leaf in folder one", false, false, false],
      ["N2", 1, "Leaf two", false, false, false],
      ["Gone", 1, "Not shown", false, false, true],
    ]);
    expect(tree?.tree?.nodes.find((n) => n.key === "N2")?.items).toEqual({ "1": "Leaf two", "2": "EN" });
  });

  test("a text editor, and a later step that changes it through the handle SAP GUI gave", () => {
    const later = new Queue();
    const editor = later.object(15);
    later.verb(editor, "ReadOnly", "S", [1]);
    later.verb(editor, "TextStream", "S", ["Second text"]);
    const screen = message([...screenHead(), ...custom("SPLIT", 3), EOM]);
    const { screens } = run(message([rfcItem(0, treeQueue().build()), EOM]), [0, message([rfcItem(1, TREE_ANSWER), EOM], { info: 0 })], screen, [0, message([EOM], { info: 0 })], message([rfcItem(0, later.build()), EOM]), [0, message([rfcItem(1, queueAnswer({})), EOM], { info: 0 })], screen);
    expect(screens.length).toBe(2);
    expect(screens[0]?.windows[0]?.controls.find((c) => c.kind === "text")).toMatchObject({ id: 120, text: "First text", readOnly: false, container: "SPLIT" });
    expect(screens[1]?.windows[0]?.controls.find((c) => c.kind === "text")).toMatchObject({ id: 120, text: "Second text", readOnly: true });
    // The tree is still there: controls persist across steps.
    expect(screens[1]?.windows[0]?.controls.find((c) => c.kind === "tree")?.tree?.nodes.length).toBe(7);
  });

  /** The control-based value help: a control of its own class tied to an empty popup dynpro. */
  function valueHelp(handle: string | number): Buffer[] {
    const make = new Queue();
    const gui = make.object("2-");
    make.verb(gui, "CreateControl", "C", [115, "SAP.TABControl.1", 0, 11], true);
    const fill = new Queue();
    fill.verb(fill.object(7), "LinkControl", "C", [115, "ZHELP", 100]);
    const help = fill.object(handle);
    fill.verb(help, "createTab", "C", ["Order Type (1)", 1]);
    const provider = fill.object("2-");
    fill.table(
      "SAPR3://COLS",
      [
        { name: "FIELDNAME", length: 30, type: "C" },
        { name: "SCRTEXT", length: 40, type: "C" },
      ],
      [
        ["F0001", "Type"],
        ["F0002", "Description"],
      ],
    );
    fill.verb(provider, "SetDataFromUrl", "C", ["APPLICATION", "X-R3TABLE", "SAPR3://COLS"]);
    fill.verb(help, "setResultTableCols", "C", [{ at: fill.object("") }]);
    fill.table(
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
    fill.verb(provider, "SetDataFromUrl", "C", ["APPLICATION", "X-R3TABLE", "SAPR3://HITS"]);
    fill.verb(help, "createResultDialog", "C", [{ at: fill.object("") }, 0, "", 0]);
    return [make.build(), fill.build()];
  }
  const dummyPopup = [ses({ index: 1, row: 1, col: 1, rows: 5, cols: 5 }), areaSize(5, 5), r3info(0x0d, "ZHELP".padEnd(40)), r3info(0x0e, "0100"), title("MCX_DUMMY_POPUP"), EOM];
  const answer = (handles: Record<number, string>): [0, Buffer] => [0, message([rfcItem(1, queueAnswer(handles)), EOM], { info: 0 })];

  test("the control-based value help: a hit list tied to an empty popup dynpro, with its caption as the title", () => {
    const [make, fill] = valueHelp(8) as [Buffer, Buffer];
    const { screens } = run(message([...screenHead(), EOM]), [0, message([EOM], { info: 0 })], message([rfcItem(0, make), EOM]), answer({ 2: "8" }), message([rfcItem(0, fill), EOM]), answer({}), message([...screenHead(), ...dummyPopup]));
    const popup = screens[1]?.windows[1];
    expect(popup).toMatchObject({ index: 1, modal: true, title: "Order Type (1)", dynproTitle: "MCX_DUMMY_POPUP", program: "ZHELP", dynpro: "0100" });
    expect(popup?.controls).toEqual([
      {
        id: 115,
        kind: "grid",
        type: "SAP.TABControl.1",
        parent: 11,
        dynpro: { program: "ZHELP", number: 100 },
        title: "Order Type (1)",
        grid: {
          columns: [
            { name: "F0001", title: "Type", titles: ["Type"], tooltip: "", width: 0, position: 0 },
            { name: "F0002", title: "Description", titles: ["Description"], tooltip: "", width: 0, position: 1 },
          ],
          rows: [
            { index: 0, cells: ["AA", "Standard order"] },
            { index: 1, cells: ["AB", "Rush order"] },
            { index: 2, cells: ["AC", "Returns"] },
          ],
          totalRows: 3,
        },
      },
    ]);
    // The main window has no such control.
    expect(screens[1]?.windows[0]?.controls).toEqual([]);
  });

  test("the value help is found without SAP GUI's answer too (only the server's side was seen)", () => {
    const [make, fill] = valueHelp(8) as [Buffer, Buffer];
    const { screens } = run(message([rfcItem(0, make), EOM]), message([rfcItem(0, fill), EOM]), message([...screenHead(), ...dummyPopup]));
    expect(screens[0]?.windows[1]?.title).toBe("Order Type (1)");
    expect(screens[0]?.windows[1]?.controls[0]?.grid?.rows.length).toBe(3);
  });

  test("a closed value help is gone: the same popup dynpro later starts empty", () => {
    const [make, fill] = valueHelp(8) as [Buffer, Buffer];
    const user: [0, Buffer] = [0, message([EOM], { info: 0 })];
    const { screens, decoder } = run(message([rfcItem(0, make), EOM]), answer({ 2: "8" }), message([rfcItem(0, fill), EOM]), answer({}), message([...screenHead(), ...dummyPopup]), user, message([...screenHead({ title: "Closed" }), EOM]), user, message([...screenHead(), ...dummyPopup]));
    expect(screens.map((s) => s.windows.length)).toEqual([2, 1, 2]);
    expect(screens[0]?.windows[1]?.controls.length).toBe(1);
    expect(screens[1]?.windows[0]?.controls).toEqual([]);
    expect(screens[2]?.windows[1]).toMatchObject({ title: "MCX_DUMMY_POPUP", controls: [] });
    expect(decoder.screen()?.windows[1]?.dynproTitle).toBeUndefined();
  });

  test("a control whose container is not on the screen is not on the screen", () => {
    const { screens } = run(message([rfcItem(0, treeQueue().build()), EOM]), [0, message([rfcItem(1, TREE_ANSWER), EOM], { info: 0 })], message([...screenHead(), ...custom("OTHER", 3), EOM]));
    expect(screens[0]?.windows[0]?.controls).toEqual([]);
    expect(screens[0]?.windows[0]?.containers.map((c) => c.name)).toEqual(["OTHER"]);
  });
});

