/**
 * Classifies an action before it runs: read, navigate or commit (may write
 * to the database). It works from the full view of the screen (the reader's
 * text, the same format for Web GUI and SAP GUI) and from the menu entries
 * with their shortcuts, so the rules can be tested on text fixtures.
 *
 * The rule fails closed: a button, a menu entry, a function key or a function
 * code is a commit unless it is known to be safe. "Known safe" is one of:
 * - its id: a toolbar button `btn[N]` whose N is a safe function key (Enter,
 *   Back, Exit, Cancel, F4, find, paging);
 * - its function key, from the tooltip ("Back (F3)");
 * - its function code (the standard functions of ALV grids: sort, filter...);
 * - its text, when the session's logon language is covered (core/words.ts);
 * - its place: the Goto menu, a value help, a message popup, a report's
 *   selection screen, a screen that only displays an object (each rule below
 *   says why that place writes nothing).
 * A control the view does not show cannot be ruled safe either.
 *
 * A key is judged as what it triggers: on a popup the button the reader
 * presses for it (reader.ts, "key"), elsewhere the button or menu entry that
 * carries it. Closing the logon (/nex, Log Off) is flagged `closes`: the guard
 * treats it on its own (core/guard.ts).
 *
 * The words and codes are tables in core/words.ts, shared with the other
 * surfaces. To cover a new case, add a word or a code there.
 */
import { menuSid, resolveId } from "../core/ids.js";
import type { Action, Assessment } from "../core/types.js";
import { actWord, CLOSES_SESSIONS, commitCode, commitWord, discardsInput, displayTitle, endsLogon, isGotoMenu, languageCovered, listChoice, listTitle, MENU_PROGRAMS, okcodeKind, runSwitch, SAFE_VKEYS, safeCode, safeWord, SAVE_VKEYS } from "../core/words.js";
import type { MenuEntry } from "./page.js";
import { vkey } from "./keys.js";

/**
 * Keys that never write, whatever the screen: the safe SAP function keys
 * (SAFE_VKEYS, by the keyboard key the reader sends for each, so the two
 * lists cannot drift apart: F8 was in one and not the other), their other
 * names (F12 for Cancel, Ctrl+G for find next), and keys that only move the focus.
 */
export const SAFE_KEYS = new Set([
  ...[...SAFE_VKEYS].flatMap((n) => {
    try {
      return [keyName(vkey(n))];
    } catch {
      return [];
    }
  }),
  "F12", "CTRL_G",
  "TAB", "SHIFT_TAB", "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "HOME", "END",
]);

/** Keys that save on every screen. */
export const SAVE_KEYS = new Set(["CTRL_S", "F11"]);

/** Keys that press the control that has the focus. */
const PRESS_KEYS = new Set(["ENTER", "SPACE"]);

/** What each kind of action does when its target is not something that runs a function. */
const BASE_RISK: Record<string, "read" | "navigate"> = {
  f4: "read",
  focus: "read",
  set: "navigate",
  check: "navigate",
  combo: "navigate",
};

/** Kinds of line that run a function when pressed. Every kind that is not in INERT is treated the same way. */
const FUNCTION_KINDS = new Set(["button", "menu", "link"]);
/** Kinds that hold input or show something: clicking one changes unsaved input at most. */
const INERT_KINDS = new Set([
  "field", "label", "tab", "radio", "checkbox", "dropdown", "group", "table", "grid", "tree", "text-editor", "html-viewer", "command-field", "status", "menubar",
]);

/** What the page says beyond the view. */
export interface AssessContext {
  /** The session's logon language ("EN", "de"); safe words count only when it is covered. */
  language?: string | undefined;
  /** The control that has the keyboard focus, when there is one. */
  focus?: FocusFacts | undefined;
}

export interface FocusFacts {
  /** Scripting id of the focused control, "" when it has none. */
  sid: string;
  /** Scripting type (GuiButton, GuiCTextField...), or "html" for an element of an HTML viewer, "browser" for one of Web GUI's own dialogs. */
  type: string;
  /** For "html" and "browser": is it a button or a link, and what does it say. */
  pressable?: boolean;
  text?: string;
}

// ---- the view, parsed ---------------------------------------------------------

export interface ViewControl {
  id: string;
  /** Window number: 0 the main window, 1.. popups. */
  window: number;
  /** field, button, tab, label, menu, link ... */
  kind: string;
  /** The rest of the line: label, value, tooltip. */
  text: string;
}
export interface ViewWindow {
  number: number;
  title: string;
  controls: ViewControl[];
}

/** The windows and control lines of a full view. Rows of grids, trees and tables (indented lines) are left out. */
export function parseView(view: string): ViewWindow[] {
  const windows: ViewWindow[] = [];
  let current: ViewWindow | undefined;
  for (const line of view.split("\n")) {
    const w = /^WINDOW wnd\[(\d+)\]\s+"(.*)"$/.exec(line);
    if (w) {
      current = { number: Number(w[1]), title: w[2] ?? "", controls: [] };
      windows.push(current);
      continue;
    }
    // A row of an open popup menu may be named by its DOM id (u1234) when the page gives it no scripting id.
    if (!current || !(line.startsWith("wnd[") || /^\S+ {2}menu {2}/.test(line))) continue;
    const [id = "", kind = "", ...rest] = line.split("  ");
    current.controls.push({ id, window: current.number, kind, text: rest.join("  ") });
  }
  return windows;
}

