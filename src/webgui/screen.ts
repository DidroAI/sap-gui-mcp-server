/**
 * Reading the Web GUI screen: the full view (one line per control, by
 * window), the HTML viewers inside it, Web GUI's own dialogs, the menu bar,
 * the focused control, and the logon and logoff pages.
 */
import type { Frame } from "playwright-core";
import { resolveId, severalText, shortIds } from "../core/ids.js";
import { ActionError } from "../core/types.js";
import { LOGON_PROGRAM, LOGON_REFUSAL } from "../core/words.js";
import type { FocusFacts } from "./assess.js";
import { evalLs } from "./controls.js";
import { type ClientPopup, extractClientPopups, extractFacts, extractLook, extractMenus, extractViewer, extractViewerIds, type FocusedControl, focusedControl, type LookResult, type MenuEntry, normalizeLsdata, type PageFacts, viewerFocus } from "./page.js";
import { endedText, extractEnded, type WebGuiSession } from "./session.js";

const MAX_GRID_ROWS = 50;
const MAX_TREE_NODES = 300;
/** How long a screen read may serve the step that follows it (assess, then act). */
const FRESH_MS = 1500;
/** The end of a grid's line while it has rows and draws none (just scrolled far: its rows are on their way). */
const NONE_DRAWN = " rows, none drawn yet";

/** How much of an HTML viewer's text the view of a screen holds: a help text or a message's long text fits (measured: 600 to 1500 characters). */
export const VIEWER_TEXT = 2000;
/** How much sap_look with the viewer's id shows. */
export const VIEWER_TEXT_WHOLE = 30000;

/**
 * Reads an HTML viewer and the frames inside it: its controls, numbered
 * across the frames, and its text, as indented lines (at most `maxText`
 * characters; a last line says how much is left out and how to get it).
 */
export async function readViewer(
  fr: Frame,
  maxText = VIEWER_TEXT,
): Promise<{
  lines: string[];
  text: string[];
  frames: { frame: Frame; from: number; to: number }[];
}> {
  const lines: string[] = [];
  const text: string[] = [];
  const frames: { frame: Frame; from: number; to: number }[] = [];
  let n = 0;
  let left = maxText;
  let more = 0;
  const walk = async (x: Frame) => {
    const r = await x.evaluate(extractViewer, { start: n, text: Math.max(0, left) }).catch(() => ({ lines: [] as string[], next: n, text: [] as string[], more: 0 }));
    frames.push({ frame: x, from: n + 1, to: r.next });
    lines.push(...r.lines);
    for (const t of r.text) {
      text.push(`  ${t}`);
      left -= t.length;
    }
    more += r.more;
    n = r.next;
    for (const c of x.childFrames()) await walk(c);
  };
  await walk(fr);
  if (more > 0) text.push(`  ... ${more} more characters of text${maxText < VIEWER_TEXT_WHOLE ? ": sap_look with this viewer's id shows it" : ""}`);
  return { lines, text, frames };
}

/** The frame of each HTML viewer, by its scripting id. */
async function framesOf(f: Frame, ids: { sid: string; dom: string }[]): Promise<{ sid: string; frame: Frame }[]> {
  const res: { sid: string; frame: Frame }[] = [];
  for (const { sid, dom } of ids) {
    const handle = await f.$(`iframe[id="${dom}"]`);
    const fr = await handle?.contentFrame();
    if (fr) res.push({ sid, frame: fr });
  }
  return res;
}

/** Frames of HTML viewers inside the Web GUI frame, with the viewer's scripting id. */
export async function viewerFrames(session: WebGuiSession): Promise<{ sid: string; frame: Frame }[]> {
  return framesOf(session.frame, await evalLs(session, extractViewerIds, undefined));
}

/** Lines for Web GUI's own dialogs, with what the agent can do about them. */
function clientPopupLines(pops: ClientPopup[]): string[] {
  const out: string[] = [];
  for (const p of pops) {
    out.push(`WINDOW browser  "${p.title}"  (a Web GUI message above the SAP screen; the SAP screen does not react until it is closed)`);
    if (p.text) out.push(`text  "${p.text}"`);
    for (const b of p.buttons) out.push(`button  ${b}`);
    if (/timeout|timed out|abgelaufen|expir/i.test(`${p.id} ${p.title} ${p.text}`))
      out.push("NOTE the SAP session has timed out. Ask the user to reload the page and log on again; this server never logs on.");
  }
  return out;
}

