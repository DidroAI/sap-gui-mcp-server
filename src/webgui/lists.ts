/**
 * Grids, table controls, trees, lists and dropdowns: scrolling to a row,
 * selecting rows, and the entries of a dropdown.
 */
import type { Locator } from "playwright-core";
import { ActionError } from "../core/types.js";
import { clean, entryList, evalLs, locate } from "./controls.js";
import { comboEntries, type MarkedControl, markSelector, type Scrolled, scrollControl } from "./page.js";
import { freshView, kindIn, look } from "./screen.js";
import type { WebGuiSession } from "./session.js";

/** A page function's answer for a row that is not drawn. */
export const notOnScreen = (r: unknown): boolean => typeof r === "string" && / is not on screen$/.test(r);

/** "(scrolled to it: rows 40 to 59 of 300 are shown)" */
export const scrolledNote = (sc: Scrolled): string => ` (scrolled to it: rows ${sc.first} to ${Math.min(sc.first + sc.visible, sc.total) - 1} of ${sc.total} are shown)`;

/** Moves a grid, table control, tree or list to a row and waits for the rows. */
export async function scrollTo(session: WebGuiSession, sid: string, to: number | string): Promise<Scrolled | string> {
  let r: Scrolled | string = "";
  await session.roundtrip(async () => {
    r = await evalLs(session, scrollControl, { sid, to });
    if (typeof r !== "string" && !r.moved) {
      // No access to the scrollbar object in this Web GUI: its page areas still take a click.
      if (to !== "next" && to !== "prev") throw new ActionError(`This Web GUI does not let the server move ${sid} to a row: scroll with "to":"next" or "prev".`);
      await session.frame.locator(`[id="${r.bar}-${to === "next" ? "bar" : "spc"}"]`).click({ position: { x: 5, y: 5 }, timeout: 5000 });
    }
  }, 600);
  const done = r as Scrolled | string;
  if (typeof done === "string") {
    if (done.startsWith("all rows")) return done;
    throw new ActionError(done);
  }
  if (typeof to === "string" && /^(right|left|rightmost|leftmost)$/.test(to)) return done;
  // Where it is now: the end of the list stops a scroll short of the row asked for.
  const now = await evalLs(session, scrollControl, { sid, to: "here" }).catch(() => "");
  return typeof now === "string" ? done : { ...done, first: now.from };
}

/**
 * Marks a row with `mark` (a page function), scrolling it into view first
 * when it is not drawn. The rows are drawn a moment after the scroll's round
 * trip: the mark is tried again for up to 2 s.
 */
export async function markScrolled<A, R>(session: WebGuiSession, sid: string, row: number, mark: (a: A) => R, target: A, first: R): Promise<{ r: R; scrolled: string }> {
  const sc = await scrollTo(session, sid, row);
  if (typeof sc === "string") return { r: first, scrolled: "" };
  let r = first;
  for (let i = 0; i < 10; i++) {
    r = await evalLs(session, mark, target);
    if (!notOnScreen(r)) break;
    await session.page.waitForTimeout(200);
  }
  return { r, scrolled: scrolledNote(sc) };
}

/** The most a row takes to show that its selector was clicked: after this long the click did not change it. */
const SELECTION_SHOWN_MS = 2000;

/** Where a table control of the view is scrolled to, how many rows it shows and has: from its line. */
export function tableAt(view: string, sid: string): { first: number; visible: number | undefined; total: number | undefined } | undefined {
  const line = view.split("\n").find((l) => l.startsWith(`${sid}  table  `));
  if (!line) return undefined;
  const num = (re: RegExp) => {
    const m = re.exec(line)?.[1];
    return m === undefined ? undefined : Number(m);
  };
  return { first: num(/\(visible [^)]*\bfirst (\d+)\)/) ?? 0, visible: num(/\(visible (\d+)/), total: num(/ {2}table {2}rows (\d+)/) };
}

/**
 * The screen row of row `row` of a table control (numbered in the whole
 * table, as the view prints it): the table is scrolled to the row first
 * when it is not on the screen. A table control's cells and row selectors
 * count rows on the screen; the agent counts them as the view does (MM03:
 * "select row 12" selected the row the view called 22, live 2026-11-23).
 */
