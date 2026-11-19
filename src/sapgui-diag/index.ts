/**
 * SAP GUI for Windows without SAP GUI scripting: the DIAG method
 * (SAP_GUI_METHOD=diag).
 *
 * SAP GUI connects through a SAProuter on this machine (router.ts): the user
 * puts `/H/127.0.0.1/S/3298` in front of the connection entry's router string.
 * The router passes the traffic on and keeps a copy; src/diag decodes it into
 * the screen SAP sent, with SAP's field names, every row of tables and grids,
 * tree nodes and lists. Nothing is loaded into SAP GUI and scripting may be
 * off. It cannot read a connection encrypted with SNC.
 *
 * Acting is keyboard and mouse (ps/input-lib.ps1): the command field, function
 * keys, and clicks at the cell SAP gave each element, mapped to pixels on the
 * window's screen area. A typed value reaches SAP, and so this reader, at the
 * next Enter or function key.
 *
 * Ids in actions: a SAP field name ("VBAK-VBELN"), a function code in braces
 * ("{HEAD}", a button or tab), a table cell "FIELD[n]" (n = the table's own
 * row number, as the view prints it; a row not on show is scrolled to), or a
 * position "@row,col" (a list line, anything else). Grids and trees by their
 * container (or "shell N", "value-help"), table controls by name, "list".
 * The actions are planned in plan.ts and wait for SAP's answer in the
 * traffic (traffic.ts); pixels and windows are in geometry.ts.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { ActionError, type Action, type Assessment, type DoctorCheck, type Driver, type LookOptions, type SessionInfo, type Surface } from "../core/types.js";
import { CLOSES_SESSIONS, commitCode, commitWord, isLogonScreen, LOGON_REFUSAL, MENU_PROGRAMS, okcodeKind, SAFE_VKEYS, safeCode, safeWord, SAVE_VKEYS } from "../core/words.js";
import { type DiagControl, DiagDecoder, type DiagElement, type DiagKey, type DiagScreen, type DiagWindow, diagView } from "../diag/index.js";
import { HostError, MAX_TIMEOUT_MS, powershellExe, PsHost, READ_TIMEOUT_MS } from "../sapgui/host.js";
import type { Transport } from "../sapgui/facts.js";
import { vkeyNumber } from "../sapgui/keys.js";
import { type Cells, cellMetrics, cellsFromEnv, type HostWindow, pickWindow, type Rect } from "./geometry.js";
import { type Geometry, type Named, namedControl, type Plan, planCombo, planGrid, planGridScroll, planPage, planPlain, planTableRow, planToolbar, planTree, position, scrollables, scrollTarget, type Step, type TreeChange } from "./plan.js";
import { type Hop, startRouter } from "./router.js";
import { lookControl } from "./rows.js";
import { MAYBE_REQUEST_MS, Traffic, type WaitOptions, waitNote, waitOptions } from "./traffic.js";
import { fileURLToPath } from "node:url";

export { cellPoint } from "./geometry.js";

const PREFIX = "sapgui:diag:";
export const INPUT_SCRIPT = fileURLToPath(new URL("./ps/input-host.ps1", import.meta.url));

interface Connection {
  n: number;
  target: Hop;
  decoder: DiagDecoder;
  open: boolean;
  /** Requests and answers of the connection, for the waits (traffic.ts). */
  traffic: Traffic;
}

