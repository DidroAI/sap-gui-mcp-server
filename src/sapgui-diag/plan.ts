/**
 * Plans an action of the DIAG method: which keys and clicks the input host
 * sends, whether SAP GUI will send a request to SAP for it, and what to
 * check on the next screen from the traffic.
 *
 * Keyboard first, wherever SAP GUI has a key: function keys and the command
 * field for buttons and toolbar entries, Ctrl+Home and the arrow keys to
 * reach a grid cell or a tree node (exact, whatever the theme draws), Page
 * Down and Page Up to scroll a table control or a list. The mouse only
 * where there is no key: to put the focus into a grid or a tree, a field,
 * a table control's row selector, a dropdown. Points come from the cell the
 * traffic gives each element (geometry.ts).
 *
 * Planning is pure: a screen, an action and the window's geometry in, the
 * steps out. The driver (index.ts) sends them and waits for SAP's answer.
 */
import { ONE_LINE_NOTE, oneLine } from "../core/action.js";
import { ActionError, type Action } from "../core/types.js";
import type { DiagControl, DiagElement, DiagElementKind, DiagKey, DiagScreen, DiagTable, DiagTreeNode, DiagWindow } from "../diag/index.js";
import { vkeyNumber } from "../sapgui/keys.js";
import { type Cells, gridPitch, type Rect, treePitch } from "./geometry.js";

/** Windows virtual-key codes of the keys used here. */
export const VK = { ENTER: 0x0d, ESCAPE: 0x1b, SPACE: 0x20, PAGEUP: 0x21, PAGEDOWN: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, F2: 0x71, F4: 0x73 } as const;

/** One input for the host (ps/input-lib.ps1, op "act"). `settle`: milliseconds the host waits after it. */
export type Step = (
  | { do: "okcode"; value: string }
  /** A SAP virtual key: 0 Enter, 1-12 F1-F12, 13-24 Shift+, 25-36 Ctrl+, 37-48 Ctrl+Shift+, 80-83 the page keys. */
  | { do: "key"; key: number }
  /** A Windows key, `count` times. */
  | { do: "vk"; vk: number; ctrl?: boolean; shift?: boolean; alt?: boolean; count?: number }
  | { do: "click" | "dblclick" | "f4"; x: number; y: number }
  | { do: "set"; x: number; y: number; value: string }
  | { do: "type"; value: string }
  /** A Windows button by its accessible name or description, inside `within` (screen pixels): BM_CLICK, no mouse. */
  | { do: "press"; name: string; within?: Rect }
) & { settle?: number };

/**
 * Will SAP GUI send a request to SAP? "yes": wait for it, and say so when it
 * does not come. "maybe": the input can stay in SAP GUI (a cell, a node):
 * look for a request briefly. "no": typing, the cursor.
 */
export type Answer = "yes" | "maybe" | "no";

/** A tree node opened or closed by the keyboard, which SAP GUI did without asking SAP: the traffic does not show it. */
export interface TreeChange {
  shell: number;
  node: string;
  expanded: boolean;
}

export interface Plan {
  steps: Step[];
  /** What was done, for the answer. */
  note: string;
  answer: Answer;
  /** After SAP's answer (or none): a sentence about the result, from the screen the traffic now holds. */
  confirm?: (after: DiagScreen | undefined, answered: boolean) => string | undefined;
  /** For a change SAP gets only with the next step: a check on the next screen. */
  later?: (next: DiagScreen) => string | undefined;
  tree?: TreeChange;
  /** The name and tooltip of the toolbar button the plan presses, as found on the screen: judged again before it is pressed. */
  pressed?: string[];
}

