/**
 * The SAP screen reader for Web GUI, in the format of the SAP GUI for Windows
 * reader: one control per line, addressed by its SAP GUI scripting id, with
 * state; and the same JSON actions, run with Playwright.
 *
 *   look(session)          the full view (core/compact.ts makes the compact one)
 *   act(session, action)   one action
 *
 * Actions, on an id from the view (full id, short id, or a field's SAP name):
 *   {"do":"set","id":"ctxtVBAK-AUART","value":"OR"}
 *   {"do":"press","id":"wnd[0]/tbar[1]/btn[8]"}
 *   {"do":"key","key":0}                 sendVKey: 0 Enter, 2 F2, 3 Back, 4 F4, 8 F8, 12 Cancel...
 *   {"do":"f4","id":"ctxtVBAK-AUART"}    value help on a field
 *   {"do":"dblclick","id":"..."}         a list line or label (with node/row: tree/grid)
 *   {"do":"check","id":"chkVBAK-AUTLF","value":true}
 *   {"do":"select","id":"tabpT\\06"}     tab, radio button, menu entry (wnd[0]/mbar/menu[1]/menu[0])
 *   {"do":"combo","id":"cmbVBAK-LIFSK","key":"01"}
 *   {"do":"okcode","value":"/nVA03"}
 *   {"do":"tree","id":"shell","node":"7","how":"double|select|expand"}
 *   {"do":"grid","id":"shell","row":0,"col":"VBELN","how":"double|select"}
 *   {"do":"toolbar","id":"shell","button":"&FIND"}
 */
import type { Frame, Locator } from "playwright-core";
import { compact, controlBlock } from "../core/compact.js";
import { resolveId, severalText, shortIds } from "../core/ids.js";
import { readRows } from "../core/rows.js";
import { ActionError, type Action, type Assessment, type LookOptions } from "../core/types.js";
import { LOGON_PROGRAM, LOGON_REFUSAL } from "../core/words.js";
import { assessAction, type FocusFacts } from "./assess.js";
import type { MarkedControl, Scrolled } from "./page.js";
import { comboEntries, extractFacts, extractLook, extractMenus, extractViewer, focusedControl, markControl, markRow, markSelector, normalizeLsdata, scrollControl, viewerFocus } from "./page.js";
import { IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, type WebGuiSession } from "./session.js";

const MAX_GRID_ROWS = 50;
const MAX_TREE_NODES = 300;
/** How long a screen read may serve the step that follows it (assess, then act). */
const FRESH_MS = 1500;
/**
 * How long to wait for the request of a step that always sends one (a
 * function key, a button, a command). The wait ends when the request
 * starts, so this costs nothing when the browser is quick; when it is slow
 * (a busy machine), 1.5 s was not enough once in a soak run, and the answer
 * showed the screen from before the step.
 */
const SURE_START_MS = 5000;

/** Reads an HTML viewer and the frames inside it, numbering controls across them. */
async function readViewer(fr: Frame): Promise<{
  lines: string[];
  frames: { frame: Frame; from: number; to: number }[];
}> {
  const lines: string[] = [];
  const frames: { frame: Frame; from: number; to: number }[] = [];
  let n = 0;
  const walk = async (x: Frame) => {
    const r = await x
      .evaluate(extractViewer, n)
      .catch(() => ({ lines: [] as string[], next: n }));
    frames.push({ frame: x, from: n + 1, to: r.next });
    lines.push(...r.lines);
    n = r.next;
    for (const c of x.childFrames()) await walk(c);
  };
  await walk(fr);
  return { lines, frames };
}

/** Frames of HTML viewers inside the Web GUI frame, with the viewer's scripting id. */
async function viewerFrames(
  f: Frame,
): Promise<{ sid: string; frame: Frame }[]> {
  const ids: { sid: string; dom: string }[] = await f.evaluate(() =>
    Array.from(
      document.querySelectorAll("iframe[data-ls*=\"Type:'GuiHtmlViewer'\"]"),
    )
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => ({
        sid:
          /SID:'((?:[^'\\]|\\.)*)'/.exec(
            e.getAttribute("data-ls") ?? "",
          )?.[1] ?? "",
        dom: e.id,
      })),
  );
  const res: { sid: string; frame: Frame }[] = [];
  for (const { sid, dom } of ids) {
    const handle = await f.$(`iframe[id="${dom}"]`);
    const fr = await handle?.contentFrame();
    if (fr) res.push({ sid, frame: fr });
  }
  return res;
}

/**
 * Web GUI of ECC writes `lsdata` as a JavaScript object literal; Web GUI of
 * S/4HANA 2025 writes strict JSON. normalizeLsdata copies every `lsdata` into
 * `data-ls` in the ECC form, so the reader reads one form. This returns the
 * frame with `data-ls` up to date.
 */
async function lsFrame(session: WebGuiSession): Promise<Frame> {
  await session.frame.evaluate(normalizeLsdata).catch(() => 0);
  return session.frame;
}

/** The full view: a header line, a WINDOW line per window, then one line per control. */
/**
 * Web GUI's own dialogs (session timeout, connection lost) are popup windows
 * of the page, not SAP windows: they carry no scripting id, so the SAP read
 * does not list them, yet they block the screen. Listed as WINDOW browser.
 * Runs in the page: no String.prototype.trim (Web GUI patches it).
 */
