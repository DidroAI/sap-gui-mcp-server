/**
 * Reads rows N to M of a long control (grid, table control, tree, classic
 * list) by scrolling it page by page. SAP GUI and Web GUI hold only the rows
 * in view, so a range is read as a person would: scroll, read, scroll on.
 *
 * A surface gives two functions: scroll the control to a row, and read the
 * control as it is now (its lines of the full view, see `controlBlock`).
 * The answer is in the compact format, with every row under its number in
 * the whole list; a row that is on the screen when the read ends also says
 * its cell row (the row its cell ids name) when that is another number.
 *
 * Classic lists. A list keeps title rows at the top of its area (column
 * heads, the header block of FBL5N) and scrolls the lines below them: with
 * the list scrolled to line `first`, screen row `r` (r >= the number of
 * title rows) shows line `first + r - titles`. SAP GUI does not say how many
 * title rows a list has, and its page size can be one off (FBL5N: 13 rows
 * shown, page size 12), so the count is measured: one extra page one line
 * further on, and the count that makes both pages agree. Lines are then
 * numbered once, title rows written once, and the next page starts at the
 * first line not read yet.
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

export interface Row {
  /** Its number in the whole control. */
  n: number;
  /** The line as written: "  row 60: ...", with the cell row when it differs and the row is on screen. */
  text: string;
  /** The row its cell ids name (table control, list), when the control counts rows on the screen. */
  cell?: number;
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
  rows: Row[];
  /** Rows the control has in all, when it says. */
  total: number | undefined;
}

/** A page as pageOf reads it: also where it is scrolled to and, for a list, its rows by screen row. */
export interface ReadPage extends Page {
  /** Where the control is scrolled to (table control, list, tree), 0 when it does not say. */
  first: number;
  /** A list's rows on the screen, by screen row (the row of the cell ids): what the stitching works on. */
  screen: Map<number, string>;
  /** Rows a list shows at once, when it says. */
  visible: number | undefined;
  /** A list's title rows, as the reader says or as guessed from one page; undefined when nothing tells. */
  titleRows: number | undefined;
}

const ROW = /^ {2}(row) (\d+)((?: \((?:selected|total)\))*): /;

/** "  row 60 (cell row 0) (selected): body" from its parts. */
const rowText = (n: number, flags: string, body: string, cell?: number): string => `  row ${n}${cell !== undefined && cell !== n ? ` (cell row ${cell})` : ""}${flags}: ${body}`;

/**
 * The title rows of a list page as one page tells them: the reader's count
 * ("below 5 title rows", Web GUI), else the rows on screen beyond the page
 * size (SAP GUI, which says neither; a guess: a page that ends on a blank
 * line, or a page size one off, makes it wrong by one).
 */
function titleGuess(head: string, screen: Map<number, string>, visible: number | undefined): number | undefined {
  const said = /\bbelow (\d+) title rows/.exec(head)?.[1];
  if (said !== undefined) return Number(said);
  if (visible === undefined || !screen.size) return undefined;
  return Math.max(0, Math.max(...screen.keys()) + 1 - visible);
}

/**
 * The rows of one control, as the compact view writes them, numbered in the whole list. `fixedRows`, for a
 * list, is its number of title rows when the caller knows it better than the control's head (readList).
 */
