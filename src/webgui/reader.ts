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
import { compact, controlBlock } from "../core/compact.js";
import { shortIds } from "../core/ids.js";
import { readRows } from "../core/rows.js";
import { ActionError, type Action, type Assessment, type LookOptions } from "../core/types.js";
import { LOGON_REFUSAL, okcodeKind } from "../core/words.js";
import { assessAction, popupButton, questionRefusal } from "./assess.js";
import { checkedNow, clean, clickForRoundtrip, clickListLine, clickMenuRow, evalLs, FIELD_TYPES, isExactly, locate, marked, noControlLook, openTextCell, pressOverflow, setCalendar, setTokenField, setRefusal, stillThere, SURE_START_MS, typeInto, typeName, windowOf } from "./controls.js";
import { LOCAL_KEY, nothingSent, vkey, wantsOn } from "./keys.js";
import { chooseEntry, entriesOf, markScrolled, notOnScreen, scrollTo, selectRow } from "./lists.js";
import { extractFacts, extractMenus, markControl, markRow, markSelector, menuRowOpen, openOverlay, scrollControl, topWindowOpen } from "./page.js";
import { checkBeforeAct, focusOf, freshView, guardFacts, isDropdown, kindIn, LOGGED_OFF, loggedOff, look, lookRead, menuLines, readViewer, resolveIn, type ScreenRead, scrollables, viewerFrames } from "./screen.js";
import { IDLE_TIMEOUT_MS, LEAVE_MS, MAX_IDLE_TIMEOUT_MS, noTiming, timingText, type WebGuiSession } from "./session.js";

export { setRefusal } from "./controls.js";
export { LOCAL_KEY, nothingSent, vkey } from "./keys.js";
export { focusOf, LOGGED_OFF, loggedOff, look, resolveIn } from "./screen.js";

/**
 * Classifies an action from the screen as it is now: the full view, the menu
 * entries, the logon language and the focused control. On a logon screen it
 * refuses (ActionError). A screen that cannot be read cannot be ruled safe.
 */
export async function assess(session: WebGuiSession, action: Action): Promise<Assessment> {
  let screen: ScreenRead;
  try {
    screen = await lookRead(session);
  } catch (e) {
    // Still never a logon screen, even one that could not be read out.
    if ((await session.frame.evaluate(extractFacts).catch(() => undefined))?.logon === true) throw new ActionError(LOGON_REFUSAL);
    return unreadable(e);
  }
  if (screen.facts?.logon) throw new ActionError(LOGON_REFUSAL);
  try {
    const view = screen.text;
    const { menus, focus } = await guardFacts(session, action.do === "key" || action.do === "okcode");
    const facts = screen.facts ?? (await session.frame.evaluate(extractFacts));
    // Enter on a question popup is never sent, with writing on or off: the answer lists the popup's answers.
    if (action.do === "key") {
      const raw = action.key ?? action.value;
      const hit = typeof raw === "number" || typeof raw === "string" ? popupButton(view, raw, focus?.sid) : undefined;
      if (hit?.asksDefault) throw new ActionError(questionRefusal(hit));
    }
    // The control the action will act on, resolved as `act` resolves it: the guard judges that one.
    const resolved = action.id ? { ...action, id: resolveIn(view, String(action.id)) } : action;
    const verdict = assessAction(resolved, view, menus, { language: facts.language, focus });
    // A control the view does not list may still exist in the page (markControl looks wider).
    // Only when the page has none either is it "no such control" rather than "may write".
    if (verdict.risk === "commit" && verdict.reason.includes("not on the screen the server read") && action.id) {
      const found = await session.frame.evaluate(markControl, String(action.id)).catch(() => "unreadable");
      if (typeof found === "string" && !(await session.frame.evaluate(menuRowOpen, String(action.id)).catch(() => ""))) throw noControlLook(String(action.id));
    }
    return verdict;
  } catch (e) {
    if (e instanceof ActionError) throw e;
    return unreadable(e);
  }
}

/** A screen that cannot be read cannot be ruled safe. */
const unreadable = (e: unknown): Assessment => ({ risk: "commit", reason: `the screen could not be read (${(e as Error).message.split("\n")[0]})` });