function extractClientPopups(): { id: string; title: string; text: string; buttons: string[] }[] {
  const out: { id: string; title: string; text: string; buttons: string[] }[] = [];
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").replace(/^ | $/g, "");
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("div[ct='PW']"))) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || el.offsetWidth === 0) continue;
    // An SAP popup window holds controls with scripting ids; those are read by the SAP read.
    if (el.querySelector("[lsdata*='wnd[']")) continue;
    const title = clean(el.querySelector(".urPWTitleText")?.textContent);
    const body = el.querySelector<HTMLElement>(".urPWContent");
    const buttons = Array.from(el.querySelectorAll<HTMLElement>("[ct='B'],button,[role='button']"))
      .map((b) => clean(b.textContent))
      .filter((t) => t.length > 0);
    const text = clean(body?.innerText);
    out.push({ id: el.id, title, text, buttons });
  }
  return out;
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
async function refuseLogon(session: WebGuiSession): Promise<void> {
  if (await onLogon(session)) throw new ActionError(LOGON_REFUSAL);
}

/**
 * The control that has the keyboard focus, for the guard: Enter and Space
 * press it. Undefined when the page gives none.
 */
export async function focusOf(session: WebGuiSession): Promise<FocusFacts | undefined> {
  const f = await lsFrame(session);
  const fc = await f.evaluate(focusedControl).catch(() => null);
  if (!fc) return undefined;
  if (fc.type !== "frame") return fc.type === "browser" ? { sid: "", type: "browser", pressable: fc.pressable, text: fc.text } : { sid: fc.sid, type: fc.type, text: fc.text };
  // The focus is inside an HTML viewer: ask that frame. What cannot be read counts as a button.
  const viewer = (await viewerFrames(f).catch(() => [])).find((v) => v.sid === fc.sid);
  const inner = viewer ? await viewer.frame.evaluate(viewerFocus).catch(() => ({ pressable: true, text: "", inner: true })) : { pressable: true, text: "", inner: true };
  if (!inner) return { sid: fc.sid, type: "html", pressable: false, text: "" };
  return { sid: fc.sid, type: "html", pressable: inner.pressable, text: inner.inner ? "an element of a frame the server cannot read" : inner.text };
}

/**
 * Classifies an action from the screen as it is now: the full view, the menu
 * entries, the logon language and the focused control. On a logon screen it
 * refuses (ActionError). A screen that cannot be read cannot be ruled safe.
 */
export async function assess(session: WebGuiSession, action: Action): Promise<Assessment> {
  await refuseLogon(session);
  try {
    const view = await look(session);
    const menus = await session.frame.evaluate(extractMenus);
    const facts = await session.frame.evaluate(extractFacts);
    const focus = action.do === "key" || action.do === "okcode" ? await focusOf(session) : undefined;
    // The control the action will act on, resolved as `act` resolves it: the guard judges that one.
    const resolved = action.id ? { ...action, id: resolveIn(view, String(action.id)) } : action;
    const verdict = assessAction(resolved, view, menus, { language: facts.language, focus });
    // A control the view does not list may still exist in the page (markControl looks wider).
    // Only when the page has none either is it "no such control" rather than "may write".
    if (verdict.risk === "commit" && verdict.reason.includes("not on the screen the server read") && action.id) {
      const found = await session.frame.evaluate(markControl, String(action.id)).catch(() => "unreadable");
      if (typeof found === "string") throw new ActionError(`No control "${action.id}" on this screen. Use an id from sap_look (the screen may have changed).`);
    }
    return verdict;
  } catch (e) {
    if (e instanceof ActionError) throw e;
    return { risk: "commit", reason: `the screen could not be read (${(e as Error).message.split("\n")[0]})` };
  }
}

/** The id of a control line: everything before the first two spaces. */
const idOf = (line: string): string => line.split("  ", 1)[0] ?? "";
const idsOf = (view: string): string[] =>
  view
    .split("\n")
    .filter((l) => l.startsWith("wnd["))
    .map(idOf);

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
async function freshView(session: WebGuiSession): Promise<string> {
  const v = session.view;
  if (v && Date.now() - v.at < FRESH_MS) return v.text;
  return look(session);
}

/** A read fails while Web GUI replaces the page under it: wait for the new screen and read once more. */
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

const NONE_DRAWN = " rows, none drawn yet";

