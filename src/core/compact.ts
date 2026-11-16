/**
 * The compact view of an SAP screen, from the full view.
 *
 * The SAP GUI reader and the Web GUI reader produce the same full format: a
 * header line, a `WINDOW` line per window, then one control per line,
 * `<scripting id>  <type>  <label and value>  <state>`. This one function
 * shortens both. Nothing the screen shows is dropped without a way to get
 * it; what each rule leaves out, and how to get it, is said below.
 *
 * - **Handles.** An id is cut to its last segment when that is unique on
 *   the screen, else to the shortest handle that is (core/ids.ts). Actions
 *   resolve handles.
 * - **Table controls.** The cells become one line per row, with only the
 *   cells that hold a value; a checkbox appears when checked.
 * - **Lists.** The cells of a classic list (`lbl[col,row]`) become one line
 *   per row of the list, each cell with its column in braces; rows that share
 *   their columns (a table drawn as a list) are written without them.
 * - **Repeated buttons.** Buttons that differ only by the field they belong
 *   to ("Multiple selection" on a selection screen) share one line, with the
 *   names in braces. Toolbar buttons keep a line each, with their whole name
 *   and key: putting a toolbar on one line saved nothing once the ids were
 *   short (measured), and leaving the key out lost what an icon button shows.
 * - **Dropdowns.** The current entry and the number of entries; the entries
 *   come from `{"do":"combo","id":...}` without a key, or sap_look with the
 *   dropdown's id.
 * - **Grids.** Columns that are empty in every row shown are named once,
 *   with their titles, instead of repeated as empty cells.
 * - **Behind a popup,** the main window keeps only what it shows (fields
 *   with a value, checked boxes, the selected tab, the status bar): buttons,
 *   menus, empty fields and list rows there cannot be used until the popup
 *   is closed. The full view still has them.
 * - **Very large screens.** When the view is longer than `maxChars`, the row
 *   lines of its longest controls are cut, each with a line that says how
 *   many are left out and how to get them (sap_look with the control's id).
 */
import { shortIds } from "./ids.js";

export interface CompactOptions {
  /** Shortest unique handles (default). False: the last segment when unique, else the path below the user area. */
  handles?: boolean;
  /** Buttons that differ only by their field on one line (default true). */
  repeatedButtons?: boolean;
  /** Dropdown entries as a count (default true). */
  dropdowns?: boolean;
  /** List cells as one line per list line (default true). */
  lists?: boolean;
  /** List lines that share their columns written without the column of each cell (default true). */
  listColumns?: boolean;
  /** Empty grid columns named once (default true). */
  emptyColumns?: boolean;
  /** Table rows without the table's id on every line (default true). */
  shortRows?: boolean;
  /** Empty table rows in a run on one line (default true). */
  emptyRuns?: boolean;
  /** Cut row lines when the view is longer than this many characters; 0 never cuts (default 20000). */
  maxChars?: number;
  /**
   * For a view of one control (`controlBlock`): the full view of the screen
   * it is on, so that its handle is the one the screen's view shows.
   */
  screen?: string;
}

export const DEFAULT_MAX_CHARS = 20_000;

/** Is this line of the screen behind a popup worth keeping? */
function keepBehind(l: string): boolean {
  if (/\bsbar\b|  status  /.test(l)) return true;
  // A table's own line: its rows behind the popup keep their column titles.
  if (/^\S+  table  rows /.test(l)) return true;
  if (/= "[^"]+"/.test(l)) return true;
  if (/\[x\]|\(selected\)/.test(l)) return true;
  return false;
}

