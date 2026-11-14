/**
 * The outer layers of DIAG: NI frames, the DP header of the first client
 * frame, the DIAG header, and the items of a message.
 *
 *   TCP stream  = NI frame*            4-byte big-endian length, then the payload
 *   NI payload  = [DP header 200] DIAG header 8, then the items (compressed when byte 7 is 1)
 *   item        = type 1, then by type: nothing more, a fixed number of bytes,
 *                 or id 1, sid 1, length 2 or 4 (big-endian) and the value
 */
import { isLzh, lzhDecompress } from "./lzh.js";

/** NI keep-alive payloads: answered by the peer, never DIAG. */
const NI_PING = "NI_PING\0";
const NI_PONG = "NI_PONG\0";

export const DP_HEADER = 200;
export const DIAG_HEADER = 8;

/** Item types. */
export const T = { SES: 0x01, ICO: 0x02, TIT: 0x03, MESSAGE: 0x07, OKC: 0x08, CHL: 0x09, SFE: 0x0a, SBA: 0x0b, EOM: 0x0c, APPL: 0x10, XMLBLOB: 0x11, APPL4: 0x12, SLC: 0x13, SBA2: 0x15 } as const;

/** Value lengths of the items that have no length field. */
const FIXED: Record<number, number> = { 0x01: 16, 0x02: 20, 0x03: 3, 0x07: 76, 0x08: 0, 0x09: 22, 0x0a: 3, 0x0b: 2, 0x0c: 0, 0x13: 2, 0x15: 36 };

/** APPL ids. */
export const A = { SCRIPT: 0x01, GRAPH: 0x02, IXOS: 0x03, ST_USER: 0x04, DYNN: 0x05, ST_R3INFO: 0x06, POPU: 0x07, RFC_TR: 0x08, DYNT: 0x09, CONTAINER: 0x0a, MNUENTRY: 0x0b, VARINFO: 0x0c, CONTROL: 0x0e, UI_EVENT: 0x0f, ACC_LIST: 0x12, RCUI: 0x13, GUI_PACKET: 0x14 } as const;

export interface DiagItem {
  type: number;
  /** APPL and APPL4 only; 0 otherwise. */
  id: number;
  sid: number;
  value: Buffer;
}

/** `type/id/sid` in hex, for the debug records. */
export function itemKey(it: { type: number; id: number; sid: number }): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return it.type === T.APPL || it.type === T.APPL4 ? `${h(it.type)}/${h(it.id)}/${h(it.sid)}` : h(it.type);
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
  /** The 8 header bytes: mode, com flags, mode stat, error number, message type, info, return code, compression. */
  header: Buffer;
  /** True when the payload began with the DP header (the first frame of a connection). */
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
  // The DP header: request id -1, and its length field (little-endian, at 30) counts what follows the 200 bytes.
  if (body.length >= DP_HEADER + DIAG_HEADER && body.readInt32BE(0) === -1 && body.readUInt32LE(30) === body.length - DP_HEADER) {
    body = body.subarray(DP_HEADER);
    dp = true;
  }
  if (body.length < DIAG_HEADER) return { header: body, dp, items: [], problem: `payload of ${body.length} bytes is shorter than a DIAG header` };
  const header = body.subarray(0, DIAG_HEADER);
  let data = body.subarray(DIAG_HEADER);
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
    if (type === T.APPL || type === T.APPL4) {
      const head = type === T.APPL ? 5 : 7;
      if (i + head > data.length) return { items, problem: `item header cut at ${i}`, end: i };
      const n = type === T.APPL ? data.readUInt16BE(i + 3) : data.readUInt32BE(i + 3);
      if (i + head + n > data.length) return { items, problem: `item ${itemKey({ type, id: data[i + 1] ?? 0, sid: data[i + 2] ?? 0 })} of ${n} bytes cut at ${i}`, end: i };
      items.push({ type, id: data[i + 1] as number, sid: data[i + 2] as number, value: data.subarray(i + head, i + head + n) });
      i += head + n;
    } else if (type === T.XMLBLOB) {
      if (i + 5 > data.length) return { items, problem: `item header cut at ${i}`, end: i };
      const n = data.readUInt32BE(i + 1);
      if (i + 5 + n > data.length) return { items, problem: `xml blob of ${n} bytes cut at ${i}`, end: i };
      items.push({ type, id: 0, sid: 0, value: data.subarray(i + 5, i + 5 + n) });
      i += 5 + n;
    } else {
      const n = FIXED[type];
      if (n === undefined) return { items, problem: `unknown item type 0x${type.toString(16)} at ${i}`, end: i };
      if (i + 1 + n > data.length) return { items, problem: `item 0x${type.toString(16)} cut at ${i}`, end: i };
      items.push({ type, id: 0, sid: 0, value: data.subarray(i + 1, i + 1 + n) });
      i += 1 + n;
    }
  }
  return { items, end: i };
}
