/**
 * Reads rows N to M of a long control (grid, table control, tree, classic
 * list) by scrolling it page by page. SAP GUI and Web GUI hold only the rows
 * in view, so a range is read as a person would: scroll, read, scroll on.
 *
 * A surface gives two functions: scroll the control to a row, and read the
 * control as it is now (its lines of the full view, see `controlBlock`).
 * The answer is in the compact format, with every row under its number in
 * the whole table or list: the one number the view prints and actions take
 * ("row"; the server finds the row's cells on the screen). The cell row a
 * cell id names is not printed per row: the note at the end says how a
 * cell id counts. A table control is scrolled back to where it was, so that
 * a read changes nothing on the screen.
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
  /** The line as written: "  row 60: ...". */
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
  /** Rows `cols` left out because they hold none of the columns (a list). */
  left?: number;
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

/** "  row 60 (selected): body" from its parts: the row's number in the whole table or list, never its cell row. */
const rowText = (n: number, flags: string, body: string): string => `  row ${n}${flags}: ${body}`;

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
      rows.push({ n, text: rowText(n, m[3] ?? "", body), cell });
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
  if (page.kind === "list") return listOnly(page, cols, want);
  return page;
}

/** The cells of a list line as pageOf writes them: "AA {3} | 1.000,00 {53}". */
const listCells = (body: string): { text: string; c: number }[] =>
  body.split(" | ").flatMap((cell) => {
    const m = /^(.*) \{(\d+)\}$/.exec(cell);
    return m ? [{ text: m[1] ?? "", c: Number(m[2]) }] : [];
  });

/**
 * Keeps only some columns of a list (FBL5N "Type,DocumentNo"; before, `cols`
 * was not applied to lists, live 2026-11-23). A column is named by a title
 * of the list's heading ("DocumentNo") or by its position in braces ("78").
 * A heading's column runs from its position to the next heading's; a cell
 * belongs to the column it overlaps most (amounts are aligned right). Rows
 * that hold none of the columns (totals, the item lines of ME2L) are left out.
 */
