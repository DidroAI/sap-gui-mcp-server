/**
 * Finding a control of the Web GUI page and acting on it: the page functions
 * run on `data-ls` (see normalizeLsdata), the control an action means is
 * marked (`data-sap-act`) and Playwright clicks or types into the mark.
 */
import type { Locator } from "playwright-core";
import { ONE_LINE_NOTE, oneLine } from "../core/action.js";
import { ActionError } from "../core/types.js";
import { vkey } from "./keys.js";
import { type MarkedControl, markControl, menuRowOpen, normalizeLsdata, openOverlay } from "./page.js";
import type { WebGuiSession } from "./session.js";

/**
 * How long to wait for the request of a step that always sends one (a
 * function key, a button, a command). The wait ends when the request
 * starts, so this costs nothing when the browser is quick; when it is slow
 * (a busy machine), 1.5 s was not enough once in a soak run, and the answer
 * showed the screen from before the step.
 */
export const SURE_START_MS = 5000;

/**
 * Runs a page function in the Web GUI frame on `data-ls` brought up to date.
 * Web GUI of ECC writes `lsdata` as a JavaScript object literal; Web GUI of
 * S/4HANA 2025 writes strict JSON. normalizeLsdata copies every `lsdata`
 * into `data-ls` in the ECC form, so the page functions read one form. A
 * normalisation that fails leaves `data-ls` as it was.
 */
export async function evalLs<A, R>(session: WebGuiSession, fn: (arg: A) => R, arg: A): Promise<R> {
  // One round trip: the normalisation and the function in one expression (each was an evaluate of its own).
  return session.frame.evaluate(withLs(fn, arg)) as Promise<R>;
}

/** The expression evalLs runs: normalizeLsdata (its failure ignored), then `fn(arg)`. Page functions close over nothing, so their source runs as it is. */
function withLs<A, R>(fn: (arg: A) => R, arg: A): string {
  return `(() => { try { (${normalizeLsdata})(); } catch {} return (${fn})(${arg === undefined ? "" : JSON.stringify(arg)}); })()`;
}

/** The answer for an id that names nothing on the screen, as the guard and `sap_look` say it. */
export const noControlLook = (id: string): ActionError => new ActionError(`No control "${id}" on this screen. Use an id from sap_look (the screen may have changed).`);
/** The same, as an action says it: the server's answer shows the screen the agent is on. */
export const noControlAct = (id: string): ActionError =>
  new ActionError(`No control "${id}" on this screen. Use an id from the screen you are on (it may have changed since your last look).`);

/** Marks the control `id` names and gives it with a locator on the mark. */
export async function locate(session: WebGuiSession, id: string): Promise<{ c: MarkedControl; loc: Locator }> {
  const r = await evalLs(session, markControl, id);
  if (typeof r === "string") throw r.startsWith("no control named") ? noControlAct(id) : new ActionError(r);
  return { c: r, loc: marked(session) };
}

/**
 * Runs in the Web GUI frame, on a control: a point of the control a click
 * reaches when its middle is under something else, as offsets from its top
 * left corner; null when the middle is free (the usual case), when no part
 * of it is, or when it is not in the window. SAP draws neighbours over a
 * part of some controls (a checkbox of a classic list is half under the
 * line image next to it): a person clicks the part that shows.
 */
export function freePoint(el: Element): { x: number; y: number } | null {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  const hit = (fx: number, fy: number) => {
    const at = document.elementFromPoint(r.left + fx * r.width, r.top + fy * r.height);
    return !!at && (at === el || el.contains(at));
  };
  if (hit(0.5, 0.5) || !document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) return null;
  for (const [fx, fy] of [[0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.12, 0.5], [0.88, 0.5], [0.12, 0.2], [0.88, 0.8]] as const)
    if (hit(fx, fy)) return { x: Math.max(1, Math.round(fx * r.width)), y: Math.max(1, Math.round(fy * r.height)) };
  return null;
}

/**
 * A locator whose click and double-click go to the part of the control that
 * shows (`freePoint`) when its middle is covered; otherwise they are
 * Playwright's own.
 */
