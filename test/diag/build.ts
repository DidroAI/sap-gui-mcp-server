/**
 * Builders of synthetic DIAG and RFC bytes for the tests: the wire formats
 * src/diag reads, written from scratch. No captured SAP data.
 */
import { lzhCompress } from "../../src/diag/lzh.js";

export const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
export const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const bytes = (v: Buffer | string | number[]): Buffer => (typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v));
const cat = (...parts: (Buffer | string | number[])[]): Buffer => Buffer.concat(parts.map(bytes));

// ---- items ----

/** An item with an id and a sub-id: 2-byte length (type 10), or 4-byte (type 12) when `long` or when the value needs it. */
export function idItem(id: number, sid: number, value: Buffer | string | number[] = [], long = false): Buffer {
  const v = bytes(value);
  return long || v.length > 0xffff ? cat([0x12, id, sid], u32(v.length), v) : cat([0x10, id, sid], u16(v.length), v);
}

/** An item without a length field (window start 0x01, list start 0x09, list format 0x0a, list position 0x0b, end 0x0c, list width 0x13). */
export const sizedItem = (type: number, value: Buffer | number[] = []): Buffer => cat([type], value);
export const END = sizedItem(0x0c);

export function windowStart(o: { index?: number; row?: number; col?: number; rows?: number; cols?: number; update?: boolean } = {}): Buffer {
  const b = Buffer.alloc(16);
  const index = o.index ?? 0;
  // update: the same screen again with only what changed (byte 6 without 0x01).
  b[6] = index > 0 ? 0x11 : o.update ? 0x00 : 0x01;
  b[7] = index;
  b[8] = o.col ?? 0;
  b[9] = o.row ?? 0;
  b[14] = o.rows ?? 20;
  b[15] = o.cols ?? 100;
  return sizedItem(0x01, b);
}

/** One NI frame with a DIAG message. `info` 1: the server is done; 2: more follows. */
export function message(items: Buffer[], o: { mode?: number; info?: number; compress?: boolean; padding?: number; dp?: boolean } = {}): Buffer {
  const body = Buffer.concat(items);
  const header = Buffer.from([o.mode ?? 0, 0, 0, 0, 0, o.info ?? 1, 0, o.compress ? 1 : 0]);
  let payload = cat(header, o.compress ? lzhCompress(body, o.padding ?? 0) : body);
  if (o.dp) {
    const dp = Buffer.alloc(200, 0x20);
    dp.writeInt32BE(-1, 0);
    dp.writeUInt32LE(payload.length, 30);
    payload = cat(dp, payload);
  }
  return cat(u32(payload.length), payload);
}

// ---- session and window items ----

export const sessionInfo = (sid: number, text: string): Buffer => idItem(0x06, sid, text);
export const title = (text: string): Buffer => idItem(0x0c, 0x09, text);
export const areaSize = (rows: number, cols: number): Buffer => idItem(0x0c, 0x07, cat(u32(rows), u32(cols), u32(rows), u32(cols)));
/** Scrolling of a window or area: size of the content, first row and column, visible rows and columns. */
export const scrollState = (rows: number, cols: number, firstRow: number, firstCol: number, visibleRows: number, visibleCols: number): Buffer =>
  idItem(0x0c, 0x06, cat(u32(rows), u32(cols), u32(rows), u32(cols), u32(firstRow), u32(firstCol), u32(visibleRows), u32(visibleCols), [1]));

/** The items every screen starts with: system, client, transaction, window, program and screen number. */
export function screenHead(o: { tcode?: string; program?: string; dynpro?: string; title?: string; rows?: number; cols?: number } = {}): Buffer[] {
  return [sessionInfo(0x02, "XYZ"), sessionInfo(0x03, "synthhost"), sessionInfo(0x0c, "100"), sessionInfo(0x07, (o.tcode ?? "ZT01").padEnd(20)), windowStart({ rows: o.rows ?? 20, cols: o.cols ?? 100 }), areaSize(o.rows ?? 20, o.cols ?? 100), idItem(0x04, 0x1c, "TESTER      "), sessionInfo(0x0d, (o.program ?? "ZPROG").padEnd(40)), sessionInfo(0x0e, o.dynpro ?? "0100"), title(o.title ?? "Synthetic Order: Overview")];
}

// ---- menus and keys ----