/** The screen, or one control of it, as the tools show it. */
export async function view(session: WebGuiSession, options: LookOptions): Promise<string> {
  if (!options.id) {
    const full = await look(session);
    return options.compact ? compact(full) : full;
  }
  if (/^(wnd\[0\]\/)?mbar$/.test(options.id.trim())) return menuLines(session);
  const full = await look(session);
  const sid = resolveIn(full, options.id);
  if (options.rows) {
    if (!controlBlock(full, sid)) throw noControlLook(options.id);
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
  if (!block) throw noControlLook(options.id);
  if (isDropdown(block, sid)) {
    // Every entry, also those the view cuts and those Web GUI loads only when the list opens.
    const entries = await entriesOf(session, sid);
    block = `${block.replace(/ {2}(\d+ )?options: .*$/, "")}  ${entries.length} options: ${entries.map((e) => `${e.key}:${e.text}`).join(", ")}`;
  }
  return options.compact ? compact(block, { dropdowns: false, maxChars: 0, screen: full }) : block;
}

/** One action. Returns a one-line note of what was done; throws ActionError when it cannot. */
export async function act(session: WebGuiSession, a: Action): Promise<string> {
  const t0 = Date.now();
  session.timing = noTiming();
  session.timingText = undefined;
  try {
    return await actTimed(session, a);
  } finally {
    session.timingText = timingText(session.timing, Date.now() - t0);
  }
}

async function actTimed(session: WebGuiSession, a: Action): Promise<string> {
  await checkBeforeAct(session);
  const w0 = Date.now();
  await session.wake();
  session.timing.wake = Date.now() - w0;
  // A long step (a report started with F8) can be given more time: "timeout" in seconds.
  const t = Number(a.timeout);
  session.idleTimeoutMs = Number.isFinite(t) && t > 0 ? Math.min(Math.round(t * 1000), MAX_IDLE_TIMEOUT_MS) : IDLE_TIMEOUT_MS;
  session.unsettled = false;
  // A type-ahead list left open by the field typed into before covers what is below it.
  // Escape closes it itself, and only it (see the "key" action).
  if (a.do !== "set" && !isEscape(a)) await session.closeSuggestions().catch(() => {});
  try {
    // The id as the screen holds it now: a handle becomes its full id, one that names several controls is refused.
    const named = a.id !== undefined && String(a.id).trim() && !isMenuPath(String(a.id));
    const mark = session.posts;
    const done = await run(session, named ? { ...a, id: resolveIn(await freshView(session), String(a.id)) } : a);
    const nothing = session.posts === mark && !done.endsWith(NOTHING_TO_SAP) ? nothingSent(a) : undefined;
    const note = nothing ? `${done}\n${nothing}` : done;
    return session.unsettled ? `${note}\n(Web GUI still showed its loading sign when the server stopped waiting: the step may not be over. If the screen below is not what the step should lead to, look again in a moment.)` : note;
  } catch (e) {
    throw tidy(e);
  } finally {
    session.view = undefined;
    session.idleTimeoutMs = IDLE_TIMEOUT_MS;
  }
}

/** Is the action the Escape key (also as key 12 or F12, Cancel)? */
function isEscape(a: Action): boolean {
  if (a.do !== "key") return false;
  try {
    return vkey(a.key ?? a.value) === "Escape";
  } catch {
    return false;
  }
}

/** The end of a note that already says that SAP got nothing. */
const NOTHING_TO_SAP = "nothing was sent to SAP)";


/** The lines of one window of the full view, its WINDOW line first: "" when the window is not open. */
function windowBlock(view: string, n: number): string {
  const lines = view.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`WINDOW wnd[${n}]`));
  if (start < 0) return "";
  const next = lines.findIndex((l, i) => i > start && l.startsWith("WINDOW wnd["));
  return lines.slice(start, next < 0 ? lines.length : next).join("\n");
}