interface WindowFacts {
  hwnd: number;
  kind: "session" | "popup";
  title: string;
  area?: [number, number, number, number] | null;
  controls?: { cls: string; rect: [number, number, number, number] }[];
  foreground?: boolean;
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const commit = (reason: string): Assessment => ({ risk: "commit", reason });

/** The window actions go to: the topmost modal one, else the main window. */
function active(s: DiagScreen): DiagWindow {
  return s.windows[s.windows.length - 1] as DiagWindow;
}

/** The popup's question, when it asks whether to save, post, delete... */
function commitQuestion(s: DiagScreen): string | undefined {
  const w = active(s);
  if (!w.modal) return undefined;
  if (commitWord(w.title)) return w.title;
  const buttons = w.elements.some((e) => e.kind === "button");
  if (!buttons || w.list) return undefined;
  const text = [w.title, ...w.elements.filter((e) => e.kind !== "button" && e.kind !== "checkbox" && e.kind !== "radio").map((e) => e.text)].join(" ");
  return commitWord(text) ? clean(text) : undefined;
}

function keyOf(w: DiagWindow, n: number): DiagKey | undefined {
  return [...w.toolbar, ...w.keys].find((k) => k.vkey === n);
}

export function assessDiag(s: DiagScreen, action: Action, target?: Target): Assessment {
  const w = active(s);
  const lang = s.session.language;
  const assessKey = (n: number, how: string): Assessment => {
    if (SAVE_VKEYS.has(n)) return commit(`${how}: Save (Ctrl+S)`);
    const k = keyOf(w, n);
    const named = k ? `${how} "${clean(k.text)}"` : how;
    if (k && (commitWord(k.text, k.tooltip) || commitCode(k.fcode))) return commit(named);
    const q = n === 0 || (k && !/^(no|cancel|back|exit)$/.test(safeWord(lang, k.text) ?? "")) ? commitQuestion(s) : undefined;
    if (q && n !== 12 && n !== 3 && n !== 15) return commit(`${named} on the popup "${q.slice(0, 90)}"`);
    if (n === 4 || n === 1) return { risk: "read", reason: n === 4 ? "value help" : "help" };
    if (SAFE_VKEYS.has(n) || (k && (safeCode(k.fcode) || safeWord(lang, k.text, k.tooltip)))) return { risk: "navigate", reason: named };
    return commit(`${named} is not known to be safe, so it is treated as a write`);
  };
  const assessButton = (e: DiagElement, how: string): Assessment => {
    const named = `${how}"${clean(e.text || e.tooltip) || e.fcode || e.name}"`;
    if (commitWord(e.text, e.tooltip) || commitCode(e.fcode)) return commit(named);
    const q = commitQuestion(s);
    const means = safeWord(lang, e.text, e.tooltip);
    if (q && !["no", "cancel", "back", "exit", "help", "display"].includes(means ?? "")) return commit(`${named} on the popup "${q.slice(0, 90)}"`);
    if (safeCode(e.fcode) || means) return { risk: "navigate", reason: named };
    return commit(`${named} is not known to be safe, so it is treated as a write`);
  };
  switch (action.do) {
    case "focus":
    case "f4":
      return { risk: "read", reason: action.do === "f4" ? "value help" : "focus" };
    case "set":
    case "check":
      return { risk: "navigate", reason: "changes input, not saved" };
    case "okcode": {
      const v = String(action.value ?? "").trim();
      const how = `okcode ${v}`;
      const k = okcodeKind(v);
      switch (k.kind) {
        case "empty":
          return assessKey(0, how);
        case "key":
          return assessKey(k.key, how);
        case "transaction":
        case "safe":
          return { risk: "navigate", reason: how };
        case "closes":
          // Ending the logon: the guard refuses it on its own rule (SAP_ALLOW_LOGOFF).
          return { risk: "commit", reason: `${how} ${CLOSES_SESSIONS}`, closes: true };
        case "commit":
          return commit(`${how} (a function code that saves, posts or deletes)`);
        default:
          if (!k.code.startsWith("/") && /^[A-Z0-9_]+$/.test(k.code) && MENU_PROGRAMS.has(w.program.toUpperCase())) return { risk: "navigate", reason: how };
          return commit(`${how} (a command or function code that the server cannot classify)`);
      }
    }
    case "key": {
      const n = vkeyNumber(action.key ?? action.value);
      if (n === undefined) return commit(`key ${String(action.key ?? action.value)} is not a key SAP GUI has`);
      return assessKey(n, `key ${n}`);
    }
    case "combo":
      // A dropdown asked for its entries: nothing is chosen.
      if (action.key === undefined && action.value === undefined) return { risk: "read", reason: "lists a dropdown's entries" };
      return { risk: "navigate", reason: "changes input, not saved" };
    case "scroll":
      return { risk: "read", reason: "scroll" };
    case "tree":
      return action.how === "expand" || action.how === "collapse" ? { risk: "read", reason: `${action.how} a tree node` } : { risk: "navigate", reason: "tree node" };
    case "grid":
      return { risk: "navigate", reason: "grid cell" };
    case "toolbar": {
      const b = clean(String(action.button ?? ""));
      const k = [...w.toolbar, ...w.keys].find((x) => x.enabled && (clean(x.fcode).toLowerCase() === b.toLowerCase() || clean(x.text).toLowerCase() === b.toLowerCase() || clean(x.tooltip).toLowerCase() === b.toLowerCase()));
      if (k) return assessKey(k.vkey, `toolbar button "${clean(k.text || k.tooltip) || k.fcode}"`);
      if (safeCode(b)) return { risk: "navigate", reason: `toolbar button ${b}` };
      if (commitWord(b) || commitCode(b)) return commit(`toolbar button "${b}"`);
      if (safeWord(lang, b)) return { risk: "navigate", reason: `toolbar button "${b}"` };
      return commit(`toolbar button "${b}" is not known to be safe, so it is treated as a write`);
    }
    case "press":
    case "click":
    case "dblclick":
    case "select": {
      // A row of a table control or a grid, a tree node by "node": selecting or opening it navigates.
      if ((action.row !== undefined || action.node !== undefined) && namedControl(s, action.id)) {
        if (action.do === "dblclick" && commitQuestion(s)) return commit("a double-click on a popup that asks to save");
        return { risk: "navigate", reason: `${action.do} on a ${action.node !== undefined ? "tree node" : "row"}` };
      }
      if (target?.kind === "key") return assessKey(target.key.vkey, `button "${clean(target.key.text)}"`);
      if (target?.kind === "tab") return { risk: "navigate", reason: `tab "${target.text}"` };
      if (target?.kind === "element" && target.element.kind === "button") return assessButton(target.element, "button ");
      if (target?.kind === "element" || target?.kind === "cell" || target?.kind === "list" || target?.kind === "gridrow" || target?.kind === "node") {
        // A click on a field or a line only moves the cursor; a double-click on a list line chooses it.
        if (action.do === "dblclick" && commitQuestion(s)) return commit("a double-click on a popup that asks to save");
        return { risk: "navigate", reason: `${action.do} on ${target.what}` };
      }
      return commit(`${action.do} on something this reader cannot see is treated as a write`);
    }
    default:
      return commit(`"${action.do}" is not an action of this method`);
  }
}

/** What an action's id means on the screen. */
export type Target =
  | { kind: "element"; element: DiagElement; window: DiagWindow; row: number; col: number; what: string }
  | { kind: "cell"; window: DiagWindow; row: number; col: number; width: number; input: boolean; what: string }
  | { kind: "list"; window: DiagWindow; row: number; col: number; what: string }
  | { kind: "tab"; window: DiagWindow; row: number; col: number; text: string; what: string }
  | { kind: "key"; key: DiagKey; what: string }
  | { kind: "gridrow"; window: DiagWindow; row: number; col: number; index: number; what: string }
  | { kind: "node"; window: DiagWindow; row: number; col: number; line: number; depth: number; header: boolean; what: string };

export function resolveTarget(s: DiagScreen, action: Action): Target | undefined {
  const w = active(s);
  const raw = String(action.id ?? action.name ?? "").trim();
  if (!raw) return undefined;
  const pos = /^@(\d+),(\d+)$/.exec(raw);
  if (pos) {
    const row = Number(pos[1]);
    const col = Number(pos[2]);
    const cell = w.list?.rows.find((r) => r.row === row)?.cells.find((c) => c.col <= col && col < c.col + Math.max(1, c.width));
    return { kind: "list", window: w, row, col, what: cell ? `"${clean(cell.text)}"` : `@${row},${col}` };
  }
  const fc = /^\{(.+)\}$/.exec(raw)?.[1];
  if (fc) {
    for (const ts of w.tabstrips) {
      const t = ts.tabs.find((x) => x.fcode === fc);
      if (t) return { kind: "tab", window: w, row: t.row, col: t.col, text: clean(t.text), what: `tab "${clean(t.text)}"` };
    }
    const b = w.elements.find((e) => e.fcode === fc && !e.hidden);
    if (b) return { kind: "element", element: b, window: w, row: b.row, col: b.col, what: `button "${clean(b.text || b.tooltip)}"` };
    const k = [...w.toolbar, ...w.keys].find((x) => x.fcode === fc);
    if (k) return { kind: "key", key: k, what: `button "${clean(k.text)}"` };
    // a tree node by its key: its line among the nodes on show (those whose parents are all open)
    for (const c of w.controls) {
      if (!c.tree || !c.area) continue;
      const byKey = new Map(c.tree.nodes.map((x) => [x.key, x]));
      const shown = c.tree.nodes.filter((x) => {
        if (x.hidden) return false;
        for (let p = byKey.get(x.parent); p; p = byKey.get(p.parent)) if (!p.expanded) return false;
        return true;
      });
      const line = shown.findIndex((x) => x.key === fc);
      if (line >= 0) {
        const node = shown[line] as (typeof shown)[number];
        return { kind: "node", window: w, row: c.area.row, col: c.area.col, line, depth: node.depth, header: c.tree.headers.length > 1, what: `tree node "${clean(node.text)}"` };
      }
    }
    return undefined;
  }
  const cell = /^(.+)\[(\d+)\]$/.exec(raw);
  if (cell) {
    // a grid row: the grid's container name and the row number of the view
    const grid = w.controls.find((c) => c.grid && (c.container === cell[1] || String(c.id) === cell[1] || (!c.area && cell[1] === "value-help")));
    if (grid?.grid && !grid.area) {
      // a value help's hit list: a control without a place on the dynpro; it opens with its first row selected
      const index = Number(cell[2]);
      if (index >= grid.grid.totalRows) return undefined;
      const r = grid.grid.rows.find((x) => x.index === index);
      return { kind: "gridrow", window: w, row: -1, col: -1, index, what: `row ${index} of the hit list${r ? ` (${r.cells.slice(0, 3).join(" | ")})` : ""}` };
    }
    if (grid?.area && grid.grid) {
      const index = Number(cell[2]);
      if (index >= grid.grid.totalRows) return undefined;
      const r = grid.grid.rows.find((x) => x.index === index);
      return { kind: "gridrow", window: w, row: grid.area.row, col: grid.area.col, index, what: `row ${index} of ${cell[1]}${r ? ` (${r.cells.slice(0, 4).join(" | ")})` : ""}` };
    }
    for (const t of w.tables) {
      const c = t.columns.find((x) => x.name === cell[1]);
      // n is the table's own row number, as the view prints it ("row n"), not the n-th row on show.
      const r = t.rows.find((x) => x.index === Number(cell[2]));
      if (c && r) return { kind: "cell", window: w, row: r.row, col: c.col, width: c.width, input: !!r.cells[c.index]?.input, what: `${cell[1]} in row ${cell[2]}` };
    }
    return undefined;
  }
  // a toolbar button by its text ("Back", "Display document flow")
  const k = [...w.toolbar, ...w.keys].find((x) => clean(x.text).toLowerCase() === raw.toLowerCase());
  const named = w.elements.filter((e) => e.name === raw && !e.hidden);
  const e = (action.do === "set" ? named.find((x) => x.input) : undefined) ?? named.find((x) => x.kind !== "label") ?? named[0];
  if (e) return { kind: "element", element: e, window: w, row: e.row, col: e.col, what: `${e.kind} ${e.name}` };
  if (k && (action.do === "press" || action.do === "click")) return { kind: "key", key: k, what: `button "${clean(k.text)}"` };
  return undefined;
}

/** What a surface shares between its drivers: window bindings, the cell calibration, and the environment. */
export interface DriverShared {
  /** Session window handle to the "connection:mode" it was matched to (geometry.ts `pickWindow`). */
  bound: Map<number, string>;
  /** Is a "connection:mode" still open? */
  live(key: string): boolean;
  env: Record<string, string | undefined>;
}

/** Where the time of the last action went. */
interface ActTiming {
  total: number;
  input: number;
  start: number;
  sap: number;
  settle: number;
  decode: number;
  requests: number;
}

/** The longest a driver waits, before an action, for SAP's answer to a step still running. */
const BUSY_MS = 2000;

export class DiagDriver implements Driver {
  info: SessionInfo;
  /** Tree folders opened or closed by the keyboard without SAP knowing: shell id to node key to open. */
  private local = new Map<number, { count: number; nodes: Map<string, boolean> }>();
  /** Checks for the next screen: changes SAP gets only with the next step (a dropdown without a function code). */
  private later: ((s: DiagScreen) => string | undefined)[] = [];
  private last: ActTiming | undefined;
  private shared: DriverShared;

