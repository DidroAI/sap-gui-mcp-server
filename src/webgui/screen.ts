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
import { extractClientPopups, extractFacts, extractLook, extractMenus, extractViewer, extractViewerIds, focusedControl, viewerFocus } from "./page.js";
import type { WebGuiSession } from "./session.js";

const MAX_GRID_ROWS = 50;
const MAX_TREE_NODES = 300;
/** How long a screen read may serve the step that follows it (assess, then act). */
const FRESH_MS = 1500;
/** The end of a grid's line while it has rows and draws none (just scrolled far: its rows are on their way). */
const NONE_DRAWN = " rows, none drawn yet";

/** Reads an HTML viewer and the frames inside it, numbering controls across them. */
export async function readViewer(fr: Frame): Promise<{
  lines: string[];
  frames: { frame: Frame; from: number; to: number }[];
}> {
  const lines: string[] = [];
  const frames: { frame: Frame; from: number; to: number }[] = [];
  let n = 0;
  const walk = async (x: Frame) => {
    const r = await x.evaluate(extractViewer, n).catch(() => ({ lines: [] as string[], next: n }));
    frames.push({ frame: x, from: n + 1, to: r.next });
    lines.push(...r.lines);
    n = r.next;
    for (const c of x.childFrames()) await walk(c);
  };
  await walk(fr);
  return { lines, frames };
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
async function clientPopupLines(f: Frame): Promise<string[]> {
  const pops = await f.evaluate(extractClientPopups).catch(() => []);
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

/** Is the page SAP's logon page, or the logon screen inside Web GUI? */
async function onLogon(session: WebGuiSession): Promise<boolean> {
  return (await session.frame.evaluate(extractFacts).catch(() => undefined))?.logon === true;
}

/** This server never acts on a logon screen: not a key, not a click. */
export async function refuseLogon(session: WebGuiSession): Promise<void> {
  if (await onLogon(session)) throw new ActionError(LOGON_REFUSAL);
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
export async function focusOf(session: WebGuiSession): Promise<FocusFacts | undefined> {
  const fc = await evalLs(session, focusedControl, undefined).catch(() => null);
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
  let text: string;
  try {
    text = await read(session);
  } catch (e) {
    if (!/context was destroyed|navigat|detached|Target closed/i.test((e as Error).message) || session.page.isClosed()) throw e;
    await session.waitIdle().catch(() => {});
    text = await read(session);
  }
  // A grid that was just scrolled far fetches its rows after the scroll: for a moment it has rows and draws none.
  for (let i = 0; i < 20 && text.includes(NONE_DRAWN); i++) {
    await session.page.waitForTimeout(250);
    text = await read(session);
  }
  session.view = { at: Date.now(), text };
  return text;
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

async function read(session: WebGuiSession): Promise<string> {
  if (await onLogon(session)) {
    const facts = await session.frame.evaluate(extractFacts);
    // The logon screen is not read out: nothing on it is for the agent.
    return [`TRANSACTION   PROGRAM ${facts.program || LOGON_PROGRAM}  SCREEN `, `WINDOW wnd[0]  "${facts.title.replace(/"/g, "'")}"`, `NOTE this is the SAP logon screen. ${LOGON_REFUSAL}.`].join("\n");
  }
  const f = session.frame;
  const r = await evalLs(session, extractLook, { grid: MAX_GRID_ROWS, tree: MAX_TREE_NODES });
  const out = [`TRANSACTION ${r.transaction}  PROGRAM ${r.program}  SCREEN ${r.screen}${r.system ? `  SYSTEM ${r.system}` : ""}`];
  // Web GUI's own dialogs first: while one is open, nothing below reacts.
  out.push(...(await clientPopupLines(f)));
  const viewers = await viewerFrames(session).catch(() => []);
  for (const w of r.windows) {
    out.push(`WINDOW ${w.id}  "${w.title}"`);
    for (const l of w.lines) {
      out.push(l);
      if (l.endsWith("  html-viewer")) {
        const v = viewers.find((x) => l.startsWith(`${x.sid}  `));
        if (v) for (const x of (await readViewer(v.frame)).lines) out.push(`${v.sid}/${x}`);
      }
    }
  }
  return out.join("\n");
}
