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

/** The largest NI frame read. A longer length is taken as garbled (the captures' largest frame is about 13 KB), so a connection never holds more. */
export const MAX_FRAME = 8 << 20;
/** After a loss, the longest frame taken as the place to start again: a false start this long would hold up reading for its whole length. */
const RESYNC_MAX = 1 << 20;
/** The framer's buffer is let go once empty when it grew past this. */
const SMALL_STORE = 1 << 20;
/** Item types a message may start with when it is not compressed. */
const FIRST_ITEM: ReadonlySet<number> = new Set<number>([...SIZE.keys(), ITEM.short, ITEM.long, ITEM.xml]);
/** Candidate starts kept while looking for the next frame after a loss. */
const MAX_CANDIDATES = 64;

type Verdict = "frame" | "more" | "bad";

/**
 * Does a frame start at `i`? "more" when the bytes so far do not tell yet.
 * A frame starts with its length and then a keep-alive, the opening block,
 * or a DIAG header whose compression byte is 0 (then an item type or
 * nothing), 1 (then the compression magic 1f 9d) or 2-3 (encrypted).
 * `strict` (when looking for a restart point) also wants byte 5 of the
 * header 0-3 and a frame no longer than RESYNC_MAX.
 */
function frameAt(buf: Buffer, i: number, strict: boolean): Verdict {
  if (buf.length - i < 4) return "more";
  const n = buf.readUInt32BE(i);
  if (n < MESSAGE_HEADER || n > (strict ? RESYNC_MAX : MAX_FRAME)) return "bad";
  const have = buf.length - i - 4;
  const p = i + 4;
  if (n === NI_PING.length) {
    if (have < n) return "more";
    const s = buf.toString("latin1", p, p + n);
    if (s === NI_PING || s === NI_PONG) return "frame";
  }
  let h = p;
  if (buf[p] === 0xff) {
    if (have < 4) return "more";
    if (buf.readInt32BE(p) === -1) {
      if (n < OPENING_BLOCK + MESSAGE_HEADER) return "bad";
      if (have < OPENING_BLOCK + MESSAGE_HEADER + 1) return "more";
      if (buf.readUInt32LE(p + 30) !== n - OPENING_BLOCK) return "bad";
      h = p + OPENING_BLOCK;
    }
  }
  const rest = n - (h - p);
  const got = have - (h - p);
  if (got < MESSAGE_HEADER) return "more";
  const compression = buf[h + 7] as number;
  if (compression > 3 || (strict && (buf[h + 5] as number) > 3)) return "bad";
  if (compression === 1) {
    if (rest < MESSAGE_HEADER + 8) return "bad";
    if (got < MESSAGE_HEADER + 7) return "more";
    return buf[h + MESSAGE_HEADER + 5] === 0x1f && buf[h + MESSAGE_HEADER + 6] === 0x9d ? "frame" : "bad";
  }
  if (compression === 0 && rest > MESSAGE_HEADER) {
    if (got < MESSAGE_HEADER + 1) return "more";
    return FIRST_ITEM.has(buf[h + MESSAGE_HEADER] as number) ? "frame" : "bad";
  }
  return "frame";
}

/** A frame's payload (`suspect` when the next frame does not start where it ends), or bytes dropped from the stream. */
export type FrameEvent = { payload: Buffer; suspect?: true } | { lost: number; why: string };

/** True when `c` is one or more whole frames, each starting as a restart point must. */
function wholeFrames(c: Buffer): boolean {
  let j = 0;
  while (j < c.length) {
    if (frameAt(c, j, true) !== "frame") return false;
    j += 4 + c.readUInt32BE(j);
  }
  return j === c.length;
}

/**
 * Splits one direction of a TCP stream into NI payloads. Keeps what is
 * incomplete for the next chunk.
 *
 * Bytes lost or garbled in transit would shift every length that follows,
 * and the stream would never be read again. So each frame must start like
 * one (`frameAt`); when one does not, the framer looks for the next place
 * where a frame starts and the frame after it starts too (or the frame ends
 * exactly where the bytes received so far end), drops what lies before, and
 * reports it as a loss. A frame that the next one does not follow is handed
 * out as `suspect`: a byte lost inside it shifted where the next one seemed
 * to start. To tell, a frame is held until the start of the next one has
 * arrived, unless the bytes received end exactly with it (as they do when
 * the sender waits). Memory stays bounded: a length over MAX_FRAME counts as
 * garbled, and the search keeps at most about RESYNC_MAX bytes. Time stays
 * linear: the bytes held are kept in one buffer that grows by doubling, so a
 * chunk is copied in once, not the bytes held before it again with every
 * chunk (as a search over many small chunks would); a payload is copied
 * once when it is handed out.
 */