  constructor(
    info: SessionInfo,
    private conn: Connection,
    private mode: number,
    private host: Transport,
    shared?: DriverShared,
  ) {
    this.info = info;
    this.shared = shared ?? { bound: new Map(), live: () => true, env: {} };
  }

  private get key(): string {
    return `${this.conn.n}:${this.mode}`;
  }

  /** The keyboard's tree changes of one tree, while SAP's nodes of it stay the same. */
  private localOf(c: DiagControl): Map<string, boolean> | undefined {
    const l = this.local.get(c.id);
    if (!l) return undefined;
    if (!c.tree || c.tree.nodes.length !== l.count) {
      this.local.delete(c.id);
      return undefined;
    }
    return l.nodes;
  }

  /** The screen of this mode, with the keyboard's tree changes. */
  private screen(): DiagScreen {
    const s = this.conn.decoder.screen(this.mode);
    if (!this.conn.open) throw new ActionError("This SAP GUI connection is closed. Call sap_sessions to see what is open.");
    if (!s) throw new ActionError("No screen has come through the router for this session yet: press Enter in SAP GUI once.");
    if (!this.local.size) return s;
    return {
      ...s,
      windows: s.windows.map((w) => ({
        ...w,
        controls: w.controls.map((c) => {
          const nodes = this.localOf(c);
          if (!nodes || !c.tree) return c;
          return { ...c, tree: { ...c.tree, nodes: c.tree.nodes.map((x) => (nodes.has(x.key) ? { ...x, expanded: nodes.get(x.key) as boolean } : x)) } };
        }),
      })),
    };
  }

