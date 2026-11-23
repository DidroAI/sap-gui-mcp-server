/**
 * What changed between two views of the same screen.
 *
 * After an action the agent already holds the view it got last. When the
 * screen is still the same one (same header line, same windows) and little
 * changed, the answer is the changed lines instead of the whole view:
 *
 *   CHANGED 2 of 64 lines on VA02 · "Change Sales Order: Overview" (same screen; sap_look shows all of it):
 *   ~ ctxtVBAK-VBELN  field  Order = "4969"  (edit)
 *   + sbar  status  S: Consider the subsequent documents
 *   - lblX  label  gone
 *   = cntlGRID1/shell  grid  52 rows; columns: ...
 *   ~   row 3: 4972 | 21.01.1997
 *
 * `~` a line whose content changed (the new line), `+` a new line, `-` a
 * line that is gone, `=` an unchanged line shown for context: the control
 * whose rows follow. A line is a control (keyed by its id) or a row of the
 * control above it. A control whose rows changed for the most part is given
 * whole: `~` its line, then all its rows as they are now. Four or more fields
 * that only closed for input (or opened again) share one line.
 */

/** The id of a control line: everything before the first two spaces. */
const keyOf = (line: string): string => line.split("  ", 1)[0] ?? line;

interface Block {
  key: string;
  head: string;
  rows: string[];
}

function blocks(view: string): Block[] {
  const out: Block[] = [];
  const seen = new Map<string, number>();
  for (const line of view.split("\n")) {
    const last = out[out.length - 1];
    if (line.startsWith(" ") && last) {
      last.rows.push(line);
      continue;
    }
    const k = line.startsWith("WINDOW ") ? line : keyOf(line);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    out.push({ key: n ? `${k}#${n}` : k, head: line, rows: [] });
  }
  return out;
}

/** The key of a row inside its control: "row 3", a tree node's key, else the line itself. */
function rowKey(row: string): string {
  return /^ +(row \d+)[ :(]/.exec(row)?.[1] ?? /\{node ([^}]*)\}$/.exec(row)?.[0] ?? row;
}

/**
 * A control's line given only for context (`=`, its rows changed): the
 * agent has it from the view before, so a grid's or tree's column list is
 * left out; it can be long (100 columns), and it did not change.
 */
function contextHead(head: string): string {
  return / {2}(grid|tree) {2}/.test(head) ? head.replace(/; columns: .*$/, "; columns as before") : head;
}

/** The lines that say where the agent is: the header and the windows. */
function frame(view: string): string {
  return view
    .split("\n")
    .filter((l, i) => i === 0 || l.startsWith("WINDOW "))
    .join("\n");
}

/** The `WINDOW` lines of a view. */
const windows = (view: string): string[] => view.split("\n").filter((l) => l.startsWith("WINDOW "));

/** Is `over` the screen of `view` with popups above it: the same main window, and more windows? */
export function popupOver(over: string, view: string): boolean {
  const a = windows(over);
  const b = windows(view);
  return b.length > 0 && a.length > b.length && b.every((w, i) => a[i] === w);
}

/** Do the two views show the same screen: same transaction, program, screen number, and the same windows with the same titles? */
export function sameScreen(a: string, b: string): boolean {
  return frame(a) === frame(b);
}

interface Flip {
  /** Where the control's line is in the diff. */
  at: number;
  id: string;
}

const CURSOR = "  (cursor here)";

/**
 * Did this control only close for input ("closed") or open again ("opened")?
 * SAP closes every field of a screen while it shows a warning or an error,
 * and opens them when the message is answered: the value did not change.
 */
function inputFlip(before: string, after: string): "closed" | "opened" | undefined {
  const a = before.replace(CURSOR, "");
  const b = after.replace(CURSOR, "");
  if (a.includes("  (edit)") && a.replace("  (edit)", "  (read-only)") === b) return "closed";
  if (a.includes("  (read-only)") && a.replace("  (read-only)", "  (edit)") === b) return "opened";
  return undefined;
}

/** From this many fields on, fields that only closed or opened share one line of the diff. */
const FOLD_FROM = 4;

/**
 * Many fields that only closed for input (or opened again) become one line
 * that counts and names them, in place of the first: twenty lines that say
 * "read-only" hide the message that closed them.
 */
