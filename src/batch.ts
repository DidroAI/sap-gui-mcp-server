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
 * - the screen is another one (transaction, program or screen number);
 * - the step's `expect` is not met;
 * - SAP is still working on the step.
 *
 * A step says what it knows will happen with `expect`, and the batch goes on
 * through it: `{"screen":"4001"}` (also `transaction`, `title`),
 * `{"popup":true}`, `{"status":"W"}`. The server ends the batch too when an
 * action fails, is refused or waits for the user's yes (server.ts): each
 * action of a batch has its own guard decision, as if it were sent alone.
 *
 * This file is the part without a session: reading the batch, and the rules.
 */
import { type NormalizedAction, normalizeAction } from "./core/action.js";
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
  action: NormalizedAction;
  expect?: Expect;
  /** The answer shows the screen after this step too, not only the last one. */
  show: boolean;
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
 * The steps of a batch, each action normalised as `sap_act` normalises one.
 * Any step that is not a valid action refuses the whole batch: nothing runs.
 */
export function parseBatch(input: unknown): BatchStep[] {
  if (!Array.isArray(input) || input.length === 0) throw new ActionError('"actions" is a list of actions, e.g. [{"do":"set","id":"ctxtVBAK-AUART","value":"OR"},{"do":"key","key":0}].');
  if (input.length > MAX_BATCH) throw new ActionError(`"actions" takes ${MAX_BATCH} actions at most (got ${input.length}): send the actions of one screen, then go on from the answer.`);
  return input.map((raw, i) => {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { action: normalizeAction(raw), show: false };
      const { expect, show, ...rest } = raw as Record<string, unknown>;
      if (show !== undefined && show !== null && typeof show !== "boolean") throw new ActionError('"show" is true or false.');
      const e = parseExpect(expect);
      return { action: normalizeAction(rest), ...(e ? { expect: e } : {}), show: show === true };
    } catch (e) {
      if (e instanceof ActionError) throw new ActionError(`Action ${i + 1} of ${input.length}: ${e.message}\nNothing ran.`);
      throw e;
    }
  });
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
  if (expect.screen !== undefined && number(expect.screen) !== number(after.screen)) unmet.push(`screen ${expect.screen} (it is ${after.screen ?? "unknown"})`);
  if (expect.transaction !== undefined && !same(expect.transaction, after.transaction)) unmet.push(`transaction ${expect.transaction} (it is ${after.transaction ?? "unknown"})`);
  if (expect.title !== undefined && !(after.title ?? "").toLowerCase().includes(expect.title.toLowerCase())) unmet.push(`a title with "${expect.title}" (it is "${after.title ?? ""}")`);
  if (expect.status !== undefined && !statusMet(after, expect.status)) unmet.push(`status ${expect.status} (${st ? `it is ${st.type ? `${st.type}: ` : ""}${st.text}` : "the status bar is empty"})`);
  if (expect.popup === true && !opened) unmet.push("a popup (none opened)");
  if (expect.popup === false && top) unmet.push(`no popup ("${top.title}" is open)`);
  return unmet.length ? { why: "expect", text: `expected ${unmet.join(", ")}` } : undefined;
}
