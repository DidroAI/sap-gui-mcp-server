/**
 * What the full view says about the windows in front: which popup covers a
 * control, what its buttons are, and whether it is a termination message.
 * Pure (text in, text out), so the reader and the tests share it.
 */
import { shortIds } from "../core/ids.js";

export interface Popup {
  /** Its window number: 1 and up. */
  n: number;
  title: string;
  /** Its lines in the view, without the WINDOW line. */
  lines: string[];
}

/** The SAP window in front, when it is a popup (wnd[1] and up); undefined on the main window alone. */
export function topPopup(view: string): Popup | undefined {
  const lines = view.split("\n");
  let start = -1;
  let n = 0;
  let title = "";
  lines.forEach((l, i) => {
    const m = /^WINDOW wnd\[(\d+)\] {2}"(.*)"/.exec(l);
    if (m && Number(m[1]) >= n) {
      n = Number(m[1]);
      title = m[2] ?? "";
      start = i;
    }
  });
  if (n < 1) return undefined;
  const next = lines.findIndex((l, i) => i > start && l.startsWith("WINDOW "));
  return { n, title, lines: lines.slice(start + 1, next < 0 ? lines.length : next) };
}

/** The popup's buttons as an answer names them: `btnSPOP-OPTION1 "Yes", btn[12] "Cancel (Escape)"`. At most eight. */
export function popupButtons(view: string, p: Popup): string {
  const ids = view
    .split("\n")
    .filter((l) => l.startsWith("wnd["))
    .map((l) => l.split("  ", 1)[0] ?? "");
  const short = shortIds(ids);
  const buttons = p.lines
    .filter((l) => l.startsWith("wnd[") && l.split("  ")[1] === "button")
    .map((l) => {
      const [id = "", , ...rest] = l.split("  ");
      return `${short.get(id) ?? id} "${rest.join("  ").replace(/"/g, "'")}"`;
    });
  return buttons.slice(0, 8).join(", ") + (buttons.length > 8 ? ", ..." : "");
}

/** `wnd[1] "Exit Order Processing"`, with its buttons when it has some. */
export function popupName(view: string, p: Popup): string {
  const buttons = popupButtons(view, p);
  return `wnd[${p.n}] "${p.title}"${buttons ? ` (its buttons: ${buttons})` : ""}`;
}

/**
 * The window whose block of the view lists control `id`; -1 when the view
 * does not list it. Not the id's own prefix: a control of a popup can carry
 * an id of the main window (the Performance Assistant's buttons are
 * `wnd[0]/dialogshell/...` in window 1).
 */
export function windowListing(view: string, id: string): number {
  let w = -1;
  for (const l of view.split("\n")) {
    const m = /^WINDOW wnd\[(\d+)\]/.exec(l);
    if (m) w = Number(m[1]);
    else if (l.startsWith("WINDOW ")) w = -1;
    else if (l.startsWith(`${id}  `)) return w;
  }
  return -1;
}

/**
 * Why an action on control `id` cannot run while a popup is in front of its
 * window, or undefined: the control is in the popup, the view does not list
 * it, or no popup is open. The menu bar (`wnd[0]/mbar`) is the main window's.
 */
export function behindPopup(view: string, id: string, doing: string): string | undefined {
  const p = topPopup(view);
  if (!p) return undefined;
  const w = /^wnd\[0\]\/mbar(\/|$)/.test(id) ? 0 : windowListing(view, id);
  if (w < 0 || w >= p.n) return undefined;
  return `${id} is behind a popup, so "${doing}" was not done: ${popupName(view, p)} is open and SAP takes nothing in the window behind it. Answer the popup first.`;
}

/** What marks a termination message in the view (see page.ts, the message popup). */
export const TERMINATION_MARK = "(termination message:";

/** The text of the termination message the popup in front shows, or undefined. */
export function terminationIn(view: string): string | undefined {
  const p = topPopup(view);
  const line = p?.lines.find((l) => l.includes(TERMINATION_MARK));
  if (!line) return undefined;
  const text = line.split("  ").slice(2).join("  ");
  return text.slice(0, text.indexOf(TERMINATION_MARK)).replace(/^A: /, "").replace(/\s+$/, "");
}

/** The transaction of a view, from its header line. */
export const transactionOf = (view: string): string => /^TRANSACTION (\S*)/.exec(view)?.[1] ?? "";

/** The status bar's message when it is an error or a warning: its type and text. */
export function statusMessage(view: string): { type: "E" | "W"; text: string } | undefined {
  const m = /^(?:wnd\[0\]\/)?sbar {2}status {2}([EW]): (.*)$/m.exec(view);
  return m ? { type: m[1] as "E" | "W", text: m[2] ?? "" } : undefined;
}

/**
 * Why a field is closed for input while the status bar shows a warning or
 * an error: SAP closes every field of the screen (all but the wrong one, for
 * an error) until the message is answered. Undefined when the screen still
 * has several open fields: the field is then read-only by itself.
 */
export function closedByMessage(view: string): string | undefined {
  const s = statusMessage(view);
  if (!s) return undefined;
  const main = view.split(/\nWINDOW wnd\[[1-9]/)[0] ?? view;
  const open = main.split("\n").filter((l) => / {2}\(edit\)/.test(l)).length;
  if (open > 1) return undefined;
  return s.type === "W"
    ? `SAP shows the warning "${s.text}" and keeps the fields closed until it is answered: Enter ({"do":"key","key":0}) accepts the warning, then the fields open again.`
    : `SAP shows the error "${s.text}" and keeps every field closed but the one it is about (marked "cursor here"): correct that field, then Enter.`;
}
