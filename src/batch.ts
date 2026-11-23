/**
 * Several actions in one `sap_act` call: `{"actions":[...]}`.
 *
 * An agent that sees a screen with six fields knows the six `set`s and the
 * Enter that sends them. One call per action costs a model turn each; a batch
 * costs one. What a batch must not do is go on blind: the ids the agent sent
 * are the ids of the screen it saw. So after each action the server reads the
 * screen and ends the batch, before the next action, when
 *
 * - a popup opened (it asks something the agent has not read);
 * - the status bar shows an error, a warning or a termination;
 * - the screen is another one (transaction, program or screen number), and
 *   the next action is not sure to belong there (`goesOnAfter` in server.ts:
 *   it goes on when the next action's id is on the new screen and it does
 *   not write);
 * - the step's `expect` is not met;
 * - SAP is still working on the step.
 *
 * A step says what it knows will happen with `expect`, and the batch goes on
 * through it: `{"screen":"4001"}` (also `transaction`, `title`),
 * `{"popup":true}`, `{"status":"W"}`; `{"screen":"*"}` is any screen. The server ends the batch too when an
 * action fails, is refused or waits for the user's yes (server.ts): each
 * action of a batch has its own guard decision, as if it were sent alone.
 *
 * This file is the part without a session: reading the batch, and the rules.
 */
import { LOOK, type NormalizedAction, normalizeAction } from "./core/action.js";
import { okcodeKind } from "./core/guard.js";
import { ActionError } from "./core/types.js";
import { type ParsedScreen, stillWorking } from "./record/screen.js";

/** The most actions one call runs. */
export const MAX_BATCH = 20;

/** What a step says the screen is like after it. */
export interface Expect {
  /** The screen (dynpro) number, "4001"; leading zeros do not count. */
  screen?: string;
  transaction?: string;
  /** Text the title of the window in front contains. */
  title?: string;
  /** A message type (S, I, W, E, A), or text the status bar's message contains. */
  status?: string;
  /** true: this step opens a popup. false: no popup is open after it. */
  popup?: boolean;
}

export interface BatchStep {
  /** The action's number in the list the agent sent, from 1 (a step that is not run leaves a gap). */
  n: number;
  action: NormalizedAction;
  /** Said after the step's own line in the answer: the action after it did not run, and why. */
  note?: string;
  expect?: Expect;
  /** The answer shows the screen after this step too, not only the last one. */
  show: boolean;
  /** This step may write on a screen the agent has not seen in this batch (see `unseenWrite`). */
  unseen: boolean;
}

const EXPECT_KEYS = ["screen", "transaction", "title", "status", "popup"];
const EXPECT_HELP = '"expect" is an object with any of: "screen" (the screen number), "transaction", "title", "status" (S, I, W, E, A, or text of the message), "popup" (true or false), e.g. {"screen":"4001"}.';

