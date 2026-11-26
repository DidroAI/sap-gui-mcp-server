/**
 * The views each session's agent was given last, and what to answer after an
 * action: the whole view, or only what changed.
 *
 * The whole view goes out on a new transaction, screen or window, and when
 * the changes are not much shorter than the view. A popup that opened and
 * closed leads back to the screen below it, which the agent saw before the
 * popup: the changes are then counted from that view, and the header says so.
 */
import { diffViews, isFioriView, popupOver, sameScreen } from "./diff.js";

export type ViewMode = "diff" | "full";

/** `SAP_VIEW=full` answers every action with the whole screen; the default answers with the changes when that is shorter. */
export function viewModeFromEnv(env: Record<string, string | undefined>): ViewMode {
  const v = (env.SAP_VIEW ?? "").trim().toLowerCase();
  if (v && v !== "diff" && v !== "full") throw new Error(`SAP_VIEW must be diff or full, not "${env.SAP_VIEW}"`);
  return v === "full" ? "full" : "diff";
}

/** Lines of a Fiori view that are no control of the page: kept when the page behind a popup is left out. */
const FIORI_KEEP = /^(FIORI|PAGE|DRAFT|TOAST|SCROLL|NOTE|PANEL|NUMBERS)\b/;

/**
 * A Fiori view with a popup open, for an action's answer: the popup whole, the page behind it as one line
 * (live 2026-11-23: a value help answer of 9.7 KB, a link's popover 4.4 KB, mostly the page behind them).
 * The view itself is unchanged when there is no popup or little behind it.
 */
export function fioriPopupFirst(view: string): string {
  if (!isFioriView(view)) return view;
  const lines = view.split("\n");
  if (!lines.some((l) => l.startsWith("POPUP "))) return view;
  const out: string[] = [];
  let behind = 0;
  let inPopup = false;
  let at = -1;
  for (const l of lines) {
    if (l.startsWith("POPUP ")) inPopup = true;
    else if (!l.startsWith(" ")) inPopup = false;
    if (inPopup || FIORI_KEEP.test(l)) {
      out.push(l);
      continue;
    }
    if (at < 0) at = out.length;
    behind++;
  }
  if (behind < 8 || at < 0) return view;
  out.splice(at, 0, `(the page behind the popup: ${behind} lines, not repeated here; close the popup to work on it, sap_look shows it)`);
  return out.join("\n");
}

/** A diff longer than this share of the view is not worth it: the whole view is clearer. */
const WORTH_IT = 0.6;
/** How many earlier views of a session are kept to diff against. */
const KEPT = 3;

export class Views {
  private bySession = new Map<string, string[]>();
  /** Per session: the long hints given on the screen it is on (`hintsOnce`). */
  private hints = new Map<string, { screen: string; seen: Set<string> }>();

  constructor(readonly mode: ViewMode = "diff") {}

  /** The agent was given this (compact) view of the session. */
  remember(session: string, view: string): void {
    const kept = (this.bySession.get(session) ?? []).filter((v) => !sameScreen(v, view));
    kept.push(view);
    this.bySession.set(session, kept.slice(-KEPT));
  }

  /** The view the agent got last, if any. */
  last(session: string): string | undefined {
    return this.bySession.get(session)?.at(-1);
  }

  forget(session: string): void {
    this.bySession.delete(session);
    this.hints.delete(session);
  }

  /**
   * What to answer with for `view`: the changes since the agent's last view
   * of this screen when that is clearly shorter, else the view. Either way
   * the view is remembered as given.
   */
  present(session: string, view: string, whole = false): string {
    // Said once per screen, in what the agent is given: a batch reads the screen several times, and a hint
    // used up by a read the agent never saw came out short the first time (live 2026-11-23).
    let memory = this.hints.get(session);
    if (!memory) this.hints.set(session, (memory = { screen: "", seen: new Set() }));
    view = hintsOnce(view, memory);
    const kept = this.bySession.get(session) ?? [];
    let answer = view;
    if (!whole && this.mode === "diff") {
      for (let i = kept.length - 1; i >= 0; i--) {
        const prev = kept[i] as string;
        if (!sameScreen(prev, view)) {
          // Popups that opened over this screen and closed again: the screen below never left.
          if (popupOver(prev, view)) continue;
          break;
        }
        // The popups that closed since: the top window of each view given after this screen.
        const closed = [...new Set(kept.slice(i + 1).map((v) => v.split("\n").filter((l) => l.startsWith("WINDOW ") || l.startsWith("POPUP ")).at(-1) ?? "").filter(Boolean))];
        // Columns said "as listed before" compare as the legend they stand for: else the diff printed the
        // whole old legend as removed (VA02, ME21N, FB50, live 2026-11-25) and came out longer than the view.
        const d = diffViews(prev, legendsOf(prev, view), "", closed);
        if (d.text.length <= view.length * WORTH_IT) answer = d.text;
        break;
      }
      if (answer === view) answer = fioriPopupFirst(view);
    }
    this.remember(session, view);
    return answer;
  }
}

