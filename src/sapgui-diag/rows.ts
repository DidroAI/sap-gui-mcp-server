/**
 * sap_look with "id" on the DIAG method: one control whole, or some of its
 * rows ("rows": first and last, from 0) and columns ("cols": ids or
 * titles), as the other surfaces give them.
 *
 * The traffic holds more than the screen shows: every node of a tree,
 * every row of a grid SAP has sent so far. Those are read without touching
 * SAP GUI. Rows that SAP has not sent (a grid's rows further down, the
 * other pages of a table control or a list) are fetched by scrolling the
 * control, page by page, as a person would (`scroll` of the driver); the
 * control stays where the last rows were read.
 *
 * The answer is the method's own view (src/diag/view.ts) of a screen that
 * holds only that control.
 */
import { type LookOptions, ActionError } from "../core/types.js";
import { type DiagControl, type DiagList, type DiagScreen, type DiagTable, type DiagTableRow, type DiagWindow, diagView } from "../diag/index.js";
import { type Named, namedControl, position, scrollables, shownNodes } from "./plan.js";

export interface RowSource {
  /** The screen as the traffic now has it (with the keyboard's tree changes). */
  screen(): DiagScreen;
  /** Scrolls a control so that `row` is on show; resolves when SAP has answered. */
  scrollTo(id: string, row: number): Promise<void>;
  /** Tree folders opened or closed by the keyboard, by shell id. */
  local?(shell: number): ReadonlyMap<string, boolean> | undefined;
}

/** The most pages one read scrolls through. */
const MAX_PAGES = 60;

const lower = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** A screen with only this window part: the view of one control. */
function only(s: DiagScreen, w: DiagWindow, part: Partial<DiagWindow>): DiagScreen {
  const win: DiagWindow = { ...w, elements: [], tabstrips: [], tables: [], controls: [], containers: [], ...part };
  delete win.list;
  delete win.focus;
  if (part.list) win.list = part.list;
  const { message: _m, ...rest } = s;
  return { ...rest, windows: [win] };
}

function view(s: DiagScreen, note?: string): string {
  const text = diagView(s, { maxRows: 1_000_000, chrome: false });
  return note ? `${text}\n${note}` : text;
}

/** The kept columns of a grid, by id or title; all when `cols` is empty. */
function keepGrid(c: DiagControl, cols: string[] | undefined): DiagControl {
  if (!c.grid || !cols?.length) return c;
  const want = cols.map(lower).filter(Boolean);
  const columns = [...c.grid.columns].sort((a, b) => a.position - b.position);
  const keep = columns.map((col, i) => ({ col, i })).filter(({ col }) => want.includes(lower(col.name)) || want.includes(lower(col.title)) || col.titles.some((t) => want.includes(lower(t))));
  if (!keep.length) throw new ActionError(`None of the columns ${cols.join(", ")} is in the grid: its columns are ${columns.map((x) => `${x.name}=${x.title}`).join(" | ")}.`);
  return { ...c, grid: { ...c.grid, columns: keep.map(({ col }, j) => ({ ...col, position: j })), rows: c.grid.rows.map((r) => ({ ...r, cells: keep.map(({ i }) => r.cells[i] ?? "") })) } };
}

function keepTable(t: DiagTable, cols: string[] | undefined): DiagTable {
  if (!cols?.length) return t;
  const want = cols.map(lower).filter(Boolean);
  const keep = new Set(t.columns.filter((c) => want.includes(lower(c.name)) || want.includes(lower(c.title))).map((c) => c.index));
  if (!keep.size) throw new ActionError(`None of the columns ${cols.join(", ")} is in the table: its columns are ${t.columns.map((x) => `${x.name}=${x.title}`).join(" | ")}.`);
  // The view names a cell by its column's place in the table: the other cells are blanked, not removed.
  return { ...t, rows: t.rows.map((r) => ({ ...r, cells: r.cells.map((c) => (keep.has(c.column) ? c : { ...c, text: "", hidden: true })) })) };
}

/** The control an id names, or an error that lists what the screen has. */
function named(s: DiagScreen, id: string): Named {
  const n = namedControl(s, id);
  if (n) return n;
  const here = scrollables(s).map((x) => x.id);
  throw new ActionError(`No control "${id}" on this screen.${here.length ? ` It has: ${here.join(", ")}.` : ""} Use an id from sap_look (the screen may have changed).`);
}