  async refresh(): Promise<SessionInfo> {
    this.info = describe(this.conn, this.mode, this.screen());
    return this.info;
  }

  async valid(): Promise<boolean> {
    return this.conn.open && !!this.conn.decoder.screen(this.mode);
  }

  async look(options: LookOptions): Promise<string> {
    if (options.id) return lookControl({ screen: () => this.screen(), scrollTo: (id, row) => this.scrollTo(id, row).then(() => undefined) }, options);
    const view = diagView(this.screen(), options.compact ? {} : { maxRows: 100_000 });
    return this.conn.traffic.pending(this.mode) ? `${view}\nNOTE SAP is still working on a step: this screen is from before it and will change. Look again in a moment, and act when the step has ended.` : view;
  }

  async assess(action: Action): Promise<Assessment> {
    const s = this.screen();
    return assessDiag(s, action, resolveTarget(s, action));
  }

  timing(): string | undefined {
    const t = this.last;
    if (!t) return undefined;
    const other = Math.max(0, t.total - t.input - t.start - t.sap - t.settle);
    return `${t.total} ms: input ${t.input}, start ${t.start}, sap ${t.sap}, settle ${t.settle}, other ${other}; decoding ${t.decode} (${t.requests} request${t.requests === 1 ? "" : "s"})`;
  }