function onFreePoint(loc: Locator): Locator {
  const at = async <T extends { position?: { x: number; y: number } }>(options?: T): Promise<T | undefined> => {
    if (options?.position) return options;
    const position = await loc.evaluate(freePoint, undefined, { timeout: 1000 }).catch(() => null);
    return position ? ({ ...(options ?? {}), position } as T) : options;
  };
  const click = loc.click.bind(loc);
  const dblclick = loc.dblclick.bind(loc);
  loc.click = async (options) => click(await at(options));
  loc.dblclick = async (options) => dblclick(await at(options));
  return loc;
}

/** Did markControl mark the control with exactly this id? It also matches by the last segment. */
export const isExactly = (r: MarkedControl | string, sid: string): r is MarkedControl => typeof r !== "string" && r.sid === sid;

/** Marks the control with exactly this id; undefined when it is not on screen or the page cannot be read. */
async function markExactly(session: WebGuiSession, sid: string): Promise<MarkedControl | undefined> {
  const r = await evalLs(session, markControl, sid).catch(() => "gone");
  return isExactly(r, sid) ? r : undefined;
}

/** Is the control still on screen? It is marked for the next click when it is. */
export async function stillThere(session: WebGuiSession, sid: string): Promise<boolean> {
  return (await markExactly(session, sid)) !== undefined;
}

/** A checkbox's state as the page shows it now; undefined when it is gone. */
export async function checkedNow(session: WebGuiSession, sid: string): Promise<boolean | undefined> {
  return (await markExactly(session, sid))?.checked;
}

/** The marked control: what `locate`, `markExactly` and the page functions marked last. */
export const marked = (session: WebGuiSession): Locator => onFreePoint(session.frame.locator("[data-sap-act]").first());

/**
 * Clicks a control whose click sends a request (a button, a tab) and waits
 * for the round trip. In a tab Chrome draws only once a second the click
 * can be lost: it first takes the focus from the field typed into before,
 * Web GUI posts that field's value and type-ahead and draws again, and the
 * control under the pointer is no longer the one the mouse went down on.
 * When no request with a step left, the click is made once more; the focus
 * is on the control by then. `sure` says that the control always sends a
 * request (a button): its request is then waited for longer. It is repeated
 * only in such a tab, and only while the control is still there: a click
 * that did work has taken its popup or screen away.
 */
export async function clickForRoundtrip(session: WebGuiSession, sid: string, sure = true, markedNow = false): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // `markedNow`: the caller has just marked exactly this control, so the first click needs no new mark.
    if (!(attempt === 0 && markedNow) && !isExactly(await evalLs(session, markControl, sid), sid)) {
      if (attempt === 0) throw noControlAct(sid);
      return;
    }
    // A field's list of earlier entries (S/4: input history) opens a moment after typing and covers the
    // controls below it: the click waited 10 s and failed (live 2026-11-23, ME23N "Select Document"). Closed first.
    await closeList(session);
    try {
      await session.roundtrip(() => marked(session).click(), sure ? SURE_START_MS : 1200);
    } catch (e) {
      // It opened after the look: closed, and the click made once more.
      if (attempt > 0 || !listCovers(e) || !(await closeList(session))) throw e;
      continue;
    }
    if (session.started || !session.slow) return;
    await session.closeSuggestions();
  }
}