export async function tableScreenRow(session: WebGuiSession, sid: string, row: number): Promise<{ vrow: number; first: number; view: string; scrolled: string }> {
  if (!Number.isInteger(row) || row < 0) throw new ActionError(`"row" is a row number from 0, as the view numbers the rows of ${sid} (in the whole table).`);
  let view = await freshView(session);
  let at = tableAt(view, sid);
  if (!at) throw new ActionError(`No table control ${sid} on this screen.`);
  if (at.total !== undefined && row >= at.total) throw new ActionError(`row ${row}: ${sid} has ${at.total} rows (0 to ${at.total - 1}).`);
  let scrolled = "";
  const shown = (a: NonNullable<typeof at>) => row >= a.first && (a.visible === undefined || row < a.first + a.visible);
  if (!shown(at)) {
    const sc = await scrollTo(session, sid, row);
    view = await look(session);
    at = tableAt(view, sid) ?? at;
    if (typeof sc !== "string") scrolled = scrolledNote({ ...sc, first: at.first });
    if (!shown(at)) throw new ActionError(`row ${row} of ${sid} could not be scrolled into view (the table shows rows ${at.first} to ${at.first + (at.visible ?? 1) - 1}).`);
  }
  return { vrow: row - at.first, first: at.first, view, scrolled };
}

/**
 * Selects (or deselects) a row of a grid, table control or value-help list
 * by its row selector, the button at the left of the row, as a person
 * clicks it; and reads the state back. `row` is the number the view prints:
 * in the whole list for a grid, in the whole table for a table control. A
 * row that is not drawn is scrolled to first.
 */
export async function selectRow(session: WebGuiSession, sid: string, row: number, on: boolean): Promise<string> {
  const table = kindIn(await freshView(session), sid) === "table";
  let scrolled = "";
  let target = { sid, row };
  if (table) {
    const at = await tableScreenRow(session, sid, row);
    scrolled = at.scrolled;
    target = { sid, row: at.vrow };
  }
  let r = await evalLs(session, markSelector, target);
  if (notOnScreen(r) && !table) ({ r, scrolled } = await markScrolled(session, sid, row, markSelector, target, r));
  if (typeof r === "string") throw new ActionError(notOnScreen(r) ? `row ${row} of ${sid} is not on screen: scroll it into view.` : r);
  if (r.selected === on) return `row ${row} of ${sid} was already ${on ? "selected" : "not selected"}: nothing changed${scrolled}`;
  await session.roundtrip(async () => {
    await session.frame.locator("[data-sap-act='selector']").first().click({ timeout: 10000 });
    // The row shows the selection a moment after the click: a table control marks it in the page about
    // 350 ms later and sends nothing (measured on ECC), a grid after its round trip. The row itself is the signal.
    const t0 = Date.now();
    while (Date.now() - t0 < SELECTION_SHOWN_MS) {
      const r = await evalLs(session, markSelector, target).catch(() => "");
      if (typeof r !== "string" && r.selected === on) break;
      await session.page.waitForTimeout(25);
    }
  }, 800);
  const now = await evalLs(session, markSelector, target).catch(() => "");
  if (typeof now !== "string" && now.selected !== on)
    throw new ActionError(`row ${row} of ${sid} is still ${now.selected ? "selected" : "not selected"}: the click on its row selector did not change it. Look at the screen.`);
  // Selecting a row adds it to the rows already selected, as a click on a row selector does in SAP: said, so
  // a function on "the selected row" is not run on more rows than meant (live 2026-11-23: rows 0 and 1 both selected).
  const others = on ? othersSelected(await look(session).catch(() => ""), sid, row) : [];
  const also = others.length ? ` (row${others.length === 1 ? "" : "s"} ${others.join(",")} ${others.length === 1 ? "is" : "are"} selected too: {"do":"select","id":"${sid}","row":N,"value":false} clears one)` : "";
  return `${on ? "selected" : "deselected"} row ${row} of ${sid}${scrolled}${also}`;
}

/** The rows of table `sid` the view names as selected, other than `row`. */
export function othersSelected(view: string, sid: string, row: number): number[] {
  const line = view.split("\n").find((l) => l.startsWith(`${sid}  `)) ?? "";
  return (/; selected rows ([\d,]+)/.exec(line)?.[1] ?? "").split(",").filter(Boolean).map(Number).filter((n) => n !== row);
}

/** The visible entries of an open list, as key and text. */
async function listed(items: Locator): Promise<{ key: string; text: string }[]> {
  // One round trip for the whole list (two per entry before).
  const raw = await items.evaluateAll((els) => els.map((e) => ({ key: e.getAttribute("data-itemkey") ?? "", text: (e as HTMLElement).innerText ?? "" })));
  return raw.map((e) => ({ key: e.key, text: clean(e.text) }));
}

