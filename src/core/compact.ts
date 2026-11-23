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
 *   cells that hold a value; a checkbox appears when checked. A button in a
 *   cell appears with its text when the buttons of its column do not all
 *   say the same (the operator of a selection criterion, a status icon);
 *   a column of equal buttons is named in the column legend only.
 * - **Row numbers.** A row of a table control or a list has one number,
 *   the one actions ("row") and `"rows"` take: in the whole table, in the
 *   whole list below its title rows ("title N" lines). Its cell ids count
 *   rows on the screen: the control's line says how (`<id>[col,0] is row
 *   60`); the rows do not repeat it (an agent took "row 15 (cell row 20)"
 *   for row 20, live 2026-11-23). A list whose reader does not say its title
 *   rows (SAP GUI) keeps its screen rows, and its line says how `"rows"`
 *   counts (core/rows.ts measures the title rows).
 * - **Lists.** The cells of a classic list (`lbl[col,row]`) become one line
 *   per row of the list, each cell with its column in braces; rows that share
 *   their columns (a table drawn as a list) are written without them.
 * - **Numbers.** A `NUMBERS 1.234,56` line under the header says the user's
 *   decimal notation, from the user's setting when the surface knows it,
 *   else from the amounts on the screen ("1.000" is a thousand with a
 *   decimal comma); no line when neither tells.
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
import { decimalOf, numbersLine } from "./notation.js";

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
  /** A grid shows this many columns, and names the others; 0 shows all. Default GRID_COLUMNS where empty columns are folded (a screen's view), else 0 (a read of rows). */
  gridColumns?: number;
  /** Cut row lines when the view is longer than this many characters; 0 never cuts (default 20000). */
  maxChars?: number;
  /**
   * Rows of table controls and lists under their screen row, the row of
   * their cell ids, alone (core/rows.ts numbers them itself). Default false:
   * a row is numbered in the whole table or list, as actions, "rows" and
   * scroll count it.
   */
  screenRows?: boolean;
  /**
   * A NUMBERS line under the header: how the user's numbers are written
   * ("NUMBERS 1.234,56"), so that "1.000" is read right. Default true; the
   * notation comes from `decimal` when the surface knows the user's setting,
   * else from the amounts the screen shows (core/notation.ts).
   */
  numbers?: boolean;
  /** The user's decimal sign, when the surface knows it from the user's settings. */
  decimal?: "," | ".";
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
  // A value (read-only ones are counted by trimBehindPopups); a table's cells keep their rows.
  if (/= "[^"]+"/.test(l)) return true;
  if (/\[x\]|\(selected\)/.test(l)) return true;
  return false;
}

/**
 * An HTML viewer docked beside the screen (outside the user area: ME21N's
 * and ME23N's help, 7 lines of text and 12 links on every answer) in one
 * line: its first line of text, and how much more there is. sap_look with
 * its id shows it whole. A viewer in the user area is the screen's content
 * and stays as it is.
 */
function foldSideViewers(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const m = /^(wnd\[\d+\]\/\S+) {2}html-viewer$/.exec(l);
    if (!m || (m[1] ?? "").includes("/usr/")) {
      out.push(l);
      continue;
    }
    const id = m[1] ?? "";
    const text: string[] = [];
    let links = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const x = lines[j] ?? "";
      if (x.startsWith("  ")) text.push(x.trim());
      else if (x.startsWith(`${id}/`)) links++;
      else break;
    }
    const first = text.find((t) => !t.startsWith("..."));
    const more = [text.length > 1 ? `${text.length - 1} more lines of text` : "", links ? `${links} link${links === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
    out.push(`${l}${first ? `  "${first.replace(/"/g, "'")}"` : ""}${more ? `  (${more}: sap_look with id "${id}" shows them)` : ""}`);
    i = j - 1;
  }
  return out;
}

/** The read-only values behind a popup that its view keeps. */
const READ_ONLY_BEHIND = 5;

