/**
 * Reads rows N to M of a long control (grid, table control, tree, classic
 * list) by scrolling it page by page. SAP GUI and Web GUI hold only the rows
 * in view, so a range is read as a person would: scroll, read, scroll on.
 *
 * A surface gives two functions: scroll the control to a row, and read the
 * control as it is now (its lines of the full view, see `controlBlock`).
 * The answer is in the compact format, with every row under its number in
 * the whole list.
 */
import { compact } from "./compact.js";
import { ActionError } from "./types.js";

export interface RowSource {
  /** Scrolls the control so that `row` (from 0) is the first row shown, or as near as the list allows. */
  scrollTo(row: number): Promise<void>;
  /**
   * The control's lines of the full view, under the header and window lines
   * (`controlBlock`), with the full view they come from; undefined when the
   * control is gone.
   */
  block(): Promise<{ block: string; screen: string } | undefined>;
}

export interface Page {
  /** The control's own line, compact. */
  head: string;
  /** Header and window lines. */
  frame: string[];
  kind: "grid" | "table" | "tree" | "list" | "other";
  /** A list's title lines, which do not scroll. */
  titles: string[];
  /** Each row line with its number in the whole list. */
  rows: { n: number; text: string }[];
  /** Rows the control has in all, when it says. */
  total: number | undefined;
}

/** The rows of one control, as the compact view writes them, numbered in the whole list. */
export function pageOf(block: string, screen?: string): Page {
  const lines = compact(block, { maxChars: 0, emptyColumns: false, listColumns: false, emptyRuns: false, ...(screen === undefined ? {} : { screen }) }).split("\n");
  const at = lines.findIndex((l, i) => i > 0 && !l.startsWith("WINDOW ") && !l.startsWith(" "));
  const head = lines[at] ?? "";
  const kind = (/ {2}(grid|table|tree|list) {2}/.exec(head)?.[1] ?? "other") as Page["kind"];
  // Rows of a table control, a list and a tree are counted on the screen: `first` is where the screen starts.
  const first = Number(/\bfirst (\d+)/.exec(head)?.[1] ?? 0);
  // A list keeps its title rows on screen while the rows below them scroll.
  const fixed = kind === "list" ? Number(/\bbelow (\d+) title rows/.exec(head)?.[1] ?? 0) : 0;
  const total = Number(/(\d+) (?:rows|lines)\b|\brows (\d+)|of (\d+) \(/.exec(head)?.slice(1).find((x) => x !== undefined) ?? Number.NaN);
  const rows: Page["rows"] = [];
  const titles: string[] = [];
  let i = 0;
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("  ") || l.startsWith("  ...") || l.startsWith("  (")) continue;
    // A table control's column legend: kept with the head.
    if (kind === "table" && l.startsWith("  columns: ")) {
      titles.push(l);
      continue;
    }
    const m = /^ {2}(row) (\d+)((?: \((?:selected|total)\))*): /.exec(l);
    if (kind === "grid" && m) rows.push({ n: Number(m[2]), text: l });
    else if (kind === "list" && m && Number(m[2]) < fixed) titles.push(`  title ${m[2]}: ${l.slice(m[0].length)}`);
    else if ((kind === "table" || kind === "list") && m) {
      const n = first + Number(m[2]) - fixed;
      rows.push({ n, text: `  ${m[1]} ${n}${m[3]}: ${l.slice(m[0].length)}` });
    }
    else if (kind === "tree") rows.push({ n: first + i++, text: l });
  }
  return { head, frame: lines.slice(0, at), titles, kind, rows, total: Number.isNaN(total) ? undefined : total };
}

/** The most pages one read scrolls through. */
const MAX_PAGES = 60;

/**
 * Keeps only some columns of a page of a grid or a table control: `cols`
 * names them by column id or title (any case). A grid's head names its
 * columns `ID=Title`; its rows hold one value per column. A table control's
 * rows name their cells `Title=value`. Other kinds are left as they are.
 */