/** Every entry of a dropdown: from the page when it holds them, else by opening the list and closing it again. */
export async function entriesOf(session: WebGuiSession, sid: string): Promise<{ key: string; text: string }[]> {
  const held = await evalLs(session, comboEntries, sid);
  if (typeof held === "string") throw new ActionError(held);
  if (held.length) return held;
  const { loc } = await locate(session, sid);
  await loc.click();
  // Not tuned: the time the list takes to open.
  await session.page.waitForTimeout(400);
  const out = await listed(session.frame.locator("[ct='LIB_I'],[role='option']").filter({ visible: true }));
  // Escape closes the open list; with no list open it would be Cancel (F12), so it is sent only to a list.
  if (out.length > 0) await session.page.keyboard.press("Escape");
  await session.page.waitForTimeout(150);
  return out;
}

/** The entry a dropdown shows now, read from its input: "" when it cannot be read. */
async function comboShown(loc: Locator): Promise<string> {
  // An input; in an S/4HANA table control a text box span (ct CB), whose text is the entry shown.
  return clean(await loc.inputValue().catch(() => loc.innerText({ timeout: 2000 }).catch(() => "")));
}

/** The key of the entry a dropdown holds, as the server drew it (ECC: lsdata key 3; S/4HANA 2025: key 4, key 3 names the field): "" when it cannot be read. */
async function comboKey(loc: Locator): Promise<string> {
  return loc
    .evaluate((e) => {
      const ls = e.getAttribute("data-ls") ?? "";
      const k = (n: number) => (new RegExp(`[{,]${n}:'((?:[^'\\\\]|\\\\.)*)'`).exec(ls)?.[1] ?? "").replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, "$1");
      const k3 = k(3);
      return /^[A-Z0-9_/]+-[A-Z0-9_]+/.test(k3) ? k(4) : k3;
    })
    .catch(() => "");
}

/**
 * Chooses an entry of a dropdown, by key or by shown text (whole, then the
 * start, then a part), from the dropdown's own list; and answers with what
 * the dropdown shows after.
 */
export async function chooseEntry(session: WebGuiSession, c: MarkedControl, loc: Locator, wanted: unknown): Promise<string> {
  const page = session.page;
  const f = session.frame;
  const want = clean(String(wanted ?? "")).toLowerCase();
  // This dropdown's own list box (ECC: lsdata key 2; S/4HANA 2025: aria-controls): other dropdowns' lists stay out.
  const listId = await loc
    .evaluate((e) => {
      const ls = e.getAttribute("data-ls") ?? "";
      const k3 = /[{,]3:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? "";
      if (/^[A-Z0-9_/]+-[A-Z0-9_]+/.test(k3) && e.getAttribute("aria-controls")) return e.getAttribute("aria-controls") ?? "";
      const k2 = /[{,]2:'((?:[^'\\]|\\.)*)'/.exec(ls)?.[1] ?? "";
      return k2.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, "$1") || e.getAttribute("aria-controls") || "";
    })
    .catch(() => "");
  const items = (listId ? f.locator(`[id="${listId}"]`).locator("[ct='LIB_I'],[role='option']") : f.locator("[ct='LIB_I'],[role='option']")).filter({ visible: true });
  const before = await comboShown(loc);
  await loc.click();
  // Not tuned: the time the list takes to open (and to load its entries).
  await page.waitForTimeout(300);
  // Some lists open from the arrow next to the field.
  if (!(await items.count())) {
    await f.locator(`[id="${await loc.getAttribute("id")}-btn"]`).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const entries = await listed(items);
  const texts = entries.map((e) => e.text.toLowerCase());
  const keys = entries.map((e) => e.key.toLowerCase());
  let idx = keys.indexOf(want);
  if (idx < 0) idx = texts.findIndex((t) => t === want || t.startsWith(`${want} `));
  // A part of a text only when one entry has it: the first of several was a guess.
  if (idx < 0 && want && texts.filter((t) => t.includes(want)).length === 1) idx = texts.findIndex((t) => t.includes(want));
  if (idx < 0) {
    // Escape closes the open list; with no list open it would be Cancel (F12).
    if (entries.length > 0) await page.keyboard.press("Escape");
    throw new ActionError(entries.length ? `no entry "${clean(String(wanted ?? ""))}" in ${c.sid}: ${entryList(entries)}` : `the list of ${c.sid} did not open, so nothing was chosen. Look at the screen.`);
  }
  const chosen = clean(await items.nth(idx).innerText());
  const key = (await items.nth(idx).getAttribute("data-itemkey")) ?? "";
  await session.roundtrip(() => items.nth(idx).click(), 800);
  // The answer says what the dropdown shows now, not what was asked for (the screen may have been drawn again).
  const again = await locate(session, c.sid).catch(() => undefined);
  const after = again ? await comboShown(again.loc) : "";
  // SAP may show the chosen entry under another text (a role taken up shows as "Customer (New)"): the key says which entry it is.
  if (after && after !== chosen && key && again && (await comboKey(again.loc)) === key) return `${c.sid} = ${key} ${after} (chosen as "${chosen}"; SAP shows it as "${after}")`;
  // The list may show an entry by its key alone ("F2") and the field by key and text ("F2 Invoice"), or the other
  // way round: the entry is in the field when one starts with the other at a word's end.
  const same = (a: string, b: string) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
  if (after && after !== chosen && same(after, chosen)) return `${c.sid} = ${key && !after.startsWith(key) ? `${key} ` : ""}${after}${before === after ? " (it was already chosen)" : ""}`;
  if (after && after !== chosen) throw new ActionError(`${c.sid} shows "${after}" after choosing "${chosen}" (it showed "${before}" before): SAP did not take the entry. Look at the screen.`);
  return `${c.sid} = ${key ? `${key} ` : ""}${chosen}${before === chosen ? " (it was already chosen)" : ""}`;
}

