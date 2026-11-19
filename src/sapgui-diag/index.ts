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
 * ("{HEAD}", a button or tab), a table cell "FIELD[n]" (n = row of the table
 * on show, 0-based), or a position "@row,col" (a list line, anything else).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { ONE_LINE_NOTE, oneLine } from "../core/action.js";
import { ActionError, type Action, type Assessment, type DoctorCheck, type Driver, type LookOptions, type SessionInfo, type Surface } from "../core/types.js";
import { CLOSES_SESSIONS, commitCode, commitWord, isLogonScreen, LOGON_REFUSAL, MENU_PROGRAMS, okcodeKind, SAFE_VKEYS, safeCode, safeWord, SAVE_VKEYS } from "../core/words.js";
import { DiagDecoder, type DiagElement, type DiagKey, type DiagScreen, type DiagWindow, diagView } from "../diag/index.js";
import { HostError, powershellExe, PsHost, READ_TIMEOUT_MS } from "../sapgui/host.js";
import type { Transport } from "../sapgui/facts.js";
import { vkeyNumber } from "../sapgui/keys.js";
import { type Hop, startRouter } from "./router.js";
import { fileURLToPath } from "node:url";

const PREFIX = "sapgui:diag:";
export const INPUT_SCRIPT = fileURLToPath(new URL("./ps/input-host.ps1", import.meta.url));
/** How long to wait for SAP's answer after an action that goes to the server. */
const STEP_MS = 60_000;

interface Connection {
  n: number;
  target: Hop;
  decoder: DiagDecoder;
  open: boolean;
  /** Bumped on every screen, per mode. */
  steps: Map<number, number>;
  waiters: (() => void)[];
}

interface WindowFacts {
  hwnd: number;
  kind: "session" | "popup";
  title: string;
  area?: [number, number, number, number] | null;
  controls?: { cls: string; rect: [number, number, number, number] }[];
  foreground?: boolean;
}

