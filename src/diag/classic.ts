/**
 * The classic part of a screen: what the DIAG items of a server message say
 * about windows, fields, tabs, table controls, lists, menus and keys.
 *
 * The server describes a screen as a flat run of items. A window starts with
 * a window-start item; what follows belongs to it. Screen elements come in
 * element lists (id 09, sub-id 02; 10 for the buttons of a tabstrip), each
 * list preceded by the chain of areas it sits in (id 0a: a reset, then
 * subscreen, tabstrip, tab page, table or control, each with its origin and
 * size relative to the one before, and its name). An element's row and
 * column are relative to the innermost area, so the absolute position is the
 * sum along the chain.
 *
 * The element types, attribute bits and layouts below are those of the
 * captured traffic (six ECC screens and two later sessions: 56 element lists,
 * 2,104 elements, each list ending exactly at its length). Element types
 * not seen there are read as "other" with their readable text, and counted
 * in the notes.
 */
import type { DiagArea, DiagContainer, DiagElement, DiagKey, DiagList, DiagListRow, DiagMenuEntry, DiagScroll, DiagSession, DiagStatus, DiagTab, DiagTable, DiagTableCell, DiagTabstrip } from "./screen.js";
import { bagTooltip, clean, cstringAt, cstrings, decode, iconText, keyName } from "./text.js";
import { type DiagItem, hasId, ID, ITEM, itemKey, UNREAD_IDS } from "./wire.js";

/**
 * Element types (byte 4 of an element), named by what they become in the
 * screen model. How each was told apart, in the captures:
 * - inputField 130, outputField 131, label 132: the same text layout; the
 *   texts of 132 are the labels SAP GUI shows, 131 are never editable;
 * - name 114 follows another element (894 times, never first in a list) and
 *   holds a field name such as "VBAK-AUART"; tooltip 120 follows a name and
 *   holds an XML bag with the tooltip;
 * - button 115 holds a function code ("=SAVE"); tab 116 comes only in the
 *   tab lists of tabstrips (sub-id 10, 74 times); box 127 holds a height, a
 *   width and a frame title;
 * - checkbox 128 and radio 129 start with the state ("X" or blank): the
 *   128 is a checkbox as SAP GUI scripting shows the same screen, the 129 come as a pair of which
 *   exactly one is "X"; dropdown 126 holds the 32-character id of its value
 *   list;
 * - cellCheckbox 124 is seen only in the cell descriptions of table
 *   controls, for the columns scripting lists as checkboxes.
 */
const EL = { name: 114, button: 115, tab: 116, tooltip: 120, cellCheckbox: 124, dropdown: 126, box: 127, checkbox: 128, radio: 129, inputField: 130, outputField: 131, label: 132 } as const;

/**
 * Attribute bits (byte 12 of an element, byte 6 of a table cell
 * description), checked against what SAP GUI scripting reads of the six screens.
 * readOnly: set on every label and output field; of the input fields, on
 * 36 of the 38 scripting shows read-only and on none of the 12 it shows
 * editable. hidden: the password field of the logon screen (its tooltip
 * says so), and every cell of the item table's second line, which scripting
 * does not list. valueHelp: set only on fields with a value help (8 of
 * 8; not every field with a value help has it).
 */
const BIT = { readOnly: 0x01, hidden: 0x02, valueHelp: 0x10 } as const;

const FIELDS = new Set<number>([EL.inputField, EL.outputField, EL.label]);

interface Level extends DiagArea {
  kind: "subscreen" | "tabstrip" | "page" | "table" | "control" | "block";
  name: string;
  /** Where its content is scrolled to, when it is larger than its area. */
  firstRow?: number;
  firstCol?: number;
}

/**
 * Sub-ids of the area items, by what follows them in the captures: 03 is
 * named with a program and a screen number (a subscreen); 08 is followed by
 * the tabstrip description and its tab buttons; 09 comes after a tabstrip
 * and holds the open tab's content; 05 is followed by a table control's
 * description; 0a by the description of a custom control. 04 (three times,
 * with an element list inside) only moves its elements.
 */
const LEVELS = new Map<number, Level["kind"]>([
  [0x03, "subscreen"],
  [0x04, "block"],
  [0x05, "table"],
  [0x08, "tabstrip"],
  [0x09, "page"],
  [0x0a, "control"],
]);

/** A window while the server describes it. */
export interface WindowState {
  index: number;
  modal: boolean;
  title: string;
  program: string;
  dynpro: string;
  guiStatus: string;
  guiStatusProgram: string;
  size: { rows: number; cols: number };
  windowSize?: { rows: number; cols: number };
  position?: { row: number; col: number };
  scroll?: DiagScroll;
  menus: DiagMenuEntry[];
  toolbar: DiagKey[];
  keys: DiagKey[];
  elements: DiagElement[];
  tabstrips: DiagTabstrip[];
  tables: DiagTable[];
  list?: DiagList;
  containers: DiagContainer[];
  focus?: { row: number; col: number; name?: string };
}

function newWindow(index: number): WindowState {
  return { index, modal: index > 0, title: "", program: "", dynpro: "", guiStatus: "", guiStatusProgram: "", size: { rows: 0, cols: 0 }, menus: [], toolbar: [], keys: [], elements: [], tabstrips: [], tables: [], containers: [] };
}

/** A dropdown's content: the 32-character id of its value list, then the selected key. */
function comboValue(s: string, codeLength = 0): { key: string; valueList?: string; fcode?: string } {
  const m = /([0-9A-F]{32})([\s\S]*)$/.exec(s);
  if (!m) return { key: s.replace(/[\x00-\x1f]/g, "").trim() };
  let rest = m[2] ?? "";
  let fcode: string | undefined;
  if (codeLength > 1 && rest.startsWith("=")) {
    fcode = rest.slice(1, codeLength).trim();
    rest = rest.slice(codeLength);
  }
  return { key: clean(rest).trim(), valueList: m[1] as string, ...(fcode ? { fcode } : {}) };
}