export class NiFramer {
  /** Bytes dropped so far. */
  lost = 0;

  /** Bytes held, waiting for the rest of a frame or for the next place a frame starts. */
  get buffered(): number {
    return this.end - this.start;
  }

  /** Bytes received and not handed out yet: `store` from `start` to `end`. */
  private store: Buffer = Buffer.alloc(0);
  private start = 0;
  private end = 0;
  /** How many bytes are needed before looking again (a frame's whole length while it arrives in small chunks). */
  private need = 0;
  /** Looking for the next frame after a loss: bytes dropped so far, why, candidate starts (offsets in buf), how far buf was scanned. */
  private search: { dropped: number; why: string; candidates: number[]; scanned: number } | undefined;

  /** The payloads of the frames completed by this chunk. */
  push(chunk: Uint8Array): Buffer[] {
    const out: Buffer[] = [];
    for (const e of this.read(chunk)) if ("payload" in e) out.push(e.payload);
    return out;
  }

  /** What this chunk completes, in stream order: frames, and the bytes dropped before or between them. */
  read(chunk: Uint8Array): FrameEvent[] {
    const c = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    const out: FrameEvent[] = [];
    if (!c.length) return out;
    // A frame whose length was garbled upward would swallow the frames after it, up to MAX_FRAME bytes. When a
    // chunk that does not end it is made of whole frames by itself, those are taken instead and the waiting frame is
    // dropped (senders write one or more whole frames at a time, so chunks often start and end with them).
    if (!this.search && this.buffered >= 4 && this.buffered + c.length !== this.need && wholeFrames(c)) {
      this.loss(out, this.buffered, "a frame cut short: the bytes after it start new frames");
      this.start = 0;
      this.end = 0;
      this.need = 0;
    }
    this.append(c);
    if (this.buffered < this.need) return out;
    const buf = this.store.subarray(this.start, this.end);
    let i = 0;
    let need = 0;
    for (;;) {
      if (this.search) {
        const found = this.resume(buf, i);
        if (found === undefined) {
          // Nothing yet: keep only what may still start a frame.
          const keep = Math.min(this.search.candidates[0] ?? Number.POSITIVE_INFINITY, this.search.scanned);
          this.search.dropped += keep - i;
          this.search.candidates = this.search.candidates.map((q) => q - keep);
          this.search.scanned -= keep;
          i = keep;
          need = buf.length - i + 1;
          break;
        }
        const { dropped, why } = this.search;
        this.search = undefined;
        this.loss(out, dropped + found - i, why);
        i = found;
        continue;
      }
      const v = frameAt(buf, i, false);
      if (v === "more") {
        need = buf.length - i + 1;
        break;
      }
      const n = buf.readUInt32BE(i);
      if (v === "bad") {
        this.search = { dropped: 0, why: `no NI frame starts where one should (length ${n})`, candidates: [], scanned: i + 1 };
        continue;
      }
      const end = i + 4 + n;
      if (buf.length < end) {
        need = end - i;
        break;
      }
      // Hold the frame until the next one shows whether it starts where this one ends.
      const next = end === buf.length ? "frame" : frameAt(buf, end, false);
      if (next === "more") {
        need = buf.length - i + 1;
        break;
      }
      // A copy: the store is written over by later chunks.
      const payload = Buffer.from(buf.subarray(i + 4, end));
      out.push(next === "frame" ? { payload } : { payload, suspect: true });
      i = end;
    }
    this.start += i;
    if (this.start >= this.end) {
      this.start = 0;
      this.end = 0;
      // A large frame's room is not kept once it is out.
      if (this.store.length > SMALL_STORE) this.store = Buffer.alloc(0);
    }
    this.need = need;
    return out;
  }

  /** Adds a chunk to the bytes held: in place when there is room, else in a buffer of twice the size needed. */
  private append(c: Buffer): void {
    const live = this.end - this.start;
    if (this.end + c.length > this.store.length) {
      const want = live + c.length;
      if (want <= this.store.length >> 1) {
        this.store.copy(this.store, 0, this.start, this.end);
      } else {
        const bigger = Buffer.allocUnsafe(Math.max(want * 2, 4096));
        this.store.copy(bigger, 0, this.start, this.end);
        this.store = bigger;
      }
      this.start = 0;
      this.end = live;
    }
    c.copy(this.store, this.end);
    this.end += c.length;
  }

  private loss(out: FrameEvent[], bytes: number, why: string): void {
    this.lost += bytes;
    out.push({ lost: bytes, why });
  }