/** What planning needs to know of the window: pixels of cells, and the Windows controls that SAP GUI draws grids and trees in. */
export interface Geometry {
  /** Screen pixel of a cell of a window of the screen. */
  at(window: DiagWindow, row: number, col: number, width?: number): [number, number];
  cells: Cells;
  /** SAP GUI's Windows controls on the window acted on (class SAPALVGrid, SAPTreeList, ...), screen pixels. */
  controls: { cls: string; rect: Rect }[];
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const lower = (s: string | undefined) => clean(s).toLowerCase();

/** The window actions go to: the topmost one. */
export function activeWindow(s: DiagScreen): DiagWindow {
  return s.windows[s.windows.length - 1] as DiagWindow;
}

// ---- what an id names ----

/** A control an action names by id: a grid, a tree, a table control, the list, a dropdown. */
export type Named =
  | { kind: "grid"; control: DiagControl; window: DiagWindow; id: string }
  | { kind: "tree"; control: DiagControl; window: DiagWindow; id: string }
  | { kind: "table"; table: DiagTable; window: DiagWindow; id: string }
  | { kind: "list"; window: DiagWindow; id: string }
  | { kind: "dropdown"; element: DiagElement; window: DiagWindow; id: string; cell?: { table: DiagTable; row: number } };

/** The id of a control in the view: its container, else "shell N"; the value help's hit list is "value-help". */
export function controlId(c: DiagControl): string {
  return c.container ?? (c.dynpro ? "value-help" : `shell ${c.id}`);
}

/**
 * The control an id names on the active window: a grid's or a tree's
 * container (or "shell N", or the shell number), "value-help", a table
 * control's name, "list", or a dropdown's field name (a table cell
 * "NAME[n]"). Case does not matter. Undefined when nothing matches.
 */
export function namedControl(s: DiagScreen, raw: string | undefined): Named | undefined {
  const w = activeWindow(s);
  const id = clean(raw);
  if (!id) return undefined;
  const want = id.toLowerCase().replace(/^shell\s+/, "");
  for (const c of w.controls) {
    if (!c.grid && !c.tree) continue;
    const names = [c.container, String(c.id), c.dynpro ? "value-help" : undefined].filter(Boolean).map((x) => lower(x));
    if (!names.includes(want)) continue;
    if (c.grid) return { kind: "grid", control: c, window: w, id: controlId(c) };
    return { kind: "tree", control: c, window: w, id: controlId(c) };
  }
  // Also as SAP GUI scripting names a table control: [wnd[1]/usr/]tbl<program><name>, e.g. tblSAPLMGMMTC_VIEW.
  const scripting = want.replace(/^.*\//, "").replace(/^tbl/, "");
  const t = w.tables.find((x) => lower(x.name) === want || scripting === lower(`${x.program || w.program}${x.name}`));
  if (t) return { kind: "table", table: t, window: w, id: t.name };
  if (want === "list" && w.list?.rows.length) return { kind: "list", window: w, id: "list" };
  const cell = /^(.+)\[(\d+)\]$/.exec(id);
  if (cell) {
    for (const table of w.tables) {
      const col = table.columns.find((x) => lower(x.name) === lower(cell[1]));
      // The table's own row number, never the n-th row on show: a row not on show names nothing here.
      const r = table.rows.find((x) => x.index === Number(cell[2]));
      const c = col && r ? r.cells[col.index] : undefined;
      if (col && r && c?.kind === "dropdown")
        return { kind: "dropdown", window: w, id, cell: { table, row: r.index }, element: { kind: "dropdown", name: col.name, text: c.text, row: r.row, col: col.col, width: col.width, input: c.input, hidden: c.hidden, path: [], etype: 0, ...(c.key !== undefined ? { key: c.key } : {}), ...(c.valueList ? { valueList: c.valueList } : {}) } };
    }
    return undefined;
  }
  const e = w.elements.find((x) => x.kind === "dropdown" && !x.hidden && lower(x.name) === want);
  if (e) return { kind: "dropdown", element: e, window: w, id: e.name };
  return undefined;
}

/** The controls of the active window that scroll, for an action without an id. */
export function scrollables(s: DiagScreen): Named[] {
  const w = activeWindow(s);
  const out: Named[] = [];
  for (const c of w.controls) {
    if (c.grid) out.push({ kind: "grid", control: c, window: w, id: controlId(c) });
    else if (c.tree) out.push({ kind: "tree", control: c, window: w, id: controlId(c) });
  }
  for (const t of w.tables) out.push({ kind: "table", table: t, window: w, id: t.name });
  if (w.list?.rows.length) out.push({ kind: "list", window: w, id: "list" });
  return out;
}

function need(s: DiagScreen, action: Action, kinds: Named["kind"][], what: string): Named {
  const n = namedControl(s, action.id);
  if (!n) {
    const here = scrollables(s)
      .filter((x) => kinds.includes(x.kind))
      .map((x) => x.id);
    throw new ActionError(`No ${what} "${String(action.id ?? "")}" on this screen.${here.length ? ` It has: ${here.join(", ")}.` : ""}`);
  }
  if (!kinds.includes(n.kind)) throw new ActionError(`${n.id} is a ${n.kind}, not a ${what}.`);
  return n;
}

// ---- trees ----

/** The nodes of a tree on show, in order, with the keyboard's changes (`local`) over what SAP sent. */
export function shownNodes(c: DiagControl, local?: ReadonlyMap<string, boolean>): DiagTreeNode[] {
  const out: DiagTreeNode[] = [];
  const open = new Map<string, boolean>([["", true]]);
  for (const n of c.tree?.nodes ?? []) {
    const visible = (open.get(n.parent) ?? false) && !n.hidden;
    const expanded = local?.get(n.key) ?? n.expanded;
    open.set(n.key, visible && expanded);
    if (visible) out.push(local?.has(n.key) ? { ...n, expanded } : n);
  }
  return out;
}

/** A Windows control of a class that holds a point of the screen area (its container's top left). */
function hostControl(g: Geometry, cls: string, x: number, y: number): Rect | undefined {
  return g.controls.find((c) => c.cls === cls && x >= c.rect[0] - 8 && x <= c.rect[0] + c.rect[2] && y >= c.rect[1] - 30 && y <= c.rect[1] + c.rect[3])?.rect;
}

/** Steps that put the keyboard focus on the first line of a tree, then on its line `line` (from the first node on show). */
function treeFocus(n: Named & { kind: "tree" }, g: Geometry, line: number): Step[] {
  const area = n.control.area;
  if (!area) throw new ActionError(`The tree ${n.id} has no place on the screen.`);
  const [cx, cy] = g.at(n.window, area.row, area.col);
  const rect = hostControl(g, "SAPTreeList", cx, cy);
  if (!rect) throw new ActionError(`The tree ${n.id} was not found on the screen (its window, class SAPTreeList).`);
  const pitch = treePitch(g.cells);
  // A click on the first line gives the tree the focus; Home and the arrow keys then count lines exactly.
  const steps: Step[] = [{ do: "click", x: rect[0] + 44, y: rect[1] + Math.floor(pitch / 2), settle: 120 }, { do: "vk", vk: VK.HOME, settle: 60 }];
  if (line > 0) steps.push({ do: "vk", vk: VK.DOWN, count: line, settle: 80 });
  return steps;
}

/** tree: a node by its key, how = double (default), select, expand or collapse. */
export function planTree(s: DiagScreen, action: Action, g: Geometry, local?: ReadonlyMap<string, boolean>): Plan {
  const n = need(s, action, ["tree"], "tree") as Named & { kind: "tree" };
  const how = String(action.how ?? "double").toLowerCase();
  if (!["double", "select", "expand", "collapse"].includes(how)) throw new ActionError('tree "how" is double, select, expand or collapse');
  const key = clean(action.node);
  if (!key) throw new ActionError('tree needs "node": the key shown as {key} after the node in the view');
  return planNode(n, key, how as "double" | "select" | "expand" | "collapse", g, local);
}

export function planNode(n: Named & { kind: "tree" }, key: string, how: "double" | "select" | "expand" | "collapse", g: Geometry, local?: ReadonlyMap<string, boolean>): Plan {
  const all = n.control.tree?.nodes ?? [];
  const node = all.find((x) => x.key === key) ?? all.find((x) => x.key.toLowerCase() === key.toLowerCase());
  if (!node) throw new ActionError(`No node {${key}} in the tree ${n.id}. Use a key shown as {key} in the view.`);
  const shown = shownNodes(n.control, local);
  const line = shown.findIndex((x) => x.key === node.key);
  if (line < 0) {
    const byKey = new Map(all.map((x) => [x.key, x]));
    let closed: DiagTreeNode | undefined;
    for (let p = byKey.get(node.parent); p; p = byKey.get(p.parent)) if (!(local?.get(p.key) ?? p.expanded)) closed = p;
    throw new ActionError(`The node {${node.key}} is ${node.hidden ? "hidden" : `inside a closed folder: expand {${closed?.key ?? node.parent}} first`}.`);
  }
  const named = `node "${clean(node.text) || node.key}" {${node.key}} of ${n.id}`;
  const state = shown[line] as DiagTreeNode;
  const kids = all.some((x) => x.parent === node.key);
  if (how === "expand" || how === "collapse") {
    const open = how === "expand";
    if (!node.folder && !kids) throw new ActionError(`${named} is not a folder: it has nothing to ${how}.`);
    if (state.expanded === open) return { steps: [], note: `${named} is already ${open ? "open" : "closed"}`, answer: "no" };
    // Right opens a folder, Left closes it. A folder whose children SAP has not sent yet makes SAP GUI ask for them.
    return {
      steps: [...treeFocus(n, g, line), { do: "vk", vk: open ? VK.RIGHT : VK.LEFT, settle: 80 }],
      note: `${open ? "expanded" : "collapsed"} ${named}`,
      answer: open && !kids ? "yes" : "maybe",
      tree: { shell: n.control.id, node: node.key, expanded: open },
      confirm: (after, answered) => {
        if (!answered) return open && kids ? "SAP GUI had its nodes already, so it did not ask SAP (the view shows them)" : undefined;
        const c = after?.windows.flatMap((w) => w.controls).find((x) => x.id === n.control.id);
        const under = c?.tree?.nodes.filter((x) => x.parent === node.key).length ?? 0;
        return open ? `${under} node${under === 1 ? "" : "s"} under it` : undefined;
      },
    };
  }
  if (how === "select") return { steps: treeFocus(n, g, line), note: `selected ${named}`, answer: "maybe" };
  // Double-click: Enter on the node, as SAP GUI's trees take it.
  return { steps: [...treeFocus(n, g, line), { do: "vk", vk: VK.ENTER, settle: 80 }], note: `opened ${named} (Enter on the node)`, answer: "yes" };
}

// ---- grids ----

/** A grid column by its id or title (any case): its place among the columns, from the left. */
function gridColumn(c: DiagControl, col: string | undefined): number | undefined {
  if (col === undefined || col === "") return undefined;
  const cols = [...(c.grid?.columns ?? [])].sort((a, b) => a.position - b.position);
  const i = cols.findIndex((x) => lower(x.name) === lower(col));
  const j = i >= 0 ? i : cols.findIndex((x) => lower(x.title) === lower(col) || x.titles.some((t) => lower(t) === lower(col)));
  if (j < 0) throw new ActionError(`No column "${col}" in the grid: its columns are ${cols.map((x) => `${x.name}=${clean(x.title)}`).join(" | ")}.`);
  return j;
}

/** Steps that give a grid the focus on its top left cell (Ctrl+Home), then move to a row and a column with the arrow keys. */
function gridFocus(n: Named & { kind: "grid" }, g: Geometry, row: number, col: number | undefined): { steps: Step[]; rect: Rect } {
  const area = n.control.area;
  if (!area) throw new ActionError(`The grid ${n.id} has no place on the screen.`);
  const [gx, gy] = g.at(n.window, area.row, area.col);
  const rect = hostControl(g, "SAPALVGrid", gx, gy);
  if (!rect) throw new ActionError(`The grid ${n.id} was not found on the screen (its window, class SAPALVGrid).`);
  const pitch = gridPitch(g.cells);
  // A click on the header of the first column gives the grid the focus without touching a data cell (a hotspot fires
  // on a single click, an editable checkbox ticks); Ctrl+Home goes to the first cell, the arrows count from there (and scroll).
  // Not the header's left corner: with row selectors that one selects every row.
  const steps: Step[] = [{ do: "click", x: rect[0] + 60, y: rect[1] + Math.floor(pitch / 2), settle: 150 }, { do: "vk", vk: VK.HOME, ctrl: true, settle: 100 }];
  if (row > 0) steps.push({ do: "vk", vk: VK.DOWN, count: row, settle: 120 });
  if (col !== undefined && col > 0) steps.push({ do: "vk", vk: VK.RIGHT, count: col, settle: 80 });
  return { steps, rect };
}

function gridRowText(c: DiagControl, row: number): string {
  const r = c.grid?.rows.find((x) => x.index === row);
  return r ? ` (${r.cells.slice(0, 4).map(clean).join(" | ")})` : "";
}

/**
 * grid: a cell by row and column; how = double (default: double-click, as
 * F2 in SAP GUI), select (the row) or cell (the cursor only). A value
 * help's hit list ("value-help") is a list in its own popup: the arrow keys
 * and Enter.
 */
export function planGrid(s: DiagScreen, action: Action, g: Geometry, howDefault = "double"): Plan {
  const n = need(s, action, ["grid"], "grid") as Named & { kind: "grid" };
  const grid = n.control.grid;
  const row = action.row;
  if (typeof row !== "number" || !Number.isInteger(row) || row < 0) throw new ActionError(`grid needs "row": a row number from the view ("row N:"), e.g. {"do":"grid","id":"${n.id}","row":0,"col":"<column>"}`);
  if (grid && row >= grid.totalRows) throw new ActionError(`row ${row}: the grid ${n.id} has ${grid.totalRows} rows (0 to ${grid.totalRows - 1}).`);
  const how = String(action.how ?? howDefault).toLowerCase();
  if (!["double", "select", "cell"].includes(how)) throw new ActionError('grid "how" is double, select or cell');
  const what = `row ${row}${gridRowText(n.control, row)} of ${n.id}`;
  if (!n.control.area) {
    // The control-based value help: it opens with its first row selected; Down moves, Enter chooses.
    const steps: Step[] = row > 0 ? [{ do: "vk", vk: VK.DOWN, count: row, settle: 120 }] : [];
    if (how === "double") return { steps: [...steps, { do: "key", key: 0 }], note: `chose ${what}`, answer: "yes" };
    return { steps, note: `selected ${what}`, answer: "no" };
  }
  const col = gridColumn(n.control, action.col);
  const colText = action.col ? `, column ${action.col}` : "";
  const { steps, rect } = gridFocus(n, g, row, col);
  if (how === "double") return { steps: [...steps, { do: "key", key: 2 }], note: `double-clicked ${what}${colText} (F2)`, answer: "yes" };
  if (how === "cell") return { steps, note: `cursor on ${what}${colText}`, answer: "maybe" };
  return { ...selectGridRow(g, row, rect, steps), note: `selected ${what}` };
}

/** Selects a grid row: the row selector at the left edge, by mouse, when the row is on the first page; Shift+Space on the row otherwise. */
function selectGridRow(g: Geometry, row: number, rect: Rect, focus: Step[]): Omit<Plan, "note"> {
  const pitch = gridPitch(g.cells);
  // Rows that surely fit under the header after Ctrl+Home (one row kept free for a horizontal scroll bar).
  const page = Math.max(1, Math.floor(rect[3] / pitch) - 2);
  if (row < page) {
    const head = focus.slice(0, 2);
    return { steps: [...head, { do: "click", x: rect[0] + 4, y: rect[1] + pitch * (row + 1) + Math.floor(pitch / 2), settle: 120 }], answer: "maybe" };
  }
  return { steps: [...focus, { do: "vk", vk: VK.SPACE, shift: true, settle: 100 }], answer: "maybe" };
}

// ---- table controls ----

/** select a table control's row by its row selector: the cell left of the first column, on the row's line. */
export function planTableRow(n: Named & { kind: "table" }, row: number, g: Geometry): Plan {
  const t = n.table;
  const r = t.rows.find((x) => x.index === row);
  if (!r) throw new ActionError(`Row ${row} of the table ${n.id} is not on show: scroll to it first ({"do":"scroll","id":"${n.id}","to":${row}}).`);
  const first = Math.min(...t.columns.filter((c) => c.visible).map((c) => c.col));
  const col = Number.isFinite(first) && first - 1 >= t.col ? first - 1 : t.col;
  const [x, y] = g.at(n.window, r.row, col);
  return {
    steps: [{ do: "click", x: x - Math.floor(g.cells.cw / 2) + 1, y, settle: 100 }],
    note: `selected row ${row} of the table ${n.id}; SAP gets the selection with the next Enter or function key`,
    answer: "no",
  };
}

// ---- dropdowns ----

/**
 * combo: chooses a dropdown entry. SAP GUI keeps a dropdown's entries
 * itself (the traffic gives the chosen key and the list's id only), so the
 * entry is chosen as a person does: a click opens the list, the entry's
 * text is typed (the list jumps to it), Enter takes it. The key it took is
 * read from the next screen.
 */
export function planCombo(s: DiagScreen, action: Action, g: Geometry): Plan {
  const n = need(s, action, ["dropdown"], "dropdown") as Named & { kind: "dropdown" };
  const e = n.element;
  const now = clean(e.key);
  const wanted = action.key ?? action.value;
  if (wanted === undefined || wanted === null || clean(String(wanted)) === "")
    return {
      steps: [],
      note: `${n.id} shows "${now}". Its entries are not in the traffic (SAP GUI keeps them; SAP sends the chosen key and the list's id${e.valueList ? ` "${e.valueList}"` : ""} only). Choose one by the text the dropdown shows: {"do":"combo","id":"${n.id}","key":"<text or key>"}`,
      answer: "no",
    };
  if (!e.input) throw new ActionError(`${n.id} is read-only.`);
  const text = clean(String(wanted));
  if (lower(now) === lower(text)) return { steps: [], note: `${n.id} already has "${now}"`, answer: "no" };
  const [x, y] = g.at(n.window, e.row, e.col, e.width);
  const keyAfter = (sc: DiagScreen): string | undefined => {
    const m = namedControl(sc, n.id);
    return m?.kind === "dropdown" ? clean(m.element.key) : undefined;
  };
  const verdict = (sc: DiagScreen): string | undefined => {
    const k = keyAfter(sc);
    if (k === undefined) return undefined;
    if (lower(k) === lower(text)) return `${n.id} now has "${k}"`;
    return k === now ? `${n.id} still has "${k}": SAP GUI found no entry starting with "${text}"` : `${n.id} now has the key "${k}" (check that it is the entry meant by "${text}")`;
  };
  // A dropdown with a function code sends the choice to SAP at once; the others with the next Enter or function key.
  const sends = !!e.fcode;
  return {
    steps: [
      { do: "click", x, y, settle: 200 },
      { do: "type", value: text, settle: 100 },
      { do: "vk", vk: VK.ENTER, settle: 100 },
    ],
    note: `chose "${text}" in ${n.id}${sends ? "" : "; SAP gets it with the next Enter or function key"}`,
    answer: sends ? "yes" : "no",
    ...(sends ? { confirm: (after: DiagScreen | undefined) => (after ? verdict(after) : undefined) } : { later: verdict }),
  };
}

// ---- toolbars ----

/** Function codes of the ALV grid's own toolbar, and the English tooltip words SAP GUI gives the button. */
const ALV_BUTTONS: Readonly<Record<string, string[]>> = {
  "&DETAIL": ["details", "detail"],
  "&SORT_ASC": ["sort in ascending order", "sort ascending"],
  "&SORT_DSC": ["sort in descending order", "sort descending"],
  "&FIND": ["find"],
  "&FIND_MORE": ["find next"],
  "&MB_FILTER": ["set filter", "filter"],
  "&FILTER": ["set filter", "filter"],
  "&MB_SUM": ["total", "totals"],
  "&MB_SUBTOT": ["subtotals", "subtotal"],
  "&PRINT_BACK": ["print preview", "print"],
  "&MB_VIEW": ["view", "views"],
  "&MB_EXPORT": ["export"],
  "&MB_VARIANT": ["select layout", "change layout", "layout"],
  "&GRAPH": ["display graphic", "graphic"],
  "&INFO": ["information", "end-user documentation"],
  "&REFRESH": ["refresh"],
  "&LOCAL&APPEND": ["append row"],
  "&LOCAL&INSERT_ROW": ["insert row"],
  "&LOCAL&DELETE_ROW": ["delete row"],
  "&LOCAL&COPY_ROW": ["duplicate row"],
};

/** The words a toolbar button may carry for what the agent named (a function code or a text). */
export function buttonWords(button: string): string[] {
  const b = clean(button);
  return [...new Set([lower(b), ...(ALV_BUTTONS[b.toUpperCase()] ?? [])])];
}

/**
 * The screen's toolbar button or function key a toolbar action names: by
 * its text or tooltip, or by the words of a known ALV function code. SAP's
 * traffic gives these buttons a key, a text and a tooltip, but no function
 * code, so a code is matched only through those words.
 */
export function toolbarKey(w: DiagWindow, button: string): DiagKey | undefined {
  const words = buttonWords(button);
  return [...w.toolbar, ...w.keys].find((x) => x.enabled && (words.includes(lower(x.text)) || words.includes(lower(x.tooltip))));
}

/**
 * toolbar: a button of a grid's toolbar. A full-screen ALV list puts its
 * toolbar into the screen's own toolbar: those buttons have a function key,
 * found by text or tooltip (`toolbarKey`) and sent by keyboard. A grid in a
 * container draws its own toolbar, which the traffic does not describe: its
 * buttons are found by their accessible names (`buttons`, from the host)
 * inside the grid's place on the screen and pushed without the mouse. The
 * agent's own text must be a button's whole name or tooltip; only the
 * words of a known ALV code may start one (`ALV_BUTTONS`).
 */
export function planToolbar(s: DiagScreen, action: Action, g: Geometry, buttons?: { name: string; tip: string; enabled: boolean; x: number; y: number }[]): Plan | "need-buttons" {
  const n = need(s, action, ["grid", "tree"], "grid") as Named & { kind: "grid" | "tree" };
  const b = clean(action.button);
  if (!b) throw new ActionError(`toolbar needs "button": a function code (e.g. "&SORT_ASC") or the button's text, e.g. {"do":"toolbar","id":"${n.id}","button":"&MB_FILTER"}`);
  const w = n.window;
  const k = toolbarKey(w, b);
  if (k) return { steps: [{ do: "key", key: k.vkey }], note: `pressed toolbar button "${clean(k.text || k.tooltip)}" (${k.key})`, answer: "yes", pressed: [k.text, k.tooltip] };
  if (!buttons) return "need-buttons";
  const area = n.control.area;
  let inside = buttons;
  let within: Rect | undefined;
  if (area) {
    const [x0, y0] = g.at(w, area.row, area.col);
    const x1 = x0 + g.cells.cw * Math.max(1, area.width);
    const y1 = y0 + g.cells.ch * Math.max(1, area.height);
    within = [x0 - g.cells.cw * 2, y0 - g.cells.ch * 2, x1 - x0 + g.cells.cw * 4, y1 - y0 + g.cells.ch * 2];
    const r = within;
    inside = buttons.filter((x) => x.x >= r[0] && x.x <= r[0] + r[2] && x.y >= r[1] && x.y <= r[1] + r[3]);
  }
  const words = buttonWords(b);
  const alv = ALV_BUTTONS[b.toUpperCase()] ?? [];
  const hit = inside.find((x) => words.includes(lower(x.name)) || words.includes(lower(x.tip))) ?? inside.find((x) => alv.some((wd) => lower(x.tip).startsWith(wd) || lower(x.name).startsWith(wd)));
  if (!hit) {
    const names = inside.map((x) => clean(x.name || x.tip)).filter(Boolean);
    throw new ActionError(`No toolbar button "${b}" on the grid ${n.id}.${names.length ? ` Its buttons: ${names.join(", ")}.` : " Its toolbar was not found on the screen."}`);
  }
  if (!hit.enabled) throw new ActionError(`The toolbar button "${clean(hit.name)}" of ${n.id} is greyed out: SAP does not offer it now.`);
  return { steps: [{ do: "press", name: hit.name, ...(within ? { within } : {}) }], note: `pressed toolbar button "${clean(hit.name)}" of ${n.id}`, answer: "maybe", pressed: [hit.name, hit.tip] };
}

// ---- scrolling ----

/** Where a table control or a list is: its first row on show, rows per page, rows in all. */
export function position(n: Named): { first: number; visible: number; total: number | undefined } | undefined {
  if (n.kind === "table") {
    const rows = n.table.rows;
    return { first: rows[0]?.index ?? 0, visible: Math.max(1, n.table.visibleRows ?? rows.length), total: n.table.totalRows };
  }
  if (n.kind === "list") {
    const l = n.window.list;
    return { first: l?.firstRow ?? 0, visible: Math.max(1, l?.rows.length ?? 1), total: l?.totalRows };
  }
  return undefined;
}

/** The first row a scroll aims at, for a table control or a list. */
export function scrollTarget(to: number | string, p: { first: number; visible: number; total: number | undefined }): number {
  const last = Math.max(0, (p.total ?? p.first + p.visible) - p.visible);
  if (typeof to === "number") return to >= p.first && to < p.first + p.visible ? p.first : Math.max(0, Math.min(to, last));
  if (to === "next") return Math.min(p.first + p.visible, last);
  if (to === "prev") return Math.max(0, p.first - p.visible);
  if (to === "first") return 0;
  return last;
}

/**
 * One page of a scroll of a table control or a list, toward `target`: the
 * page keys SAP GUI sends to SAP (Page Down, Page Up; Ctrl+ for the first
 * and the last page). A table control gets the focus first (a click on a
 * cell of its first row on show): there the keys scroll the table.
 */
export function planPage(n: Named, target: number, g: Geometry): Plan | undefined {
  const p = position(n);
  if (!p) return undefined;
  if (target >= p.first && target < p.first + p.visible) return undefined;
  const steps: Step[] = [];
  if (n.kind === "table") {
    // The click that gives the table the focus goes into a plain field: a checkbox there would tick, a dropdown open.
    const r = n.table.rows[0];
    const c = r ? n.table.columns.filter((x) => x.visible && r.cells[x.index]?.kind === "field" && !r.cells[x.index]?.hidden).sort((a, b) => a.col - b.col)[0] : undefined;
    if (!r || !c) throw new ActionError(`${n.id} has no plain field in its first row on show to put the cursor in (only checkboxes, dropdowns or nothing), so it is not scrolled: a click there would change it. Scroll it in SAP GUI, or use its own buttons.`);
    const [x, y] = g.at(n.window, r.row, c.col, c.width);
    steps.push({ do: "click", x, y, settle: 100 });
  }
  const last = Math.max(0, (p.total ?? 0) - p.visible);
  // SAP's page keys: 80 first page (Ctrl+Page Up), 81 previous (Page Up), 82 next (Page Down), 83 last (Ctrl+Page Down).
  const key = target < p.first ? (target === 0 ? 80 : 81) : p.total !== undefined && target >= last && target - p.first > p.visible ? 83 : 82;
  steps.push({ do: "key", key });
  return { steps, note: `scrolled ${n.id}`, answer: "yes" };
}

/** Steps that scroll a grid so that `row` is on show: the focus, Ctrl+Home, then Down (SAP GUI asks SAP for rows it does not have). */
export function planGridScroll(n: Named & { kind: "grid" }, to: number | string, g: Geometry): Plan {
  const total = n.control.grid?.totalRows ?? 0;
  if (!n.control.area) throw new ActionError(`The hit list ${n.id} shows all its rows: use sap_look with "id":"${n.id}" to read them.`);
  if (to === "next" || to === "prev") {
    const { steps } = gridFocus(n, g, 0, undefined);
    // The click on the header gives the grid the focus; Page Down or Page Up moves one page from its current cell.
    return { steps: [steps[0] as Step, { do: "vk", vk: to === "next" ? VK.PAGEDOWN : VK.PAGEUP, settle: 150 }], note: `scrolled ${n.id} one page ${to === "next" ? "down" : "up"}`, answer: "maybe" };
  }
  if (to === "last") {
    const { steps } = gridFocus(n, g, 0, undefined);
    return { steps: [...steps, { do: "vk", vk: VK.END, ctrl: true, settle: 150 }], note: `scrolled ${n.id} to its last row`, answer: "maybe" };
  }
  const row = to === "first" ? 0 : Number(to);
  if (!Number.isInteger(row) || row < 0) throw new ActionError('scroll "to" is a row number counted from 0, or "next", "prev", "first" or "last".');
  if (total && row >= total) throw new ActionError(`row ${row}: the grid ${n.id} has ${total} rows (0 to ${total - 1}).`);
  const { steps } = gridFocus(n, g, row, undefined);
  return { steps, note: `scrolled ${n.id} to row ${row}`, answer: "maybe" };
}

// ---- the actions of before: okcode, key, set, click, dblclick, press, select, check, focus, f4 ----

/** What a plain action's id means (index.ts `resolveTarget`), as far as planning needs it. */
export type PlainTarget =
  | { kind: "element"; element: DiagElement; window: DiagWindow; row: number; col: number; what: string }
  | { kind: "cell"; window: DiagWindow; row: number; col: number; width: number; input: boolean; cellKind?: DiagElementKind; what: string }
  | { kind: "list"; window: DiagWindow; row: number; col: number; what: string }
  | { kind: "tab"; window: DiagWindow; row: number; col: number; text: string; what: string }
  | { kind: "key"; key: { vkey: number; text: string }; what: string }
  | { kind: "gridrow"; window: DiagWindow; row: number; col: number; index: number; what: string }
  | { kind: "node"; window: DiagWindow; row: number; col: number; line: number; depth: number; header: boolean; what: string };

/** What a plain target is, for the refusals: an element's or a table cell's kind, else the target's kind. */
function kindOf(x: PlainTarget): string {
  if (x.kind === "element") return x.element.kind;
  if (x.kind === "cell") return x.cellKind ?? "field";
  return x.kind;
}

/**
 * Why focus, f4, set or check cannot go to this target without doing more
 * than they say, or undefined. Each starts with a mouse click at the target
 * (ps/input-lib.ps1), and on a push button, a toolbar key or a tab that
 * click presses it, on a checkbox it ticks it, on a dropdown it opens it, on
 * a list line it can open the line (a hotspot). So:
 * - set takes a field (or a table cell) that is a field;
 * - check takes a checkbox or a radio button;
 * - focus and f4 take a field (a grid row and a tree node are reached by the
 *   keyboard, see planGrid and planNode).
 * The driver refuses these before the guard is asked (index.ts `assess`),
 * and planning refuses them again.
 */
export function plainMisuse(action: Action, x: PlainTarget): string | undefined {
  const k = kindOf(x);
  const press = k === "button" || k === "key" || k === "tab" ? ` To press it, use {"do":"press","id":"${String(action.id ?? "")}"}.` : "";
  switch (action.do) {
    case "set":
      if (k === "field") return undefined;
      return `${x.what} does not take text (it is ${k === "key" ? "a toolbar button or function key" : `a ${k}`}), so nothing was typed: a click there would ${k === "checkbox" || k === "radio" ? "tick it" : "press or open it"}.${k === "checkbox" || k === "radio" ? ` Use {"do":"check","id":"${String(action.id ?? "")}"}.` : press}`;
    case "check":
      if (k === "checkbox" || k === "radio") return undefined;
      return `${x.what} is not a checkbox or a radio button, so "check" was not done: it would only click it.${press}`;
    case "focus":
    case "f4":
      if (k === "field" || (action.do === "focus" && (k === "label" || k === "group" || x.kind === "gridrow" || x.kind === "node"))) return undefined;
      return `"${action.do}" on ${x.what} was not done: it starts with a click there, and a click on ${k === "list" ? "a list line can open it (a hotspot)" : k === "checkbox" || k === "radio" ? "a checkbox or a radio button changes it" : k === "dropdown" ? "a dropdown opens it" : k === "other" ? "an element this reader cannot classify may press it" : "it presses it"}. ${action.do === "f4" ? "Value help is for fields." : "Put the cursor on a field instead."}${press}`;
    default:
      return undefined;
  }
}

/** The control a grid row or tree node target sits in. */
function controlAt(t: { window: DiagWindow; row: number; col: number }, want: "grid" | "tree"): DiagControl | undefined {
  return t.window.controls.find((c) => (want === "grid" ? c.grid : c.tree) && (t.row < 0 ? !c.area : c.area?.row === t.row && c.area?.col === t.col));
}

export function planPlain(s: DiagScreen, action: Action, target: PlainTarget | undefined, g: Geometry, local?: ReadonlyMap<string, boolean>): Plan {
  const w = activeWindow(s);
  const id = String(action.id ?? action.name ?? "");
  const t = (): PlainTarget => {
    if (!target) throw new ActionError(`Nothing on the screen matches "${id}": use a field name, {FCODE}, FIELD[n] or @row,col from the view.`);
    return target;
  };
  switch (action.do) {
    case "okcode": {
      const value = String(action.value ?? "");
      return { steps: [{ do: "okcode", value }], note: `okcode ${value}`, answer: "yes" };
    }
    case "key": {
      const n = vkeyNumber(action.key ?? action.value);
      if (n === undefined) throw new ActionError(`Unknown key ${String(action.key ?? action.value)}`);
      return { steps: [{ do: "key", key: n }], note: `key ${n}`, answer: "yes" };
    }
    case "set": {
      const x = t();
      if (x.kind !== "element" && x.kind !== "cell") throw new ActionError(`${x.what} does not take text.`);
      const misuse = plainMisuse(action, x);
      if (misuse) throw new ActionError(misuse);
      if (x.kind === "element" && !x.element.input) throw new ActionError(`${x.what} is read-only.`);
      const [px, py] = g.at(x.window, x.row, x.col, x.kind === "cell" ? x.width : x.element.width);
      // Typed with the keyboard: a line break would be the Enter key, so it is typed as a space.
      const single = oneLine(String(action.value ?? ""));
      return { steps: [{ do: "set", x: px, y: py, value: single.text, settle: 150 }], note: `typed into ${x.what}; SAP gets it with the next Enter or function key${single.had ? ` (${ONE_LINE_NOTE})` : ""}`, answer: "no" };
    }
    case "focus":
    case "check":
    case "click":
    case "dblclick":
    case "press":
    case "select":
    case "f4": {
      const x = t();
      const misuse = plainMisuse(action, x);
      if (misuse) throw new ActionError(misuse);
      if (x.kind === "key") return { steps: [{ do: "key", key: x.key.vkey }], note: `pressed ${x.what}`, answer: "yes" };
      if (x.kind === "node") {
        const c = controlAt(x, "tree");
        const key = /^\{(.+)\}$/.exec(id)?.[1];
        if (!c || !key) throw new ActionError(`${x.what}: its tree was not found.`);
        const how = action.do === "dblclick" ? "double" : "select";
        return planNode({ kind: "tree", control: c, window: x.window, id: controlId(c) }, key, how, g, local);
      }
      if (x.kind === "gridrow") {
        const c = controlAt(x, "grid");
        if (!c) throw new ActionError(`${x.what}: its grid was not found.`);
        const how = action.do === "dblclick" || action.do === "press" ? "double" : action.do === "select" ? "select" : "cell";
        // A value help's hit list: "select" only moves to the row there.
        return planGrid(s, { do: "grid", id: controlId(c), row: x.index, how: !c.area && how === "select" ? "cell" : how }, g);
      }
      if (x.kind === "tab" && action.do !== "focus") {
        // Tab captions are drawn in a proportional font, so a cell is not where they are: send the tab's
        // function code through the command field, as a click on it does.
        const fcode = w.tabstrips.flatMap((ts) => ts.tabs).find((tab) => tab.row === x.row && tab.col === x.col)?.fcode;
        if (fcode && !w.modal) return { steps: [{ do: "okcode", value: fcode }], note: `selected ${x.what}`, answer: "yes" };
      }
      const width = x.kind === "element" ? x.element.width : x.kind === "cell" ? x.width : x.kind === "tab" ? Math.max(1, x.text.length) : 1;
      const [px, py] = g.at(x.window, x.row, x.col, width);
      const twice = action.do === "dblclick";
      const f4 = action.do === "f4";
      // A click on a field only moves the cursor; buttons, tabs, a checkbox with a function code, double-clicks and F4 go
      // to SAP. An element this reader cannot classify may: a short look for SAP's answer.
      const goes = f4 || twice || x.kind === "tab" || (x.kind === "element" && (x.element.kind === "button" || !!x.element.fcode)) || (x.kind === "cell" && x.cellKind === "button");
      const unknown = (x.kind === "element" && x.element.kind === "other") || (x.kind === "cell" && x.cellKind === "other");
      return { steps: [{ do: f4 ? "f4" : twice ? "dblclick" : "click", x: px, y: py, settle: 150 }], note: `${action.do} on ${x.what}`, answer: goes ? "yes" : unknown ? "maybe" : "no" };
    }
    default:
      throw new ActionError(`"${action.do}" is not supported by the DIAG method.`);
  }
}
