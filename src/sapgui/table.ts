/**
 * Table controls, ALV grids and the keyboard keys SAP GUI has no virtual key
 * for, worked out from the screen read (pure functions; index.ts acts on them).
 *
 * A table control's cells are controls of their own: "<table>/<prefix><FIELD>[col,row]",
 * with the row counted from the first row on screen (the scrollbar's position).
 * An agent names a cell by the table, an absolute row and a column (field name,
 * column title or column number): `tableCell` finds its id, or says the row must
 * be scrolled into view first.
 */
import { ActionError } from "../core/types.js";
import type { Control, Screen } from "./facts.js";

const CELL = /^(.*)\/([a-z]+)([^/[\]]*)\[(\d+),(\d+)\]$/;

/** A cell id's parts: the table it is in, the field, its column and its row on screen. */
export function cellParts(id: string): { table: string; field: string; col: number; vrow: number } | undefined {
  const m = CELL.exec(id);
  if (!m) return undefined;
  return { table: m[1] as string, field: m[3] as string, col: Number(m[4]), vrow: Number(m[5]) };
}

/** The cells of a table control in the read. */
export function tableCells(screen: Screen, table: Control): Control[] {
  return screen.windows.flatMap((w) => w.controls).filter((c) => cellParts(c.id)?.table === table.id);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The column a "col" means: a number, a field name ("MSICHTAUSW-KZSEL" or "KZSEL") or a column title. */
export function tableColumn(screen: Screen, table: Control, col: unknown): number {
  const cells = tableCells(screen, table);
  const titles = table.columns ?? [];
  if (typeof col === "number" || (typeof col === "string" && /^\d+$/.test(col.trim()))) {
    const n = Number(col);
    if (Number.isInteger(n) && n >= 0 && (n < titles.length || cells.some((c) => cellParts(c.id)?.col === n))) return n;
  } else if (typeof col === "string" && col.trim()) {
    // The column as the view's legend writes it: the cell's id without its place, "txtKONP-KBETR" (live, VK12, 2026-11-25).
    const want = norm(col.trim().replace(/\[\d+,\d+\]$/, "").replace(/^(ctxt|txt|cmb|chk|rad|btn|lbl|pwd)(?=[A-Z0-9_%/]*-|[A-Z])/, ""));
    const byField = cells.find((c) => {
      const field = norm(c.name || (cellParts(c.id)?.field ?? ""));
      return field === want || field.endsWith(`-${want}`);
    });
    if (byField) return cellParts(byField.id)?.col as number;
    const byTitle = titles.findIndex((t) => norm(t) === want);
    if (byTitle >= 0) return byTitle;
  }
  const fields = [...new Map(cells.map((c) => [cellParts(c.id)?.col, c.name || cellParts(c.id)?.field])).entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  const known = fields.map(([i, f]) => `${i}=${f}${titles[i ?? -1] ? ` (${titles[i ?? -1]})` : ""}`).join(", ") || titles.map((t, i) => `${i}=${t}`).join(", ");
  throw new ActionError(`${table.id} has no column "${String(col ?? "")}". Give "col" as a field name, a column title or a column number: ${known}`);
}

/**
 * The cell at an absolute row (from 0) and a column; `scroll` when the row is
 * not on screen and the table must be scrolled to it first.
 */
export function tableCell(screen: Screen, table: Control, row: number, col: unknown): { cell: Control } | { scroll: true } {
  if (!Number.isInteger(row) || row < 0) throw new ActionError('"row" is a row number from 0, counted from the table\'s first row (not from the first one on screen)');
  const total = table.rowCount;
  if (typeof total === "number" && row >= total) throw new ActionError(`row ${row}: ${table.id} has ${total} rows (0 to ${total - 1}).`);
  const c = tableColumn(screen, table, col);
  const first = table.firstRow ?? 0;
  const vrow = row - first;
  const visible = table.visibleRowCount ?? undefined;
  if (vrow < 0 || (typeof visible === "number" && vrow >= visible)) return { scroll: true };
  const cell = tableCells(screen, table).find((x) => {
    const p = cellParts(x.id);
    return p?.col === c && p.vrow === vrow;
  });
  if (!cell) {
    const like = tableCells(screen, table).find((x) => cellParts(x.id)?.col === c);
    const p = like ? cellParts(like.id) : undefined;
    throw new ActionError(`row ${row} of ${table.id} has no cell in column ${c} on screen (the row may be empty and closed for input).${p ? ` Its cell id would be ${p.table}/${/\/([a-z]+)[^/]*$/.exec(like!.id)?.[1] ?? ""}${p.field}[${c},${vrow}] (a cell id counts rows on the screen).` : ""}`);
  }
  return { cell };
}

/** An ALV grid's column id for a "col" given as its id or its title. */
export function gridColumn(grid: Control, col: unknown): string {
  const g = grid.grid;
  const want = typeof col === "string" ? col.trim() : "";
  if (!g) return want;
  const byId = g.cols.find((c) => c === want) ?? g.cols.find((c) => c.toLowerCase() === want.toLowerCase());
  if (byId) return byId;
  const i = g.titles.findIndex((t) => norm(t) === norm(want));
  if (want && i >= 0) return g.cols[i] as string;
  throw new ActionError(`${grid.id} has no column "${want}". Give "col" as a column id: ${g.cols.map((c, j) => `${c}=${g.titles[j] ?? ""}`).join(" | ")}`);
}

/** Keys SAP GUI scripting has no virtual key for, and what each does here instead. */
export type LocalKey = "tab" | "backtab" | "space" | "rowselect";

export function localKey(key: unknown): LocalKey | undefined {
  if (typeof key !== "string") return undefined;
  const s = key.replace(/\s+/g, "").toLowerCase();
  if (s === "tab") return "tab";
  if (s === "shift+tab") return "backtab";
  if (s === "space") return "space";
  if (s === "shift+space") return "rowselect";
  return undefined;
}

/** Controls Tab moves through: those that take input, in screen order. */
const TABBABLE = new Set(["GuiTextField", "GuiCTextField", "GuiPasswordField", "GuiComboBox", "GuiCheckBox", "GuiRadioButton"]);

/** The control Tab (or Shift+Tab) moves the focus to, in the active window. */
export function nextField(screen: Screen, back: boolean): Control | undefined {
  const win = screen.windows.find((w) => w.id === (screen.activeWindow ?? "wnd[0]")) ?? screen.windows[0];
  const all = (win?.controls ?? []).filter((c) => TABBABLE.has(c.type) && c.changeable === true);
  if (!all.length) return undefined;
  const at = all.findIndex((c) => c.id === screen.focus);
  if (at < 0) return back ? all[all.length - 1] : all[0];
  return all[(at + (back ? -1 : 1) + all.length) % all.length];
}

/** The table control and absolute row the focused cell is in. */
export function focusedRow(screen: Screen): { table: Control; row: number } | undefined {
  const p = screen.focus ? cellParts(screen.focus) : undefined;
  if (!p) return undefined;
  const table = screen.windows.flatMap((w) => w.controls).find((c) => c.id === p.table && c.type === "GuiTableControl");
  if (!table) return undefined;
  return { table, row: (table.firstRow ?? 0) + p.vrow };
}

/**
 * The table control a column's id belongs to, for an action that names the
 * column as its id and gives a row ({"do":"set","id":"txtRV45A-KWMENG","row":0},
 * live VA01 and VF01, 2026-11-25). `col` is the column's field name. Only when
 * exactly one table on the screen has such a column.
 */
export function tableOfColumn(screen: Screen, ident: string): { table: Control; col: string } | undefined {
  const want = ident.trim().replace(/^.*\//, "").replace(/\[\d+,\d+\]$/, "");
  const field = want.replace(/^(ctxt|txt|cmb|chk|rad|btn|lbl|pwd)(?=[A-Z0-9_%])/, "");
  if (!field) return undefined;
  const all = screen.windows.flatMap((w) => w.controls);
  const found = all.filter(
    (t) => t.type === "GuiTableControl" && tableCells(screen, t).some((c) => (cellParts(c.id)?.field ?? "") === field || c.name === field),
  );
  return found.length === 1 ? { table: found[0] as Control, col: field } : undefined;
}
