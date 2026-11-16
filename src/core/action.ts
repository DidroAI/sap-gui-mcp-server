/**
 * One shape for an action, whatever the agent sent.
 *
 * The server normalises an action once, then gives the same object to the
 * guard, to the surface's `assess` and to its `act`. Before this, `assess`
 * and `act` each read the raw input their own way: `{"do":"key","value":11}`
 * was "no key" to one and Save to the other.
 *
 * After `normalizeAction`:
 * - `do` is one of `VERBS` (trimmed, lower case; `fill` and `double`, the
 *   older names, become `set` and `dblclick`);
 * - a `key` action has `key` only (never `value`): an integer 0–99 (an SAP
 *   virtual key), or a key name in one spelling ("Enter", "Shift+Tab",
 *   "Control+s");
 * - an `okcode` action has a trimmed string `value`;
 * - no string holds a carriage return or a line feed;
 * - `value` and `key` are a string, a number, a boolean or absent.
 * Anything else is refused with an ActionError.
 */
import { type Action, ActionError } from "./types.js";

/** Every `do` the server accepts. Each surface supports a subset and says so when it does not. */
export const VERBS = ["set", "press", "click", "key", "select", "check", "combo", "okcode", "f4", "focus", "dblclick", "tree", "grid", "toolbar", "scroll"] as const;
export type Verb = (typeof VERBS)[number];

/** Older names that are still accepted, and the verb they mean. */
export const VERB_ALIASES: Readonly<Record<string, Verb>> = { fill: "set", double: "dblclick" };

/** An action after `normalizeAction`. */
export interface NormalizedAction extends Action {
  do: Verb;
}

const MODIFIERS: Record<string, string> = { control: "Control", ctrl: "Control", alt: "Alt", shift: "Shift", meta: "Meta", cmd: "Meta", command: "Meta" };
const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Meta"];
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  space: "Space",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  back: "Back",
};

/**
 * Verbs that act on one control. Without an id a surface would act on
 * whatever control its lookup matches first: a press without id once opened
 * Web GUI's Menu button. So the id is required here, before the guard.
 */
const NEEDS_ID: ReadonlySet<Verb> = new Set(["set", "press", "click", "select", "check", "combo", "f4", "focus", "dblclick", "tree", "grid", "toolbar"]);

const KEY_HELP =
  'key needs "key": an SAP virtual key number from 0 to 99 (0 Enter, 3 Back, 4 F4, 8 F8, 11 Save, 12 Cancel), or a key name (Enter, Escape, Tab, Shift+Tab, F1 to F24, ArrowDown, PageDown, Home, End, Back, Control+S).';

/**
 * The key of a key action: an integer 0–99, or a key name in one spelling.
 * Undefined for anything else.
 */
export function normalizeKey(raw: unknown): number | string | undefined {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 && raw <= 99 ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(/\s+/g, "");
  if (/^\d{1,2}$/.test(s)) return Number(s);
  const parts = s.toLowerCase().split("+");
  const base = parts.pop() ?? "";
  const mods = new Set<string>();
  for (const p of parts) {
    const m = MODIFIERS[p];
    if (!m) return undefined;
    mods.add(m);
  }
  let key = NAMED_KEYS[base];
  if (!key) {
    const f = /^f(\d{1,2})$/.exec(base);
    if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) key = `F${Number(f[1])}`;
    // A letter or a digit is a key only with Control, Alt or Meta (Control+S): alone it would type text.
    else if (/^[a-z0-9]$/.test(base) && (mods.has("Control") || mods.has("Alt") || mods.has("Meta"))) key = base;
  }
  if (!key) return undefined;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** What `scroll` takes as "to", besides a row number. Fiori's own words (down, up, top, bottom) mean the same. */