/**
 * Where each column of a table control starts, and whether it is on show: after the row selector, one cell
 * between columns, in the order shown. Scrolled sideways (`firstColumn`), the fixed columns stay and the
 * others start at that one; those between are out of view.
 */
export function layoutColumns(table: DiagTable): void {
  const order = [...table.columns].sort((a, b) => a.position - b.position);
  const fixed = table.fixedColumns ?? 0;
  const first = table.firstColumn && table.firstColumn > fixed ? table.firstColumn : 0;
  let col = table.col + 2;
  order.forEach((c, i) => {
    c.col = col;
    // Scrolled sideways, only the fixed columns are taken as on show: where SAP GUI draws the others was right
    // for FB50 and wrong for ME21N (a click typed into Handover Location), so they are reached with Tab.
    if (first && i >= fixed) {
      c.visible = false;
      if (i < first) return;
    } else c.visible = table.width === 0 || col + c.width <= table.col + table.width;
    col += c.width + 1;
  });
}

/** Table control while its items arrive. */
interface TableBuild {
  table: DiagTable;
  /** Cell descriptions by their id (the first two bytes of each): element type and attributes per column. SAP sends a description once and names it in each row that uses it. */
  refs: Map<number, { etype: number; attr: number }[]>;
  /** The description sent last, for a row that names none. */
  lastRefs?: { etype: number; attr: number }[];
  /** The row about to come: its line on show (1-based) and the id of its cell description. */
  line?: { index: number; refs: number };
  /** The first line on show (0-based), from the table's scrolling item. */
  firstRow: number;
}

export class ClassicState {
  session: DiagSession = {};
  windows: WindowState[] = [];
  message: DiagStatus | undefined;
  /** UTF-8 unless the server says the session runs in a single-byte code page. */
  utf8 = true;
  /** Counts a screen change: goes up each time the server starts a window anew. */
  revision = 0;
  /** Per window: the revision at which its menus, keys and GUI status were last sent (they are carried over while unchanged). */
  readonly chromeSent = new WeakMap<WindowState, number>();

  private cur: WindowState | undefined;
  private path: Level[] = [];
  private last: DiagElement | undefined;
  private build: TableBuild | undefined;
  /** The windows as they were before the last window start: a popup sent again as an update finds itself there. */
  private closed: WindowState[] = [];
  /** Parts of the window kept from its last sending, while SAP sends only what changed: replaced by what comes at their place. */
  private carried = new Set<unknown>();
  private listPos: { row: number; col: number } | undefined;
  private listFormat: Buffer | undefined;
  private listWidth = 0;
  /** What the next scrolling item (sub-id 02 of the window id) is about. */
  private scrollOf: "table" | "list" | undefined;
  /** Called when the server ends an internal mode (session sub-id 15), with its number (sub-id 0a of the same message). */
  modeEnded?: (internalMode: number) => void;

  constructor(private readonly note: (what: string) => void) {}

  /** The window the items now describe; the main window when the server named none yet. */
  private win(): WindowState {
    if (!this.cur) {
      this.cur = this.windows[0] ?? newWindow(0);
      this.windows[0] = this.cur;
    }
    return this.cur;
  }

  private text(b: Uint8Array): string {
    return decode(b, this.utf8);
  }

  /** Absolute origin of the innermost container, and the rectangle its content is cut to (end exclusive). */
  private origin(): { row: number; col: number; top: number; left: number; bottom: number; right: number } {
    let row = 0;
    let col = 0;
    let top = 0;
    let left = 0;
    let bottom = Number.MAX_SAFE_INTEGER;
    let right = Number.MAX_SAFE_INTEGER;
    for (const l of this.path) {
      row += l.row;
      col += l.col;
      top = Math.max(top, row);
      left = Math.max(left, col);
      if (l.height) bottom = Math.min(bottom, row + l.height);
      if (l.width) right = Math.min(right, col + l.width);
      row -= l.firstRow ?? 0;
      col -= l.firstCol ?? 0;
    }
    return { row, col, top, left, bottom, right };
  }

  private names(): string[] {
    return this.path.map((l) => l.name).filter(Boolean);
  }