/** Shortens the main window while a popup (wnd[1] and up, or a browser dialog) is open. */
function trimBehindPopups(lines: string[]): string[] {
  const popup = lines.some((l) => /^WINDOW (wnd\[[1-9]\d*\]|browser)(\s|$)/.test(l));
  if (!popup) return lines;
  const out: string[] = [];
  let behind = false;
  let dropped = 0;
  const flush = () => {
    if (dropped) out.push(`  (${dropped} more lines behind the popup: buttons, menus, empty fields, list rows; sap_look full=true shows them)`);
    dropped = 0;
  };
  for (const l of lines) {
    if (l.startsWith("WINDOW ")) {
      flush();
      behind = /^WINDOW wnd\[0\]/.test(l);
      out.push(l);
      continue;
    }
    if (behind && !keepBehind(l)) {
      dropped++;
      continue;
    }
    out.push(l);
  }
  flush();
  return out;
}

const CELL = /^(?<tbl>.*\/tbl[^/[]+)\/(?<ctl>[a-z]+)(?<name>[^[\s]+)\[(?<c>\d+),(?<r>\d+)\]\s+(?<rest>.*)$/;
/** A cell of a classic list: a label, checkbox or field directly in the user area, named by column and line. */
const LIST_CELL = /^(?<area>wnd\[\d+\]\/usr)\/(?<ctl>lbl|chk|txt|ctxt)\[(?<c>\d+),(?<r>\d+)\]$/;
/** The id of a control line: everything before the first two spaces. */
const idOf = (line: string): string => line.split("  ", 1)[0] ?? "";
const lastSegment = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/** The handles of the view before core/ids.ts: the last segment when unique, else the path below the user area. */
function plainHandles(ids: string[]): Map<string, string> {
  const last = new Map<string, number>();
  for (const id of ids) last.set(lastSegment(id), (last.get(lastSegment(id)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const id of new Set(ids)) {
    const seg = lastSegment(id);
    const unique = last.get(seg) === 1 && seg !== "" && !/^(btn\[|shell|menu\[)/.test(seg);
    out.set(id, unique ? seg : id.includes("/usr/") ? id.slice(id.indexOf("/usr/") + 5) : id);
  }
  return out;
}

/** One line of the result while it is built: text, or a line that is filled in at the end. */
type Out = string | { cells: string[]; prefix: string; table?: Table; r?: number } | { list: List; r?: number } | { table: Table };

/** A table control: what its own line says, and what its cells say about its columns. */
interface Table {
  id: string;
  /** Its line in the compact view, without the columns. */
  head: string;
  /** Column titles by column number (the table line names every column, drawn or not). */
  titles: string[];
  /** Rows (on screen) its line says are selected. */
  selected: Set<number>;
  /** Columns that have cells on screen: their cell id (ctxtVBAK-MATNR) and in which rows they are read-only or editable. */
  columns: Map<number, { id: string; ro: Set<number>; edit: Set<number> }>;
  /** Row 0 here is this row of the table. */
  first: number;
}

/** Up to `n` numbers, then "...". */
const some = (xs: number[], n = 5) => `${xs.slice(0, n).join(",")}${xs.length > n ? ",..." : ""}`;

/** The column legend of a table: the id of each column on screen, and which columns are scrolled out. */
function legend(t: Table): string {
  const drawn = [...t.columns.keys()].sort((a, b) => a - b);
  if (!drawn.length) return t.titles.length ? `  columns: ${t.titles.map((x, i) => `${i} ${x || "?"}`).join(", ")}` : "";
  const parts = drawn.map((c) => {
    const col = t.columns.get(c)!;
    const ro = [...col.ro].sort((a, b) => a - b);
    const state = ro.length && !col.edit.size ? " (read-only)" : ro.length ? ` (read-only in rows ${some(ro)})` : "";
    return `${c} ${t.titles[c] || col.id.replace(/^[a-z]+/, "")}=${col.id}${state}`;
  });
  const lo = drawn[0] ?? 0;
  const hi = drawn[drawn.length - 1] ?? 0;
  const left = t.titles.map((x, i) => ({ x, i })).filter((c) => c.i < lo && !t.columns.has(c.i));
  const right = t.titles.map((x, i) => ({ x, i })).filter((c) => c.i > hi && !t.columns.has(c.i));
  const names = (cs: { x: string; i: number }[]) => `${cs.slice(0, 12).map((c) => c.x || "?").join(", ")}${cs.length > 12 ? ", ..." : ""}`;
  const out = [`  columns: ${parts.join(", ")}`];
  if (left.length) out.push(`; ${left.length} more to the left (scroll "to":"left"): ${names(left)}`);
  if (right.length) out.push(`; ${right.length} more to the right (scroll "to":"right"): ${names(right)}`);
  return out.join("");
}

/** A classic list: its cells by line. */
interface List {
  /** Id of the user area that holds it. */
  area: string;
  /** What the reader said about it (how many lines, where it is scrolled to); "" when it said nothing. */
  text: string;
  lines: Map<number, { c: number; text: string }[]>;
}

/**
 * The columns most lines of a list share (a table drawn as a list), when at
 * least three lines and four in ten do: those lines are then written without
 * the column of each cell.
 */
function sharedColumns(list: List): string | undefined {
  const count = new Map<string, number>();
  for (const cells of list.lines.values()) {
    const sig = cells.map((x) => x.c).join(",");
    count.set(sig, (count.get(sig) ?? 0) + 1);
  }
  const [sig, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return n >= 3 && n * 10 >= list.lines.size * 4 && sig.includes(",") ? sig : undefined;
}

/**
 * Buttons of the screen with one text and ids that differ in one place only
 * (`btn%_SVBELN_%_APP_%-VALU_PUSH`, `btn%_SAUART_%_APP_%-VALU_PUSH`...): one
 * line, the differing part in braces.
 */
function foldRepeatedButtons(lines: string[]): string[] {
  const groups = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (l.startsWith(" ") || l.startsWith("WINDOW ")) return;
    const [id = "", kind = "", ...rest] = l.split("  ");
    if (kind !== "button" || /btn\[\d+\]$/.test(id)) return;
    const key = rest.join("  ");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(i);
  });
  const drop = new Set<number>();
  const replace = new Map<number, string>();
  for (const [text, at] of groups) {
    if (at.length < 3) continue;
    const ids = at.map((i) => idOf(lines[i] ?? ""));
    const first = ids[0] ?? "";
    let pre = 0;
    while (pre < first.length && ids.every((x) => x[pre] === first[pre])) pre++;
    let suf = 0;
    while (suf < first.length - pre && ids.every((x) => x.length - suf > pre && x[x.length - 1 - suf] === first[first.length - 1 - suf])) suf++;
    const mids = ids.map((x) => x.slice(pre, x.length - suf));
    if (pre + suf < 4 || mids.some((m) => !m || /[{},]/.test(m)) || new Set(mids).size !== mids.length) continue;
    replace.set(at[0] as number, `${first.slice(0, pre)}{${mids.join(",")}}${first.slice(first.length - suf)}  button  ${text}  (${at.length} buttons: one id per name in braces)`);
    for (const i of at.slice(1)) drop.add(i);
  }
  return lines.flatMap((l, i) => (drop.has(i) ? [] : [replace.get(i) ?? l]));
}

/** Names the columns of a grid that are empty in every row shown, instead of repeating empty cells. */
function foldEmptyColumns(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i] ?? "";
    const m = /^(.*  grid  .*; columns: )(.*)$/.exec(head);
    if (!m || head.startsWith(" ")) {
      out.push(head);
      continue;
    }
    const cols = (m[2] ?? "").split(" | ");
    const rows: { prefix: string; cells: string[] }[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const r = /^( {2}row \d+(?: \(selected\))?: )(.*)$/.exec(lines[j] ?? "");
      if (!r) break;
      rows.push({ prefix: r[1] ?? "", cells: (r[2] ?? "").split(" | ") });
    }
    const regular = rows.length > 0 && rows.every((r) => r.cells.length === cols.length);
    const empty = regular ? cols.map((_, c) => rows.every((r) => !r.cells[c])) : [];
    if (empty.filter(Boolean).length < 3) {
      out.push(head);
      continue;
    }
    const keep = cols.map((_, c) => c).filter((c) => !empty[c]);
    // Named with their titles: a column that holds nothing here is still a column of the list.
    const gone = cols.filter((_, c) => empty[c]);
    out.push(`${m[1]}${keep.map((c) => cols[c]).join(" | ")}; empty in these rows: ${gone.join(" | ")}`);
    for (const r of rows) out.push(`${r.prefix}${keep.map((c) => r.cells[c]).join(" | ")}`);
    i = j - 1;
  }
  return out;
}

/** Cuts the row lines of the longest controls until the view fits `maxChars`. */
function fit(lines: string[], maxChars: number): string[] {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (!maxChars || total <= maxChars) return lines;
  interface Block {
    head: number;
    rows: number[];
  }
  const blocks: Block[] = [];
  let current: Block | undefined;
  lines.forEach((l, i) => {
    if (l.startsWith("  ") && current && !l.startsWith("  (") && !l.startsWith("  ...")) current.rows.push(i);
    else if (!l.startsWith(" ")) {
      current = { head: i, rows: [] };
      blocks.push(current);
    }
  });
  const MIN = 8;
  const long = blocks.filter((b) => b.rows.length > MIN);
  const rowChars = long.reduce((n, b) => n + b.rows.reduce((m, i) => m + (lines[i]?.length ?? 0) + 1, 0), 0);
  if (!rowChars) return lines;
  const ratio = Math.max(0, (maxChars - (total - rowChars)) / rowChars);
  const drop = new Set<number>();
  const notes = new Map<number, string>();
  for (const b of long) {
    const keep = Math.max(MIN, Math.floor(b.rows.length * ratio));
    if (keep >= b.rows.length) continue;
    for (const i of b.rows.slice(keep)) drop.add(i);
    const id = idOf(lines[b.head] ?? "");
    notes.set(b.rows[keep - 1] as number, `  ... ${b.rows.length - keep} more lines of ${id} are left out to keep the view short: sap_look with id "${id}" shows it whole`);
  }
  return lines.flatMap((l, i) => (drop.has(i) ? [] : notes.has(i) ? [l, notes.get(i) as string] : [l]));
}

export function compact(full: string, options: CompactOptions = {}): string {
  const opt: CompactOptions = { handles: true, repeatedButtons: true, dropdowns: true, lists: true, listColumns: true, emptyColumns: true, shortRows: true, emptyRuns: true, maxChars: DEFAULT_MAX_CHARS, ...options };
  const lines = trimBehindPopups(full.split("\n"));
  const ids = (opt.screen === undefined ? lines : opt.screen.split("\n")).filter((l) => l.startsWith("wnd[")).map(idOf);
  const handles = opt.handles ? shortIds(ids) : plainHandles(ids);
  const short = (id: string) => handles.get(id) ?? id;

  const tables = new Map<string, Table>();
  const tableRows = new Map<string, string[]>();
  const lists = new Map<string, List>();
  const out: Out[] = [];
  for (const l of lines) {
    if (!l.startsWith("wnd[")) {
      out.push(l);
      continue;
    }
    const id = idOf(l);
    const rest = l.slice(id.length + 2);

    const g = CELL.exec(l)?.groups;
    if (g) {
      const tbl = g.tbl ?? "";
      const cellRest = g.rest ?? "";
      const c = Number(g.c);
      const r = Number(g.r);
      const t = tables.get(tbl);
      const col = t?.titles[c] || (g.name ?? "");
      let cell: string | null = null;
      if (cellRest.startsWith("checkbox")) cell = `${col} ${cellRest.includes("[x]") ? "[x]" : "[ ]"}`;
      else if (cellRest.startsWith("dropdown")) {
        // A dropdown cell: the entry's text, else its key.
        const v = /= "(.*?)"(.*)$/.exec(cellRest.replace(/ {2}(\d+ )?options: .*$/, "").replace(/\s*\((edit|read-only)\)\s*$/, ""));
        const text = (v?.[2] ?? "").replace(/^\s+|\s+$/g, "") || v?.[1] || "";
        cell = text ? `${col}=${text}` : null;
      } else {
        const v = /= "(.*)" {2}\((edit|read-only)\)/.exec(cellRest);
        cell = v?.[1] ? `${col}=${v[1]}` : null;
      }
      if (t) {
        let info = t.columns.get(c);
        if (!info) {
          info = { id: `${g.ctl ?? ""}${g.name ?? ""}`, ro: new Set(), edit: new Set() };
          t.columns.set(c, info);
        }
        if (/\(read-only\)/.test(cellRest)) info.ro.add(r);
        else if (/\(edit\)/.test(cellRest)) info.edit.add(r);
      }
      const key = `${tbl}|${r}`;
      let cells = tableRows.get(key);
      if (!cells) {
        cells = [];
        tableRows.set(key, cells);
        out.push({ cells, prefix: opt.shortRows ? `  row ${r}` : `  ${lastSegment(tbl)} row ${r}`, ...(t ? { table: t } : {}), r });
      }
      if (cell) cells.push(cell);
      continue;
    }
    if (l.includes("  table  rows ")) {
      const titles = l.includes("columns: ")
        ? (l.split("columns: ")[1] ?? "").split(" | ").map((x) => x.replace(/^ +| +$/g, ""))
        : [];
      const h = short(id);
      // A table control counts its rows on the screen: scrolled, its row 0 is further down the table.
      const first = Number(/\(visible [^)]*\bfirst (\d+)\)/.exec(l)?.[1] ?? 0);
      const selected = new Set((/; selected rows ([\d,]+)/.exec(l)?.[1] ?? "").split(",").filter(Boolean).map(Number));
      const own = (l.split("  table  ")[1] ?? "").replace(/; columns: .*$/, "");
      const t: Table = {
        id,
        head: `${h}  table  ${own}`,
        titles,
        selected,
        columns: new Map(),
        first,
      };
      tables.set(id, t);
      out.push({ table: t });
      continue;
    }

    const cell = opt.lists ? LIST_CELL.exec(id)?.groups : undefined;
    if (cell) {
      const area = cell.area ?? "";
      let list = lists.get(area);
      if (!list) {
        // SAP GUI gives a list no line of its own: this one stands for it.
        list = { area, text: "", lines: new Map() };
        lists.set(area, list);
        out.push({ list });
      }
      const r = Number(cell.r);
      let line = list.lines.get(r);
      if (!line) {
        line = [];
        list.lines.set(r, line);
        out.push({ list, r });
      }
      let text = rest.replace(/^label {2}/, "");
      if (rest.startsWith("checkbox  ")) text = rest.slice(10).replace(/\s+$/, "");
      else if (rest.startsWith("field  ")) text = /= (".*") {2}\((edit|read-only)\)$/.exec(rest)?.[1] ?? rest;
      line.push({ c: Number(cell.c), text });
      continue;
    }
    if (opt.lists && /^wnd\[\d+\]\/usr$/.test(id) && rest.startsWith("list")) {
      // The reader's own line for the list (Web GUI): its cells follow.
      const list: List = { area: id, text: rest.replace(/^list\s*/, ""), lines: new Map() };
      lists.set(id, list);
      out.push({ list });
      continue;
    }

    if (opt.dropdowns && rest.startsWith("dropdown  ")) {
      const m = /^(.*?) {2}(\d+ )?options: (.*)$/.exec(rest);
      if (m) {
        const n = m[2] ? Number(m[2]) : (m[3] ?? "").split(", ").length;
        out.push(`${short(id)}  ${(m[1] ?? "").replace(/\s+$/, "")}  (${n} options)`);
        continue;
      }
    }
    out.push(`${short(id)}  ${rest}`);
  }

  const shared = new Map<List, string | undefined>();
  for (const l of lists.values()) shared.set(l, opt.listColumns ? sharedColumns(l) : undefined);
  let text = out.flatMap((x, i): string[] => {
    if (typeof x === "string") return [x];
    if ("table" in x && !("cells" in x)) {
      const t = x.table;
      const l = legend(t);
      const firstCol = [...t.columns.entries()].sort((a, b) => a[0] - b[0])[0];
      const example = firstCol ? `${firstCol[1].id}[${firstCol[0]},0]` : `${short(t.id)}/<id>[0,0]`;
      const head = `${t.head}  (cell id: <id>[col,row], e.g. ${example}${t.first ? `; row 0 here is row ${t.first} of the table` : ""})`;
      return l ? [head, l] : [head];
    }
    if ("cells" in x) {
      const sel = x.table && x.r !== undefined && x.table.selected.has(x.r) ? " (selected)" : "";
      if (x.cells.length || sel || !opt.emptyRuns) return [`${x.prefix}${sel}: ${x.cells.join("; ") || "(empty)"}`];
      // Empty rows in a run: one line for the run.
      const prev = out[i - 1];
      if (prev && typeof prev !== "string" && "cells" in prev && !prev.cells.length && prev.table === x.table && !(prev.table && prev.r !== undefined && prev.table.selected.has(prev.r))) return [];
      let last = x.r ?? 0;
      for (let j = i + 1; j < out.length; j++) {
        const n = out[j];
        if (!n || typeof n === "string" || !("cells" in n) || n.cells.length || n.table !== x.table || (n.table && n.r !== undefined && n.table.selected.has(n.r))) break;
        last = n.r ?? last;
      }
      return [last > (x.r ?? 0) ? `${x.prefix.replace(/row (\d+)$/, `rows $1 to ${last}`)}: (empty)` : `${x.prefix}: (empty)`];
    }
    const h = short(x.list.area);
    const cols = shared.get(x.list);
    if (x.r === undefined) {
      const how = cols ? `; rows without braces have their cells in columns ${cols}` : "";
      return [`${h}  list  ${x.list.text || `${x.list.lines.size} rows`}  (cell ids: ${h}/lbl[col,row], col in braces${how}; a checkbox is chk[col,row])`];
    }
    const cells = x.list.lines.get(x.r) ?? [];
    const plain = cols !== undefined && cells.map((c) => c.c).join(",") === cols;
    return [`  row ${x.r}: ${cells.map((c) => (plain ? c.text : `${c.text} {${c.c}}`)).join(" | ")}`];
  });
  if (opt.repeatedButtons) text = foldRepeatedButtons(text);
  if (opt.emptyColumns) text = foldEmptyColumns(text);
  return fit(text, opt.maxChars ?? 0).join("\n");
}

/**
 * The lines of one control of a full view: its own line and the lines that
 * belong to it (rows, nodes, cells, the controls of an HTML viewer), under
 * the view's header and the control's window line. Undefined when the id is
 * not a line of the view.
 */
export function controlBlock(full: string, id: string): string | undefined {
  const lines = full.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${id}  `) || l === id);
  // A classic list has no line of its own in the SAP GUI view: its cells stand for it.
  const isList = /^wnd\[\d+\]\/usr$/.test(id);
  const mine = (l: string) => l.startsWith(`${id}/`) && (!isList || LIST_CELL.test(idOf(l)));
  if (at < 0 && !(isList && lines.some(mine))) return undefined;
  const out: string[] = [lines[0] ?? ""];
  const windowLine = lines
    .slice(0, at < 0 ? lines.findIndex(mine) : at)
    .reverse()
    .find((l) => l.startsWith("WINDOW "));
  if (windowLine) out.push(windowLine);
  if (at >= 0) {
    out.push(lines[at] ?? "");
    for (let i = at + 1; i < lines.length && ((lines[i] ?? "").startsWith("  ") || mine(lines[i] ?? "")); i++) out.push(lines[i] ?? "");
  } else out.push(...lines.filter(mine));
  return out.join("\n");
}
