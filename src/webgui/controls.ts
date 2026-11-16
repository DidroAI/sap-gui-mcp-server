/**
 * Finding a control of the Web GUI page and acting on it: the page functions
 * run on `data-ls` (see normalizeLsdata), the control an action means is
 * marked (`data-sap-act`) and Playwright clicks or types into the mark.
 */
import type { Locator } from "playwright-core";
import { ActionError } from "../core/types.js";
import { vkey } from "./keys.js";
import { type MarkedControl, markControl, menuRowOpen, normalizeLsdata } from "./page.js";
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
  return { c: r, loc: session.frame.locator("[data-sap-act]").first() };
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
export const marked = (session: WebGuiSession): Locator => session.frame.locator("[data-sap-act]").first();

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
    await session.roundtrip(() => marked(session).click(), sure ? SURE_START_MS : 1200);
    if (session.started || !session.slow) return;
    await session.closeSuggestions();
  }
}

/** The window a control id is in: 0 for the main window, 1 and up for popups. */
export const windowOf = (sid: string): number => Number(/^wnd\[(\d+)\]/.exec(sid)?.[1] ?? 0);

/** Controls a value can be typed into. A password field is not one: this server never types a password. */
export const FIELD_TYPES = new Set(["GuiTextField", "GuiCTextField", "GuiTextEdit", "GuiSearchHelpPageItem"]);
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
  if (!FIELD_TYPES.has(c.type)) return `${c.sid} is a ${typeName(c.type)}, not a field: "set" types into fields only. Use "press" for a button, "select" for a tab or a menu entry.`;
  if (c.tag !== "INPUT" && c.tag !== "TEXTAREA" && c.type !== "GuiTextEdit") return `${c.sid} cannot be typed into (it is shown as text).`;
  return undefined;
}

/** Types a value into a field as a person does: select all, delete, type; no line break (it would be Enter). */
export async function typeInto(session: WebGuiSession, loc: Locator, value: string): Promise<void> {
  value = value.replace(/[\r\n]+/g, " ");
  await session.closeSuggestions();
  await loc.focus({ timeout: 10000 });
  // Select all: Ctrl+A, or Cmd+A when the browser runs on macOS.
  await loc.press("ControlOrMeta+A");
  await loc.press("Delete");
  if (value) await loc.pressSequentially(value, { delay: 15 });
  await session.waitIdle(session.quietMs, true, 100, "typing");
  await session.closeSuggestions();
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
  await session.roundtrip(() => f.locator(`tr[id="${dom.replace(/"/g, '\\"')}"]`).first().click({ timeout: 10000 }), 1200);
  return true;
}

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
  await opener.click({ timeout: 5000 });
  // Not tuned: the time the ">>" menu takes to open.
  await session.page.waitForTimeout(300);
  if (await clickMenuRow(session, `${c.dom}-BtnMenu`)) return `pressed ${c.sid} (from the ">>" menu of its toolbar)`;
  const k = /\/tbar\[\d\]\/btn\[(\d+)\]$/.exec(c.sid)?.[1];
  // The menu did not show the entry: close it (">>" again; Escape would be Cancel if it is not open), then send the button's function key.
  await opener.click({ timeout: 5000 }).catch(() => {});
  await session.page.waitForTimeout(150);
  if (k === undefined) throw new ActionError(`${c.sid} is behind the toolbar's ">>" button and its entry could not be found there. Look at the screen.`);
  await session.roundtrip(() => session.pressKey(vkey(Number(k))), SURE_START_MS);
  return `pressed ${c.sid} (behind ">>": sent as its key ${vkey(Number(k))})`;
}

/** Text as the answers show it: white space folded, no space at either end. */
export const clean = (t: string | null | undefined): string => (t ?? "").replace(/\s+/g, " ").replace(/^ | $/g, "");