function menuEntry(path: number[], flags: number, vkey: number, text: string, accel = "", info = ""): Buffer {
  const pos = Buffer.alloc(4);
  path.forEach((p, i) => {
    pos[i] = p;
  });
  const rest = cat(pos, [flags, vkey], Buffer.alloc(12), text, [0], accel, [0], info, [0]);
  return cat(u16(rest.length + 2), rest);
}
/** The menu bar (sid 1) or the entries of its menus (sid 2): entries as [path, text, flags]. */
export const menus = (sid: 1 | 2, entries: [number[], string, number?][]): Buffer => idItem(0x0b, sid, Buffer.concat(entries.map(([path, text, flags]) => menuEntry(path, flags ?? 0x02, 0, text, text.slice(0, 1)))), true);
/** The toolbar (sid 3) or the function keys (sid 4): entries as [vkey, text, tooltip, flags] (flags 0: greyed out). */
export const keys = (sid: 3 | 4, entries: [number, string, string?, number?][]): Buffer => idItem(0x0b, sid, Buffer.concat(entries.map(([vkey, text, info, flags], i) => menuEntry([i], flags ?? 0x02, vkey, text, "", info ?? ""))), true);

// ---- areas ----

export const RESET = idItem(0x0a, 0x01, Buffer.alloc(9));
/** An area in the chain: 3 subscreen, 5 table, 8 tabstrip, 9 tab page, 10 control. */
export const areaLevel = (sid: number, row: number, col: number, width: number, height: number): Buffer => idItem(0x0a, sid, cat([1], u16(row), u16(col), u16(width), u16(height)));
export const areaName = (name: string, program = "", dynpro = ""): Buffer => idItem(0x0a, 0x06, cat(name, [0], program, [0], dynpro, [0]));

// ---- elements ----

const PROTECTED = 0x01;
const INVISIBLE = 0x02;
const MATCHCODE = 0x10;

function element(etype: number, row: number, col: number, attr: number, body: Buffer | string | number[], flag1 = 0): Buffer {
  const b = bytes(body);
  return cat(u16(13 + b.length), [flag1, 0, etype, 0, 1, 0], u16(row), u16(col), [attr], b);
}
const fieldBody = (text: string, width: number): Buffer => cat([0, 0, Buffer.byteLength(text), width, 0, width], text);

export const elem = {
  /** An input field (or an output field when `output`), padded to `width`. */
  field: (row: number, col: number, text: string, o: { width?: number; readOnly?: boolean; output?: boolean; hidden?: boolean; valueHelp?: boolean } = {}): Buffer => {
    const width = o.width ?? Math.max(text.length, 1);
    const attr = (o.readOnly || o.output ? PROTECTED : 0) | (o.hidden ? INVISIBLE : 0) | (o.valueHelp ? MATCHCODE : 0);
    return element(o.output ? 131 : 130, row, col, attr, fieldBody(text.padEnd(width), width));
  },
  label: (row: number, col: number, text: string): Buffer => element(132, row, col, PROTECTED, fieldBody(text.padEnd(text.length + 3), text.length + 3)),
  /** The SAP field name of the element just before. */
  name: (row: number, col: number, name: string): Buffer => element(114, row, col, 0, name),
  tooltip: (row: number, col: number, text: string): Buffer => element(120, row, col, 0, `<Propertybag><DefaultTooltip>${text}</DefaultTooltip></Propertybag>\0`),
  /** A push button; `disabled`: SAP greys it out (the protected attribute). */
  button: (row: number, col: number, text: string, fcode: string, disabled = false): Buffer => {
    const padded = text.padEnd(text.length + 4);
    return element(115, row, col, disabled ? PROTECTED : 0, cat([padded.length, 1], u16(19 + padded.length + 1), u16(19), padded, [0], `=${fcode}`, [0, 0]));
  },
  check: (row: number, col: number, text: string, checked: boolean, readOnly = false): Buffer => element(128, row, col, readOnly ? PROTECTED : 0, cat([checked ? 0x58 : 0x20], u16(text.length), [0, 0, 0, 0, 0], u16(text.length), text)),
  frame: (row: number, col: number, rows: number, cols: number, text: string): Buffer => element(127, row, col, PROTECTED, cat(u16(rows), u16(cols), text)),
  dropdown: (row: number, col: number, key: string, list = "0123456789ABCDEF0123456789ABCDEF"): Buffer => element(126, row, col, 0, cat([1, 0, 0, 0, 0x20, 0, 0x20, 0, 0, 0x20, 0, 2, 0, 2, 0x15, 0, 2], list, key)),
  tab: (index: number, text: string, id: string, active = false): Buffer => {
    const padded = text.padEnd(20);
    const fcodeAt = 22 + padded.length + 1;
    return element(116, 0, index, 0x20, cat([padded.length, 1, 3], u16(fcodeAt), u16(22), u16(fcodeAt + id.length + 2), padded, [0], `=${id}`, [0], id, [0, 0]), active ? 0x40 : 0);
  },
  /** A field SAP sends again without its text (the text's length 0): in an update, SAP GUI keeps what it shows. */
  unsent: (row: number, col: number, width: number, o: { readOnly?: boolean; label?: boolean } = {}): Buffer => element(o.label ? 132 : 130, row, col, o.readOnly || o.label ? PROTECTED : 0, [0, 0, 0, width, 0, width]),
  /** An element type the decoder does not know. */
  unknown: (row: number, col: number, text: string): Buffer => element(99, row, col, 0, text),
};
export const elementList = (...list: Buffer[]): Buffer => idItem(0x09, 0x02, Buffer.concat(list), true);
export const tabList = (...list: Buffer[]): Buffer => idItem(0x09, 0x10, Buffer.concat(list), true);