function listOnly(page: Page, cols: string[], want: string[]): Page {
  const heads = page.titles
    .flatMap((t) => listCells(t.replace(/^ {2}title \d+: /, "")))
    .sort((a, b) => a.c - b.c);
  const spans = heads.map((h, i) => ({ title: h.text, from: h.c, to: heads[i + 1]?.c ?? Number.MAX_SAFE_INTEGER }));
  const picked: { from: number; to: number }[] = [];
  for (const w of want) {
    const byTitle = spans.filter((s) => s.title.toLowerCase() === w);
    if (byTitle.length) picked.push(...byTitle);
    else if (/^\d+$/.test(w)) picked.push(spans.find((s) => s.from === Number(w)) ?? { from: Number(w), to: Number(w) + 1 });
  }
  if (!picked.length)
    throw new ActionError(
      `none of the columns ${cols.join(", ")} is in this list: name a column by a title of the list's heading${heads.length ? ` (${heads.map((h) => `${h.text} {${h.c}}`).join(", ")})` : ""} or by its position, the number in braces after a value.`,
    );
  const columnOf = (cell: { text: string; c: number }) => {
    const end = cell.c + Math.max(1, cell.text.length);
    let best: { from: number; to: number } | undefined;
    let most = 0;
    for (const s of spans.length ? spans : picked) {
      const overlap = Math.min(end, s.to) - Math.max(cell.c, s.from);
      if (overlap > most) {
        most = overlap;
        best = s;
      }
    }
    return best;
  };
  const keep = (cell: { text: string; c: number }) => picked.some((p) => (spans.includes(p as (typeof spans)[number]) ? columnOf(cell) === p : cell.c === p.from));
  let dropped = 0;
  const rows = page.rows.flatMap((r) => {
    const m = /^( {2}row \d+(?: \((?:selected|total)\))*: )(.*)$/.exec(r.text);
    if (!m) return [r];
    const cells = listCells(m[2] ?? "").filter(keep);
    if (!cells.length) {
      dropped++;
      return [];
    }
    return [{ ...r, text: `${m[1]}${cells.map((x) => `${x.text} {${x.c}}`).join(" | ")}` }];
  });
  return { ...page, rows, ...(dropped ? { left: dropped } : {}) };
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

/**
 * Rows between the last row the screen showed before a read and the first
 * row of the range asked for: the agent took the last row it saw for
 * another number (ME2L, P2P-05: "row 15 (cell row 20)", then rows 20-47
 * were asked for and PO 4500001184 in rows 16 to 19 was never seen). Said
 * in the answer; "" when the range follows on, or nothing was shown.
 */
export function skippedNote(before: Page | undefined, from: number): string {
  const shown = before?.rows.map((r) => r.n) ?? [];
  if (!shown.length) return "";
  const last = Math.max(...shown);
  if (from <= last + 1 || Math.min(...shown) > last) return "";
  const a = last + 1;
  const b = from - 1;
  return ` The screen showed rows up to ${last}: row${a === b ? ` ${a} is` : `s ${a} to ${b} are`} not in this read ("rows":"${a}-${b}" reads ${a === b ? "it" : "them"}).`;
}

/** Reads lines `from` to `to` of a classic list: see the head of this file. */
async function readList(source: RowSource, id: string, from: number, to: number, start: ReadPage, cols: string[] | undefined, skipped: string, prior: ReadPage | undefined): Promise<string> {
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
  // Web GUI says how many title rows a list has, and how many lines it has in all.
  const webgui = /\bbelow \d+ title rows/.test(one.head);
  // One more page, one line further on (or back, at the end): it tells the title rows apart from the lines.
  if (scrolls) {
    const next = await read(one.first + 1);
    if (next.first === one.first && one.first > 0) await read(one.first - 1);
  }
  // The count a page tells, from the top of the list when one is there: Web GUI's page shrinks by one once the
  // list has moved (ECC FBL5N, 2026-11-22), so a scrolled page's "below N title rows" can be one off. A tie-break only.
  const hint = [...pages.filter((p) => p.first === 0), ...pages].map((p) => p.titleRows).find((x) => x !== undefined) ?? 0;
  const total = () => pages[pages.length - 1]?.total;
  /**
   * A count that numbers a line at or past the end of the list is too small:
   * Web GUI's total counts the lines (key 10 of the scrollbar). A blank title
   * row taken for a line put FBL5N's rows one on and said "of 57" for 56
   * (live 2026-11-23). SAP GUI's total can be one off: not checked there.
   */
  const fits = (k: number): number => {
    const all = total();
    if (!webgui || all === undefined) return k;
    const bottom = Math.max(0, ...pages.flatMap((p) => [...p.screen.keys()]));
    let n = k;
    while (n < bottom && pages.some((p) => [...p.screen.keys()].some((r) => r >= n && p.first + r - n >= all))) n++;
    return n;
  };
  let fixed = fits(titleRowsOf(pages, hint) ?? hint);
  const linesOf = (p: ReadPage) => [...p.screen.entries()].filter(([r]) => r >= fixed).map(([r, text]) => ({ n: p.first + r - fixed, r, text }));
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
    fixed = fits(titleRowsOf(pages, hint) ?? fixed);
  }
  let last = pages[pages.length - 1]!;
  const lines = new Map<number, string>();
  for (const p of pages) for (const l of linesOf(p)) if (!lines.has(l.n)) lines.set(l.n, l.text);
  // The list goes back to where the screen had it, as a table control does: a read changes nothing on the
  // screen (FBL5N was left scrolled, live 2026-11-23).
  let restored = false;
  if (prior && prior.first !== last.first) {
    await source.scrollTo(prior.first);
    const now = await source.block();
    if (now) {
      const back = pageOf(now.block, now.screen);
      if (back.first === prior.first) {
        last = back;
        restored = true;
      }
    }
  }
  // The screen as it is now: where a cell id finds a line.
  const onScreen = new Map(linesOf(last).map((l) => [l.n, l.r]));
  const top = pages.reduce((a, p) => (p.first < a.first ? p : a), pages[0]!);
  const allTitles = [...top.screen.entries()].filter(([r]) => r < fixed).sort((a, b) => a[0] - b[0]);
  // The list's header lines (FBL5N: 12 lines about the customer) come once, with a read from line 0; any other
  // read has the column heading only (the title line with the most cells), not 900 bytes again each time.
  const heading = allTitles.reduce<[number, string] | undefined>((a, t) => (!a || t[1].split(" | ").length >= a[1].split(" | ").length ? t : a), undefined);
  const whole = from === 0 && !cols?.length;
  const titles = (whole || !heading ? allTitles : [heading]).map(([r, t]) => `  title ${r}: ${t}`);
  const titlesLeft = whole || !heading ? 0 : allTitles.length - 1;
  const max = Math.max(-1, ...lines.keys());
  const count = Math.max(total() ?? 0, max + 1);
  const head = `${last.head.replace(/\bbelow \d+ title rows/, `below ${fixed} title rows`)}`;
  let page: Page = {
    head,
    frame: last.frame,
    kind: "list",
    titles,
    rows: [...lines.entries()]
      .filter(([n]) => n >= from && n <= to)
      .sort((a, b) => a[0] - b[0])
      .map(([n, t]) => ({ n, text: rowText(n, "", t) })),
    total: count,
  };
  const read0 = page.rows.map((r) => r.n);
  if (cols?.length) page = onlyColumns(page, cols);
  const firstOn = [...onScreen.entries()].sort((a, b) => a[0] - b[0])[0];
  const where = firstOn
    ? ` Rows are numbered in the whole list (line 0 is the first line below ${fixed} title row${fixed === 1 ? "" : "s"}): "rows" and "row" in actions take these numbers. A cell id counts rows on the screen: row ${firstOn[0]} is lbl[col,${firstOn[1]}] now, col in braces.`
    : "";
  const left = page.left ? ` ${page.left} rows that hold none of these columns are left out.` : "";
  const scrolledTo = restored ? ` the list is scrolled back to line ${prior?.first ?? 0}, as it was.` : " the control is now scrolled there.";
  const moreTitles = titlesLeft ? ` ${titlesLeft} more title line${titlesLeft === 1 ? "" : "s"} (the list's header) come with "rows" from 0.` : "";
  const note = read0.length
    ? `  (rows ${read0[0]} to ${read0[read0.length - 1]} of ${count};${scrolledTo}${left}${where}${moreTitles})`
    : `  (no rows ${from} to ${to}: the list has ${count || "fewer"} lines)`;
  // Rows the read skips past are said first: at the end of a long answer the agent did not see it (live 2026-11-23).
  const first = skipped ? [`  (${skipped.trim()})`] : [];
  return [...page.frame, page.head, ...first, ...page.titles, ...page.rows.map((r) => r.text), note].join("\n");
}