/** Did a click fail on an open list (a dropdown's, or a field's earlier entries) over the control? */
const listCovers = (e: unknown): boolean => {
  const log = e instanceof Error ? e.message : String(e);
  return /<[^\n]*(role="listbox"|lsListbox|ct="LIB)[^\n]*> intercepts pointer events/.test(log);
};

/** Closes an open list over the screen with Escape, which the list takes (SAP gets nothing). True when one was open and closed. */
export async function closeList(session: WebGuiSession): Promise<boolean> {
  if ((await session.frame.evaluate(openOverlay).catch(() => "")) !== "list") return false;
  await session.pressKey("Escape").catch(() => {});
  await session.page.waitForTimeout(150);
  return (await session.frame.evaluate(openOverlay).catch(() => "")) !== "list";
}

/** The window a control id is in: 0 for the main window, 1 and up for popups. */
export const windowOf = (sid: string): number => Number(/^wnd\[(\d+)\]/.exec(sid)?.[1] ?? 0);

/** Controls a value can be typed into. A password field is not one: this server never types a password. */
export const FIELD_TYPES = new Set(["GuiTextField", "GuiCTextField", "GuiTextEdit", "GuiSearchHelpPageItem", "GuiSearchHelpHeaderItem"]);
/** "GuiRadioButton" as the answers name it: "radio button". */
export const typeName = (type: string): string => type.replace(/^Gui/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() || "control";

/**
 * Why `set` may not type into this control, or undefined when it may.
 * Typing focuses the control first, and a key typed on a button presses it:
 * so only fields are typed into.
 */
export function setRefusal(c: MarkedControl): string | undefined {
  if (c.type === "GuiPasswordField" || c.inputType === "password") return `${c.sid} is a password field: this server never types a password. Type it yourself.`;
  if (c.type === "GuiOKCodeField") return 'The command field takes {"do":"okcode","value":"..."}, not "set".';
  if (c.type === "GuiGridView") return `${c.sid} is a grid: to type into one of its cells add "row" and "col", e.g. {"do":"set","id":"...","row":0,"col":"<column id>","value":"..."} (the grid's line names the columns whose cells take input).`;
  if (c.type === "GuiTableControl")
    return `${c.sid} is a table control: to type into one of its cells add "row" (as the view numbers it) and "col" (column number, title or field name), e.g. {"do":"set","id":"${c.sid}","row":0,"col":"<column>","value":"..."}, or use the cell's own id from the view (<table>/ctxt<FIELD>[col,<row on screen>]).`;
  if (!FIELD_TYPES.has(c.type)) return `${c.sid} is a ${typeName(c.type)}, not a field: "set" types into fields only. Use "press" for a button, "select" for a tab or a menu entry.`;
  if (c.tag !== "INPUT" && c.tag !== "TEXTAREA" && c.type !== "GuiTextEdit" && !c.drawnAsText) return `${c.sid} cannot be typed into (it is shown as text).`;
  return undefined;
}

/**
 * A field drawn as text until it is clicked (a table cell of S/4HANA 2025):
 * clicks it and gives the input Web GUI puts in its place, marked. Throws
 * when no input comes.
 */
export async function openTextCell(session: WebGuiSession, c: MarkedControl, loc: Locator): Promise<Locator> {
  await session.closeSuggestions();
  await loc.click({ timeout: 5000 });
  for (let i = 0; i < 40; i++) {
    const now = await evalLs(session, markControl, c.sid).catch(() => "gone");
    if (isExactly(now, c.sid) && !now.drawnAsText && (now.tag === "INPUT" || now.tag === "TEXTAREA")) return marked(session);
    await session.page.waitForTimeout(50);
  }
  throw new ActionError(`${c.sid} did not open for typing after a click: the cell stays shown as text. Look at the screen (a message may have to be answered first).`);
}

/**
 * Sets a filter of the value help dialog of S/4HANA 2025, a token field: a
 * value it holds is a token, and the field has an input only while it holds
 * none. The tokens are removed as a person does (a click on the token, then
 * Backspace), then the value is typed into the input that comes back.
 */
export async function setTokenField(session: WebGuiSession, c: MarkedControl, value: string): Promise<void> {
  const field = session.frame.locator(`[id="${c.dom}"]`).first();
  const tokens = field.locator("[ct='TOKEN']");
  await session.closeSuggestions();
  for (let i = 0; i < 20 && (await tokens.count()) > 0; i++) {
    await tokens.last().click({ timeout: 3000 });
    await session.page.keyboard.press("Backspace");
    await session.page.waitForTimeout(150);
  }
  if ((await tokens.count()) > 0) throw new ActionError(`${c.sid} still holds its old value: it could not be removed. Look at the screen.`);
  for (let i = 0; i < 40; i++) {
    const now = await evalLs(session, markControl, c.sid).catch(() => "gone");
    if (isExactly(now, c.sid) && now.tag === "INPUT") {
      await typeInto(session, marked(session), value);
      return;
    }
    await session.page.waitForTimeout(50);
  }
  if (value) throw new ActionError(`${c.sid} did not open for typing. Look at the screen.`);
}

/** Above this many characters a text editor's text is put in at once: typed key by key, 300 characters took 4.8 s (measured on ECC). */
const TYPE_KEYS_MAX = 120;

/**
 * Types a value into a field as a person does: select all, delete, type.
 * A line break is never the Enter key (Enter would send the screen). In a
 * control that has lines (`lines`: a text editor) the text goes in with its
 * line breaks; in a field that has one line each becomes a space. Then the
 * field is read back: the answer is what to add to the note, "" when the
 * field holds what was asked for. A field cuts a value longer than itself
 * without a word, so the note says what it holds. `cell`: the field is a
 * cell of a grid, where the keys that empty a field mean something else.
 */
export async function typeInto(session: WebGuiSession, loc: Locator, value: string, lines = false, cell = false): Promise<string> {
  const single = oneLine(value);
  const text = lines ? value.replace(/\r\n?/g, "\n") : single.text;
  await session.closeSuggestions();
  await loc.focus({ timeout: 10000 });
  if (cell) {
    // In a grid cell Ctrl+A selects every row and column of the grid, and Delete can be the grid's own
    // function (measured on ECC): the cell's text is selected in the page and taken away with Backspace.
    if (await loc.inputValue({ timeout: 1000 }).catch(() => "")) {
      await loc.selectText({ timeout: 3000 });
      await loc.press("Backspace");
    }
  } else {
    // Select all: Ctrl+A, or Cmd+A when the browser runs on macOS.
    await loc.press("ControlOrMeta+A");
    await loc.press("Delete");
  }
  // With line breaks, or long: inserted as text, as a paste is (no key is pressed, so no Enter).
  if (lines && (text.includes("\n") || text.length > TYPE_KEYS_MAX)) await session.page.keyboard.insertText(text);
  else if (text) await loc.pressSequentially(text, { delay: 15 });
  await session.waitIdle(session.quietMs, true, 100, "typing");
  await session.closeSuggestions();
  const notes: string[] = [];
  if (!lines && single.had) notes.push(ONE_LINE_NOTE);
  const held = await loc.inputValue({ timeout: 1000 }).then(
    (v) => v.replace(/\r\n?/g, "\n"),
    () => undefined,
  );
  const differs = held !== undefined && held.replace(/\s+$/, "").toLowerCase() !== text.replace(/\s+$/, "").toLowerCase();
  if (differs) notes.push(heldNote(text, held as string));
  return notes.length ? ` (${notes.join("; ")})` : "";
}

/** What a field holds when it is not what was typed: cut to the field's length, or changed by the field. */
export function heldNote(typed: string, held: string): string {
  const show = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}...` : t).replace(/\n/g, "\\n");
  if (held.length < typed.length && typed.toLowerCase().startsWith(held.toLowerCase()))
    return `the field takes ${held.length} characters: it holds "${show(held)}", not all ${typed.length} typed`;
  return `the field holds "${show(held)}", not the value typed`;
}

/**
 * Clicks a row of an open popup menu (a context menu, the menu of a
 * dropdown button, the ">>" menu of a toolbar) named by its DOM id, as the
 * view lists it (the scripting id for a dropdown button's menu). False when
 * no such row is open.
 */
export async function clickMenuRow(session: WebGuiSession, id: string): Promise<boolean> {
  const f = session.frame;
  const dom = await f.evaluate(menuRowOpen, id).catch(() => "");
  if (!dom) return false;
  try {
    await session.roundtrip(() => f.locator(`tr[id="${dom.replace(/"/g, '\\"')}"]`).first().click({ timeout: MENU_CLICK_MS }), 1200);
  } catch (e) {
    // The row was open when read and could not be clicked: its menu closed again, or something covers it.
    if (e instanceof Error && /Timeout \d+ms exceeded/.test(e.message)) throw new MenuGone(`The menu entry ${id} could not be clicked: its menu closed again or is covered. Nothing was chosen; look at the screen and open the menu again.`);
    throw e;
  }
  return true;
}