/** Every menu entry of the menu bar, with its id and its shortcut: what the view names as one `menubar` line. */
async function menuLines(session: WebGuiSession): Promise<string> {
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

/** The screen, or one control of it, as the tools show it. */
export async function view(session: WebGuiSession, options: LookOptions): Promise<string> {
  if (!options.id) {
    const full = await look(session);
    return options.compact ? compact(full) : full;
  }
  if (/^(wnd\[0\]\/)?mbar$/.test(options.id.trim())) return menuLines(session);
  const full = await look(session);
  const sid = resolveIn(full, options.id);
  const missing = () => new ActionError(`No control "${options.id}" on this screen. Use an id from sap_look (the screen may have changed).`);
  if (options.rows) {
    if (!controlBlock(full, sid)) throw missing();
    return readRows(
      {
        scrollTo: async (row) => {
          await scrollTo(session, sid, row);
        },
        block: async () => {
          const screen = await look(session);
          const block = controlBlock(screen, sid);
          return block === undefined ? undefined : { block, screen };
        },
      },
      options.id,
      options.rows.from,
      options.rows.to,
      options.cols,
    );
  }
  let block = controlBlock(full, sid);
  if (!block) throw missing();
  // The control's own line says what it is (a table's last line may be one of its dropdown cells).
  if (/ {2}dropdown {2}/.test(block.split("\n").find((l) => l.startsWith(`${sid}  `)) ?? "")) {
    // Every entry, also those the view cuts and those Web GUI loads only when the list opens.
    const entries = await entriesOf(session, sid);
    block = `${block.replace(/ {2}(\d+ )?options: .*$/, "")}  ${entries.length} options: ${entries.map((e) => `${e.key}:${e.text}`).join(", ")}`;
  }
  return options.compact ? compact(block, { dropdowns: false, maxChars: 0, screen: full }) : block;
}

async function read(session: WebGuiSession): Promise<string> {
  if (await onLogon(session)) {
    const facts = await session.frame.evaluate(extractFacts);
    // The logon screen is not read out: nothing on it is for the agent.
    return [`TRANSACTION   PROGRAM ${facts.program || LOGON_PROGRAM}  SCREEN `, `WINDOW wnd[0]  "${facts.title.replace(/"/g, "'")}"`, `NOTE this is the SAP logon screen. ${LOGON_REFUSAL}.`].join("\n");
  }
  const f = await lsFrame(session);
  const r = await f.evaluate(extractLook, {
    grid: MAX_GRID_ROWS,
    tree: MAX_TREE_NODES,
  });
  const out = [
    `TRANSACTION ${r.transaction}  PROGRAM ${r.program}  SCREEN ${r.screen}${r.system ? `  SYSTEM ${r.system}` : ""}`,
  ];
  // Web GUI's own dialogs first: while one is open, nothing below reacts.
  out.push(...(await clientPopupLines(f)));
  const viewers = await viewerFrames(f).catch(() => []);
  for (const w of r.windows) {
    out.push(`WINDOW ${w.id}  "${w.title}"`);
    for (const l of w.lines) {
      out.push(l);
      if (l.endsWith("  html-viewer")) {
        const v = viewers.find((x) => l.startsWith(`${x.sid}  `));
        const inner = v ? (await readViewer(v.frame)).lines : [];
        for (const x of inner) out.push(`${v!.sid}/${x}`);
      }
    }
  }
  return out.join("\n");
}

/** SAP virtual keys (sendVKey) as keyboard keys in Web GUI. */
export function vkey(k: unknown): string {
  // "Back" is SAP's Back (F3), as on the other surfaces.
  if (typeof k === "string" && /^back$/i.test(k)) return "F3";
  if (typeof k === "string" && !/^\d+$/.test(k)) return k;
  const n = Number(k);
  const f = (i: number) => `F${i}`;
  if (n === 0) return "Enter";
  if (n === 11) return "Control+s";
  if (n === 12) return "Escape";
  if (n >= 1 && n <= 10) return f(n);
  if (n >= 13 && n <= 24) return `Shift+${f(n - 12)}`;
  if (n >= 25 && n <= 36) return `Control+${f(n - 24)}`;
  if (n >= 37 && n <= 48) return `Control+Shift+${f(n - 36)}`;
  if (n === 70) return "Control+e";
  if (n === 71) return "Control+f";
  if (n === 80) return "Control+PageUp";
  if (n === 81) return "PageUp";
  if (n === 82) return "PageDown";
  if (n === 83) return "Control+PageDown";
  throw new ActionError(`unknown virtual key ${k}`);
}

async function locate(session: WebGuiSession, id: string) {
  const f = await lsFrame(session);
  const r = await f.evaluate(markControl, id);
  if (typeof r === "string") throw new ActionError(r.startsWith("no control named") ? `No control "${id}" on this screen. Use an id from the screen you are on (it may have changed since your last look).` : r);
  return { f, c: r, loc: f.locator("[data-sap-act]").first() };
}

async function typeInto(
  session: WebGuiSession,
  loc: Locator,
  value: string,
): Promise<void> {
  // A line break would be Enter: it is never typed.
  value = value.replace(/[\r\n]+/g, " ");
  await session.closeSuggestions();
  await loc.focus({ timeout: 10000 });
  // Select all: Ctrl+A, or Cmd+A when the browser runs on macOS.
  await loc.press("ControlOrMeta+A");
  await loc.press("Delete");
  if (value) await loc.pressSequentially(value, { delay: 15 });
  await session.waitIdle();
  await session.closeSuggestions();
}

/**
 * Clicks a control whose click sends a request (a button, a tab) and waits
 * for the round trip. In a tab Chrome draws only once a second the click
 * can be lost: it first takes the focus from the field typed into before,
 * Web GUI posts that field's value and type-ahead and draws again, and the
 * control under the pointer is no longer the one the mouse went down on.
 * When no request with a step left, the click is made once more; the focus
 * is on the control by then. `sure` says that the control always sends a
 * request (a button): its request is then waited for longer. It is repeated only in such a tab, and only
 * while the control is still there: a click that did work has taken its
 * popup or screen away.
 */
async function clickForRoundtrip(session: WebGuiSession, sid: string, sure = true): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = await lsFrame(session);
    const r = await f.evaluate(markControl, sid);
    if (typeof r === "string" || r.sid !== sid) {
      if (attempt === 0) throw new ActionError(`No control "${sid}" on this screen. Use an id from the screen you are on (it may have changed since your last look).`);
      return;
    }
    await session.roundtrip(() => f.locator("[data-sap-act]").first().click(), sure ? SURE_START_MS : 1200);
    if (session.started || !session.slow) return;
    await session.closeSuggestions();
  }
}

