/**
 * The SAP GUI for Windows surface.
 *
 * It attaches to the SAP GUI the user already has open, through SAP GUI
 * scripting, and never logs on. Scripting is COM: a PowerShell host process
 * (host.ts, ps/host.ps1) reads raw facts, and the text view is formatted
 * here (format.ts) and shortened by core/compact.ts.
 *
 * Actions: set, press, key, select, check, combo (without a key: the
 * entries), okcode, f4, focus, dblclick, tree (double, select, expand,
 * collapse), grid (double, select), toolbar and scroll (a grid, a table
 * control, a list, a long tree). "select" with "row" selects a table
 * control's or a grid's row; "set" with "row" and "col" types into a table
 * control's or a grid's cell (table.ts). Tab and Space, which SAP GUI has no
 * virtual key for, become a focus, a tick or a row selection. Ids are the ones the view shows; handles
 * and SAP field names work too (resolve.ts), and an id that names several
 * controls is refused with the list of them.
 */
import { compact, controlBlock } from "../core/compact.js";
import { severalText } from "../core/ids.js";
import { readRows } from "../core/rows.js";
import { ONE_LINE_NOTE, oneLine } from "../core/action.js";
import { type Action, ActionError, type Assessment, type Driver, type LookOptions, type SessionInfo, type Surface } from "../core/types.js";
import { isLogonScreen, LOGON_REFUSAL } from "../core/words.js";
import { assess } from "./assess.js";
import type { Control, DoctorEngine, DoctorLocal, Screen, SessionFacts, SessionsFacts, Transport } from "./facts.js";
import { esc, forAgent, fullView, listsOnly } from "./format.js";
import { vkeyNumber } from "./keys.js";
import { HostError, MAX_TIMEOUT_MS, type PowershellPolicy, powershellPolicy, PsHost, READ_TIMEOUT_MS } from "./host.js";
import { relativeId, resolve, resolveStrict } from "./resolve.js";
import { cellParts, focusedRow, gridColumn, localKey, nextField, tableCell, tableOfColumn } from "./table.js";

const PREFIX = "sapgui:";
/** How long a screen read may serve the step that follows it (assess, then act). */
const FRESH_MS = 1500;
/** A step in SAP can run long (a report, a large list): actions get more time than reads. */
const ACT_MS = 180_000;

/** What discovery says when SAP GUI is open but gives scripting nothing. */
export const SCRIPTING_OFF = "SAP GUI is running but scripting is off (in SAP GUI options, or sapgui/user_scripting on the server)";

/**
 * How long one action may take: 180 s, or the action's own "timeout" in
 * seconds (a report started with F8 can run for minutes), up to 600 s.
 */
export function actTimeoutMs(action: Action): number {
  const t = Number(action.timeout);
  if (!Number.isFinite(t) || t <= 0) return ACT_MS;
  return Math.min(Math.round(t * 1000), MAX_TIMEOUT_MS);
}

/** A password field, by its type or by its id ("pwd" prefix). */
const isPassword = (c: Control) => c.type === "GuiPasswordField" || /(^|\/)pwd[^/]*$/.test(c.id);

/** Types "set" may write a text into. */
/** A row number of a grid or a table control: a whole number from 0. */
export const isRow = (row: unknown): row is number => Number.isInteger(row) && (row as number) >= 0;

const SET_TYPES = new Set(["GuiTextField", "GuiCTextField"]);

/** Types SAP GUI scripting can "Select" (a tab, a radio button, a menu entry). */
const SELECT_TYPES = new Set(["GuiTab", "GuiRadioButton", "GuiMenu", "GuiContextMenu", "GuiTableRow"]);

export interface SapguiOptions {
  /** Default: process.platform. */
  platform?: string;
  /** Default: the PowerShell host. Tests pass a fake. */
  transport?: Transport;
}

function sessionInfo(s: SessionFacts, where: string): SessionInfo {
  const info: SessionInfo = { id: PREFIX + s.id, surface: "sapgui", where };
  if (s.system) info.system = s.system;
  if (s.client) info.client = s.client;
  if (s.user) info.user = s.user;
  if (s.transaction) info.transaction = s.transaction;
  const title = s.busy ? "(busy)" : s.windows?.[0]?.title;
  if (title) info.title = title;
  return info;
}

