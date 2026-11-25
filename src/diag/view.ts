/**
 * The text view of a DiagScreen, for an agent.
 *
 * A header line (transaction, program, screen, system, user, mode), the
 * status bar in the form every surface writes it (`sbar  status  E: text`,
 * so the server puts an error, a warning or a termination first and keeps
 * it in an answer of changes only), then per window a WINDOW line, its
 * menus, keys and toolbar, and the screen area: one line per row of the
 * screen, `r<row>` first, the elements of the row from left to right.
 *
 *   label text                      a label
 *   NAME@17="value"                 a read-only field: SAP field name, column, value ("" when empty)
 *   NAME@17=[value]                 a field the user can type in ((required) when it must be filled)
 *   [x] text NAME@1                 a checkbox, (o) a radio button; (read-only) when it cannot be changed
 *   NAME@17=dropdown [key]          a dropdown: the selected key
 *   <text>{FCODE}@70                a push button and its function code
 *   -- text --                      a group box
 *
 * What SAP shows greyed out is kept and marked "(greyed out)": a push
 * button, a tree node, a top menu; keys and toolbar buttons are listed on a
 * line of their own. A value typed in SAP GUI that SAP has not received yet
 * (the surface marks it, `typed`) shows as `NAME@17=[value] (typed, sent
 * with the next Enter)`.
 *
 * Row and column are character cells from the top left of the window's
 * screen area: what an action needs to place the cursor. Tabs give their
 * function code, a table control its columns (title and SAP field name)
 * and one line per row with the cells that hold something (a column a row
 * line does not name is empty there, or unchecked), a list one line
 * per list row, a grid its columns and rows, a tree its nodes on show, a
 * text editor its text. Long row sets are cut with a line that says how
 * many rows are left out.
 *
 * Left out, and in the model: read-only fields with no content and no SAP name, hidden
 * elements, tooltips of fields, the entries below the menu bar (`menuView`
 * lists them), what a window behind a popup cannot do (its keys and
 * toolbar).
 */
import type { DiagControl, DiagElement, DiagKey, DiagList, DiagMenuEntry, DiagScreen, DiagStatus, DiagTable, DiagTabstrip, DiagWindow } from "./screen.js";
import { keyName } from "./text.js";

export interface DiagViewOptions {
  /** Rows shown per table, list, grid or tree before the rest is counted (default 50). */
  maxRows?: number;
  /** Menus, function keys and toolbar (default true). */
  chrome?: boolean;
}

const one = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();
const quote = (s: string): string => `"${one(s).replace(/"/g, '\\"')}"`;

/** What marks something SAP shows greyed out: it takes no click on this screen. */
export const GREYED = "(greyed out)";
/** What marks a value typed in SAP GUI that SAP has not received yet. */
export const TYPED = "(typed, sent with the next Enter)";

/**
 * The status bar line: `sbar  status  E: text  (V1 302)`, the form the
 * scripting and Web GUI views write, which the server reads (statusTop,
 * withStatus) and record/screen.ts parses. A termination (A) or exit (X)
 * message is marked: SAP ends the transaction.
 */
export function statusLine(m: DiagStatus): string {
  const mark = m.type === "A" ? "  (termination message: SAP ends the transaction when it is confirmed, and unsaved input is lost)" : m.type === "X" ? "  (exit message: SAP ended the transaction with a runtime error, and unsaved input is lost)" : "";
  return `sbar  status  ${m.type ? `${m.type}: ` : ""}${one(m.text)}${m.id ? `  (${m.id} ${m.number ?? ""})`.replace(/ \)$/, ")") : ""}${mark}`;
}