/** Controls a value can be typed into. A password field is not one: this server never types a password. */
const FIELD_TYPES = new Set(["GuiTextField", "GuiCTextField", "GuiTextEdit"]);
const typeName = (type: string) => type.replace(/^Gui/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() || "control";

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

/** One action. Returns a one-line note of what was done; throws ActionError when it cannot. */
export async function act(session: WebGuiSession, a: Action): Promise<string> {
  await refuseLogon(session);
  await session.wake();
  // A long step (a report started with F8) can be given more time: "timeout" in seconds.
  const t = Number(a.timeout);
  session.idleTimeoutMs = Number.isFinite(t) && t > 0 ? Math.min(Math.round(t * 1000), MAX_IDLE_TIMEOUT_MS) : IDLE_TIMEOUT_MS;
  session.unsettled = false;
  // A type-ahead list left open by the field typed into before covers what is below it.
  if (a.do !== "set") await session.closeSuggestions().catch(() => {});
  try {
    // The id as the screen holds it now: a handle becomes its full id, one that names several controls is refused.
    const named = a.id !== undefined && String(a.id).trim() && !isMenuPath(String(a.id));
    const note = await run(session, named ? { ...a, id: resolveIn(await freshView(session), String(a.id)) } : a);
    return session.unsettled ? `${note}\n(Web GUI still showed its loading sign when the server stopped waiting: the step may not be over. If the screen below is not what the step should lead to, look again in a moment.)` : note;
  } catch (e) {
    throw tidy(e);
  } finally {
    session.view = undefined;
    session.idleTimeoutMs = IDLE_TIMEOUT_MS;
  }
}

const isMenuPath = (id: string) => /\/mbar\/menu\[/.test(id) || /^menu\[/.test(id);

/** Moves a grid, table control, tree or list to a row and waits for the rows. */
async function scrollTo(session: WebGuiSession, sid: string, to: number | string): Promise<Scrolled | string> {
  const f = await lsFrame(session);
  let r: Scrolled | string = "";
  await session.roundtrip(async () => {
    r = await f.evaluate(scrollControl, { sid, to });
    if (typeof r !== "string" && !r.moved) {
      // No access to the scrollbar object in this Web GUI: its page areas still take a click.
      if (to !== "next" && to !== "prev") throw new ActionError(`This Web GUI does not let the server move ${sid} to a row: scroll with "to":"next" or "prev".`);
      await f.locator(`[id="${r.bar}-${to === "next" ? "bar" : "spc"}"]`).click({ position: { x: 5, y: 5 }, timeout: 5000 });
    }
  }, 600);
  const done = r as Scrolled | string;
  if (typeof done === "string") {
    if (done.startsWith("all rows")) return done;
    throw new ActionError(done);
  }
  if (typeof to === "string" && /^(right|left|rightmost|leftmost)$/.test(to)) return done;
  // Where it is now: the end of the list stops a scroll short of the row asked for.
  const now = await (await lsFrame(session)).evaluate(scrollControl, { sid, to: "here" }).catch(() => "");
  return typeof now === "string" ? done : { ...done, first: now.from };
}

/** The controls of the screen that scroll, for a `scroll` without an id. */
function scrollables(view: string): string[] {
  return view
    .split("\n")
    .filter((l) => l.startsWith("wnd[") && / {2}(grid|table|tree|list) {2}/.test(l))
    .map(idOf);
}

/** Every entry of a dropdown: from the page when it holds them, else by opening the list and closing it again. */
async function entriesOf(session: WebGuiSession, sid: string): Promise<{ key: string; text: string }[]> {
  const f = await lsFrame(session);
  const held = await f.evaluate(comboEntries, sid);
  if (typeof held === "string") throw new ActionError(held);
  if (held.length) return held;
  const { loc } = await locate(session, sid);
  await loc.click();
  await session.page.waitForTimeout(400);
  const items = f.locator("[ct='LIB_I'],[role='option']").filter({ visible: true });
  const n = await items.count();
  const out: { key: string; text: string }[] = [];
  for (let i = 0; i < n; i++)
    out.push({
      key: (await items.nth(i).getAttribute("data-itemkey")) ?? "",
      text: ((await items.nth(i).innerText()) || "").replace(/\s+/g, " ").replace(/^ | $/g, ""),
    });
  // Escape closes the open list; with no list open it would be Cancel (F12), so it is sent only to a list.
  if (n > 0) await session.page.keyboard.press("Escape");
  await session.page.waitForTimeout(150);
  return out;
}

/** Playwright's errors carry a long call log: keep the first line, and say what blocks when a popup covers the control. */
function tidy(e: unknown): Error {
  if (e instanceof ActionError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const first = message.split("\n")[0] ?? message;
  if (message.includes("intercepts pointer events"))
    return new ActionError(`${first} Another window covers this control (a popup is open?): look at the screen and answer the popup first.`);
  return new ActionError(first);
}

/** What kind of control a line of the view says `sid` is ("grid", "table", "tree", "list", "field" ...), "" when the view has no such line. */
function kindIn(view: string, sid: string): string {
  const line = view.split("\n").find((l) => l.startsWith(`${sid}  `));
  return line?.split("  ")[1] ?? "";
}

/**
 * Selects (or deselects) a row of a grid, table control or value-help list
 * by its row selector, the button at the left of the row, as a person
 * clicks it; and reads the state back. A grid row that is not drawn is
 * scrolled to first; a table control counts rows on screen.
 */
async function selectRow(session: WebGuiSession, sid: string, row: number, on: boolean): Promise<string> {
  const target = { sid, row };
  let f = await lsFrame(session);
  let r = await f.evaluate(markSelector, target);
  let scrolled = "";
  if (typeof r === "string" && / is not on screen$/.test(r) && kindIn(await freshView(session), sid) !== "table") {
    const sc = await scrollTo(session, sid, row);
    if (typeof sc !== "string") scrolled = ` (scrolled to it: rows ${sc.first} to ${Math.min(sc.first + sc.visible, sc.total) - 1} of ${sc.total} are shown)`;
    // The rows come a moment after the scroll.
    for (let i = 0; i < 10; i++) {
      f = await lsFrame(session);
      r = await f.evaluate(markSelector, target);
      if (typeof r !== "string" || !/ is not on screen$/.test(r)) break;
      await session.page.waitForTimeout(200);
    }
  }
  if (typeof r === "string")
    throw new ActionError(/ is not on screen$/.test(r) ? `${r}: a table control counts its rows on screen (row 0 is the first row shown); scroll it to bring the row into view.` : r);
  if (r.selected === on) return `row ${row} of ${sid} was already ${on ? "selected" : "not selected"}: nothing changed${scrolled}`;
  await session.roundtrip(() => f.locator("[data-sap-act='selector']").first().click({ timeout: 10000 }), 800);
  const now = await (await lsFrame(session)).evaluate(markSelector, target).catch(() => "");
  if (typeof now !== "string" && now.selected !== on)
    throw new ActionError(`row ${row} of ${sid} is still ${now.selected ? "selected" : "not selected"}: the click on its row selector did not change it. Look at the screen.`);
  return `${on ? "selected" : "deselected"} row ${row} of ${sid}${scrolled}`;
}

/**
 * Clicks a row of an open popup menu (a context menu, the menu of a
 * dropdown button, the ">>" menu of a toolbar) named by its DOM id, as the
 * view lists it. False when no such row is open.
 */
async function clickMenuRow(session: WebGuiSession, id: string): Promise<boolean> {
  const f = await lsFrame(session);
  const open = await f
    .evaluate((rowId) => {
      const tr = document.getElementById(rowId);
      if (!tr || tr.tagName !== "TR" || !(tr.getAttribute("ct") ?? "").startsWith("POMN")) return false;
      const r = tr.getBoundingClientRect();
      // A closed menu stays in the page far above the window.
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    }, id)
    .catch(() => false);
  if (!open) return false;
  await session.roundtrip(() => f.locator(`tr[id="${id.replace(/"/g, '\\"')}"]`).first().click({ timeout: 10000 }), 1200);
  return true;
}

/**
 * Presses a toolbar button that the toolbar moved behind its ">>" button:
 * opens that menu and chooses the button's entry, as a person does. A
 * button of the screen's toolbar (tbar[N]/btn[K]) is function key K when the
 * entry cannot be found.
 */
async function pressOverflow(session: WebGuiSession, c: MarkedControl): Promise<string> {
  const f = await lsFrame(session);
  await f.locator(`[id="${c.overflow}"]`).first().click({ timeout: 5000 });
  await session.page.waitForTimeout(300);
  const row = `${c.dom}-BtnMenu`;
  if (await clickMenuRow(session, row)) return `pressed ${c.sid} (from the ">>" menu of its toolbar)`;
  const k = /\/tbar\[\d\]\/btn\[(\d+)\]$/.exec(c.sid)?.[1];
  // The menu did not show the entry: close it (">>" again; Escape would be Cancel if it is not open), then send the button's function key.
  await f.locator(`[id="${c.overflow}"]`).first().click({ timeout: 5000 }).catch(() => {});
  await session.page.waitForTimeout(150);
  if (k === undefined) throw new ActionError(`${c.sid} is behind the toolbar's ">>" button and its entry could not be found there. Look at the screen.`);
  await session.roundtrip(() => session.pressKey(vkey(Number(k))), SURE_START_MS);
  return `pressed ${c.sid} (behind ">>": sent as its key ${vkey(Number(k))})`;
}

/** The entry a dropdown shows now, read from its input: "" when it cannot be read. */
async function comboShown(loc: Locator): Promise<string> {
  return ((await loc.inputValue().catch(() => "")) || "").replace(/\s+/g, " ").replace(/^ | $/g, "");
}

async function run(session: WebGuiSession, a: Action): Promise<string> {
  const page = session.page;
  const id = String(a.id ?? "");
  switch (a.do) {
    case "okcode":
      await session.okCode(String(a.value ?? ""));
      return `okcode ${a.value}`;
    case "key": {
      const k = vkey(a.key ?? a.value);
      // In a popup, SAP binds toolbar button btn[N] to virtual key N ("Continue (Enter)" is btn[0]).
      // Pressing that button works whether or not the keyboard focus is in the popup.
      const n = typeof (a.key ?? a.value) === "number" ? Number(a.key ?? a.value) : k === "Enter" ? 0 : undefined;
      if (n !== undefined) {
        const f = await lsFrame(session);
        const top = await f.evaluate(() => {
          let max = 0;
          for (const el of Array.from(document.querySelectorAll("[lsdata*='wnd[']"))) {
            const m = /wnd\[(\d+)\]/.exec(el.getAttribute("lsdata") ?? "");
            if (m && (el as HTMLElement).offsetWidth > 0) max = Math.max(max, Number(m[1]));
          }
          return max;
        });
        if (top > 0)
          for (const bar of [0, 1]) {
            const sid = `wnd[${top}]/tbar[${bar}]/btn[${n}]`;
            const r = await f.evaluate(markControl, sid);
            // markControl also matches by last segment: only a button of the popup itself counts.
            if (typeof r === "string" || r.sid !== sid) continue;
            await clickForRoundtrip(session, sid);
            return `key ${k} (pressed ${sid})`;
          }
        // No such button in the popup: give the popup the keyboard focus (a click on its title bar
        // does nothing else), so the key reaches it and not the screen behind.
        if (top > 0) await f.locator(".urPWTitleText").filter({ visible: true }).last().click({ timeout: 3000 }).catch(() => {});
      }
      // An SAP function key always sends a request: it is waited for, also when the browser is slow to
      // hand the key on. Keys that only move in the page (Tab, arrows) send none.
      await session.roundtrip(() => session.pressKey(k), n !== undefined || /^((Shift|Control|Alt)\+)*(Enter|Escape|F\d{1,2})$/i.test(k) ? SURE_START_MS : 800);
      return `key ${k}`;
    }
    case "scroll": {
      let sid = id;
      if (!sid) {
        const all = scrollables(await freshView(session));
        if (all.length !== 1) throw new ActionError(all.length ? `scroll needs "id": one of ${all.map((x) => shortIds(all).get(x) ?? x).join(", ")}.` : "Nothing on this screen scrolls: no grid, table, tree or list.");
        sid = all[0] as string;
      }
      const to = (a.to ?? "next") as number | string;
      const r = await scrollTo(session, sid, to);
      if (typeof r === "string") return r;
      const last = Math.min(r.first + r.visible, r.total) - 1;
      if (to === "right" || to === "left" || to === "rightmost" || to === "leftmost")
        return r.first === r.from ? `${r.sid} cannot move further ${to.replace(/most$/, "")}` : `scrolled ${r.sid} sideways: the columns on screen changed (the view lists them)`;
      return r.first === r.from ? `${r.sid} is already there: rows ${r.first} to ${last} of ${r.total}` : `scrolled ${r.sid}: rows ${r.first} to ${last} of ${r.total}`;
    }
    case "tree":
    case "grid": {
      // "select" on a grid row: the row is selected by its row selector, as a person clicks it; with a column,
      // the cell gets the cursor first. "cell" only puts the cursor on the cell.
      if (a.do === "grid" && (a.how ?? "double") === "select" && a.row !== undefined) {
        const hasSelector = await (await lsFrame(session)).evaluate(markSelector, { sid: id, row: Number(a.row) }).catch(() => "");
        const selectable = typeof hasSelector !== "string" || / is not on screen$/.test(hasSelector);
        if (selectable && (a.col === undefined || a.col === "")) return selectRow(session, id, Number(a.row), true);
        if (selectable) {
          const note = await run(session, { ...a, how: "cell" });
          const sel = await selectRow(session, id, Number(a.row), true);
          return `${note}; ${sel}`;
        }
      }
      // expand and collapse are one click on the node's expander: a node already in that state is left alone.
      if (a.do === "tree" && (a.how === "expand" || a.how === "collapse") && a.node !== undefined) {
        const node = String(a.node).replace(/^ +| +$/g, "");
        const line = (await freshView(session)).split("\n").find((l) => l.endsWith(`{node ${node}}`));
        const open = line ? /^ +\[-\] /.test(line) : undefined;
        const leaf = line ? !/^ +\[[-+]\] /.test(line) : false;
        if (leaf) throw new ActionError(`node ${node} has no children: there is nothing to ${a.how}.`);
        if (open === (a.how === "expand")) return `node ${node} is already ${a.how === "expand" ? "expanded" : "collapsed"}: nothing changed`;
      }
      let f = await lsFrame(session);
      const target = { sid: id, row: a.row, node: a.node, col: a.col };
      let r = await f.evaluate(markRow, target);
      let scrolled = "";
      if (/ is not on screen$/.test(r) && a.row !== undefined && a.node === undefined) {
        // A row past the end is said so before anything moves.
        const here = await f.evaluate(scrollControl, { sid: id, to: "here" }).catch(() => "");
        if (typeof here !== "string" && a.row >= here.total) throw new ActionError(`row ${a.row}: the list has ${here.total} rows (0 to ${here.total - 1}).`);
        // The row is not drawn: scroll it into view first, as a person would.
        const sc = await scrollTo(session, id, a.row);
        if (typeof sc !== "string") {
          scrolled = ` (scrolled to it: rows ${sc.first} to ${Math.min(sc.first + sc.visible, sc.total) - 1} of ${sc.total} are shown)`;
          // The rows are drawn a moment after the scroll's round trip.
          for (let i = 0; i < 10; i++) {
            f = await lsFrame(session);
            r = await f.evaluate(markRow, target);
            if (!/ is not on screen$/.test(r)) break;
            await session.page.waitForTimeout(200);
          }
        }
      }
      if (r !== "ok") throw new ActionError(/ is not on screen$/.test(r) ? `${r}: the list does not have it, or it is not drawn. {"do":"scroll","id":"${id}","to":<row>} shows where the list ends.` : r);
      const how = a.how ?? "double";
      const cell = f.locator("[data-sap-act='cell']").first();
      await cell.scrollIntoViewIfNeeded().catch(() => {});
      await session.roundtrip(async () => {
        if (how === "expand" || how === "collapse") {
          const exp = f.locator("[data-sap-act='expander']");
          if (await exp.count()) await exp.first().click();
          else await cell.click();
        } else if (how === "double") await cell.dblclick({ timeout: 5000 }).catch(() => cell.dispatchEvent("dblclick"));
        else await cell.click({ timeout: 5000 }).catch(() => cell.dispatchEvent("click"));
      }, 1200);
      return `${a.do} ${how === "cell" ? "cursor on" : how} ${a.node ?? `row ${a.row}`}${a.col !== undefined && a.col !== "" && a.node === undefined ? ` column ${a.col}` : ""}${scrolled}`;
    }
    case "select": {
      if (/\/mbar\/menu\[/.test(id) || /^menu\[/.test(id)) {
        // Menu path: open the Menu button, then each level by its scripting id.
        const f = await lsFrame(session);
        const full = id.startsWith("wnd[") ? id : `wnd[0]/mbar/${id}`;
        await f.locator("#cua2sapmenu_btn").click();
        await page.waitForTimeout(300);
        const parts = full.split("/").slice(2);
        for (let i = 1; i <= parts.length; i++) {
          const sid = `wnd[0]/mbar/${parts.slice(0, i).join("/")}`;
          const row = f
            .locator(`tr[id="${sid}"]`)
            .filter({ visible: true })
            .first();
          await row.click({ timeout: 10000 });
          await page.waitForTimeout(300);
        }
        await session.waitRoundtrip();
        return `menu ${full}`;
      }
      if (a.row !== undefined && /^(table|grid)$/.test(kindIn(await freshView(session), id)))
        return selectRow(session, id, Number(a.row), a.value === undefined || /^(x|true|1|on|yes)$/i.test(String(a.value)));
      if (await clickMenuRow(session, id)) return `chose menu entry ${id}`;
      const { loc, c } = await locate(session, id);
      // A tab sends a request, and choosing it twice is choosing it once: a lost click is made again.
      // (Not `sure`: a tab strip that switches in the page sends nothing.)
      if (c.type === "GuiTab") await clickForRoundtrip(session, c.sid, false);
      else await session.roundtrip(() => loc.click(), 1200);
      return `selected ${c.sid}`;
    }
    case "toolbar": {
      const { loc, c } = await locate(session, `${id}/${a.button}`).catch(() =>
        locate(session, String(a.button)),
      );
      await session.roundtrip(() => loc.click(), 1200);
      return `pressed ${c.sid}`;
    }
    case "dblclick":
      if (a.node !== undefined)
        return run(session, { ...a, do: "tree", how: "double" });
      if (a.row !== undefined)
        return run(session, { ...a, do: "grid", how: "double" });
      break;
    default:
      break;
  }
  if (id.startsWith("html[") || /\/html\[\d+\]$/.test(id))
    return actHtml(session, a);
  // A row of an open popup menu is named by its DOM id.
  if ((a.do === "press" || a.do === "dblclick") && (await clickMenuRow(session, id))) return `chose menu entry ${id}`;
  if (a.do === "check" && a.row !== undefined && /^(table|grid)$/.test(kindIn(await freshView(session), id)))
    return selectRow(session, id, Number(a.row), a.value === undefined || /^(x|true|1|on|yes)$/i.test(String(a.value)));
  const { loc, c } = await locate(session, id);
  switch (a.do) {
    case "set": {
      if (c.type === "GuiCheckBox") return run(session, { ...a, do: "check" });
      if (c.type === "GuiComboBox")
        return run(session, { ...a, do: "combo", key: a.value });
      const refusal = setRefusal(c);
      if (refusal) throw new ActionError(refusal);
      if (c.readonly) throw new ActionError(`${c.sid} is read-only`);
      await typeInto(session, loc, String(a.value ?? ""));
      return `set ${c.sid}`;
    }
    case "press":
      if (c.overflow) return pressOverflow(session, c);
      if (c.type === "GuiButton") await clickForRoundtrip(session, c.sid);
      else await session.roundtrip(() => loc.click(), 1200);
      return `pressed ${c.sid}`;
    case "focus":
      await loc.focus();
      return `focus ${c.sid}`;
    case "dblclick":
      await session.roundtrip(() => loc.dblclick(), 1200);
      return `double-clicked ${c.sid}`;
    case "f4":
      if (!FIELD_TYPES.has(c.type) && c.type !== "GuiComboBox") throw new ActionError(`${c.sid} is a ${typeName(c.type)}: value help works on fields.`);
      await loc.focus();
      await session.roundtrip(() => page.keyboard.press("F4"));
      return `value help on ${c.sid}`;
    case "check": {
      if (c.type !== "GuiCheckBox" && c.type !== "GuiRadioButton" && c.type !== "ABAPLISTCHECKBOX")
        throw new ActionError(`${c.sid} is a ${typeName(c.type)}, not a checkbox: use "press" for a button, "select" for a tab, {"do":"select","id":<table>,"row":N} for a row.`);
      const on =
        a.value === undefined
          ? true
          : /^(x|true|1|on|yes)$/i.test(String(a.value));
      if (c.readonly) throw new ActionError(`${c.sid} cannot be changed here: it is greyed out (read-only). It stays ${c.checked ? "checked" : "unchecked"}.`);
      if (c.type === "GuiRadioButton" && !on) throw new ActionError(`${c.sid} is a radio button: it is turned off by selecting another one of its group.`);
      if (c.checked === on) return `${c.sid} was already ${on ? "checked" : "unchecked"}: nothing changed`;
      const stateNow = async () => {
        const now = await (await lsFrame(session)).evaluate(markControl, c.sid).catch(() => "");
        return typeof now !== "string" && now.sid === c.sid ? now.checked : undefined;
      };
      await session.roundtrip(() => loc.click(), 800);
      // A click that was lost (see clickForRoundtrip) left the box as it was: made once more, by the box's own state.
      if ((await stateNow()) === !on) {
        await session.closeSuggestions();
        await session.roundtrip(() => session.frame.locator("[data-sap-act]").first().click(), 800);
      }
      const after = await stateNow();
      if (after === !on) throw new ActionError(`${c.sid} is still ${after ? "checked" : "unchecked"}: SAP did not take the change (it may set this box itself). Look at the screen.`);
      return `${c.sid} ${on ? "checked" : "unchecked"}`;
    }
    case "combo": {
      if (c.type !== "GuiComboBox") throw new ActionError(`${c.sid} is a ${typeName(c.type)}, not a dropdown.`);
      if (a.key === undefined && a.value === undefined) {
        // No key: the entries, and nothing is chosen.
        const entries = await entriesOf(session, c.sid);
        return entries.length ? `${c.sid} has ${entries.length} entries: ${entries.map((e) => `${e.key}:${e.text}`).join(", ")}` : `${c.sid} has no entries`;
      }
      if (c.readonly) throw new ActionError(`${c.sid} is read-only: its entry cannot be changed here.`);
      const want = String(a.key ?? a.value ?? "").replace(/\s+/g, " ").replace(/^ | $/g, "").toLowerCase();
      const f = await lsFrame(session);
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
      await page.waitForTimeout(300);
      // Some lists open from the arrow next to the field.
      if (!(await items.count())) {
        await f.locator(`[id="${await loc.getAttribute("id")}-btn"]`).first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
      }
      const n = await items.count();
      const texts: string[] = [];
      const keys: string[] = [];
      for (let i = 0; i < n; i++) {
        texts.push(((await items.nth(i).innerText()) || "").replace(/\s+/g, " ").replace(/^ | $/g, "").toLowerCase());
        keys.push(((await items.nth(i).getAttribute("data-itemkey")) ?? "").toLowerCase());
      }
      let idx = keys.indexOf(want);
      if (idx < 0) idx = texts.findIndex((t) => t === want || t.startsWith(`${want} `));
      if (idx < 0 && want) idx = texts.findIndex((t) => t.includes(want));
      if (idx < 0) {
        // Escape closes the open list; with no list open it would be Cancel (F12).
        if (n > 0) await page.keyboard.press("Escape");
        throw new ActionError(n ? `no entry "${want}" in ${c.sid}: ${keys.map((k, i) => `${k}:${texts[i]}`).join(", ")}` : `the list of ${c.sid} did not open, so nothing was chosen. Look at the screen.`);
      }
      const chosen = ((await items.nth(idx).innerText()) || "").replace(/\s+/g, " ").replace(/^ | $/g, "");
      const key = (await items.nth(idx).getAttribute("data-itemkey")) ?? "";
      await session.roundtrip(() => items.nth(idx).click(), 800);
      // The answer says what the dropdown shows now, not what was asked for (the screen may have been drawn again).
      const again = await locate(session, c.sid).catch(() => undefined);
      const after = again ? await comboShown(again.loc) : "";
      if (after && after !== chosen) throw new ActionError(`${c.sid} shows "${after}" after choosing "${chosen}" (it showed "${before}" before): SAP did not take the entry. Look at the screen.`);
      return `${c.sid} = ${key ? `${key} ` : ""}${chosen}${before === chosen ? " (it was already chosen)" : ""}`;
    }
    default:
      throw new ActionError(`unknown action ${a.do}`);
  }
}

/** Why an action may not run on this element of an HTML viewer, or undefined when it may. */
export function htmlRefusal(doing: string, tag: string, inputType: string, id: string): string | undefined {
  const button = tag === "BUTTON" || tag === "A" || (tag === "INPUT" && /^(button|submit|image|reset)$/.test(inputType));
  if (doing === "set") {
    if (inputType === "password") return `${id} is a password field: this server never types a password. Type it yourself.`;
    if (button || (tag === "INPUT" && /^(checkbox|radio|file)$/.test(inputType))) return `${id} is not a field: "set" types into fields only. Use "press" for a button or a link.`;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return `${id} is not a field: "set" types into fields only.`;
  }
  if (doing === "combo" && tag !== "SELECT") return `${id} is not a dropdown.`;
  if (doing === "check" && !(tag === "INPUT" && /^(checkbox|radio)$/.test(inputType))) return `${id} is not a checkbox.`;
  return undefined;
}

/** Actions on controls of an HTML viewer (html[n] from the view). */
async function actHtml(session: WebGuiSession, a: Action): Promise<string> {
  const id = String(a.id);
  const n = /html\[(\d+)\]$/.exec(id)?.[1];
  const f = await lsFrame(session);
  const viewers = await viewerFrames(f);
  const v = viewers.find((x) => id.startsWith(`${x.sid}/`)) ?? viewers[0];
  if (!v || !n) throw new ActionError(`no HTML viewer control ${id}`);
  const { frames } = await readViewer(v.frame); // numbers the controls as the view did
  const hit = frames.find((x) => Number(n) >= x.from && Number(n) <= x.to);
  if (!hit) throw new ActionError(`no HTML viewer control ${id}`);
  const loc = hit.frame.locator(`[data-sap-html="${n}"]`);
  const { tag, type } = await loc.evaluate((e) => ({ tag: e.tagName, type: e.tagName === "INPUT" ? (e as HTMLInputElement).type || "text" : "" }));
  const refusal = htmlRefusal(a.do, tag, type, id);
  if (refusal) throw new ActionError(refusal);
  if (a.do === "combo" || (a.do === "set" && tag === "SELECT")) {
    const want = String(a.key ?? a.value ?? "");
    const r = await loc
      .selectOption(want)
      .catch(() => loc.selectOption({ label: want }));
    await session.waitRoundtrip(1500);
    return `selected ${r.join(",")} in ${id}`;
  }
  if (a.do === "set") await loc.fill(String(a.value ?? ""));
  else if (a.do === "dblclick") await loc.dblclick();
  else if (a.do === "check")
    await loc.setChecked(
      a.value === undefined
        ? true
        : /^(x|true|1|on|yes)$/i.test(String(a.value)),
    );
  else await loc.click();
  await session.waitRoundtrip(1200);
  return `${a.do} ${id}`;
}