/** What the host's failure means for the model. */
function explain(e: unknown): Error {
  if (!(e instanceof HostError)) return e as Error;
  switch (e.code) {
    case "NO_SESSION":
      return new ActionError("This SAP GUI session is closed. Call sap_sessions to see what is open.");
    case "SCRIPTING_OFF":
      return new ActionError(`${SCRIPTING_OFF}. Run "npx -y sap-ui-automation doctor" for what to change.`);
    case "NO_SAPGUI":
    case "NO_ENGINE":
      return new ActionError(`${e.message}. Run "npx -y sap-ui-automation doctor" for what to change.`);
    case "LOGON":
      return new ActionError(LOGON_REFUSAL);
    case "PASSWORD":
      return new ActionError(`${e.message}: this server never types a password. Type it yourself.`);
    case "BUSY":
      return new ActionError('SAP GUI is still busy with the last step. Look again in a moment (sap_look); a long step can be given more time with "timeout" (seconds).');
    case "NOT_FOUND":
      // A row the grid does not have, or a control that went away between the read and the action.
      return new ActionError(/^row \d+:/.test(e.message) ? `${e.message}.` : `${e.message}. Use an id from the screen you are on (it may have changed since your last look).`);
    case "NOT_SELECTABLE":
      return new ActionError(`${e.message}. Tick the row's checkbox with "check" on its cell id, or select by a row button if the screen has one.`);
    case "NO_SCROLL":
      return new ActionError(`${e.message}: "scroll" works on a grid, a table control, a tree or a list.`);
    default:
      return new ActionError(`SAP GUI refused: ${e.message}`);
  }
}

/**
 * Why a field takes no input. After an error or a warning SAP opens only the
 * fields its message is about (live: FB50 after "Enter valid date" refused
 * the header text, and the agent read "invalid argument" as a wrong value).
 */
export function readOnlyText(id: string, screen: Screen): string {
  const bar = screen.windows.flatMap((w) => w.controls).find((c) => c.type === "GuiStatusbar" && c.text);
  const type = bar?.messageType ?? "";
  if (type === "E" || type === "W")
    return `${id} is read-only now: after the ${type === "E" ? "error" : "warning"} "${esc(bar?.text)}" SAP keeps the other fields closed. ${type === "E" ? "Correct the field the message names, then Enter" : "Enter accepts the warning"}; the fields open again, then set this one.`;
  return `${id} is read-only on this screen: it takes no input here (a display, or a field SAP fills in). Change mode or another screen may have it.`;
}

/**
 * The screen after an action that SAP GUI keeps to itself, worked out from
 * the screen before it: "set" into a text field or a text editor (its text),
 * "focus" (the cursor). undefined for every other action, and for a field
 * the screen does not have: then the screen is read again.
 *
 * Each read walks every control of the screen through COM; FB50's table of
 * 74 columns took seconds, and a batch read it twice per field typed (live,
 * 2026-11-25: 23 s for 7 cells and Enter).
 */
export function typed(screen: Screen, action: Record<string, unknown>): Screen | undefined {
  if (action.do !== "set" && action.do !== "focus") return undefined;
  const id = String(action.id ?? "");
  const at = screen.windows.flatMap((w) => w.controls).find((c) => c.id === id);
  if (!at) return undefined;
  if (action.do === "focus") return { ...screen, focus: id };
  const text = at.type === "GuiTextField" || at.type === "GuiCTextField" || (at.type === "GuiShell" && at.sub === "TextEdit");
  if (!text || typeof action.value !== "string") return undefined;
  return { ...screen, windows: screen.windows.map((w) => ({ ...w, controls: w.controls.map((c) => (c.id === id ? { ...c, text: action.value as string } : c)) })) };
}

class SapguiDriver implements Driver {
  info: SessionInfo;
  private sid: string;
  /** The last screen read; `typed`: it is that read with what "set" or "focus" changed since (no read in between). */
  private last: { at: number; screen: Screen; typed?: boolean } | undefined;
  /** Trees longer than the host reads at once: the node each is read from, until the screen changes. */
  private treeFrom: Record<string, number> = {};

  constructor(
    info: SessionInfo,
    private host: Transport,
  ) {
    this.info = info;
    this.sid = info.id.slice(PREFIX.length);
  }