function parseExpect(raw: unknown): Expect | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ActionError(EXPECT_HELP);
  const out: Expect = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (!EXPECT_KEYS.includes(k)) throw new ActionError(`"expect" has no "${k.slice(0, 40)}". ${EXPECT_HELP}`);
    if (k === "popup") {
      if (typeof v !== "boolean") throw new ActionError('"expect": "popup" is true or false.');
      out.popup = v;
    } else {
      if (typeof v !== "string" && typeof v !== "number") throw new ActionError(`"expect": "${k}" is a string.`);
      const s = String(v).trim();
      if (s) out[k as "screen" | "transaction" | "title" | "status"] = s;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * An okcode that starts a transaction ("/nVA03") says where it leads: the
 * batch goes on into that transaction's first screen, as if the step said
 * {"transaction":"VA03"}. Agents write a batch that way (seen on live
 * systems: without it, every such batch ran its first action only). The
 * actions after it are still checked one by one: an id that is not on that
 * screen fails and ends the batch with the screen, and a write there does not
 * run unless its step says "unseen" (`unseenWrite`).
 */
function opens(action: NormalizedAction): Expect | undefined {
  // A Fiori app opened by its intent: whatever page it shows is the one asked for.
  if (action.do === "open") return { screen: ANY };
  if (action.do !== "okcode" || typeof action.value !== "string" || !/^\/[nN*]/.test(action.value.trim())) return undefined;
  const k = okcodeKind(action.value);
  // "/nPurchaseOrder-manage" is a Fiori app's intent (the Fiori surface opens it), not a transaction a header would name.
  return k.kind === "transaction" && !/[-#]/.test(k.tcode) ? { transaction: k.tcode } : undefined;
}

/** `expect` "*": any screen, transaction or title. */
export const ANY = "*";

/** What the answer says in place of an Enter that came right after an okcode. */
export const SKIPPED_ENTER = "(skipped Enter: okcode already submits)";

/** `{"do":"look"}`: not an action; agents send it for the screen after the step before it. */
export function isLook(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const d = (raw as { do?: unknown }).do;
  return typeof d === "string" && d.trim().toLowerCase() === LOOK;
}

/** A key 0 or Enter with nothing else said about it. */
const bareEnter = (s: BatchStep) => s.action.do === "key" && (s.action.key === 0 || s.action.key === "Enter") && !s.expect && !s.show && !s.unseen;

/**
 * The steps of a batch, each action normalised as `sap_act` normalises one.
 * Any step that is not a valid action refuses the whole batch: nothing runs.
 * An empty list is no steps: the server answers with the screen.
 *
 * Two habits of agents are taken as meant rather than refused:
 * - `{"do":"look"}` asks for the screen after the step before it (`show`);
 * - a bare Enter right after an okcode does not run: the okcode already
 *   submitted. Live, 110 batches sent both; 42 then hit an error status, and
 *   once the extra Enter went past VF01's first screen and billed the wrong
 *   document. The okcode's line says it was skipped.
 */
export function parseBatch(input: unknown): BatchStep[] {
  if (!Array.isArray(input)) throw new ActionError('"actions" is a list of actions, e.g. [{"do":"set","id":"ctxtVBAK-AUART","value":"OR"},{"do":"key","key":0}].');
  if (input.length > MAX_BATCH) throw new ActionError(`"actions" takes ${MAX_BATCH} actions at most (got ${input.length}): send the actions of one screen, then go on from the answer.`);
  const steps: BatchStep[] = [];
  for (const [i, raw] of input.entries()) {
    const n = i + 1;
    if (isLook(raw)) {
      const prev = steps.at(-1);
      if (prev) prev.show = true;
      continue;
    }
    let step: BatchStep;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) step = { n, action: normalizeAction(raw), show: false, unseen: false };
      else {
        const { expect, show, unseen, ...rest } = raw as Record<string, unknown>;
        if (show !== undefined && show !== null && typeof show !== "boolean") throw new ActionError('"show" is true or false.');
        if (unseen !== undefined && unseen !== null && typeof unseen !== "boolean") throw new ActionError('"unseen" is true or false.');
        const action = normalizeAction(rest);
        const e = parseExpect(expect) ?? opens(action);
        step = { n, action, ...(e ? { expect: e } : {}), show: show === true, unseen: unseen === true };
      }
    } catch (e) {
      if (e instanceof ActionError) throw new ActionError(`Action ${n} of ${input.length}: ${e.message}\nNothing ran.`);
      throw e;
    }
    const prev = steps.at(-1);
    if (prev && prev.n === n - 1 && prev.action.do === "okcode" && bareEnter(step)) {
      prev.note = SKIPPED_ENTER;
      continue;
    }
    steps.push(step);
  }
  return steps;
}

/** Why a batch ends after a step. */
export interface Stop {
  why: "popup" | "status" | "screen" | "expect" | "busy";
  text: string;
}

const popups = (s: ParsedScreen) => s.windows.filter((w) => /^wnd\[[1-9]\d*\]$/.test(w.id));
const number = (s: string | undefined) => (s ?? "").trim().replace(/^0+(?=\d)/, "");
const same = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();
const where = (s: ParsedScreen) => [s.transaction, s.program && `program ${s.program}`, s.screen && `screen ${s.screen}`].filter(Boolean).join(", ") + (s.title ? ` ("${s.title}")` : "");