/**
 * `view` with each "as listed before" of a table's or a grid's columns put
 * back as `prev` lists them (the same control's), for comparing the two.
 */
export function legendsOf(prev: string, view: string): string {
  if (!view.includes("as listed before")) return view;
  const id = (line: string) => line.split("  ")[0] ?? "";
  const head = /^\S+ {2}(?:table|grid) {2}/;
  // Each control's legend line and its inline columns, in the view before.
  const legends = new Map<string, string>();
  const inline = new Map<string, string>();
  let table = "";
  for (const line of prev.replace(/^[~+=-] /gm, "").split("\n")) {
    if (head.test(line)) {
      table = id(line);
      const cols = /; columns: (.+?)(?: {2}\(.*\))?$/.exec(line)?.[1];
      if (cols && cols !== "as listed before") inline.set(table, cols);
    }
    const legend = /^ +columns: (.+)$/.exec(line)?.[1];
    if (legend && legend !== "as listed before" && table) legends.set(table, legend);
  }
  table = "";
  return view
    .split("\n")
    .map((line) => {
      if (head.test(line)) {
        table = id(line);
        const cols = inline.get(table);
        return cols ? line.replace(/; columns: as listed before/, `; columns: ${cols}`) : line;
      }
      const legend = /^( +)columns: as listed before$/.exec(line);
      const was = legend && legends.get(table);
      return was ? `${legend[1]}columns: ${was}` : line;
    })
    .join("\n");
}

/**
 * The compact view with its long hints said once per visit to a screen: a
 * list's explanation of its row numbers (480 characters), and the columns
 * of a table or grid (700 characters), which a diff repeated with every
 * change of the line (live 2026-11-23). After the first time the list keeps
 * what changes (the cell id of row N, the columns of rows without braces);
 * a table's or grid's columns, while they are the same, are "as listed
 * before". Another screen, and the hints come again.
 */
export function hintsOnce(text: string, memory: { screen: string; seen: Set<string> }): string {
  const lines = text.split("\n");
  const head = /^TRANSACTION (\S*)\s+PROGRAM (\S*)\s+SCREEN (\S*)/.exec(lines[0] ?? "");
  if (!head) return text;
  const screen = head.slice(1).join("/");
  if (memory.screen !== screen) memory.seen.clear();
  memory.screen = screen;
  const first = (key: string) => {
    if (memory.seen.has(key)) return false;
    memory.seen.add(key);
    return true;
  };
  let table = "";
  return lines
    .map((line) => {
      if (/^\S+ {2}(?:table|grid) {2}/.test(line)) table = line.split("  ")[0] ?? "";
      // A table control's columns on a line of their own, under its line (ME21N: 700 characters).
      const legend = /^( +)columns: (.+)$/.exec(line);
      if (legend && (legend[2] ?? "").length > 120) {
        if (first(`columns ${table} ${legend[2]}`)) return line;
        return `${legend[1]}columns: as listed before`;
      }
      const list = /^(\S+ {2}list {2}.*?) {2}\(((?:rows numbered in the whole list|rows here are screen rows|cell ids: ).*)\)$/.exec(line);
      if (list) {
        if (first(`list ${list[1]?.split("  ")[0]}`)) return line;
        const hint = list[2] ?? "";
        const at = /row N is (\S+) now/.exec(hint)?.[1];
        const cells = /\b(?:cell ids: |as cell ids count them: )(\S+?\[col,row\])/.exec(hint)?.[1];
        const cols = /rows without braces have their cells in columns ([\d,]+)/.exec(hint)?.[1];
        const numbered = hint.startsWith("rows numbered") ? "rows numbered in the whole list" : hint.startsWith("rows here") ? "screen rows" : "";
        const parts = [numbered, at ? `row N is ${at}` : cells ? `cell ${cells}` : "", cols ? `cells in columns ${cols}` : ""].filter(Boolean);
        return `${list[1]}  (${parts.join("; ")}; as explained before)`;
      }
      const grid = /^(\S+ {2}(?:table|grid) {2}.*?; columns: )(.+?)( {2}\(.*\))?$/.exec(line);
      if (grid && (grid[2] ?? "").length > 120) {
        if (first(`columns ${line.split("  ")[0]} ${grid[2]}`)) return line;
        return `${grid[1]}as listed before${grid[3] ?? ""}`;
      }
      return line;
    })
    .join("\n");
}
