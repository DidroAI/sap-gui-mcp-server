/**
 * SAP virtual keys as Web GUI takes them, and what an action that sent
 * nothing to SAP says. Pure: no page, so the guard (assess.ts) and the
 * reader share it without importing each other.
 */
import { ActionError, type Action } from "../core/types.js";

/** SAP virtual keys (sendVKey) as keyboard keys in Web GUI. */
export function vkey(k: unknown): string {
  // "Back" is SAP's Back (F3), as on the other surfaces.
  if (typeof k === "string" && /^back$/i.test(k)) return "F3";
  // F12 is Cancel; Web GUI takes it as Escape (the browser keeps F12 for itself), as key 12 is sent.
  if (typeof k === "string" && /^f12$/i.test(k)) return "Escape";
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

/** Keys that only move in the page (the focus, the cursor, a checkbox): Web GUI sends SAP nothing for them. */
export const LOCAL_KEY = /^(Shift\+)?(Tab|Arrow(Up|Down|Left|Right)|Space|Home|End|Backspace|Delete|Insert)$/;

/**
 * What the answer says when an action sent no request with a step to SAP:
 * SAP did nothing, whatever the page shows. Undefined for actions that
 * never send one (typing, the focus, listing a dropdown's entries).
 */
export function nothingSent(a: Action): string | undefined {
  if (a.do === "set" || a.do === "focus" || a.do === "scroll" || (a.do === "combo" && a.key === undefined && a.value === undefined)) return undefined;
  if (a.do === "key") {
    const k = vkey(a.key ?? a.value);
    if (LOCAL_KEY.test(k)) return "(A key that moves in the page: nothing was sent to SAP.)";
    return "Nothing was sent to SAP: this key does nothing on this screen (or the browser kept it). The screen is as it was.";
  }
  // A box ticked, a radio button chosen or a table row selected: Web GUI keeps it in the page until the next step,
  // which is how SAP works (live 2026-11-21: MM02's "Select View(s)" row answered "Nothing was sent", then Enter went on).
  // So is an entry chosen in a dropdown that has no function code of its own (VA02's delivery block, live 2026-11-21).
  if (a.do === "check" || a.do === "combo" || (a.do === "select" && (a.row !== undefined || /(^|\/)rad[^/]*$/.test(String(a.id ?? "")))))
    return "(Set in the page: SAP gets it with the next Enter or key.)";
  return "Nothing was sent to SAP for this action: what changed (if anything) changed only in the page.";
}

/**
 * What an action that sent SAP nothing says once the page is read again:
 * the page changed (a value help closed and filled its field, live
 * 2026-11-23 on an F4 hit list), so the step is done there and SAP gets it
 * with the next Enter; or the page is as it was. "Nothing was sent to SAP"
 * after a pick that worked made a success sound like a failure.
 */
export function inPageOutcome(before: string, now: string): string | undefined {
  const body = (v: string) => v.split("\n").slice(1).join("\n");
  if (!before || !now || body(before) === body(now)) return undefined;
  const popups = (v: string) => (v.match(/^WINDOW wnd\[[1-9]\d*\]/gm) ?? []).length;
  return popups(now) < popups(before)
    ? "(Done in the page: the popup closed. SAP gets what it set with the next Enter or key.)"
    : "(Done in the page: SAP gets it with the next Enter or key.)";
}

/** "x", "true", "1", "on", "yes" turn a checkbox or a row selection on; no value at all does too. */
export const wantsOn = (value: unknown): boolean => value === undefined || /^(x|true|1|on|yes)$/i.test(String(value));
