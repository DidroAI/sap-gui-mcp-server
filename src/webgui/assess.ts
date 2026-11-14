/**
 * Classifies an action before it runs: read, navigate or commit (may write
 * to the database). It works from the full view of the screen (the reader's
 * text, the same format for Web GUI and SAP GUI) and from the menu entries
 * with their shortcuts, so the rules can be tested on text fixtures.
 *
 * The rules are the tables below. To cover a new case, add a word or a code
 * to a table; the logic underneath does not change.
 */
import type { Action, Assessment } from "../core/types.js";
import type { MenuEntry } from "./page.js";
import { vkey } from "./reader.js";

/**
 * Words that mean "this writes to SAP", matched as whole words (so "saved",
 * "unsaved" and "deleted" in a message do not match) against a button's text
 * and tooltip, a menu entry's text, and a popup's question.
 */
export const COMMIT_WORDS: { language: string; words: RegExp }[] = [
  {
    language: "en",
    words:
      /\b(save|post|book|park|hold|delete|remove|release|approve|reject|reverse|reversal|activate|deactivate|confirm|update|lock|unlock|change status|set status|status change|cancel(?:lation)? (?:document|order|invoice|billing|posting|delivery|item|goods|payment|confirmation|release))\b/i,
  },
  {
    language: "de",
    words: /(^|[^\p{L}])(sichern|speichern|buchen|vorerfassen|merken|löschen|entfernen|freigeben|genehmigen|ablehnen|stornieren|storno|aktivieren|deaktivieren|bestätigen|sperren|entsperren|status ändern)($|[^\p{L}])/iu,
  },
  {
    language: "fr",
    words: /(^|[^\p{L}])(sauvegarder|enregistrer|comptabiliser|préenregistrer|supprimer|libérer|approuver|refuser|annuler le document|extourner|contre-passer|activer|désactiver|confirmer|bloquer|débloquer|modifier le statut)($|[^\p{L}])/iu,
  },
];

/** Function codes that save, post or delete, as typed in the command field ("SAVE", "=BU") or carried by a toolbar button. */
export const COMMIT_CODES = new Set([
  "SAVE", "SICH", "BU", "BUCH", "POST", "BOOK", "UPD", "UPDA", "UPDATE", "DEL", "DELE", "DELETE", "DLT", "LOES", "LOE", "FREI", "RELE", "RELEASE", "STOR", "STORNO", "ACTIVATE", "&DELETE_ROW",
]);

/** Virtual keys that never write, whatever the screen: Enter, F1 help, F2 choose, F3 back, F4 value help, F12 cancel, Shift+F3 exit, find, paging. */
export const SAFE_KEYS = new Set(["ENTER", "F1", "F2", "F3", "F4", "ESCAPE", "F12", "SHIFT_F3", "CTRL_F", "CTRL_G", "CTRL_PAGEUP", "PAGEUP", "PAGEDOWN", "CTRL_PAGEDOWN"]);

/** Keys that save on every screen. */
export const SAVE_KEYS = new Set(["CTRL_S", "F11"]);

/** Answers that decline, on a popup that asks whether to save, post or delete. Any other button there commits. */
export const DECLINE = /^(no|cancel|back|exit|help|display|nein|abbrechen|zurück|hilfe|anzeigen|non|annuler|retour|aide|afficher)\b/i;

/** What each kind of action does when it cannot commit. */
const BASE_RISK: Record<string, "read" | "navigate"> = {
  f4: "read",
  focus: "read",
  set: "navigate",
  check: "navigate",
  combo: "navigate",
};

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

/** The control an id names, resolved as the reader's actions resolve it: full id, id tail, or a field's SAP name; the topmost window wins. */
export function findControl(windows: ViewWindow[], ident: string): ViewControl | undefined {
  const all = windows.flatMap((w) => w.controls);
  let want = ident.replace(/^ +| +$/g, "");
  let hits = all.filter((c) => c.id === want);
  if (!hits.length && want.startsWith("wnd[")) want = want.slice(want.lastIndexOf("/") + 1);
  if (!hits.length) hits = all.filter((c) => c.id.endsWith(`/${want}`));
  if (!hits.length) hits = all.filter((c) => c.id.slice(c.id.lastIndexOf("/") + 1).replace(/^[a-z]+/, "") === want);
  return hits.sort((a, b) => b.window - a.window)[0];
}

// ---- the rules ----------------------------------------------------------------

function commitWord(text: string): string | undefined {
  for (const { words } of COMMIT_WORDS) {
    const m = words.exec(text);
    if (m) return (m[2] ?? m[1] ?? m[0]).toLowerCase();
  }
  return undefined;
}

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

const quote = (s: string) => `"${s.replace(/\s+/g, " ").slice(0, 80)}"`;
const commit = (reason: string): Assessment => ({ risk: "commit", reason });
const NAVIGATE: Assessment = { risk: "navigate", reason: "" };
const READ: Assessment = { risk: "read", reason: "" };