/** Runs of rows that hold nothing on one line: "  rows 25 to 40: (empty)". */
function foldEmpty(rows: Row[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!/^ {2}row \d+: \(empty\)$/.test(r.text)) {
      out.push(r.text);
      continue;
    }
    let j = i;
    while (j + 1 < rows.length && /^ {2}row \d+: \(empty\)$/.test(rows[j + 1]!.text) && rows[j + 1]!.n === rows[j]!.n + 1) j++;
    out.push(j > i ? `  rows ${r.n} to ${rows[j]!.n}: (empty)` : r.text);
    i = j;
  }
  return out;
}

/**
 * Reads rows `from` to `to` of a grid, table control, tree or list.
 * `before` is the control as the screen showed it before the read (its
 * block of the full view): a table control is scrolled back there after the
 * read, and rows the range skips past are said.
 */
export async function readRows(source: RowSource, id: string, from: number, to: number, cols?: string[], before?: { block: string; screen: string }): Promise<string> {
  const prior = before ? pageOf(before.block, before.screen) : undefined;
  const skipped = skippedNote(prior, from);
  const got = new Map<number, Row>();
  let page: Page | undefined;
  let read: ReadPage | undefined;
  let next = from;
  for (let n = 0; n < MAX_PAGES && next <= to; n++) {
    await source.scrollTo(next);
    const now = await source.block();
    if (!now) throw new ActionError(`No control "${id}" on this screen any more. Look at the screen again.`);
    read = pageOf(now.block, now.screen);
    page = read;
    if (read.kind === "other") throw new ActionError(`"${id}" has no rows to read: "rows" works on a grid, a table control, a tree or a list.`);
    // A classic list has title rows above the lines that scroll: read apart, see readList.
    if (read.kind === "list") return readList(source, id, from, to, read, cols, skipped, prior?.kind === "list" ? prior : undefined);
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
  if (!page || !read) throw new ActionError(`"${id}" could not be read.`);
  const table = page.kind === "table";
  // A table control goes back to where the screen had it: a read changes nothing on the screen (MM03 "Select
  // View(s)": a read left it scrolled, live 2026-11-23). Its rows keep their numbers either way.
  let at = read.first;
  if (table && prior?.kind === "table" && prior.first !== read.first) {
    await source.scrollTo(prior.first);
    at = prior.first;
  }
  // The head says where the table is now.
  if (table) page = { ...page, head: page.head.replace(/; row 0 here is row \d+ of the table\)$/, ")").replace(/(\(visible [^)]*?)(?:, first \d+)?\)/, (_m, v: string) => `${v}${at ? `, first ${at}` : ""})`) };
  if (cols?.length) {
    const only = onlyColumns({ ...page, rows: [...got.values()] }, cols);
    page = only;
    got.clear();
    for (const r of only.rows) got.set(r.n, r);
  }
  const rows = [...got.values()].sort((a, b) => a.n - b.n);
  const total = page.total === undefined ? "" : ` of ${page.total}`;
  const scrolledTo = table ? (at === read.first ? " the table is now scrolled there." : ` the table is scrolled back to row ${at}, as it was.`) : " the control is now scrolled there.";
  const where = table
    ? ` Rows are numbered in the whole table: "row" in select, set and check takes these numbers, and the server scrolls to the row. A cell id counts rows on the screen instead${at ? `: <id>[col,0] is row ${at} now` : ""}.`
    : "";
  // Rows past the last one that holds something, up to the end of the table, are blank lines SAP counts too.
  const end = page.total === undefined ? undefined : Math.min(to, page.total - 1);
  const filled = rows.filter((r) => !/: \(empty\)$/.test(r.text)).map((r) => r.n);
  const lastFilled = filled.length ? Math.max(...filled) : undefined;
  const allDrawn = read.visible !== undefined && page.total !== undefined && read.first + read.visible >= page.total;
  const blank =
    table && end !== undefined && lastFilled !== undefined && lastFilled < end && (allDrawn || rows.some((r) => r.n === end))
      ? ` Rows ${lastFilled + 1} to ${end} hold nothing: SAP counts ${page.total} rows in this table, blank lines included.`
      : "";
  const note = rows.length
    ? `  (rows ${rows[0]?.n} to ${rows[rows.length - 1]?.n}${total};${scrolledTo}${blank}${where}${skipped})`
    : table && page.total !== undefined && from < page.total
      ? `  (rows ${from} to ${Math.min(to, page.total - 1)} hold nothing on the screen: SAP counts ${page.total} rows in this table, blank lines included. If you expect values here, look at the table with its id: it may be outside the part of the page that is drawn.${skipped})`
      : `  (no rows ${from} to ${to}: the control has ${page.total ?? "fewer"} rows${skipped ? `.${skipped}` : ""})`;
  return [...page.frame, page.head, ...page.titles, ...(table ? foldEmpty(rows) : rows.map((r) => r.text)), note].join("\n");
}
