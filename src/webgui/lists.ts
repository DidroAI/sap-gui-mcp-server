/**
 * Grids, table controls, trees, lists and dropdowns: scrolling to a row,
 * selecting rows, and the entries of a dropdown.
 */
import type { Locator } from "playwright-core";
import { ActionError } from "../core/types.js";
import { clean, evalLs, locate } from "./controls.js";
import { comboEntries, type MarkedControl, markSelector, type Scrolled, scrollControl } from "./page.js";
import { freshView, kindIn } from "./screen.js";
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

/**
 * Selects (or deselects) a row of a grid, table control or value-help list
 * by its row selector, the button at the left of the row, as a person
 * clicks it; and reads the state back. A grid row that is not drawn is
 * scrolled to first; a table control counts rows on screen.
 */
export async function selectRow(session: WebGuiSession, sid: string, row: number, on: boolean): Promise<string> {
  const target = { sid, row };
  let r = await evalLs(session, markSelector, target);
  let scrolled = "";
  if (notOnScreen(r) && kindIn(await freshView(session), sid) !== "table") ({ r, scrolled } = await markScrolled(session, sid, row, markSelector, target, r));
  if (typeof r === "string")
    throw new ActionError(notOnScreen(r) ? `${r}: a table control counts its rows on screen (row 0 is the first row shown); scroll it to bring the row into view.` : r);
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
  return `${on ? "selected" : "deselected"} row ${row} of ${sid}${scrolled}`;
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
  return clean(await loc.inputValue().catch(() => ""));
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
  if (idx < 0 && want) idx = texts.findIndex((t) => t.includes(want));
  if (idx < 0) {
    // Escape closes the open list; with no list open it would be Cancel (F12).
    if (entries.length > 0) await page.keyboard.press("Escape");
    throw new ActionError(entries.length ? `no entry "${clean(String(wanted ?? ""))}" in ${c.sid}: ${entries.map((e) => `${e.key}:${e.text}`).join(", ")}` : `the list of ${c.sid} did not open, so nothing was chosen. Look at the screen.`);
  }
  const chosen = clean(await items.nth(idx).innerText());
  const key = (await items.nth(idx).getAttribute("data-itemkey")) ?? "";
  await session.roundtrip(() => items.nth(idx).click(), 800);
  // The answer says what the dropdown shows now, not what was asked for (the screen may have been drawn again).
  const again = await locate(session, c.sid).catch(() => undefined);
  const after = again ? await comboShown(again.loc) : "";
  if (after && after !== chosen) throw new ActionError(`${c.sid} shows "${after}" after choosing "${chosen}" (it showed "${before}" before): SAP did not take the entry. Look at the screen.`);
  return `${c.sid} = ${key ? `${key} ` : ""}${chosen}${before === chosen ? " (it was already chosen)" : ""}`;
}