export function pageOf(block: string, screen?: string, fixedRows?: number): ReadPage {
  const lines = compact(block, { maxChars: 0, emptyColumns: false, listColumns: false, emptyRuns: false, screenRows: true, numbers: false, ...(screen === undefined ? {} : { screen }) }).split("\n");
  const at = lines.findIndex((l, i) => i > 0 && !l.startsWith("WINDOW ") && !l.startsWith(" "));
  const head = lines[at] ?? "";
  const kind = (/ {2}(grid|table|tree|list) {2}/.exec(head)?.[1] ?? "other") as Page["kind"];
  // Rows of a table control, a list and a tree are counted on the screen: `first` is where the screen starts.
  const first = Number(/\bfirst (\d+)/.exec(head)?.[1] ?? 0);
  const visible = /\bvisible (\d+)/.exec(head)?.[1];
  const total = Number(/(\d+) (?:rows|lines)\b|\brows (\d+)|of (\d+) \(/.exec(head)?.slice(1).find((x) => x !== undefined) ?? Number.NaN);
  const listed = new Map<number, string>();
  if (kind === "list")
    for (const l of lines.slice(at + 1)) {
      const m = ROW.exec(l);
      if (m) listed.set(Number(m[2]), l.slice(m[0].length));
    }
  // A list that does not scroll has no title rows apart: its rows are its screen rows.
  const scrolls = kind === "list" && visible !== undefined;
  const titleRows = fixedRows ?? (scrolls ? titleGuess(head, listed, Number(visible)) : kind === "list" ? 0 : undefined);
  const fixed = titleRows ?? 0;
  const rows: Row[] = [];
  const titles: string[] = [];
  let i = 0;
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("  ") || l.startsWith("  ...") || l.startsWith("  (")) continue;
    // A table control's column legend: kept with the head.
    if (kind === "table" && l.startsWith("  columns: ")) {
      titles.push(l);
      continue;
    }
    const m = ROW.exec(l);
    const body = m ? l.slice(m[0].length) : "";
    if (kind === "grid" && m) rows.push({ n: Number(m[2]), text: l });
    else if (kind === "list" && m && Number(m[2]) < fixed) titles.push(`  title ${m[2]}: ${body}`);
    else if ((kind === "table" || kind === "list") && m) {
      const cell = Number(m[2]);
      const n = first + cell - fixed;
      rows.push({ n, text: rowText(n, m[3] ?? "", body, cell), cell });
    } else if (kind === "tree") rows.push({ n: first + i++, text: l });
  }
  return { head, frame: lines.slice(0, at), titles, kind, rows, total: Number.isNaN(total) ? undefined : total, first, screen: listed, visible: visible === undefined ? undefined : Number(visible), titleRows };
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
  // The columns a missing name is close to (its words in a column's id or title), when there are some: ten
  // "Length" columns say more than all seventy (Astra's review, 2026-11-23).
  const near = (names: string[]) => {
    const words = want.flatMap((w) => w.split(/[^a-z0-9]+/)).filter((w) => w.length > 1);
    const close = names.filter((n) => words.some((w) => n.toLowerCase().includes(w)));
    return close.length && close.length < names.length ? `the columns close to it are ${close.join(" | ")} (${close.length} of ${names.length})` : `its columns are ${names.join(" | ")}`;
  };
  const split = (row: string) => {
    const m = /^( {2}row \d+(?: \(cell row \d+\))?(?: \((?:selected|total)\))*: )(.*)$/.exec(row);
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
    if (!keep.length) throw new ActionError(`none of the columns ${cols.join(", ")} is in this grid: ${near(names)}.`);
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
  if (page.kind === "table") {
    // The legend names each column "N Title=cell id": a column asked for by its cell id ("txtVBAP-POSNR"), or by
    // the SAP name in it ("VBAP-POSNR"), is the column of that title and index. Before, only titles matched, and
    // every row of a read by ids came back "(empty)" (live 2026-11-20, VA03 items).
    const legend = page.titles.find((t) => t.startsWith("  columns: ")) ?? "";
    const columns = [...legend.matchAll(/(?:^ {2}columns: |, )(\d+) ([^=]+?)=([^\s,;]+)/g)].map((m) => ({ index: Number(m[1]), title: (m[2] ?? "").toLowerCase(), id: (m[3] ?? "").toLowerCase() }));
    const byId = columns.filter((c) => want.includes(c.id) || want.includes(c.id.replace(/^(?:ctxt|txt|chk|rad|cmb|btn|lbl|pwd)/, "")));
    const titleOf = (c: string) => (/^(.*?)(=| \[)/.exec(c)?.[1] ?? c).toLowerCase();
    const indexOf = (c: string) => /^[^=]*? \[col (\d+)\]=/.exec(c)?.[1];
    const kept = (c: string) => {
      const t = titleOf(c);
      if (want.includes(t)) return true;
      const i = indexOf(c);
      return byId.some((b) => b.title === t && (i === undefined || Number(i) === b.index));
    };
    if (columns.length && !columns.some((c) => want.includes(c.title) || byId.includes(c)))
      throw new ActionError(`none of the columns ${cols.join(", ")} is in this table: ${near(columns.map((c) => `${c.title}=${c.id}`))}.`);
    return {
      ...page,
      rows: page.rows.map((r) => {
        const p = split(r.text);
        if (!p) return r;
        const cells = p.body.split("; ").filter(kept);
        return { ...r, text: `${p.prefix}${cells.join("; ") || "(empty)"}` };
      }),
    };
  }
  return page;
}

/**
 * The title rows of a list, from pages read at different scroll positions:
 * the count under which the pages agree best. Below it a row is the same on
 * every page (a title); from it on, a row shows line `first + row - count`,
 * so two pages show one line at rows that differ by their scroll distance.
 * Only pages that show some lines in common count (a page one line on is
 * read for this): the title area of pages far apart says little, and SAP
 * changes it near the end of some lists (FBL5N shows a part of the next
 * page's header there). Undefined when no two pages are at different
 * positions; a tie goes to the count nearest `hint`.
 */
export function titleRowsOf(pages: { first: number; screen: Map<number, string> }[], hint = 0): number | undefined {
  const bottom = Math.max(0, ...pages.flatMap((p) => [...p.screen.keys()]));
  // Pages near enough to share lines whatever the count: the same pairs judge every count.
  const near = Math.max(1, Math.floor((bottom + 1 - hint) / 2));
  const pairs: [(typeof pages)[number], (typeof pages)[number]][] = [];
  for (let a = 0; a < pages.length; a++)
    for (let b = a + 1; b < pages.length; b++) {
      const d = Math.abs((pages[a]?.first ?? 0) - (pages[b]?.first ?? 0));
      if (d > 0 && d <= near) pairs.push([pages[a]!, pages[b]!]);
    }
  if (!pairs.length) return undefined;
  let best: { k: number; score: number } | undefined;
  for (let k = 0; k <= bottom + 1; k++) {
    let score = 0;
    for (const [a, b] of pairs) {
      let pair = 0;
      let shared = 0;
      for (let r = 0; r < k; r++) {
        const x = a.screen.get(r);
        const y = b.screen.get(r);
        if (x === undefined && y === undefined) continue;
        pair += x === y ? 1 : -1;
      }
      const d = b.first - a.first;
      for (let r = k; r <= bottom; r++) {
        const rb = r - d;
        if (rb < k || rb > bottom) continue;
        const x = a.screen.get(r);
        const y = b.screen.get(rb);
        if (x === undefined && y === undefined) continue;
        pair += x === y ? 1 : -1;
        shared++;
      }
      // Pages that share no line: their title areas alone say little (see above).
      if (shared) score += pair;
    }
    if (!best || score > best.score || (score === best.score && Math.abs(k - hint) < Math.abs(best.k - hint))) best = { k, score };
  }
  return best?.k;
}

/** Reads lines `from` to `to` of a classic list: see the head of this file. */
async function readList(source: RowSource, id: string, from: number, to: number, start: ReadPage): Promise<string> {
  const pages: ReadPage[] = [start];
  // The line each page was asked for: a page that starts before it is the end of the list.
  const asked: number[] = [from];
  const read = async (row: number): Promise<ReadPage> => {
    await source.scrollTo(row);
    const now = await source.block();
    if (!now) throw new ActionError(`No control "${id}" on this screen any more. Look at the screen again.`);
    const p = pageOf(now.block, now.screen);
    pages.push(p);
    asked.push(row);
    return p;
  };
  const one = start;
  const scrolls = one.visible !== undefined;
  // One more page, one line further on (or back, at the end): it tells the title rows apart from the lines.
  if (scrolls) {
    const next = await read(one.first + 1);
    if (next.first === one.first && one.first > 0) await read(one.first - 1);
  }
  // The count a page tells, from the top of the list when one is there: Web GUI's page shrinks by one once the
  // list has moved (ECC FBL5N, 2026-11-22), so a scrolled page's "below N title rows" can be one off. A tie-break only.
  const hint = [...pages.filter((p) => p.first === 0), ...pages].map((p) => p.titleRows).find((x) => x !== undefined) ?? 0;
  let fixed = titleRowsOf(pages, hint) ?? hint;
  const linesOf = (p: ReadPage) => [...p.screen.entries()].filter(([r]) => r >= fixed).map(([r, text]) => ({ n: p.first + r - fixed, r, text }));
  const total = () => pages[pages.length - 1]?.total;
  /**
   * Is line `n` read? A page has read the lines from its first one to the
   * last one it shows (blank lines have no cells); the last page of the list
   * every line after its first one.
   */
  const seen = (n: number) =>
    pages.some((p, i) => {
      if (n < p.first) return false;
      const end = (asked[i] ?? 0) > p.first ? Number.MAX_SAFE_INTEGER : p.first + Math.max(fixed, ...p.screen.keys()) - fixed;
      return n <= end;
    });
  for (let k = pages.length; scrolls && k < MAX_PAGES; k++) {
    const end = Math.min(to, (total() ?? Number.MAX_SAFE_INTEGER) - 1);
    let next = from;
    while (next <= end && seen(next)) next++;
    if (next > end) break;
    const before = pages.map((p) => p.first);
    const p = await read(next);
    // A list that does not move any more.
    if (before.includes(p.first) && !seen(next)) break;
    fixed = titleRowsOf(pages, hint) ?? fixed;
  }
  const last = pages[pages.length - 1]!;
  const lines = new Map<number, string>();
  for (const p of pages) for (const l of linesOf(p)) if (!lines.has(l.n)) lines.set(l.n, l.text);
  // The screen as it is now: its lines say their cell row.
  const onScreen = new Map(linesOf(last).map((l) => [l.n, l.r]));
  const rows = [...lines.entries()].filter(([n]) => n >= from && n <= to).sort((a, b) => a[0] - b[0]);
  const top = pages.reduce((a, p) => (p.first < a.first ? p : a), pages[0]!);
  const titles = [...top.screen.entries()].filter(([r]) => r < fixed).sort((a, b) => a[0] - b[0]).map(([r, t]) => `  title ${r}: ${t}`);
  const max = Math.max(-1, ...lines.keys());
  const count = Math.max(total() ?? 0, max + 1);
  const head = `${last.head.replace(/\bbelow \d+ title rows/, `below ${fixed} title rows`)}`;
  const out = rows.map(([n, t]) => rowText(n, "", t, onScreen.get(n)));
  const firstOn = [...onScreen.entries()].sort((a, b) => a[0] - b[0])[0];
  const where = firstOn
    ? ` Rows are numbered in the whole list (line 0 is the first line below ${fixed} title row${fixed === 1 ? "" : "s"}), as "rows" and scroll count them; a cell id counts rows on screen: a row on screen now says its cell row (row ${firstOn[0]} is lbl[col,${firstOn[1]}]), scroll to the others before acting on them.`
    : "";
  const note = rows.length ? `  (rows ${rows[0]?.[0]} to ${rows[rows.length - 1]?.[0]} of ${count}; the control is now scrolled there.${where})` : `  (no rows ${from} to ${to}: the list has ${count || "fewer"} lines)`;
  return [...last.frame, head, ...titles, ...out, note].join("\n");
}

export async function readRows(source: RowSource, id: string, from: number, to: number, cols?: string[]): Promise<string> {
  const got = new Map<number, Row>();
  let page: Page | undefined;
  let next = from;
  for (let n = 0; n < MAX_PAGES && next <= to; n++) {
    await source.scrollTo(next);
    const now = await source.block();
    if (!now) throw new ActionError(`No control "${id}" on this screen any more. Look at the screen again.`);
    const read = pageOf(now.block, now.screen);
    page = read;
    if (read.kind === "other") throw new ActionError(`"${id}" has no rows to read: "rows" works on a grid, a table control, a tree or a list.`);
    // A classic list has title rows above the lines that scroll: read apart, see readList.
    if (read.kind === "list") return readList(source, id, from, to, read);
    let progress = false;
    let last = -1;
    for (const r of page.rows) {
      last = Math.max(last, r.n);
      if (r.n < from || r.n > to || got.has(r.n)) continue;
      got.set(r.n, r);
      progress = true;
    }
    // The end of the list, or a control that does not move.
    if (!progress || last < next) break;
    next = last + 1;
    if (page.total !== undefined && next >= page.total) break;
  }
  if (!page) throw new ActionError(`"${id}" could not be read.`);
  // Rows on the screen now keep their cell row; rows read on an earlier page are not on the screen any more.
  const here = new Map(page.rows.map((r) => [r.n, r]));
  for (const [n, r] of got) {
    const now = here.get(n);
    if (now) got.set(n, now);
    else if (r.cell !== undefined) got.set(n, { n, text: r.text.replace(/ \(cell row \d+\)/, "") });
  }
  if (cols?.length) {
    const only = onlyColumns({ ...page, rows: [...got.values()] }, cols);
    page = only;
    got.clear();
    for (const r of only.rows) got.set(r.n, r);
  }
  const rows = [...got.entries()].sort((a, b) => a[0] - b[0]);
  const total = page.total === undefined ? "" : ` of ${page.total}`;
  const anchor = page.rows.find((r) => r.cell !== undefined);
  const where =
    page.kind === "table"
      ? ` Rows are numbered in the whole table, as "rows" and scroll count them; a cell id counts rows on screen: a row on screen now says its cell row${anchor && anchor.cell !== anchor.n ? ` (row ${anchor.n} is <id>[col,${anchor.cell}])` : ""}, scroll to the others before acting on them.`
      : "";
  const note = rows.length
    ? `  (rows ${rows[0]?.[0]} to ${rows[rows.length - 1]?.[0]}${total}; the control is now scrolled there.${where})`
    : page.kind === "table" && page.total !== undefined && from < page.total
      ? `  (rows ${from} to ${Math.min(to, page.total - 1)} hold nothing on the screen: SAP counts ${page.total} rows in this table, blank lines included. If you expect values here, look at the table with its id: it may be outside the part of the page that is drawn.)`
      : `  (no rows ${from} to ${to}: the control has ${page.total ?? "fewer"} rows)`;
  return [...page.frame, page.head, ...page.titles, ...rows.map(([, r]) => r.text), note].join("\n");
}
