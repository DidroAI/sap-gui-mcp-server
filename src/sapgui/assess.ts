/**
 * Is an action a read, a navigation or a commit (a write to the database)?
 *
 * SAP GUI does not say what a button will do, so the rule fails closed: a
 * button, a menu entry, a function key or a function code is a commit unless
 * it is known to be safe. "Known safe" is one of:
 * - its id: a toolbar button `btn[N]` is bound to function key N, and Enter,
 *   F1 to F4, F12, Shift+F3, find and paging never write (SAFE_VKEYS);
 * - its function code (SAFE_CODES: Back, Exit, and the standard functions of
 *   ALV lists such as sort, filter, find, details);
 * - its text or tooltip, when the session's logon language is covered by the
 *   word table (SAFE_WORDS: Display, Find, Refresh, Next...).
 * A text that holds a commit word (COMMIT_WORDS: Save, Post, Delete...) is a
 * commit even when the rest of it is safe. A popup that asks whether to
 * save, post, delete... makes every answer but No and Cancel a commit.
 *
 * The tables are in core/words.ts, shared with the other surfaces.
 */
import { ActionError, type Action, type Assessment } from "../core/types.js";
import { CLOSES_SESSIONS, commitCode, commitWord, MENU_PROGRAMS, okcodeKind, SAFE_VKEYS, safeCode, safeWord, SAVE_VKEYS } from "../core/words.js";
import type { Control, Screen } from "./facts.js";
import { vkeyNumber } from "./keys.js";
import { allControls } from "./resolve.js";

export { commitCode, commitWord } from "../core/words.js";

/** Types that hold input or show something: acting on one changes unsaved input at most. */
const INERT_TYPES = new Set([
  "GuiTextField",
  "GuiCTextField",
  "GuiPasswordField",
  "GuiLabel",
  "GuiCheckBox",
  "GuiRadioButton",
  "GuiComboBox",
  "GuiTab",
  "GuiBox",
  "GuiTableControl",
  "GuiStatusbar",
  "GuiStatusPane",
  "GuiOkCodeField",
]);
const BUTTON_TYPES = new Set(["GuiButton"]);

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const shown = (c: Control) => [c.text, c.tip].map(clean).find(Boolean) ?? c.id;
const short = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);
const commit = (reason: string): Assessment => ({ risk: "commit", reason });
const notSafe = (what: string) => commit(`${what} is not known to be safe, so it is treated as a write`);

/** The function key a toolbar button is bound to, from its id: `wnd[0]/tbar[1]/btn[8]` -> 8. */
function buttonKey(id: string): number | undefined {
  const m = /^wnd\[\d+\]\/tbar\[\d+\]\/btn\[(\d+)\]$/.exec(id);
  return m ? Number(m[1]) : undefined;
}

/** The function key a button's tooltip names: "Cancel   (F12)" -> 12, "Save   (Ctrl+S)" -> 11. */
function tooltipKey(b: Control): number | undefined {
  const m = /\(([^()]+)\)\s*$/.exec(clean(b.tip) || clean(b.text));
  return m?.[1] ? vkeyNumber(m[1]) : undefined;
}

/** The question of the active popup, when it asks whether to save, post, delete... */
export function commitQuestion(screen: Screen): string | undefined {
  const w = screen.windows.find((x) => x.id === screen.activeWindow);
  if (!w || w.id === "wnd[0]") return undefined;
  // A value-help hit list (list lines or a grid, no button of its own) is not a question, whatever its entries say.
  const usrButton = w.controls.some((c) => c.type === "GuiButton" && c.id.includes("/usr/"));
  const hitList = w.controls.some((c) => /\/lbl\[\d+,\d+\]$/.test(c.id) || (c.type === "GuiShell" && c.sub === "GridView"));
  if (hitList && !usrButton) return undefined;
  // The title alone can ask ("Save Data"). Otherwise a question is text with answer buttons in the popup body
  // (Yes / No of POPUP_TO_CONFIRM): a popup whose only buttons sit in its toolbar is a dialog, and a checkbox
  // such as MM03's "Create views selected" asks nothing.
  if (commitWord(clean(w.title))) return clean(w.title);
  if (!usrButton) return undefined;
  const texts = w.controls.filter((c) => c.type !== "GuiButton" && c.type !== "GuiCheckBox" && c.type !== "GuiRadioButton" && c.id !== w.id).map((c) => clean(c.text));
  const question = [w.title, ...texts].filter(Boolean).join(" ").replace(/\s+/g, " ");
  return commitWord(question) ? question : undefined;
}

