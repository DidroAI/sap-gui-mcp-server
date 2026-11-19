/**
 * What the router sees of one SAP GUI connection, for the waits of the
 * actions: SAP GUI's requests, SAP's answers, and what SAP GUI tells the
 * server about its own window.
 *
 * The decoder (src/diag) reads the screens. This reads the other direction
 * on its own, lightly (client messages are small): a message from SAP GUI
 * either answers a call of the server's control framework (it carries an
 * RFC_TR item, mid-step) or it is a request the user's input made (Enter, a
 * function key, a click that SAP GUI sends on). The request names its mode
 * in byte 0 of the DIAG header. The decoder gives a screen when SAP is done
 * with the step and waits for input (byte 5 of the header is 1 and no call
 * is open). So an action is done when every request of its mode seen since
 * the input began has been answered by a screen of that mode: no timer
 * guesses when SAP has finished.
 *
 * SAP GUI also sends, in ST_USER items (APPL 0x04), the pixel size of its
 * character cell (sid 0x04: height, width, then two more numbers, uint16
 * big-endian). On SAP GUI 8.00, Quartz, 100% it sent 27 and 8 (X-271's
 * measured 8 x 27 px). Read here for the pixel mapping (geometry.ts).
 */
import { A, NiFramer, parseMessage, T } from "../diag/wire.js";

/** Cell size in pixels as SAP GUI reported it. */
export interface FontCell {
  /** Width and height of one character cell. */
  cw: number;
  ch: number;
}

export interface WaitOptions {
  /** How long to wait for SAP GUI to send a request after the input ended. */
  requestMs: number;
  /** How long to wait for SAP's answer once the request was sent. */
  answerMs: number;
  /** After the answer: the traffic must be quiet this long (a popup or more rows can follow at once). */
  quietMs: number;
  /** The quiet wait never adds more than this. */
  maxSettleMs: number;
}

export const DEFAULT_WAIT: WaitOptions = { requestMs: 3000, answerMs: 60_000, quietMs: 60, maxSettleMs: 1500 };
/** For an input that may stay inside SAP GUI (a click in a grid, a tree node): a short look for a request. */
export const MAYBE_REQUEST_MS = 700;

export interface WaitResult {
  /** A request of this mode was seen after the input began. */
  requested: boolean;
  /** Every such request has its answer (a screen). */
  answered: boolean;
  /** The connection closed while waiting. */
  closed: boolean;
  /** Requests seen for this mode since the input began. */
  requests: number;
  /** Milliseconds: input end to the first request (0 when it came during the input), first request to the last answer, then the quiet wait. */
  start: number;
  sap: number;
  settle: number;
}

interface ModeState {
  /** Number of the last request seen, over the whole connection. */
  lastRequest: number;
  lastRequestAt: number;
  /** Number of the last request that a screen answered. */
  answered: number;
  answeredAt: number;
  /** Numbers of the last requests of this mode, to count them. */
  recent: number[];
}

