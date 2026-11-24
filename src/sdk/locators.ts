/**
 * Locators: a control named by its id, read fresh from the screen each time
 * it is used. A locator holds no state of the screen, so it stays valid
 * across actions, and `expect` can poll it until a condition holds.
 */
import type { Action } from "../core/types.js";
import { type Control, locate, type ParsedScreen } from "../record/screen.js";
import type { Sap } from "./session.js";

/** What a control looks like now; `found` false when it is not on the screen. */
export interface ControlState {
  found: boolean;
  id: string;
  type?: string;
  label?: string;
  value?: string;
  editable?: boolean;
  /** The whole line of the full view, after the id and type. */
  rest?: string;
}

function stateOf(c: Control | undefined, id: string): ControlState {
  if (!c) return { found: false, id };
  // The full view ends a field's line with "(edit)" or "(read-only)"; other states follow in the same parentheses.
  const ro = /\(read-only\b|\(disabled\b|\bread-only\)/.test(c.rest);
  const ed = /\(edit\b/.test(c.rest);
  return { found: true, id: c.id, type: c.type, label: c.label, value: c.value, ...(ro || ed ? { editable: ed && !ro } : {}), rest: c.rest };
}

export class ControlLocator {
  readonly kind = "control";
  constructor(
    readonly sap: Sap,
    readonly id: string,
  ) {}

  toString(): string {
    return `control ${this.id}`;
  }

  /** The control on a parsed screen; the same lookup a replay uses (exact id, else the same field elsewhere). */
  on(screen: ParsedScreen): ControlState {
    return stateOf(locate(screen, this.id)?.control, this.id);
  }

  async state(): Promise<ControlState> {
    return this.on(await this.sap.screen());
  }

  /** The value: a field's text, "true"/"false" for a checkbox, a button's text. Throws when the control is not on the screen. */
  async value(): Promise<string> {
    const s = await this.state();
    if (!s.found) throw new Error(`${this} is not on the screen.`);
    return s.value ?? "";
  }

  async exists(): Promise<boolean> {
    return this.sap.asks(async () => (await this.state()).found);
  }

  async editable(): Promise<boolean> {
    return (await this.state()).editable === true;
  }

  set(value: string | number | boolean): Promise<string> {
    return this.sap.set(this.id, value);
  }
  press(): Promise<string> {
    return this.sap.press(this.id);
  }
  select(): Promise<string> {
    return this.sap.select(this.id);
  }
  check(value = true): Promise<string> {
    return this.sap.check(this.id, value);
  }
  f4(): Promise<string> {
    return this.sap.f4(this.id);
  }
}

/** A grid's rows as read: column ids and titles, and each row's cells. */
export interface GridState {
  found: boolean;
  id: string;
  /** Column ids (grid) or titles (table control). */
  columns: string[];
  titles: string[];
  /** Rows in all, when the control says. */
  total?: number;
  rows: { n: number; cells: string[]; text: string }[];
  text: string;
}

/**
 * Reads the compact text of one control (as `look({ id })` gives it) into rows and cells.
 * Two row formats: an ALV grid writes "row 0: 4700 | 01.02.2005 | 100.00" under a head
 * "columns: VBELN=Sales Doc. | ..."; a table control writes "row 0: Item=10; Material=M-01; Rej [x]"
 * under "  columns: 0 Item=txtVBAP-POSNR (read-only), 1 Material=ctxtRV45A-MABNR, ...".
 */
export function parseGrid(text: string, id: string): GridState {
  const lines = text.split("\n");
  const head = lines.find((l) => / {2}(grid|table|tree|list)\b/.test(l) && !l.startsWith(" ")) ?? "";
  if (!head) return { found: false, id, columns: [], titles: [], rows: [], text };
  const total = Number(/(?<!\d)(\d+) (?:rows|lines)\b|\brows (\d+)/.exec(head)?.slice(1).find((x) => x !== undefined) ?? Number.NaN);
  const rows: GridState["rows"] = [];
  let columns: string[] = [];
  let titles: string[] = [];
  const legend = lines.find((l) => l.startsWith("  columns: "));
  /** Table control: each column's number on screen (the legend skips hidden ones), for "Title [col N]" cells. */
  const numbers: number[] = [];
  if (legend) {
    // Table control: "0 Item=txtVBAP-POSNR (read-only)": the title, then the cell id without its type prefix.
    // The legend may end with "; 41 more to the right (scroll ...): ..." (columns scrolled out): not columns.
    // Cut where that starts: a regex running on to the end of the line is slow on a long one.
    const all = legend.slice("  columns: ".length);
    const more = all.search(/; \d+ more to the (?:left|right) \(/);
    const drawn = more < 0 ? all : all.slice(0, more);
    for (const c of drawn.split(/, (?=\d+ )/)) {
      const m = /^(\d+) (.*?)=(\S+)/.exec(c);
      numbers.push(Number(m?.[1] ?? Number.NaN));
      titles.push(m?.[2] ?? c);
      columns.push((m?.[3] ?? c).replace(/^[a-z]+/, ""));
    }
  } else {
    const at = head.indexOf("columns: ");
    const cols = at < 0 ? [] : head.slice(at + "columns: ".length).split(" | ").map((c) => c.trim());
    columns = cols.map((c) => c.split("=")[0] ?? c);
    titles = cols.map((c) => c.split("=").slice(1).join("=") || c);
  }
  for (const l of lines) {
    const m = /^ {2}row (\d+)(?: \([^)]*\))*: (.*)$/.exec(l);
    if (!m) continue;
    const body = m[2] ?? "";
    let cells: string[];
    if (legend) {
      // "Title=value" or "Title [x]" per cell, in column order; an empty cell is left out of the row.
      const named = new Map<string, string>();
      for (const part of body.split("; ")) {
        const eq = part.indexOf("=");
        const box = /^(.*) \[(x| )\]$/.exec(part);
        if (box) named.set(box[1] ?? "", box[2] === "x" ? "true" : "false");
        else if (eq >= 0) named.set(part.slice(0, eq), part.slice(eq + 1));
      }
      // Two columns with one title are written "Description [col 4]=...": matched by number.
      cells = titles.map((t, i) => named.get(`${t} [col ${numbers[i]}]`) ?? named.get(t) ?? "");
    } else cells = body.split(" | ").map((c) => c.trim());
    rows.push({ n: Number(m[1]), cells, text: body });
  }
  return { found: true, id, columns, titles, ...(Number.isNaN(total) ? {} : { total }), rows, text };
}

export class GridLocator {
  readonly kind = "grid";
  constructor(
    readonly sap: Sap,
    readonly id: string,
  ) {}

  toString(): string {
    return `grid ${this.id}`;
  }

  /** The rows on screen, or rows `from`..`to` (counted from 0; the control is scrolled there). */
  async state(range?: { from: number; to: number }): Promise<GridState> {
    const text = await this.sap.look({ id: this.id, ...(range ? { rows: range } : {}) }).catch((e: Error) => e.message);
    return parseGrid(text, this.id);
  }

  async rowCount(): Promise<number | undefined> {
    return (await this.state()).total;
  }

  /** One cell's text, by row (from 0) and column id or title. */
  async cell(row: number, col: string): Promise<string> {
    // A row already on screen is read as it is: asking for a range scrolls, a round trip of seconds on Web GUI.
    let g = await this.state();
    let r = g.rows.find((x) => x.n === row);
    if (!r) {
      g = await this.state({ from: row, to: row });
      r = g.rows.find((x) => x.n === row);
    }
    if (!r) throw new Error(`${this} has no row ${row}.`);
    const want = col.toLowerCase();
    let i = g.columns.findIndex((c) => c.toLowerCase() === want || c.toLowerCase() === want.replace(/^[a-z]+/, ""));
    if (i < 0) i = g.titles.findIndex((c) => c.toLowerCase() === want);
    if (i >= 0) return r.cells[i] ?? "";
    throw new Error(`${this} has no column "${col}" (columns: ${[...g.columns, ...g.titles].join(", ") || "none named"}).`);
  }

  private grid(how: string, row: number, col?: string, more: Partial<Action> = {}): Promise<string> {
    return this.sap.act({ ...more, do: "grid", id: this.id, row, ...(col ? { col } : {}), how });
  }
  /** Selects a row. */
  selectRow(row: number): Promise<string> {
    return this.sap.select(this.id, { row });
  }
  /** Double-clicks a cell (opens the document behind it on most reports). */
  double(row: number, col: string): Promise<string> {
    return this.grid("double", row, col);
  }
  /** Types into a cell of a grid that takes input. */
  setCell(row: number, col: string, value: string): Promise<string> {
    return this.sap.set(this.id, value, { row, col });
  }
  scroll(to: number | string): Promise<string> {
    return this.sap.scroll(this.id, to);
  }
}

export interface StatusState {
  /** S success, I information, W warning, E error, A abort; undefined when the view does not say. */
  type?: string;
  text: string;
}

export class StatusLocator {
  readonly kind = "status";
  constructor(readonly sap: Sap) {}

  toString(): string {
    return "status bar";
  }

  on(screen: ParsedScreen): StatusState {
    return { ...(screen.status?.type ? { type: screen.status.type } : {}), text: screen.status?.text ?? "" };
  }

  async state(): Promise<StatusState> {
    return this.on(await this.sap.screen());
  }

  async text(): Promise<string> {
    return (await this.state()).text;
  }

  async type(): Promise<string | undefined> {
    return (await this.state()).type;
  }
}

/** "Continue (Enter)" -> "Continue": a button's label without the key SAP shows after it. */
export const bareLabel = (label: string): string => label.trimEnd().replace(/\([^()]*\)$/, "").trim();

/**
 * The button a label names on a screen: in the window in front first (a
 * popup covers what is behind it), then anywhere. Within a window, the exact
 * label, then the label without its key ("Continue" for "Continue (Enter)"),
 * then either one in any case. Several buttons at the first rule that finds
 * any: `several`, never a guess.
 */
export function findButton(screen: ParsedScreen, label: string): { control?: Control; several?: Control[] } {
  const want = label.trim();
  const low = want.toLowerCase();
  const buttons = screen.controls.filter((c) => c.type === "button");
  const top = screen.windows.filter((w) => /^wnd\[\d+\]$/.test(w.id)).at(-1)?.id;
  const rules: ((c: Control) => boolean)[] = [
    (c) => c.label.trim() === want,
    (c) => bareLabel(c.label) === want,
    (c) => c.label.trim().toLowerCase() === low || bareLabel(c.label).toLowerCase() === low,
  ];
  for (const pool of [buttons.filter((c) => c.window === top), buttons])
    for (const rule of rules) {
      const hits = pool.filter(rule);
      if (hits.length === 1) return { control: hits[0] as Control };
      if (hits.length > 1) return { several: hits };
    }
  return {};
}

/**
 * A button named by its label: what code presses when the id is only a
 * number in a toolbar (`wnd[0]/tbar[1]/btn[0]`), which another screen or a
 * popup gives to another button. Found fresh each time it is used.
 */
export class ButtonLocator {
  readonly kind = "button";
  constructor(
    readonly sap: Sap,
    readonly label: string,
  ) {}

  toString(): string {
    return `button "${this.label}"`;
  }

  /** The button on this screen; throws when no button or several have this label. */
  find(screen: ParsedScreen): Control {
    const r = findButton(screen, this.label);
    if (r.several) throw new Error(`${this} names ${r.several.length} buttons on this screen (${r.several.map((c) => `${c.id} "${c.label}"`).join(", ")}): use sap.press with one of these ids.`);
    if (!r.control) {
      const labels = screen.controls.filter((c) => c.type === "button" && c.label).map((c) => `"${c.label}"`);
      throw new Error(`${this} is not on the screen${labels.length ? ` (buttons: ${labels.slice(0, 15).join(", ")})` : ""}.`);
    }
    return r.control;
  }

  async exists(): Promise<boolean> {
    return this.sap.asks(async () => !!findButton(await this.sap.screen(), this.label).control);
  }

  /** Presses it, through the guard like any action. */
  async press(): Promise<string> {
    const c = this.find(await this.sap.screen());
    // On the DIAG method a toolbar button is its key (record/replay.ts pressOf).
    return this.sap.act(c.vkey !== undefined && !c.id.startsWith("wnd[") ? { do: "key", key: c.vkey } : { do: "press", id: c.id });
  }
}