/** Does this button of a popup decline what the popup asks? Cancel by its key, or No, Cancel, Back... by its text. */
function declines(screen: Screen, b: Control): boolean {
  // Cancel, Back or Exit, by the button's id or by the key its tooltip names ("Cancel   (F12)").
  const key = buttonKey(b.id) ?? tooltipKey(b);
  if (key === 12 || key === 3 || key === 15) return true;
  const means = safeWord(screen.language, clean(b.text).replace(/\([^()]*\)\s*$/, ""), clean(b.tip).replace(/\([^()]*\)\s*$/, ""));
  return means === "no" || means === "cancel" || means === "back" || means === "exit" || means === "help" || means === "display";
}

function button(screen: Screen, windowId: string, n: number): Control | undefined {
  const w = screen.windows.find((x) => x.id === windowId);
  return w?.controls.find((c) => c.type === "GuiButton" && new RegExp(`^${windowId.replace(/[[\]]/g, "\\$&")}/tbar\\[[01]\\]/btn\\[${n}\\]$`).test(c.id));
}

function assessButton(screen: Screen, b: Control, how: string): Assessment {
  const named = `${how}"${shown(b)}"`;
  const key = buttonKey(b.id) ?? tooltipKey(b);
  if (key !== undefined && SAVE_VKEYS.has(key)) return commit(`${named} (Save)`);
  if (commitWord(b.text, b.tip)) return commit(named);
  const question = commitQuestion(screen);
  if (question && b.id.startsWith(`${screen.activeWindow}/`) && !declines(screen, b)) return commit(`"${shown(b)}" on the popup "${short(question)}"`);
  if (key !== undefined && SAFE_VKEYS.has(key)) return { risk: "navigate", reason: named };
  if (safeWord(screen.language, b.text, b.tip)) return { risk: "navigate", reason: named };
  return notSafe(named);
}

function assessMenu(screen: Screen, m: Control | undefined): Assessment {
  if (!m) return commit("a menu entry the server could not read");
  const named = `menu entry "${shown(m)}"`;
  // A top-level menu ("wnd[0]/mbar/menu[1]") only opens.
  if (/\/mbar\/menu\[\d+\]$/.test(m.id)) return { risk: "navigate", reason: named };
  if (commitWord(m.text, m.tip)) return commit(named);
  if (safeWord(screen.language, m.text, m.tip)) return { risk: "navigate", reason: named };
  return notSafe(named);
}

/** Pressing the control that has the focus (Enter does, on a button): what would that do? */
function assessFocus(screen: Screen, how: string): Assessment | undefined {
  if (!screen.focus) return undefined;
  const f = allControls(screen).find((c) => c.id === screen.focus);
  if (!f) return /\/mbar\//.test(screen.focus) ? commit(`${how} with the focus on a menu entry the server could not read`) : undefined;
  if (BUTTON_TYPES.has(f.type)) {
    const a = assessButton(screen, f, `${how} with the focus on the button `);
    return a.risk === "commit" ? a : undefined;
  }
  if (f.type === "GuiMenu") {
    const a = assessMenu(screen, f);
    return a.risk === "commit" ? commit(`${how} with the focus on the ${a.reason}`) : undefined;
  }
  return undefined;
}

function assessKey(screen: Screen, windowId: string, n: number, how: string): Assessment {
  if (SAVE_VKEYS.has(n)) return commit(`${how}: Save (Ctrl+S)`);
  if (n === 0) {
    const pressed = assessFocus(screen, how);
    if (pressed) return pressed;
  }
  const b = button(screen, windowId, n);
  if (b) {
    const a = assessButton(screen, b, `${how}: button `);
    if (a.risk === "commit") return a;
  }
  const question = n === 0 && windowId === screen.activeWindow ? commitQuestion(screen) : undefined;
  if (question) return commit(`Enter on the popup "${short(question)}"`);
  if (n === 4 || n === 1) return { risk: "read", reason: n === 4 ? "value help" : "help" };
  if (b || SAFE_VKEYS.has(n)) return { risk: "navigate", reason: how };
  return commit(`${how} has no button on this screen, so what it does is unknown`);
}

