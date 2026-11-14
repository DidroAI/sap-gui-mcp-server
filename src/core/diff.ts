/**
 * What changed between two views of the same screen.
 *
 * After an action the agent already holds the view it got last. When the
 * screen is still the same one (same header line, same windows) and little
 * changed, the answer is the changed lines instead of the whole view:
 *
 *   CHANGED 2 of 64 lines (same screen; sap_look shows all of it):
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
 * whole: `~` its line, then all its rows as they are now.
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
export function diffViews(prev: string, next: string, since = ""): ViewDiff {
  const total = next.split("\n").length;
  if (prev === next) return { text: `NO CHANGE on the screen${since} (${total} lines; sap_look shows it).`, changed: 0 };
  const before = new Map(blocks(prev).map((b) => [b.key, b]));
  const out: string[] = [];
  let changed = 0;
  const seen = new Set<string>();
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
    out.push(`${headChanged ? "~" : "="} ${b.head}`, ...rowLines, ...gone.map((r) => `- ${r}`));
    changed += rowChanges + (headChanged ? 1 : 0);
  }
  for (const [k, b] of before)
    if (!seen.has(k)) {
      out.push(`- ${b.head}`);
      changed += 1 + b.rows.length;
    }
  return { text: [`CHANGED ${changed} of ${total} lines${since} (same screen; sap_look shows all of it):`, ...out].join("\n"), changed };
}
