/**
 * The outer layers of DIAG: NI frames, the 200-byte block that opens the
 * first message of a connection, the message header, and the run of items
 * that makes a message.
 *
 *   TCP stream  = NI frame*             4-byte big-endian length, then the payload
 *   NI payload  = [opening block 200] message header 8, then the items
 *                 (LZH-compressed when header byte 7 is 1)
 *   item        = one type byte, then either a value of a size fixed by the
 *                 type, or id 1, sub-id 1, length (2 or 4 bytes, big-endian)
 *                 and the value, or (type 11 only) length 4 and the value
 *
 * Example (synthetic, from test/diag/build.ts): the window title
 * "Synthetic" is the item
 *
 *   10 0c 09 00 09 53 79 6e 74 68 65 74 69 63
 *
 * type 10 (2-byte length), id 0c, sub-id 09, length 9, then the text.
 *
 * The item types and sizes below are the ones the captured traffic uses
 * (six screens of an ECC system and two later sessions, 178 messages and 4
 * screens sent inside RFC calls): with these sizes every one of the 182
 * item runs parses exactly to its end, and for each type no other size
 * between 0 and 120 does (types 0a and 0b only together, see below). A type
 * not listed here stops the message with a note, since its size is unknown.
 */
import { isLzh, lzhDecompress } from "./lzh.js";

/** NI keep-alive payloads: answered by the peer, never DIAG. */
const NI_PING = "NI_PING\0";
const NI_PONG = "NI_PONG\0";

export const OPENING_BLOCK = 200;
export const MESSAGE_HEADER = 8;

/** Item types, by their first byte. */
export const ITEM = {
  /** A window starts (16 bytes: its number, modal flag, position and size). */
  windowStart: 0x01,
  /** A classic list starts (22 bytes, not read). */
  listStart: 0x09,
  /** The format of the next list text (3 bytes; 08 00 08 for line-drawing cells). */
  listFormat: 0x0a,
  /** Row and column of the next list text (1 byte each). */
  listPosition: 0x0b,
  /** End of the message (no value). */
  end: 0x0c,
  /** Width of the next list text (2 bytes, big-endian). */
  listWidth: 0x13,
  /** id 1, sub-id 1, value length 2. */
  short: 0x10,
  /** id 1, sub-id 1, value length 4: the same items as `short`, when the value is long. */
  long: 0x12,
  /** Value length 4, then an XML document ("<?xml ...><DATAMANAGER>", 49 times in the captures; not read). */
  xml: 0x11,
} as const;

/**
 * Value sizes of the item types without a length field. 0a and 0b always
 * come together (0b 0a 13, then the list text): 2 and 3 is the split under
 * which both appear as items of their own, the 0b value reads as a row and a
 * column that place the texts where the list shows them, and the 13 value
 * is the width of the text after it: its length 170 of 172 times, less for
 * the 2 texts that carry icon and tooltip markup.
 */
const SIZE = new Map<number, number>([
  [ITEM.windowStart, 16],
  [ITEM.listStart, 22],
  [ITEM.listFormat, 3],
  [ITEM.listPosition, 2],
  [ITEM.end, 0],
  [ITEM.listWidth, 2],
]);

/**
 * Ids of the items with a length field: what the item is about. Only those
 * the decoder reads; the sub-id says which piece of it.
 */
export const ID = {
  /** About the user: logon language (sub-id 1b) and user name (1c). */
  user: 0x04,
  /** About the session and screen: system, client, transaction, program, screen number, status bar, code page. */
  session: 0x06,
  /** An RFC call between the server and SAP GUI's control framework, or a piece of one. */
  rfc: 0x08,
  /** Screen elements: element lists, tabstrips, table controls, focus. */
  screen: 0x09,
  /** The chain of areas (subscreen, tabstrip, tab page, table, control) the next elements sit in. */
  area: 0x0a,
  /** Menu bar and menus, toolbar, function keys. */
  menu: 0x0b,
  /** About the window: title, size, scrolling, message details, list texts; from SAP GUI, the command field. */
  window: 0x0c,
} as const;

/** Ids seen in the captures whose content the decoder does not use: skipped without a note. */
export const UNREAD_IDS: ReadonlySet<number> = new Set([0x05, 0x0e]);

export interface DiagItem {
  type: number;
  /** Items with a length field only; 0 otherwise. */
  id: number;
  sid: number;
  value: Buffer;
}

/** True for the item types that carry an id and a sub-id. */
export function hasId(type: number): boolean {
  return type === ITEM.short || type === ITEM.long;
}

/** `type/id/sid` in hex, for the debug records. */
export function itemKey(it: { type: number; id: number; sid: number }): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return hasId(it.type) ? `${h(it.type)}/${h(it.id)}/${h(it.sid)}` : h(it.type);
}