  /**
   * Looks for a restart point from `from` on. A candidate is confirmed when
   * its frame ends where the bytes end, or the frame after it starts
   * plausibly too. Gives the first confirmed offset, or undefined (then
   * `search.candidates` and `search.scanned` say what to look at again).
   */
  private resume(buf: Buffer, from: number): number | undefined {
    const s = this.search as NonNullable<NiFramer["search"]>;
    const check = (q: number): Verdict => {
      const v = frameAt(buf, q, true);
      if (v !== "frame") return v;
      const end = q + 4 + buf.readUInt32BE(q);
      if (end > buf.length) return "more";
      if (end === buf.length) return "frame";
      const next = frameAt(buf, end, false);
      return next === "frame" ? "frame" : next;
    };
    let kept: number[] = [];
    for (const q of s.candidates) {
      if (q < from) continue;
      const v = check(q);
      if (v === "frame") return q;
      if (v === "more") kept.push(q);
    }
    let q = Math.max(s.scanned, from);
    for (; q < buf.length; q++) {
      const v = check(q);
      if (v === "frame") return q;
      if (v === "more") kept.push(q);
    }
    // Too many open candidates: the oldest give way, so that the search moves on.
    if (kept.length > MAX_CANDIDATES) kept = kept.slice(-MAX_CANDIDATES);
    s.candidates = kept;
    s.scanned = q;
    return undefined;
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
  /** The payload breaks off or does not decompress: damaged in transit, or not DIAG. (An unknown item type stops the parsing too, but is not damage.) */
  broken?: true;
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
  if (body.length < MESSAGE_HEADER) return { header: body, dp, items: [], problem: `payload of ${body.length} bytes is shorter than a DIAG header`, broken: true };
  const header = body.subarray(0, MESSAGE_HEADER);
  let data = body.subarray(MESSAGE_HEADER);
  const compression = header[7] ?? 0;
  if (compression === 1) {
    if (!isLzh(data)) return { header, dp, items: [], problem: "compressed message without an LZH header", broken: true };
    try {
      data = lzhDecompress(data);
    } catch (e) {
      return { header, dp, items: [], problem: e instanceof Error ? e.message : String(e), broken: true };
    }
  } else if (compression !== 0) {
    return { header, dp, items: [], problem: `encrypted message (SNC, compression flag ${compression}): not readable` };
  }
  const { items, problem, cut } = parseItems(data);
  if (problem === undefined) return { header, dp, items };
  return cut ? { header, dp, items, problem, broken: true } : { header, dp, items, problem };
}

/** The items of a decompressed message, or of an inner stream found in an RFC blob. */
export function parseItems(data: Buffer): { items: DiagItem[]; problem?: string; end: number; cut?: true } {
  const items: DiagItem[] = [];
  let i = 0;
  while (i < data.length) {
    const type = data[i] as number;
    if (hasId(type)) {
      const head = type === ITEM.short ? 5 : 7;
      if (i + head > data.length) return { items, problem: `item header cut at ${i}`, end: i, cut: true };
      const n = type === ITEM.short ? data.readUInt16BE(i + 3) : data.readUInt32BE(i + 3);
      if (i + head + n > data.length) return { items, problem: `item ${itemKey({ type, id: data[i + 1] ?? 0, sid: data[i + 2] ?? 0 })} of ${n} bytes cut at ${i}`, end: i, cut: true };
      items.push({ type, id: data[i + 1] as number, sid: data[i + 2] as number, value: data.subarray(i + head, i + head + n) });
      i += head + n;
    } else if (type === ITEM.xml) {
      if (i + 5 > data.length) return { items, problem: `item header cut at ${i}`, end: i, cut: true };
      const n = data.readUInt32BE(i + 1);
      if (i + 5 + n > data.length) return { items, problem: `xml item of ${n} bytes cut at ${i}`, end: i, cut: true };
      items.push({ type, id: 0, sid: 0, value: data.subarray(i + 5, i + 5 + n) });
      i += 5 + n;
    } else {
      const n = SIZE.get(type);
      // Without a known size the rest cannot be split into items: stop here, with what was read.
      if (n === undefined) return { items, problem: `unknown item type 0x${type.toString(16)} at ${i}`, end: i };
      if (i + 1 + n > data.length) return { items, problem: `item 0x${type.toString(16)} cut at ${i}`, end: i, cut: true };
      items.push({ type, id: 0, sid: 0, value: data.subarray(i + 1, i + 1 + n) });
      i += 1 + n;
    }
  }
  return { items, end: i };
}
