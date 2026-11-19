/**
 * What the router sees of one SAP GUI connection, for the waits of the
 * actions: SAP GUI's requests, SAP's answers, and what SAP GUI tells the
 * server about its own window.
 *
 * The decoder (src/diag) reads the screens. This reads the other direction
 * on its own, lightly (client messages are small): a message from SAP GUI
 * either answers a call of the server's control framework (it carries an
 * RFC item, mid-step) or it is a request the user's input made (Enter, a
 * function key, a click that SAP GUI sends on). The request names its mode
 * in byte 0 of the DIAG header. The decoder gives a screen when SAP is done
 * with the step and waits for input (byte 5 of the header is 1 and no call
 * is open). So an action is done when every request of its mode seen since
 * the input began has been answered by a screen of that mode: no timer
 * guesses when SAP has finished.
 *
 * A plan of several inputs (a click, arrow keys, then F2) can make SAP GUI
 * send a request before its last input (rows fetched while the arrows
 * move): the wait then also needs a request made after the last input began
 * (`last`), so that it does not end on the answer to an earlier one.
 *
 * When the answer is lost or cannot be read, no screen comes for the
 * request. A message of this mode that breaks off or does not decompress
 * (the decoder calls `trouble(mode)`) is this session's: its wait stops once
 * this session has had no message from the server for LOST_QUIET_MS (other
 * sessions' traffic does not count) and says that the session state is
 * unknown. Bytes lost on the connection (`trouble()`) cannot be told to one
 * session: they never cut a wait short, so another session's long step
 * runs on; the wait ends at its timeout. Either way the request stays open
 * (a next action is refused, not sent into a busy SAP) until a screen of
 * the mode comes or a look takes the last screen read as the state
 * (`recover`). Nothing waits forever.
 *
 * SAP GUI also sends, in user items (id 0x04), the pixel size of its
 * character cell (sid 0x04: height, width, then two more numbers, uint16
 * big-endian). On SAP GUI 8.00, Quartz, 100% it sent 27 and 8, which is
 * the cell measured on screen. Read here for the pixel mapping (geometry.ts).
 */
import { ID, ITEM, NiFramer, parseMessage } from "../diag/wire.js";

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
  /** After a damaged answer: the server's quiet that ends the wait (LOST_QUIET_MS when not given). */
  lostMs?: number;
}

export const DEFAULT_WAIT: WaitOptions = { requestMs: 3000, answerMs: 60_000, quietMs: 60, maxSettleMs: 1500 };
/** For an input that may stay inside SAP GUI (a click in a grid, a tree node): a short look for a request. */
export const MAYBE_REQUEST_MS = 700;
/** After bytes of the answer were lost or unreadable: how long the server must be quiet before the wait gives up on that answer. */
export const LOST_QUIET_MS = 3000;

export interface WaitResult {
  /** A request of this mode was seen after the input began. */
  requested: boolean;
  /** Every such request has its answer (a screen). */
  answered: boolean;
  /** The connection closed while waiting. */
  closed: boolean;
  /** A request came, but none after the last input began (the last input made SAP GUI send nothing). */
  lastMissing?: boolean;
  /** The answer was lost or could not be read: the session state is unknown. */
  unknown?: boolean;
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
  /** SAP's answer to the open request may be lost: "mode" when a message of this mode broke, "connection" when bytes of the connection were lost (`trouble`). */
  trouble: false | "mode" | "connection";
  /** Time of the last message from the server for this mode. */
  lastServerAt: number;
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
      m = { lastRequest: 0, lastRequestAt: 0, answered: 0, answeredAt: 0, recent: [], trouble: false, lastServerAt: 0 };
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
        if (it.type !== ITEM.short && it.type !== ITEM.long) continue;
        if (it.id === ID.rfc) answer = true;
        else if (it.id === ID.user && it.sid === 0x04 && it.value.length >= 4) {
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
    m.trouble = false;
    this.wake();
  }

  /**
   * Bytes from the server were lost, or a message of it could not be read
   * (of this mode, or of any when undefined): an open request may never get
   * its screen.
   */
  trouble(mode?: number): void {
    for (const [n, m] of this.modes) {
      if (m.lastRequest <= m.answered) continue;
      if (mode === undefined) m.trouble ||= "connection";
      else if (n === mode) m.trouble = "mode";
    }
    this.wake();
  }

  /** A message from the server for this mode came (the decoder read its header). */
  serverMessage(mode: number): void {
    this.state(mode).lastServerAt = this.now();
  }

  /** Is the open request of this mode one whose answer was damaged? */
  troubled(mode: number): boolean {
    const m = this.modes.get(mode);
    return !!m && m.trouble && m.lastRequest > m.answered;
  }

  /**
   * Takes the last screen read as the state of the mode after a damaged
   * answer (the request is closed). True when it did.
   */
  recover(mode: number): boolean {
    const m = this.modes.get(mode);
    if (!m?.trouble || m.lastRequest <= m.answered) return false;
    m.answered = m.lastRequest;
    m.answeredAt = this.now();
    m.trouble = false;
    this.wake();
    return true;
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
   * `last`: a mark taken before the plan's last input; a request after it
   * is waited for too (the answer to an earlier request does not end it).
   */
  async wait(mode: number, mark: number, inputEnd: number, o: WaitOptions, last = mark): Promise<WaitResult> {
    const m = this.state(mode);
    const out: WaitResult = { requested: false, answered: false, closed: false, requests: 0, start: 0, sap: 0, settle: 0 };
    const seen = () => m.lastRequest > mark;
    const seenLast = () => m.lastRequest > Math.max(mark, last);
    // 1. the request, made by the last input
    while (!seenLast() && this.open) {
      const left = inputEnd + o.requestMs - this.now();
      if (left <= 0) break;
      await this.next(left);
    }
    if (!this.open) out.closed = true;
    if (!seen()) return out;
    out.requested = true;
    if (!seenLast()) out.lastMissing = true;
    const first = this.now();
    out.start = Math.max(0, first - inputEnd);
    // 2. the answers, then quiet; a request that comes during the quiet wait is waited for too
    const answerEnd = first + o.answerMs;
    let settleFrom = 0;
    for (;;) {
      while (m.answered < m.lastRequest && this.open) {
        const left = answerEnd - this.now();
        if (left <= 0) break;
        if (m.trouble === "mode") {
          // This session's answer was damaged: once the server is quiet for this session, no screen will come for it.
          const quiet = Math.max(m.lastServerAt, m.lastRequestAt) + (o.lostMs ?? LOST_QUIET_MS) - this.now();
          if (quiet <= 0) {
            out.unknown = true;
            break;
          }
          await this.next(Math.min(left, quiet));
          continue;
        }
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
  if (r.unknown)
    return "SAP's answer to this step was lost or could not be read on the connection, so the session state is unknown: look (sap_look) before anything else. The look shows the last screen read whole and takes it as the state; if SAP GUI shows something else, press Enter in SAP GUI once";
  if (r.lastMissing && expected && r.answered) return `SAP GUI sent nothing to SAP for the last input of this action within ${seconds(o.requestMs)} s (only for an earlier one): the last key may have missed. Look (sap_look) before trying again`;
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