function assessOkcode(screen: Screen, value: unknown): Assessment {
  const v = String(value ?? "").trim();
  const how = `okcode ${v}`;
  const k = okcodeKind(v);
  switch (k.kind) {
    case "empty":
      return assessKey(screen, "wnd[0]", 0, how);
    case "key":
      return assessKey(screen, "wnd[0]", k.key, how);
    case "transaction":
      // /nXXXX, /oXXXX, /*XXXX start a transaction: unsaved input is dropped, nothing is written.
      return { risk: "navigate", reason: how };
    case "closes":
      return commit(`${how} ${CLOSES_SESSIONS}`);
    case "commit":
      return commit(`${how} (a function code that saves, posts or deletes)`);
    case "safe":
      return { risk: "navigate", reason: how };
    default:
      // On SAP Easy Access a plain word is a transaction code.
      if (!k.code.startsWith("/") && /^[A-Z0-9_]+$/.test(k.code) && MENU_PROGRAMS.has(screen.program.toUpperCase())) return { risk: "navigate", reason: how };
      return commit(`${how} (a command or function code that the server cannot classify)`);
  }
}

/**
 * @param target the control the action's id means (resolve.ts), when it has one and it was found.
 */
export function assess(screen: Screen, action: Action, target?: Control): Assessment {
  const active = screen.activeWindow ?? "wnd[0]";
  const menu = target?.type === "GuiMenu" || /\/mbar\/menu\[/.test(target?.id ?? action.id ?? "");
  switch (action.do) {
    case "focus":
      return { risk: "read", reason: "focus" };
    case "f4":
      return { risk: "read", reason: "value help" };
    case "combo":
      // A dropdown asked for its entries: nothing is chosen.
      if (action.key === undefined && action.value === undefined) return { risk: "read", reason: "lists a dropdown's entries" };
      return { risk: "navigate", reason: "changes input, not saved" };
    case "set":
    case "check":
      return { risk: "navigate", reason: "changes input, not saved" };
    case "okcode":
      return assessOkcode(screen, action.value);
    case "key": {
      const n = vkeyNumber(action.key ?? action.value);
      if (n === undefined) return commit(`key ${String(action.key ?? action.value)} is not a key SAP GUI has`);
      return assessKey(screen, active, n, `key ${n}`);
    }
    case "press":
    case "click":
    case "select":
    case "dblclick": {
      // A tree node or a grid cell: opening it navigates.
      if (action.do === "dblclick" && (action.node !== undefined || action.row !== undefined)) return { risk: "navigate", reason: "open a row" };
      if (menu) return assessMenu(screen, target);
      // Nothing to press: the driver could not find it either. Say so instead of "may write".
      if (!target) throw new ActionError(`No control "${action.id ?? ""}" on this screen. Use an id from sap_look (the screen may have changed).`);
      if (BUTTON_TYPES.has(target.type)) return assessButton(screen, target, "button ");
      if (INERT_TYPES.has(target.type)) return { risk: "navigate", reason: action.do };
      // A shell (grid, tree, HTML viewer): selecting it moves the focus. Anything else is not known.
      if (target.type === "GuiShell" && action.do !== "press" && action.do !== "click") return { risk: "navigate", reason: action.do };
      return notSafe(`${action.do} on ${target.type} "${shown(target)}"`);
    }
    case "toolbar": {
      const id = String(action.button ?? "");
      const b = target?.buttons?.find((x) => x.id === id);
      const label = b ? [b.text, b.tip].map((s) => s.trim()).find(Boolean) ?? id : id;
      if (safeCode(id)) return { risk: "navigate", reason: `toolbar button "${label}"` };
      if (commitWord(b?.text, b?.tip) || commitCode(id)) return commit(`toolbar button "${label}" {${id}}`);
      if (b && safeWord(screen.language, b.text, b.tip)) return { risk: "navigate", reason: `toolbar button "${label}"` };
      return notSafe(`toolbar button "${label}" {${id}}`);
    }
    case "tree":
      return action.how === "expand" || action.how === "collapse" ? { risk: "read", reason: `${action.how} a tree node` } : { risk: "navigate", reason: "tree node" };
    case "grid":
      return { risk: "navigate", reason: "grid cell" };
    case "scroll":
      // Moves a list; nothing is chosen or changed.
      return { risk: "read", reason: "scroll" };
    default:
      return commit(`action "${action.do}" is not one the SAP GUI surface knows`);
  }
}