const SCROLL_ALIASES: Readonly<Record<string, string>> = { down: "next", up: "prev", top: "first", bottom: "last", previous: "prev", start: "first", end: "last" };
const SCROLL_WORDS = new Set(["next", "prev", "first", "last", "right", "left", "rightmost", "leftmost", ...Object.keys(SCROLL_ALIASES)]);

const stripBreaks = (s: string) => s.replace(/[\r\n]+/g, "");
const scalar = (v: unknown) => v === undefined || v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * The action in its one shape, or an ActionError that says what is wrong.
 * The result is a new, frozen object: nothing downstream can change what was assessed.
 */
export function normalizeAction(input: unknown): NormalizedAction {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ActionError('An action is an object, e.g. {"do":"press","id":"btn[8]"}.');
  const raw = input as Record<string, unknown>;
  if (typeof raw.do !== "string") throw new ActionError(`An action needs "do": one of ${VERBS.join(", ")}.`);
  const named = raw.do.trim().toLowerCase();
  const verb = VERB_ALIASES[named] ?? (VERBS as readonly string[]).find((v) => v === named);
  if (!verb) throw new ActionError(`Unknown action "${stripBreaks(raw.do).slice(0, 40)}". Use one of: ${VERBS.join(", ")}.`);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "do" || v === undefined) continue;
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (typeof v === "string") out[k] = stripBreaks(v);
    else if (scalar(v)) out[k] = v;
    else throw new ActionError(`"${k}" must be a string, a number or a boolean.`);
  }
  for (const k of ["id", "node", "how", "col", "button"]) {
    if (out[k] === null) delete out[k];
    else if (out[k] !== undefined && typeof out[k] !== "string") {
      // A tree node key or a column may arrive as a number: SAP's are text.
      if (typeof out[k] === "number" && (k === "node" || k === "col" || k === "button")) out[k] = String(out[k]);
      else throw new ActionError(`"${k}" must be a string.`);
    }
  }
  if (NEEDS_ID.has(verb as Verb) && (typeof out.id !== "string" || !out.id.trim()))
    throw new ActionError(`${verb} needs "id": the id of a control from sap_look, e.g. {"do":"${verb}","id":"btn[8]"}.`);
  if (out.row !== undefined && out.row !== null && !(typeof out.row === "number" && Number.isInteger(out.row) && out.row >= 0))
    throw new ActionError('"row" must be a whole number, 0 or more.');

  if (verb === "scroll" && out.to !== undefined && out.to !== null) {
    // A row counted from 0, or a direction.
    const to = typeof out.to === "string" && /^\d+$/.test(out.to.trim()) ? Number(out.to.trim()) : typeof out.to === "string" ? out.to.trim().toLowerCase() : out.to;
    if (!(typeof to === "number" && Number.isInteger(to) && to >= 0) && !(typeof to === "string" && SCROLL_WORDS.has(to)))
      throw new ActionError('scroll "to" is a row number counted from 0, or "next", "prev", "first" or "last"; sideways (a table control\'s columns) "right", "left", "rightmost" or "leftmost".');
    out.to = SCROLL_ALIASES[String(to)] ?? to;
  }

  if (verb === "key") {
    const key = normalizeKey(out.key ?? out.value);
    if (key === undefined) throw new ActionError(KEY_HELP);
    out.key = key;
    delete out.value;
  }
  if (verb === "okcode") {
    if (typeof out.value !== "string" || !out.value.trim()) throw new ActionError('okcode needs "value", a string, e.g. {"do":"okcode","value":"/nVA03"}.');
    out.value = out.value.trim();
  }
  return Object.freeze({ ...out, do: verb }) as NormalizedAction;
}

/** A stable text of a normalised action, to compare two of them and to show the user. */
export function actionText(a: Action): string {
  const keys = Object.keys(a)
    .filter((k) => k !== "do" && a[k] !== undefined)
    .sort();
  return JSON.stringify({ do: a.do, ...Object.fromEntries(keys.map((k) => [k, a[k]])) });
}
