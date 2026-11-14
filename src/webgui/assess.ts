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
 * - its text, when the session's logon language is covered (core/words.ts).
 * A control the view does not show cannot be ruled safe either.
 *
 * The words and codes are tables in core/words.ts, shared with the other
 * surfaces. To cover a new case, add a word or a code there.
 */
import { resolveId } from "../core/ids.js";
import type { Action, Assessment } from "../core/types.js";
import { CLOSES_SESSIONS, commitCode, commitWord, MENU_PROGRAMS, okcodeKind, SAFE_VKEYS, safeCode, safeWord, SAVE_VKEYS } from "../core/words.js";
import type { MenuEntry } from "./page.js";
import { vkey } from "./reader.js";

/** Keys that never write, whatever the screen: the safe SAP function keys, and keys that only move the focus. */
export const SAFE_KEYS = new Set([
  "ENTER", "F1", "F2", "F3", "F4", "ESCAPE", "F12", "SHIFT_F3", "CTRL_F", "CTRL_G", "CTRL_PAGEUP", "PAGEUP", "PAGEDOWN", "CTRL_PAGEDOWN",
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
    if (!current || !line.startsWith("wnd[")) continue;
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
const notSafe = (what: string) => commit(`${what} is not known to be safe, so it is treated as a write`);

/** The topmost popup, when it asks whether to save, post, delete...: its question, shortened. */
function commitQuestion(windows: ViewWindow[]): string | undefined {
  const top = windows.reduce<ViewWindow | undefined>((a, w) => (!a || w.number > a.number ? w : a), undefined);
  if (!top || top.number === 0) return undefined;
  // A value-help hit list (list lines or a grid, no button of its own) is not a question, whatever its entries say.
  const usrButton = top.controls.some((c) => c.kind === "button" && c.id.includes("/usr/"));
  const hitList = top.controls.some((c) => /\/lbl\[\d+,\d+\]$/.test(c.id) || c.kind === "grid");
  if (hitList && !usrButton) return undefined;
  // The title alone can ask ("Save Data"). Otherwise a question is text with answer buttons in the popup body
  // (Yes / No of POPUP_TO_CONFIRM): a popup whose only buttons sit in its toolbar is a dialog, and a checkbox
  // label such as MM03's "Create views selected" asks nothing.
  if (commitWord(top.title)) return top.title;
  if (!usrButton) return undefined;
  const choices = new Set(top.controls.filter((c) => c.kind === "checkbox" || c.kind === "radio").map((c) => c.text));
  const asked = [top.title, ...top.controls.filter((c) => c.kind === "label" && !choices.has(c.text)).map((c) => c.text)].join(" ");
  return commitWord(asked) ? asked : undefined;
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

/** A button, an open menu row, or a link or button of an HTML viewer: what pressing it may do. */
function assessFunction(what: string, text: string, control: ViewControl | undefined, windows: ViewWindow[], ctx: AssessContext): Assessment {
  const named = `${what} ${quote(text)}`;
  const key = control ? buttonKey(control.id) : undefined;
  // The Save button of the system toolbar, whatever the language.
  if (key !== undefined && SAVE_VKEYS.has(key)) return commit(`${named} is Save`);
  const sc = shortcutOf(text);
  if (sc && SAVE_KEYS.has(sc)) return commit(named);
  const code = control ? toolbarCode(control.id) : undefined;
  if (code && safeCode(code)) return NAVIGATE;
  if (code && commitCode(code)) return commit(`${named} {${code}}`);
  if (commitWord(text)) return commit(named);
  if (control && control.window > 0 && control.kind === "button") {
    const asked = commitQuestion(windows);
    if (asked && !declines(control, text, ctx)) return commit(`${named} on the popup ${quote(asked)}`);
  }
  if (key !== undefined && SAFE_VKEYS.has(key)) return NAVIGATE;
  if (sc && SAFE_KEYS.has(sc)) return NAVIGATE;
  if (safeWord(ctx.language, text)) return NAVIGATE;
  return notSafe(named);
}

function assessMenu(entry: MenuEntry, menus: MenuEntry[], ctx: AssessContext): Assessment {
  // An entry with entries below it only opens its submenu.
  if (menus.some((m) => m.sid.startsWith(`${entry.sid}/`))) return NAVIGATE;
  const key = entry.key ? keyName(entry.key) : "";
  if (key && SAVE_KEYS.has(key)) return commit(`menu entry ${quote(entry.text)}`);
  if (commitWord(entry.text)) return commit(`menu entry ${quote(entry.text)}`);
  if (key && SAFE_KEYS.has(key)) return NAVIGATE;
  if (safeWord(ctx.language, entry.text)) return NAVIGATE;
  return notSafe(`menu entry ${quote(entry.text)}`);
}

/** Enter and Space press the control that has the focus: what would that do? Undefined when the focus is on nothing that can be pressed. */
function assessFocus(windows: ViewWindow[], menus: MenuEntry[], ctx: AssessContext, what: string): Assessment | undefined {
  const f = ctx.focus;
  if (!f) return undefined;
  if (f.type === "html" || f.type === "browser") {
    if (!f.pressable) return undefined;
    const a = assessFunction(`${what} would press`, f.text ?? "", undefined, windows, ctx);
    return a.risk === "commit" ? a : undefined;
  }
  if (f.type === "GuiMenu") {
    const entry = menus.find((m) => m.sid === f.sid);
    if (!entry) return commit(`${what} would choose a menu entry the server could not read`);
    const a = assessMenu(entry, menus, ctx);
    return a.risk === "commit" ? commit(`${what} would choose the ${a.reason}`) : undefined;
  }
  if (!/Button$/.test(f.type) || f.type === "GuiRadioButton") return undefined;
  const control = f.sid ? findControl(windows, f.sid) : undefined;
  if (!control) return commit(`${what} would press the button that has the focus (${f.sid || "no id"}), which the view does not show`);
  const a = assessFunction(`${what} would press the button`, control.text, control, windows, ctx);
  return a.risk === "commit" ? a : undefined;
}

function assessKey(raw: unknown, windows: ViewWindow[], menus: MenuEntry[], what: string, ctx: AssessContext): Assessment {
  let name: string;
  try {
    name = keyName(vkey(raw));
  } catch {
    return commit(`${what} is not a key the server knows`);
  }
  if (SAVE_KEYS.has(name)) return commit(`${what} is Save`);
  if (PRESS_KEYS.has(name)) {
    const pressed = assessFocus(windows, menus, ctx, what);
    if (pressed) return pressed;
    // Space on a field types a blank, on a checkbox ticks it; with the focus unknown it cannot be ruled safe.
    if (name === "SPACE") return ctx.focus ? NAVIGATE : commit(`${what} presses whatever has the focus, and the server could not read the focus`);
  }
  const top = Math.max(0, ...windows.map((w) => w.number));
  // Enter on a popup presses its default button.
  if (name === "ENTER" && top > 0) {
    const asked = commitQuestion(windows);
    if (asked) return commit(`${what} (Enter) answers the popup ${quote(asked)}`);
  }
  // What the key does here: the button or the menu entry that carries it.
  const button = windows
    .filter((w) => w.number === top)
    .flatMap((w) => w.controls)
    .find((c) => c.kind === "button" && shortcutOf(c.text) === name);
  if (button) return assessFunction(`${what} is the button`, button.text, button, windows, ctx);
  const entry = top === 0 ? menus.find((m) => m.key && keyName(m.key) === name) : undefined;
  if (entry) {
    const a = assessMenu(entry, menus, ctx);
    return a.risk === "commit" ? commit(`${what} is the ${a.reason}`) : a;
  }
  if (SAFE_KEYS.has(name)) return NAVIGATE;
  return commit(`${what} has no button or menu entry on this screen, so what it does is unknown`);
}

function assessOkcode(value: string, view: string, windows: ViewWindow[], menus: MenuEntry[], ctx: AssessContext): Assessment {
  const v = value.replace(/^\s+|\s+$/g, "");
  const how = `okcode ${v}`;
  const k = okcodeKind(v);
  switch (k.kind) {
    case "empty":
      return assessKey(0, windows, menus, how, ctx);
    case "key":
      return assessKey(k.key, windows, menus, how, ctx);
    case "transaction":
      // /nXXXX, /oXXXX, /*XXXX: unsaved input is dropped, nothing is written.
      return NAVIGATE;
    case "closes":
      return commit(`${how} ${CLOSES_SESSIONS}`);
    case "commit":
      return commit(`${how} (a function code that saves, posts or deletes)`);
    case "safe":
      return NAVIGATE;
    default:
      // On SAP Easy Access a plain word is a transaction code.
      if (!k.code.startsWith("/") && /^[A-Z0-9_]+$/.test(k.code) && MENU_PROGRAMS.has(programOf(view).toUpperCase())) return NAVIGATE;
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
  const id = String(action.id ?? "");
  switch (action.do) {
    case "okcode":
      return assessOkcode(String(action.value ?? ""), view, windows, menus, ctx);
    case "key":
      return assessKey(action.key ?? action.value, windows, menus, `key ${String(action.key ?? action.value)}`, ctx);
    case "tree":
    case "grid":
      return action.how === "expand" || action.how === "collapse" ? READ : NAVIGATE;
    case "toolbar": {
      const button = String(action.button ?? "");
      if (safeCode(button)) return NAVIGATE;
      if (commitCode(button)) return commit(`toolbar button ${button}`);
      const control = findControl(windows, `${id}/${button}`) ?? findControl(windows, button);
      return control ? assessFunction("toolbar button", control.text, control, windows, ctx) : notSafe(`toolbar button ${button}, which the view does not show,`);
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
      if (/\/mbar\/menu\[/.test(id) || /^menu\[/.test(id)) {
        if (!acts) return { risk: BASE_RISK[action.do] ?? "navigate", reason: "" };
        const full = id.startsWith("wnd[") ? id : `wnd[0]/mbar/${id}`;
        const entry = menus.find((m) => m.sid === full);
        if (!entry) return commit(`menu entry ${full} is not known, so what it does is unknown`);
        return assessMenu(entry, menus, ctx);
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
        if (entry) return assessMenu(entry, menus, ctx);
      }
      return assessFunction(FUNCTION_KINDS.has(control.kind) ? (control.kind === "menu" ? "menu entry" : control.kind) : control.kind, control.text, control, windows, ctx);
    }
    case "scroll":
      // Moves a list; nothing is chosen or changed.
      return READ;
    default:
      return commit(`action "${action.do}" is not one the Web GUI surface knows`);
  }
}