/** How long a click on an open menu row may wait for the row: a menu that closed under it never comes back. */
const MENU_CLICK_MS = 2000;

/** A menu row that was open could not be clicked (see clickMenuRow): a caller that can open the menu again retries. */
export class MenuGone extends ActionError {}

/**
 * How long Web GUI holds a click on a line of a classic list before it
 * sends it (measured on ECC: the request leaves 300 ms after the click; it
 * waits to see whether a second click follows), with a margin.
 */
const LIST_CLICK_MS = 600;

/**
 * Clicks a line of a classic list and waits for its round trip. The request
 * leaves late (see LIST_CLICK_MS), after the page has long drawn its frames:
 * the wait for it ends when the request is seen, not when the page is calm.
 */
export async function clickListLine(session: WebGuiSession, click: () => Promise<void>): Promise<void> {
  const before = session.posts;
  await click();
  const t0 = Date.now();
  while (session.posts === before && Date.now() - t0 < LIST_CLICK_MS) await session.page.waitForTimeout(25);
  await session.waitRoundtrip(1200, before);
}

/**
 * Sets the date of a calendar (the value help of a date field): its own date
 * field takes the date as the format says; Continue then copies it. The
 * field is filled, not typed into key by key: it keeps the parts of the old
 * date a key does not replace. Answers the date the calendar holds after.
 */
