/**
 * Button names as the agent reads them, and the shortcut a name carries.
 * Pure: the screen reader (screen.ts) cleans each button line with it, and
 * the guard (assess.ts) finds a button's key with it, so the two cannot
 * read the same line two ways.
 *
 * The page code (page.ts, extractLook) writes a button as its text, then its
 * tooltip in parentheses when the tooltip says more: `Back (F3)` on ECC,
 * where the tooltip starts with the text. Web GUI of S/4HANA 2025 differs
 * (live 2026-11-23, BP, ME2L, VA01):
 * - a tooltip with no text of its own, only the shortcut, comes out as
 *   `Company Code  ((Ctrl+F2))`: the parentheses of the tooltip around the
 *   parentheses of the shortcut. Read as "Company Code (Ctrl+F2)";
 * - the text of an emphasized button ends in the screen-reader word
 *   "Emphasized" (`Enter Emphasized ((Enter))`, `Save Emphasized ((Ctrl+S))`);
 * - a menu button's text is the screen-reader hint "Press Enter to trigger
 *   an action and Arrow Down to open the menu.", its name being the tooltip
 *   (`... menu.  (Set Filter...)`).
 */

/** Screen-reader words S/4HANA 2025 appends to an emphasized button's text. */
const EMPHASIZED = /\s+(?:Emphasized|Hervorgehoben)$/i;
/** Screen-reader hints that stand in for a button's text (a menu button). */
const HINTS = [/Press Enter to trigger an action and Arrow Down to open the menu\.?/gi];

/**
 * A shortcut as SAP writes it in a tooltip: "F3", "Shift+F5", "Ctrl+Shift+F1",
 * "Ctrl+S", "Escape", "Enter", "Strg+S", "Umsch+F8". A letter or digit alone
 * is no shortcut ("Type (A)"): it needs a modifier.
 */
const MOD = "(?:Ctrl|Control|Strg|Shift|Umsch|Umschalt|Alt)";
const KEY = `(?:(?:${MOD}\\s*\\+\\s*)*(?:F(?:[1-9]|1[0-9]|2[0-4])|Enter|Return|Escape|Esc|Page\\s?Up|Page\\s?Down|Bild\\s?auf|Bild\\s?ab|Tab|Space)|(?:${MOD}\\s*\\+\\s*)+[A-Z0-9])`;
const KEY_ONLY = new RegExp(`^${KEY}$`, "i");
const KEY_IN_PARENS = new RegExp(`\\(\\s*(${KEY})\\s*\\)`, "gi");

/** Notes the page code appends to a button line after its name: not part of the name. */
const NOTE = /^\((?:behind ">>"|greyed out\b.*)\)$/;

/**
 * The shortcut a button's name ends with, as written: "Back (F3)" -> "F3",
 * "Company Code  ((Ctrl+F2))" -> "Ctrl+F2", "PO History  (Purchase Order
 * History (F5))" -> "F5", "Save As Template  (Saves ... (Ctrl+F10))  (behind ">>")"
 * -> "Ctrl+F10". The last key in parentheses wins, notes of the reader left out.
 */
export function shortcutText(text: string): string | undefined {
  const parts = text.split("  ");
  while (parts.length > 1 && NOTE.test(parts[parts.length - 1] ?? "")) parts.pop();
  const name = parts.join("  ");
  let last: string | undefined;
  KEY_IN_PARENS.lastIndex = 0;
  for (let m = KEY_IN_PARENS.exec(name); m; m = KEY_IN_PARENS.exec(name)) last = m[1];
  KEY_IN_PARENS.lastIndex = 0;
  return last?.replace(/\s+/g, "");
}

/** A button's name without the screen-reader noise of S/4HANA 2025, and with an empty tooltip's shortcut folded in. */
function cleanName(name: string, tip: string | undefined): { name: string; tip: string | undefined } {
  let n = name;
  for (const h of HINTS) n = n.replace(h, " ");
  n = n.replace(/\s+/g, " ").trim();
  if (EMPHASIZED.test(n) && n.replace(EMPHASIZED, "")) n = n.replace(EMPHASIZED, "");
  let t = tip;
  // A hint was all the text: the tooltip is the name ("Set Filter...").
  if (!n && t) {
    n = t;
    t = undefined;
  }
  if (t !== undefined) {
    const inner = t.replace(EMPHASIZED, "");
    // "((Ctrl+F2))": a tooltip that is only the shortcut joins the name, as ECC shows it ("Back (F3)").
    const key = /^\((.*)\)$/.exec(inner)?.[1];
    if (key !== undefined && KEY_ONLY.test(key.trim())) return { name: `${n} (${key.trim()})`, tip: undefined };
    if (inner === n) return { name: n, tip: undefined };
    t = inner;
  }
  return { name: n, tip: t };
}

/**
 * One line of the view, with a button's name cleaned (see the head of this
 * file); every other line as it was. `btn[26]  button  Company Code  ((Ctrl+F2))`
 * -> `btn[26]  button  Company Code (Ctrl+F2)`.
 */
export function buttonLine(line: string): string {
  const m = /^(\S+ {2}button {2})(.*)$/.exec(line);
  if (!m) return line;
  const [, head = "", rest = ""] = m;
  const parts = rest.split("  ");
  const notes: string[] = [];
  while (parts.length > 1 && NOTE.test(parts[parts.length - 1] ?? "")) notes.unshift(parts.pop() ?? "");
  const [name = "", ...more] = parts;
  // The tooltip is the one part after the name, in parentheses; anything else is left alone.
  const tipPart = more.length === 1 && /^\(.*\)$/.test(more[0] ?? "") ? more[0] : undefined;
  if (more.length && tipPart === undefined) return line;
  const tip = tipPart?.slice(1, -1);
  const c = cleanName(name, tip);
  if (!c.name) return line;
  return `${head}${[c.name, ...(c.tip !== undefined ? [`(${c.tip})`] : []), ...notes].join("  ")}`;
}
