/**
 * The text view of a DiagScreen, for an agent.
 *
 * A header line (transaction, program, screen, system, user, mode), then per
 * window a WINDOW line, its status bar, menus, keys and toolbar, and the
 * screen area: one line per row of the screen, `r<row>` first, the elements
 * of the row from left to right.
 *
 *   label text                      a label
 *   NAME@17="value"                 a read-only field: SAP field name, column, value
 *   NAME@17=[value]                 a field the user can type in ((required) when it must be filled)
 *   [x] text NAME@1                 a checkbox, (o) a radio button; (read-only) when it cannot be changed
 *   NAME@17=dropdown [key]          a dropdown: the selected key
 *   <text>{FCODE}@70                a push button and its function code
 *   -- text --                      a group box
 *
 * Row and column are character cells from the top left of the window's
 * screen area: what an action needs to place the cursor. Tabs give their
 * function code, a table control its columns (title and SAP field name)
 * and one line per row with the cells that hold something, a list one line
 * per list row, a grid its columns and rows, a tree its nodes on show, a
 * text editor its text. Long row sets are cut with a line that says how
 * many rows are left out.
 *
 * Left out, and in the model: read-only fields with no content, hidden
 * elements, tooltips of fields, the entries below the menu bar, what a
 * window behind a popup cannot do (its keys and toolbar).
 */
import type { DiagControl, DiagElement, DiagKey, DiagList, DiagScreen, DiagTable, DiagTabstrip, DiagWindow } from "./screen.js";

export interface DiagViewOptions {
  /** Rows shown per table, list, grid or tree before the rest is counted (default 50). */
  maxRows?: number;
  /** Menus, function keys and toolbar (default true). */
  chrome?: boolean;
}

const one = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();
const quote = (s: string): string => `"${one(s).replace(/"/g, '\\"')}"`;

function elementText(e: DiagElement): string {
  const at = `@${e.col}`;
  switch (e.kind) {
    case "label":
      return one(e.text || e.tooltip || "");
    case "group":
      return e.text ? `-- ${one(e.text)} --` : "";
    case "button":
      return `<${one(e.text || e.tooltip || e.name)}>${e.fcode ? `{${e.fcode}}` : ""}${at}`;
    case "checkbox":
    case "radio": {
      const box = e.kind === "checkbox" ? `[${e.checked ? "x" : " "}]` : `(${e.checked ? "o" : " "})`;
      return `${box} ${one(e.text || e.label || "")} ${e.name}${at}${e.input ? "" : " (read-only)"}`;
    }
    case "dropdown":
      return `${e.name}${at}=dropdown ${e.input ? `[${e.key ?? ""}]` : quote(e.key ?? "")}`;
    case "field":
      if (!e.input && !e.text) return "";
      return `${e.name}${at}=${e.input ? `[${one(e.text)}]` : quote(e.text)}${e.required ? " (required)" : ""}`;
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
  const filled = t.rows.filter((r) => !r.empty);
  const out = [`r${t.row}  table ${t.name}${t.title ? ` ${quote(t.title)}` : ""}  ${t.totalRows ?? t.rows.length} rows (${filled.length} with data on show), ${columns.length} columns: ${columns.map((c) => `${one(c.title || c.tooltip || "")} ${c.name}`.trim()).join(" | ")}`];
  for (const r of filled.slice(0, maxRows)) {
    const cells: string[] = [];
    for (const c of columns) {
      const cell = r.cells[c.index];
      if (!cell || cell.hidden) continue;
      if (cell.kind === "checkbox" || cell.kind === "radio") {
        if (cell.checked) cells.push(`${handle(c.index)}=[x]`);
      } else if (cell.text) cells.push(`${handle(c.index)}=${cell.input ? `[${one(cell.text)}]` : one(cell.text)}`);
    }
    out.push(`  row ${r.index} r${r.row}: ${cells.join("; ")}`);
  }
  if (filled.length > maxRows) out.push(`  ... ${filled.length - maxRows} more rows`);
  const empty = t.rows.filter((r) => r.empty);
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
    for (const n of shown.slice(0, maxRows * 4)) {
      const texts = [...new Set([n.text, ...Object.values(n.items)].map(one).filter(Boolean))].join(" | ");
      out.push(`  ${"  ".repeat(n.depth)}${n.folder ? (n.expanded ? "[-] " : "[+] ") : ""}${texts || "(no text)"}${n.key === c.tree.selected ? " (selected)" : ""}  {${n.key}}`);
    }
    if (shown.length > maxRows * 4) out.push(`  ... ${shown.length - maxRows * 4} more nodes on show`);
    const closed = c.tree.nodes.length - shown.length;
    if (closed > 0) out.push(`  (${closed} more nodes in closed folders)`);
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
    if (w.menus.length) out.push(`menu: ${w.menus.map((m) => one(m.text)).join(" | ")}`);
    if (top) {
      // A key that is also a toolbar button is written once, with the button's text.
      const toolbar = w.toolbar.filter((k) => k.enabled);
      const onToolbar = new Set(toolbar.map((k) => k.vkey));
      const keys = w.keys.filter((k) => k.enabled && !onToolbar.has(k.vkey));
      if (keys.length) out.push(`keys: ${keys.map(keyText).join(" | ")}`);
      if (toolbar.length) out.push(`toolbar: ${toolbar.map(keyText).join(" | ")}`);
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
export function diagView(s: DiagScreen, options: DiagViewOptions = {}): string {
  const o: Required<DiagViewOptions> = { maxRows: options.maxRows ?? 50, chrome: options.chrome ?? true };
  const main = s.windows[0];
  const head = [`TRANSACTION ${s.session.tcode ?? ""}`, `PROGRAM ${main?.program ?? ""}`, `SCREEN ${main?.dynpro.replace(/^0+(?=\d)/, "") ?? ""}`, `SYSTEM ${s.session.system ?? ""}${s.session.client ? ` (${s.session.client})` : ""}`, ...(s.session.user ? [`USER ${s.session.user}`] : []), `MODE ${s.mode}`];
  const out = [head.join("  ")];
  if (s.message?.text) out.push(`status  ${s.message.type ? `${s.message.type}: ` : ""}${one(s.message.text)}${s.message.id ? `  (${s.message.id} ${s.message.number ?? ""})` : ""}`);
  s.windows.forEach((w, i) => {
    out.push(...windowLines(w, i === s.windows.length - 1, o));
  });
  return out.join("\n");
}