/**
 * Runs in the Web GUI frame: what an action checks before it starts, in one
 * round trip. `ended` as extractEnded says it, `logon` as extractFacts says
 * it, and `screen`: the frame holds a Web GUI screen, so the tab is not on
 * the logoff page (see loggedOff). A part that cannot be read says "" or false.
 */
const BEFORE_ACT = `(() => {
  const out = { ended: "", logon: false, screen: false };
  try { out.ended = (${extractEnded})(); } catch {}
  try { out.logon = (${extractFacts})().logon === true; } catch {}
  try { out.screen = !!document.querySelector("#ToolbarOkCode, [lsdata], [data-ls]"); } catch {}
  return out;
})()`;

/**
 * Before an action: the session has not ended (ActionError with what the
 * page says), the screen is not the logon screen (never acted on) and the
 * tab is not on the logoff page.
 */
export async function checkBeforeAct(session: WebGuiSession): Promise<void> {
  const before = await session.frame.evaluate<{ ended: string; logon: boolean; screen: boolean }>(BEFORE_ACT).catch(() => ({ ended: "", logon: false, screen: false }));
  // A session that has ended takes nothing more: said at once, not after a wait.
  if (before.ended) throw new ActionError(endedText(before.ended));
  if (before.logon) throw new ActionError(LOGON_REFUSAL);
  // A Web GUI screen in this frame is not the logoff page; else every frame of the tab is looked at.
  if (!before.screen && (await loggedOff(session))) throw new ActionError(LOGGED_OFF);
}

/**
 * Is the tab on Web GUI's logoff page ("Goodbye. You have been logged off")?
 * Then the logon is closed: no session is left in the tab, and Web GUI's page
 * stays locked, so a wait for SAP would last until its timeout.
 */
export async function loggedOff(session: WebGuiSession): Promise<boolean> {
  const page = session.page;
  if (page.isClosed()) return true;
  // A screen of Web GUI, in any frame (also one embedded in the Fiori launchpad without a command field), is not the logoff page.
  for (const f of page.frames()) if ((await f.locator("#ToolbarOkCode, [lsdata], [data-ls]").count().catch(() => 0)) > 0) return false;
  const title = await page.title().catch(() => "");
  const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  return /log\s*off|logged off|abgemeldet|déconnecté|desconectado/i.test(`${title} ${body}`);
}

export const LOGGED_OFF =
  "The SAP logon of this tab is closed: Web GUI shows its logoff page. Every session of this logon is gone, with its unsaved input, and nothing more can be done here until the user logs on again.";

/**
 * The control that has the keyboard focus, for the guard: Enter and Space
 * press it. Undefined when the page gives none.
 */
export async function focusOf(session: WebGuiSession, known?: FocusedControl | null): Promise<FocusFacts | undefined> {
  const fc = known !== undefined ? known : await evalLs(session, focusedControl, undefined).catch(() => null);
  if (!fc) return undefined;
  if (fc.type !== "frame") return fc.type === "browser" ? { sid: "", type: "browser", pressable: fc.pressable, text: fc.text } : { sid: fc.sid, type: fc.type, text: fc.text };
  // The focus is inside an HTML viewer: ask that frame. What cannot be read counts as a button.
  const viewer = (await viewerFrames(session).catch(() => [])).find((v) => v.sid === fc.sid);
  const inner = viewer ? await viewer.frame.evaluate(viewerFocus).catch(() => ({ pressable: true, text: "", inner: true })) : { pressable: true, text: "", inner: true };
  if (!inner) return { sid: fc.sid, type: "html", pressable: false, text: "" };
  return { sid: fc.sid, type: "html", pressable: inner.pressable, text: inner.inner ? "an element of a frame the server cannot read" : inner.text };
}

/** The line of the view for control `sid`; undefined when the view has none. */
const lineOf = (view: string, sid: string): string | undefined => view.split("\n").find((l) => l.startsWith(`${sid}  `));
/** The id of a control line: everything before the first two spaces. */
const idOf = (line: string): string => line.split("  ", 1)[0] ?? "";
const idsOf = (view: string): string[] =>
  view
    .split("\n")
    .filter((l) => l.startsWith("wnd["))
    .map(idOf);

/** What kind of control a line of the view says `sid` is ("grid", "table", "tree", "list", "field" ...), "" when the view has no such line. */
export function kindIn(view: string, sid: string): string {
  return lineOf(view, sid)?.split("  ")[1] ?? "";
}