export async function setCalendar(session: WebGuiSession, loc: Locator, value: string): Promise<string> {
  await loc.fill(value.replace(/[\r\n]+/g, " "), { timeout: 10000 });
  // Leaving the field makes the calendar take the date (Tab stays in the popup).
  await loc.press("Tab");
  await session.waitIdle();
  return clean(await loc.inputValue().catch(() => ""));
}

/**
 * Presses a toolbar button that the toolbar moved behind its ">>" button:
 * opens that menu and chooses the button's entry, as a person does. A
 * button of the screen's toolbar (tbar[N]/btn[K]) is function key K when the
 * entry cannot be found.
 */
export async function pressOverflow(session: WebGuiSession, c: MarkedControl): Promise<string> {
  const opener = session.frame.locator(`[id="${c.overflow}"]`).first();
  // A toolbar without a ">>" button of its own (the id is then the toolbar's): only the function key is left.
  const opens = await opener.evaluate((e) => e.getAttribute("ct") !== "T").catch(() => false);
  if (opens) {
    await opener.click({ timeout: 5000 });
    // The ">>" menu opens a moment after the click: its entry is looked for until it is there.
    for (let i = 0; i < 10; i++) {
      if (await clickMenuRow(session, `${c.dom}-BtnMenu`)) return `pressed ${c.sid} (from the ">>" menu of its toolbar)`;
      if ((await session.frame.evaluate(openOverlay).catch(() => "")) === "menu" && i >= 2) break;
      await session.page.waitForTimeout(100);
    }
    // The menu did not show the entry: close it (Escape goes to an open menu only; else ">>" again), then send the button's function key.
    if ((await session.frame.evaluate(openOverlay).catch(() => "")) === "menu") await session.pressKey("Escape");
    await session.page.waitForTimeout(150);
  }
  const k = /\/tbar\[\d\]\/btn\[(\d+)\]$/.exec(c.sid)?.[1];
  if (k === undefined) throw new ActionError(`${c.sid} is behind the toolbar's ">>" button and its entry could not be found there. Look at the screen.`);
  await session.roundtrip(() => session.pressKey(vkey(Number(k))), SURE_START_MS);
  return `pressed ${c.sid} (behind ">>": sent as its key ${vkey(Number(k))})`;
}