function elementText(e: DiagElement): string {
  const at = `@${e.col}`;
  switch (e.kind) {
    case "label":
      return one(e.text || e.tooltip || "");
    case "group":
      return e.text ? `-- ${one(e.text)} --` : "";
    case "button":
      // A push button that takes no input is one SAP greys out.
      return `<${one(e.text || e.tooltip || e.name)}>${e.fcode ? `{${e.fcode}}` : ""}${at}${e.input ? "" : ` ${GREYED}`}`;
    case "checkbox":
    case "radio": {
      const box = e.kind === "checkbox" ? `[${e.checked ? "x" : " "}]` : `(${e.checked ? "o" : " "})`;
      return `${box} ${one(e.text || e.label || "")} ${e.name}${at}${e.input ? "" : " (read-only)"}${e.typed ? " (ticked, sent with the next Enter)" : ""}`;
    }
    case "dropdown":
      return `${e.name}${at}=dropdown ${e.input ? `[${e.key ?? ""}]` : quote(e.key ?? "")}`;
    case "field":
      // An empty read-only field with a SAP name is kept (`NAME@17=""`): a check can say it is empty.
      if (!e.input && !e.text) return e.name ? `${e.name}${at}=""` : "";
      return `${e.name}${at}=${e.input ? `[${one(e.text)}]` : quote(e.text)}${e.typed ? ` ${TYPED}` : e.required ? " (required)" : ""}`;
    default:
      return e.text ? `${e.name}${at} ${one(e.text)}` : "";
  }
}

function keyText(k: DiagKey): string {
  const text = k.text && k.tooltip && k.tooltip !== k.text ? `${k.text}: ${k.tooltip}` : k.text || k.tooltip;
  return `${one(text)} (${k.key})`;
}

function tabLine(t: DiagTabstrip): string {
  return `r${t.row}  tabs ${t.name}: ${t.tabs.map((tab) => `${one(tab.text || tab.tooltip || tab.id)}${tab.active ? " (selected)" : ""} {${tab.fcode || tab.id}}`).join(" | ")}`;
}

function tableLines(t: DiagTable, maxRows: number): string[] {
  const columns = [...t.columns].sort((a, b) => a.position - b.position);
  const count = new Map<string, number>();
  for (const c of columns) count.set(c.title, (count.get(c.title) ?? 0) + 1);
  // A cell is named by its column title; by the SAP name too when the title is not unique.
  const handle = (i: number): string => {
    const c = t.columns[i];
    if (!c) return String(i);
    return c.title && count.get(c.title) === 1 ? c.title : `${c.title}(${c.name})`;
  };
  const filled = t.rows.filter((r) => !r.empty || r.cells.some((c) => c.typed));
  // With rows on show, the head lists the columns that hold something in them (VA03's item table has 109 columns,
  // most empty); the empty ones are counted. Without, every column, to type into.
  const holds = (i: number) => filled.some((r) => {
    const c = r.cells[i];
    return !!c && !c.hidden && (!!c.text || !!c.checked || !!c.typed);
  });
  const listed = filled.length ? columns.filter((c) => holds(c.index)) : columns;
  const rest = columns.length - listed.length;
  const out = [`r${t.row}  table ${t.name}${t.title ? ` ${quote(t.title)}` : ""}  ${t.totalRows ?? t.rows.length} rows (${filled.length} with data on show), ${columns.length} columns: ${listed.map((c) => `${one(c.title || c.tooltip || "")} ${c.name}`.trim()).join(" | ")}${rest ? ` | (${rest} more, empty in the rows on show)` : ""}`];
  for (const r of filled.slice(0, maxRows)) {
    const cells: string[] = [];
    for (const c of columns) {
      const cell = r.cells[c.index];
      if (!cell || cell.hidden) continue;
      if (cell.kind === "checkbox" || cell.kind === "radio") {
        if (cell.checked || cell.typed) cells.push(`${handle(c.index)}=[${cell.checked ? "x" : " "}]${cell.typed ? " (ticked, sent with the next Enter)" : ""}`);
      } else if (cell.kind === "button" && !cell.text) continue;
      else if (cell.kind === "button" || cell.kind === "other") cells.push(`${handle(c.index)}=<${one(cell.text)}>${cell.kind === "other" ? " (element this reader cannot classify)" : ""}`);
      else if (cell.text || cell.typed) cells.push(`${handle(c.index)}=${cell.input ? `[${one(cell.text)}]` : one(cell.text)}${cell.typed ? ` ${TYPED}` : ""}`);
    }
    out.push(`  row ${r.index} r${r.row}: ${cells.join("; ")}`);
  }
  if (filled.length > maxRows) out.push(`  ... ${filled.length - maxRows} more rows`);
  const empty = t.rows.filter((r) => !filled.includes(r));
  if (empty.length) out.push(`  (${empty.length} empty ${empty.length === 1 ? "row" : "rows"} below, from r${empty[0]?.row}${empty.some((r) => r.cells.some((c) => c.input && !c.hidden)) ? ", open for input" : ""})`);
  return out;
}