function foldFlips(out: string[], flips: Flip[], what: string): string[] {
  if (flips.length < FOLD_FROM) return out;
  const drop = new Set(flips.map((f) => f.at));
  const first = flips[0]?.at;
  const ids = flips.map((f) => f.id.replace(/#\d+$/, ""));
  const line = `~ ${flips.length} fields ${what}: ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", ..." : ""}`;
  // Indexes are kept (a second fold counts in the same lines): a folded line leaves GONE, removed at the end.
  return out.map((l, i) => (i === first ? line : drop.has(i) ? GONE : l));
}
const GONE = "\u0000";

export interface ViewDiff {
  /** The diff as text, with its header line. */
  text: string;
  /** Lines of the diff that are changes. */
  changed: number;
}

/**
 * The changes from `prev` to `next`. `since` goes into the header line, for a
 * view that is not the one just before ("since this screen was last shown").
 */
export function diffViews(prev: string, next: string, since = "", popupsClosed: string[] = []): ViewDiff {
  const total = next.split("\n").length;
  const at = whereLine(next);
  const on = at ? ` on ${at}` : " on the screen";
  // Popups that closed to lead back here are named: the next action lands on this screen, not on them.
  const names = popupsClosed.map((w) => windowName(w).replace(/^wnd\[\d+\] /, "")).join(", ");
  const back = names ? `, back from the popup ${names}` : since;
  const from = names ? "since before it; " : "";
  if (prev === next) return { text: `NO CHANGE${on}${back} (${from}${total} lines; sap_look shows it).`, changed: 0 };
  const before = new Map(blocks(prev).map((b) => [b.key, b]));
  const out: string[] = [];
  let changed = 0;
  const seen = new Set<string>();
  // Fields whose only change is that they closed for input, or opened again (see foldFlips).
  const closed: Flip[] = [];
  const opened: Flip[] = [];
  for (const b of blocks(next)) {
    seen.add(b.key);
    const old = before.get(b.key);
    if (!old) {
      out.push(`+ ${b.head}`, ...b.rows.map((r) => `+ ${r}`));
      changed += 1 + b.rows.length;
      continue;
    }
    const headChanged = old.head !== b.head;
    const rowsSame = old.rows.length === b.rows.length && old.rows.every((r, i) => r === b.rows[i]);
    if (!headChanged && rowsSame) continue;
    if (rowsSame) {
      const flip = inputFlip(old.head, b.head);
      if (flip) (flip === "closed" ? closed : opened).push({ at: out.length, id: b.key });
      out.push(`~ ${b.head}`);
      changed++;
      continue;
    }
    const oldRows = new Map(old.rows.map((r) => [rowKey(r), r]));
    const newKeys = new Set(b.rows.map(rowKey));
    const rowLines: string[] = [];
    let rowChanges = 0;
    let lastSame: string | undefined;
    for (const r of b.rows) {
      const was = oldRows.get(rowKey(r));
      if (was === r) {
        lastSame = r;
        continue;
      }
      // An unchanged row before new ones says where they are.
      if (was === undefined && lastSame !== undefined) rowLines.push(`= ${lastSame}`);
      lastSame = undefined;
      rowLines.push(`${was === undefined ? "+" : "~"} ${r}`);
      rowChanges++;
    }
    const gone = old.rows.filter((r) => !newKeys.has(rowKey(r)));
    rowChanges += gone.length;
    if (rowChanges * 2 > Math.max(b.rows.length, 1) + 1) {
      // Most rows changed (a scroll, a new list): the control as it is now.
      out.push(`~ ${b.head}`, ...b.rows.map((r) => `  ${r}`));
      changed += 1 + b.rows.length;
      continue;
    }
    out.push(headChanged ? `~ ${b.head}` : `= ${contextHead(b.head)}`, ...rowLines, ...gone.map((r) => `- ${r}`));
    changed += rowChanges + (headChanged ? 1 : 0);
  }
  for (const [k, b] of before)
    if (!seen.has(k)) {
      out.push(`- ${b.head}`);
      changed += 1 + b.rows.length;
    }
  const lines = foldFlips(foldFlips(out, closed, "closed for input (read-only now), values as before"), opened, "open for input again (edit), values as before").filter((l) => l !== GONE);
  return { text: [`CHANGED ${changed} of ${total} lines${on}${back} (${from}same screen; sap_look shows all of it):`, ...lines].join("\n"), changed };
}

/** A window's id and title from its `WINDOW` line: `wnd[1] "Detailed Display"`. */
export const windowName = (line: string): string => /^WINDOW (\S+) {2}(".*?")?/.exec(line)?.slice(1).filter(Boolean).join(" ") ?? line;

/**
 * Where the agent is, for the diff's first line: the transaction and the
 * window in front (a popup by its id, which its controls start with), as
 * `ZT01 · "Overview"` or `ZT01 · wnd[1] "Information"` (Astra's review,
 * 2026-11-23: a bare "NO CHANGE" after a popup closed did not say where the
 * next action lands). "" when the view names neither.
 */
export function whereLine(view: string): string {
  const tx = /^TRANSACTION (\S+)/.exec(view)?.[1];
  const front = windows(view).at(-1);
  const win = front ? windowName(front).replace(/^wnd\[0\] /, "") : "";
  return [...(tx ? [tx] : []), ...(win ? [win] : [])].join(" · ");
}