/** Cell to screen pixel, on a window's screen area: SAP GUI lays its screens out on a grid of character cells. */
export function cellPoint(area: [number, number, number, number], size: { rows: number; cols: number }, row: number, col: number, width = 1): [number, number] {
  const [left, top, w, h] = area;
  const cw = Math.max(1, Math.floor(w / Math.max(1, size.cols)));
  const ch = Math.max(1, Math.floor(h / Math.max(1, size.rows + 1)));
  // Measured on Quartz at 100% (VA01, VA03): x = 3 + cw * col, y = ch * (row + 1) is the middle of a row.
  const x = left + 3 + cw * col + Math.min(Math.floor((cw * Math.max(1, width)) / 2), 3 * cw);
  const y = top + ch * (row + 1) - Math.floor(ch / 10);
  return [x, y];
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const commit = (reason: string): Assessment => ({ risk: "commit", reason });

/** The window actions go to: the topmost modal one, else the main window. */
function active(s: DiagScreen): DiagWindow {
  return s.windows[s.windows.length - 1] as DiagWindow;
}

const w0 = (s: DiagScreen): DiagWindow => active(s);

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
    case "press":
    case "click":
    case "dblclick":
    case "select": {
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
      const r = t.rows[Number(cell[2])];
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

class DiagDriver implements Driver {
  info: SessionInfo;
  constructor(
    info: SessionInfo,
    private conn: Connection,
    private mode: number,
    private host: Transport,
  ) {
    this.info = info;
  }

  private screen(): DiagScreen {
    const s = this.conn.decoder.screen(this.mode);
    if (!this.conn.open) throw new ActionError("This SAP GUI connection is closed. Call sap_sessions to see what is open.");
    if (!s) throw new ActionError("No screen has come through the router for this session yet: press Enter in SAP GUI once.");
    return s;
  }

  async refresh(): Promise<SessionInfo> {
    this.info = describe(this.conn, this.mode, this.screen());
    return this.info;
  }

  async valid(): Promise<boolean> {
    return this.conn.open && !!this.conn.decoder.screen(this.mode);
  }

  async look(options: LookOptions): Promise<string> {
    return diagView(this.screen(), options.compact ? {} : { maxRows: 100_000 });
  }

  async assess(action: Action): Promise<Assessment> {
    const s = this.screen();
    return assessDiag(s, action, resolveTarget(s, action));
  }

  /** The SAP GUI window of this session (and its popups), by title. */
  private async windows(s: DiagScreen): Promise<WindowFacts[]> {
    const main = s.windows[0]?.title ?? "";
    const all = await this.host.request<{ windows: WindowFacts[] }>("windows", {}, READ_TIMEOUT_MS);
    const mine = all.windows.filter((w) => w.kind === "session" && clean(w.title) === clean(main));
    if (!mine.length) throw new ActionError(`No SAP GUI window titled "${main}" is open on this desktop.`);
    const pick = mine.find((w) => w.foreground) ?? mine[0];
    if (mine.length > 1 && !pick?.foreground) throw new ActionError(`Several SAP GUI windows are titled "${main}": bring the one to drive to the front, then ask again.`);
    const res = await this.host.request<{ windows: WindowFacts[] }>("area", { session: (pick as WindowFacts).hwnd }, READ_TIMEOUT_MS);
    return res.windows;
  }

  private async waitStep(before: number): Promise<boolean> {
    const end = Date.now() + STEP_MS;
    while ((this.conn.steps.get(this.mode) ?? 0) === before && this.conn.open) {
      const left = end - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 500));
        this.conn.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    // a step can come in several messages: let the last one land
    await new Promise((r) => setTimeout(r, 300));
    return true;
  }

  async act(action: Action): Promise<string> {
    const s = this.screen();
    if (isLogonScreen(s.windows[0]?.program, s.windows[0]?.dynpro)) throw new ActionError(LOGON_REFUSAL);
    const wins = await this.windows(s);
    const session = wins[0]?.hwnd;
    const top = wins[wins.length - 1] as WindowFacts;
    const before = this.conn.steps.get(this.mode) ?? 0;
    const main = !active(s).modal;
    const send = (a: Record<string, unknown>) => this.host.request("act", { session, main, action: a }, READ_TIMEOUT_MS).catch((e) => {
      throw e instanceof HostError ? new ActionError(e.message) : e;
    });
    const at = (t: { row: number; col: number; window: DiagWindow }, width = 1): [number, number] => {
      const w = (main ? wins[0] : wins[t.window.index]) ?? top;
      if (!w.area) throw new ActionError("The screen area of this SAP GUI window was not found.");
      return cellPoint(w.area, t.window.size, t.row, t.col, width);
    };
    let goes = true;
    let note: string;
    const target = resolveTarget(s, action);
    const need = () => {
      if (!target) throw new ActionError(`Nothing on the screen matches "${String(action.id ?? action.name ?? "")}": use a field name, {FCODE}, FIELD[n] or @row,col from the view.`);
      return target;
    };
    switch (action.do) {
      case "okcode":
        await send({ do: "okcode", value: String(action.value ?? "") });
        note = `okcode ${String(action.value ?? "")}`;
        break;
      case "key": {
        const n = vkeyNumber(action.key ?? action.value);
        if (n === undefined) throw new ActionError(`Unknown key ${String(action.key ?? action.value)}`);
        await send({ do: "key", key: n });
        note = `key ${n}`;
        break;
      }
      case "set": {
        const t = need();
        if (t.kind !== "element" && t.kind !== "cell") throw new ActionError(`${t.what} does not take text.`);
        if (t.kind === "element" && !t.element.input) throw new ActionError(`${t.what} is read-only.`);
        const [x, y] = at(t, t.kind === "cell" ? t.width : t.element.width);
        // Typed with the keyboard: a line break would be the Enter key, so it is typed as a space.
        const single = oneLine(String(action.value ?? ""));
        await send({ do: "set", x, y, value: single.text, settle: 150 });
        note = `typed into ${t.what}; SAP gets it with the next Enter or function key${single.had ? ` (${ONE_LINE_NOTE})` : ""}`;
        goes = false;
        break;
      }
      case "focus":
      case "check":
      case "click":
      case "dblclick":
      case "press":
      case "select":
      case "f4": {
        const t = need();
        if (t.kind === "key") {
          await send({ do: "key", key: t.key.vkey });
          note = `pressed ${t.what}`;
          break;
        }
        if (t.kind === "node") {
          // Trees are SAP GUI controls: lines of a fixed height from the top of the tree's window, indented by depth.
          const host = (main ? wins[0] : wins[t.window.index]) ?? top;
          const [cx, cy] = at({ row: t.row, col: t.col, window: t.window });
          const g = host.controls?.find((c) => c.cls === "SAPTreeList" && cx >= c.rect[0] - 8 && cx <= c.rect[0] + c.rect[2] && cy >= c.rect[1] - 30 && cy <= c.rect[1] + c.rect[3]);
          if (!g) throw new ActionError("The tree's window was not found on the screen.");
          const pitch = Math.max(16, Math.floor((host.area?.[3] ?? 571) / ((t.window.size.rows || 20) + 1)) - 3);
          // a column tree draws its header in a window of its own: the tree window starts at the first line
          const y = g.rect[1] + pitch * t.line + Math.floor(pitch / 2);
          if (y > g.rect[1] + g.rect[3] - 4) throw new ActionError(`${t.what} is below the visible part of the tree.`);
          await send({ do: action.do === "dblclick" ? "dblclick" : "click", x: g.rect[0] + 44 + 18 * t.depth, y, settle: 150 });
          note = `${action.do} on ${t.what}`;
          goes = action.do === "dblclick";
          break;
        }
        if (t.kind === "gridrow" && t.row < 0) {
          if (t.index > 0) await send({ do: "down", count: t.index, settle: 150 });
          if (action.do === "dblclick" || action.do === "press") {
            await send({ do: "key", key: 0 });
            note = `chose ${t.what}`;
          } else {
            note = `selected ${t.what}`;
            goes = false;
          }
          break;
        }
        if (t.kind === "gridrow") {
          // Grids are SAP GUI controls drawn on their own: click the first row, move down with the arrow key
          // (it scrolls), and choose with F2, as a double-click does in an ALV list.
          const host = (main ? wins[0] : wins[t.window.index]) ?? top;
          const [gx, gy] = at({ row: t.row, col: t.col, window: t.window });
          const g = host.controls?.find((c) => c.cls === "SAPALVGrid" && gx >= c.rect[0] - 8 && gx <= c.rect[0] + c.rect[2] && gy >= c.rect[1] - 30 && gy <= c.rect[1] + c.rect[3]);
          if (!g) throw new ActionError("The grid's window was not found on the screen.");
          const pitch = Math.max(16, Math.floor((host.area?.[3] ?? 571) / ((t.window.size.rows || 20) + 1)) - 1);
          await send({ do: "click", x: g.rect[0] + 60, y: g.rect[1] + pitch + Math.floor(pitch / 2), settle: 150 });
          await send({ do: "top", settle: 100 });
          if (t.index > 0) await send({ do: "down", count: t.index, settle: 150 });
          if (action.do === "dblclick" || action.do === "press") {
            await send({ do: "key", key: 2 });
            note = `chose ${t.what}`;
          } else {
            note = `selected ${t.what}`;
            goes = false;
          }
          break;
        }
        if (t.kind === "tab" && action.do !== "focus") {
          // Tab captions are drawn in a proportional font, so a cell is not where they are: send the tab's
          // function code through the command field, as a click on it does.
          const fcode = w0(s).tabstrips.flatMap((x) => x.tabs).find((x) => x.row === t.row && x.col === t.col)?.fcode;
          if (fcode && !w0(s).modal) {
            await send({ do: "okcode", value: fcode });
            note = `selected ${t.what}`;
            break;
          }
        }
        const width = t.kind === "element" ? t.element.width : t.kind === "cell" ? t.width : t.kind === "tab" ? Math.max(1, t.text.length) : 1;
        const [x, y] = at(t, width);
        const twice = action.do === "dblclick";
        const f4 = action.do === "f4";
        await send({ do: f4 ? "f4" : twice ? "dblclick" : "click", x, y, settle: 150 });
        note = `${action.do} on ${t.what}`;
        // A click on a field only moves the cursor; buttons, tabs, double-clicks and F4 go to SAP.
        goes = f4 || twice || t.kind === "tab" || (t.kind === "element" && (t.element.kind === "button" || !!t.element.fcode));
        if (action.do === "check" || action.do === "focus") goes = false;
        break;
      }
      default:
        throw new ActionError(`"${action.do}" is not supported by the DIAG method (okcode, key, set, press, click, dblclick, check, select, f4, focus).`);
    }
    if (goes && !(await this.waitStep(before))) return `${note}; SAP has not answered yet`;
    const after = this.conn.decoder.screen(this.mode);
    const msg = after?.message?.text ? `; status ${after.message.type}: ${after.message.text}` : "";
    return `${note}${msg}`;
  }

  async screenshot(): Promise<Buffer> {
    const wins = await this.windows(this.screen());
    const r = await this.host.request<{ png: string }>("screenshot", { session: wins[0]?.hwnd }, READ_TIMEOUT_MS);
    return Buffer.from(r.png, "base64");
  }

  async close(): Promise<void> {}
}

function describe(c: Connection, mode: number, s: DiagScreen): SessionInfo {
  const info: SessionInfo = { id: `${PREFIX}${c.n}:${mode}`, surface: "sapgui", method: "diag", where: `SAP GUI connection to ${c.target.host}:${c.target.service} through the DIAG router, mode ${mode}` };
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
      const c: Connection = { n: n++, target, decoder: new DiagDecoder(), open: true, steps: new Map(), waiters: [] };
      c.decoder.onScreen = (_s, mode) => {
        c.steps.set(mode, (c.steps.get(mode) ?? 0) + 1);
        for (const w of c.waiters.splice(0)) w();
      };
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
          c.decoder.push(dir, chunk);
        },
        close: () => {
          c.open = false;
          for (const w of c.waiters.splice(0)) w();
        },
      };
    },
  });
  router.catch(() => {});
  let host: Transport | undefined = options.transport;
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
      return new DiagDriver(info, c, Number(m[2]), input());
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