function listLines(list: DiagList, maxRows: number): string[] {
  const rows = [...list.rows].sort((a, b) => a.row - b.row);
  // Rows that share their columns (a table drawn as a list) are written without the column of each cell.
  const count = new Map<string, number>();
  for (const r of rows) {
    const sig = r.cells.map((c) => c.col).join(",");
    count.set(sig, (count.get(sig) ?? 0) + 1);
  }
  const [shared, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const regular = n >= 3 && n * 10 >= rows.length * 4 && shared.includes(",") ? shared : undefined;
  const total = list.totalRows !== undefined && list.totalRows > rows.length ? `${list.totalRows} rows, ${rows.length} on show` : `${rows.length} rows`;
  const out = [`list  ${total}${regular ? `; columns at ${regular.split(",").map((c) => `c${c}`).join(" ")}` : ""}`];
  for (const r of rows.slice(0, maxRows)) {
    const sig = r.cells.map((c) => c.col).join(",");
    const cell = (text: string, tip?: string) => one(text || tip || "");
    out.push(`r${r.row}  ${r.cells.map((c) => (sig === regular ? cell(c.text, c.tooltip) : `${cell(c.text, c.tooltip)}@${c.col}`)).join(" | ")}`);
  }
  if (rows.length > maxRows) out.push(`  ... ${rows.length - maxRows} more rows on show`);
  return out;
}

/**
 * A node's texts. In a column tree whose items are named "C <n>" (MMBE's stock overview: "C          1" is the
 * first column after the hierarchy), each value goes with its column's heading: "Full | Unrestricted use=312,000 |
 * Reserved=100,000". Otherwise the distinct texts.
 */
function treeTexts(n: { text: string; items: Record<string, string> }, headers: string[]): string {
  const entries = Object.entries(n.items);
  const numbered = headers.length > 1 && entries.length > 1 && entries.every(([k]) => k.startsWith("&") || /^C\s*\d+$/.test(k));
  if (!numbered) return [...new Set([n.text, ...entries.map(([, v]) => v)].map(one).filter(Boolean))].join(" | ");
  const parts = [one(n.text)];
  for (const [k, v] of entries) {
    const i = /^C\s*(\d+)$/.exec(k);
    if (!i || !one(v)) continue;
    const head = headers[Number(i[1])];
    parts.push(head ? `${one(head)}=${one(v)}` : one(v));
  }
  return parts.filter(Boolean).join(" | ");
}

/** The most nodes of a tree shown whole, closed folders included. */
const WHOLE_TREE = 40;

function controlLines(c: DiagControl, maxRows: number): string[] {
  const where = `${c.area ? `r${c.area.row}  ` : ""}`;
  const id = `${c.container ?? (c.dynpro ? "value-help" : "")} (shell ${c.id})`.trim();
  if (c.grid) {
    const g = c.grid;
    const out = [`${where}grid ${id}  ${g.totalRows} rows, ${g.columns.length} columns: ${g.columns.map((col) => `${col.name}=${[col.title, ...col.titles.filter((t) => t !== col.title)].map(one).join(" / ")}`).join(" | ")}`];
    for (const r of g.rows.slice(0, maxRows)) out.push(`  row ${r.index}: ${r.cells.map(one).join(" | ")}`);
    const rest = g.totalRows - Math.min(g.rows.length, maxRows);
    if (rest > 0) out.push(`  ... ${rest} more rows${g.rows.length < g.totalRows ? ` (${g.rows.length} sent so far; the grid loads the others when scrolled)` : " (all sent; a higher maxRows shows them)"}`);
    return out;
  }
  if (c.tree) {
    const shown: typeof c.tree.nodes = [];
    const open = new Map<string, boolean>([["", true]]);
    for (const n of c.tree.nodes) {
      const visible = (open.get(n.parent) ?? false) && !n.hidden;
      open.set(n.key, visible && n.expanded);
      if (visible) shown.push(n);
    }
    const out = [`${where}tree ${id}  ${shown.length} nodes on show${c.tree.headers.length ? `; columns: ${c.tree.headers.map(one).join(" | ")}` : ""}`];
    // SAP often sends the nodes of closed folders too (MMBE's stock levels): a small tree is shown whole, those
    // marked. A large one (the SAP menu) only as it is on show.
    const budget = maxRows * 4;
    const whole = c.tree.nodes.length <= Math.min(budget, WHOLE_TREE);
    const on = new Set(shown);
    for (const n of (whole ? c.tree.nodes : shown).slice(0, budget)) {
      if (n.hidden) continue;
      const texts = treeTexts(n, c.tree.headers);
      // Keys are written without SAP's leading blanks ("          1" is {1}); the actions take them either way.
      out.push(`  ${"  ".repeat(n.depth)}${n.folder ? (n.expanded ? "[-] " : "[+] ") : ""}${texts || "(no text)"}${n.key === c.tree.selected ? " (selected)" : ""}${n.disabled ? ` ${GREYED}` : ""}${on.has(n) ? "" : " (in a closed folder)"}  {${n.key.trim()}}`);
    }
    if (shown.length > budget) out.push(`  ... ${shown.length - budget} more nodes on show`);
    const closed = c.tree.nodes.length - shown.length;
    if (closed > 0 && !whole) out.push(`  (${closed} more nodes in closed folders)`);
    return out;
  }
  if (c.kind === "text") return [`${where}text-editor ${id}${c.readOnly ? " (read-only)" : ""}  ${quote(c.text ?? "")}`];
  if (c.kind === "container" || c.kind === "splitter") return [];
  return [`${where}control ${id}  ${c.type}`];
}

function windowLines(w: DiagWindow, top: boolean, o: Required<DiagViewOptions>): string[] {
  const place = w.position ? `  at r${w.position.row} c${w.position.col}` : "";
  const out = [`WINDOW ${w.index}${w.modal ? " popup" : ""}  ${quote(w.title)}${w.index > 0 ? `  ${w.program} ${w.dynpro}` : ""}${place}  area ${w.size.rows}x${w.size.cols}`];
  if (o.chrome) {
    if (w.menus.length) out.push(`menu: ${w.menus.map((m) => `${one(m.text)}${m.enabled ? "" : ` ${GREYED}`}`).join(" | ")}${w.index === 0 ? '  (every entry: sap_look id "mbar")' : ""}`);
    if (top) {
      // A key that is also a toolbar button is written once, with the button's text.
      const toolbar = w.toolbar.filter((k) => k.enabled);
      const onToolbar = new Set(toolbar.map((k) => k.vkey));
      const keys = w.keys.filter((k) => k.enabled && !onToolbar.has(k.vkey));
      if (keys.length) out.push(`keys: ${keys.map(keyText).join(" | ")}`);
      if (toolbar.length) out.push(`toolbar: ${toolbar.map(keyText).join(" | ")}`);
      // Greyed out: on the screen, and taking no click. Said, so that "not here" and "not now" differ.
      const offered = new Set([...toolbar, ...keys].map((k) => k.vkey));
      const grey = [...w.toolbar, ...w.keys].filter((k, i, all) => !k.enabled && !offered.has(k.vkey) && (k.text || k.tooltip) && all.findIndex((x) => x.vkey === k.vkey) === i);
      if (grey.length) out.push(`greyed out (SAP does not offer it on this screen): ${grey.map(keyText).join(" | ")}`);
    } else out.push("(behind the popup: its keys and toolbar are left out)");
  }
  // Everything of the screen area by row; within a row, the plain elements first.
  const blocks: { row: number; order: number; lines: string[] }[] = [];
  const rows = new Map<string, DiagElement[]>();
  for (const e of w.elements) {
    if (e.hidden) continue;
    const key = `${e.row}${e.scrolledOut ? " (scrolled out of view)" : ""}`;
    const row = rows.get(key) ?? [];
    rows.set(key, row);
    row.push(e);
  }
  for (const [key, elements] of rows) {
    const parts = elements
      .sort((a, b) => a.col - b.col)
      .map(elementText)
      .filter(Boolean);
    if (parts.length) blocks.push({ row: elements[0]?.row ?? 0, order: key.includes(" ") ? 4 : 0, lines: [`r${key}  ${parts.join("  ")}`] });
  }
  for (const t of w.tabstrips) blocks.push({ row: t.row, order: 1, lines: [tabLine(t)] });
  for (const t of w.tables) blocks.push({ row: t.row, order: 2, lines: tableLines(t, o.maxRows) });
  for (const c of w.controls) {
    const lines = controlLines(c, o.maxRows);
    if (lines.length) blocks.push({ row: c.area?.row ?? Number.MAX_SAFE_INTEGER, order: 3, lines });
  }
  blocks.sort((a, b) => a.row - b.row || a.order - b.order);
  for (const b of blocks) out.push(...b.lines);
  if (w.list?.rows.length) out.push(...listLines(w.list, o.maxRows));
  if (w.focus) out.push(`cursor: r${w.focus.row} c${w.focus.col}${w.focus.name ? ` ${w.focus.name}` : ""}`);
  return out;
}

/** The view of a screen: see the top of this file for the format. */
/** One short line each when bytes were lost before the screen, or when the decoder met parts it could not read. */
/** The start of the line a view ends with when bytes were lost: the recorder and the replay look for it. */
export const DAMAGED_NOTE = "note  bytes were lost on the connection";

function decoderNotes(s: DiagScreen): string[] {
  const out: string[] = [];
  if (s.damaged) out.push(`${DAMAGED_NOTE} while SAP sent this screen or earlier: parts of it may be missing or old. A control SAP sends again is read afresh.`);
  // What the decoder met and could not read: said plainly, with its technical name in parentheses (for doctor and bug reports).
  if (s.unread?.length) out.push(`note  SAP sent something with this screen that this reader cannot read yet (${s.unread.slice(0, 3).join("; ")}${s.unread.length > 3 ? `; and ${s.unread.length - 3} more` : ""}); everything else is shown`);
  return out;
}

export function diagView(s: DiagScreen, options: DiagViewOptions = {}): string {
  const o: Required<DiagViewOptions> = { maxRows: options.maxRows ?? 50, chrome: options.chrome ?? true };
  const main = s.windows[0];
  const head = [`TRANSACTION ${s.session.tcode ?? ""}`, `PROGRAM ${main?.program ?? ""}`, `SCREEN ${main?.dynpro.replace(/^0+(?=\d)/, "") ?? ""}`, `SYSTEM ${s.session.system ?? ""}${s.session.client ? ` (${s.session.client})` : ""}`, ...(s.session.user ? [`USER ${s.session.user}`] : []), `MODE ${s.mode}`];
  const out = [head.join("  ")];
  if (s.message?.text) out.push(statusLine(s.message));
  s.windows.forEach((w, i) => {
    out.push(...windowLines(w, i === s.windows.length - 1, o));
  });
  out.push(...decoderNotes(s));
  return out.join("\n");
}

/**
 * Every entry of the main window's menu bar (`sap_look id "mbar"`), as the
 * Web GUI lists them: indented by level, with the key that runs an entry
 * and what SAP greys out.
 */
export function menuView(s: DiagScreen): string {
  const menus = s.windows[0]?.menus ?? [];
  if (!menus.length) return "mbar  menubar  (this screen has no menu bar the server can read)";
  const out = ['mbar  menubar  every entry; an entry with a key runs with {"do":"key","key":"<key>"}'];
  const walk = (entries: DiagMenuEntry[], depth: number, grey: boolean) => {
    for (const m of entries) {
      if (m.separator || !m.text) continue;
      const off = grey || !m.enabled;
      out.push(`  ${"  ".repeat(depth)}${one(m.text)}${m.vkey !== undefined ? ` (${keyName(m.vkey)})` : ""}${off ? "  (greyed out: SAP does not offer it on this screen)" : ""}`);
      walk(m.children, depth + 1, off);
    }
  };
  walk(menus, 0, false);
  return out.join("\n");
}
