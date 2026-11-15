/**
 * DiagDecoder: SAP GUI's traffic with the application server, read into
 * screens.
 *
 * Feed it the raw bytes of one TCP connection, per direction, as they pass.
 * It splits them into NI frames, decompresses and parses the DIAG messages,
 * follows the RFC calls the server makes to SAP GUI's control framework,
 * and keeps the state of every session ("mode") of the connection. After
 * each server message that ends a dialog step it gives the screen of that
 * mode as a DiagScreen.
 *
 * It only reads. It never throws on what it does not know: unknown items
 * and broken pieces are counted in `notes`.
 *
 * How a dialog step looks on the wire (byte 5 of the DIAG header: 1 = the
 * server is done and waits, 2 = more follows without an answer):
 *
 * - a small screen: one message with the items of the screen;
 * - calls to the control framework: a message with an RFC_TR item (REQ),
 *   answered by SAP GUI (RET), any number of times before the screen;
 * - a large screen: the items travel inside an RFC call,
 *   GUICORE_BLOB_DIAG_PARSER, cut into RFC_TR fragments (MOR, each
 *   acknowledged, then RNB), followed by an empty message that ends the
 *   step.
 */
import { ClassicState } from "./classic.js";
import { Controls } from "./controls.js";
import { parseRfc } from "./rfc.js";
import type { DiagControl, DiagElement, DiagScreen, DiagWindow } from "./screen.js";
import { clean, decode } from "./text.js";
import { A, type DiagItem, NiFramer, parseItems, parseMessage, T } from "./wire.js";

/** RFC_TR sub-ids: a call that wants an answer, its answer, a fragment with more to come, a call without answer. */
const RFC = { REQ: 0x00, RET: 0x01, ERR: 0x02, MOR: 0x04, RNB: 0x06 } as const;

/** Everything kept for one mode. */
class Mode {
  readonly classic: ClassicState;
  readonly controls: Controls;
  step = 0;
  /** Fragments of an RFC call still arriving, per direction. */
  fragments: [Buffer[], Buffer[]] = [[], []];
  lastCommand: string | undefined;
  /** The user acted since the last screen: the next server message opens a new step. */
  userActed = true;
  screen: DiagScreen | undefined;

  constructor(note: (what: string) => void) {
    this.classic = new ClassicState(note);
    this.controls = new Controls(note);
  }
}

export class DiagDecoder {
  /** Called after each server message that ends a dialog step, with the screen of the mode it was for. */
  onScreen?: (screen: DiagScreen, mode: number) => void;
  /** What was not understood, with how often: unknown items, element types, pieces that broke off. For debugging. */
  readonly notes = new Map<string, number>();

  private framers: [NiFramer, NiFramer] = [new NiFramer(), new NiFramer()];
  private modes = new Map<number, Mode>();
  private latest: number | undefined;

  private note = (what: string): void => {
    this.notes.set(what, (this.notes.get(what) ?? 0) + 1);
  };