  /** The SAP GUI windows of this session (the session window, then its popups), with their screen areas. */
  private async windows(s: DiagScreen): Promise<WindowFacts[]> {
    const all = await this.host.request<{ windows: HostWindow[] }>("windows", {}, READ_TIMEOUT_MS);
    const mine = pickWindow(all.windows, { key: this.key, title: s.windows[0]?.title ?? "", ...(s.message?.text ? { status: s.message.text } : {}) }, this.shared.bound, this.shared.live);
    if (typeof mine === "string") throw new ActionError(mine);
    const res = await this.host.request<{ windows: WindowFacts[] }>("area", { session: mine.hwnd }, READ_TIMEOUT_MS);
    return res.windows;
  }

  /** The pixels of the windows: cells from the traffic (or a calibration, or the area's size), the Windows controls of the window acted on. */
  private geometry(s: DiagScreen, wins: WindowFacts[]): Geometry {
    const main = !active(s).modal;
    const top = wins[wins.length - 1] as WindowFacts;
    const env = cellsFromEnv(this.shared.env.SAP_DIAG_CELL);
    const hostOf = (w: DiagWindow): WindowFacts => (main ? wins[0] : wins[w.index]) ?? top;
    const cellsOf = (w: DiagWindow): Cells => {
      const area = hostOf(w).area;
      if (!area) throw new ActionError("The screen area of this SAP GUI window was not found.");
      return cellMetrics(area as Rect, w.size, this.conn.traffic.font, env);
    };
    const acting = (main ? wins[0] : top) ?? top;
    return {
      at: (w, row, col, width = 1) => {
        const c = cellsOf(w);
        const [left, topPx] = hostOf(w).area as Rect;
        return [left + c.x0 + c.cw * col + Math.min(Math.floor((c.cw * Math.max(1, width)) / 2), 3 * c.cw), topPx + c.ch * row + c.y0];
      },
      get cells() {
        return cellsOf(active(s));
      },
      controls: (acting.controls ?? []) as { cls: string; rect: Rect }[],
    };
  }

  /** Sends one input to the host. */
  private async send(session: number | undefined, main: boolean, step: Step): Promise<void> {
    await this.host.request("act", { session, main, action: step }, READ_TIMEOUT_MS).catch((e) => {
      throw e instanceof HostError ? new ActionError(e.message) : e;
    });
  }

