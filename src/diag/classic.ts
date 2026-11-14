/**
 * The classic part of a screen: what the DIAG items of a server message say
 * about windows, fields, tabs, table controls, lists, menus and keys.
 *
 * The server describes a screen as a flat run of items. A window starts with
 * a SES item; what follows belongs to it. Screen elements come as "atoms"
 * (DYNT_ATOM), each run of atoms preceded by the chain of containers it
 * sits in (CONTAINER items: reset, then subscreen, tabstrip, tab page, table
 * or control, each with its origin and size relative to the one before, and
 * its name). An atom's row and column are relative to the innermost
 * container, so the absolute position is the sum along the chain.
 */
import type { DiagArea, DiagContainer, DiagElement, DiagElementKind, DiagKey, DiagList, DiagListRow, DiagMenuEntry, DiagScroll, DiagSession, DiagStatus, DiagTab, DiagTable, DiagTableCell, DiagTableColumn, DiagTabstrip } from "./screen.js";
import { bagTooltip, clean, cstringAt, cstrings, decode, iconText, keyName } from "./text.js";
import { A, type DiagItem, itemKey, T } from "./wire.js";

/** Element types of an atom. */
const E = { EFIELD: 101, OFIELD: 102, KEYWORD: 103, CHECK_4: 104, RADIO_0: 105, PUSH_3: 106, FRAME_3: 107, LOOP: 108, SUBSCREEN: 109, PROPERTY: 111, ICON: 112, PUSH_1: 113, FNAME: 114, PUSH_2: 115, TAB: 116, COMBO: 117, CHECK_1: 118, RADIO_1: 119, XMLPROP: 120, EFIELD_1: 121, OFIELD_1: 122, KEYWORD_1: 123, CHECK_2: 124, RADIO_2: 125, COMBO_1: 126, FRAME_1: 127, CHECK_3: 128, RADIO_3: 129, EFIELD_2: 130, OFIELD_2: 131, KEYWORD_2: 132 } as const;

/** Attribute bits of an atom. */
const ATTR = { PROTECTED: 0x01, INVISIBLE: 0x02, MATCHCODE: 0x10 } as const;

const CHECKS = new Set<number>([E.CHECK_1, E.CHECK_2, E.CHECK_3, E.CHECK_4]);
const RADIOS = new Set<number>([E.RADIO_0, E.RADIO_1, E.RADIO_2, E.RADIO_3]);
const COMBOS = new Set<number>([E.COMBO, E.COMBO_1]);
const INPUTS = new Set<number>([E.EFIELD, E.EFIELD_1, E.EFIELD_2]);
const OUTPUTS = new Set<number>([E.OFIELD, E.OFIELD_1, E.OFIELD_2]);
const KEYWORDS = new Set<number>([E.KEYWORD, E.KEYWORD_1, E.KEYWORD_2]);

interface Level extends DiagArea {
  kind: "subscreen" | "tabstrip" | "page" | "table" | "control" | "loop" | "splitter" | "cell" | "other";
  name: string;
  /** Where its content is scrolled to, when it is larger than its area. */
  firstRow?: number;
  firstCol?: number;
}

const LEVELS: Record<number, Level["kind"]> = { 0x03: "subscreen", 0x04: "loop", 0x05: "table", 0x08: "tabstrip", 0x09: "page", 0x0a: "control", 0x0d: "splitter", 0x0e: "cell" };

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
function comboValue(s: string): { key: string; valueList?: string } {
  const m = /([0-9A-F]{32})([\s\S]*)$/.exec(s);
  return m ? { key: clean(m[2] ?? "").trim(), valueList: m[1] as string } : { key: s.replace(/[\x00-\x1f]/g, "").trim() };
}

/** Table control while its items arrive. */
interface TableBuild {
  table: DiagTable;
  /** Cell descriptions of the row about to come: element type and attributes per column. */
  refs?: { etype: number; attr: number }[];
  line?: { index: number; screen: number };
}