/**
 * Actions that type or mark and send nothing to SAP on SAP GUI: the status
 * bar after them is the one from before. An error that was there when the
 * batch began does not end it at the first field the agent corrects.
 */
const LOCAL = new Set(["set", "check", "focus"]);

function statusMet(s: ParsedScreen, want: string): boolean {
  if (!s.status) return false;
  if (/^[SIWEA]$/i.test(want)) return (s.status.type ?? "").toUpperCase() === want.toUpperCase();
  return s.status.text.toLowerCase().includes(want.toLowerCase());
}

/** Did the step lead to another screen? With a popup open the header names the popup's screen, so the main window's title is compared. */
function moved(before: ParsedScreen, after: ParsedScreen): boolean {
  if ((before.transaction || after.transaction) && !same(before.transaction, after.transaction)) return true;
  const pb = popups(before).length;
  const pa = popups(after).length;
  if (pb === 0 && pa === 0) return !same(before.program, after.program) || number(before.screen) !== number(after.screen);
  if (pb !== pa) return (before.windows[0]?.title ?? "") !== (after.windows[0]?.title ?? "");
  return false;
}

/**
 * Why the batch ends after this step, given the screen before and after it;
 * undefined when the next action may run.
 */
export function stopAfter(action: NormalizedAction, before: ParsedScreen, after: ParsedScreen, expect?: Expect): Stop | undefined {
  if (stillWorking(after.text)) return { why: "busy", text: "SAP is still working on it: the screen is from before the step" };
  const pb = popups(before);
  const pa = popups(after);
  const top = pa.at(-1);
  const opened = !!top && (pa.length > pb.length || (pa.length === pb.length && top.title !== pb.at(-1)?.title));
  if (opened && expect?.popup !== true) return { why: "popup", text: `a popup opened ("${top.title}")` };
  const st = after.status;
  if (st?.type && /^[EWA]$/.test(st.type)) {
    const left = LOCAL.has(action.do) && before.status?.type === st.type && before.status.text === st.text;
    if (!left && !(expect?.status && statusMet(after, expect.status))) return { why: "status", text: `the status bar shows ${st.type}: ${st.text}` };
  }
  const named = expect?.screen !== undefined || expect?.transaction !== undefined || expect?.title !== undefined;
  // A popup the step said it opens is not another screen: the screen below is still there.
  if (!named && !(opened && expect?.popup === true) && moved(before, after)) return { why: "screen", text: `the screen changed: it is now ${where(after)}` };
  if (!expect) return undefined;
  const unmet: string[] = [];
  if (expect.screen !== undefined && expect.screen !== ANY && number(expect.screen) !== number(after.screen)) unmet.push(`screen ${expect.screen} (it is ${after.screen ?? "unknown"})`);
  if (expect.transaction !== undefined && expect.transaction !== ANY && !same(expect.transaction, after.transaction)) unmet.push(`transaction ${expect.transaction} (it is ${after.transaction ?? "unknown"})`);
  if (expect.title !== undefined && expect.title !== ANY && !(after.title ?? "").toLowerCase().includes(expect.title.toLowerCase())) unmet.push(`a title with "${expect.title}" (it is "${after.title ?? ""}")`);
  if (expect.status !== undefined && !statusMet(after, expect.status)) unmet.push(`status ${expect.status} (${st ? `it is ${st.type ? `${st.type}: ` : ""}${st.text}` : "the status bar is empty"})`);
  if (expect.popup === true && !opened) unmet.push("a popup (none opened)");
  if (expect.popup === false && top) unmet.push(`no popup ("${top.title}" is open)`);
  return unmet.length ? { why: "expect", text: `expected ${unmet.join(", ")}` } : undefined;
}

/** A container segment that names no control on its own: a control's shell and its container. */
const GENERIC = /^(shell|shellcont)(\[\d+\])?$/;