export async function lookControl(src: RowSource, options: LookOptions): Promise<string> {
  const id = String(options.id ?? "");
  let n = named(src.screen(), id);
  const rows = options.rows;
  const s0 = src.screen();
  if (n.kind === "dropdown") {
    const e = n.element;
    return view(only(s0, n.window, { elements: [e] }), `(${e.name} shows "${e.key ?? ""}"; its entries are not in the traffic: SAP GUI keeps them${e.valueList ? `, list "${e.valueList}"` : ""}. Choose with {"do":"combo","id":"${n.id}","key":"<text or key>"}.)`);
  }
  if (n.kind === "tree") {
    const shown = shownNodes(n.control, src.local?.(n.control.id));
    const from = rows ? Math.max(0, rows.from) : 0;
    const to = rows ? Math.min(rows.to, shown.length - 1) : shown.length - 1;
    // The nodes on show in the range, each made a root so that the view shows them with their depth.
    const nodes = shown.slice(from, to + 1).map((x) => ({ ...x, parent: "" }));
    const c: DiagControl = { ...n.control, ...(n.control.tree ? { tree: { ...n.control.tree, nodes } } : {}) };
    return view(only(s0, n.window, { controls: [c] }), rows ? `(nodes ${from} to ${to} of the ${shown.length} on show; every node SAP sent is in the traffic, so nothing was scrolled)` : undefined);
  }
  if (n.kind === "grid") {
    const g = n.control.grid;
    const total = g?.totalRows ?? 0;
    if (!rows) return view(only(s0, n.window, { controls: [keepGrid(n.control, options.cols)] }));
    const from = Math.max(0, rows.from);
    const to = Math.min(rows.to, Math.max(0, total - 1));
    const have = (c: DiagControl) => new Set(c.grid?.rows.map((r) => r.index));
    const missing = (c: DiagControl) => {
      const h = have(c);
      for (let i = from; i <= to; i++) if (!h.has(i)) return i;
      return undefined;
    };
    // SAP sends a grid's rows as SAP GUI shows them: scroll to the first row not sent yet, then to the last.
    for (let tries = 0; tries < 3; tries++) {
      const gap = missing(n.control);
      if (gap === undefined || !n.control.area) break;
      await src.scrollTo(n.id, tries === 0 ? gap : to);
      n = named(src.screen(), n.id);
      if (n.kind !== "grid") throw new ActionError(`The grid ${id} is gone from the screen.`);
    }
    const c = keepGrid(n.control, options.cols);
    const kept: DiagControl = c.grid ? { ...c, grid: { ...c.grid, rows: c.grid.rows.filter((r) => r.index >= from && r.index <= to) } } : c;
    const gap = missing(n.control);
    return view(only(src.screen(), n.window, { controls: [kept] }), gap === undefined ? undefined : `(rows from ${gap} were not sent by SAP: scroll the grid there and look again)`);
  }
  // A table control or a list: the server sends the page on show; other pages come by scrolling.
  if (!rows) {
    if (n.kind === "table") return view(only(s0, n.window, { tables: [keepTable(n.table, options.cols)] }));
    return view(only(s0, n.window, { list: n.window.list as DiagList }));
  }
  const from = Math.max(0, rows.from);
  const collected = new Map<number, DiagTableRow>();
  const pages: string[] = [];
  let total: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = position(n);
    if (!p) break;
    total = p.total;
    const to = Math.min(rows.to, total !== undefined ? total - 1 : rows.to);
    if (from > to) break;
    if (p.first > to || p.first + p.visible <= from) {
      // Not on this page: scroll to the first row wanted that is still missing.
      const want = n.kind === "table" ? ([...Array(to - from + 1).keys()].map((i) => from + i).find((i) => !collected.has(i)) ?? from) : from;
      const before = p.first;
      await src.scrollTo(n.id, want);
      n = named(src.screen(), n.id);
      if (position(n)?.first === before) break;
      continue;
    }
    if (n.kind === "table") for (const r of n.table.rows) if (r.index >= from && r.index <= to && !r.empty) collected.set(r.index, r);
    else pages.push(view(only(src.screen(), n.window, { list: n.window.list as DiagList }), `(the page from line ${p.first})`));
    if (p.first + p.visible > to || (total !== undefined && p.first + p.visible >= total)) break;
    const before = p.first;
    await src.scrollTo(n.id, p.first + p.visible);
    n = named(src.screen(), n.id);
    if (position(n)?.first === before) break;
  }
  if (n.kind === "table") {
    const kept = [...collected.values()].sort((a, b) => a.index - b.index);
    const t = keepTable({ ...n.table, rows: kept }, options.cols);
    const to = Math.min(rows.to, total !== undefined ? total - 1 : rows.to);
    return view(only(src.screen(), n.window, { tables: [t] }), `(rows ${from} to ${to}${total !== undefined ? ` of ${total}` : ""}: ${kept.length} with data; the table stays scrolled to the last page read)`);
  }
  return pages.join("\n") || view(only(src.screen(), n.window, { list: n.window.list as DiagList }));
}