/** The program of the screen, from the view's header line. */
export function programOf(view: string): string {
  return /^TRANSACTION .*?  PROGRAM (\S*)/.exec(view)?.[1] ?? "";
}

/** The control an id names, resolved as the reader's actions resolve it: full id, id tail, or a field's SAP name; the topmost window wins. */
export function findControl(windows: ViewWindow[], ident: string): ViewControl | undefined {
  const all = windows.flatMap((w) => w.controls);
  let want = ident.replace(/^ +| +$/g, "");
  // A handle of the compact view (core/ids.ts), as the reader resolves it.
  const named = resolveId(
    all.map((c) => c.id),
    want,
  );
  if ("id" in named) return all.find((c) => c.id === named.id);
  let hits = all.filter((c) => c.id === want);
  if (!hits.length && want.startsWith("wnd[")) want = want.slice(want.lastIndexOf("/") + 1);
  if (!hits.length) hits = all.filter((c) => c.id.endsWith(`/${want}`));
  if (!hits.length) hits = all.filter((c) => c.id.slice(c.id.lastIndexOf("/") + 1).replace(/^[a-z]+/, "") === want);
  return hits.sort((a, b) => b.window - a.window)[0];
}

// ---- the rules ----------------------------------------------------------------

/** "Shift+F3", "Control+s", "SHIFT_F3", "Ctrl+S" -> "SHIFT_F3", "CTRL_S". */
export function keyName(k: string): string {
  return k
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[+-]/g, "_")
    .replace(/CONTROL|STRG/g, "CTRL")
    .replace(/^ESC$/, "ESCAPE")
    .replace(/^RETURN$/, "ENTER");
}

/** The shortcut a button's tooltip ends with: "Save (Ctrl+S)" -> "CTRL_S". */
function shortcutOf(text: string): string | undefined {
  const m = /\(([^()]+)\)\s*$/.exec(text);
  return m?.[1] ? keyName(m[1]) : undefined;
}

/** The function key a toolbar button is bound to, from its id: `wnd[0]/tbar[1]/btn[8]` -> 8. */
function buttonKey(id: string): number | undefined {
  const m = /^wnd\[\d+\]\/tbar\[\d+\]\/btn\[(\d+)\]$/.exec(id);
  return m ? Number(m[1]) : undefined;
}

/** The function code of a button that sits in a grid's or a tree's toolbar: `.../shell/&MB_FILTER` -> "&MB_FILTER". */
function toolbarCode(id: string): string | undefined {
  return /\/shell\/([^/[\]]+)$/.exec(id)?.[1];
}

const quote = (s: string) => `"${s.replace(/\s+/g, " ").slice(0, 80)}"`;
const commit = (reason: string): Assessment => ({ risk: "commit", reason });
const NAVIGATE: Assessment = { risk: "navigate", reason: "" };
const READ: Assessment = { risk: "read", reason: "" };
const navigate = (reason: string): Assessment => ({ risk: "navigate", reason });
const notSafe = (what: string) => commit(`${what} is not known to be safe, so it is treated as a write`);
/** Ending the logon: a commit (unsaved data is lost) that the guard also refuses on its own rule. */
const closes = (reason: string): Assessment => ({ risk: "commit", reason, closes: true });

/** What one action is judged on: the windows of the full view, the screen's header, the menu entries. */
interface Scene {
  windows: ViewWindow[];
  menus: MenuEntry[];
  program: string;
  /** The screen number from the header ("1000"). */
  dynpro: string;
}