  /** Runs a plan: the inputs, then the wait for SAP's answer in the traffic, then the checks on the screen it brought. */
  private async run(s: DiagScreen, plan: Plan, wins: WindowFacts[], o: WaitOptions, t0: number): Promise<string> {
    const traffic = this.conn.traffic;
    const session = wins[0]?.hwnd;
    const main = !active(s).modal;
    const decode0 = traffic.decodeMs;
    const mark = traffic.mark();
    const tIn = Date.now();
    for (const step of plan.steps) await this.send(session, main, step);
    const inputEnd = Date.now();
    if (plan.tree) this.remember(plan.tree);
    let note = plan.note;
    let answered = false;
    const timing: ActTiming = { total: 0, input: inputEnd - tIn, start: 0, sap: 0, settle: 0, decode: 0, requests: 0 };
    if (plan.answer !== "no" && plan.steps.length) {
      const r = await traffic.wait(this.mode, mark, inputEnd, { ...o, requestMs: plan.answer === "yes" ? o.requestMs : MAYBE_REQUEST_MS });
      Object.assign(timing, { start: r.start, sap: r.sap, settle: r.settle, requests: r.requests });
      answered = r.answered;
      const miss = waitNote(r, { ...o, requestMs: plan.answer === "yes" ? o.requestMs : MAYBE_REQUEST_MS }, plan.answer === "yes");
      if (miss) note += `; ${miss}`;
    }
    const after = this.conn.decoder.screen(this.mode);
    if (answered && after) {
      for (const check of this.later.splice(0)) {
        const said = check(after);
        if (said) note += `; ${said}`;
      }
    }
    const confirm = plan.confirm?.(after ? this.screen() : undefined, answered);
    if (confirm) note += `; ${confirm}`;
    if (plan.later) this.later.push(plan.later);
    if (answered && after?.message?.text) note += `; status ${after.message.type}: ${after.message.text}`;
    timing.decode = Math.round(traffic.decodeMs - decode0);
    timing.total = Date.now() - t0;
    this.last = timing;
    return note;
  }

  private remember(t: TreeChange): void {
    const c = this.conn.decoder
      .screen(this.mode)
      ?.windows.flatMap((w) => w.controls)
      .find((x) => x.id === t.shell);
    if (!c?.tree) return;
    const l = this.local.get(t.shell);
    const nodes = l && l.count === c.tree.nodes.length ? l.nodes : new Map<string, boolean>();
    nodes.set(t.node, t.expanded);
    this.local.set(t.shell, { count: c.tree.nodes.length, nodes });
  }

  /** Before an action: SAP must be done with the last step. */
  private async idle(): Promise<void> {
    const traffic = this.conn.traffic;
    if (!traffic.pending(this.mode)) return;
    await traffic.wait(this.mode, -1, Date.now(), { requestMs: 0, answerMs: BUSY_MS, quietMs: 0, maxSettleMs: 0 });
    if (traffic.pending(this.mode)) throw new ActionError('SAP is still working on the last step. Look again in a moment (sap_look); a long step can be given more time with "timeout" (seconds).');
  }

  /**
   * Scrolls a control so that `row` (from 0) is on show, or by a word
   * (next, prev, first, last). Table controls and lists page with SAP's page
   * keys until the row is on show, each page confirmed by the next screen.
   */
  private async scrollTo(id: string, to: number | string, o: WaitOptions = waitOptions({}, this.shared.env, MAX_TIMEOUT_MS)): Promise<string> {
    const t0 = Date.now();
    let s = this.screen();
    let n = namedControl(s, id);
    if (!n) throw new ActionError(`No control "${id}" on this screen. It has: ${scrollables(s).map((x) => x.id).join(", ") || "nothing that scrolls"}.`);
    if (n.kind === "dropdown") throw new ActionError(`${n.id} is a dropdown: it does not scroll.`);
    if (n.kind === "tree") return `every node SAP sent of ${n.id} is in the view (sap_look with "id":"${n.id}" and "rows" reads any of them): nothing to scroll`;
    if (typeof to === "string" && ["right", "left", "rightmost", "leftmost"].includes(to)) throw new ActionError(`Scrolling sideways is not supported by the DIAG method: the view already has every column SAP sent.`);
    const wins = await this.windows(s);
    if (n.kind === "grid") return this.run(s, planGridScroll(n, to, this.geometry(s, wins)), wins, o, t0);
    const start = position(n);
    if (!start) throw new ActionError(`${n.id} does not scroll.`);
    const target = scrollTarget(to, start);
    let notes = "";
    for (let page = 0; page < 60; page++) {
      const plan = planPage(n, target, this.geometry(s, wins));
      if (!plan) break;
      const before = position(n)?.first;
      const said = await this.run(s, plan, wins, o, t0);
      s = this.screen();
      n = namedControl(s, id) as Named | undefined;
      if (!n) return `${said}; ${id} is gone from the screen`;
      if (position(n)?.first === before) {
        notes = `; ${n.id} did not move with SAP's page key (${said})`;
        break;
      }
    }
    const p = position(n);
    if (!p) return `scrolled ${id}`;
    const last = p.first + p.visible - 1;
    const where = `rows ${p.first} to ${p.total !== undefined ? Math.min(last, p.total - 1) : last}${p.total !== undefined ? ` of ${p.total}` : ""}`;
    return p.first === start.first ? `${n.id} is already there: ${where}${notes}` : `scrolled ${n.id}: ${where}${notes}`;
  }