  private async ask<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    try {
      return await this.host.request<T>(op, { session: this.sid, ...params }, timeoutMs);
    } catch (e) {
      throw explain(e);
    }
  }

  private async screen(reuse = false): Promise<Screen> {
    if (reuse && this.last && Date.now() - this.last.at < FRESH_MS) return this.last.screen;
    const paged = Object.keys(this.treeFrom).length > 0;
    const screen = listsOnly(await this.ask<Screen>("screen", paged ? { treeFrom: this.treeFrom } : {}));
    // A tree that is gone takes its place in the paging with it.
    if (paged && !Object.keys(this.treeFrom).every((id) => screen.windows.some((w) => w.controls.some((c) => c.id === id)))) this.treeFrom = {};
    this.last = { at: Date.now(), screen };
    return screen;
  }

  async refresh(): Promise<SessionInfo> {
    this.info = sessionInfo(await this.ask<SessionFacts>("info"), this.info.where);
    return this.info;
  }

  async look(options: LookOptions): Promise<string> {
    // Right after "set" or "focus" the screen is the last read with that change: SAP GUI has not gone to the server.
    const screen = await this.screen(this.last?.typed === true);
    const full = fullView(screen);
    // The compact view leaves out what SAP GUI adds around the transaction (forAgent); the full view keeps all.
    if (!options.id) return options.compact ? compact(fullView(forAgent(screen))) : full;
    const target = this.strict(screen, options.id);
    const missing = () => new ActionError(`No control "${options.id}" on this screen. Use an id from sap_look (the screen may have changed).`);
    if (!target) throw missing();
    const id = target.id;
    if (options.rows) {
      const before = controlBlock(full, id);
      return readRows(
        {
          scrollTo: async (row) => {
            // A list with no scrollbar (all its rows on screen, MI24 live) has nothing to scroll: its rows are read as they are.
            if (target.type === "GuiUserArea" && !target.scroll) return;
            await this.scroll(target, row);
          },
          block: async () => {
            const now = fullView(await this.screen());
            const block = controlBlock(now, id);
            return block === undefined ? undefined : { block, screen: now };
          },
        },
        options.id,
        options.rows.from,
        options.rows.to,
        options.cols,
        // The control as the screen showed it: a table control goes back there, and rows the range skips are said.
        before === undefined ? undefined : { block: before, screen: full },
      );
    }
    let block = controlBlock(full, id);
    if (!block) throw missing();
    // Every entry of a dropdown, also those the view cuts.
    if (target.type === "GuiComboBox" && (target.entries?.length ?? 0) > 30)
      block = `${block.replace(/ {2}\d+ options: .*$/, "")}  ${target.entries?.length} options: ${(target.entries ?? []).map(([k, v]) => `${k.trim()}:${v.trim()}`).join(", ")}`;
    return options.compact ? compact(block, { dropdowns: false, maxChars: 0, screen: full }) : block;
  }

  /** The control an id means on the screen read; an id that names several is refused. */
  private strict(screen: Screen, ident: string): Control | undefined {
    const r = resolveStrict(screen, ident);
    if ("several" in r) throw new ActionError(severalText(ident, r.several));
    return "control" in r ? r.control : undefined;
  }

  /** Moves a grid, a table control, a list or a long tree; answers where it is now. */
  private async scroll(target: Control, to: number | string, timeoutMs = ACT_MS): Promise<string> {
    const id = target.id;
    if (target.type === "GuiShell" && target.sub === "Tree" && target.tree) {
      // SAP GUI gives every node on show whatever the tree is scrolled to: only a tree longer than one read is paged.
      const t = target.tree;
      const page = t.nodes.length;
      const from = t.first ?? 0;
      if (page >= t.shown && from === 0) return `all ${t.shown} nodes of ${id} are in the view: nothing to scroll`;
      const max = Math.max(0, t.shown - page);
      const want = typeof to === "number" ? to : to === "next" ? from + page : to === "prev" ? from - page : to === "first" ? 0 : to === "last" ? max : from;
      const first = Math.max(0, Math.min(want, Math.max(max, 0)));
      this.treeFrom = { ...this.treeFrom, [id]: first };
      this.last = undefined;
      return `scrolled ${id}: nodes ${first} to ${Math.min(first + page, t.shown) - 1} of ${t.shown}`;
    }
    const scrolls = (target.type === "GuiShell" && target.sub === "GridView") || target.type === "GuiTableControl" || (target.type === "GuiUserArea" && target.scroll);
    if (!scrolls) throw new ActionError(`${id} does not scroll: "scroll" works on a grid, a table control, a tree or a list.`);
    this.last = undefined;
    const r = await this.ask<{ from?: number; first?: number; visible?: number; total?: number }>("act", { action: { do: "scroll", id, to } }, timeoutMs);
    if (r.first === undefined) return `scrolled ${id}`;
    const last = Math.min((r.first ?? 0) + (r.visible ?? 1), r.total ?? Number.MAX_SAFE_INTEGER) - 1;
    return r.first === r.from ? `${id} is already there: rows ${r.first} to ${last} of ${r.total}` : `scrolled ${id}: rows ${r.first} to ${last} of ${r.total}`;
  }

  /** The control an action's id means: on the screen read, or asked from SAP GUI (menu entries are not in the read). */
  private async target(screen: Screen, action: Action): Promise<Control | undefined> {
    if (typeof action.id !== "string" || !action.id.trim()) return undefined;
    const found = this.strict(screen, action.id);
    if (found) return found;
    const id = relativeId(action.id);
    if (!id.startsWith("wnd[")) return undefined;
    const r = await this.ask<{ found: boolean; control?: Control }>("describe", { control: id });
    return r.found ? r.control : undefined;
  }

  async assess(action: Action): Promise<Assessment> {
    // A read of the last moment serves (the server reads the screen after every action of a batch, then judges the next).
    const screen = await this.screen(true);
    if (isLogonScreen(screen.program, screen.screen)) throw new ActionError(LOGON_REFUSAL);
    // Tab and Space have no virtual key: they are judged as what they become (a focus, a tick, a row selection).
    if (action.do === "key" && localKey(action.key ?? action.value)) {
      const instead = this.keyAction(screen, action);
      return assess(screen, instead, await this.target(screen, instead));
    }
    return assess(screen, action, await this.target(screen, action));
  }

  /**
   * What a key SAP GUI has no virtual key for does here: Tab and Shift+Tab move the
   * focus to the next (previous) field that takes input; Space ticks the focused
   * checkbox or selects the row of the focused table cell; Shift+Space selects that row.
   */
  private keyAction(screen: Screen, action: Action): Action {
    const k = localKey(action.key ?? action.value);
    if (k === "tab" || k === "backtab") {
      const to = nextField(screen, k === "backtab");
      if (!to) throw new ActionError('No field takes input in this window: there is nowhere for Tab to go. Put the cursor on a control with {"do":"focus","id":"<id>"}.');
      return { do: "focus", id: to.id };
    }
    const focused = screen.focus ? resolve(screen, screen.focus) : undefined;
    if (k === "space" && focused && (focused.type === "GuiCheckBox" || focused.type === "GuiRadioButton"))
      return { do: "check", id: focused.id, value: focused.type === "GuiRadioButton" ? true : !focused.selected };
    const inRow = focusedRow(screen);
    if (inRow) return { do: "select", id: inRow.table.id, row: inRow.row };
    throw new ActionError(
      `${k === "space" ? "Space" : "Shift+Space"} has no virtual key in SAP GUI, and the cursor is not in a table row${k === "space" ? " or on a checkbox" : ""}. Select a table row with {"do":"select","id":"<table>","row":N}, an ALV grid row with {"do":"grid","id":"<grid>","row":N,"col":"<col>","how":"select"}, tick a checkbox with {"do":"check","id":"<id>"}.`,
    );
  }

  async act(action: Action): Promise<string> {
    const doing = action.do === "click" ? "press" : action.do;
    const timeoutMs = actTimeoutMs(action);
    // Never on the logon screen: not a key, not a field, not a button.
    const now = await this.screen(true);
    if (isLogonScreen(now.program, now.screen)) throw new ActionError(LOGON_REFUSAL);
    if (doing === "okcode") {
      if (typeof action.value !== "string") throw new ActionError('okcode needs "value", e.g. {"do":"okcode","value":"/nVA03"}');
      return this.run({ do: "okcode", value: action.value }, `okcode ${action.value}`, timeoutMs);
    }
    if (doing === "key") {
      if (localKey(action.key ?? action.value)) {
        const instead = this.keyAction(now, action);
        return `key ${String(action.key ?? action.value).trim()}: ${await this.act({ ...instead, timeout: action.timeout })}`;
      }
      const key = vkeyNumber(action.key ?? action.value);
      if (key === undefined)
        throw new ActionError(
          'key needs "key": a virtual key number (0 Enter, 3 Back, 4 F4, 8 F8, 12 Cancel) or a function key by name (Enter, F8, Shift+F3, Control+s). Tab moves to the next field (or use {"do":"focus","id":"<id>"}); Space ticks the focused checkbox or selects the focused table row (or use "check", or "select" with "row").',
        );
      return this.run({ do: "key", key }, `key ${key}`, timeoutMs);
    }
    const screen = now;
    if (doing === "scroll" && (typeof action.id !== "string" || !action.id.trim())) {
      // Without an id: the one control of the screen that scrolls.
      const all = screen.windows.flatMap((w) => w.controls).filter((c) => (c.type === "GuiShell" && (c.sub === "GridView" || c.sub === "Tree")) || c.type === "GuiTableControl" || (c.type === "GuiUserArea" && c.scroll));
      if (all.length !== 1) throw new ActionError(all.length ? `scroll needs "id": one of ${all.map((c) => c.id).join(", ")}.` : "Nothing on this screen scrolls: no grid, table, tree or list.");
      return this.scroll(all[0] as Control, (action.to ?? "next") as number | string, timeoutMs);
    }
    if (typeof action.id !== "string" || !action.id.trim()) throw new ActionError(`${doing} needs "id": a control id from sap_look`);
    const target = await this.target(screen, action);
    // A column named by one of its cells' ids without the place, with a row: that row's cell, not the first one found.
    if (target && action.row !== undefined && cellParts(target.id) && !/\[\d+,\d+\]$/.test(String(action.id).trim())) {
      const p = cellParts(target.id) as { table: string; field: string };
      return this.act({ ...action, id: p.table, col: p.field });
    }
    if (!target && action.row !== undefined) {
      // A table's column named as the id, with a row: that table's cell.
      const column = tableOfColumn(screen, action.id);
      if (column) return this.act({ ...action, id: column.table.id, col: column.col });
    }
    if (!target) throw new ActionError(`No control "${action.id}" on this screen. Use an id from sap_look (the screen may have changed).`);
    const id = target.id;
    switch (doing) {
      case "set":
        if (isPassword(target)) throw new ActionError(`${id} is a password field: this server never types a password. Type it yourself.`);
        if (target.type === "GuiOkCodeField") throw new ActionError('The command field takes {"do":"okcode","value":"..."}, not "set".');
        if (target.type === "GuiCheckBox" || target.type === "GuiRadioButton") return this.act({ ...action, do: "check" });
        if (target.type === "GuiComboBox") return this.act({ ...action, do: "combo", key: action.value });
        // A text editor has lines (SAP GUI separates them with CR LF); every other field has one.
        // A cell of a table control or of an ALV grid, by row and column.
        if (target.type === "GuiTableControl") return this.tableAct(target, action, (cell) => {
            const { row: _row, col: _col, ...rest } = action;
            return this.act({ ...rest, id: cell.id });
          }, timeoutMs);
        if (target.type === "GuiShell" && target.sub === "GridView") {
          if (!isRow(action.row) || action.col === undefined) throw new ActionError(`${id} is an ALV grid: "set" into one of its cells needs "row" (a number from 0, from "row N:") and "col" (column id).`);
          const col = gridColumn(target, action.col);
          const single = oneLine(String(action.value ?? ""));
          return this.run({ do: "cell", id, row: action.row, col, value: single.text }, `set row ${action.row}, column ${col} of ${id} = "${single.text}"${single.had ? ` (${ONE_LINE_NOTE})` : ""}`, timeoutMs);
        }
        if (target.type === "GuiShell" && target.sub === "TextEdit") return this.run({ do: "set", id, value: String(action.value ?? "").replace(/\r\n?|\n/g, "\r\n") }, `set ${id}`, timeoutMs);
        if (!SET_TYPES.has(target.type))
          throw new ActionError(`${id} is a ${target.type}, not a field: "set" types into fields only, or into a table's or grid's cell given "row" and "col". Use "press" for a button, "select" for a tab or a menu entry.`);
        // SAP GUI answers a read-only field with "The method got an invalid argument": say why instead.
        if (target.changeable === false) throw new ActionError(readOnlyText(id, screen));
        const single = oneLine(String(action.value ?? ""));
        return this.run({ do: "set", id, value: single.text }, `set ${id} = "${single.text}"${single.had ? ` (${ONE_LINE_NOTE})` : ""}`, timeoutMs);
      case "press":
        // A click on a grid's cell (live: "click" with row and col on FB02's line items) puts the cursor there and selects the row.
        if (target.type === "GuiShell" && target.sub === "GridView" && action.row !== undefined) return this.act({ ...action, do: action.col === undefined ? "select" : "grid", how: "select" });
        if (target.type === "GuiTableControl" && action.row !== undefined) return this.act({ ...action, do: "grid", how: action.col === undefined ? "select" : "cell" });
        // A tab is clicked to open it: that is "select" (live, MM02's tabs, 2026-11-25).
        if (target.type === "GuiTab") return this.act({ ...action, do: "select" });
        if (target.type !== "GuiButton") throw new ActionError(`${id} is a ${target.type}, not a button: use "select" for a tab or a menu entry, "set" for a field.`);
        return this.run({ do: doing, id }, `${doing} ${id}`, timeoutMs);
      case "select": {
        // A row of a table control or of an ALV grid, as a click on its row selector does.
        if (action.row !== undefined) {
          const on = action.value === undefined || !(action.value === false || action.value === "false" || action.value === "" || action.value === 0);
          if (target.type === "GuiTableControl") return this.selectRow(target, action.row, on, timeoutMs);
          if (target.type === "GuiShell" && target.sub === "GridView") {
            if (!isRow(action.row)) throw new ActionError('"row" is a row number from 0, as the grid shows it ("row N:")');
            // Unselecting clears the grid's whole selection (ClearSelection): the answer says so.
            return this.run({ do: "grid", id, row: action.row, col: "", how: on ? "select" : "unselect" }, on ? `selected row ${action.row} of ${id}` : `cleared the selection of ${id} (all rows)`, timeoutMs);
          }
        }
        if (target.type === "GuiButton") return this.act({ ...action, do: "press" });
        if (target.type === "GuiCheckBox") return this.act({ ...action, do: "check" });
        if (target.type === "GuiTableControl" || (target.type === "GuiShell" && target.sub === "GridView"))
          throw new ActionError(`${id} is a ${target.type === "GuiTableControl" ? "table" : "grid"}: "select" needs "row", e.g. {"do":"select","id":"${id}","row":0}.`);
        if (!SELECT_TYPES.has(target.type))
          throw new ActionError(
            `${id} is a ${target.type}, which cannot be selected: "select" takes a tab, a radio button, a menu entry, or a table or grid row with "row". Use "set" for a field, "check" for a checkbox, "dblclick" for a list entry, "focus" to put the cursor on it.`,
          );
        return this.run({ do: doing, id }, `${doing} ${id}`, timeoutMs);
      }
      case "focus":
      case "f4":
        return this.run({ do: doing, id }, `${doing} ${id}`, timeoutMs);
      case "check": {
        const value = action.value === undefined ? true : action.value === true || action.value === "true" || action.value === "x" || action.value === "X" || action.value === 1;
        if (target.type !== "GuiCheckBox" && target.type !== "GuiRadioButton") throw new ActionError(`${id} is a ${target.type}, not a checkbox.`);
        return this.run({ do: "check", id, value }, `${value ? "checked" : "unchecked"} ${id}`, timeoutMs);
      }
      case "combo": {
        // A dropdown in a table control's cell, by row and column (live, FB50's D/C column, 2026-11-25).
        if (target.type === "GuiTableControl")
          return this.tableAct(target, action, (cell) => {
            const { row: _row, col: _col, ...rest } = action;
            return this.act({ ...rest, id: cell.id });
          }, timeoutMs);
        if (target.type !== "GuiComboBox") throw new ActionError(`${id} is a ${target.type}, not a dropdown.`);
        const entries = target.entries ?? [];
        // No key: the entries, and nothing is chosen.
        if (action.key === undefined && action.value === undefined)
          return entries.length ? `${id} has ${entries.length} entries: ${entries.map(([k, v]) => `${k.trim()}:${v.trim()}`).join(", ")}` : `${id} has no entries`;
        // By key, or by the text the dropdown shows.
        const wanted = String(action.key ?? action.value ?? "");
        const key = entries.find(([k]) => k === wanted) ?? entries.find(([k]) => k.trim() === wanted.trim()) ?? entries.find(([, v]) => v.trim().toLowerCase() === wanted.trim().toLowerCase());
        if (entries.length && !key) throw new ActionError(`No entry "${wanted}" in ${id}. Entries: ${entries.map(([k, v]) => `${k.trim()}:${v.trim()}`).join(", ")}`);
        return this.run({ do: "combo", id, key: key?.[0] ?? wanted }, `combo ${id} = "${(key?.[0] ?? wanted).trim()}"`, timeoutMs);
      }
      case "dblclick":
        if (action.node !== undefined) return this.act({ ...action, do: "tree", how: "double" });
        if (action.row !== undefined) return this.act({ ...action, do: "grid", how: "double" });
        return this.run({ do: "dblclick", id }, `double-click ${id}`, timeoutMs);
      case "tree": {
        if (action.node === undefined) throw new ActionError('tree needs "node": the key shown as {node <key>}');
        const how = action.how ?? "double";
        if (!["double", "select", "expand", "collapse"].includes(how)) throw new ActionError('tree "how" is double, select, expand or collapse');
        return this.run({ do: "tree", id, node: String(action.node), how, ...(action.col ? { col: action.col } : {}) }, `tree ${how} node ${String(action.node).trim()} in ${id}`, timeoutMs);
      }
      case "grid": {
        if (target.type === "GuiTableControl") {
          // A table control is no ALV grid: its rows are selected by their row selector, its cells are controls.
          const how = action.how ?? "double";
          if (how === "select") return this.selectRow(target, action.row, true, timeoutMs);
          if (!["double", "cell"].includes(how)) throw new ActionError('grid "how" is double, select or cell');
          return this.tableAct(target, action, (cell) => this.run({ do: how === "cell" ? "focus" : "dblclick", id: cell.id }, `${how === "cell" ? "cursor on" : "double-click"} ${cell.id}`, timeoutMs), timeoutMs);
        }
        if (!isRow(action.row) || typeof action.col !== "string") throw new ActionError('grid needs "row" (a number from 0, from "row N:") and "col" (column id, e.g. "VBELN")');
        const how = action.how ?? "double";
        // "cell": the cursor on the cell, nothing opened or selected (as on a table control).
        if (!["double", "select", "cell"].includes(how)) throw new ActionError('grid "how" is double, select or cell');
        const col = target.type === "GuiShell" && target.sub === "GridView" ? gridColumn(target, action.col) : action.col;
        return this.run({ do: "grid", id, row: action.row, col, how }, `grid ${how} row ${action.row}, column ${action.col} in ${id}`, timeoutMs);
      }
      case "scroll":
        return this.scroll(target, (action.to ?? "next") as number | string, timeoutMs);
      case "toolbar":
      {
        if (typeof action.button !== "string") throw new ActionError('toolbar needs "button": the id shown as {<id>}');
        // A menu button: "value" is the entry to choose; without it the answer is the menu's entries.
        const entry = action.value === undefined || action.value === "" ? undefined : String(action.value);
        this.last = undefined;
        this.treeFrom = {};
        const r = await this.ask<{ menu?: [string, string][] }>("act", { action: { do: "toolbar", id, button: action.button, ...(entry ? { menu: entry } : {}) } }, timeoutMs);
        if (r?.menu)
          return r.menu.length
            ? `${action.button} in ${id} is a menu: ${r.menu.map(([, t]) => t).join(", ")}. Choose one with "value", e.g. {"do":"toolbar","id":"${id}","button":"${action.button}","value":"${r.menu[0]?.[1]}"}.`
            : `${action.button} in ${id} is a menu, and SAP GUI gave none of its entries.`;
        return entry ? `toolbar button ${action.button} in ${id}, menu entry "${entry}"` : `toolbar button ${action.button} in ${id}`;
      }
      default:
        throw new ActionError(`Unknown action "${doing}". SAP GUI takes: set, press, key, select, check, combo, okcode, f4, focus, dblclick, tree, grid, toolbar, scroll.`);
    }
  }

  /** Selects (or unselects) a table control's row, by its number from the table's first row. */
  private async selectRow(table: Control, row: unknown, on: boolean, timeoutMs: number): Promise<string> {
    if (!isRow(row)) throw new ActionError(`"row" is a row number from 0, counted from the table's first row, e.g. {"do":"select","id":"${table.id}","row":0}`);
    const total = table.rowCount;
    if (typeof total === "number" && (row as number) >= total) throw new ActionError(`row ${row}: ${table.id} has ${total} rows (0 to ${total - 1}).`);
    return this.run({ do: "selectrow", id: table.id, row, value: on }, `${on ? "selected" : "unselected"} row ${row} of ${table.id}`, timeoutMs);
  }

  /** Finds a table control's cell by row and column, scrolling the row into view first when needed, and acts on it. */
  private async tableAct(table: Control, action: Action, then: (cell: Control) => Promise<string>, timeoutMs: number): Promise<string> {
    if (action.row === undefined || action.col === undefined)
      throw new ActionError(`${table.id} is a table: give "row" (from 0) and "col" (field name or column title), or the cell's own id from sap_look (e.g. ${table.id}/txt<FIELD>[col,row]).`);
    const row = Number(action.row);
    let screen = await this.screen(true);
    let current = this.strict(screen, table.id) ?? table;
    let found = tableCell(screen, current, row, action.col);
    if ("scroll" in found) {
      await this.scroll(current, row, timeoutMs);
      screen = await this.screen();
      current = this.strict(screen, table.id) ?? current;
      found = tableCell(screen, current, row, action.col);
      if ("scroll" in found) throw new ActionError(`row ${row} of ${table.id} could not be scrolled into view.`);
    }
    return then(found.cell);
  }

  private async run(action: Record<string, unknown>, note: string, timeoutMs = ACT_MS): Promise<string> {
    const prior = this.last;
    this.last = undefined;
    const local = prior && Date.now() - prior.at < FRESH_MS ? typed(prior.screen, action) : undefined;
    // Another screen may follow: a tree's paging belongs to the screen it was asked on.
    if (!local) this.treeFrom = {};
    await this.ask("act", { action }, timeoutMs);
    // Typing into a field or moving the cursor stays in SAP GUI: the screen is the one read, with that change.
    if (local) this.last = { at: Date.now(), screen: local, typed: true };
    return note;
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.ask<{ png: string }>("screenshot");
    return Buffer.from(r.png, "base64");
  }

  async close(): Promise<void> {
    // The host is shared by every session of the surface and stops with the server.
  }
}