const topOf = (windows: ViewWindow[]) => windows.reduce<ViewWindow | undefined>((a, w) => (!a || w.number > a.number ? w : a), undefined);
const windowOf = (scene: Scene, c: ViewControl) => scene.windows.find((w) => w.number === c.window);
/** A button's text without its shortcut and without the "..." that announces a dialog: "Data (F7)" -> "data". */
const bareText = (t: string) =>
  t
    .replace(/\([^()]*\)\s*$/, "")
    .replace(/\.\.\.|…/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const INPUT_KINDS = new Set(["field", "dropdown", "checkbox", "radio", "table", "grid", "tree", "text-editor"]);

/** The question of the topmost popup, when it asks whether to save, post, delete...: its question, shortened. */
function commitQuestion(windows: ViewWindow[]): string | undefined {
  const top = topOf(windows);
  if (!top || top.number === 0) return undefined;
  // A value-help hit list (list lines or a grid, no button of its own) is not a question, whatever its entries say.
  const usrButton = top.controls.some((c) => c.kind === "button" && c.id.includes("/usr/"));
  const hitList = top.controls.some((c) => /\/lbl\[\d+,\d+\]$/.test(c.id) || c.kind === "grid");
  if (hitList && !usrButton) return undefined;
  const choices = new Set(top.controls.filter((c) => c.kind === "checkbox" || c.kind === "radio").map((c) => c.text));
  // A popup titled like the main window ("Customer Create: Initial Screen" over XD01) carries the transaction's
  // name, not a question: its title then asks nothing.
  const own = top.title.trim() !== (windows.find((w) => w.number === 0)?.title ?? "").trim();
  const whole = [own ? top.title : "", ...top.controls.filter((c) => c.kind === "label" && !choices.has(c.text)).map((c) => c.text)].join(" ");
  // The title alone can ask ("Save Data"). Otherwise a question is text with answer buttons in the popup body
  // (Yes / No of POPUP_TO_CONFIRM): a popup whose only buttons sit in its toolbar is a dialog, and a checkbox
  // label such as MM03's "Create views selected" asks nothing.
  const asked = own && commitWord(top.title) ? top.title : usrButton && commitWord(whole) ? whole : undefined;
  if (!asked) return undefined;
  // "Cancel Customer / Data will be lost. Do you want to cancel processing?": "cancel" followed by a word
  // reads as "cancel a document" (a reversal), but a popup that says the input will be lost asks whether to
  // stop editing, and Yes discards. A real commit word in it (save, post) still makes it a commit question.
  if (commitWord(asked) === "cancel a document" && commitWord(whole) === "cancel a document" && discardsInput(whole)) return undefined;
  return asked;
}

/**
 * The topmost popup, when it asks whether to throw unsaved input away ("Data
 * will be lost. Do you want to cancel processing?") and nothing else: no
 * commit question (commitQuestion), answers in its body. Each answer either
 * discards the input or goes back to it; none writes.
 */
function discardQuestion(windows: ViewWindow[]): string | undefined {
  const top = topOf(windows);
  if (!top || top.number === 0 || commitQuestion(windows)) return undefined;
  if (!top.controls.some((c) => c.kind === "button" && c.id.includes("/usr/"))) return undefined;
  const whole = [top.title, ...top.controls.filter((c) => c.kind === "label").map((c) => c.text)].join(" ");
  return discardsInput(whole) ? whole : undefined;
}

/** Does this button of a popup decline what the popup asks? Cancel by its id, or No, Cancel, Back... by its text. */
function declines(control: ViewControl, text: string, ctx: AssessContext): boolean {
  const key = buttonKey(control.id);
  if (key === 12 || key === 3 || key === 15) return true;
  const sc = shortcutOf(text);
  if (sc === "F12" || sc === "ESCAPE" || sc === "F3" || sc === "SHIFT_F3") return true;
  const means = safeWord(ctx.language, text.replace(/\([^()]*\)\s*$/, ""));
  return means === "no" || means === "cancel" || means === "back" || means === "exit" || means === "help" || means === "display";
}

/**
 * A message popup: the window SAP shows an error, warning or information
 * message in ("Error", "Information": message lines, a Continue or Confirm
 * button on Enter, Help). It has no input field and no button in its body,
 * and its text holds no commit word. Its Enter button only acknowledges the
 * message, whatever it is called: "Confirm (Enter)" there confirms having
 * read it, not a document.
 */
function isMessagePopup(w: ViewWindow | undefined): boolean {
  if (!w || w.number === 0) return false;
  if (w.controls.some((c) => INPUT_KINDS.has(c.kind) || (c.kind === "button" && c.id.includes("/usr/")))) return false;
  const lines = w.controls.filter((c) => c.kind === "label").map((c) => c.text);
  return lines.length > 0 && !commitWord(w.title, ...lines);
}

/**
 * A value help (F4): Web GUI's search help page, with its restriction tab and
 * hit list. It only puts a value into a field of the screen behind it, so its
 * buttons (Copy the chosen entry, Find, Print the hit list) write nothing.
 */
function isValueHelp(w: ViewWindow | undefined): boolean {
  return !!w && w.number > 0 && w.controls.some((c) => /\/shell\/(gridRESULT|critcol)(\/|$)/.test(c.id));
}

/**
 * A report's selection screen: select-options (their buttons carry SAP's
 * generated ids `%_<name>_%_APP_%-...`), or screen 1000 with Execute (F8).
 * Its pushbuttons (multiple selection, select options, the report's own
 * SELECTION-SCREEN PUSHBUTTON) change the selection; they do at most what
 * Execute does, which is counted safe on purpose (core/words.ts SAFE_VKEYS)
 * unless the screen shows that the report updates (updateRun).
 */
function isSelectionScreen(scene: Scene): boolean {
  const main = scene.windows.find((w) => w.number === 0);
  if (!main) return false;
  if (main.controls.some((c) => /%_APP_%-/.test(c.id))) return true;
  return scene.dynpro === "1000" && main.controls.some((c) => c.id === "wnd[0]/tbar[1]/btn[8]");
}

/**
 * Why Execute (F8) on this selection screen may write, or undefined when it
 * is a selection screen like any list's. Execute is counted safe because
 * reports read; a report that updates the database shows it in one of two
 * ways, and then Execute is a write:
 * - a switch on the screen (runSwitch): "Test Run" not ticked, or "Update
 *   Run" chosen. With the test run ticked the report writes nothing;
 * - its title names what it does ("Deletion of Jobs", "Batch Input: Process
 *   All Sessions", "Close Period for Material Master Records") and not that
 *   it lists something. Read where the words are known (a covered language).
 *   Not read on a screen of a dialog program, whose title names an object,
 *   nor on a selection screen that asks how the report's list is to look
 *   ("Scope of List", a layout): that report ends in a list.
 * A report that updates without either sign is not caught: SAP_BLOCK_TCODES
 * is the tool for known update programs (README).
 */
function updateRun(scene: Scene, ctx: AssessContext): string | undefined {
  if (!isSelectionScreen(scene)) return undefined;
  const main = scene.windows.find((w) => w.number === 0);
  if (!main) return undefined;
  const switches = main.controls
    .filter((c) => c.kind === "checkbox" || c.kind === "radio")
    .map((c) => {
      const label = c.text.replace(/^\[[x ]\] ?/, "").replace(/ {2}\(read-only\)$/, "");
      const name = c.id.slice(c.id.lastIndexOf("/") + 1).replace(/^(chk|rad)/, "");
      return { label, on: c.text.startsWith("[x]"), is: runSwitch(name, label) };
    });
  const update = switches.find((x) => x.is === "update" && x.on);
  if (update) return `${quote(update.label)} is chosen on this selection screen, so the report updates SAP when it runs`;
  const tests = switches.filter((x) => x.is === "test");
  if (tests.length && !tests.some((x) => x.on)) return `this report can update SAP and ${quote(tests[0]?.label ?? "")} is not chosen: choose it to run the report without writing`;
  if (tests.some((x) => x.on)) return undefined;
  // The title of an executable report names the report. A screen of a dialog program (a module pool SAPM...,
  // a function group SAPL...) with an Execute button is titled after its object ("Update Requests: Initial
  // Screen"), which says nothing about what Execute does.
  if (/^SAP[ML]/i.test(scene.program)) return undefined;
  // A report that asks how its list is to look ends in a list.
  const asksForList = main.controls.some((c) => {
    if (!["field", "checkbox", "radio", "dropdown"].includes(c.kind) || !c.id.includes("/usr/")) return false;
    const name = c.id.slice(c.id.lastIndexOf("/") + 1).replace(/^(ctxt|txt|chk|rad|cmb)/, "").replace(/-(LOW|HIGH)$/, "");
    return listChoice(name, c.text.replace(/^\[[x ]\] ?/, "").replace(/ = ".*$/, ""));
  });
  if (asksForList) return undefined;
  if (languageCovered(ctx.language) && !listTitle(main.title)) {
    const does = commitWord(main.title) ?? actWord(main.title);
    if (does) return `the title of this selection screen, ${quote(main.title)}, names something the report does (${does}), not a list it shows`;
  }
  return undefined;
}

/**
 * A screen that only displays an object: the title of the main window says
 * so ("Display Standard Order 19121: Overview", "Material anzeigen"), and
 * its system toolbar, which the view shows, has no Save. SAP opens such a
 * screen without locking the object and offers no way to save, so a button
 * or menu entry of the transaction moves to another view of the object
 * (item conditions, schedule lines, a list of orders) or to another
 * transaction, where the guard judges again. Fields that take input there
 * are keys to search by (the initial screen). "Display <-> Change" leads to
 * a screen titled "Change", where this no longer holds.
 */
function isDisplayScreen(scene: Scene, ctx: AssessContext): boolean {
  const main = scene.windows.find((w) => w.number === 0);
  if (!main || !displayTitle(ctx.language, main.title)) return false;
  const buttons = main.controls.filter((c) => c.kind === "button");
  // The system toolbar must have been read: without it, a missing Save proves nothing.
  if (!buttons.some((c) => /^wnd\[0\]\/tbar\[0\]\/btn\[\d+\]$/.test(c.id))) return false;
  return !buttons.some((c) => {
    const key = buttonKey(c.id);
    const sc = shortcutOf(c.text);
    return (key !== undefined && SAVE_VKEYS.has(key)) || (sc !== undefined && SAVE_KEYS.has(sc));
  });
}

/** Is this menu entry in one of the transaction's own menus? The last two of the menu bar are SAP's System and Help, the same on every screen. */
function inOwnMenu(entry: MenuEntry, menus: MenuEntry[]): boolean {
  const n = Number(/^wnd\[0\]\/mbar\/menu\[(\d+)\]/.exec(entry.sid)?.[1] ?? Number.NaN);
  const tops = menus.map((m) => /^wnd\[0\]\/mbar\/menu\[(\d+)\]$/.exec(m.sid)?.[1]).filter((x): x is string => x !== undefined);
  if (Number.isNaN(n) || tops.length < 3) return false;
  return n < Math.max(...tops.map(Number)) - 1;
}

/** The top menu ("Goto") an entry sits in. */
function topMenuOf(entry: MenuEntry, menus: MenuEntry[]): MenuEntry | undefined {
  const top = /^wnd\[0\]\/mbar\/menu\[\d+\]/.exec(entry.sid)?.[0];
  return top ? menus.find((m) => m.sid === top) : undefined;
}

/**
 * Is this button the same function as an entry of the Goto menu? Matched by
 * its shortcut ("Org. Levels (F6)" and "Organizational Levels... (F6)") or by
 * its text ("Company Code Data (Ctrl+F2)" and "Company Code Data"). A popup's
 * button that repeats a button of the main window (same text, same key) is
 * that button again (MM03's Select View(s) popup repeats "Data (F7)").
 */
function inGotoMenu(control: ViewControl, text: string, scene: Scene, ctx: AssessContext): boolean {
  if (control.window > 0) {
    const twin = scene.windows.find((w) => w.number === 0)?.controls.find((c) => c.kind === "button" && c.text === text);
    return !!twin && inGotoMenu(twin, twin.text, scene, ctx);
  }
  const sc = shortcutOf(text);
  const want = bareText(text);
  const twins = scene.menus.filter((m) => /\/mbar\/menu\[\d+\]\/menu\[/.test(m.sid) && ((sc && m.key && keyName(m.key) === sc) || (want && bareText(m.text) === want)));
  return twins.length > 0 && twins.every((m) => isGotoMenu(ctx.language, topMenuOf(m, scene.menus)?.text));
}

/** A button, an open menu row, or a link or button of an HTML viewer: what pressing it may do. */
function assessFunction(what: string, text: string, control: ViewControl | undefined, scene: Scene, ctx: AssessContext): Assessment {
  const named = `${what} ${quote(text)}`;
  const key = control ? buttonKey(control.id) : undefined;
  // The Save button of the system toolbar, whatever the language.
  if (key !== undefined && SAVE_VKEYS.has(key)) return commit(`${named} is Save`);
  const sc = shortcutOf(text);
  if (sc && SAVE_KEYS.has(sc)) return commit(named);
  const code = control ? toolbarCode(control.id) : undefined;
  if (code && safeCode(code)) return NAVIGATE;
  if (code && commitCode(code)) return commit(`${named} {${code}}`);
  if (endsLogon(text)) return closes(named);
  const win = control ? windowOf(scene, control) : undefined;
  // The Enter button of a message popup acknowledges the message (isMessagePopup), also when it says "Confirm".
  if (control && key === 0 && isMessagePopup(win)) return navigate(`${named} acknowledges the message`);
  if (commitWord(text)) return commit(named);
  if (control && control.window > 0 && control.kind === "button") {
    const asked = commitQuestion(scene.windows);
    if (asked && !declines(control, text, ctx)) return endsLogon(asked) ? closes(`${named} on the popup ${quote(asked)}`) : commit(`${named} on the popup ${quote(asked)}`);
  }
  // Execute on the selection screen of a report that updates (updateRun).
  if (control && control.window === 0 && (key === 8 || sc === "F8")) {
    const writes = updateRun(scene, ctx);
    if (writes) return commit(`${named}: ${writes}`);
  }
  if (key !== undefined && SAFE_VKEYS.has(key)) return NAVIGATE;
  if (sc && SAFE_KEYS.has(sc)) return NAVIGATE;
  if (safeWord(ctx.language, text)) return NAVIGATE;
  // An answer to "Data will be lost..." (discardQuestion) discards the input or keeps it.
  if (control && control.window > 0 && control.kind === "button" && control.window === topOf(scene.windows)?.number && discardQuestion(scene.windows))
    return navigate(`${named} on a popup that asks whether to discard unsaved input`);
  // Where the button sits can say it writes nothing (each rule above its function). These rules lean on the
  // commit words to keep "Delete from personal list" or a "Post" pushbutton a commit, so they hold only where
  // the words are read (a covered logon language).
  const placed = languageCovered(ctx.language);
  if (placed && control && isValueHelp(win)) return navigate(`${named} of a value help`);
  if (placed && control && control.window === 0 && control.id.includes("/usr/") && isSelectionScreen(scene)) return navigate(`${named} of a selection screen`);
  if (control && inGotoMenu(control, text, scene, ctx)) return navigate(`${named} is in the Goto menu`);
  // A button of the transaction on a screen that only displays (isDisplayScreen): its own toolbar or the
  // screen body, not the toolbar of a grid or a tree. A function named as one that acts (print, issue
  // output, start, execute...) is still held back.
  if (control && control.window === 0 && control.kind === "button" && /^wnd\[0\]\/(tbar\[1\]|usr)\//.test(control.id) && !control.id.includes("/shell") && isDisplayScreen(scene, ctx) && !actWord(text))
    return navigate(`${named} on a screen that only displays`);
  return notSafe(named);
}

function assessMenu(entry: MenuEntry, menus: MenuEntry[], ctx: AssessContext, scene?: Scene): Assessment {
  // An entry with entries below it only opens its submenu.
  if (menus.some((m) => m.sid.startsWith(`${entry.sid}/`))) return NAVIGATE;
  const key = entry.key ? keyName(entry.key) : "";
  if (key && SAVE_KEYS.has(key)) return commit(`menu entry ${quote(entry.text)}`);
  if (endsLogon(entry.text)) return closes(`menu entry ${quote(entry.text)}`);
  if (commitWord(entry.text)) return commit(`menu entry ${quote(entry.text)}`);
  // Execute on the selection screen of a report that updates (updateRun).
  if (key === "F8" && scene) {
    const writes = updateRun(scene, ctx);
    if (writes) return commit(`menu entry ${quote(entry.text)}: ${writes}`);
  }
  if (key && SAFE_KEYS.has(key)) return NAVIGATE;
  if (safeWord(ctx.language, entry.text)) return NAVIGATE;
  // SAP's Goto menu moves between the screens of an object (isGotoMenu).
  if (isGotoMenu(ctx.language, topMenuOf(entry, menus)?.text)) return navigate(`menu entry ${quote(entry.text)} is in the Goto menu`);
  // An entry of the transaction's own menus on a screen that only displays (isDisplayScreen), unless it is
  // named as a function that acts (Issue Output To, Print...). System and Help are the same everywhere.
  // The menus above it count too: "Flag for deletion > Immediately" is named by its parent.
  const path = [entry.text, ...menus.filter((m) => entry.sid.startsWith(`${m.sid}/`)).map((m) => m.text)];
  if (scene && inOwnMenu(entry, menus) && isDisplayScreen(scene, ctx) && !actWord(...path) && !commitWord(...path)) return navigate(`menu entry ${quote(entry.text)} on a screen that only displays`);
  return notSafe(`menu entry ${quote(entry.text)}`);
}

/** Enter and Space press the control that has the focus: what would that do? Undefined when the focus is on nothing that can be pressed. */
function assessFocus(scene: Scene, ctx: AssessContext, what: string): Assessment | undefined {
  const { windows, menus } = scene;
  const f = ctx.focus;
  if (!f) return undefined;
  if (f.type === "html" || f.type === "browser") {
    if (!f.pressable) return undefined;
    const a = assessFunction(`${what} would press`, f.text ?? "", undefined, scene, ctx);
    return a.risk === "commit" ? a : undefined;
  }
  if (f.type === "GuiMenu") {
    const entry = menus.find((m) => m.sid === f.sid);
    if (!entry) return commit(`${what} would choose a menu entry the server could not read`);
    const a = assessMenu(entry, menus, ctx, scene);
    return a.risk === "commit" ? { ...a, reason: `${what} would choose the ${a.reason}` } : undefined;
  }
  if (!/Button$/.test(f.type) || f.type === "GuiRadioButton") return undefined;
  const control = f.sid ? findControl(windows, f.sid) : undefined;
  if (!control) return commit(`${what} would press the button that has the focus (${f.sid || "no id"}), which the view does not show`);
  const a = assessFunction(`${what} would press the button`, control.text, control, scene, ctx);
  return a.risk === "commit" ? a : undefined;
}

/**
 * The button of a popup that a key presses, as the reader presses it
 * (reader.ts `run`, "key"): for a key number N, or Enter (0), the popup's
 * toolbar button btn[N]. Enter on a popup without btn[0] whose answers sit
 * in its body (Yes / No / Cancel) presses no button here: it would be the
 * popup's default answer, and the agent must press the answer it means
 * (`asksDefault`, `questionRefusal`). `undefined` when the key does not go
 * to a button of the popup.
 */
export function popupButton(view: string, key: number | string, focusSid?: string): PopupKey | undefined {
  return popupButtonIn(parseView(view), key, focusSid);
}

export interface PopupKey {
  /** The toolbar button the key presses; absent for Enter on a question popup. */
  control?: ViewControl;
  window: ViewWindow;
  /** Enter on a popup whose answers sit in its body and that has no btn[0]: a question popup. */
  asksDefault: boolean;
  /** On a question popup: the answer SAP has put the focus on, which Enter would press. */
  focused?: ViewControl;
}

function popupButtonIn(windows: ViewWindow[], key: number | string, focusSid?: string): PopupKey | undefined {
  const top = topOf(windows);
  if (!top || top.number === 0) return undefined;
  let k: string;
  try {
    k = vkey(key);
  } catch {
    return undefined;
  }
  const n = typeof key === "number" ? key : k === "Enter" ? 0 : undefined;
  if (n === undefined) return undefined;
  const bar = top.controls.find((c) => c.kind === "button" && new RegExp(`^wnd\\[${top.number}\\]/tbar\\[[01]\\]/btn\\[${n}\\]$`).test(c.id));
  if (bar) return { control: bar, window: top, asksDefault: false };
  const answers = answersOf(top);
  if (n !== 0 || !answers.length) return undefined;
  const focused = focusSid ? findControl([top], focusSid) : undefined;
  return { ...(focused && answers.includes(focused) ? { focused } : {}), window: top, asksDefault: true };
}

/** The answers of a popup that sit in its body: Yes, No, Cancel. */
const answersOf = (w: ViewWindow): ViewControl[] => w.controls.filter((c) => c.kind === "button" && c.id.includes("/usr/"));

/**
 * What Enter on a question popup is answered with, in every write mode:
 * nothing is pressed, and the answers are listed by id. Enter presses the
 * popup's default answer; on "Do you want to save your data first?" that is
 * Yes, and an agent that meant "go on" has then saved. SAP putting the focus
 * on an answer does not make it the one the agent means.
 */
export function questionRefusal(hit: PopupKey): string {
  const label = (c: ViewControl) => `${c.id} "${c.text.replace(/\s+/g, " ").replace(/^ | $/g, "")}"`;
  const would = hit.focused ? `would press the answer SAP has put the focus on (${label(hit.focused)})` : "would press its default answer, and the server cannot tell which one that is";
  return `Enter on the popup "${hit.window.title}" ${would}. The popup asks a question, so nothing was pressed: press the answer you mean by its id: ${answersOf(hit.window).map(label).join(", ")}.`;
}

function assessKey(raw: unknown, scene: Scene, what: string, ctx: AssessContext): Assessment {
  const { windows, menus } = scene;
  let name: string;
  try {
    name = keyName(vkey(raw));
  } catch {
    return commit(`${what} is not a key the server knows`);
  }
  if (SAVE_KEYS.has(name)) return commit(`${what} is Save`);
  const top = Math.max(0, ...windows.map((w) => w.number));
  // On a popup a key is the button it presses (popupButton): judged, and named, as that button.
  if (top > 0 && (typeof raw === "number" || typeof raw === "string")) {
    const hit = popupButtonIn(windows, raw, ctx.focus?.sid);
    if (hit?.control) {
      const a = assessFunction(`${what} presses the button`, hit.control.text, hit.control, scene, ctx);
      return { ...a, reason: a.reason || `${what} presses the button ${quote(hit.control.text)}` };
    }
    if (hit?.focused) {
      // Enter on Yes / No with the focus on an answer would press that one. The reader refuses it all the
      // same (questionRefusal); the guard rates what it would do.
      const a = assessFunction(`${what} presses the button`, hit.focused.text, hit.focused, scene, ctx);
      return { ...a, reason: a.reason || `${what} presses the button ${quote(hit.focused.text)}` };
    }
    if (hit?.asksDefault) {
      // Enter on Yes / No without the focus on an answer: SAP would press the popup's default answer, which
      // the page does not tell. The reader refuses it and lists the answers; for the guard it may be any of them.
      const asked = commitQuestion(windows);
      if (asked) return (endsLogon(asked) ? closes : commit)(`${what} (Enter) would press the default answer of the popup ${quote(asked)}, which the server cannot tell`);
      return navigate(`${what} (Enter) would press the default answer of the popup, which the server cannot tell`);
    }
  }
  if (PRESS_KEYS.has(name)) {
    const pressed = assessFocus(scene, ctx, what);
    if (pressed) return pressed;
    // Space on a field types a blank, on a checkbox ticks it; with the focus unknown it cannot be ruled safe.
    if (name === "SPACE") return ctx.focus ? NAVIGATE : commit(`${what} presses whatever has the focus, and the server could not read the focus`);
  }
  // Enter on a popup presses its default button.
  if (name === "ENTER" && top > 0) {
    const asked = commitQuestion(windows);
    if (asked) return (endsLogon(asked) ? closes : commit)(`${what} (Enter) answers the popup ${quote(asked)}`);
  }
  // What the key does here: the button or the menu entry that carries it, by its shortcut or, on the main
  // window, by its id (btn[N] is bound to virtual key N).
  const n = typeof raw === "number" ? raw : undefined;
  const button = windows
    .filter((w) => w.number === top)
    .flatMap((w) => w.controls)
    .find((c) => c.kind === "button" && (shortcutOf(c.text) === name || (n !== undefined && /\/tbar\[[01]\]\//.test(c.id) && buttonKey(c.id) === n)));
  if (button) return assessFunction(`${what} is the button`, button.text, button, scene, ctx);
  const entry = top === 0 ? menus.find((m) => m.key && keyName(m.key) === name) : undefined;
  if (entry) {
    const a = assessMenu(entry, menus, ctx, scene);
    return a.risk === "commit" ? { ...a, reason: `${what} is the ${a.reason}` } : a;
  }
  // F8 without a button or menu entry the view shows is still Execute on a selection screen (updateRun).
  if (name === "F8" && top === 0) {
    const writes = updateRun(scene, ctx);
    if (writes) return commit(`${what}: ${writes}`);
  }
  if (SAFE_KEYS.has(name)) return NAVIGATE;
  return commit(`${what} has no button or menu entry on this screen, so what it does is unknown`);
}

function assessOkcode(value: string, view: string, scene: Scene, ctx: AssessContext): Assessment {
  const v = value.replace(/^\s+|\s+$/g, "");
  const how = `okcode ${v}`;
  const k = okcodeKind(v);
  switch (k.kind) {
    case "empty":
      return assessKey(0, scene, how, ctx);
    case "key":
      return assessKey(k.key, scene, how, ctx);
    case "transaction":
      // /nXXXX, /oXXXX, /*XXXX: unsaved input is dropped, nothing is written.
      return NAVIGATE;
    case "closes":
      return closes(`${how} ${CLOSES_SESSIONS}`);
    case "commit":
      return commit(`${how} (a function code that saves, posts or deletes)`);
    case "safe":
      return NAVIGATE;
    default:
      // On SAP Easy Access a plain word is a transaction code.
      if (!k.code.startsWith("/") && /^[A-Z0-9_.]+$/.test(k.code) && MENU_PROGRAMS.has(programOf(view).toUpperCase())) return NAVIGATE;
      return commit(`${how} (a command or function code that the server cannot classify)`);
  }
}

/**
 * The risk of one action on the screen `view` shows. `menus` are the entries
 * of the menu bar (text, shortcut, id); pass [] when they are not known.
 * `ctx` holds the logon language and the focused control; without a language
 * no text is trusted to be safe.
 */
export function assessAction(action: Action, view: string, menus: MenuEntry[], ctx: AssessContext = {}): Assessment {
  const windows = parseView(view);
  const scene: Scene = { windows, menus, program: programOf(view), dynpro: /  SCREEN (\S+)/.exec(view.split("\n", 1)[0] ?? "")?.[1] ?? "" };
  const id = String(action.id ?? "");
  switch (action.do) {
    case "okcode":
      return assessOkcode(String(action.value ?? ""), view, scene, ctx);
    case "key":
      return assessKey(action.key ?? action.value, scene, `key ${String(action.key ?? action.value)}`, ctx);
    case "tree":
    case "grid":
      return action.how === "expand" || action.how === "collapse" ? READ : NAVIGATE;
    case "toolbar": {
      const button = String(action.button ?? "");
      if (safeCode(button)) return NAVIGATE;
      if (commitCode(button)) return commit(`toolbar button ${button}`);
      const control = findControl(windows, `${id}/${button}`) ?? findControl(windows, button);
      return control ? assessFunction("toolbar button", control.text, control, scene, ctx) : notSafe(`toolbar button ${button}, which the view does not show,`);
    }
    case "press":
    case "select":
    case "click":
    case "dblclick":
    case "set":
    case "check":
    case "combo":
    case "f4":
    case "focus": {
      // A dropdown asked for its entries: nothing is chosen.
      if (action.do === "combo" && action.key === undefined && action.value === undefined) return READ;
      if (action.do === "dblclick" && (action.node !== undefined || action.row !== undefined)) return NAVIGATE;
      const acts = ["press", "select", "click", "dblclick"].includes(action.do);
      const full = menuSid(id);
      if (full) {
        if (!acts) return { risk: BASE_RISK[action.do] ?? "navigate", reason: "" };
        const entry = menus.find((m) => m.sid === full);
        if (!entry) return commit(`menu entry ${full} is not known, so what it does is unknown`);
        return assessMenu(entry, menus, ctx, scene);
      }
      const control = findControl(windows, id);
      if (!control) {
        // Typing, ticking and value help fail on their own when the control is not a field (reader.ts checks the control itself).
        if (!acts) return { risk: BASE_RISK[action.do] ?? "navigate", reason: "" };
        return commit(`${action.do} on ${quote(id)}, which is not on the screen the server read, so what it does is unknown`);
      }
      // Fields, tabs, radio buttons, labels and lists hold input or show something: they do not write.
      if (INERT_KINDS.has(control.kind)) return { risk: acts ? "navigate" : (BASE_RISK[action.do] ?? "navigate"), reason: "" };
      // Value help and focus on a button do nothing; typing into one is refused by the reader.
      if (action.do === "f4" || action.do === "focus") return READ;
      // Buttons, open menu rows, links and buttons of HTML viewers, and any kind this table does not know.
      if (control.kind === "menu") {
        const entry = menus.find((m) => m.sid === control.id);
        if (entry) return assessMenu(entry, menus, ctx, scene);
      }
      return assessFunction(FUNCTION_KINDS.has(control.kind) ? (control.kind === "menu" ? "menu entry" : control.kind) : control.kind, control.text, control, scene, ctx);
    }
    case "scroll":
      // Moves a list; nothing is chosen or changed.
      return READ;
    default:
      return commit(`action "${action.do}" is not one the Web GUI surface knows`);
  }
}
