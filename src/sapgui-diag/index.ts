/**
 * SAP GUI for Windows without SAP GUI scripting: the DIAG method
 * (SAP_GUI_METHOD=diag).
 *
 * SAP GUI connects through a SAProuter on this machine (router.ts): the user
 * puts `/H/127.0.0.1/S/3298` in front of the connection entry's router string.
 * The router passes the traffic on and keeps a copy; src/diag decodes it into
 * the screen SAP sent, with SAP's field names, every row of tables and grids,
 * tree nodes and lists. Nothing is loaded into SAP GUI and scripting may be
 * off. It cannot read a connection encrypted with SNC.
 *
 * Acting is keyboard and mouse (ps/input-lib.ps1): the command field, function
 * keys, and clicks at the cell SAP gave each element, mapped to pixels on the
 * window's screen area. A typed value reaches SAP, and so this reader, at the
 * next Enter or function key: until then the view shows it marked as typed
 * (`Typed`), and after that step a field that does not show it is reported.
 *
 * Ids in actions: a SAP field name ("VBAK-VBELN"), a function code in braces
 * ("{HEAD}", a button or tab), a table cell "FIELD[n]" (n = the table's own
 * row number, as the view prints it; a row not on show is scrolled to), or a
 * position "@row,col" (the element there, a list line, anything else). Grids
 * and trees by their container (or "shell N", "value-help"), table controls
 * by name, "list". Ids written nearly right resolve by the rule of
 * core/ids.ts when they then mean one thing (`findTarget`); a name several
 * elements share is refused with their places. What SAP greys out is
 * refused before any input (`greyedRefusal`).
 * The actions are planned in plan.ts and wait for SAP's answer in the
 * traffic (traffic.ts); pixels and windows are in geometry.ts.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { ONE_LINE_NOTE, oneLine } from "../core/action.js";
import { ActionError, type Action, type Assessment, type DoctorCheck, type Driver, type LookOptions, type SessionInfo, type Surface } from "../core/types.js";
import { CLOSES_SESSIONS, commitCode, commitWord, isLogonScreen, LOGON_REFUSAL, MENU_PROGRAMS, okcodeKind, SAFE_VKEYS, safeCode, safeWord, SAVE_VKEYS } from "../core/words.js";
import { type DiagControl, DiagDecoder, type DiagElement, type DiagKey, type DiagScreen, type DiagWindow, diagView, menuView } from "../diag/index.js";
import { notationNote } from "../core/notation.js";
import { HostError, MAX_TIMEOUT_MS, powershellExe, PsHost, READ_TIMEOUT_MS } from "../sapgui/host.js";
import type { Transport } from "../sapgui/facts.js";
import { vkeyNumber } from "../sapgui/keys.js";
import { type Cells, cellMetrics, cellsFromEnv, type HostWindow, pickWindow, type Rect } from "./geometry.js";
import { type Geometry, type Named, namedControl, type Plan, plainMisuse, planCombo, planGrid, planGridScroll, planPage, planPlain, planTableRow, planToolbar, planTree, position, scrollables, scrollTarget, type Step, type TreeChange, toolbarKey } from "./plan.js";
import { type Hop, startRouter } from "./router.js";
import { lookControl } from "./rows.js";
import { MAYBE_REQUEST_MS, Traffic, type WaitOptions, waitNote, waitOptions } from "./traffic.js";
import { fileURLToPath } from "node:url";

export { cellPoint } from "./geometry.js";

const PREFIX = "sapgui:diag:";
export const INPUT_SCRIPT = fileURLToPath(new URL("./ps/input-host.ps1", import.meta.url));

interface Connection {
  n: number;
  target: Hop;
  decoder: DiagDecoder;
  open: boolean;
  /** Requests and answers of the connection, for the waits (traffic.ts). */
  traffic: Traffic;
  /** Bumped on every screen, per mode: typed values hold while it does not change. */
  steps: Map<number, number>;
  /** Per mode: values typed in SAP GUI that SAP has not received yet (see Typed). */
  typed: Map<number, Typed[]>;
}