/** A tabstrip's description: numbers, then the strip's name and the ids of the first and the open tab. */
export function tabstripHeader(name: string, active: string, count: number): Buffer {
  const head = Buffer.alloc(32);
  head.writeUInt16BE(count, 16);
  head.writeUInt16BE(0x20, 26);
  head.writeUInt16BE(0x3f, 28);
  head.writeUInt16BE(0x40, 30);
  return idItem(0x09, 0x0f, cat(head, name.padEnd(30), [0], [0], active, [0]), true);
}

// ---- table control ----

export interface TableColumn {
  name: string;
  title: string;
  width: number;
  /** Element type of its cells: 130 input, 131 output, 124 checkbox, 126 dropdown. */
  etype?: number;
}

/** A table control: its description, field names and, per row, cell descriptions, line numbers and values. `order`: column numbers (1-based) by display position. */
/**
 * A table control as SAP sends it: the description, the scrolling item (lines, columns, lines on show, first
 * column, first line on show, 0), the column names, then per row its cell description (sent again only when it
 * differs from the one before, as SAP does) and its values. A push button cell is its function code and text.
 */
export function tableControl(o: { program: string; name: string; title: string; columns: TableColumn[]; rows: { values: string[]; hidden?: boolean; readOnly?: boolean }[]; order?: number[]; total?: number; first?: number }): Buffer[] {
  const n = o.columns.length;
  const head = Buffer.alloc(60);
  const orderAt = 131;
  const flagsAt = orderAt + 2 * n;
  const widthsAt = flagsAt + 2 * (n + 2);
  const titleAt = widthsAt + 2 * n + 1;
  const titlesAt = titleAt + 60 + 1;
  head.writeUInt16BE(n, 11);
  head.writeUInt16BE(o.total ?? o.rows.length, 13);
  head.writeUInt16BE(o.rows.length, 15);
  head.writeUInt16BE(orderAt, 17);
  head.writeUInt16BE(flagsAt, 23);
  head.writeUInt16BE(n, 25);
  head.writeUInt16BE(flagsAt + 4, 27);
  head.writeUInt16BE(widthsAt, 29);
  head.writeUInt16BE(titleAt, 48);
  head.writeUInt16BE(titlesAt, 50);
  head.writeUInt16BE(60, 52);
  const order = o.order ?? o.columns.map((_, i) => i + 1);
  const body = cat(head, o.program.padEnd(40), o.name.padEnd(30), [0], Buffer.concat(order.map(u16)), Buffer.alloc(2 * (n + 2), 0x51), Buffer.concat(o.columns.map((c) => u16(c.width))), [o.title.length], o.title.padEnd(60), [0], Buffer.concat(o.columns.map((c) => cat(c.title, [0]))));
  body.writeUInt16BE(body.length, 0);
  const out = [idItem(0x09, 0x0e, body, true), idItem(0x0c, 0x02, cat(u32(o.total ?? o.rows.length), u32(n), u32(o.rows.length), u32(0), u32(o.first ?? 0), u32(0)), true), idItem(0x09, 0x0d, Buffer.concat(o.columns.map((c) => cat(c.name, [0]))), true)];
  let refs = 0;
  let lastAttr = -1;
  o.rows.forEach((row, r) => {
    const attr = (row.readOnly ? PROTECTED : 0) | (row.hidden ? INVISIBLE : 0);
    if (attr !== lastAttr) {
      refs = r + 1;
      lastAttr = attr;
      out.push(idItem(0x09, 0x11, Buffer.concat(o.columns.map((c) => cat(u16(refs), [c.etype ?? 130, 1, refs, 0, attr | (c.etype === 131 ? PROTECTED : 0), 0x20, 0x10]))), true));
    }
    out.push(idItem(0x09, 0x05, cat(u16(r + 1), u16(refs)), true));
    const cells = o.columns.map((c, i) => {
      const v = row.values[i] ?? "";
      if (c.etype === 124) return cat(v, [0, 0]);
      if (c.etype === 126) return cat([1, 0], "FEDCBA9876543210FEDCBA9876543210", [0, 0], v, [0], String(v.length), [0]);
      if (c.etype === 115) return cat("=", c.name.split("-").pop() ?? "", [0], v.padEnd(c.width), [0]);
      return cat(v.padEnd(c.width), [0], String(c.width), [0], "0", [0]);
    });
    out.push(idItem(0x09, 0x08, Buffer.concat(cells), true));
  });
  return out;
}