/** Splits one direction of a TCP stream into NI payloads. Keeps what is incomplete for the next chunk. */
export class NiFramer {
  private pending: Buffer[] = [];
  private size = 0;

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.length) {
      this.pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
      this.size += chunk.length;
    }
    const out: Buffer[] = [];
    if (this.size < 4) return out;
    let buf = this.pending.length === 1 ? (this.pending[0] as Buffer) : Buffer.concat(this.pending);
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) break;
      out.push(buf.subarray(4, 4 + n));
      buf = buf.subarray(4 + n);
    }
    this.pending = buf.length ? [buf] : [];
    this.size = buf.length;
    return out;
  }
}

export interface DiagMessage {
  /** The 8 header bytes. Byte 0: the session (mode) number; byte 5: 1 when the server is done and waits, 2 when more follows; byte 7: 1 when the items are compressed. */
  header: Buffer;
  /** True when the payload began with the 200-byte opening block (the first message of a connection). */
  dp: boolean;
  items: DiagItem[];
  /** What stopped the parsing early, if anything. */
  problem?: string;
}

/**
 * One NI payload as a DIAG message. Never throws: a payload that is not
 * DIAG, or one that breaks off, gives the items read so far and `problem`.
 */
export function parseMessage(payload: Buffer): DiagMessage | undefined {
  if (payload.length === NI_PING.length) {
    const s = payload.toString("latin1");
    if (s === NI_PING || s === NI_PONG) return undefined;
  }
  let body = payload;
  let dp = false;
  // The opening block starts with ff ff ff ff, and the little-endian number at byte 30 counts what follows its 200 bytes.
  if (body.length >= OPENING_BLOCK + MESSAGE_HEADER && body.readInt32BE(0) === -1 && body.readUInt32LE(30) === body.length - OPENING_BLOCK) {
    body = body.subarray(OPENING_BLOCK);
    dp = true;
  }
  if (body.length < MESSAGE_HEADER) return { header: body, dp, items: [], problem: `payload of ${body.length} bytes is shorter than a DIAG header` };
  const header = body.subarray(0, MESSAGE_HEADER);
  let data = body.subarray(MESSAGE_HEADER);
  const compression = header[7] ?? 0;
  if (compression === 1) {
    if (!isLzh(data)) return { header, dp, items: [], problem: "compressed message without an LZH header" };
    try {
      data = lzhDecompress(data);
    } catch (e) {
      return { header, dp, items: [], problem: e instanceof Error ? e.message : String(e) };
    }
  } else if (compression !== 0) {
    return { header, dp, items: [], problem: `encrypted message (SNC, compression flag ${compression}): not readable` };
  }
  const { items, problem } = parseItems(data);
  return problem === undefined ? { header, dp, items } : { header, dp, items, problem };
}

/** The items of a decompressed message, or of an inner stream found in an RFC blob. */
export function parseItems(data: Buffer): { items: DiagItem[]; problem?: string; end: number } {
  const items: DiagItem[] = [];
  let i = 0;
  while (i < data.length) {
    const type = data[i] as number;
    if (hasId(type)) {
      const head = type === ITEM.short ? 5 : 7;
      if (i + head > data.length) return { items, problem: `item header cut at ${i}`, end: i };
      const n = type === ITEM.short ? data.readUInt16BE(i + 3) : data.readUInt32BE(i + 3);
      if (i + head + n > data.length) return { items, problem: `item ${itemKey({ type, id: data[i + 1] ?? 0, sid: data[i + 2] ?? 0 })} of ${n} bytes cut at ${i}`, end: i };
      items.push({ type, id: data[i + 1] as number, sid: data[i + 2] as number, value: data.subarray(i + head, i + head + n) });
      i += head + n;
    } else if (type === ITEM.xml) {
      if (i + 5 > data.length) return { items, problem: `item header cut at ${i}`, end: i };
      const n = data.readUInt32BE(i + 1);
      if (i + 5 + n > data.length) return { items, problem: `xml item of ${n} bytes cut at ${i}`, end: i };
      items.push({ type, id: 0, sid: 0, value: data.subarray(i + 5, i + 5 + n) });
      i += 5 + n;
    } else {
      const n = SIZE.get(type);
      // Without a known size the rest cannot be split into items: stop here, with what was read.
      if (n === undefined) return { items, problem: `unknown item type 0x${type.toString(16)} at ${i}`, end: i };
      if (i + 1 + n > data.length) return { items, problem: `item 0x${type.toString(16)} cut at ${i}`, end: i };
      items.push({ type, id: 0, sid: 0, value: data.subarray(i + 1, i + 1 + n) });
      i += 1 + n;
    }
  }
  return { items, end: i };
}