export class ClassicState {
  session: DiagSession = {};
  windows: WindowState[] = [];
  message: DiagStatus | undefined;
  /** UTF-8 unless the server says the session runs in a single-byte code page. */
  utf8 = true;
  /** Counts a screen change: goes up each time the server starts a window anew. */
  revision = 0;

  private cur: WindowState | undefined;
  private path: Level[] = [];
  private last: DiagElement | undefined;
  private build: TableBuild | undefined;
  private listPos: { row: number; col: number } | undefined;
  private listFormat: Buffer | undefined;
  private listWidth = 0;
  /** What the next SCROLL_INFOS item is about. */
  private scrollOf: "table" | "list" | undefined;

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

  /** A new step begins: the status bar of the last one is gone. */
  clearMessage(): void {
    this.message = undefined;
  }

  private item(it: DiagItem): void {
    const v = it.value;
    if (it.type === T.SES) return this.ses(v);
    if (it.type === T.EOM || it.type === T.XMLBLOB || it.type === T.ICO || it.type === T.TIT) return;
    if (it.type === T.CHL) {
      this.scrollOf = "list";
      return;
    }
    if (it.type === T.SBA) {
      this.listPos = { row: v[0] ?? 0, col: v[1] ?? 0 };
      return;
    }
    if (it.type === T.SBA2) {
      // Seen in the item table only, never in a capture: assumed to be row and column as two uint32.
      this.note("SBA2 item: position read as two uint32, unverified");
      this.listPos = { row: v.readUInt32BE(0), col: v.readUInt32BE(4) };
      return;
    }
    if (it.type === T.SFE) {
      this.listFormat = v;
      return;
    }
    if (it.type === T.SLC) {
      this.listWidth = v.readUInt16BE(0);
      return;
    }
    if (it.type !== T.APPL && it.type !== T.APPL4) return this.note(`item ${itemKey(it)}`);
    switch (it.id) {
      case A.ST_R3INFO:
        return this.r3info(it.sid, v);
      case A.ST_USER:
        if (it.sid === 0x1b) this.session.language = clean(this.text(v));
        else if (it.sid === 0x1c) this.session.user = clean(this.text(v));
        return;
      case A.VARINFO:
        return this.varinfo(it.sid, v);
      case A.MNUENTRY:
        return this.menu(it.sid, v);
      case A.CONTAINER:
        return this.container(it.sid, v);
      case A.DYNT:
        return this.dynt(it.sid, v);
      case A.DYNN:
      case A.CONTROL:
      case A.RFC_TR:
        return;
      default:
        return this.note(`item ${itemKey(it)}`);
    }
  }