interface WindowFacts {
  hwnd: number;
  kind: "session" | "popup";
  title: string;
  area?: [number, number, number, number] | null;
  controls?: { cls: string; rect: [number, number, number, number] }[];
  foreground?: boolean;
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const commit = (reason: string): Assessment => ({ risk: "commit", reason });

/** The window actions go to: the topmost modal one, else the main window. */
function active(s: DiagScreen): DiagWindow {
  return s.windows[s.windows.length - 1] as DiagWindow;
}

/** The popup's question, when it asks whether to save, post, delete... */
function commitQuestion(s: DiagScreen): string | undefined {
  const w = active(s);
  if (!w.modal) return undefined;
  if (commitWord(w.title)) return w.title;
  const buttons = w.elements.some((e) => e.kind === "button");
  if (!buttons || w.list) return undefined;
  const text = [w.title, ...w.elements.filter((e) => e.kind !== "button" && e.kind !== "checkbox" && e.kind !== "radio").map((e) => e.text)].join(" ");
  return commitWord(text) ? clean(text) : undefined;
}

function keyOf(w: DiagWindow, n: number): DiagKey | undefined {
  return [...w.toolbar, ...w.keys].find((k) => k.vkey === n);
}

export function assessDiag(s: DiagScreen, action: Action, target?: Target): Assessment {
  const w = active(s);
  const lang = s.session.language;
  const assessKey = (n: number, how: string): Assessment => {
    if (SAVE_VKEYS.has(n)) return commit(`${how}: Save (Ctrl+S)`);
    const k = keyOf(w, n);
    // A toolbar button may have only a tooltip ("List Width Right"): named by it, not as "".
    const named = k ? `${how} "${clean(k.text || k.tooltip)}"` : how;
    if (k && commitWord(k.text, k.tooltip)) return commit(named);
    const q = n === 0 || (k && !/^(no|cancel|back|exit)$/.test(safeWord(lang, k.text) ?? "")) ? commitQuestion(s) : undefined;
    if (q && n !== 12 && n !== 3 && n !== 15) return commit(`${named} on the popup "${q.slice(0, 90)}"`);
    if (n === 4 || n === 1) return { risk: "read", reason: n === 4 ? "value help" : "help" };
    if (SAFE_VKEYS.has(n) || (k && safeWord(lang, k.text, k.tooltip))) return { risk: "navigate", reason: named };
    return commit(`${named} is not known to be safe, so it is treated as a write`);
  };
  const assessButton = (e: DiagElement, how: string): Assessment => {
    const named = `${how}"${clean(e.text || e.tooltip) || e.fcode || e.name}"`;
    if (commitWord(e.text, e.tooltip) || commitCode(e.fcode)) return commit(named);
    const q = commitQuestion(s);
    const means = safeWord(lang, e.text, e.tooltip);
    if (q && !["no", "cancel", "back", "exit", "help", "display"].includes(means ?? "")) return commit(`${named} on the popup "${q.slice(0, 90)}"`);
    if (safeCode(e.fcode) || means) return { risk: "navigate", reason: named };
    return commit(`${named} is not known to be safe, so it is treated as a write`);
  };
  // The input decides, not the verb: focus, f4, set, check, click, press... all start with a mouse click at the
  // target (plan.ts planPlain), and a click on a push button, a toolbar key or a box with a function code presses it.
  const onRowOrNode = (action.row !== undefined || action.node !== undefined) && !!namedControl(s, action.id);
  if (/^(focus|f4|set|check|press|click|dblclick|select)$/.test(action.do) && !onRowOrNode) {
    if (target?.kind === "key") return assessKey(target.key.vkey, `${action.do} on button "${clean(target.key.text || target.key.tooltip)}"`);
    if (target?.kind === "element") {
      const e = target.element;
      if (e.kind === "button" || (e.fcode && e.kind !== "field")) return assessButton(e, `${action.do} on ${e.kind === "button" ? "button" : e.kind} `);
      // Never rated safer than a button: what it does when clicked is not known.
      if (e.kind === "other") return commit(`${action.do} on an element this reader cannot classify (${e.name || `@${e.row},${e.col}`}, type ${e.etype}) is treated as a write`);
    }
    // A push button in a table-control row (Details, Delete...) or a cell of a type not known: what it does is not in the traffic.
    if (target?.kind === "cell" && (target.cellKind === "button" || target.cellKind === "other")) {
      const text = clean(target.window.tables.find((t) => t.name === target.table)?.rows.find((r) => r.index === target.index)?.cells[target.column]?.text);
      return commit(`${action.do} on ${target.cellKind === "button" ? `the button "${text}"` : "an element this reader cannot classify"} in row ${target.index} of the table ${target.table} is treated as a write`);
    }
  }
  switch (action.do) {
    case "focus":
    case "f4":
      return { risk: "read", reason: action.do === "f4" ? "value help" : "focus" };
    case "set":
    case "check":
      return { risk: "navigate", reason: "changes input, not saved" };
    case "okcode": {
      const v = String(action.value ?? "").trim();
      const how = `okcode ${v}`;
      const k = okcodeKind(v);
      switch (k.kind) {
        case "empty":
          return assessKey(0, how);
        case "key":
          return assessKey(k.key, how);
        case "transaction":
        case "safe":
          return { risk: "navigate", reason: how };
        case "closes":
          // Ending the logon: the guard refuses it on its own rule (SAP_ALLOW_LOGOFF).
          return { risk: "commit", reason: `${how} ${CLOSES_SESSIONS}`, closes: true };
        case "commit":
          return commit(`${how} (a function code that saves, posts or deletes)`);
        default:
          if (!k.code.startsWith("/") && /^[A-Z0-9_]+$/.test(k.code) && MENU_PROGRAMS.has(w.program.toUpperCase())) return { risk: "navigate", reason: how };
          return commit(`${how} (a command or function code that the server cannot classify)`);
      }
    }
    case "key": {
      const n = vkeyNumber(action.key ?? action.value);
      if (n === undefined) return commit(`key ${String(action.key ?? action.value)} is not a key SAP GUI has`);
      return assessKey(n, `key ${n}`);
    }
    case "combo":
      // A dropdown asked for its entries: nothing is chosen.
      if (action.key === undefined && action.value === undefined) return { risk: "read", reason: "lists a dropdown's entries" };
      return { risk: "navigate", reason: "changes input, not saved" };
    case "scroll":
      return { risk: "read", reason: "scroll" };
    case "tree":
      return action.how === "expand" || action.how === "collapse" ? { risk: "read", reason: `${action.how} a tree node` } : { risk: "navigate", reason: "tree node" };
    case "grid":
      return { risk: "navigate", reason: "grid cell" };
    case "toolbar": {
      const b = clean(String(action.button ?? ""));
      const k = toolbarKey(w, b);
      if (k) return assessKey(k.vkey, `toolbar button "${clean(k.text || k.tooltip)}"`);
      if (safeCode(b)) return { risk: "navigate", reason: `toolbar button ${b}` };
      if (commitWord(b) || commitCode(b)) return commit(`toolbar button "${b}"`);
      if (safeWord(lang, b)) return { risk: "navigate", reason: `toolbar button "${b}"` };
      return commit(`toolbar button "${b}" is not known to be safe, so it is treated as a write`);
    }
    case "press":
    case "click":
    case "dblclick":
    case "select": {
      // A row of a table control or a grid, a tree node by "node": selecting or opening it navigates.
      if ((action.row !== undefined || action.node !== undefined) && namedControl(s, action.id)) {
        if (action.do === "dblclick" && commitQuestion(s)) return commit("a double-click on a popup that asks to save");
        return { risk: "navigate", reason: `${action.do} on a ${action.node !== undefined ? "tree node" : "row"}` };
      }
      if (target?.kind === "key") return assessKey(target.key.vkey, `button "${clean(target.key.text)}"`);
      if (target?.kind === "tab") return { risk: "navigate", reason: `tab "${target.text}"` };
      if (target?.kind === "element" && target.element.kind === "button") return assessButton(target.element, "button ");
      if (target?.kind === "element" || target?.kind === "cell" || target?.kind === "list" || target?.kind === "gridrow" || target?.kind === "node") {
        // A click on a field or a line only moves the cursor; a double-click on a list line chooses it.
        if (action.do === "dblclick" && commitQuestion(s)) return commit("a double-click on a popup that asks to save");
        return { risk: "navigate", reason: `${action.do} on ${target.what}` };
      }
      return commit(`${action.do} on something this reader cannot see is treated as a write`);
    }
    default:
      return commit(`"${action.do}" is not an action of this method`);
  }
}

/** What an action's id means on the screen. */
export type Target =
  | { kind: "element"; element: DiagElement; window: DiagWindow; row: number; col: number; what: string }
  | { kind: "cell"; window: DiagWindow; row: number; col: number; width: number; input: boolean; cellKind: DiagElement["kind"]; table: string; index: number; column: number; what: string }
  | { kind: "list"; window: DiagWindow; row: number; col: number; what: string }
  | { kind: "tab"; window: DiagWindow; row: number; col: number; text: string; what: string }
  | { kind: "key"; key: DiagKey; what: string }
  | { kind: "gridrow"; window: DiagWindow; row: number; col: number; index: number; what: string }
  | { kind: "node"; window: DiagWindow; row: number; col: number; line: number; depth: number; header: boolean; disabled: boolean; what: string };

/** What an id means: one target, several (refused, with the list), or nothing. */
export type Found = { target: Target } | { several: string[] } | { none: true };

/** The tree nodes on show (those whose parents are all open), in the order they are drawn. */
function shownNodes(tree: NonNullable<DiagWindow["controls"][number]["tree"]>) {
  const byKey = new Map(tree.nodes.map((x) => [x.key, x]));
  return tree.nodes.filter((x) => {
    if (x.hidden) return false;
    for (let p = byKey.get(x.parent); p; p = byKey.get(p.parent)) if (!p.expanded) return false;
    return true;
  });
}

const same = (a: string, b: string, ci: boolean) => (ci ? a.toUpperCase() === b.toUpperCase() : a === b);

/**
 * The target of an id written as the view writes it; `ci` compares names and
 * function codes in any case. A name that several elements share is refused
 * with their positions, never guessed among.
 */
function lookup(w: DiagWindow, raw: string, action: Action, ci: boolean): Found {
  const pos = /^@(\d+),(\d+)$/.exec(raw);
  if (pos) {
    const row = Number(pos[1]);
    const col = Number(pos[2]);
    // A field, a button or a box at that place is the element itself; anything else is a point of the screen (a list line).
    const e = w.elements.find((x) => !x.hidden && x.row === row && x.col <= col && col < x.col + Math.max(1, x.width) && x.kind !== "label" && x.kind !== "group");
    if (e) return { target: { kind: "element", element: e, window: w, row: e.row, col: e.col, what: `${e.kind} ${e.name || `@${e.row},${e.col}`}` } };
    const cell = w.list?.rows.find((r) => r.row === row)?.cells.find((c) => c.col <= col && col < c.col + Math.max(1, c.width));
    return { target: { kind: "list", window: w, row, col, what: cell ? `"${clean(cell.text)}"` : `@${row},${col}` } };
  }
  const fc = /^\{(.+)\}$/.exec(raw)?.[1];
  if (fc) {
    for (const ts of w.tabstrips) {
      const t = ts.tabs.find((x) => same(x.fcode, fc, ci));
      if (t) return { target: { kind: "tab", window: w, row: t.row, col: t.col, text: clean(t.text), what: `tab "${clean(t.text)}"` } };
    }
    const b = w.elements.find((e) => !!e.fcode && same(e.fcode, fc, ci) && !e.hidden);
    if (b) return { target: { kind: "element", element: b, window: w, row: b.row, col: b.col, what: `button "${clean(b.text || b.tooltip)}"` } };
    // Toolbar buttons and function keys are not found here: SAP's traffic gives them no function code (noTargetText says so).
    // a tree node by its key: its line among the nodes on show
    for (const c of w.controls) {
      if (!c.tree || !c.area) continue;
      const shown = shownNodes(c.tree);
      const line = shown.findIndex((x) => same(x.key, fc, ci));
      if (line >= 0) {
        const node = shown[line] as (typeof shown)[number];
        return { target: { kind: "node", window: w, row: c.area.row, col: c.area.col, line, depth: node.depth, header: c.tree.headers.length > 1, disabled: node.disabled, what: `tree node "${clean(node.text)}"` } };
      }
    }
    return { none: true };
  }
  const cell = /^(.+)\[(\d+)\]$/.exec(raw);
  if (cell) {
    const [, name = "", n = ""] = cell;
    const index = Number(n);
    // a grid row: the grid's container name and the row number of the view
    const grid = w.controls.find((c) => c.grid && ((c.container !== undefined && same(c.container, name, ci)) || String(c.id) === name || (!c.area && same(name, "value-help", ci))));
    if (grid?.grid && !grid.area) {
      // a value help's hit list: a control without a place on the dynpro; it opens with its first row selected
      if (index >= grid.grid.totalRows) return { none: true };
      const r = grid.grid.rows.find((x) => x.index === index);
      return { target: { kind: "gridrow", window: w, row: -1, col: -1, index, what: `row ${index} of the hit list${r ? ` (${r.cells.slice(0, 3).join(" | ")})` : ""}` } };
    }
    if (grid?.area && grid.grid) {
      if (index >= grid.grid.totalRows) return { none: true };
      const r = grid.grid.rows.find((x) => x.index === index);
      return { target: { kind: "gridrow", window: w, row: grid.area.row, col: grid.area.col, index, what: `row ${index} of ${grid.container ?? name}${r ? ` (${r.cells.slice(0, 4).join(" | ")})` : ""}` } };
    }
    for (const t of w.tables) {
      const c = t.columns.find((x) => same(x.name, name, ci));
      // n is the table's own row number, as the view prints it ("row n"), not the n-th row on show.
      const r = t.rows.find((x) => x.index === index);
      if (c && r) return { target: { kind: "cell", window: w, row: r.row, col: c.col, width: c.width, input: !!r.cells[c.index]?.input, cellKind: r.cells[c.index]?.kind ?? "field", table: t.name, index, column: c.index, what: `${c.name} in row ${index}` } };
    }
    return { none: true };
  }
  const named = w.elements.filter((e) => !e.hidden && !!e.name && same(e.name, raw, ci));
  // The field a label is named after is meant; for set, the one that takes input.
  const inputs = action.do === "set" ? named.filter((x) => x.input) : [];
  const fields = named.filter((x) => x.kind !== "label");
  const best = inputs.length ? inputs : fields.length ? fields : named;
  if (best.length > 1) return { several: best.map((e) => `@${e.row},${e.col} (${e.kind} ${e.name}${e.text ? ` "${clean(e.text).slice(0, 30)}"` : ""})`) };
  const e = best[0];
  if (e) return { target: { kind: "element", element: e, window: w, row: e.row, col: e.col, what: `${e.kind} ${e.name}` } };
  // a toolbar button by its text ("Back", "Display document flow")
  const k = [...w.toolbar, ...w.keys].find((x) => clean(x.text).toLowerCase() === raw.toLowerCase());
  // Any action that clicks finds it too: so that the guard judges a focus or a check on it as pressing it.
  if (k && /^(press|click|dblclick|select|focus|f4|set|check)$/.test(action.do)) return { target: { kind: "key", key: k, what: `button "${clean(k.text)}"` } };
  return { none: true };
}

/**
 * What an action's id means on the screen, by the rule every surface uses
 * (core/ids.ts `resolveId`): the id as the view writes it, then an id
 * written nearly right when it then means one thing only:
 * - in another case (`vbak-vbeln`, `{head}`): SAP names are upper case;
 * - as a scripting id or handle (`wnd[0]/usr/ctxtVBAK-VBELN`, `ctxtVBAK-VBELN`);
 * - a table cell with a column and a row (`RV45A-MABNR[3,0]`), as SAP GUI
 *   scripting names it: the field's name and the row say which cell it is,
 *   the column index does not. Scripting counts the row from the first row
 *   on show (src/sapgui: "cell ids still count from the first row on
 *   screen"), so the table's first row on show is added to it;
 * - a table's own name with a cell's place (`TC_ITEMS[1,0]`): the cell at
 *   that column (as the table shows them) and row on show; a grid's with
 *   [col,row]: that row;
 * - `NAME[0]` for a field that is not in a table: the field.
 */
export function findTarget(s: DiagScreen, action: Action): Found {
  const w = active(s);
  const raw = String(action.id ?? action.name ?? "").trim();
  if (!raw) return { none: true };
  const exact = lookup(w, raw, action, false);
  if (!("none" in exact)) return exact;
  const last = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  // A scripting type prefix (ctxt, txt, chk, btn...): lower case before SAP's upper-case name, or one of the known ones.
  const bare = /^[a-z]+[A-Z%<*]/.test(last) ? last.replace(/^[a-z]+/, "") : last.replace(/^(?:ctxt|txt|lbl|chk|rad|cmb|btn|tbl|pwd)(?=.)/i, "");
  // A classic list's label as scripting names it, lbl[col,row]: that place of the screen, as @row,col.
  const label = /^lbl\[(\d+),(\d+)\]$/i.exec(last);
  if (label) return lookup(w, `@${label[2]},${label[1]}`, action, true);
  const forms = [...new Set([raw, last, bare])];
  const unique = (f: Found): { target: Target } | undefined => ("target" in f ? f : undefined);
  for (const f of forms) {
    const hit = unique(lookup(w, f, action, true));
    if (hit) return hit;
  }
  for (const f of forms) {
    const two = /^(.+)\[(\d+),(\d+)\]$/.exec(f);
    if (two) {
      const [, name = "", col = "", row = ""] = two;
      // Scripting's row is counted from the table's first row on show; the view's FIELD[n] is the table's own row.
      const first = (t: { rows: { index: number }[] }) => t.rows[0]?.index ?? 0;
      const table = w.tables.find((t) => same(t.name, name, true));
      if (table) {
        const c = [...table.columns].sort((a, b) => a.position - b.position)[Number(col)];
        const hit = c && unique(lookup(w, `${c.name}[${first(table) + Number(row)}]`, action, false));
        if (hit) return hit;
        continue;
      }
      const owner = w.tables.find((t) => t.columns.some((c) => same(c.name, name, true)));
      const hit = unique(lookup(w, `${name}[${owner ? first(owner) + Number(row) : row}]`, action, true));
      if (hit) return hit;
    }
    const zero = /^(.+)\[0\]$/.exec(f);
    if (zero?.[1] && !w.tables.some((t) => t.columns.some((c) => same(c.name, zero[1] as string, true)))) {
      const hit = unique(lookup(w, zero[1], action, true));
      if (hit?.target.kind === "element") return hit;
    }
  }
  return { none: true };
}

/** findTarget for one target: undefined when the id means nothing; a name that means several is refused. */
export function resolveTarget(s: DiagScreen, action: Action): Target | undefined {
  const f = findTarget(s, action);
  if ("several" in f) {
    const ident = String(action.id ?? action.name ?? "");
    throw new ActionError(`"${ident}" names ${f.several.length} elements on this screen: ${f.several.slice(0, 8).join(", ")}${f.several.length > 8 ? ", ..." : ""}. Use one of these ids (@row,col).`);
  }
  return "target" in f ? f.target : undefined;
}

/** The ids the active window offers, as the view writes them: what a refused id is compared with. */
export function idsOf(s: DiagScreen): string[] {
  const w = active(s);
  const out: string[] = [];
  for (const e of w.elements) if (!e.hidden && e.name && e.kind !== "label" && e.kind !== "group") out.push(e.name);
  for (const e of w.elements) if (!e.hidden && e.fcode) out.push(`{${e.fcode}}`);
  for (const t of w.tabstrips) for (const tab of t.tabs) if (tab.fcode) out.push(`{${tab.fcode}}`);
  for (const t of w.tables) for (const c of t.columns) out.push(`${c.name}[0]`);
  for (const c of w.controls) if (c.grid) out.push(`${c.container ?? (c.area ? String(c.id) : "value-help")}[0]`);
  for (const k of [...w.toolbar, ...w.keys]) if (k.enabled && k.text) out.push(clean(k.text));
  return [...new Set(out)];
}

/** Edits between two strings (Levenshtein), in any case. */
function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length] ?? 0;
}