export class Traffic {
  /** Requests seen on this connection, all modes. */
  seq = 0;
  /** Time of the last bytes from the server. */
  lastServerAt = 0;
  /** Milliseconds spent in the decoder, summed (the driver reads the difference over an action). */
  decodeMs = 0;
  font: FontCell | undefined;
  open = true;
  private framer = new NiFramer();
  private modes = new Map<number, ModeState>();
  private waiters: (() => void)[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  private state(mode: number): ModeState {
    let m = this.modes.get(mode);
    if (!m) {
      m = { lastRequest: 0, lastRequestAt: 0, answered: 0, answeredAt: 0, recent: [] };
      this.modes.set(mode, m);
    }
    return m;
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Bytes from SAP GUI to the server. Never throws. */
  client(chunk: Uint8Array): void {
    let payloads: Buffer[];
    try {
      payloads = this.framer.push(chunk);
    } catch {
      return;
    }
    for (const p of payloads) {
      const msg = parseMessage(p);
      if (!msg || msg.header.length < 8) continue;
      let answer = false;
      for (const it of msg.items) {
        if (it.type !== T.APPL && it.type !== T.APPL4) continue;
        if (it.id === A.RFC_TR) answer = true;
        else if (it.id === A.ST_USER && it.sid === 0x04 && it.value.length >= 4) {
          const ch = it.value.readUInt16BE(0);
          const cw = it.value.readUInt16BE(2);
          if (cw >= 3 && cw <= 64 && ch >= 6 && ch <= 128) this.font = { cw, ch };
        }
      }
      if (answer || !msg.items.length) continue;
      const m = this.state(msg.header[0] ?? 0);
      m.lastRequest = ++this.seq;
      m.lastRequestAt = this.now();
      m.recent.push(m.lastRequest);
      if (m.recent.length > 64) m.recent.shift();
      this.wake();
    }
  }

  /** Bytes from the server came (before the decoder reads them). */
  server(): void {
    this.lastServerAt = this.now();
    this.wake();
  }

  /** The decoder gave a screen of this mode: SAP is done with the step. */
  screen(mode: number): void {
    const m = this.state(mode);
    if (m.lastRequest > m.answered) {
      m.answered = m.lastRequest;
      m.answeredAt = this.now();
    }
    this.wake();
  }

  closed(): void {
    this.open = false;
    this.wake();
  }

  /** A mark to wait from: take it before the input. */
  mark(): number {
    return this.seq;
  }

  /** Is a request of this mode still without its answer? */
  pending(mode: number): boolean {
    const m = this.modes.get(mode);
    return !!m && m.lastRequest > m.answered;
  }

  /** Resolves on the next event, or after `ms`. */
  private next(ms: number): Promise<void> {
    return new Promise<void>((r) => {
      const t = setTimeout(done, Math.max(0, ms));
      function done() {
        clearTimeout(t);
        r();
      }
      this.waiters.push(done);
    });
  }

  /**
   * Waits for SAP's answer to what the input since `mark` made SAP GUI send
   * for `mode`. `inputEnd` is when the input ended. With `requestMs` 0 no
   * request is awaited (an input that stays in SAP GUI): only one that came.
   */
  async wait(mode: number, mark: number, inputEnd: number, o: WaitOptions): Promise<WaitResult> {
    const m = this.state(mode);
    const out: WaitResult = { requested: false, answered: false, closed: false, requests: 0, start: 0, sap: 0, settle: 0 };
    const seen = () => m.lastRequest > mark;
    // 1. the request
    while (!seen() && this.open) {
      const left = inputEnd + o.requestMs - this.now();
      if (left <= 0) break;
      await this.next(left);
    }
    if (!this.open) out.closed = true;
    if (!seen()) return out;
    out.requested = true;
    const first = this.now();
    out.start = Math.max(0, first - inputEnd);
    // 2. the answers, then quiet; a request that comes during the quiet wait is waited for too
    const answerEnd = first + o.answerMs;
    let settleFrom = 0;
    for (;;) {
      while (m.answered < m.lastRequest && this.open) {
        const left = answerEnd - this.now();
        if (left <= 0) break;
        await this.next(left);
      }
      if (!this.open) out.closed = true;
      if (m.answered < m.lastRequest) break;
      out.answered = true;
      settleFrom ||= this.now();
      // quiet: no server bytes for quietMs, within maxSettleMs of the first answer
      const quietEnd = () => Math.max(this.lastServerAt, m.answeredAt) + o.quietMs;
      while (this.open && m.answered === m.lastRequest && this.now() < quietEnd() && this.now() < settleFrom + o.maxSettleMs) await this.next(Math.min(quietEnd(), settleFrom + o.maxSettleMs) - this.now());
      if (m.answered === m.lastRequest || !this.open) break;
      out.answered = false;
    }
    const end = this.now();
    out.requests = this.seqOf(mode, mark);
    if (out.answered) {
      out.sap = Math.max(0, (settleFrom || end) - first);
      out.settle = Math.max(0, end - (settleFrom || end));
    } else out.sap = end - first;
    return out;
  }

  /** Requests of this mode since mark. */
  private seqOf(mode: number, mark: number): number {
    return this.modes.get(mode)?.recent.filter((n) => n > mark).length ?? 0;
  }
}

const seconds = (ms: number) => String(Math.round(ms / 100) / 10);

/** The answer's words for a wait that did not end with SAP's answer, or undefined when it did. */
export function waitNote(r: WaitResult, o: WaitOptions, expected: boolean): string | undefined {
  if (r.closed) return "the SAP GUI connection closed during the step";
  if (!r.requested) return expected ? `SAP GUI sent nothing to SAP within ${seconds(o.requestMs)} s: the input may have missed, or the key or button is not active on this screen. Look (sap_look) before trying again` : undefined;
  if (!r.answered)
    return `SAP has not answered within ${seconds(o.answerMs)} s: the step is still running in SAP. Look again later (sap_look) before the next action; a long step can be given more time with "timeout" (seconds)`;
  return undefined;
}

/** The wait for one action: the defaults, with the action's own "timeout" (seconds, up to `max` ms) for SAP's answer. */
export function waitOptions(action: { timeout?: unknown; [k: string]: unknown }, env: Record<string, string | undefined> = {}, max = 600_000): WaitOptions {
  const t = Number(action.timeout);
  const answerMs = Number.isFinite(t) && t > 0 ? Math.min(Math.round(t * 1000), max) : DEFAULT_WAIT.answerMs;
  // SAP_DIAG_QUIET_MS and SAP_DIAG_REQUEST_MS tune the quiet wait and the wait for SAP GUI's request (a slow desktop).
  const quiet = Number(env.SAP_DIAG_QUIET_MS);
  const request = Number(env.SAP_DIAG_REQUEST_MS);
  return { ...DEFAULT_WAIT, answerMs, ...(Number.isFinite(quiet) && quiet >= 0 ? { quietMs: quiet } : {}), ...(Number.isFinite(request) && request > 0 ? { requestMs: request } : {}) };
}