/** The topmost popup, when it asks whether to save, post, delete...: its question, shortened. */
function commitQuestion(windows: ViewWindow[]): string | undefined {
  const top = windows.reduce<ViewWindow | undefined>((a, w) => (!a || w.number > a.number ? w : a), undefined);
  if (!top || top.number === 0) return undefined;
  const asked = [top.title, ...top.controls.filter((c) => c.kind === "label").map((c) => c.text)].join(" ");
  return commitWord(asked) ? asked : undefined;
}

function assessFunction(what: string, text: string, control: ViewControl | undefined, windows: ViewWindow[]): Assessment {
  // The Save button of the system toolbar, whatever the language.
  if (control && /\/tbar\[0\]\/btn\[11\]$/.test(control.id)) return commit(`${what} ${quote(text)} is Save`);
  const sc = shortcutOf(text);
  if (sc && SAVE_KEYS.has(sc)) return commit(`${what} ${quote(text)}`);
  if (commitWord(text)) return commit(`${what} ${quote(text)}`);
  if (control && control.window > 0) {
    const asked = commitQuestion(windows);
    if (asked && control.kind === "button" && !DECLINE.test(text)) return commit(`${what} ${quote(text)} on the popup ${quote(asked)}`);
  }
  return NAVIGATE;
}

function assessKey(raw: unknown, windows: ViewWindow[], menus: MenuEntry[], what: string): Assessment {
  let name: string;
  try {
    name = keyName(vkey(raw));
  } catch {
    return NAVIGATE; // not a key: the action fails on its own
  }
  if (SAVE_KEYS.has(name)) return commit(`${what} is Save`);
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
  if (button) return assessFunction(`${what} is the button`, button.text, button, windows);
  const entry = top === 0 ? menus.find((m) => m.key && keyName(m.key) === name) : undefined;
  if (entry) return commitWord(entry.text) ? commit(`${what} is the menu entry ${quote(entry.text)}`) : NAVIGATE;
  if (SAFE_KEYS.has(name)) return NAVIGATE;
  return commit(`${what} has no button or menu entry on this screen, so what it does is unknown`);
}

function assessOkcode(value: string, windows: ViewWindow[], menus: MenuEntry[]): Assessment {
  const v = value.replace(/^\s+|\s+$/g, "");
  const fkey = /^\/(\d+)$/.exec(v);
  if (fkey) return assessKey(Number(fkey[1]), windows, menus, `okcode ${v}`);
  // /n, /o, /i, /h, /nex ...: session commands; unsaved input is dropped, nothing is written.
  if (v.startsWith("/")) return NAVIGATE;
  const code = v.replace(/^=/, "").toUpperCase();
  if (COMMIT_CODES.has(code) || commitWord(code.toLowerCase())) return commit(`okcode ${v}`);
  return NAVIGATE;
}

/**
 * The risk of one action on the screen `view` shows. `menus` are the entries
 * of the menu bar (text, shortcut, id); pass [] when they are not known.
 */
export function assessAction(action: Action, view: string, menus: MenuEntry[]): Assessment {
  const windows = parseView(view);
  const id = String(action.id ?? "");
  switch (action.do) {
    case "okcode":
      return assessOkcode(String(action.value ?? ""), windows, menus);
    case "key":
      return assessKey(action.key ?? action.value, windows, menus, `key ${String(action.key ?? action.value)}`);
    case "tree":
    case "grid":
      return action.how === "expand" ? READ : NAVIGATE;
    case "toolbar": {
      const button = String(action.button ?? "");
      if (COMMIT_CODES.has(button.toUpperCase())) return commit(`toolbar button ${button}`);
      const control = findControl(windows, `${id}/${button}`) ?? findControl(windows, button);
      return control ? assessFunction("toolbar button", control.text, control, windows) : NAVIGATE;
    }
    case "press":
    case "select":
    case "click":
    case "dblclick": {
      if (action.do === "dblclick" && (action.node !== undefined || action.row !== undefined)) return NAVIGATE;
      if (/\/mbar\/menu\[/.test(id) || /^menu\[/.test(id)) {
        const full = id.startsWith("wnd[") ? id : `wnd[0]/mbar/${id}`;
        const entry = menus.find((m) => m.sid === full);
        if (!entry) return commit(`menu entry ${full} is not known, so what it does is unknown`);
        return commitWord(entry.text) || (entry.key && SAVE_KEYS.has(keyName(entry.key))) ? commit(`menu entry ${quote(entry.text)}`) : NAVIGATE;
      }
      const control = findControl(windows, id);
      if (!control) return NAVIGATE; // the action fails on its own: no such control
      // Buttons, open menu rows and the links and buttons of HTML viewers do something; tabs, radio buttons and labels do not write.
      if (!["button", "menu", "link"].includes(control.kind)) return NAVIGATE;
      return assessFunction(control.kind === "menu" ? "menu entry" : control.kind, control.text, control, windows);
    }
    default:
      return { risk: BASE_RISK[action.do] ?? "navigate", reason: "" };
  }
}