/** Is `sid` a dropdown, by its own line (a table's last line may be one of its dropdown cells)? */
export const isDropdown = (view: string, sid: string): boolean => / {2}dropdown {2}/.test(lineOf(view, sid) ?? "");

/** The controls of the screen that scroll, for a `scroll` without an id. */
export function scrollables(view: string): string[] {
  return view
    .split("\n")
    .filter((l) => l.startsWith("wnd[") && / {2}(grid|table|tree|list) {2}/.test(l))
    .map(idOf);
}

/**
 * The full id an id or a handle means on the screen `view` shows. A handle
 * that names several controls is refused with the list of them. An id the
 * view does not hold comes back as it is: the page may still know it (a
 * field's SAP name, a menu entry).
 */
export function resolveIn(view: string, ident: string): string {
  const ids = idsOf(view);
  const r = resolveId(ids, ident);
  if ("id" in r) return r.id;
  if ("several" in r) throw new ActionError(severalText(ident, r.several, shortIds(ids)));
  return ident.trim();
}

/** The full view, read again unless one was read a moment ago. */
export async function freshView(session: WebGuiSession): Promise<string> {
  const v = session.view;
  if (v && Date.now() - v.at < FRESH_MS) return v.text;
  return look(session);
}

/**
 * The full view: a header line, a WINDOW line per window, then one line per
 * control. A read fails while Web GUI replaces the page under it: then it
 * waits for the new screen and reads once more.
 */
export async function look(session: WebGuiSession): Promise<string> {
  return (await lookRead(session)).text;
}

/**
 * As `look`, with what the same read saw besides the view: the session
 * facts, and Web GUI's lock. With `ended`, a page whose session has ended
 * is not read: `ended` then says what it says, and `text` is "".
 */
export async function lookRead(session: WebGuiSession, ended = false): Promise<ScreenRead> {
  let r: ScreenRead;
  try {
    r = await read(session, ended);
  } catch (e) {
    if (!/context was destroyed|navigat|detached|Target closed/i.test((e as Error).message) || session.page.isClosed()) throw e;
    await session.waitIdle().catch(() => {});
    r = await read(session, ended);
  }
  // A grid that was just scrolled far fetches its rows after the scroll: for a moment it has rows and draws none.
  for (let i = 0; i < 20 && r.text.includes(NONE_DRAWN); i++) {
    await session.page.waitForTimeout(250);
    r = await read(session, ended);
  }
  if (!r.ended) {
    session.view = { at: Date.now(), text: r.text };
    session.unsaved.seen(r.text);
  }
  return r;
}