/** Shortens the main window while a popup (wnd[1] and up, or a browser dialog) is open. */
function trimBehindPopups(lines: string[]): string[] {
  const popup = lines.some((l) => /^WINDOW (wnd\[[1-9]\d*\]|browser)(\s|$)/.test(l));
  if (!popup) return lines;
  const out: string[] = [];
  let behind = false;
  let dropped = 0;
  const flush = () => {
    if (dropped) out.push(`  (${dropped} more lines behind the popup: buttons, menus, read-only and empty fields, list rows; sap_look full=true shows them)`);
    dropped = 0;
  };
  // Read-only values behind it: the first few say where the popup came from; the rest (a VA01 overview: some 25) were in the view before it.
  let readOnly = 0;
  for (const l of lines) {
    if (l.startsWith("WINDOW ")) {
      flush();
      behind = /^WINDOW wnd\[0\]/.test(l);
      out.push(l);
      continue;
    }
    const fixed = behind && / {2}(field|dropdown) {2}.*\(read-only\)\s*$/.test(l) && !CELL.test(l) && ++readOnly > READ_ONLY_BEHIND;
    if (behind && (fixed || !keepBehind(l))) {
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
type Out = string | { cells: Cell[]; prefix: string; table?: Table; r?: number } | { list: List; r?: number } | { table: Table };

/** One cell of a table row: its column, its text ("Material=M-17"), and whether it is a button. */
interface Cell {
  c: number;
  text: string;
  button?: boolean;
}
/** The cells of a row that hold a value: a row with buttons only is an empty row. */
const filled = (cells: Cell[]): boolean => cells.some((x) => !x.button);
/** A row's cells in the order of the columns (a table scrolled sideways draws its fixed columns last). */
const rowText = (cells: Cell[]): string =>
  filled(cells)
    ? [...cells]
        .sort((a, b) => a.c - b.c)
        .map((x) => x.text)
        .join("; ")
    : "";

/** A table control: what its own line says, and what its cells say about its columns. */
interface Table {
  id: string;
  /** Its line in the compact view, without the columns. */
  head: string;
  /** Column titles by column number (the table line names every column, drawn or not). */
  titles: string[];
  /** Rows (in the whole table) its line says are selected. */
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
      const r = /^( {2}row \d+(?: \((?:selected|total)\))*: )(.*)$/.exec(lines[j] ?? "");
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

/** The columns of a grid a view shows by default; the others are named by id, to be read with "cols". */
export const GRID_COLUMNS = 15;
/** The ids of the columns left out that a grid's line names; more are counted only. */
const NAMED_LEFT_OUT = 80;

/**
 * A grid with more than `max` columns (SE16N on EKPO: 385, each row some 600
 * characters) shows its first `max` columns; its line names the others by
 * id, to be read with sap_look's "cols" (by id or title).
 */
function foldWideGrids(lines: string[], max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i] ?? "";
    const m = /^(\S.*  grid  .*?; columns: )(.*?)((?:; empty in these rows: .*)?)$/.exec(head);
    if (!m) {
      out.push(head);
      continue;
    }
    const cols = (m[2] ?? "").split(" | ");
    const rows: { prefix: string; cells: string[] }[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const r = /^( {2}row \d+(?: \((?:selected|total)\))*: )(.*)$/.exec(lines[j] ?? "");
      if (!r) break;
      rows.push({ prefix: r[1] ?? "", cells: (r[2] ?? "").split(" | ") });
    }
    if (cols.length <= max || rows.some((r) => r.cells.length !== cols.length)) {
      out.push(head);
      continue;
    }
    const idsOf = (xs: string[]) => xs.map((c) => c.split("=", 1)[0] ?? c);
    const named = (ids: string[]) => (ids.length > NAMED_LEFT_OUT ? `${ids.slice(0, NAMED_LEFT_OUT).join(", ")}, ... (sap_look full=true with the id names all)` : ids.join(", "));
    const ids = idsOf(cols.slice(max));
    // The columns empty in every row shown, by id too: SE16N on EKPO has some 200.
    const empty = m[3] ? idsOf(m[3].replace(/^; empty in these rows: /, "").split(" | ")) : [];
    const emptyPart = empty.length ? `; ${empty.length} columns empty in these rows: ${named(empty)}` : "";
    out.push(`${m[1]}${cols.slice(0, max).join(" | ")}; ${ids.length} more columns, read with sap_look id and "cols" (ids or titles): ${named(ids)}${emptyPart}`);
    for (const r of rows) out.push(`${r.prefix}${r.cells.slice(0, max).join(" | ")}`);
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
  // The view of one control (`screen` given) keeps a viewer whole.
  const lines = trimBehindPopups(opt.screen === undefined ? foldSideViewers(full.split("\n")) : full.split("\n"));
  const ids = (opt.screen === undefined ? lines : opt.screen.split("\n")).filter((l) => l.startsWith("wnd[")).map(idOf);
  const handles = opt.handles ? shortIds(ids) : plainHandles(ids);
  const short = (id: string) => handles.get(id) ?? id;

  const tables = new Map<string, Table>();
  const tableRows = new Map<string, Cell[]>();
  const lists = new Map<string, List>();
  const out: Out[] = [];
  // Button cells by table and column: a column whose buttons all say the same holds an action, not a value.
  const buttonTexts = new Map<string, Set<string>>();
  for (const l of lines) {
    const g = CELL.exec(l)?.groups;
    if (!g || !(g.rest ?? "").startsWith("button  ")) continue;
    const key = `${g.tbl}|${g.c}`;
    if (!buttonTexts.has(key)) buttonTexts.set(key, new Set());
    buttonTexts.get(key)?.add((g.rest ?? "").slice(8));
  }
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
      const title = t?.titles[c] || (g.name ?? "");
      // Two columns with one title (a key and its text, both "Country"): each is told apart by its number.
      const col = t && title && t.titles.indexOf(title) !== t.titles.lastIndexOf(title) ? `${title} [col ${c}]` : title;
      let cell: string | null = null;
      let button = false;
      if (cellRest.startsWith("button  ")) {
        button = true;
        cell = (buttonTexts.get(`${tbl}|${c}`)?.size ?? 0) > 1 ? `${col}=${cellRest.slice(8).replace(/ {2}\(.*\)$/, "")}` : null;
      } else if (cellRest.startsWith("checkbox") || cellRest.startsWith("radio")) cell = `${col} ${cellRest.includes("[x]") ? "[x]" : "[ ]"}`;
      else if (cellRest.startsWith("label  ")) {
        // A text drawn in a cell (SAP GUI: a GuiLabel): a value like any other.
        const v = cellRest.slice(7).replace(/^\s+|\s+$/g, "");
        cell = v ? `${col}=${v}` : null;
      }
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
      // A cell the reader wrote twice (a display cell and the label in it: "View=Basic Data 1; View=Basic Data 1"): once.
      if (cell && !cells.some((x) => x.c === c && x.text === cell)) cells.push({ c, text: cell, ...(button ? { button } : {}) });
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
      // Scrolled, its rows are numbered in the whole table, as actions and "rows" take them; its cell ids count on the screen.
      const head =
        t.first && !opt.screenRows
          ? `${t.head}  (rows numbered in the whole table: "row" in actions takes these numbers; a cell id counts rows on the screen: ${example} is row ${t.first})`
          : `${t.head}  (cell id: <id>[col,row], e.g. ${example}${t.first ? `; row 0 here is row ${t.first} of the table` : ""})`;
      // No cell of the table holds a value or takes input: said, or the "rows N" of its line reads as N rows the view left out.
      // Not "no row is filled": Web GUI draws no cell of a table outside the part of the page in view.
      const rows = out.some((o) => typeof o !== "string" && "cells" in o && o.table === t);
      const none = rows || !/ {2}table {2}rows /.test(t.head) ? [] : [`  (no cell of this table is in the view: its rows on screen are blank lines, or the table is outside the part of the page that is drawn. sap_look with id "${short(t.id)}" reads it on its own.)`];
      return l ? [head, l, ...none] : [head, ...none];
    }
    if ("cells" in x) {
      // The reader names selected rows in the whole table.
      const picked = (o: { table?: Table; r?: number }) => !!o.table && o.r !== undefined && o.table.selected.has(o.table.first + o.r);
      const sel = picked(x) ? " (selected)" : "";
      // The row in the whole table: the number actions take.
      const at = (r: number) => (x.table && !opt.screenRows ? x.table.first + r : r);
      const r0 = x.r ?? 0;
      const label = x.prefix.replace(/row \d+$/, `row ${at(r0)}`);
      if (filled(x.cells) || sel || !opt.emptyRuns) return [`${label}${sel}: ${rowText(x.cells) || "(empty)"}`];
      // Empty rows in a run: one line for the run.
      const prev = out[i - 1];
      if (prev && typeof prev !== "string" && "cells" in prev && !filled(prev.cells) && prev.table === x.table && !picked(prev)) return [];
      let last = x.r ?? 0;
      for (let j = i + 1; j < out.length; j++) {
        const n = out[j];
        if (!n || typeof n === "string" || !("cells" in n) || filled(n.cells) || n.table !== x.table || picked(n)) break;
        last = n.r ?? last;
      }
      if (last <= r0) return [`${label}: (empty)`];
      return [`${x.prefix.replace(/row \d+$/, `rows ${at(r0)} to ${at(last)}`)}: (empty)`];
    }
    const h = short(x.list.area);
    const cols = shared.get(x.list);
    // A list that scrolls: its lines below the title rows are numbered in the whole list when the reader says how many title rows it has (Web GUI).
    const scrolls = /\bvisible \d+/.test(x.list.text);
    const below = /\bbelow (\d+) title rows/.exec(x.list.text)?.[1];
    const fixed = scrolls && below !== undefined && !opt.screenRows ? Number(below) : undefined;
    const first = Number(/\bfirst (\d+)/.exec(x.list.text)?.[1] ?? 0);
    if (x.r === undefined) {
      const how = cols ? `; rows without braces have their cells in columns ${cols}` : "";
      const ids =
        fixed !== undefined
          ? `rows numbered in the whole list below its ${fixed} title row${fixed === 1 ? "" : "s"}: "rows" and "row" in actions take these numbers, e.g. {"do":"dblclick","id":"${h}","row":N,"col":<col>}; a cell id counts rows on the screen: row N is ${h}/lbl[col,N${fixed - first >= 0 ? "+" : ""}${fixed - first}] now, col in braces${how}; a checkbox is chk[col,...]`
          : scrolls && !opt.screenRows
            ? `rows here are screen rows, as cell ids count them: ${h}/lbl[col,row], col in braces${how}; a checkbox is chk[col,row]. "rows" and scroll count the list's lines from 0, below its title rows: sap_look with id "${h}" and rows numbers each line`
            : `cell ids: ${h}/lbl[col,row], col in braces${how}; a checkbox is chk[col,row]`;
      return [`${h}  list  ${x.list.text || `${x.list.lines.size} rows`}  (${ids})`];
    }
    const cells = x.list.lines.get(x.r) ?? [];
    // A line whose cells are in some of the shared columns is written without braces too, an empty cell where a
    // column holds nothing: its values stay under their columns (FBL5N open items, no clearing date: 8 values
    // under 9 columns, live 2026-11-23).
    const columns = cols?.split(",").map(Number) ?? [];
    const exact = cols !== undefined && cells.map((c) => c.c).join(",") === cols;
    const title = fixed !== undefined && x.r < fixed;
    const most = !title && cells.length > 1 && cells.length * 2 >= columns.length && cells.every((c) => columns.includes(c.c)) && new Set(cells.map((c) => c.c)).size === cells.length;
    const plain = exact || most;
    const upTo = Math.max(...cells.map((c) => columns.indexOf(c.c)));
    const body = plain ? columns.slice(0, upTo + 1).map((at) => cells.find((c) => c.c === at)?.text ?? "").join(" | ") : cells.map((c) => `${c.text} {${c.c}}`).join(" | ");
    if (fixed === undefined) return [`  row ${x.r}: ${body}`];
    if (x.r < fixed) return [`  title ${x.r}: ${body}`];
    return [`  row ${first + x.r - fixed}: ${body}`];
  });
  if (opt.repeatedButtons) text = foldRepeatedButtons(text);
  if (opt.emptyColumns) text = foldEmptyColumns(text);
  // Not in a read of rows (core/rows.ts: no empty columns folded there either), which picks its columns with "cols".
  const gridColumns = opt.gridColumns ?? (opt.emptyColumns ? GRID_COLUMNS : 0);
  if (gridColumns > 0) text = foldWideGrids(text, gridColumns);
  // How the user writes numbers, once, under the header: "1.000" is a thousand with a decimal comma and one with a point.
  if (opt.numbers !== false && /^TRANSACTION /.test(text[0] ?? "") && !text.some((l) => l.startsWith("NUMBERS "))) {
    const shown = opt.decimal ? undefined : decimalOf(text.join("\n"));
    const sign = opt.decimal ?? shown?.sign;
    if (sign) text.splice(1, 0, numbersLine(sign, shown?.example));
  }
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