  async act(action: Action): Promise<string> {
    const t0 = Date.now();
    let s = this.screen();
    if (isLogonScreen(s.windows[0]?.program, s.windows[0]?.dynpro)) throw new ActionError(LOGON_REFUSAL);
    await this.idle();
    s = this.screen();
    const o = waitOptions(action, this.shared.env, MAX_TIMEOUT_MS);
    const has = (v: unknown) => v !== undefined && v !== null && v !== "";
    // Without a choice, a dropdown only says what it can: no window is needed.
    if (action.do === "combo" && !has(action.key) && !has(action.value)) return planCombo(s, action, NO_GEOMETRY).note;
    if (action.do === "scroll") {
      let id = action.id;
      if (typeof id !== "string" || !id.trim()) {
        const all = scrollables(s);
        if (all.length !== 1) throw new ActionError(all.length ? `scroll needs "id": one of ${all.map((x) => x.id).join(", ")}.` : "Nothing on this screen scrolls: no grid, table, tree or list.");
        id = (all[0] as Named).id;
      }
      return this.scrollTo(id, (action.to ?? "next") as number | string, o);
    }
    // A table cell by the table's own row number: a row that is not on show is scrolled to first.
    const cell = /^(.+)\[(\d+)\]$/.exec(String(action.id ?? ""));
    if (cell && !resolveTarget(s, action)) {
      const table = active(s).tables.find((t) => t.columns.some((c) => c.name === cell[1]));
      if (table && !table.rows.some((r) => r.index === Number(cell[2])) && (table.totalRows === undefined || Number(cell[2]) < table.totalRows)) {
        await this.scrollTo(table.name, Number(cell[2]), o);
        s = this.screen();
      }
    }
    const wins = await this.windows(s);
    const g = this.geometry(s, wins);
    const named = namedControl(s, action.id);
    const local = (n: Named | undefined) => (n?.kind === "tree" ? this.localOf(n.control) : undefined);
    let plan: Plan;
    switch (action.do) {
      case "combo":
        plan = planCombo(s, action, g);
        break;
      case "tree":
        plan = planTree(s, action, g, local(named));
        break;
      case "grid":
        plan = planGrid(s, action, g);
        break;
      case "toolbar": {
        let p = planToolbar(s, action, g);
        if (p === "need-buttons") {
          const r = await this.host.request<{ buttons: { name: string; tip: string; enabled: boolean; x: number; y: number }[] }>("buttons", { session: wins[0]?.hwnd }, READ_TIMEOUT_MS);
          p = planToolbar(s, action, g, r.buttons ?? []) as Plan;
        }
        plan = p;
        break;
      }
      default: {
        // A row of a table control or a grid, a tree node by "node" (the other surfaces' shape).
        if (named && (action.do === "select" || action.do === "dblclick" || action.do === "click") && (action.row !== undefined || action.node !== undefined)) {
          if (named.kind === "tree" && action.node !== undefined) plan = planTree(s, { ...action, do: "tree", how: action.do === "dblclick" ? "double" : "select" }, g, local(named));
          else if (named.kind === "grid") plan = planGrid(s, { ...action, do: "grid", how: action.do === "dblclick" ? "double" : action.do === "select" ? "select" : "cell" }, g);
          else if (named.kind === "table" && typeof action.row === "number") {
            if (!named.table.rows.some((r) => r.index === action.row)) {
              await this.scrollTo(named.table.name, action.row, o);
              s = this.screen();
            }
            const again = namedControl(s, named.id);
            if (again?.kind !== "table") throw new ActionError(`The table ${named.id} is gone from the screen.`);
            plan = planTableRow(again, action.row, g);
          } else throw new ActionError(`${named.id} is a ${named.kind}: "row" and "node" go with a table, a grid or a tree.`);
          break;
        }
        if (named?.kind === "dropdown" && action.do === "set") {
          plan = planCombo(s, { ...action, do: "combo", key: action.value }, g);
          break;
        }
        plan = planPlain(s, action, resolveTarget(s, action), g, local(named));
      }
    }
    return this.run(s, plan, wins, o, t0);
  }

  async screenshot(): Promise<Buffer> {
    const wins = await this.windows(this.screen());
    const r = await this.host.request<{ png: string }>("screenshot", { session: wins[0]?.hwnd }, READ_TIMEOUT_MS);
    return Buffer.from(r.png, "base64");
  }