/** Every menu entry of the menu bar, with its id and its shortcut: what the view names as one `menubar` line. */
export async function menuLines(session: WebGuiSession): Promise<string> {
  const menus = await session.frame.evaluate(extractMenus);
  if (!menus.length) return "mbar  menubar  (this screen has no menu bar the server can read)";
  const path = (sid: string) => (sid.match(/menu\[(\d+)\]/g) ?? []).map((x) => Number(x.slice(5, -1)));
  const sorted = [...menus].sort((a, b) => {
    const x = path(a.sid);
    const y = path(b.sid);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    return x.length - y.length;
  });
  const out = ['mbar  menubar  every entry; choose one with {"do":"select","id":"<id>"}'];
  for (const m of sorted) {
    const id = m.sid.replace(/^wnd\[0\]\/mbar\//, "");
    if (!id.startsWith("menu[")) continue;
    out.push(`  ${"  ".repeat(path(m.sid).length - 1)}${m.text}${m.key ? ` (${m.key.replace(/_/g, "+")})` : ""}  {${id}}`);
  }
  return out.join("\n");
}

export interface ScreenRead {
  /** The full view; "" when the session has ended. */
  text: string;
  /** What the page says when its session has ended (only when asked for); "" while it has not. */
  ended: string;
  /** The session facts; undefined when the page could not give them. */
  facts: PageFacts | undefined;
  /** Web GUI's lock after the read: true while a step runs; undefined when this Web GUI does not say. */
  locked: boolean | undefined;
}

interface Snapshot {
  ended: string;
  facts?: PageFacts;
  look?: LookResult;
  popups: ClientPopup[];
  viewers: { sid: string; dom: string }[];
  locked?: boolean;
}

/**
 * Everything a read takes from the Web GUI frame, in one round trip: the
 * end of the session (when asked), the facts (the logon screen is not read
 * further), the controls (on `data-ls` brought up to date), Web GUI's own
 * dialogs, the HTML viewers, and the lock. A part that may fail on its own
 * fails as before: the controls fail the read, the rest reads as nothing.
 */
const snapshotScript = (ended: boolean): string => `(() => {
  const out = { ended: "", popups: [], viewers: [] };
  ${ended ? `try { out.ended = (${extractEnded})(); } catch {}
  if (out.ended) return out;` : ""}
  try { out.facts = (${extractFacts})(); } catch {}
  if (out.facts && out.facts.logon) return out;
  try { (${normalizeLsdata})(); } catch {}
  out.look = (${extractLook})(${JSON.stringify({ grid: MAX_GRID_ROWS, tree: MAX_TREE_NODES })});
  try { out.popups = (${extractClientPopups})(); } catch {}
  try { out.viewers = (${extractViewerIds})(); } catch {}
  try {
    const ls = window.oLS;
    if (ls && typeof ls.bLocked === "function") out.locked = ls.bLocked() === true;
  } catch {}
  return out;
})()`;
const SNAPSHOT = snapshotScript(false);
const SNAPSHOT_UNLESS_ENDED = snapshotScript(true);

async function read(session: WebGuiSession, ended: boolean): Promise<ScreenRead> {
  const f = session.frame;
  const s = await f.evaluate<Snapshot>(ended ? SNAPSHOT_UNLESS_ENDED : SNAPSHOT);
  if (s.ended) return { text: "", ended: s.ended, facts: undefined, locked: undefined };
  const facts = s.facts;
  if (facts?.logon) {
    // The logon screen is not read out: nothing on it is for the agent.
    const text = [`TRANSACTION   PROGRAM ${facts.program || LOGON_PROGRAM}  SCREEN `, `WINDOW wnd[0]  "${facts.title.replace(/"/g, "'")}"`, `NOTE this is the SAP logon screen. ${LOGON_REFUSAL}.`].join("\n");
    return { text, ended: "", facts, locked: undefined };
  }
  const r = s.look as LookResult;
  const out = [`TRANSACTION ${r.transaction}  PROGRAM ${r.program}  SCREEN ${r.screen}${r.system ? `  SYSTEM ${r.system}` : ""}`];
  // Web GUI's own dialogs first: while one is open, nothing below reacts.
  out.push(...clientPopupLines(s.popups));
  // The viewers' frames are found only for a screen that has one.
  const hasViewer = r.windows.some((w) => w.lines.some((l) => l.endsWith("  html-viewer")));
  const viewers = hasViewer ? await framesOf(f, s.viewers).catch(() => []) : [];
  for (const w of r.windows) {
    out.push(`WINDOW ${w.id}  "${w.title}"`);
    for (const l of w.lines) {
      out.push(l);
      if (l.endsWith("  html-viewer")) {
        const v = viewers.find((x) => l.startsWith(`${x.sid}  `));
        if (v) {
          // The text the viewer shows, then its controls.
          const r = await readViewer(v.frame);
          out.push(...r.text);
          for (const x of r.lines) out.push(`${v.sid}/${x}`);
        }
      }
    }
  }
  return { text: out.join("\n"), ended: "", facts, locked: s.locked };
}

/**
 * Runs in the Web GUI frame on `data-ls` brought up to date: the menu
 * entries for the guard, and the focused control when asked (null when it
 * cannot be read), in one round trip.
 */
const guardScript = (focus: boolean): string => `(() => {
  try { (${normalizeLsdata})(); } catch {}
  const menus = (${extractMenus})();
  let focus = null;
  ${focus ? `try { focus = (${focusedControl})(); } catch {}` : ""}
  return { menus, focus };
})()`;
const GUARD = guardScript(false);
const GUARD_FOCUS = guardScript(true);

/** The menu entries, and the focused control when `focus`: what the guard reads besides the view. */
export async function guardFacts(session: WebGuiSession, focus: boolean): Promise<{ menus: MenuEntry[]; focus: FocusFacts | undefined }> {
  const r = await session.frame.evaluate<{ menus: MenuEntry[]; focus: FocusedControl | null }>(focus ? GUARD_FOCUS : GUARD);
  return { menus: r.menus, focus: focus ? await focusOf(session, r.focus) : undefined };
}