/**
 * An action's note with each id of a control in a window's user area cut to
 * its last part, as the compact view names it: "set wnd[0]/usr/tabsTAXI/
 * tabpT\01/ssubBODY:SAPMV45A:4400/.../ctxtRV45A-MABNR[1,0]" is "set
 * ctxtRV45A-MABNR[1,0]" (ME21N: 7 such lines of 200 characters in one batch).
 * A shell keeps the control it belongs to: "cntlGRID1/shell".
 */
export function shortNote(note: string): string {
  return note.replace(/\bwnd\[\d+\]\/usr\/((?:[^\s/"]+\/)*[^\s/"]+)/g, (_m, path: string) => {
    const segs = path.split("/");
    let at = segs.length - 1;
    while (at > 0 && GENERIC.test(segs[at] ?? "")) at--;
    return segs.slice(at).join("/").replace(/\/shellcont\//g, "/");
  });
}

/** The id of a line of a view: what stands before its first two spaces, without a cell's [col,row]. */
const lineId = (l: string) => (l.split("  ", 1)[0] ?? "").replace(/\[\d+,\d+\]$/, "");

/**
 * Is the control `id` on the screen `view` shows (compact or full)? A line's
 * id is it, or ends with it after a "/"; a table cell counts by its column
 * (any row). A Fiori control counts where its id stands in a line, as the
 * compact view writes it ("#tail") or the full one ("id=<full id>"), sent
 * with or without "#", as that tail or as a longer one (the driver finds a
 * control by any tail of its id cut at "--" or "::"). Live 2026-11-23: a
 * batch stopped after a tile press opened the app, though the next id
 * ("SalesOrder-inner", sent without "#") was on it.
 */
export function idOn(view: string, id: string): boolean {
  const want = id.trim().replace(/\[\d+,\d+\]$/, "");
  if (!want) return false;
  const fiori = view.startsWith("FIORI");
  const bare = want.replace(/^#/, "").replace(/^id=/, "");
  for (const l of view.split("\n")) {
    const got = lineId(l);
    if (got === want || got.endsWith(`/${want}`)) return true;
    if (!fiori && !want.startsWith("#")) continue;
    for (const m of l.matchAll(/(?:^|\s)(?:#|id=)(\S+)/g)) {
      const shown = m[1] ?? "";
      if (shown === bare || shown.endsWith(`--${bare}`) || shown.endsWith(`::${bare}`) || bare.endsWith(`--${shown}`) || bare.endsWith(`::${shown}`)) return true;
    }
  }
  return false;
}

/**
 * Why a write must not run here, in a batch: the screen it would write on is
 * not the one the agent saw when it sent the batch (a step's `expect` let the
 * batch go on through a new screen or a popup). SAP raises no message for
 * wrong but valid data (another customer, a zero price), so the stop rules
 * cannot catch it: the agent sees the screen first, then sends the write, or
 * says it knows that screen with "unseen": true on the step. Undefined when
 * the write may run.
 */
export function unseenWrite(step: BatchStep, start: ParsedScreen, now: ParsedScreen): string | undefined {
  if (step.unseen) return undefined;
  if (!moved(start, now) && popups(start).length === popups(now).length) return undefined;
  return `it may write, on a screen you have not seen in this batch (${where(now)}). Read the screen below, then send it, or mark the step "unseen": true when you know that screen`;
}

/**
 * Why a write must not run: SAP is not on the screen the agent was last shown
 * (another transaction, program or screen, or another number of popups). A
 * step that ended "nothing was sent" while SAP moved on, a timer, another
 * user of the session: the agent would write on a screen it decided nothing
 * about (live 2026-11-20, a stale Web GUI answer led a press into VD03).
 * Undefined when the write may run. The answer shows the screen, so sending
 * the same action again after reading it runs.
 */
export function staleWrite(seen: ParsedScreen, now: ParsedScreen): string | undefined {
  if (!moved(seen, now) && popups(seen).length === popups(now).length) return undefined;
  return `it may write, and SAP is not on the screen you last saw: it is now ${where(now)}. Read the screen below; send the action again only if it is still what you want here`;
}