  /** Raw bytes of the connection: direction 0 from SAP GUI to the server, 1 from the server to SAP GUI. */
  push(dir: 0 | 1, chunk: Uint8Array): void {
    let payloads: Buffer[];
    try {
      payloads = this.framers[dir].push(chunk);
    } catch (e) {
      this.note(`framing: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const payload of payloads) {
      try {
        this.message(dir, payload);
      } catch (e) {
        this.note(`message not read: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** The screen of the mode that last finished a step (or of the mode asked for). */
  screen(mode?: number): DiagScreen | undefined {
    const m = mode ?? this.latest;
    return m === undefined ? undefined : this.modes.get(m)?.screen;
  }

  /** The current screen of every mode of the connection, by mode number. */
  screens(): Map<number, DiagScreen> {
    const out = new Map<number, DiagScreen>();
    for (const [n, m] of this.modes) if (m.screen) out.set(n, m.screen);
    return out;
  }

  private mode(n: number): Mode {
    let m = this.modes.get(n);
    if (!m) {
      m = new Mode(this.note);
      this.modes.set(n, m);
    }
    return m;
  }

  private message(dir: 0 | 1, payload: Buffer): void {
    const msg = parseMessage(payload);
    if (!msg) return;
    if (msg.problem) this.note(msg.problem);
    if (msg.header.length < 8) return;
    const number = msg.header[0] ?? 0;
    const mode = this.mode(number);
    if (dir === 0) return this.fromClient(mode, msg.items);
    if (mode.userActed) {
      mode.classic.clearMessage();
      mode.userActed = false;
    }
    let waitsForAnswer = false;
    const plain: DiagItem[] = [];
    for (const it of msg.items) {
      if ((it.type === T.APPL || it.type === T.APPL4) && it.id === A.RFC_TR) {
        // Items before a call are applied before it, so that screen and controls keep their order.
        mode.classic.apply(plain.splice(0));
        waitsForAnswer = this.rfc(mode, 1, it) || waitsForAnswer;
      } else plain.push(it);
    }
    mode.classic.apply(plain);
    if (msg.header[5] === 1 && !waitsForAnswer && mode.classic.windows.length) this.emit(number, mode);
  }

  private fromClient(mode: Mode, items: DiagItem[]): void {
    let answer = false;
    for (const it of items) {
      if (it.type !== T.APPL && it.type !== T.APPL4) continue;
      if (it.id === A.RFC_TR) {
        answer = true;
        this.rfc(mode, 0, it);
      } else if (it.id === A.VARINFO && it.sid === 0x04) mode.lastCommand = clean(decode(it.value, mode.classic.utf8)).trim();
    }
    if (!answer && items.length) mode.userActed = true;
  }

  /** One RFC_TR item. Returns true when it is a call SAP GUI still has to answer (the step goes on). */
  private rfc(mode: Mode, dir: 0 | 1, it: DiagItem): boolean {
    const fragments = mode.fragments[dir];
    if (it.sid === RFC.MOR) {
      if (it.value.length) fragments.push(it.value);
      return true;
    }
    const payload = fragments.length ? Buffer.concat([...fragments, it.value]) : it.value;
    fragments.length = 0;
    if (it.sid !== RFC.REQ && it.sid !== RFC.RET && it.sid !== RFC.RNB) {
      this.note(`RFC_TR item ${it.sid}`);
      return false;
    }
    if (!payload.length) return it.sid === RFC.REQ;
    const call = parseRfc(payload);
    if (call.problem) this.note(`${call.function || "RFC answer"}: ${call.problem}`);
    for (const t of call.tables.values()) if (t.problem) this.note(`table ${t.name} of ${call.function || "RFC answer"}: ${t.problem}`);
    if (dir === 0) {
      mode.controls.clientAnswer(call);
      return false;
    }
    if (call.function === "GUICORE_BLOB_DIAG_PARSER") {
      const stream = call.params.get("STREAM");
      if (stream) {
        const inner = parseItems(stream);
        if (inner.problem) this.note(`inner stream: ${inner.problem}`);
        mode.classic.apply(inner.items);
      }
    } else if (call.function === "OLE_FLUSH_CALL") mode.controls.serverCall(call, mode.classic.utf8, mode.classic.revision);
    else if (call.function !== "SAPGUI_PROGRESS_INDICATOR") this.note(`RFC call ${call.function}`);
    return it.sid === RFC.REQ;
  }

  private emit(number: number, mode: Mode): void {
    mode.step++;
    const onShow = (program: string, dynpro: number): boolean => mode.classic.windows.some((w) => w.program === program && Number(w.dynpro) === dynpro);
    mode.controls.dropClosed(onShow);
    const controls = mode.controls.snapshot();
    const windows: DiagWindow[] = mode.classic.windows.map((w) => {
      const elements = w.elements.map((e) => ({ ...e }));
      pairLabels(elements);
      const mine: DiagControl[] = [];
      for (const c of controls) {
        const area = w.containers.find((k) => k.name === c.container);
        if (area) mine.push({ ...c, area: { row: area.row, col: area.col, width: area.width, height: area.height } });
      }
      // A control tied to the dynpro itself draws the whole popup: its caption is the title the user sees.
      let caption: string | undefined;
      for (const c of controls) {
        if (!c.dynpro || c.dynpro.program !== w.program || c.dynpro.number !== Number(w.dynpro)) continue;
        mine.push(c);
        caption ??= c.title;
      }
      return { ...w, elements, controls: mine, ...(caption ? { title: caption, dynproTitle: w.title } : {}) };
    });
    // Controls without a container on any window (docked beside the screen) go to the window on top while they are fresh.
    const placed = new Set(windows.flatMap((w) => w.controls.map((c) => c.id)));
    const top = windows[windows.length - 1];
    if (top) for (const c of controls) if (!placed.has(c.id) && !c.container && (c.grid || c.tree || c.text !== undefined) && (mode.controls.controls.get(c.id)?.touched ?? -1) >= mode.classic.revision) top.controls.push(c);
    const screen: DiagScreen = { mode: number, step: mode.step, session: { ...mode.classic.session }, windows, ...(mode.classic.message ? { message: { ...mode.classic.message } } : {}), ...(mode.lastCommand ? { lastCommand: mode.lastCommand } : {}) };
    mode.screen = screen;
    this.latest = number;
    this.onScreen?.(screen, number);
  }
}

/**
 * Gives each field, dropdown and unnamed checkbox the label that stands for
 * it: the nearest label to its left on the same row. A read-only text at the
 * start of a row with nothing before it is a label too (SAP screens use
 * output fields for texts that change, like "Standard Order").
 */
export function pairLabels(elements: DiagElement[]): void {
  const rows = new Map<number, DiagElement[]>();
  for (const e of elements) {
    if (e.hidden) continue;
    let row = rows.get(e.row);
    if (!row) {
      row = [];
      rows.set(e.row, row);
    }
    row.push(e);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.col - b.col);
    let label: string | undefined;
    for (const e of row) {
      if (e.kind === "label") {
        if (e.text) label = e.text;
      } else if (e.kind === "group") label = undefined;
      else if (e.kind === "field" || e.kind === "dropdown") {
        if (label === undefined && e.kind === "field" && !e.input && e.text) label = e.text;
        else if (label !== undefined) e.label = label;
      } else if ((e.kind === "checkbox" || e.kind === "radio") && !e.text && label !== undefined) e.label = label;
    }
  }
}