/** Text as the answers show it: white space folded, no space at either end. */
export const clean = (t: string | null | undefined): string => (t ?? "").replace(/\s+/g, " ").replace(/^ | $/g, "");

/** How many entries of a dropdown a refusal lists; the rest are counted (ME21N's order types: 39 entries, 5.3 KB). */
export const ENTRIES_LISTED = 15;

/** Entries as "key:text", the first `ENTRIES_LISTED` of them and a count of the others. */
export function entryList(entries: { key: string; text: string }[], max = ENTRIES_LISTED): string {
  const shown = entries.slice(0, max).map((e) => `${clean(e.key)}:${clean(e.text)}`).join(", ");
  const more = entries.length - max;
  return more > 0 ? `${shown} and ${more} more (a combo with no key lists them all)` : shown;
}

/**
 * The entry of a dropdown an agent means by `wanted`: a key ("91"), a key
 * and its text as the entries are listed ("91:Customer Request") or shown
 * ("91 Customer Request"), a whole text ("Customer Request"), in any case;
 * else whole words of one entry's text ("Customer"), when no other entry has
 * them. "" (or " ", or ":" as the list writes the blank entry) is the blank
 * entry, which clears the field. A text that two entries share is refused as
 * ambiguous with their keys (ME21N: AR and NB are both "Standard PO"); a
 * part of a text that is not whole words is never matched (":" in "DEA:
 * Check Form 222" once chose a wrong entry). Answers the refusal, with the
 * entries, when no entry is meant.
 */
export function entryFor(sid: string, entries: { key: string; text: string }[], wanted: unknown): { key: string; text: string; blank: boolean } | string {
  const w = clean(String(wanted ?? ""));
  const low = (t: string) => clean(t).toLowerCase();
  if (w === "" || w === ":") {
    const blank = entries.find((e) => !clean(e.key) && !clean(e.text)) ?? entries.find((e) => !clean(e.key));
    return blank ? { ...blank, blank: true } : `${sid} has no blank entry, so it cannot be cleared: choose one of its entries (key:text): ${entryList(entries)}`;
  }
  const one = (hits: { key: string; text: string }[]) => (hits.length === 1 ? hits[0] : undefined);
  const byKey = one(entries.filter((e) => clean(e.key) && low(e.key) === w.toLowerCase()));
  const pair = /^([^:\s]*)\s*[: ]\s*(.*)$/.exec(w);
  const byPair = pair ? one(entries.filter((e) => low(e.key) === (pair[1] ?? "").toLowerCase() && (!pair[2] || low(e.text) === (pair[2] ?? "").toLowerCase()))) : undefined;
  const texts = entries.filter((e) => clean(e.text) && low(e.text) === w.toLowerCase());
  const byText = one(texts);
  const hit = byKey ?? byPair ?? byText;
  if (hit) return { ...hit, blank: !clean(hit.key) && !clean(hit.text) };
  const ambiguous = (hits: { key: string; text: string }[], how: string) =>
    `"${w}" is ambiguous in ${sid}: ${hits.map((e) => clean(e.key)).join(", ")} (${how}). Give the key of the entry you mean.`;
  if (texts.length > 1) return ambiguous(texts, `each "${clean(texts[0]?.text)}"`);
  // Whole words of a text, at least three characters with a letter: "Customer" for "Customer Request".
  if (w.length >= 3 && /\p{L}/u.test(w)) {
    const words = new RegExp(`(^|[^\\p{L}\\p{N}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
    const parts = entries.filter((e) => words.test(low(e.text)));
    if (parts.length === 1 && parts[0]) return { ...parts[0], blank: false };
    if (parts.length > 1 && parts.length <= ENTRIES_LISTED) return ambiguous(parts, `each with "${w}" in its text: ${parts.map((e) => clean(e.text)).join(", ")}`);
  }
  return `no entry "${w}" in ${sid}: give an entry's key exactly ("" for the blank entry, which clears the field). Its entries (key:text): ${entryList(entries)}`;
}