/** A cell of a table control in the full view: "<table>/<ctl><NAME>[c,r]  <kind>  ...". */
const TABLE_CELL = /^(.+)\/([a-z]+)([^/[\s]+)\[(\d+),(\d+)\] {2}(\S+)/;
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/^ | $/g, "").toLowerCase();

/**
 * The column a "col" names in a table control of the full view: its number
 * (from 0, as the legend counts), its field name ("RV45A-MABNR", "MABNR",
 * or the whole cell prefix "ctxtRV45A-MABNR") or its title ("Material").
 * Throws, naming the columns, when none fits.
 */
export function tableColumn(view: string, sid: string, col: unknown): number {
  const lines = view.split("\n");
  const head = lines.find((l) => l.startsWith(`${sid}  table  `)) ?? "";
  const titles = head.includes("columns: ") ? (head.split("columns: ")[1] ?? "").split(" | ").map((t) => t.replace(/^ +| +$/g, "")) : [];
  const cells = lines.flatMap((l) => {
    const m = TABLE_CELL.exec(l);
    return m && m[1] === sid ? [{ ctl: m[2] ?? "", name: m[3] ?? "", c: Number(m[4]) }] : [];
  });
  const raw = typeof col === "number" ? String(col) : typeof col === "string" ? col.replace(/^ +| +$/g, "") : "";
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n < titles.length || cells.some((x) => x.c === n)) return n;
  } else if (raw) {
    const want = raw.toLowerCase();
    const field = cells.find((x) => `${x.ctl}${x.name}`.toLowerCase() === want || x.name.toLowerCase() === want || x.name.toLowerCase().endsWith(`-${want}`));
    if (field) return field.c;
    const title = titles.findIndex((t) => norm(t) === norm(raw));
    if (title >= 0) return title;
  }
  const fields = new Map(cells.map((x) => [x.c, `${x.ctl}${x.name}`]));
  const known = titles.length ? titles.map((t, i) => `${i} ${t || "?"}${fields.has(i) ? `=${fields.get(i)}` : ""}`) : [...fields].sort((a, b) => a[0] - b[0]).map(([i, f]) => `${i}=${f}`);
  throw new ActionError(`${sid} has no column "${raw}". "col" is a column number, title or field name: ${known.join(", ")}.`);
}

/**
 * The id of the cell of a table control at screen row `vrow` in the column
 * "col" names, from the full view; the cell id form is named when the row
 * has no cell there.
 */