export function onlyColumns(page: Page, cols: string[]): Page {
  const want = cols.map((c) => c.replace(/^ +| +$/g, "").toLowerCase()).filter(Boolean);
  if (!want.length) return page;
  const split = (row: string) => {
    const m = /^( {2}row \d+(?: \((?:selected|total)\))*: )(.*)$/.exec(row);
    return m ? { prefix: m[1] ?? "", body: m[2] ?? "" } : undefined;
  };
  if (page.kind === "grid") {
    const m = /^(.*; columns: )(.*?)(; empty in these rows: .*)?$/.exec(page.head);
    if (!m) return page;
    const names = (m[2] ?? "").split(" | ");
    const keep = names.map((n, i) => ({ n, i })).filter(({ n }) => {
      const [cid = "", title = ""] = n.split("=");
      return want.includes(cid.toLowerCase()) || want.includes(title.toLowerCase());
    });
    if (!keep.length) throw new ActionError(`none of the columns ${cols.join(", ")} is in this grid: its columns are ${names.join(" | ")}.`);
    return {
      ...page,
      head: `${m[1]}${keep.map(({ n }) => n).join(" | ")}  (${keep.length} of ${names.length} columns)`,
      rows: page.rows.map((r) => {
        const p = split(r.text);
        if (!p) return r;
        const cells = p.body.split(" | ");
        return { ...r, text: `${p.prefix}${keep.map(({ i }) => cells[i] ?? "").join(" | ")}` };
      }),
    };
  }
  if (page.kind === "table")
    return {
      ...page,
      rows: page.rows.map((r) => {
        const p = split(r.text);
        if (!p) return r;
        const cells = p.body.split("; ").filter((c) => want.includes((/^(.*?)(=| \[)/.exec(c)?.[1] ?? c).toLowerCase()));
        return { ...r, text: `${p.prefix}${cells.join("; ") || "(empty)"}` };
      }),
    };
  return page;
}

export async function readRows(source: RowSource, id: string, from: number, to: number, cols?: string[]): Promise<string> {
  const got = new Map<number, string>();
  let page: Page | undefined;
  let next = from;
  for (let n = 0; n < MAX_PAGES && next <= to; n++) {
    await source.scrollTo(next);
    const now = await source.block();
    if (!now) throw new ActionError(`No control "${id}" on this screen any more. Look at the screen again.`);
    page = pageOf(now.block, now.screen);
    if (page.kind === "other") throw new ActionError(`"${id}" has no rows to read: "rows" works on a grid, a table control, a tree or a list.`);
    let progress = false;
    let last = -1;
    for (const r of page.rows) {
      last = Math.max(last, r.n);
      if (r.n < from || r.n > to || got.has(r.n)) continue;
      got.set(r.n, r.text);
      progress = true;
    }
    // The end of the list, or a control that does not move.
    if (!progress || last < next) break;
    next = last + 1;
    if (page.total !== undefined && next >= page.total) break;
  }
  if (!page) throw new ActionError(`"${id}" could not be read.`);
  if (cols?.length) {
    const only = onlyColumns({ ...page, rows: [...got.entries()].map(([n, text]) => ({ n, text })) }, cols);
    page = only;
    got.clear();
    for (const r of only.rows) got.set(r.n, r.text);
  }
  const rows = [...got.entries()].sort((a, b) => a[0] - b[0]);
  const total = page.total === undefined ? "" : ` of ${page.total}`;
  const where =
    page.kind === "table" || page.kind === "list"
      ? ` Rows are numbered in the whole ${page.kind} here; a cell id counts rows on screen, so scroll to a row before acting on it.`
      : "";
  const note = rows.length
    ? `  (rows ${rows[0]?.[0]} to ${rows[rows.length - 1]?.[0]}${total}; the control is now scrolled there.${where})`
    : page.kind === "table" && page.total !== undefined && from < page.total
      ? `  (rows ${from} to ${Math.min(to, page.total - 1)} hold nothing: SAP counts ${page.total} rows in this table, blank lines included, and none of these is filled)`
      : `  (no rows ${from} to ${to}: the control has ${page.total ?? "fewer"} rows)`;
  return [...page.frame, page.head, ...page.titles, ...rows.map(([, t]) => t), note].join("\n");
}