/** The refusal for an id that means nothing on the screen, with the closest ids the screen has. */
export function noTargetText(s: DiagScreen, ident: string): string {
  const want = ident.trim().replace(/^.*\//, "");
  const close = idsOf(s)
    .map((id) => ({ id, d: distance(id, want) / Math.max(id.length, want.length, 1) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.id);
  const w = active(s);
  const keys = [...w.toolbar, ...w.keys].filter((k) => k.enabled && (k.text || k.tooltip));
  // {CODE} for a toolbar button or a function key: the traffic carries no function code for them.
  const code = /^\{.+\}$/.test(ident.trim()) && keys.length
    ? ` Toolbar buttons and function keys cannot be named by a function code: SAP's traffic does not carry one for them. Press them by key ({"do":"key","key":3}) or by text ({"do":"press","id":"Back"}); this screen has ${keys.slice(0, 12).map((k) => `${k.key} "${clean(k.text || k.tooltip)}"`).join(", ")}${keys.length > 12 ? ", ..." : ""}. A function code can also go through the command field: {"do":"okcode","value":"<code>"}.`
    : "";
  return `No control "${ident}" on this screen${close.length ? ` (closest: ${close.join(", ")})` : ""}. Use a field name, {FCODE} of a button or tab, FIELD[n] or @row,col from sap_look (the screen may have changed).${code}`;
}

/** The refusal for a button, a key, a tree node or a menu entry SAP shows greyed out: SAP would do nothing with it. */
export const greyedOut = (what: string): string =>
  `${what} is greyed out: SAP does not offer it on this screen now (in this mode, or for this data), so nothing was clicked. Look at the screen for the function that is offered, or for what has to be chosen first.`;

/**
 * Why an action goes to something SAP greys out on this screen, or
 * undefined: said at once, before any input reaches SAP GUI.
 */
export function greyedRefusal(s: DiagScreen, action: Action, target: Target | undefined): string | undefined {
  const w = active(s);
  const clicks = /^(press|click|dblclick|select|f4)$/.test(action.do);
  if (target?.kind === "key" && !target.key.enabled && clicks) return greyedOut(target.what);
  if (target?.kind === "node" && target.disabled && clicks) return greyedOut(target.what);
  if (target?.kind === "element") {
    const e = target.element;
    if (e.kind === "button" && !e.input && clicks) return greyedOut(target.what);
    if ((e.kind === "checkbox" || e.kind === "radio") && !e.input && (action.do === "check" || clicks))
      return `${target.what} cannot be changed here: it is greyed out (read-only). It stays ${e.checked ? "checked" : "unchecked"}.`;
  }
  const all = [...w.toolbar, ...w.keys];
  if (action.do === "key") {
    const n = vkeyNumber(action.key ?? action.value);
    const ks = all.filter((k) => k.vkey === n);
    if (n !== undefined && n !== 0 && ks.length && ks.every((k) => !k.enabled)) return greyedOut(`key ${ks[0]?.key ?? n} "${clean(ks[0]?.text || ks[0]?.tooltip)}"`);
  }
  // An okcode is not checked against the toolbar: its buttons carry no function code in the traffic.
  return undefined;
}

/** A value typed in SAP GUI that SAP has not received yet: kept until the next screen comes. */
export interface Typed {
  /** The step of the mode it was typed on: it holds while no new screen came. */
  step: number;
  window: number;
  program: string;
  dynpro: string;
  name: string;
  row: number;
  col: number;
  /** A cell of a table control: the table, the table's own row number (as the view prints it) and the column index. */
  table?: { name: string; index: number; column: number };
  value: string;
  /** A checkbox or radio button ticked or cleared by `check`: its new state (SAP gets it with the next Enter, like a typed value). */
  checked?: boolean;
}

/** A copy of the screen with the typed values in their fields, marked as typed. */
export function withTyped(s: DiagScreen, typed: Typed[]): DiagScreen {
  if (!typed.length) return s;
  const copy = structuredClone(s);
  for (const t of typed) {
    const w = copy.windows[t.window];
    if (!w || w.program !== t.program || w.dynpro !== t.dynpro) continue;
    if (t.table) {
      const cell = w.tables.find((x) => x.name === t.table?.name)?.rows.find((r) => r.index === t.table?.index)?.cells[t.table.column];
      if (cell) Object.assign(cell, t.checked !== undefined ? { checked: t.checked, typed: true } : { text: t.value, typed: true });
      continue;
    }
    const e = w.elements.find((x) => x.name === t.name && x.row === t.row && x.col === t.col);
    if (e) Object.assign(e, t.checked !== undefined ? { checked: t.checked, typed: true } : { text: t.value, typed: true, required: false });
  }
  return copy;
}

/** "0010" and "10", "or" and "OR" are the same value as SAP shows it. */
const sameValue = (a: string, b: string) => {
  const n = (v: string) => clean(v).toUpperCase().replace(/^0+(?=\d)/, "");
  return n(a) === n(b);
};

/**
 * After the step that sent them: the typed values the screen does not show,
 * when it is still the screen they were typed on (a field SAP changed or
 * did not take). One line each.
 */
export function typedMisses(typed: Typed[], after: DiagScreen): string[] {
  const out: string[] = [];
  for (const t of typed) {
    const w = after.windows[t.window];
    if (!w || w.program !== t.program || w.dynpro !== t.dynpro) continue;
    const target = t.table ? w.tables.find((x) => x.name === t.table?.name)?.rows.find((r) => r.index === t.table?.index)?.cells[t.table.column] : w.elements.find((x) => x.name === t.name && x.row === t.row && x.col === t.col);
    if (t.checked !== undefined) {
      if (target && !!target.checked !== t.checked) out.push(`${t.name}${t.table ? `[${t.table.index}]` : ""} is ${target.checked ? "ticked" : "not ticked"} after this step, not as it was set: SAP changed it or did not take it.`);
      continue;
    }
    const now = target?.text;
    if (now === undefined || sameValue(now, t.value)) continue;
    out.push(`${t.name}${t.table ? `[${t.table.index}]` : ""} shows "${clean(now)}" after this step, not the typed "${t.value}": SAP changed it or did not take it.`);
  }
  return out;
}

/** What a surface shares between its drivers: window bindings, the cell calibration, and the environment. */
export interface DriverShared {
  /** Session window handle to the "connection:mode" it was matched to (geometry.ts `pickWindow`). */
  bound: Map<number, string>;
  /** Is a "connection:mode" still open? */
  live(key: string): boolean;
  /** The titles of every open routed mode's screen: how many windows of a title may be routed. */
  routedTitles?(): string[];
  env: Record<string, string | undefined>;
}

/** Where the time of the last action went. */
interface ActTiming {
  total: number;
  input: number;
  start: number;
  sap: number;
  settle: number;
  decode: number;
  requests: number;
}

/** The longest a driver waits, before an action, for SAP's answer to a step still running. */
const BUSY_MS = 2000;

export class DiagDriver implements Driver {
  info: SessionInfo;
  /** Tree folders opened or closed by the keyboard without SAP knowing: shell id to node key to open. */
  private local = new Map<number, { count: number; nodes: Map<string, boolean> }>();
  /** Checks for the next screen: changes SAP gets only with the next step (a dropdown without a function code). */
  private later: ((s: DiagScreen) => string | undefined)[] = [];
  private last: ActTiming | undefined;
  private shared: DriverShared;

  constructor(
    info: SessionInfo,
    private conn: Connection,
    private mode: number,
    private host: Transport,
    shared?: DriverShared,
  ) {
    this.info = info;
    this.shared = shared ?? { bound: new Map(), live: () => true, env: {} };
  }

  private get key(): string {
    return `${this.conn.n}:${this.mode}`;
  }

  /** The keyboard's tree changes of one tree, while SAP's nodes of it stay the same. */
  private localOf(c: DiagControl): Map<string, boolean> | undefined {
    const l = this.local.get(c.id);
    if (!l) return undefined;
    if (!c.tree || c.tree.nodes.length !== l.count) {
      this.local.delete(c.id);
      return undefined;
    }
    return l.nodes;
  }

  /** The screen of this mode, with the keyboard's tree changes. */
  private screen(): DiagScreen {
    const s = this.conn.decoder.screen(this.mode);
    if (!this.conn.open) throw new ActionError("This SAP GUI connection is closed. Call sap_sessions to see what is open.");
    if (!s) throw new ActionError("No screen has come through the router for this session yet: press Enter in SAP GUI once.");
    if (!this.local.size) return s;
    return {
      ...s,
      windows: s.windows.map((w) => ({
        ...w,
        controls: w.controls.map((c) => {
          const nodes = this.localOf(c);
          if (!nodes || !c.tree) return c;
          return { ...c, tree: { ...c.tree, nodes: c.tree.nodes.map((x) => (nodes.has(x.key) ? { ...x, expanded: nodes.get(x.key) as boolean } : x)) } };
        }),
      })),
    };
  }

  async refresh(): Promise<SessionInfo> {
    this.info = describe(this.conn, this.mode, this.screen());
    return this.info;
  }

  async valid(): Promise<boolean> {
    return this.conn.open && !!this.conn.decoder.screen(this.mode);
  }

  async look(options: LookOptions): Promise<string> {
    // SAP's answer to the last step was lost or unreadable: any look (whole, by id, the menus) takes the last screen read as the state.
    const recovered = this.conn.traffic.recover(this.mode)
      ? "\nNOTE SAP's answer to the last step was lost or could not be read on the connection: this is the last screen read whole, and actions now go on from it. The session state is not known for sure: if SAP GUI shows another screen, press Enter in SAP GUI once and look again."
      : "";
    if (options.id?.trim().toLowerCase() === "mbar") return menuView(this.screen()) + recovered;
    if (options.id) return (await lookControl({ screen: () => this.screen(), scrollTo: (id, row) => this.scrollTo(id, row).then(() => undefined) }, options)) + recovered;
    const view = diagView(withTyped(this.screen(), this.typed()), options.compact ? {} : { maxRows: 100_000 });
    if (recovered) return view + recovered;
    return this.conn.traffic.pending(this.mode) ? `${view}\nNOTE SAP is still working on a step: this screen is from before it and will change. Look again in a moment, and act when the step has ended.` : view;
  }

  /** The values typed on the screen on show that SAP has not received yet; those of an earlier screen are dropped. */
  private typed(): Typed[] {
    const step = this.conn.steps.get(this.mode) ?? 0;
    const kept = (this.conn.typed.get(this.mode) ?? []).filter((t) => t.step === step);
    this.conn.typed.set(this.mode, kept);
    return kept;
  }

  async assess(action: Action): Promise<Assessment> {
    const s = this.screen();
    const target = resolveTarget(s, action);
    // An id that names nothing here is said as such, with the closest ids, not refused as a write the guard cannot see.
    if (!target && /^(set|focus|check|click|dblclick|press|select|f4)$/.test(action.do) && !((action.row !== undefined || action.node !== undefined) && namedControl(s, action.id)))
      throw new ActionError(noTargetText(s, String(action.id ?? action.name ?? "")));
    // Something SAP greys out is refused here, before the guard could ask the user to confirm it.
    const grey = greyedRefusal(s, action, target);
    if (grey) throw new ActionError(grey);
    // focus, f4, set or check where their first click would press, tick or open something: refused, not confirmed.
    const misuse = target && !((action.row !== undefined || action.node !== undefined) && namedControl(s, action.id)) ? plainMisuse(action, target) : undefined;
    if (misuse) throw new ActionError(misuse);
    return assessDiag(s, action, target);
  }

  timing(): string | undefined {
    const t = this.last;
    if (!t) return undefined;
    const other = Math.max(0, t.total - t.input - t.start - t.sap - t.settle);
    return `${t.total} ms: input ${t.input}, start ${t.start}, sap ${t.sap}, settle ${t.settle}, other ${other}; decoding ${t.decode} (${t.requests} request${t.requests === 1 ? "" : "s"})`;
  }

  /** The SAP GUI windows of this session (the session window, then its popups), with their screen areas. */
  private async windows(s: DiagScreen): Promise<WindowFacts[]> {
    const all = await this.host.request<{ windows: HostWindow[] }>("windows", {}, READ_TIMEOUT_MS);
    const title = s.windows[0]?.title ?? "";
    const routed = this.shared.routedTitles?.().filter((t) => t.replace(/\s+/g, " ").trim() === title.replace(/\s+/g, " ").trim()).length ?? 1;
    const facts = { key: this.key, title, routed, ...(s.message?.text ? { status: s.message.text } : {}), ...(s.session.system ? { system: s.session.system } : {}), ...(s.session.client ? { client: s.session.client } : {}) };
    const mine = pickWindow(all.windows, facts, this.shared.bound, this.shared.live);
    if (typeof mine === "string") throw new ActionError(mine);
    const res = await this.host.request<{ windows: WindowFacts[] }>("area", { session: mine.hwnd }, READ_TIMEOUT_MS);
    return res.windows;
  }

  /** The pixels of the windows: cells from the traffic (or a calibration, or the area's size), the Windows controls of the window acted on. */
  private geometry(s: DiagScreen, wins: WindowFacts[]): Geometry {
    const main = !active(s).modal;
    const top = wins[wins.length - 1] as WindowFacts;
    const env = cellsFromEnv(this.shared.env.SAP_DIAG_CELL);
    // A popup is the host window of its title: a dialog SAP GUI left with no owner (a dropped connection's error,
    // live 2026-11-20) is listed among the session's windows too, so the n-th one is not always the n-th popup.
    const titled = (w: DiagWindow) => (w.index > 0 ? wins.filter((x, i) => i > 0 && clean(x.title) === clean(w.title)) : []);
    const hostOf = (w: DiagWindow): WindowFacts => (main ? wins[0] : (titled(w).length === 1 ? titled(w)[0] : wins[w.index])) ?? top;
    const cellsOf = (w: DiagWindow): Cells => {
      const area = hostOf(w).area;
      if (!area) throw new ActionError("The screen area of this SAP GUI window was not found.");
      return cellMetrics(area as Rect, w.size, this.conn.traffic.font, env);
    };
    const acting = (main ? wins[0] : top) ?? top;
    return {
      at: (w, row, col, width = 1) => {
        const c = cellsOf(w);
        const [left, topPx] = hostOf(w).area as Rect;
        return [left + c.x0 + c.cw * col + Math.min(Math.floor((c.cw * Math.max(1, width)) / 2), 3 * c.cw), topPx + c.ch * row + c.y0];
      },
      get cells() {
        return cellsOf(active(s));
      },
      controls: (acting.controls ?? []) as { cls: string; rect: Rect }[],
    };
  }

  /** Sends one input to the host. */
  private async send(session: number | undefined, main: boolean, step: Step): Promise<void> {
    await this.host.request("act", { session, main, action: step }, READ_TIMEOUT_MS).catch((e) => {
      throw e instanceof HostError ? new ActionError(e.message) : e;
    });
  }

  /** Runs a plan: the inputs, then the wait for SAP's answer in the traffic, then the checks on the screen it brought. */
  private async run(s: DiagScreen, plan: Plan, wins: WindowFacts[], o: WaitOptions, t0: number): Promise<string> {
    const traffic = this.conn.traffic;
    const session = wins[0]?.hwnd;
    const main = !active(s).modal;
    const decode0 = traffic.decodeMs;
    const mark = traffic.mark();
    // A mark before the last input too: the request it makes is the one whose answer ends the wait.
    let last = mark;
    const tIn = Date.now();
    for (const [i, step] of plan.steps.entries()) {
      if (i === plan.steps.length - 1) last = traffic.mark();
      await this.send(session, main, step);
    }
    const inputEnd = Date.now();
    if (plan.tree) this.remember(plan.tree);
    let note = plan.note;
    let answered = false;
    const timing: ActTiming = { total: 0, input: inputEnd - tIn, start: 0, sap: 0, settle: 0, decode: 0, requests: 0 };
    if (plan.answer !== "no" && plan.steps.length) {
      const r = await traffic.wait(this.mode, mark, inputEnd, { ...o, requestMs: plan.answer === "yes" ? o.requestMs : MAYBE_REQUEST_MS }, plan.answer === "yes" ? last : mark);
      Object.assign(timing, { start: r.start, sap: r.sap, settle: r.settle, requests: r.requests });
      answered = r.answered;
      const miss = waitNote(r, { ...o, requestMs: plan.answer === "yes" ? o.requestMs : MAYBE_REQUEST_MS }, plan.answer === "yes");
      if (miss) note += `; ${miss}`;
    }
    const after = this.conn.decoder.screen(this.mode);
    if (answered && after) {
      for (const check of this.later.splice(0)) {
        const said = check(after);
        if (said) note += `; ${said}`;
      }
    }
    const confirm = plan.confirm?.(after ? this.screen() : undefined, answered);
    if (confirm) note += `; ${confirm}`;
    if (plan.later) this.later.push(plan.later);
    timing.decode = Math.round(traffic.decodeMs - decode0);
    timing.total = Date.now() - t0;
    this.last = timing;
    return note;
  }

  private remember(t: TreeChange): void {
    const c = this.conn.decoder
      .screen(this.mode)
      ?.windows.flatMap((w) => w.controls)
      .find((x) => x.id === t.shell);
    if (!c?.tree) return;
    const l = this.local.get(t.shell);
    const nodes = l && l.count === c.tree.nodes.length ? l.nodes : new Map<string, boolean>();
    nodes.set(t.node, t.expanded);
    this.local.set(t.shell, { count: c.tree.nodes.length, nodes });
  }

  /** Before an action: SAP must be done with the last step. */
  private async idle(): Promise<void> {
    const traffic = this.conn.traffic;
    if (!traffic.pending(this.mode)) return;
    if (!traffic.troubled(this.mode)) await traffic.wait(this.mode, -1, Date.now(), { requestMs: 0, answerMs: BUSY_MS, quietMs: 0, maxSettleMs: 0 });
    if (traffic.troubled(this.mode))
      throw new ActionError("SAP's answer to the last step was lost or could not be read on the connection, so the session state is unknown and nothing was sent. Look first (any sap_look, with or without an id): the look takes the last screen read as the state, and actions go on from there.");
    if (traffic.pending(this.mode)) throw new ActionError('SAP is still working on the last step. Look again in a moment (sap_look); a long step can be given more time with "timeout" (seconds).');
  }

  /**
   * Scrolls a control so that `row` (from 0) is on show, or by a word
   * (next, prev, first, last). Table controls and lists page with SAP's page
   * keys until the row is on show, each page confirmed by the next screen.
   */
  private async scrollTo(id: string, to: number | string, o: WaitOptions = waitOptions({}, this.shared.env, MAX_TIMEOUT_MS)): Promise<string> {
    const t0 = Date.now();
    let s = this.screen();
    let n = namedControl(s, id);
    if (!n) throw new ActionError(`No control "${id}" on this screen. It has: ${scrollables(s).map((x) => x.id).join(", ") || "nothing that scrolls"}.`);
    // A page key, or a grid's row fetch, sends what was typed: a scroll or a read must not.
    const typed = n.kind === "tree" ? [] : this.typed();
    if (typed.length)
      throw new ActionError(
        `${typed.length} change${typed.length === 1 ? "" : "s"} on this screen (${typed.map((t) => `${t.table ? `${t.name}[${t.table.index}]` : t.name}${t.checked !== undefined ? (t.checked ? " ticked" : " cleared") : " typed"}`).join(", ")}) ${typed.length === 1 ? "has" : "have"} not reached SAP yet, and scrolling ${n.id} would send ${typed.length === 1 ? "it" : "them"}: nothing was scrolled. Send ${typed.length === 1 ? "it" : "them"} first with Enter ({"do":"key","key":0}), then scroll or read again.`,
      );
    if (n.kind === "dropdown") throw new ActionError(`${n.id} is a dropdown: it does not scroll.`);
    if (n.kind === "tree") return `every node SAP sent of ${n.id} is in the view (sap_look with "id":"${n.id}" and "rows" reads any of them): nothing to scroll`;
    if (typeof to === "string" && ["right", "left", "rightmost", "leftmost"].includes(to)) throw new ActionError(`Scrolling sideways is not supported by the DIAG method: the view already has every column SAP sent.`);
    const wins = await this.windows(s);
    if (n.kind === "grid") return this.run(s, planGridScroll(n, to, this.geometry(s, wins)), wins, o, t0);
    const start = position(n);
    if (!start) throw new ActionError(`${n.id} does not scroll.`);
    const target = scrollTarget(to, start);
    let notes = "";
    for (let page = 0; page < 60; page++) {
      const plan = planPage(n, target, this.geometry(s, wins));
      if (!plan) break;
      const before = position(n)?.first;
      const said = await this.run(s, plan, wins, o, t0);
      s = this.screen();
      n = namedControl(s, id) as Named | undefined;
      if (!n) return `${said}; ${id} is gone from the screen`;
      if (position(n)?.first === before) {
        notes = `; ${n.id} did not move with SAP's page key (${said})`;
        break;
      }
    }
    const p = position(n);
    if (!p) return `scrolled ${id}`;
    const last = p.first + p.visible - 1;
    const where = `rows ${p.first} to ${p.total !== undefined ? Math.min(last, p.total - 1) : last}${p.total !== undefined ? ` of ${p.total}` : ""}`;
    return p.first === start.first ? `${n.id} is already there: ${where}${notes}` : `scrolled ${n.id}: ${where}${notes}`;
  }

  async act(action: Action): Promise<string> {
    const t0 = Date.now();
    let s = this.screen();
    if (isLogonScreen(s.windows[0]?.program, s.windows[0]?.dynpro)) throw new ActionError(LOGON_REFUSAL);
    await this.idle();
    s = this.screen();
    // Something SAP greys out is refused before any input.
    if (/^(press|click|dblclick|select|f4|check|key|okcode)$/.test(action.do)) {
      const grey = greyedRefusal(s, action, resolveTarget(s, action));
      if (grey) throw new ActionError(grey);
    }
    const o = waitOptions(action, this.shared.env, MAX_TIMEOUT_MS);
    const has = (v: unknown) => v !== undefined && v !== null && v !== "";
    // Without a choice, a dropdown only says what it can: no window is needed.
    if (action.do === "combo" && !has(action.key) && !has(action.value)) return planCombo(s, action, NO_GEOMETRY).note;
    if (action.do === "scroll") {
      let id = action.id;
      if (typeof id !== "string" || !id.trim()) {
        const all = scrollables(s);
        if (all.length !== 1) throw new ActionError(all.length ? `scroll needs "id": one of ${all.map((x) => x.id).join(", ")}.` : "Nothing on this screen scrolls: no grid, table, tree or list.");
        id = (all[0] as Named).id;
      }
      return this.scrollTo(id, (action.to ?? "next") as number | string, o);
    }
    // A table cell by the table's own row number: a row that is not on show is scrolled to first.
    const cell = /^(.+)\[(\d+)\]$/.exec(String(action.id ?? ""));
    if (cell && !resolveTarget(s, action)) {
      const table = active(s).tables.find((t) => t.columns.some((c) => c.name === cell[1]));
      if (table && !table.rows.some((r) => r.index === Number(cell[2])) && (table.totalRows === undefined || Number(cell[2]) < table.totalRows)) {
        const said = await this.scrollTo(table.name, Number(cell[2]), o);
        s = this.screen();
        // Never the n-th row on show instead: when the page keys did not bring row n, nothing is done.
        const again = active(s).tables.find((t) => t.name === table.name);
        if (!again?.rows.some((r) => r.index === Number(cell[2]))) throw new ActionError(`Row ${cell[2]} of the table ${table.name} is not on show after scrolling (${said}), so nothing was done in it. Look at the screen (sap_look) and scroll the table there first.`);
      }
    }
    const wins = await this.windows(s);
    const g = this.geometry(s, wins);
    const named = namedControl(s, action.id);
    const local = (n: Named | undefined) => (n?.kind === "tree" ? this.localOf(n.control) : undefined);
    let plan: Plan;
    switch (action.do) {
      case "combo":
        plan = planCombo(s, action, g);
        break;
      case "tree":
        plan = planTree(s, action, g, local(named));
        break;
      case "grid":
        plan = planGrid(s, action, g);
        break;
      case "toolbar": {
        let p = planToolbar(s, action, g);
        if (p === "need-buttons") {
          const r = await this.host.request<{ buttons: { name: string; tip: string; enabled: boolean; x: number; y: number }[] }>("buttons", { session: wins[0]?.hwnd }, READ_TIMEOUT_MS);
          p = planToolbar(s, action, g, r.buttons ?? []) as Plan;
        }
        // The guard judged the agent's word; the button found is judged too, and a write it was not rated as is refused.
        if (p.pressed && commitWord(...p.pressed) && assessDiag(s, action).risk !== "commit")
          throw new ActionError(`The button found for "${String(action.button ?? "")}" is "${clean(p.pressed[0] || p.pressed[1])}", which may write to SAP: nothing was pressed. Name it by its own text so that it is judged as what it is.`);
        plan = p;
        break;
      }
      default: {
        // A row of a table control or a grid, a tree node by "node" (the other surfaces' shape).
        if (named && (action.do === "select" || action.do === "dblclick" || action.do === "click") && (action.row !== undefined || action.node !== undefined)) {
          if (named.kind === "tree" && action.node !== undefined) plan = planTree(s, { ...action, do: "tree", how: action.do === "dblclick" ? "double" : "select" }, g, local(named));
          else if (named.kind === "grid") plan = planGrid(s, { ...action, do: "grid", how: action.do === "dblclick" ? "double" : action.do === "select" ? "select" : "cell" }, g);
          else if (named.kind === "table" && typeof action.row === "number") {
            if (!named.table.rows.some((r) => r.index === action.row)) {
              await this.scrollTo(named.table.name, action.row, o);
              s = this.screen();
            }
            const again = namedControl(s, named.id);
            if (again?.kind !== "table") throw new ActionError(`The table ${named.id} is gone from the screen.`);
            plan = planTableRow(again, action.row, g);
          } else throw new ActionError(`${named.id} is a ${named.kind}: "row" and "node" go with a table, a grid or a tree.`);
          break;
        }
        if (named?.kind === "dropdown" && action.do === "set") {
          plan = planCombo(s, { ...action, do: "combo", key: action.value }, g);
          break;
        }
        const target = resolveTarget(s, action);
        if (!target && /^(set|focus|check|click|dblclick|press|select|f4)$/.test(action.do)) throw new ActionError(noTargetText(s, String(action.id ?? action.name ?? "")));
        plan = planPlain(s, action, target, g, local(named));
        if (action.do === "set" && (target?.kind === "element" || target?.kind === "cell")) plan = { ...plan, note: this.keepTyped(target, String(action.value ?? ""), s) };
        // A box ticked without a function code stays in SAP GUI until the next Enter: kept like a typed value.
        if (action.do === "check" && plan.answer === "no" && (target?.kind === "element" || target?.kind === "cell")) this.keepTicked(target, s);
      }
    }
    const before = this.conn.steps.get(this.mode) ?? 0;
    // The typed values this step sends to SAP: checked on the screen it brings.
    const sent = plan.answer !== "no" && plan.steps.length ? (this.conn.typed.get(this.mode) ?? []).filter((x) => x.step === before) : [];
    const note = await this.run(s, plan, wins, o, t0);
    const after = this.conn.decoder.screen(this.mode);
    const moved = (this.conn.steps.get(this.mode) ?? 0) !== before;
    // The status bar is the view's (sbar line): the server puts an error, a warning or a termination first.
    const lines = [note];
    if (after && moved && sent.length) lines.push(...typedMisses(sent, after));
    // A termination message that was confirmed: SAP has ended the transaction, and the answer says so.
    if (after && moved && s.message?.type === "A" && after.message?.type !== "A")
      lines.push(`SAP ended transaction ${s.session.tcode ?? ""} after the termination message "${clean(s.message.text)}": input that was not saved there is lost. The screen below is where SAP went; start the transaction again to retry.`);
    return lines.join("\n");
  }

  /** Keeps the new state of a checkbox or radio button until SAP gets it with the next step. */
  private keepTicked(t: Extract<Target, { kind: "element" | "cell" }>, s: DiagScreen): void {
    const shown = withTyped(s, this.typed());
    const w = shown.windows[t.window.index];
    const now = t.kind === "element" ? w?.elements.find((x) => x.name === t.element.name && x.row === t.row && x.col === t.col) : w?.tables.find((x) => x.name === t.table)?.rows.find((r) => r.index === t.index)?.cells[t.column];
    const radio = now?.kind === "radio";
    const checked = radio ? true : !now?.checked;
    const step = this.conn.steps.get(this.mode) ?? 0;
    const name = t.kind === "element" ? t.element.name : (t.what.split(" ")[0] ?? "");
    const kept = this.typed().filter((x) => !(x.window === t.window.index && x.row === t.row && x.col === t.col && x.name === name));
    kept.push({ step, window: t.window.index, program: t.window.program, dynpro: t.window.dynpro, name, row: t.row, col: t.col, ...(t.kind === "cell" ? { table: { name: t.table, index: t.index, column: t.column } } : {}), value: "", checked });
    this.conn.typed.set(this.mode, kept);
  }

  /** Keeps a value typed into a field or a table cell until SAP gets it with the next step; the note of the set. */
  private keepTyped(t: Extract<Target, { kind: "element" | "cell" }>, value: string, s: DiagScreen): string {
    // SAP, and so this reader, sees the value with the next Enter: until then the view shows it as typed.
    const single = oneLine(value);
    const step = this.conn.steps.get(this.mode) ?? 0;
    const name = t.kind === "element" ? t.element.name : (t.what.split(" ")[0] ?? "");
    const typed = this.typed().filter((x) => !(x.window === t.window.index && x.row === t.row && x.col === t.col && x.name === name));
    typed.push({ step, window: t.window.index, program: t.window.program, dynpro: t.window.dynpro, name, row: t.row, col: t.col, ...(t.kind === "cell" ? { table: { name: t.table, index: t.index, column: t.column } } : {}), value: single.text });
    this.conn.typed.set(this.mode, typed);
    const notation = notationNote(single.text, diagView(s));
    return `set ${t.kind === "cell" ? `${name}[${t.index}]` : name || t.what} = "${single.text}" (typed; SAP gets it with the next Enter or function key)${single.had ? ` (${ONE_LINE_NOTE})` : ""}${notation ? ` (${notation})` : ""}`;
  }

  async screenshot(): Promise<Buffer> {
    const wins = await this.windows(this.screen());
    const r = await this.host.request<{ png: string }>("screenshot", { session: wins[0]?.hwnd }, READ_TIMEOUT_MS);
    return Buffer.from(r.png, "base64");
  }

  async close(): Promise<void> {}
}

/** Planning without a window: for a plan that sends nothing. */
const NO_GEOMETRY: Geometry = {
  at: () => {
    throw new ActionError("This action needs SAP GUI's window.");
  },
  get cells(): Cells {
    throw new ActionError("This action needs SAP GUI's window.");
  },
  controls: [],
};

function describe(c: Connection, mode: number, s: DiagScreen): SessionInfo {
  const info: SessionInfo = { id: `${PREFIX}${c.n}:${mode}`, surface: "sapgui", method: "diag", where: `SAP GUI connection to ${c.target.host}:${c.target.service} through the DIAG router, mode ${mode}` };
  if (s.session.system) info.system = s.session.system;
  if (s.session.client) info.client = s.session.client;
  if (s.session.user) info.user = s.session.user;
  if (s.session.tcode) info.transaction = s.session.tcode;
  if (s.windows[0]?.title) info.title = s.windows[0].title;
  return info;
}

/** What the decoders of the open connections could not read: lost traffic, encrypted messages, unknown items. Undefined when there is no connection. */
export function decodingCheck(conns: { decoder: DiagDecoder }[]): DoctorCheck | undefined {
  if (!conns.length) return undefined;
  let lost = 0;
  let losses = 0;
  const notes = new Map<string, number>();
  for (const c of conns) {
    lost += c.decoder.lostBytes;
    losses += c.decoder.losses;
    for (const [k, n] of c.decoder.notes) notes.set(k, (notes.get(k) ?? 0) + n);
  }
  const top = [...notes].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} (${n})`);
  const parts = [losses ? `${lost} bytes lost or garbled in transit, ${losses} time(s): the decoder found its place again` : "no traffic lost", notes.size ? `${[...notes.values()].reduce((a, b) => a + b, 0)} note(s) on what was not read: ${top.join("; ")}${notes.size > 5 ? "; …" : ""}` : "everything read"];
  const snc = [...notes.keys()].some((k) => k.startsWith("encrypted message"));
  if (snc) return { ok: false, check: "DIAG decoding", detail: parts.join("; "), fix: "The connection is encrypted with SNC, which the DIAG method cannot read. Use a connection entry without SNC, or another method." };
  return { ok: true, check: "DIAG decoding", detail: parts.join("; ") };
}

export interface DiagSurfaceOptions {
  port?: number;
  transport?: Transport;
  /** Where the router's messages go (a route refused, reading the traffic failed); stderr when not given. */
  log?: (m: string) => void;
}

/** The server's log: stderr, since stdout carries the MCP protocol. */
const stderrLog = (m: string): void => {
  process.stderr.write(`sap-gui-mcp DIAG router: ${m}\n`);
};

/** The most router messages doctor shows. */
const KEPT_EVENTS = 5;

/**
 * SAP_DIAG_CAPTURE=<folder>: a copy of the raw traffic, to debug the
 * decoder. Opt-in; it holds SAP data and the logon, so the file is made
 * readable by its owner only (0600, where the OS honours it). A capture that
 * fails is stopped and said (`failed`), never the decoding nor the logon.
 */
export class Capture {
  failed: string | undefined;
  private file: string | undefined;

  constructor(folder: string | undefined, name: string) {
    if (!folder) return;
    try {
      mkdirSync(folder, { recursive: true });
      this.file = join(folder, name);
      writeFileSync(this.file, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    } catch (e) {
      this.stop(e);
    }
  }

  get on(): boolean {
    return this.file !== undefined;
  }

  write(dir: 0 | 1, chunk: Buffer): void {
    if (!this.file) return;
    try {
      const head = Buffer.alloc(13);
      head[0] = dir;
      head.writeDoubleLE(Date.now() / 1000, 1);
      head.writeUInt32LE(chunk.length, 9);
      appendFileSync(this.file, Buffer.concat([head, chunk]), { mode: 0o600 });
    } catch (e) {
      this.stop(e);
    }
  }

  private stop(e: unknown): void {
    this.failed = `the capture (SAP_DIAG_CAPTURE) failed and was stopped; reading goes on: ${(e as Error).message}`;
    this.file = undefined;
  }
}

export function sapguiDiagSurface(env: Record<string, string | undefined>, options: DiagSurfaceOptions = {}): Surface & { router: Promise<Server> } {
  const port = options.port ?? Number(env.SAP_DIAG_PORT ?? 3298);
  const conns: Connection[] = [];
  let n = 0;
  // What the router said that went wrong (route refused, reading failed, capture failed), for doctor.
  const events: string[] = [];
  const say = options.log ?? stderrLog;
  const log = (m: string) => {
    if (!m.startsWith("routed to ")) {
      events.push(m);
      if (events.length > KEPT_EVENTS) events.shift();
    }
    try {
      say(m);
    } catch {
      // a log that fails never stops the traffic
    }
  };
  const router = startRouter({
    port,
    log,
    onConnection(target) {
      const c: Connection = { n: n++, target, decoder: new DiagDecoder(), open: true, traffic: new Traffic(), steps: new Map(), typed: new Map() };
      c.decoder.onScreen = (_s, mode) => {
        c.steps.set(mode, (c.steps.get(mode) ?? 0) + 1);
        c.traffic.screen(mode);
      };
      c.decoder.onTrouble = (mode) => c.traffic.trouble(mode);
      c.decoder.onServerMessage = (mode) => c.traffic.serverMessage(mode);
      conns.push(c);
      const capture = new Capture(env.SAP_DIAG_CAPTURE, `diag-${Date.now()}-${c.n}.bin`);
      let said = false;
      const sayCapture = () => {
        if (capture.failed && !said) {
          said = true;
          log(capture.failed);
        }
      };
      sayCapture();
      return {
        data: (dir, chunk) => {
          if (capture.on) {
            capture.write(dir, chunk);
            sayCapture();
          }
          // The tracker sees SAP GUI's requests before the decoder, and SAP's bytes before the screen they make.
          if (dir === 0) c.traffic.client(chunk);
          else c.traffic.server();
          const t = performance.now();
          c.decoder.push(dir, chunk);
          c.traffic.decodeMs += performance.now() - t;
        },
        close: () => {
          c.open = false;
          c.traffic.closed();
          // A closed connection is never listed again: let its screens go, so that memory does not grow with every logon.
          const at = conns.indexOf(c);
          if (at >= 0) conns.splice(at, 1);
        },
      };
    },
  });
  router.catch(() => {});
  let host: Transport | undefined = options.transport;
  const shared: DriverShared = {
    bound: new Map(),
    live: (key) => {
      const [cn, mode] = key.split(":").map(Number);
      const c = conns.find((x) => x.n === cn);
      return !!c?.open && c.decoder.screens().has(mode as number);
    },
    routedTitles: () => conns.filter((c) => c.open).flatMap((c) => [...c.decoder.screens().values()].map((x) => x.windows[0]?.title ?? "")),
    env,
  };
  const input = () => (host ??= new PsHost(env, { command: powershellExe(env), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INPUT_SCRIPT] }));
  return {
    name: "sapgui",
    router,
    async discover() {
      await router.catch(() => undefined);
      const out: SessionInfo[] = [];
      for (const c of conns) {
        if (!c.open) continue;
        for (const [mode, s] of c.decoder.screens()) out.push(describe(c, mode, s));
      }
      return out;
    },
    async open(info) {
      const m = /^sapgui:diag:(\d+):(\d+)$/.exec(info.id);
      const c = conns.find((x) => x.n === Number(m?.[1]));
      if (!m || !c) throw new ActionError("This SAP GUI session is gone. Call sap_sessions to see what is open.");
      return new DiagDriver(info, c, Number(m[2]), input(), shared);
    },
    async doctor(): Promise<DoctorCheck[]> {
      const checks: DoctorCheck[] = [];
      try {
        await router;
        checks.push({ ok: true, check: "DIAG router", detail: `listening on 127.0.0.1:${port}` });
      } catch (e) {
        checks.push({ ok: false, check: "DIAG router", detail: (e as Error).message, fix: `Port ${port} is taken: set SAP_DIAG_PORT to a free port.` });
      }
      const live = conns.filter((c) => c.open).length;
      checks.push(
        live
          ? { ok: true, check: "SAP GUI connections", detail: `${live} through the router` }
          : { ok: false, check: "SAP GUI connections", detail: "none through the router yet", fix: `In SAP Logon, edit the connection entry: put /H/127.0.0.1/S/${port} at the start of its SAProuter string, then log on again. Connections encrypted with SNC cannot be read.` },
      );
      const reading = decodingCheck(conns.filter((c) => c.open));
      if (reading) checks.push(reading);
      if (events.length) checks.push({ ok: false, check: "DIAG router messages", detail: events.join("; "), fix: "A refused route is a connection entry whose SAProuter string does not lead on from this router; a failed capture is a folder that cannot be written (SAP_DIAG_CAPTURE)." });
      return checks;
    },
  };
}