export function tableCellId(view: string, sid: string, vrow: number, col: unknown, row = vrow): string {
  const c = tableColumn(view, sid, col);
  const lines = view.split("\n");
  const inCol = lines.flatMap((l) => {
    const m = TABLE_CELL.exec(l);
    return m && m[1] === sid && Number(m[4]) === c ? [{ id: l.split("  ", 1)[0] ?? "", ctl: m[2] ?? "", name: m[3] ?? "", r: Number(m[5]) }] : [];
  });
  const hit = inCol.find((x) => x.r === vrow);
  if (hit) return hit.id;
  const like = inCol[0];
  throw new ActionError(
    `row ${row} of ${sid} has no cell in column ${c} on the screen (an empty row that takes no input, or a column scrolled out sideways).${like ? ` Its cell id would be ${sid}/${like.ctl}${like.name}[${c},${vrow}] (a cell id counts rows on the screen).` : ""}`,
  );
}

/** Where a classic list of the view is scrolled to and how its rows are numbered, from its line. */
export function listAt(view: string, sid: string): { first: number; visible: number | undefined; titles: number | undefined } | undefined {
  const line = view.split("\n").find((l) => l.startsWith(`${sid}  list  `));
  if (!line) return undefined;
  const num = (re: RegExp) => {
    const m = re.exec(line)?.[1];
    return m === undefined ? undefined : Number(m);
  };
  const visible = num(/\(visible (\d+)/);
  // As the compact view numbers it: a list that scrolls and says its title rows (Web GUI) in the whole list,
  // else by its rows on the screen.
  const titles = visible === undefined ? undefined : num(/\bbelow (\d+) title rows/);
  return { first: num(/\bfirst (\d+)/) ?? 0, visible, titles };
}

/**
 * The screen row of row `row` of a classic list, numbered as the compact
 * view numbers it; undefined when the row is not on the screen now.
 */
export function listScreenRow(view: string, sid: string, row: number): number | undefined {
  const at = listAt(view, sid);
  if (!at) return undefined;
  if (at.titles === undefined) return row;
  const r = row - at.first + at.titles;
  if (r < at.titles || (at.visible !== undefined && r >= at.titles + at.visible)) return undefined;
  return r;
}

/**
 * The id of a cell of a list line at screen row `r`: the one at column
 * `col` (exact, else the cell that covers it), the first checkbox for
 * `checkbox`, else the first cell with text.
 */
export function listCellId(view: string, sid: string, r: number, col: unknown, checkbox = false): string | undefined {
  const cells = view.split("\n").flatMap((l) => {
    const m = /^(\S+)\/(lbl|chk|txt|ctxt)\[(\d+),(\d+)\] {2}(?:label {2}|checkbox {2}|field {2})?(.*)$/.exec(l);
    return m && m[1] === sid && Number(m[4]) === r ? [{ id: `${sid}/${m[2]}[${m[3]},${m[4]}]`, kind: m[2] ?? "", c: Number(m[3]), text: m[5] ?? "" }] : [];
  });
  cells.sort((a, b) => a.c - b.c);
  const raw = typeof col === "number" ? String(col) : typeof col === "string" ? col.replace(/^ +| +$/g, "") : "";
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return (cells.find((x) => x.c === n && (!checkbox || x.kind === "chk")) ?? cells.find((x) => x.c <= n && n < x.c + Math.max(1, x.text.length) && (!checkbox || x.kind === "chk")))?.id;
  }
  if (checkbox) return cells.find((x) => x.kind === "chk")?.id;
  return (cells.find((x) => x.kind !== "chk" && x.text) ?? cells[0])?.id;
}

/**
 * The column id of an ALV grid that "col" names, from the grid's line of
 * the full view ("columns: VBELN=Sales Document | NETWR=Net Value (Item)"):
 * the id itself, or a title, as sap_look's "cols" takes them (before, a
 * title was refused by "grid": live 2026-11-23, VA05). "col" as it is when
 * neither fits (the page names the columns then).
 */
export function gridColumnId(view: string, sid: string, col: unknown): unknown {
  if (typeof col !== "string" || !col.trim()) return col;
  const line = view.split("\n").find((l) => l.startsWith(`${sid}  grid  `));
  if (!line?.includes("; columns: ")) return col;
  const columns = (line.slice(line.indexOf("; columns: ") + 11).split("; ")[0] ?? "").split(" | ").map((c) => {
    const at = c.indexOf("=");
    return at < 0 ? { id: c, title: "" } : { id: c.slice(0, at), title: c.slice(at + 1) };
  });
  const want = col.trim();
  const byId = columns.find((c) => c.id === want) ?? columns.find((c) => c.id.toLowerCase() === want.toLowerCase());
  if (byId) return byId.id;
  const byTitle = columns.find((c) => norm(c.title) === norm(want));
  return byTitle ? byTitle.id : col;
}