  async close(): Promise<void> {}
}

/** Planning without a window: for a plan that sends nothing. */
const NO_GEOMETRY: Geometry = {
  at: () => {
    throw new ActionError("This action needs SAP GUI's window.");
  },
  get cells(): Cells {
    throw new ActionError("This action needs SAP GUI's window.");
  },
  controls: [],
};

function describe(c: Connection, mode: number, s: DiagScreen): SessionInfo {
  const info: SessionInfo = { id: `${PREFIX}${c.n}:${mode}`, surface: "sapgui", where: `SAP GUI connection to ${c.target.host}:${c.target.service} through the DIAG router, mode ${mode}` };
  if (s.session.system) info.system = s.session.system;
  if (s.session.client) info.client = s.session.client;
  if (s.session.user) info.user = s.session.user;
  if (s.session.tcode) info.transaction = s.session.tcode;
  if (s.windows[0]?.title) info.title = s.windows[0].title;
  return info;
}

export interface DiagSurfaceOptions {
  port?: number;
  transport?: Transport;
  log?: (m: string) => void;
}

export function sapguiDiagSurface(env: Record<string, string | undefined>, options: DiagSurfaceOptions = {}): Surface & { router: Promise<Server> } {
  const port = options.port ?? Number(env.SAP_DIAG_PORT ?? 3298);
  const conns: Connection[] = [];
  let n = 0;
  const router = startRouter({
    port,
    ...(options.log ? { log: options.log } : {}),
    onConnection(target) {
      const c: Connection = { n: n++, target, decoder: new DiagDecoder(), open: true, traffic: new Traffic() };
      c.decoder.onScreen = (_s, mode) => c.traffic.screen(mode);
      conns.push(c);
      // SAP_DIAG_CAPTURE=<folder>: keep the raw traffic, to debug the decoder (it holds SAP data: keep it local).
      const capture = env.SAP_DIAG_CAPTURE ? join(env.SAP_DIAG_CAPTURE, `diag-${Date.now()}-${c.n}.bin`) : undefined;
      if (capture) mkdirSync(env.SAP_DIAG_CAPTURE as string, { recursive: true });
      return {
        data: (dir, chunk) => {
          if (capture) {
            const head = Buffer.alloc(13);
            head[0] = dir;
            head.writeDoubleLE(Date.now() / 1000, 1);
            head.writeUInt32LE(chunk.length, 9);
            appendFileSync(capture, Buffer.concat([head, chunk]));
          }
          // The tracker sees SAP GUI's requests before the decoder, and SAP's bytes before the screen they make.
          if (dir === 0) c.traffic.client(chunk);
          else c.traffic.server();
          const t = performance.now();
          c.decoder.push(dir, chunk);
          c.traffic.decodeMs += performance.now() - t;
        },
        close: () => {
          c.open = false;
          c.traffic.closed();
        },
      };
    },
  });
  router.catch(() => {});
  let host: Transport | undefined = options.transport;
  const shared: DriverShared = {
    bound: new Map(),
    live: (key) => {
      const [cn, mode] = key.split(":").map(Number);
      const c = conns.find((x) => x.n === cn);
      return !!c?.open && c.decoder.screens().has(mode as number);
    },
    env,
  };
  const input = () => (host ??= new PsHost(env, { command: powershellExe(env), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INPUT_SCRIPT] }));
  return {
    name: "sapgui",
    router,
    async discover() {
      await router.catch(() => undefined);
      const out: SessionInfo[] = [];
      for (const c of conns) {
        if (!c.open) continue;
        for (const [mode, s] of c.decoder.screens()) out.push(describe(c, mode, s));
      }
      return out;
    },
    async open(info) {
      const m = /^sapgui:diag:(\d+):(\d+)$/.exec(info.id);
      const c = conns.find((x) => x.n === Number(m?.[1]));
      if (!m || !c) throw new ActionError("This SAP GUI session is gone. Call sap_sessions to see what is open.");
      return new DiagDriver(info, c, Number(m[2]), input(), shared);
    },
    async doctor(): Promise<DoctorCheck[]> {
      const checks: DoctorCheck[] = [];
      try {
        await router;
        checks.push({ ok: true, check: "DIAG router", detail: `listening on 127.0.0.1:${port}` });
      } catch (e) {
        checks.push({ ok: false, check: "DIAG router", detail: (e as Error).message, fix: `Port ${port} is taken: set SAP_DIAG_PORT to a free port.` });
      }
      const live = conns.filter((c) => c.open).length;
      checks.push(
        live
          ? { ok: true, check: "SAP GUI connections", detail: `${live} through the router` }
          : { ok: false, check: "SAP GUI connections", detail: "none through the router yet", fix: `In SAP Logon, edit the connection entry: put /H/127.0.0.1/S/${port} at the start of its SAProuter string, then log on again. Connections encrypted with SNC cannot be read.` },
      );
      return checks;
    },
  };
}