  /** Applies the items of one message, or of an inner stream, in order. RFC items are the caller's. */
  apply(items: DiagItem[]): void {
    for (const it of items) {
      try {
        this.item(it);
      } catch (e) {
        this.note(`item ${itemKey(it)} not read: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * The values SAP GUI sends with a request: element lists in the areas of the window on top, the fields the
   * user typed into with their new text. They become the text of the fields at those places, so that a field
   * SAP later sends again without its text keeps what the user typed (elementList).
   */
  clientValues(items: DiagItem[]): void {
    const w = this.windows[this.windows.length - 1];
    if (!w) return;
    const path = this.path;
    this.path = [];
    try {
      for (const it of items) {
        if (!hasId(it.type)) continue;
        if (it.id === ID.area) {
          if (it.sid === 0x01) this.path = [];
          const kind = LEVELS.get(it.sid);
          if (kind && it.value.length >= 9) this.path.push({ kind, name: "", row: it.value.readUInt16BE(1), col: it.value.readUInt16BE(3), width: it.value.readUInt16BE(5), height: it.value.readUInt16BE(7) });
        } else if (it.id === ID.screen && it.sid === 0x02) this.clientElements(w, it.value);
      }
    } catch (e) {
      this.note(`values from SAP GUI not read: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.path = path;
    }
  }

  private clientElements(w: WindowState, v: Buffer): void {
    const o = this.origin();
    for (let i = 0; i + 13 <= v.length; ) {
      const n = v.readUInt16BE(i);
      if (n < 13 || i + n > v.length) return;
      const a = v.subarray(i, i + n);
      i += n;
      const etype = a[4] ?? 0;
      const body = a.subarray(13);
      if ((etype !== EL.inputField && etype !== EL.outputField) || body.length < 6) continue;
      const row = o.row + a.readUInt16BE(8);
      const col = o.col + a.readUInt16BE(10);
      const e = w.elements.find((x) => x.kind === "field" && x.input && !x.hidden && x.row === row && x.col === col);
      if (e) e.text = clean(this.text(body.subarray(6, 6 + (body[2] ?? 0)))).trim();
    }
  }

  /** A new step begins: the status bar of the last one is gone. */
  clearMessage(): void {
    this.message = undefined;
  }

  private item(it: DiagItem): void {
    const v = it.value;
    if (it.type === ITEM.windowStart) return this.windowStart(v);
    if (it.type === ITEM.end || it.type === ITEM.xml) return;
    if (it.type === ITEM.listStart) {
      this.scrollOf = "list";
      return;
    }
    if (it.type === ITEM.listPosition) {
      this.listPos = { row: v[0] ?? 0, col: v[1] ?? 0 };
      return;
    }
    if (it.type === ITEM.listFormat) {
      this.listFormat = v;
      return;
    }
    if (it.type === ITEM.listWidth) {
      this.listWidth = v.readUInt16BE(0);
      return;
    }
    if (!hasId(it.type)) return this.note(`item ${itemKey(it)}`);
    if (UNREAD_IDS.has(it.id)) return;
    switch (it.id) {
      case ID.session:
        return this.sessionInfo(it.sid, v);
      case ID.user:
        if (it.sid === 0x1b) this.session.language = clean(this.text(v));
        else if (it.sid === 0x1c) this.session.user = clean(this.text(v));
        return;
      case ID.window:
        return this.windowInfo(it.sid, v);
      case ID.menu:
        return this.menu(it.sid, v);
      case ID.area:
        return this.area(it.sid, v);
      case ID.screen:
        return this.screenItem(it.sid, v);
      case ID.rfc:
        return;
      default:
        return this.note(`item ${itemKey(it)}`);
    }
  }

  /**
   * A window starts (16 bytes). Byte 7 is the window's number (0 the main
   * window, 1 a popup over it); byte 6 is 01 for the main window and 11 for
   * a popup, so 0x10 marks a modal one; bytes 14 and 15 are its rows and
   * columns (the main window: 20 and 156, the size the next window-size item
   * repeats). Bytes 8 and 9 are a popup's column and row: read the other way
   * round, a 24-row popup would start at row 24 of a 20-row window. With
   * rows and columns 0, the item only announces a session, not a screen.
   *
   * Example (synthetic): 01 | 00 00 00 00 00 00 11 01 18 03 00 00 00 00 0c 22
   * is popup 1 at column 24, row 3, of 12 rows and 34 columns.
   */
  private windowStart(v: Buffer): void {
    const rows = v[14] ?? 0;
    const cols = v[15] ?? 0;
    if (!rows && !cols) return;
    const index = v[7] ?? 0;
    const w = newWindow(index);
    w.modal = ((v[6] ?? 0) & 0x10) !== 0 || index > 0;
    w.windowSize = { rows, cols };
    w.size = { rows, cols };
    if (index > 0) w.position = { row: v[9] ?? 0, col: v[8] ?? 0 };
    // Menus, keys and GUI status are only sent when they change: a window sent again keeps them.
    // A popup sent again right after its main window was (an update of both) is found among those that one closed.
    const before = this.windows[index] ?? this.closed[index];
    if (before) {
      w.menus = before.menus;
      w.toolbar = before.toolbar;
      w.keys = before.keys;
      w.guiStatus = before.guiStatus;
      w.guiStatusProgram = before.guiStatusProgram;
    }
    this.chromeSent.set(w, before ? (this.chromeSent.get(before) ?? this.revision) : this.revision + 1);
    // Byte 6 without 0x01 on the main window: the same screen again with only what changed (SAP's answer to an
    // error on the screen: the input fields and the message, not the labels, frames and buttons). What is not
    // sent again stays as it was. Seen in a capture: VA03's first screen after "not in the database".
    this.carried = new Set();
    // Byte 6 without 0x01 on a popup (0x10): the same, for the popup (XD01's initial popup after SAP GUI's type-ahead call).
    if (((v[6] ?? 0) & 0x01) === 0 && before && (index === 0 || ((v[6] ?? 0) & 0x10) !== 0) && before.program && (index === 0 || before.modal)) {
      w.program = before.program;
      w.dynpro = before.dynpro;
      w.title = before.title;
      w.elements = [...before.elements];
      w.tabstrips = [...before.tabstrips];
      w.tables = [...before.tables];
      w.containers = [...before.containers];
      if (before.list) w.list = before.list;
      for (const x of [...w.elements, ...w.tabstrips, ...w.tables]) this.carried.add(x);
    }
    // A window replaces itself and closes those above it.
    this.closed = this.windows.slice(0);
    this.windows.length = Math.min(this.windows.length, index);
    while (this.windows.length < index) this.windows.push(newWindow(this.windows.length));
    this.windows[index] = w;
    this.cur = w;
    this.path = [];
    this.last = undefined;
    this.build = undefined;
    this.scrollOf = undefined;
    this.revision++;
    if (index === 0) this.message = undefined;
  }

  /** Session and screen facts, by sub-id; each was told by its value in the captures (a 3-letter system id, a 3-digit client, a transaction code, a program name...). */
  private sessionInfo(sid: number, v: Buffer): void {
    const s = () => clean(this.text(v));
    switch (sid) {
      case 0x02:
        this.session.system = s();
        return;
      case 0x03:
        this.session.host = s();
        return;
      case 0x07:
        this.session.tcode = s();
        return;
      case 0x0a:
        if (v.length >= 2) this.session.internalMode = v.readUInt16BE(0);
        return;
      case 0x15:
        // Empty, in a message of its own (header byte 5 = 2) where an internal mode ends: after /n, and when
        // a transaction is left for the menu. Its controls are gone in SAP GUI: those of the next transaction
        // reuse their shell ids (seen in a capture: VA03's 115..122, then VA05's 115 and 116).
        this.modeEnded?.(this.session.internalMode ?? 0);
        return;
      case 0x0b: {
        // "E: text": the type, a colon, the text.
        const m = /^([A-Z]): ?([\s\S]*)$/.exec(s());
        this.message = { ...this.message, type: m?.[1] ?? this.message?.type ?? "", text: (m ? (m[2] ?? "") : s()).trim() };
        return;
      }
      case 0x0c:
        this.session.client = s();
        return;
      case 0x0d:
      case 0x0e: {
        const w = this.win();
        const value = s();
        const before = sid === 0x0d ? w.program : w.dynpro;
        if (this.carried.size && before && value !== before) this.dropCarried(w);
        if (sid === 0x0d) w.program = value;
        else w.dynpro = value;
        return;
      }
      case 0x0f:
        this.win().guiStatusProgram = s();
        return;
      case 0x10:
        this.win().guiStatus = s();
        this.chromeSent.set(this.win(), this.revision);
        return;
      case 0x23: {
        // uint32 code page, a byte, then its number and name as strings: "4110", "utf-8".
        const parts = cstrings(v.subarray(5), false);
        this.session.codepage = parts[1] || parts[0] || String(v.readUInt32BE(0));
        const number = v.length >= 4 ? v.readUInt32BE(0) : 4110;
        this.utf8 = number === 4110;
        if (number === 4102 || number === 4103) this.note(`code page ${number} (UTF-16): texts are read as UTF-8, unverified`);
        return;
      }
      case 0x29:
        this.session.kernel = cstrings(v, false)[0] ?? "";
        return;
      default:
        return;
    }
  }

  private windowInfo(sid: number, v: Buffer): void {
    const i32 = (n: number) => (v.length >= 4 * n + 4 ? v.readInt32BE(4 * n) : 0);
    switch (sid) {
      case 0x02: {
        // Six uint32. After a list start the first is the number of lines of the list. After a table control's
        // description: its lines, columns, lines on show, first column, first line on show (0-based), and one not
        // read. Seen in a capture: VA02 scrolled to its second item gave 3, 109, 4, 0, 1, 0.
        if (this.scrollOf === "list") {
          const w = this.win();
          w.list ??= { rows: [] };
          w.list.totalRows = i32(0);
          // The third and fifth: the lines on show and the first one on show (ME2L's 54 lines came as 25 from 0, 25, 50).
          if (v.length >= 20) {
            w.list.visibleRows = i32(2);
            w.list.firstRow = i32(4);
          }
        } else if (this.scrollOf === "table" && this.build && v.length >= 20) {
          this.build.table.totalRows = i32(0);
          this.build.table.visibleRows = i32(2);
          this.build.firstRow = i32(4);
          // The sixth: the first column on show after the fixed ones when SAP GUI scrolled the table sideways
          // (FB50 scrolled to Assignment, its column 9, gave 9).
          if (v.length >= 24 && i32(5) > 0 && i32(5) < this.build.table.columns.length) {
            this.build.table.firstColumn = i32(5);
            layoutColumns(this.build.table);
          }
        }
        this.scrollOf = undefined;
        return;
      }
      case 0x03: {
        // The status bar message's type, message class and number, as strings ("I", class, "007").
        const parts = cstrings(v, this.utf8);
        const type = (parts[0] ?? "").trim();
        const id = (parts[1] ?? "").trim();
        const number = (parts[2] ?? "").trim();
        this.message = { type: type || this.message?.type || "", text: this.message?.text ?? "", ...(id ? { id } : {}), ...(number ? { number } : {}) };
        return;
      }
      case 0x06: {
        // Eight uint32 and a byte: rows, columns (twice), first row, first column, visible rows, visible columns.
        const level = this.path[this.path.length - 1];
        if (!level) this.win().scroll = { rows: i32(0), cols: i32(1), firstRow: i32(4), firstCol: i32(5), visibleRows: i32(6), visibleCols: i32(7) };
        else {
          // A subscreen or tab page larger than its area scrolls on its own.
          level.firstRow = i32(4);
          level.firstCol = i32(5);
        }
        return;
      }
      case 0x07: {
        const w = this.win();
        w.windowSize = { rows: i32(0), cols: i32(1) };
        w.size = { rows: i32(2), cols: i32(3) };
        return;
      }
      case 0x09:
        this.win().title = clean(this.text(v));
        return;
      case 0x0a:
        this.session.label = clean(this.text(v));
        return;
      case 0x0b:
        return this.listCell(v);
      default:
        return;
    }
  }

  private listCell(v: Buffer): void {
    const w = this.win();
    w.list ??= { rows: [] };
    const pos = this.listPos ?? { row: 0, col: 0 };
    const raw = this.text(v);
    const f = this.listFormat;
    // Frames of a list are cells of line-drawing codes ("0".."?" in SAP's frame font), sent with this format.
    const frame = f !== undefined && f[0] === 0x08 && f[2] === 0x08 && /^[0-9:;<=>?]+$/.test(raw);
    this.listFormat = undefined;
    if (frame) return;
    const it = iconText(raw);
    if (!it.text && !it.icon) return;
    let row: DiagListRow | undefined = w.list.rows[w.list.rows.length - 1];
    if (!row || row.row !== pos.row) {
      row = w.list.rows.find((r) => r.row === pos.row);
      if (!row) {
        row = { row: pos.row, cells: [] };
        w.list.rows.push(row);
      }
    }
    row.cells.push({ col: pos.col, text: it.text, width: this.listWidth || raw.length, ...(it.tooltip ? { tooltip: it.tooltip } : {}), ...(it.icon ? { icon: it.icon } : {}) });
  }

  /**
   * Menu items: sub-id 01 the menu bar, 02 the entries of its menus, 03 the
   * toolbar buttons, 04 the function keys. Each entry, as the 5,339 entries
   * of the captures show it: its own length (2 bytes; the entries fill the
   * item exactly), its place in the menu tree (4 bytes, one per level:
   * 02 01 00 00 is the first entry of the second menu), flags, the key
   * (100 for none), 12 bytes not read (the place or the key repeated, then
   * zeros), and three NUL-ended strings: text, accelerator letter, tooltip.
   * Flags: 0x02 the entry can be chosen; 0x08 in a menu, a separator (all
   * 356 have no text); 0x10 in a menu, the entry has a key (the 346 with it
   * have a key other than 100, the 4,008 without have 100).
   *
   * Example (synthetic): 00 1d | 01 00 00 00 | 02 | 64 | 00 x 12 | "Order" 00 "O" 00 00
   */
  private menu(sid: number, v: Buffer): void {
    const w = this.win();
    const entries: { path: number[]; flags: number; vkey: number; text: string; accel: string; info: string }[] = [];
    let i = 0;
    while (i + 20 <= v.length) {
      const n = v.readUInt16BE(i);
      if (n < 20 || i + n > v.length) break;
      const e = v.subarray(i, i + n);
      const strings = cstrings(e.subarray(20), this.utf8);
      entries.push({ path: [...e.subarray(2, 6)].filter((x) => x > 0), flags: e[6] ?? 0, vkey: e[7] ?? 0, text: strings[0] ?? "", accel: strings[1] ?? "", info: strings[2] ?? "" });
      i += n;
    }
    this.chromeSent.set(w, this.revision);
    if (sid === 0x01 || sid === 0x02) {
      if (sid === 0x01) w.menus = [];
      for (const e of entries) {
        const node: DiagMenuEntry = { path: e.path, text: e.text, accelerator: e.accel, enabled: (e.flags & 0x02) !== 0, separator: (e.flags & 0x08) !== 0, children: [], ...((e.flags & 0x10) !== 0 && sid === 0x02 ? { vkey: e.vkey } : {}) };
        let level = w.menus;
        for (const p of e.path.slice(0, -1)) {
          const parent = level.find((m) => m.path[m.path.length - 1] === p);
          if (!parent) break;
          level = parent.children;
        }
        level.push(node);
      }
      return;
    }
    const keys: DiagKey[] = entries.map((e) => {
      const it = iconText(e.text);
      return { vkey: e.vkey, key: keyName(e.vkey), text: it.text, tooltip: e.info.trim() || it.tooltip || "", icon: it.icon ?? "", enabled: (e.flags & 0x02) !== 0 };
    });
    if (sid === 0x03) w.toolbar = keys;
    else if (sid === 0x04) w.keys = keys;
  }

  /**
   * Area items: 01 empties the chain; 06 names the last area ("name", then
   * program and screen number for a subscreen, NUL-ended); the others add an
   * area of 9 bytes: a byte (1), then row, column, width and height (2 bytes
   * each, relative to the area before).
   *
   * Example (synthetic): 10 0a 03 00 09 | 01 00 04 00 02 00 5a 00 08 is a
   * subscreen at row 4, column 2, 90 wide, 8 high.
   */
  private area(sid: number, v: Buffer): void {
    if (sid === 0x01) {
      this.path = [];
      this.build = undefined;
      return;
    }
    if (sid === 0x06) {
      const level = this.path[this.path.length - 1];
      if (!level) return;
      const [name = "", program = "", dynpro = ""] = cstrings(v, this.utf8);
      level.name = level.kind === "subscreen" && program ? `${name}:${program}:${dynpro}` : name;
      if (level.kind === "control") {
        const o = this.origin();
        const w = this.win();
        if (!w.containers.some((c) => c.name === name)) w.containers.push({ name, row: o.row, col: o.col, width: level.width, height: level.height, path: this.names().slice(0, -1) });
      }
      return;
    }
    const kind = LEVELS.get(sid);
    if (!kind || v.length < 9) return;
    this.path.push({ kind, name: "", row: v.readUInt16BE(1), col: v.readUInt16BE(3), width: v.readUInt16BE(5), height: v.readUInt16BE(7) });
  }

  /** Screen element items, by sub-id. */
  private screenItem(sid: number, v: Buffer): void {
    switch (sid) {
      case 0x02:
        return this.elementList(v, false);
      case 0x10:
        return this.elementList(v, true);
      case 0x0f:
        return this.tabstripHeader(v);
      case 0x0e:
        return this.tableHeader(v);
      case 0x0d: {
        const names = cstrings(v, this.utf8);
        this.build?.table.columns.forEach((c) => {
          c.name = names[c.index] ?? c.name;
        });
        return;
      }
      case 0x15: {
        const bags = cstrings(v, this.utf8);
        this.build?.table.columns.forEach((c) => {
          const tip = bagTooltip(bags[c.index] ?? "");
          if (tip) c.tooltip = tip;
        });
        return;
      }
      case 0x11: {
        // One description per cell of the next row: row 2, element type 1, three bytes, attributes 1, two bytes.
        const refs: { etype: number; attr: number }[] = [];
        for (let i = 0; i + 9 <= v.length; i += 9) refs.push({ etype: v[i + 2] ?? 0, attr: v[i + 6] ?? 0 });
        if (this.build) {
          if (v.length >= 2) this.build.refs.set(v.readUInt16BE(0), refs);
          this.build.lastRefs = refs;
        }
        return;
      }
      case 0x05:
        if (this.build && v.length >= 4) this.build.line = { index: v.readUInt16BE(0), refs: v.readUInt16BE(2) };
        return;
      case 0x08:
        return this.tableRow(v);
      case 0x0b: {
        // Focus: a kind byte, then row and column. Kept when an element is there; the forms for a table cell or a control are not read.
        if ((v[0] === 1 || v[0] === 2) && v.length >= 5) {
          const row = v.readUInt16BE(1);
          const col = v.readUInt16BE(3);
          const w = this.win();
          const el = w.elements.find((e) => e.row === row && e.col === col && e.kind !== "label" && e.kind !== "group");
          if (el) w.focus = { row, col, ...(el.name ? { name: el.name } : {}) };
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * An element list: elements one after the other, each with a 13-byte head
   * and a body whose layout depends on the element type:
   *
   *   bytes 0-1   the element's length, head included (the elements fill the list exactly)
   *   byte  2     flags; 0x40 on the open tab of a tabstrip
   *   byte  4     the element type (EL)
   *   bytes 8-9   row, relative to the innermost area
   *   bytes 10-11 column, likewise
   *   byte  12    attribute bits (BIT)
   *
   * Bytes 3 and 5 to 7 are not read (5 to 7 are 00 01 00 in almost all of
   * the 2,104 elements captured). The row and column were checked on the
   * logon screen: the labels "Client", "User", "Password", "Logon Language"
   * come at rows 0, 2, 3, 5 of their area, column 1.
   *
   * Example (synthetic, test/diag/build.ts `elem.label(2, 1, "Order Type")`):
   *
   *   00 20 00 00 84 00 01 00 00 02 00 01 01 | 00 00 0d 0d 00 0d "Order Type   "
   *
   * a label (0x84 = 132) at row 2, column 1, read-only, 13 characters.
   * A name (114) and a tooltip (120) belong to the element before them.
   */
  private elementList(v: Buffer, tabs: boolean): void {
    const w = this.win();
    const o = this.origin();
    const path = this.names();
    let strip = tabs ? w.tabstrips[w.tabstrips.length - 1] : undefined;
    if (tabs && (!strip || this.carried.has(strip))) {
      strip = this.newTabstrip();
      this.pushTabstrip(w, strip);
    }
    if (strip && this.tabsKept.has(strip)) {
      strip.tabs = [];
      this.tabsKept.delete(strip);
    }
    let lastTab: DiagTab | undefined;
    let i = 0;
    while (i + 13 <= v.length) {
      const n = v.readUInt16BE(i);
      if (n < 13 || i + n > v.length) {
        this.note("element list breaks off");
        break;
      }
      const a = v.subarray(i, i + n);
      i += n;
      const flags = a[2] ?? 0;
      const etype = a[4] ?? 0;
      const row = a.readUInt16BE(8);
      const col = a.readUInt16BE(10);
      const attr = a[12] ?? 0;
      const body = a.subarray(13);
      if (etype === EL.name) {
        const name = clean(this.text(body));
        if (lastTab) lastTab.name = name;
        else if (this.last) this.last.name = name;
        continue;
      }
      if (etype === EL.tooltip) {
        const tip = bagTooltip(this.text(body));
        if (tip && lastTab) lastTab.tooltip ??= tip;
        else if (tip && this.last) this.last.tooltip ??= tip;
        continue;
      }
      if (etype === EL.tab && strip) {
        // Width, height and one more byte, then where the function code, the text and the tab's id start, counted from the element's first byte.
        const fcodeAt = body.readUInt16BE(3);
        const textAt = body.readUInt16BE(5);
        const idAt = body.readUInt16BE(7);
        const it = iconText(clean(cstringAt(a, textAt, this.utf8, fcodeAt > textAt ? fcodeAt : a.length)));
        const before = strip.tabs.reduce((sum, t) => sum + t.text.length + 3, 0);
        lastTab = { id: cstringAt(a, idAt, this.utf8), name: "", text: it.text, fcode: cstringAt(a, fcodeAt, this.utf8).replace(/^=/, ""), active: (flags & 0x40) !== 0, index: strip.tabs.length, row: strip.row, col: strip.col + 1 + before, ...(it.icon ? { icon: it.icon } : {}), ...(it.tooltip ? { tooltip: it.tooltip } : {}) };
        strip.tabs.push(lastTab);
        this.last = undefined;
        continue;
      }
      lastTab = undefined;
      const el: DiagElement = { kind: "other", name: "", text: "", row: o.row + row, col: o.col + col, width: 0, input: (attr & BIT.readOnly) === 0, hidden: (attr & BIT.hidden) !== 0, path, etype };
      if ((attr & BIT.valueHelp) !== 0) el.valueHelp = true;
      if (el.row < o.top || el.row >= o.bottom || el.col < o.left || el.col >= o.right) el.scrolledOut = true;
      this.element(el, a, body);
      if (this.carried.size) {
        const at = w.elements.findIndex((x) => this.carried.has(x) && x.row === el.row && x.col === el.col);
        const old = w.elements[at];
        // In an update a label comes with no text (00 00 00 00 00 00): it keeps the text it had. So does a field
        // sent without its text (its length 0, the width given): SAP GUI keeps showing what it held (FB50 closes
        // its header fields after a warning and sends them so).
        if (old && FIELDS.has(etype) && !(body[2] ?? 0) && (etype === EL.label || (old.kind === "field" && !el.hidden))) {
          el.text = old.text;
          if (etype === EL.label || !el.width) el.width = old.width;
          if (old.icon) el.icon = old.icon;
          if (old.tooltip) el.tooltip = old.tooltip;
        }
        if (at >= 0) w.elements.splice(at, 1);
      }
      w.elements.push(el);
      this.last = el;
    }
    if (strip) this.markActiveTab(strip);
  }

  /** The body of one element, by its type. */
  private element(el: DiagElement, a: Buffer, body: Buffer): void {
    const etype = el.etype;
    if (FIELDS.has(etype)) {
      // Two bytes not read, the length of the text sent, the width shown, the maximum length (2 bytes), the text:
      // 00 00 03 03 00 03 "ABC" is a 3-character field holding "ABC"; the captured password field shows 12 of 40.
      if (body.length >= 6) {
        el.width = body[3] ?? 0;
        el.maxLength = body.readUInt16BE(4);
      }
      const raw = this.text(body.subarray(Math.min(6, body.length)));
      el.kind = etype === EL.label ? "label" : "field";
      if (el.kind === "label") {
        const it = iconText(clean(raw));
        el.text = it.text;
        if (it.icon) el.icon = it.icon;
        if (it.tooltip) el.tooltip = it.tooltip;
        el.input = false;
      } else {
        // A hidden field is a password or a field the screen does not show: its content stays out.
        el.text = el.hidden ? "" : clean(raw).trim();
        if (etype === EL.outputField) el.input = false;
        // An empty required field arrives as "?".
        if (el.input && el.text === "?") {
          el.text = "";
          el.required = true;
        }
      }
      if (!el.width) el.width = raw.length;
      return;
    }
    if (etype === EL.button) {
      // Width, height, then where the function code and the text start, counted from the element's first byte:
      // 08 01 00 1c 00 13 "Save    " 00 "=SAVE" 00 is an 8-wide button "Save" with function code SAVE.
      const fcodeAt = body.readUInt16BE(2);
      const textAt = body.readUInt16BE(4);
      const it = iconText(clean(cstringAt(a, textAt, this.utf8, fcodeAt > textAt ? fcodeAt : a.length)));
      el.kind = "button";
      el.width = body[0] ?? 0;
      el.text = it.text;
      if (it.icon) el.icon = it.icon;
      if (it.tooltip) el.tooltip = it.tooltip;
      el.fcode = cstringAt(a, fcodeAt, this.utf8).replace(/^=/, "");
      return;
    }
    if (etype === EL.box) {
      // Height and width (2 bytes each), then the title: 00 05 00 3c "Organizational Data".
      el.kind = "group";
      el.height = body.readUInt16BE(0);
      el.width = body.readUInt16BE(2);
      el.text = iconText(clean(this.text(body.subarray(4)))).text;
      el.input = false;
      return;
    }
    if (etype === EL.checkbox || etype === EL.radio) {
      // The state ("X" or blank), the width shown (2 bytes), 5 bytes that are 0 in every capture (not read),
      // the length of the text (2 bytes), the text: 58 00 04 00 00 00 00 00 00 04 "Done" is a ticked "Done".
      // A box with a function code (it sends a request when ticked) has the code's length at bytes 5 and 7, and the
      // text starts with it: 58 00 1e 00 00 03 00 03 00 1e "=C1Batch" is a ticked "Batch" with function code C1.
      el.kind = etype === EL.checkbox ? "checkbox" : "radio";
      el.checked = body[0] === 0x58;
      const length = body.length >= 10 ? body.readUInt16BE(8) : 0;
      let raw = this.text(body.subarray(10, 10 + length));
      const codeLength = body[5] ?? 0;
      if (codeLength > 1 && raw.startsWith("=")) {
        el.fcode = raw.slice(1, codeLength).trim();
        raw = raw.slice(codeLength);
      }
      const it = iconText(clean(raw));
      el.text = it.text;
      if (it.tooltip) el.tooltip = it.tooltip;
      el.width = (body.length >= 3 ? body.readUInt16BE(1) : 0) || el.text.length;
      return;
    }
    if (etype === EL.dropdown) {
      // Some bytes not read, then the 32-character id of the value list and the selected key.
      // Byte 7 is the length of a function code ("=MEDOCTYPE"), sent between the value list's id and the key.
      el.kind = "dropdown";
      const codeLength = body[7] ?? 0;
      const c = comboValue(decode(body, false), codeLength);
      if (c.fcode) el.fcode = c.fcode;
      el.key = c.key;
      el.text = c.key;
      if (c.valueList) el.valueList = c.valueList;
      el.width = el.key.length;
      return;
    }
    // A type not seen in the captures: the readable text, nothing more.
    el.text = iconText(this.text(body).replace(/[\x00-\x1f]+/g, " ").trim()).text;
    el.width = el.text.length;
    this.note(`element type ${etype}`);
  }

  /** The screen is another one after all: nothing of the last one stays. */
  private dropCarried(w: WindowState): void {
    w.elements = w.elements.filter((x) => !this.carried.has(x));
    w.tabstrips = w.tabstrips.filter((x) => !this.carried.has(x));
    w.tables = w.tables.filter((x) => !this.carried.has(x));
    w.containers = [];
    delete w.list;
    this.carried.clear();
  }

  private newTabstrip(): DiagTabstrip {
    const o = this.origin();
    const level = this.path[this.path.length - 1];
    return { name: level?.name ?? "", row: o.row, col: o.col, width: level?.width ?? 0, height: level?.height ?? 0, tabs: [], path: this.names().slice(0, -1) };
  }

  /**
   * A tabstrip's description (sub-id 0f), before its tab buttons. The
   * numbers at bytes 26, 28 and 30 say where its name (30 characters), the
   * id of its first tab and the id of the open tab start (32, 63 and 64 or
   * 68 in the captures, where the open tab's id is the one SAP GUI shows
   * open).
   */
  private tabstripHeader(v: Buffer): void {
    const w = this.win();
    const strip = this.newTabstrip();
    if (v.length >= 32) {
      const nameAt = v.readUInt16BE(26);
      const activeAt = v.readUInt16BE(30);
      if (nameAt < v.length) strip.name = clean(decode(v.subarray(nameAt, Math.min(nameAt + 30, v.length)), false)).trim() || strip.name;
      if (activeAt > nameAt && activeAt < v.length) this.activeTab.set(strip, cstringAt(v, activeAt, this.utf8));
    }
    this.pushTabstrip(w, strip);
  }

  /**
   * A tabstrip sent anew takes the place of the one kept from the last sending. In an update SAP may send
   * its description without its tab buttons (FB50 after a warning): it keeps the tabs it had, until a tab
   * list comes for it.
   */
  private pushTabstrip(w: WindowState, strip: DiagTabstrip): void {
    if (this.carried.size) {
      const old = w.tabstrips.find((x) => this.carried.has(x) && x.name === strip.name);
      if (old && !strip.tabs.length && old.tabs.length) {
        strip.tabs = old.tabs.map((t) => ({ ...t }));
        this.tabsKept.add(strip);
        this.markActiveTab(strip);
      }
      w.tabstrips = w.tabstrips.filter((x) => !(this.carried.has(x) && x.name === strip.name));
    }
    w.tabstrips.push(strip);
  }

  /** Tabstrips whose tabs were kept from the last sending: a tab list for them replaces those tabs. */
  private tabsKept = new WeakSet<DiagTabstrip>();

  private activeTab = new WeakMap<DiagTabstrip, string>();

  private markActiveTab(strip: DiagTabstrip): void {
    const id = this.activeTab.get(strip);
    if (id && strip.tabs.some((t) => t.id === id)) for (const t of strip.tabs) t.active = t.id === id;
    // The open page comes after the tabs: its area is taken when it does.
  }

  /**
   * A table control's description (sub-id 0e). As read from the captured
   * ones (two tables of a sales order): bytes 0-1 its length; 11 the number
   * of columns; 13 the number of lines, 15 how many are visible; 60-99 the
   * program, 100-129 the table's name; then the parts whose start it names
   * itself: at 17 the column numbers (1-based) in display order, at 29 the
   * column widths, at 48 the table's title (length at 52), at 50 the column
   * titles, NUL-ended. Each count and title matches the table SAP GUI shows.
   */
  private tableHeader(v: Buffer): void {
    const w = this.win();
    const o = this.origin();
    const level = this.path[this.path.length - 1];
    const u16 = (at: number) => (at + 2 <= v.length ? v.readUInt16BE(at) : 0);
    const count = u16(11);
    const table: DiagTable = { name: clean(decode(v.subarray(100, 130), false)).trim() || (level?.name ?? ""), program: clean(decode(v.subarray(60, 100), false)).trim(), title: "", row: o.row, col: o.col, width: level?.width || u16(6), height: level?.height || u16(8), columns: [], rows: [], totalRows: u16(13), visibleRows: u16(15), path: this.names().slice(0, -1) };
    const orderAt = u16(17) || 131;
    const widthsAt = u16(29) || orderAt + 2 * count + 2 * (count + 2);
    // A table without a title (ME23N's items) has 0 at 48: its column titles start right after the widths.
    const titleAt = u16(48);
    const titlesAt = u16(50);
    const position = new Map<number, number>();
    for (let p = 0; p < count; p++) position.set(u16(orderAt + 2 * p) - 1, p);
    const titleLength = u16(52) || (v[titleAt - 1] ?? 0);
    if (titleAt) table.title = iconText(clean(this.text(v.subarray(titleAt, Math.min(titleAt + titleLength, titlesAt > titleAt ? titlesAt : v.length))))).text;
    const titles = titlesAt > titleAt && titlesAt < v.length ? cstrings(v.subarray(titlesAt), this.utf8) : [];
    for (let c = 0; c < count; c++) {
      const it = iconText(clean(titles[c] ?? ""));
      table.columns.push({ index: c, position: position.get(c) ?? c, name: "", title: it.text, width: u16(widthsAt + 2 * c), col: 0, visible: false, ...(it.tooltip ? { tooltip: it.tooltip } : {}) });
    }
    // Bytes 15-16: the columns that stay on show when the table scrolls sideways (FB50's items: 5, the first five
    // SAP GUI shows left of its divider; VA01's: 2; MM03's view list, all of its columns).
    table.fixedColumns = Math.min(u16(15), count);
    layoutColumns(table);
    if (this.carried.size) w.tables = w.tables.filter((x) => !(this.carried.has(x) && x.name === table.name));
    w.tables.push(table);
    this.build = { table, refs: new Map(), firstRow: 0 };
    this.scrollOf = "table";
  }

  /**
   * One row of a table control (sub-id 08): NUL-separated strings, so many
   * per cell, by the cell's element type in the descriptions sent before
   * the row (sub-id 11, 9 bytes per cell: the line, the element type, three
   * bytes, the attribute bits, two bytes). An input or output field gives
   * its value, maximum length and one more string; a checkbox its state and
   * an empty string; a dropdown five strings, the id of its value list second
   * and the key fourth. Example (synthetic):
   * "10    \0" "6\0" "0\0" is a field of width 6 holding "10".
   *
   * A cell of any other element type (a push button in the row, a type not
   * in the captures) is never taken for a field: a button cell becomes a
   * button, anything else "other", with its first string as its text (the
   * strings it takes are not known: three are assumed, and noted).
   */
  private tableRow(v: Buffer): void {
    const b = this.build;
    if (!b) return;
    const refs = (b.line ? b.refs.get(b.line.refs) : undefined) ?? b.lastRefs ?? b.table.columns.map(() => ({ etype: EL.inputField, attr: BIT.readOnly }));
    const tokens = this.text(v).split("\0");
    const cells: DiagTableCell[] = [];
    let t = 0;
    refs.forEach((ref, column) => {
      const hidden = (ref.attr & BIT.hidden) !== 0;
      const input = (ref.attr & BIT.readOnly) === 0;
      if (ref.etype === EL.cellCheckbox) {
        const state = tokens[t] ?? "";
        t += 2;
        cells.push({ column, kind: "checkbox", text: "", checked: state === "X", input, hidden });
      } else if (ref.etype === EL.dropdown) {
        const key = (tokens[t + 3] ?? "").trim();
        const valueList = tokens[t + 1] ?? "";
        t += 5;
        cells.push({ column, kind: "dropdown", text: hidden ? "" : key, key: hidden ? "" : key, input, hidden, ...(valueList ? { valueList } : {}) });
      } else if (FIELDS.has(ref.etype)) {
        const text = (tokens[t] ?? "").trim();
        const maxLength = Number(tokens[t + 1] ?? "") || 0;
        t += 3;
        cells.push({ column, kind: "field", text: hidden ? "" : text, input: input && ref.etype !== EL.outputField, hidden, ...(maxLength ? { maxLength } : {}) });
      } else if (ref.etype === EL.button) {
        // A push button in the row: its function code ("=MEPO1211MSG"), then its text.
        const fcode = (tokens[t] ?? "").replace(/^=/, "").trim();
        const text = iconText((tokens[t + 1] ?? "").trim()).text;
        t += 2;
        cells.push({ column, kind: "button", text: hidden ? "" : text, input, hidden, ...(fcode ? { fcode } : {}) });
      } else {
        const text = iconText((tokens[t] ?? "").trim()).text;
        t += 3;
        this.note(`table cell element type ${ref.etype}`);
        cells.push({ column, kind: "other", text: hidden ? "" : text, input, hidden });
      }
    });
    if (t > tokens.length) this.note(`table ${b.table.name}: a row has fewer values than cells`);
    // The row's line on show (1-based) is its screen row under the column titles; the table's line is that plus the scrolling.
    const line = b.line?.index ?? b.table.rows.length + 1;
    // The table's area starts with its title, when it has one, then the column headers: FB50's items (title "0 Items")
    // and VA01's ("All items") show their first line two rows below the area's top (checked live, 2026-11-25).
    b.table.rows.push({ index: b.firstRow + line - 1, row: b.table.row + line + (b.table.title ? 1 : 0), empty: cells.every((c) => c.hidden || (!c.text && !c.checked)), cells });
    delete b.line;
  }
}