const OPTIONS = 'SAP Logon > Options > Accessibility & Scripting > Scripting';

function setting(local: DoctorLocal, name: string): { value: number | undefined; where: string } {
  const s = local.settings[name];
  return { value: s?.value, where: s ? (s.where === "HKLM" ? " (set for the whole machine by an administrator)" : "") : " (not set: SAP GUI's default)" };
}

const POLICY_HELP =
  "The host script calls SAP GUI's COM objects, which needs PowerShell's Full Language mode. Ask your IT team to allow this server's script (an AppLocker or App Control rule for its folder, or for its publisher once it is signed), or use Web GUI or Fiori in Chrome, which need no PowerShell";

/** What a Windows policy does to the PowerShell host, as a doctor line; undefined when PowerShell could not be asked and the host itself must tell. */
export function policyCheck(p: PowershellPolicy): { ok: boolean; check: string; detail: string } | undefined {
  const check = "PowerShell may run the host";
  const locker = p.appLocker ? " AppLocker is active on this machine (its service AppIDSvc is running)." : "";
  if (p.languageMode === "FullLanguage") return { ok: true, check, detail: `Full Language mode${p.appLocker ? "; AppLocker is active and allows it" : ""}` };
  if (p.languageMode) return { ok: false, check, detail: `PowerShell runs in ${p.languageMode.replace(/Language$/, " Language")} mode: a Windows policy (AppLocker or App Control) restricts scripts.${locker} ${POLICY_HELP}` };
  if (/blocked by group policy|AppLocker|Software Restriction|EPERM|EACCES|Access is denied/i.test(p.error ?? ""))
    return { ok: false, check, detail: `Windows blocked powershell.exe (${p.error}): AppLocker or a software restriction policy stops it. ${POLICY_HELP}` };
  return undefined;
}