// ---- lists ----

/** The start of a classic list: the list-start item and the scrolling item with the number of lines. */
export const listHead = (totalRows: number): Buffer[] => [sizedItem(0x09, Buffer.alloc(22)), idItem(0x0c, 0x02, cat(u32(totalRows), u32(40), u32(40), u32(40), u32(0), u32(0)))];
/** One list cell: position, format, length, text. `frame` makes it a cell of line-drawing codes. */
export const listCell = (row: number, col: number, text: string, frame = false): Buffer[] => [sizedItem(0x0b, [row, col]), sizedItem(0x0a, frame ? [8, 0, 8] : [0x0a, 2, 0]), sizedItem(0x13, u16(text.length)), idItem(0x0c, 0x0b, text)];

// ---- RFC ----

const rfcField = (id: number, data: Buffer | string | number[]): Buffer => {
  const d = bytes(data);
  return cat(u16(id), u16(d.length), d, u16(id));
};

export interface RfcTableSpec {
  name: string;
  rowLength: number;
  rows: Buffer[];
  /** Rows compressed into 0305 chunks instead of one 0304 field each. */
  packed?: boolean;
  /** Padding bits of the LZH block. */
  padding?: number;
}

/** The payload of an RFC call: header fields, function name, parameters, tables, end mark. */
export function rfcCall(fn: string, params: Record<string, Buffer | string> = {}, tables: RfcTableSpec[] = []): Buffer {
  const parts: Buffer[] = [rfcField(0x0101, [1, 1, 1, 1, 4, 1, 1, 0]), rfcField(0x0008, "synthhost")];
  if (fn) parts.push(rfcField(0x0102, fn));
  for (const [name, value] of Object.entries(params)) parts.push(rfcField(0x0201, name), rfcField(0x0203, value));
  for (const t of tables) {
    parts.push(rfcField(0x0301, t.name), rfcField(0x0302, cat(u32(t.rowLength), u32(t.rows.length))));
    if (t.packed) {
      const block = lzhCompress(Buffer.concat(t.rows), t.padding ?? 0);
      const whole = cat([0x7b, 0x02, 0x00, 0xea], u32(block.length), block);
      for (let i = 0; i < whole.length; i += 250) parts.push(rfcField(0x0305, whole.subarray(i, i + 250)));
      parts.push(rfcField(0x0306, []));
    } else for (const r of t.rows) parts.push(rfcField(0x0304, r));
  }
  return cat(...parts, [0xff, 0xff]);
}

/** An RFC item: sid 0 a call that waits for an answer, 1 an answer, 4 a part with more to come, 6 a call without answer or the last part. */
export const rfcItem = (sid: number, payload: Buffer): Buffer => idItem(0x08, sid, payload);

const fixedRow = (text: string, length: number): Buffer => Buffer.from(text.padEnd(length).slice(0, length), "latin1");

export interface DpField {
  name: string;
  length: number;
  type: "C" | "I";
}

/** An automation queue (OLE_FLUSH_CALL): verbs with their parameters and variables, and the data provider's tables. */
export class Queue {
  private vars: Buffer[] = [];
  private verbs: Buffer[] = [];
  private params: Buffer[] = [];
  private queue: Buffer[] = [];
  private messages = 0;