const isMenuPath = (id: string) => /\/mbar\/menu\[/.test(id) || /^menu\[/.test(id);

/** Playwright's errors carry a long call log: keep the first line, and say what blocks when a popup covers the control. */
function tidy(e: unknown): Error {
  if (e instanceof ActionError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const first = message.split("\n")[0] ?? message;
  if (message.includes("intercepts pointer events"))
    return new ActionError(`${first} Another window covers this control (a popup is open?): look at the screen and answer the popup first.`);
  return new ActionError(first);
}

async function run(session: WebGuiSession, a: Action): Promise<string> {
  const page = session.page;
  const id = String(a.id ?? "");
  switch (a.do) {
    case "okcode": {
      const value = String(a.value ?? "");
      if (okcodeKind(value).kind !== "closes") {
        await session.okCode(value);
        return `okcode ${value}`;
      }
      // /nex, /nend, /i: the guard let it run (SAP_ALLOW_LOGOFF=on). /nex logs off at once, and the
      // logoff page never looks idle: the answer comes from the page itself, within seconds.
      session.idleTimeoutMs = 15_000;
      const sent = session.okCode(value).then(
        () => "done" as const,
        (e: unknown) => e as Error,
      );
      for (let i = 0; i < 150; i++) {
        const r = await Promise.race([sent, page.waitForTimeout(100).then(() => undefined)]);
        if (await loggedOff(session)) return `okcode ${value}: ${LOGGED_OFF}`;
        if (r === "done") return `okcode ${value}`; // /i and /nend ask first: their Log Off popup is on the screen
        if (r instanceof Error) throw r;
      }
      return `okcode ${value} (no answer from SAP within 15 s)`;
    }
    case "key": {
      const raw = a.key ?? a.value;
      const k = vkey(raw);
      // In a popup, SAP binds toolbar button btn[N] to virtual key N ("Continue (Enter)" is btn[0]).
      // Pressing that button works whether or not the keyboard focus is in the popup.
      const n = typeof raw === "number" ? Number(raw) : k === "Enter" ? 0 : k === "Escape" ? 12 : undefined;
      if (k === "Escape") {
        // A menu or a list is open above the screen: Escape closes it, as for a person, and SAP gets
        // nothing. Pressing the window's Cancel button instead left the transaction with the menu open.
        const overlay = await session.frame.evaluate(openOverlay).catch(() => "" as const);
        if (overlay) {
          await session.roundtrip(() => session.pressKey("Escape"), 800);
          let still = await session.frame.evaluate(openOverlay).catch(() => "" as const);
          // A menu with a submenu open closes one level per Escape (the Menu button's menu of S/4HANA 2025).
          for (let i = 0; i < 4 && still === "menu" && overlay === "menu" && !session.started; i++) {
            await session.roundtrip(() => session.pressKey("Escape"), 800);
            still = await session.frame.evaluate(openOverlay).catch(() => "" as const);
          }
          // The menu bar's menu keeps its first level when Escape went to a submenu (ECC): its Menu button closes it, as a click does.
          if (still === "menu" && !session.started && (await session.frame.evaluate(menuRowOpen, "wnd[0]/mbar/menu[0]").catch(() => ""))) {
            await session.frame.locator("#cua2sapmenu_btn").click({ timeout: 3000 }).catch(() => {});
            await session.page.waitForTimeout(200);
            still = await session.frame.evaluate(openOverlay).catch(() => "" as const);
          }
          const what = overlay === "menu" ? "menu" : "list";
          if (still) throw new ActionError(`Escape did not close the open ${what}. Nothing else was pressed: look at the screen.`);
          if (session.started) return `key ${k} (a ${what} was open: Escape went to it)`;
          return `key ${k} (closed the open ${what}; the screen under it is as it was, ${NOTHING_TO_SAP}`;
        }
      }
      if (n !== undefined && (typeof raw === "number" || typeof raw === "string")) {
        // The button the key presses on the popup, as the guard judged it (assess.ts `popupButton`): it is
        // pressed by its id and named in the answer, so the agent knows which answer SAP got.
        const view = await freshView(session);
        const hit = popupButton(view, raw, (await focusOf(session))?.sid);
        const label = (c: { id: string; text: string }) => `${c.id} "${clean(c.text)}"`;
        if (hit?.control) {
          await clickForRoundtrip(session, hit.control.id);
          return `key ${k} (pressed ${label(hit.control)})`;
        }
        // A question popup (Yes / No in its body): Enter presses nothing, whatever has the focus.
        if (hit?.asksDefault) throw new ActionError(questionRefusal(hit));
      }
      if (n !== undefined) {
        const f = session.frame;
        const top = await f.evaluate(topWindowOpen);
        // Cancel (12) on the main window is its Cancel button: the browser's Escape in a field typed into
        // only takes the typing back, and sends SAP nothing.
        if (top > 0 || n === 12)
          for (const bar of [0, 1]) {
            const sid = `wnd[${top}]/tbar[${bar}]/btn[${n}]`;
            // Only a button of the popup itself counts.
            if (!isExactly(await evalLs(session, markControl, sid), sid)) continue;
            await clickForRoundtrip(session, sid, true, true);
            return `key ${k} (pressed ${sid})`;
          }
        // No such button in the popup: give the popup the keyboard focus (a click on its title bar
        // does nothing else), so the key reaches it and not the screen behind.
        if (top > 0) await f.locator(".urPWTitleText, .lsPWNewHeader [role='heading']").filter({ visible: true }).last().click({ timeout: 3000 }).catch(() => {});
      }
      // An SAP function key always sends a request: it is waited for, also when the browser is slow to
      // hand the key on. Keys that only move in the page (Tab, arrows) send none.
      await session.roundtrip(() => session.pressKey(k), LOCAL_KEY.test(k) ? 800 : SURE_START_MS);
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
        return r.first === r.from ? `${r.sid} cannot move further ${to.replace(/most$/, "")}` : `scrolled ${r.sid} sideways: the view lists the columns on screen now`;
      return r.first === r.from ? `${r.sid} is already there: rows ${r.first} to ${last} of ${r.total}` : `scrolled ${r.sid}: rows ${r.first} to ${last} of ${r.total}`;
    }
    case "tree":
    case "grid": {
      // "select" on a grid row: the row is selected by its row selector, as a person clicks it; with a column,
      // the cell gets the cursor first. "cell" only puts the cursor on the cell.
      if (a.do === "grid" && (a.how ?? "double") === "select" && a.row !== undefined) {
        const hasSelector = await evalLs(session, markSelector, { sid: id, row: Number(a.row) }).catch(() => "");
        const selectable = typeof hasSelector !== "string" || notOnScreen(hasSelector);
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
      const f = session.frame;
      const target = { sid: id, row: a.row, node: a.node, col: a.col };
      let r = await evalLs(session, markRow, target);
      let scrolled = "";
      if (notOnScreen(r) && a.row !== undefined && a.node === undefined) {
        // A row past the end is said so before anything moves.
        const here = await f.evaluate(scrollControl, { sid: id, to: "here" }).catch(() => "");
        if (typeof here !== "string" && a.row >= here.total) throw new ActionError(`row ${a.row}: the list has ${here.total} rows (0 to ${here.total - 1}).`);
        // The row is not drawn: scroll it into view first, as a person would.
        ({ r, scrolled } = await markScrolled(session, id, a.row, markRow, target, r));
      }
      if (r !== "ok") throw new ActionError(notOnScreen(r) ? `${r}: the list does not have it, or it is not drawn. {"do":"scroll","id":"${id}","to":<row>} shows where the list ends.` : r);
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
      // A column and no row: the column's header was clicked (it selects the column, for the toolbar's sort or total).
      if (a.row === undefined && a.node === undefined && a.col !== undefined && a.col !== "") return `${a.do} ${how === "select" || how === "cell" ? "selected" : how} column ${a.col}`;
      return `${a.do} ${how === "cell" ? "cursor on" : how} ${a.node ?? `row ${a.row}`}${a.col !== undefined && a.col !== "" && a.node === undefined ? ` column ${a.col}` : ""}${scrolled}`;
    }
    case "select": {
      if (isMenuPath(id)) {
        // Menu path: open the Menu button, then each level by its scripting id.
        const f = session.frame;
        const full = id.startsWith("wnd[") ? id : `wnd[0]/mbar/${id}`;
        const parts = full.split("/").slice(2);
        const path = (n: number) => `wnd[0]/mbar/${parts.slice(0, n).join("/")}`;
        const open = async (sid: string) => (await f.evaluate(menuRowOpen, sid).catch(() => "")) !== "";
        const menuOpen = async () => (await f.evaluate(openOverlay).catch(() => "")) === "menu";
        // An entry the menu bar does not have is said at once, with where the entries are listed. (Web GUI
        // keeps the entries as templates only while the menu is closed: an open menu is asked itself.)
        const wasOpen = await open(path(1));
        const menus = wasOpen ? [] : await f.evaluate(extractMenus).catch(() => []);
        if (menus.length && !menus.some((m) => m.sid === full)) throw new ActionError(`No menu entry "${id}" on this screen. {"id":"mbar"} in sap_look lists every entry with its id.`);
        // Web GUI's event queue is watched from before the clicks: an entry that only opens its submenu puts nothing there.
        await session.watchQueue();
        const before = session.posts;
        // The Menu button opens the menu, and closes one that is open: it is clicked only when the menu is closed.
        if (!wasOpen) await f.locator("#cua2sapmenu_btn").click({ timeout: 5000 });
        for (let i = 1; i <= parts.length; i++) {
          const sid = path(i);
          // A level that already shows its entries (opened by an earlier "select") is not clicked again.
          if (i < parts.length && (await open(path(i + 1)))) continue;
          // A submenu opens a moment after its parent is clicked: the entry is waited for, not long.
          let shown = false;
          for (let k = 0; k < 30 && !(shown = await open(sid)); k++) await page.waitForTimeout(100);
          if (!shown) {
            for (let k = 0; k < 4 && (await menuOpen()); k++) await session.pressKey("Escape").catch(() => {});
            if (await open(path(1))) await f.locator("#cua2sapmenu_btn").click({ timeout: 3000 }).catch(() => {});
            throw new ActionError(`The menu did not show its entry ${sid.replace(/^wnd\[0\]\/mbar\//, "")} within 3 s: this screen has no such entry (or it is hidden here). Nothing was chosen, and the menu is closed again. {"id":"mbar"} in sap_look lists every entry with its id.`);
          }
          await f.locator(`tr[id="${sid}"]`).filter({ visible: true }).first().click({ timeout: 5000 });
          if (i < parts.length) await page.waitForTimeout(100);
        }
        // An entry with a submenu only opens it, and sends SAP nothing: its entries show within a moment
        // (they are in the view). Any other entry sends its request, which is waited for as a button's is.
        const prefix = `${full}/`;
        let submenu = false;
        for (let k = 0; k < 8 && session.posts === before && !submenu; k++) {
          submenu = await f
            .evaluate((p) => Array.from(document.querySelectorAll("tr[ct^='POMN']")).some((tr) => tr.id.startsWith(p) && tr.getBoundingClientRect().height > 0 && tr.getBoundingClientRect().bottom > 0), prefix)
            .catch(() => false);
          if (!submenu) await page.waitForTimeout(100);
        }
        await session.waitRoundtrip(submenu ? 300 : SURE_START_MS, before);
        if (!session.started && (await menuOpen())) return `opened menu ${full}: its entries are listed below; choose one with "select" (${NOTHING_TO_SAP}`;
        return `menu ${full}`;
      }
      if (a.row !== undefined && /^(table|grid)$/.test(kindIn(await freshView(session), id)))
        return selectRow(session, id, Number(a.row), wantsOn(a.value));
      if (await clickMenuRow(session, id)) return `chose menu entry ${id}`;
      const { loc, c } = await locate(session, id);
      // A tab sends a request, and choosing it twice is choosing it once: a lost click is made again.
      // (Not `sure`: a tab strip that switches in the page sends nothing.)
      if (c.type === "GuiTab") await clickForRoundtrip(session, c.sid, false, true);
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
    return selectRow(session, id, Number(a.row), wantsOn(a.value));
  const { loc, c } = await locate(session, id);
  switch (a.do) {
    case "set": {
      if (c.type === "GuiCalendar") {
        const wanted = String(a.value ?? "");
        const holds = await setCalendar(session, loc, wanted);
        if (holds !== clean(wanted)) throw new ActionError(`${c.sid} holds "${holds}" after "${wanted}" was typed: the calendar did not take it as a date (the view gives the format).`);
        return `set ${c.sid}`;
      }
      if (c.type === "GuiCheckBox") return run(session, { ...a, do: "check" });
      if (c.type === "GuiComboBox")
        return run(session, { ...a, do: "combo", key: a.value });
      if (c.type === "GuiSearchHelpHeaderItem" && !c.readonly) {
        await setTokenField(session, c, String(a.value ?? ""));
        return `set ${c.sid}`;
      }
      const refusal = setRefusal(c);
      if (refusal) throw new ActionError(refusal);
      if (c.readonly) throw new ActionError(`${c.sid} is read-only`);
      await typeInto(session, c.drawnAsText ? await openTextCell(session, c, loc) : loc, String(a.value ?? ""));
      return `set ${c.sid}`;
    }
    case "press":
      if (c.overflow) return pressOverflow(session, c);
      if (c.type === "GuiButton") await clickForRoundtrip(session, c.sid, true, true);
      else await session.roundtrip(() => loc.click(), 1200);
      return `pressed ${c.sid}`;
    case "focus":
      await loc.focus();
      return `focus ${c.sid}`;
    case "dblclick": {
      const inPopup = windowOf(c.sid) > 0;
      if (!inPopup || !c.type.startsWith("ABAPLIST")) {
        await session.roundtrip(() => loc.dblclick(), 1200);
        return `double-clicked ${c.sid}`;
      }
      // A line of a list in a popup. Its click reaches SAP late (clickListLine), and the first one can do
      // no more than give the line the cursor: SAP answers, and the popup stays as it was (measured on
      // "Partner selection" of VA01: the line that has the cursor when the popup opens). So the popup is
      // compared with what it showed before, and when nothing in it changed the double-click is made once more.
      const n = windowOf(c.sid);
      const before = windowBlock(await freshView(session), n);
      await clickListLine(session, () => loc.dblclick());
      if (!(await stillThere(session, c.sid)) || windowBlock(await look(session), n) !== before) return `double-clicked ${c.sid}`;
      await clickListLine(session, () => marked(session).dblclick());
      return `double-clicked ${c.sid} (twice: the first double-click only gave the list the cursor)`;
    }
    case "f4":
      if (!FIELD_TYPES.has(c.type) && c.type !== "GuiComboBox") throw new ActionError(`${c.sid} is a ${typeName(c.type)}: value help works on fields.`);
      await loc.focus();
      await session.roundtrip(() => page.keyboard.press("F4"));
      return `value help on ${c.sid}`;
    case "check": {
      if (c.type !== "GuiCheckBox" && c.type !== "GuiRadioButton" && c.type !== "ABAPLISTCHECKBOX")
        throw new ActionError(`${c.sid} is a ${typeName(c.type)}, not a checkbox: use "press" for a button, "select" for a tab, {"do":"select","id":<table>,"row":N} for a row.`);
      const on = wantsOn(a.value);
      if (c.readonly) throw new ActionError(`${c.sid} cannot be changed here: it is greyed out (read-only). It stays ${c.checked ? "checked" : "unchecked"}.`);
      if (c.type === "GuiRadioButton" && !on) throw new ActionError(`${c.sid} is a radio button: it is turned off by selecting another one of its group.`);
      if (c.checked === on) return `${c.sid} was already ${on ? "checked" : "unchecked"}: nothing changed`;
      await session.roundtrip(() => loc.click(), 800);
      // A click that was lost (see clickForRoundtrip) left the box as it was: made once more, by the box's own state.
      if ((await checkedNow(session, c.sid)) === !on) {
        await session.closeSuggestions();
        await session.roundtrip(() => marked(session).click(), 800);
      }
      const after = await checkedNow(session, c.sid);
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
      return chooseEntry(session, c, loc, a.key ?? a.value);
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
  const viewers = await viewerFrames(session);
  const v = viewers.find((x) => id.startsWith(`${x.sid}/`)) ?? viewers[0];
  if (!v || !n) throw new ActionError(`no HTML viewer control ${id}`);
  const { frames } = await readViewer(v.frame); // numbers the controls as the view did
  const hit = frames.find((x) => Number(n) >= x.from && Number(n) <= x.to);
  if (!hit) throw new ActionError(`no HTML viewer control ${id}`);
  const loc = hit.frame.locator(`[data-sap-html="${n}"]`);
  const { tag, type } = await loc.evaluate((e) => ({ tag: e.tagName, type: e.tagName === "INPUT" ? (e as HTMLInputElement).type || "text" : "" }));
  const refusal = htmlRefusal(a.do, tag, type, id);
  if (refusal) throw new ActionError(refusal);
  const before = session.posts;
  if (a.do === "combo" || (a.do === "set" && tag === "SELECT")) {
    const want = String(a.key ?? a.value ?? "");
    const r = await loc
      .selectOption(want)
      .catch(() => loc.selectOption({ label: want }));
    await session.waitRoundtrip(1500, before, LEAVE_MS);
    return `selected ${r.join(",")} in ${id}`;
  }
  if (a.do === "set") await loc.fill(String(a.value ?? ""));
  else if (a.do === "dblclick") await loc.dblclick();
  else if (a.do === "check")
    await loc.setChecked(wantsOn(a.value));
  else await loc.click();
  // The viewer's frame tells Web GUI by a message: its event reaches the queue a moment after the click.
  await session.waitRoundtrip(1200, before, LEAVE_MS);
  return `${a.do} ${id}`;
}