export async function doctor(host: Transport, policy: () => Promise<PowershellPolicy | undefined> = async () => undefined): Promise<{ ok: boolean; check: string; detail: string }[]> {
  const out: { ok: boolean; check: string; detail: string }[] = [];
  // First what Windows lets PowerShell do: under a restricting policy the host script cannot even start.
  const allowed = await policy()
    .then((p) => (p ? policyCheck(p) : undefined))
    .catch(() => undefined);
  if (allowed) out.push(allowed);
  if (allowed && !allowed.ok) return out;
  let local: DoctorLocal;
  try {
    local = await host.request<DoctorLocal>("doctor-local", {}, 30_000);
  } catch (e) {
    return [...out, { ok: false, check: "PowerShell host", detail: `${(e as Error).message}. The server talks to SAP GUI through Windows PowerShell 5.1 (powershell.exe); it must be allowed to run.` }];
  }
  if (!allowed && local.languageMode && local.languageMode !== "FullLanguage")
    out.push({ ok: false, check: "PowerShell may run the host", detail: `PowerShell runs in ${local.languageMode} mode. ${POLICY_HELP}` });
  const running = local.processes.length > 0;
  out.push({
    ok: running,
    check: "SAP GUI is running",
    detail: running ? local.processes.join(", ") : "not running: start SAP Logon and log on to a system",
  });

  const scripting = setting(local, "UserScripting");
  const attach = setting(local, "WarnOnAttach");
  const connection = setting(local, "WarnOnConnection");

  let engine: DoctorEngine | undefined;
  let engineError = "";
  if (running) {
    try {
      engine = await host.request<DoctorEngine>("doctor-engine", {}, 30_000);
    } catch (e) {
      engineError = (e as Error).message;
    }
  }
  const clientOn = scripting.value !== 0 && (!running || engine?.engine === true);
  out.push({
    ok: clientOn,
    check: "Scripting is on in SAP GUI",
    detail:
      scripting.value === 0
        ? `off${scripting.where}: tick "Enable scripting" in ${OPTIONS}, then restart SAP Logon`
        : !running
          ? `on${scripting.where}; not checked against SAP GUI, which is not running`
          : engine?.engine
            ? `on${scripting.where}`
            : `SAP GUI does not offer its scripting object (${engineError || engine?.error || "no reason given"}): tick "Enable scripting" in ${OPTIONS}, restart SAP Logon, and run this server as the same Windows user, in the same desktop session, not as administrator`,
  });

  const cons = engine?.connections ?? [];
  const visible = cons.reduce((n, c) => n + c.sessions, 0);
  const blocked = cons.filter((c) => c.disabledByServer || c.sessions === 0);
  out.push({
    ok: visible > 0 && blocked.length === 0,
    check: "Scripting is allowed on the SAP system",
    detail: !engine?.engine
      ? "not checked: SAP GUI scripting is not reachable"
      : !cons.length
        ? "no SAP system is logged on: log on in SAP Logon"
        : blocked.length
          ? `${blocked.map((c) => c.description || "a connection").join(", ")}: no session is visible to scripting. Set profile parameter sapgui/user_scripting = TRUE on that system (transaction RZ11, and the default profile to keep it), then log on again`
          : `${visible} session(s) on ${cons.map((c) => c.description || "a connection").join(", ")}`,
  });

  const notice = (s: { value: number | undefined; where: string }, check: string, box: string) =>
    out.push({
      ok: s.value === 0,
      check,
      detail: s.value === 0 ? `off${s.where}` : `on${s.where}: SAP GUI then shows a dialog and waits for a click each time. Untick "${box}" in ${OPTIONS}`,
    });
  notice(attach, 'Notice "a script is attaching" is off', "Notify when a script attaches to SAP GUI");
  notice(connection, 'Notice "a script opens a connection" is off', "Notify when a script opens a connection");
  return out;
}