  /**
   * SES starts a window: byte 6 has 0x10 for a modal window, byte 7 is the
   * window's number, bytes 8 and 9 its column and row over the main window,
   * bytes 14 and 15 its rows and columns. Without a size it announces a
   * mode, not a screen.
   */
  private ses(v: Buffer): void {
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
    const before = this.windows[index];
    if (before) {
      w.menus = before.menus;
      w.toolbar = before.toolbar;
      w.keys = before.keys;
      w.guiStatus = before.guiStatus;
      w.guiStatusProgram = before.guiStatusProgram;
    }
    // A window replaces itself and closes those above it.
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

  private r3info(sid: number, v: Buffer): void {
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
        this.win().program = s();
        return;
      case 0x0e:
        this.win().dynpro = s();
        return;
      case 0x0f:
        this.win().guiStatusProgram = s();
        return;
      case 0x10:
        this.win().guiStatus = s();
        return;
      case 0x23: {
        // uint32 code page, a byte, then its number and name as strings.
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

  private varinfo(sid: number, v: Buffer): void {
    const i32 = (n: number) => (v.length >= 4 * n + 4 ? v.readInt32BE(4 * n) : 0);
    switch (sid) {
      case 0x02: {
        // SCROLL_INFOS, six uint32. After a table header: first column, columns, lines. After a list header: lines, columns.
        if (this.scrollOf === "list") {
          const w = this.win();
          w.list ??= { rows: [] };
          w.list.totalRows = i32(0);
        }
        this.scrollOf = undefined;
        return;
      }
      case 0x03: {
        // MESTYPE2: type, message class, number, as strings.
        const parts = cstrings(v, this.utf8);
        const type = (parts[0] ?? "").trim();
        const id = (parts[1] ?? "").trim();
        const number = (parts[2] ?? "").trim();
        this.message = { type: type || this.message?.type || "", text: this.message?.text ?? "", ...(id ? { id } : {}), ...(number ? { number } : {}) };
        return;
      }
      case 0x06: {
        // SCROLL_INFOS2: rows, columns (twice), first row, first column, visible rows, visible columns.
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
   * Menu entries: length 2, position path 4, flags 1, virtual key 1, return
   * code 6, function code 6, then text, accelerator and info as strings.
   */
  private menu(sid: number, v: Buffer): void {
    const w = this.win();
    const entries: { path: number[]; flags: number; vkey: number; fcode: string; text: string; accel: string; info: string }[] = [];
    let i = 0;
    while (i + 20 <= v.length) {
      const n = v.readUInt16BE(i);
      if (n < 20 || i + n > v.length) break;
      const e = v.subarray(i, i + n);
      const strings = cstrings(e.subarray(20), this.utf8);
      entries.push({ path: [...e.subarray(2, 6)].filter((x) => x > 0), flags: e[6] ?? 0, vkey: e[7] ?? 0, fcode: clean(decode(e.subarray(14, 20), false)).trim(), text: strings[0] ?? "", accel: strings[1] ?? "", info: strings[2] ?? "" });
      i += n;
    }
    if (sid === 0x01 || sid === 0x02) {
      if (sid === 0x01) w.menus = [];
      for (const e of entries) {
        const node: DiagMenuEntry = { path: e.path, text: e.text, accelerator: e.accel, enabled: (e.flags & 0x02) !== 0, separator: (e.flags & 0x08) !== 0, children: [], ...((e.flags & 0x10) !== 0 && sid === 0x02 ? { vkey: e.vkey } : {}), ...(e.fcode ? { fcode: e.fcode } : {}) };
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
      return { vkey: e.vkey, key: keyName(e.vkey), text: it.text, tooltip: e.info.trim() || it.tooltip || "", icon: it.icon ?? "", enabled: (e.flags & 0x02) !== 0, ...(e.fcode ? { fcode: e.fcode } : {}) };
    });
    if (sid === 0x03) w.toolbar = keys;
    else if (sid === 0x04) w.keys = keys;
  }

  /** CONTAINER items: 01 resets the chain; the others add a level (id 1, row 2, col 2, width 2, height 2); 06 names the last level. */
  private container(sid: number, v: Buffer): void {
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
    const kind = LEVELS[sid];
    if (!kind || v.length < 9) return;
    this.path.push({ kind, name: "", row: v.readUInt16BE(1), col: v.readUInt16BE(3), width: v.readUInt16BE(5), height: v.readUInt16BE(7) });
  }

  private dynt(sid: number, v: Buffer): void {
    switch (sid) {
      case 0x02:
        return this.atoms(v, false);
      case 0x10:
        return this.atoms(v, true);
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
        if (this.build) this.build.refs = refs;
        return;
      }
      case 0x05:
        if (this.build && v.length >= 4) this.build.line = { index: v.readUInt16BE(0), screen: v.readUInt16BE(2) };
        return;
      case 0x08:
      case 0x09:
        return this.tableRow(v);
      case 0x0b:
      case 0x01: {
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
   * Atoms: length 2, two flag bytes, element type 1, area, block, group,
   * row 2, col 2, attributes 1, then what the type needs. A name atom (114)
   * and a property bag (120) belong to the element before them.
   */
  private atoms(v: Buffer, tabs: boolean): void {
    const w = this.win();
    const o = this.origin();
    const path = this.names();
    let strip = tabs ? w.tabstrips[w.tabstrips.length - 1] : undefined;
    if (tabs && !strip) {
      strip = this.newTabstrip();
      w.tabstrips.push(strip);
    }
    let lastTab: DiagTab | undefined;
    let i = 0;
    while (i + 13 <= v.length) {
      const n = v.readUInt16BE(i);
      if (n < 13 || i + n > v.length) {
        this.note("atom list breaks off");
        break;
      }
      const a = v.subarray(i, i + n);
      i += n;
      const flag1 = a[2] ?? 0;
      const etype = a[4] ?? 0;
      const row = a.readUInt16BE(8);
      const col = a.readUInt16BE(10);
      const attr = a[12] ?? 0;
      const body = a.subarray(13);
      if (etype === E.FNAME) {
        const name = clean(this.text(body));
        if (lastTab) lastTab.name = name;
        else if (this.last) this.last.name = name;
        continue;
      }
      if (etype === E.XMLPROP) {
        const tip = bagTooltip(this.text(body));
        if (tip && lastTab) lastTab.tooltip ??= tip;
        else if (tip && this.last) this.last.tooltip ??= tip;
        continue;
      }
      if (etype === E.TAB && strip) {
        // Width 1, height 1, page 1, then the offsets of function code, text and id in the atom.
        const fcodeAt = body.readUInt16BE(3);
        const textAt = body.readUInt16BE(5);
        const idAt = body.readUInt16BE(7);
        const it = iconText(clean(cstringAt(a, textAt, this.utf8, fcodeAt > textAt ? fcodeAt : a.length)));
        const before = strip.tabs.reduce((sum, t) => sum + t.text.length + 3, 0);
        lastTab = { id: cstringAt(a, idAt, this.utf8), name: "", text: it.text, fcode: cstringAt(a, fcodeAt, this.utf8).replace(/^=/, ""), active: (flag1 & 0x40) !== 0, index: strip.tabs.length, row: strip.row, col: strip.col + 1 + before, ...(it.icon ? { icon: it.icon } : {}), ...(it.tooltip ? { tooltip: it.tooltip } : {}) };
        strip.tabs.push(lastTab);
        this.last = undefined;
        continue;
      }
      lastTab = undefined;
      const el: DiagElement = { kind: "other", name: "", text: "", row: o.row + row, col: o.col + col, width: 0, input: (attr & ATTR.PROTECTED) === 0, hidden: (attr & ATTR.INVISIBLE) !== 0, path, etype };
      if ((attr & ATTR.MATCHCODE) !== 0) el.valueHelp = true;
      if (el.row < o.top || el.row >= o.bottom || el.col < o.left || el.col >= o.right) el.scrolledOut = true;
      this.element(el, a, body);
      w.elements.push(el);
      this.last = el;
    }
    if (strip) this.markActiveTab(strip);
  }

  private element(el: DiagElement, a: Buffer, body: Buffer): void {
    const etype = el.etype;
    const field = INPUTS.has(etype) || OUTPUTS.has(etype) || KEYWORDS.has(etype);
    if (field) {
      // Newer form: flags 2, data length 1, visible length 1, maximum length 2, text. The older one has one flag byte.
      const head = etype >= E.EFIELD_2 ? 6 : etype >= E.EFIELD_1 ? 5 : 0;
      if (head && body.length >= head) {
        el.width = body[head - 3] ?? 0;
        el.maxLength = body.readUInt16BE(head - 2);
      }
      const raw = this.text(body.subarray(Math.min(head, body.length)));
      el.kind = KEYWORDS.has(etype) ? "label" : "field";
      if (el.kind === "label") {
        const it = iconText(clean(raw));
        el.text = it.text;
        if (it.icon) el.icon = it.icon;
        if (it.tooltip) el.tooltip = it.tooltip;
        el.input = false;
      } else {
        // A hidden field is a password or a field the screen does not show: its content stays out.
        el.text = el.hidden ? "" : clean(raw).trim();
        if (OUTPUTS.has(etype)) el.input = false;
        // An empty required field arrives as "?".
        if (el.input && el.text === "?") {
          el.text = "";
          el.required = true;
        }
      }
      if (!el.width) el.width = raw.length;
      return;
    }
    if (etype === E.PUSH_2) {
      // Width 1, height 1, then the offsets of function code and text in the atom.
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
    if (etype === E.FRAME_1) {
      el.kind = "group";
      el.height = body.readUInt16BE(0);
      el.width = body.readUInt16BE(2);
      el.text = iconText(clean(this.text(body.subarray(4)))).text;
      el.input = false;
      return;
    }
    if (etype === E.CHECK_3 || etype === E.RADIO_3) {
      // State 1, visible label length 2, event offset 2, event length 1, text offset 2, text length 2, then event id and text.
      el.kind = etype === E.CHECK_3 ? "checkbox" : "radio";
      el.checked = body[0] === 0x58 || body[0] === 0x01;
      const eventLength = body[5] ?? 0;
      const rest = body.subarray(10);
      const fcode = clean(this.text(rest.subarray(0, eventLength))).trim();
      if (fcode) el.fcode = fcode.replace(/^=/, "");
      const it = iconText(clean(this.text(rest.subarray(eventLength))));
      el.text = it.text;
      if (it.tooltip) el.tooltip = it.tooltip;
      el.width = body.readUInt16BE(1) || el.text.length;
      return;
    }
    if (COMBOS.has(etype)) {
      el.kind = "dropdown";
      const c = comboValue(decode(body, false));
      el.key = c.key;
      el.text = c.key;
      if (c.valueList) el.valueList = c.valueList;
      el.width = el.key.length;
      return;
    }
    // Older element types, never seen in a capture: the readable text, nothing more.
    el.kind = CHECKS.has(etype) ? "checkbox" : RADIOS.has(etype) ? "radio" : etype === E.PUSH_1 || etype === E.PUSH_3 ? "button" : etype === E.FRAME_3 ? "group" : "other";
    if (el.kind === "checkbox" || el.kind === "radio") el.checked = body[0] === 0x58;
    el.text = iconText(this.text(body).replace(/[\x00-\x1f]+/g, " ").trim()).text;
    el.width = el.text.length;
    this.note(`atom type ${etype}`);
  }

  private newTabstrip(): DiagTabstrip {
    const o = this.origin();
    const level = this.path[this.path.length - 1];
    return { name: level?.name ?? "", row: o.row, col: o.col, width: level?.width ?? 0, height: level?.height ?? 0, tabs: [], path: this.names().slice(0, -1) };
  }

  /** DYNT_TABSTRIP_HEADER: ends with the strip's name and the ids of the first and of the open tab, at offsets it names itself. */
  private tabstripHeader(v: Buffer): void {
    const w = this.win();
    const strip = this.newTabstrip();
    if (v.length >= 32) {
      const nameAt = v.readUInt16BE(26);
      const activeAt = v.readUInt16BE(30);
      if (nameAt < v.length) strip.name = clean(decode(v.subarray(nameAt, Math.min(nameAt + 30, v.length)), false)).trim() || strip.name;
      if (activeAt > nameAt && activeAt < v.length) this.activeTab.set(strip, cstringAt(v, activeAt, this.utf8));
    }
    w.tabstrips.push(strip);
  }

  private activeTab = new WeakMap<DiagTabstrip, string>();

  private markActiveTab(strip: DiagTabstrip): void {
    const id = this.activeTab.get(strip);
    if (id && strip.tabs.some((t) => t.id === id)) for (const t of strip.tabs) t.active = t.id === id;
    // The open page comes after the tabs: its area is taken when it does.
  }

  /**
   * TABLE_HEADER: geometry and counts, then program (40) and name (30),
   * then per column the display order, flags and width, then the table's
   * title and the column titles (NUL-terminated). The header names the offsets of its parts.
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
    const titleAt = u16(48) || widthsAt + 2 * count;
    const titlesAt = u16(50);
    const position = new Map<number, number>();
    for (let p = 0; p < count; p++) position.set(u16(orderAt + 2 * p) - 1, p);
    const titleLength = u16(52) || (v[titleAt - 1] ?? 0);
    table.title = iconText(clean(this.text(v.subarray(titleAt, Math.min(titleAt + titleLength, titlesAt > titleAt ? titlesAt : v.length))))).text;
    const titles = titlesAt > titleAt && titlesAt < v.length ? cstrings(v.subarray(titlesAt), this.utf8) : [];
    for (let c = 0; c < count; c++) {
      const it = iconText(clean(titles[c] ?? ""));
      table.columns.push({ index: c, position: position.get(c) ?? c, name: "", title: it.text, width: u16(widthsAt + 2 * c), col: 0, visible: false, ...(it.tooltip ? { tooltip: it.tooltip } : {}) });
    }
    // Where each column starts: after the row selector, one cell between columns.
    let col = table.col + 2;
    for (const c of [...table.columns].sort((a, b) => a.position - b.position)) {
      c.col = col;
      c.visible = table.width === 0 || col + c.width <= table.col + table.width;
      col += c.width + 1;
    }
    w.tables.push(table);
    this.build = { table };
    this.scrollOf = "table";
  }

  /**
   * One row of a table control: per cell, strings by element type. A field
   * gives value, length, flag; a checkbox state and an empty string; a
   * dropdown a marker, the id of its value list, an empty string, the key
   * and its length.
   */
  private tableRow(v: Buffer): void {
    const b = this.build;
    if (!b) return;
    const refs = b.refs ?? b.table.columns.map(() => ({ etype: E.EFIELD_2, attr: ATTR.PROTECTED }));
    const tokens = this.text(v).split("\0");
    const cells: DiagTableCell[] = [];
    let t = 0;
    refs.forEach((ref, column) => {
      const hidden = (ref.attr & ATTR.INVISIBLE) !== 0;
      const input = (ref.attr & ATTR.PROTECTED) === 0;
      if (CHECKS.has(ref.etype) || RADIOS.has(ref.etype)) {
        const state = tokens[t] ?? "";
        t += 2;
        cells.push({ column, kind: CHECKS.has(ref.etype) ? "checkbox" : "radio", text: "", checked: state === "X" || state === "\u0001", input, hidden });
      } else if (COMBOS.has(ref.etype)) {
        const key = (tokens[t + 3] ?? "").trim();
        const valueList = tokens[t + 1] ?? "";
        t += 5;
        cells.push({ column, kind: "dropdown", text: hidden ? "" : key, key: hidden ? "" : key, input, hidden, ...(valueList ? { valueList } : {}) });
      } else {
        const text = (tokens[t] ?? "").trim();
        const maxLength = Number(tokens[t + 1] ?? "") || 0;
        t += 3;
        cells.push({ column, kind: "field", text: hidden ? "" : text, input: input && !OUTPUTS.has(ref.etype), hidden, ...(maxLength ? { maxLength } : {}) });
      }
    });
    if (t > tokens.length) this.note(`table ${b.table.name}: a row has fewer values than cells`);
    const screen = b.line?.screen ?? b.table.rows.length + 1;
    const index = (b.line?.index ?? b.table.rows.length + 1) - 1;
    b.table.rows.push({ index, row: b.table.row + screen, empty: cells.every((c) => c.hidden || (!c.text && !c.checked)), cells });
    delete b.refs;
    delete b.line;
  }
}