  /** A variable with a value; returns its index. */
  value(v: string | number): number {
    this.vars.push(fixedRow(`${"".padEnd(32)}000000000 ${v}`, 337));
    return this.vars.length;
  }
  /** A variable that holds an object SAP GUI knows by `handle`. */
  object(handle: string | number): number {
    this.vars.push(fixedRow(`${"".padEnd(32)}000000000O${handle}`, 337));
    return this.vars.length;
  }
  result(): number {
    this.vars.push(fixedRow(`${"_RESULT".padEnd(32)}000000000 `, 337));
    return this.vars.length;
  }
  /** A verb on the object in variable `object`; `args` are values or variable indexes ({ at }). Returns the index of its result variable when `withResult`. */
  verb(object: number, name: string, kind: "C" | "S" | "G", args: (string | number | { at: number })[] = [], withResult = false): number {
    this.verbs.push(fixedRow(`${String(object).padStart(10)}${name.padEnd(42)}${kind}`, 53));
    const n = this.verbs.length;
    args.forEach((a, i) => {
      const at = typeof a === "object" ? a.at : this.value(a);
      this.params.push(fixedRow(`${String(n).padStart(4)}${"3".padStart(4)}${`#${i + 1}`.padEnd(32)}${String(at).padStart(4)}`, 44));
    });
    if (!withResult) return 0;
    const at = this.result();
    this.params.push(fixedRow(`${String(n).padStart(4)}${"12".padStart(4)}${"_RESULT".padEnd(32)}${String(at).padStart(4)}`, 44));
    return at;
  }
  /** A table of the data provider under `url`: an inner DP_PUT_CLIENT_TABLE call cut into queue rows. */
  table(url: string, fields: DpField[], rows: (string | number)[][]): void {
    let offset = 0;
    const layout = fields.map((f) => {
      const at = offset;
      offset += f.length;
      return { ...f, at };
    });
    const format = layout.map((f, i) => cat(fixedRow("ZSTRUCT", 30), fixedRow(f.name, 30), u32le(i + 1), u32le(f.at), u32le(f.length), u32le(0), [f.type.charCodeAt(0), 0, 0, 0]));
    const data = rows.map((r) => {
      const b = Buffer.alloc(offset, 0x20);
      layout.forEach((f, i) => {
        const v = r[i] ?? "";
        if (f.type === "I") b.writeInt32LE(Number(v), f.at);
        else b.write(String(v).slice(0, f.length), f.at, "utf8");
      });
      return b;
    });
    const inner = rfcCall("DP_PUT_CLIENT_TABLE45A", { DESURL: url.padEnd(80), SUBTYPE: "X-R3TABLE" }, [
      { name: "DATAASC", rowLength: offset, rows: data, packed: true },
      { name: "FORMAT", rowLength: 80, rows: format },
    ]);
    this.messages++;
    const size = 1853 - 68;
    for (let i = 0, part = 1; i < inner.length; i += size, part++) {
      const chunk = Buffer.alloc(size);
      inner.copy(chunk, 0, i, Math.min(i + size, inner.length));
      this.queue.push(cat("0AA400021ABCDEF012340000", "SAPGUI".padEnd(32), String(this.messages).padStart(8, "0"), u32(part), chunk));
    }
  }
  /** The call as the payload of an RFC item. */
  build(): Buffer {
    return rfcCall("OLE_FLUSH_CALL", { IMPORT_XML: "\0" }, [
      { name: "PARAMS", rowLength: 44, rows: this.params },
      { name: "RFC_QUEUE", rowLength: 1853, rows: this.queue, packed: true, padding: 1 },
      { name: "VARS", rowLength: 337, rows: this.vars, packed: true, padding: 3 },
      { name: "VERBS", rowLength: 53, rows: this.verbs },
    ]);
  }
}

/** SAP GUI's answer to a queue: for each verb number, the handle of the object it made. */
export function queueAnswer(handles: Record<number, string>): Buffer {
  const vars: Buffer[] = [];
  const params: Buffer[] = [];
  for (const [verb, handle] of Object.entries(handles)) {
    vars.push(fixedRow(`${"_RESULT".padEnd(32)}000000000O${handle}`, 337));
    params.push(fixedRow(`${String(verb).padStart(4)}${"9".padStart(4)}${"_RESULT".padEnd(32)}${String(vars.length).padStart(4)}`, 44));
  }
  return rfcCall("", { EXCEPT_DESCRIPT: "".padEnd(16) }, [
    { name: "PARAMS", rowLength: 44, rows: params },
    { name: "VARS", rowLength: 337, rows: vars, packed: true },
  ]);
}