export function sapguiSurface(env: Record<string, string | undefined>, options: SapguiOptions = {}): Surface {
  const windows = (options.platform ?? process.platform) === "win32";
  let host = options.transport;
  const transport = (): Transport => (host ??= new PsHost(env));
  return {
    name: "sapgui",
    async discover() {
      if (!windows) return [];
      let facts: SessionsFacts;
      try {
        facts = await transport().request<SessionsFacts>("sessions", {}, READ_TIMEOUT_MS);
      } catch (e) {
        // No SAP GUI open is not an error: the user may only work in a browser.
        if (e instanceof HostError && e.code === "NO_SAPGUI") return [];
        // SAP GUI is open and gives no scripting object: the user must know, or the answer reads "no SAP session".
        if (e instanceof HostError && (e.code === "SCRIPTING_OFF" || e.code === "NO_ENGINE")) throw new Error(SCRIPTING_OFF);
        throw e;
      }
      // Connections are open, yet scripting sees no session: the SAP system does not allow it.
      const visible = facts.connections.reduce((n, c) => n + c.sessions.length, 0);
      if (!visible && facts.connections.length) throw new Error(SCRIPTING_OFF);
      const out: SessionInfo[] = [];
      for (const con of facts.connections)
        con.sessions.forEach((s, i) => {
          const n = s.sessionNumber || i + 1;
          // A connection opened by connection string has no description: name it by its system.
          const name = con.description || (s.system ? `${s.system}${s.client ? ` (${s.client})` : ""}` : con.id);
          out.push(sessionInfo(s, `SAP GUI ${name}, session ${n}`));
        });
      // The session the user is in comes first: the registry makes the first one active.
      const active = PREFIX + facts.active;
      return [...out.filter((s) => s.id === active), ...out.filter((s) => s.id !== active)];
    },
    async open(session) {
      if (!windows) throw new Error("SAP GUI for Windows needs Windows.");
      return new SapguiDriver(session, transport());
    },
    async doctor() {
      if (!windows)
        return [{ ok: false, check: "SAP GUI for Windows", detail: "needs Windows: run the server on the Windows machine where SAP GUI is open (Web GUI and Fiori work everywhere)" }];
      return doctor(transport(), () => powershellPolicy(env));
    },
    async close() {
      await host?.close();
    },
  };
}
