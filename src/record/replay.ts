/**
 * Runs a recorded test again, with no model, through the same driver and
 * the same guard as `sap_act`.
 *
 * For each step: fill in the variables, find the control (by its recorded
 * id, else by its field name if the screen moved it), ask the guard, run
 * the action, read the screen, then check it:
 *   - the status bar shows no error or abort message (unless the recording did);
 *   - the screen is the recorded one (program and screen number, transaction);
 *   - every check marked on the step holds;
 *   - every capture finds its value, which later steps use.
 * The first failing step stops the run; the steps after it are skipped. The
 * result carries the screen at the failure and the phase the step failed in.
 *
 * A run can resume at the failed step (`from`), on the screen as it is, with
 * a repair for that one step (repair.ts): the repair is carried out under
 * its rules, the step is judged by what the recording expected, and the
 * steps after it run as recorded. The result then holds what the repair did
 * and a proposed test. No model is called here.
 */
import { actionText, normalizeAction, type NormalizedAction } from "../core/action.js";
import { commandFieldRefusal, decide, leavesTransaction, type Policy, sessionRefusal, systemAllowed } from "../core/guard.js";
import type { Assessment, Driver } from "../core/types.js";
import { compact } from "../core/compact.js";
import { vkeyNumber } from "../sapgui/keys.js";
import { captureValue, evaluate } from "./checks.js";
import { actionWith, duration, fill, inputsOf, type SapTest, type Step } from "./format.js";
import { applyCapture, type Phase, type Proposal, propose, type Repair, type RepairRecord, RepairRefused, repairRefusal, runRepairActions } from "./repair.js";
import { type Control, locate, type ParsedScreen, readSettled } from "./screen.js";

export interface ReplayOptions {
  /** Values for the test's variables; the file's defaults fill the rest. */
  variables?: Record<string, string>;
  /** strict (default): another program or screen number after a step fails it. loose: it is a warning. */
  screens?: "strict" | "loose";
  /**
   * A screen SAP shows for some data only, that offers a choice the recording does not have (availability
   * control: complete delivery, delivery proposal, continue without confirming).
   * stop (default): the step fails there and names the ways on; nothing is pressed.
   * continue: the replay presses the screen's neutral Continue and says so in the result.
   */
  choices?: "stop" | "continue";
  /**
   * Resume at this step (from 1) on the screen as it is: no clean start, no popup closed. With the
   * variables the earlier run ended with. The result holds the steps from this one on.
   */
  from?: number;
  /** A repair for step `from` (see repair.ts). */
  repair?: Repair;
  /** After a failure, leave the transaction with /n (default true). Unsaved input is dropped. */
  leaveOnFailure?: boolean;
  /** Called after each step, for progress output. */
  onStep?: (r: StepResult) => void;
}

export interface StepResult {
  n: number;
  outcome: "pass" | "fail" | "skipped";
  /** The action as it ran, variables filled in. */
  action?: string;
  note?: string;
  ms: number;
  /** How long the action took from sending it to SAP's answer, as `ms` of a recorded step counts it. */
  actMs?: number;
  /** How long the action took when it was recorded. */
  recordedMs?: number;
  /** The action took much longer than recorded (over twice as long, and over a second more): said, never a failure. */
  slower?: string;
  /** Why it failed. */
  failures: string[];
  /** What differed without failing the step. */
  warnings: string[];
  /** Checks that held. */
  passed: string[];
  /** On a failure: where the step failed (see repair.ts). */
  phase?: Phase;
  /** What a repair did at this step. A step that passed with one is not the recorded step. */
  repair?: RepairRecord;
}

export interface ReplayResult {
  name: string;
  passed: boolean;
  /** Where it ran. */
  system: string;
  surface: string;
  steps: StepResult[];
  /** The variables at the end: inputs, defaults and what the steps captured. */
  variables: Record<string, string>;
  /** Before the first step: why the run could not start. */
  aborted?: string;
  /** What the replay did before the first step to start clean (popups it closed). */
  before?: string[];
  /** Variables the steps capture that this run did not reach: their value is the recorded one. */
  notCaptured?: string[];
  /** The screen at the failure, compact, as sap_look would show it. */
  screen?: string;
  /** The full view at the failure, for tools. */
  screenFull?: string;
  /** The step the run resumed at, when it did not start at step 1. */
  from?: number;
  /** After a repair that worked: the recording with the change written in. Nothing was saved. */
  proposal?: Proposal;
  ms: number;
}

const HOME = new Set(["SESSION_MANAGER", "SMEN", "S000"]);
/** "a popup", "an availability control screen". */
const a = (what: string) => `${/^[aeiou]/i.test(what) ? "an" : "a"} ${what}`;
const first = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
const where = (r: { transaction?: string | undefined; program?: string | undefined; screen?: string | undefined }) => `${r.transaction ?? "?"} ${r.program ?? "?"}/${r.screen ?? "?"}`;

/** The screen a step led to: read once the step is over (see readSettled). */
async function read(driver: Driver): Promise<ParsedScreen> {
  return readSettled(() => driver.look({ compact: false }));
}

/** The run cannot start, for a reason said as it is. */
class Abort extends Error {}

/** The guard said no. Not drift: a repair is never asked for. */
export class GuardRefusal extends Error {
  override name = "GuardRefusal";
}

/** Runs one action the way sap_act does: the same guard, then the driver. Returns the driver's note, or throws with the refusal. */
async function guarded(driver: Driver, policy: Policy, action: NormalizedAction, rated?: Assessment): Promise<string> {
  const field = commandFieldRefusal(action);
  if (field) throw new GuardRefusal(`refused: ${field}`);
  const info = await driver.refresh();
  if (!systemAllowed(policy, info)) throw new GuardRefusal(`refused: system ${info.system ?? "(unknown)"} is outside SAP_ALLOW_SYSTEMS`);
  const here = sessionRefusal(policy, info);
  if (here && !leavesTransaction(policy, action)) throw new GuardRefusal(`refused: ${here}`);
  // `rated`: a repair's own, stricter rating of the action (a confirmation that completes a write is that write).
  const verdict = decide(policy, action, rated ?? (await driver.assess(action)));
  if (!verdict.run)
    throw new GuardRefusal("refused" in verdict ? `refused: ${verdict.refused}` : `refused: this step may write to SAP (${verdict.confirm}). A replay cannot ask for each step: run it with SAP_WRITE=on, on a system where the test may write.`);
  return driver.act(action);
}

/** What the screen after a step must satisfy, beyond the marked checks. */
function implicit(step: Step, screen: ParsedScreen, strict: boolean, r: StepResult, vars: Record<string, string> = {}): void {
  const was = step.after;
  const type = screen.status?.type;
  // An error is a failure unless the recording ended this step on the same error.
  if ((type === "E" || type === "A") && !(was?.status?.type === type && sameText(was.status.text, screen.status?.text ?? "", vars)))
    r.failures.push(`SAP reported an error in the status bar: ${screen.status?.text ?? ""}`);
  if (!was) return;
  const moved = (["transaction", "program", "screen"] as const).filter((k) => was[k] && screen[k] && was[k] !== screen[k]);
  if (moved.length) (strict ? r.failures : r.warnings).push(`landed on another screen: ${where(screen)}${screen.title ? ` "${screen.title}"` : ""}, recorded ${where(was)}`);
}

/** Does a recorded text, its variables filled in, say what SAP says now? */
function sameText(recorded: string, now: string, vars: Record<string, string>): boolean {
  try {
    return fill(recorded, vars) === now;
  } catch {
    return false;
  }
}

/**
 * A window SAP showed that the recording does not have at this point, and
 * what the replay does about it:
 *   pass    an Information popup (text and a Continue button, no question, no
 *           input, no choice): confirmed, and noted;
 *   choice  a known screen that offers several ways on (availability control).
 *           Which one is taken decides what is saved, so the replay stops
 *           unless the run asked for the neutral way (`choices: "continue"`);
 *   stop    anything else: a question, input. The replay does not answer
 *           what it was not shown how to answer.
 */
export interface Detour {
  kind: "pass" | "choice" | "stop";
  /** What it is, for the report: `popup "Information" (Consider the subsequent documents)`. */
  what: string;
  /** The answer, for a pass. */
  action?: NormalizedAction;
  /** How the answer is said in the report: "pressed Continue". */
  answer?: string;
  /** For a choice: every way on the screen offers, as its buttons name them. */
  ways?: string[];
}

/**
 * Screens of the main window that SAP shows for some data only, with their
 * neutral way on. Availability control (VA01, VA02: the quantity is not
 * available on the date asked) has no Back: its ways on are its own buttons
 * (complete delivery, delivery proposal, continue). "Continue" takes the
 * order on with what the check confirmed, which can be nothing: the order
 * is then saved unconfirmed, a result the recording did not have. So this
 * is a choice, not a detail (see Detour).
 */
const OPTIONAL_SCREENS: { what: string; is: (s: ParsedScreen) => boolean; button: RegExp }[] = [
  {
    what: "availability control",
    is: (s) => s.program === "SAPLATP4" || /availability control|verf(ü|ue)gbarkeitskontrolle/i.test(s.title ?? ""),
    button: /^(continue|weiter)\b/i,
  },
];

const topWindowOf = (s: ParsedScreen) => s.windows.filter((w) => /^wnd\[\d+\]$/.test(w.id)).at(-1);
const popupOf = (s: ParsedScreen) => {
  const w = topWindowOf(s);
  return w && w.id !== "wnd[0]" ? w : undefined;
};
/** The action that presses a button: by its id, or on the DIAG method a function key or toolbar button by its key. */
const pressOf = (c: Control): NormalizedAction => (c.vkey !== undefined && !c.id.startsWith("wnd[") ? normalizeAction({ do: "key", key: c.vkey }) : normalizeAction({ do: "press", id: c.id }));
/** A popup's Continue: SAP GUI's green tick (wnd[1]/tbar[0]/btn[0]), on the DIAG method the popup's Enter key. */
const continueOf = (mine: Control[], window: string) => mine.find((c) => c.id === `${window}/tbar[0]/btn[0]`) ?? mine.find((c) => c.zone === "bar" && c.vkey === 0);
const editable = (c: Control) => (c.type === "field" || c.type === "dropdown" || c.type === "textedit") && !/\(read-only\)|\(display\)/.test(c.rest);

/** What to do about the window in front, when it is one the replay may meet without a recording of it. */
export function detour(screen: ParsedScreen): Detour | undefined {
  const pop = popupOf(screen);
  if (pop) {
    const mine = screen.controls.filter((c) => c.window === pop.id);
    const words = mine
      .filter((c) => c.type === "label" || (c.type === "field" && !editable(c)))
      .map((c) => (c.type === "field" ? c.value : c.label || c.rest))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ");
    const what = `popup "${pop.title}"${words ? ` (${words.slice(0, 200)})` : ""}`;
    const go = continueOf(mine, pop.id);
    const question =
      mine.some((c) => c.type === "button" && (c.id.includes("/usr/") || c.zone === "area")) ||
      mine.some(editable) ||
      mine.some((c) => /^(table|grid|list|tree|checkbox|radio|dropdown|textedit|html-viewer)$/.test(c.type)) ||
      /\?\s*$/.test(words) ||
      /\?/.test(pop.title);
    if (!go || question) return { kind: "stop", what };
    return { kind: "pass", what, action: pressOf(go), answer: `pressed ${go.label || "Continue"}` };
  }
  for (const o of OPTIONAL_SCREENS) {
    if (!o.is(screen)) continue;
    const go = screen.controls.find((c) => c.type === "button" && c.window === "wnd[0]" && o.button.test(c.label));
    const what = `${o.what} screen "${screen.title ?? ""}"`;
    if (!go) return { kind: "stop", what: `${what} (no Continue button the replay could press)` };
    const ways = screen.controls.filter((c) => c.type === "button" && (/^wnd\[0\]\/tbar\[1\]\//.test(c.id) || (c.window === "wnd[0]" && c.zone === "bar" && c.rest.endsWith("(toolbar)")))).map((c) => c.label);
    return { kind: "choice", what, action: pressOf(go), answer: `pressed ${go.label}`, ways };
  }
  return undefined;
}

/** Is the screen where the step was recorded to lead? Only what the recording holds is compared. */
function asRecorded(step: Step, screen: ParsedScreen, vars: Record<string, string>): boolean {
  const was = step.after;
  if (!was) return true;
  const moved = (["transaction", "program", "screen"] as const).some((k) => was[k] && screen[k] && was[k] !== screen[k]);
  if (moved) return false;
  return !was.title || !screen.title || sameText(was.title, screen.title, vars);
}

/**
 * The popup a recorded step confirms, if that is what it does: by its
 * Continue button (wnd[1]/tbar[0]/btn[0]). On the DIAG method, whose ids do
 * not name the window, only a popup the recorder saw as a plain message
 * (`step.on.message`: text and a Continue, no question) confirmed by Enter
 * or a press, in a step not rated a write. The answer to a question (Yes,
 * Save, any button of a popup that asks) is never one: a replay that skips
 * it would pass without the write.
 */
function confirming(step: Step, diag = false): string | undefined {
  const a = step.action;
  if (a?.do === "press") {
    const m = /^(wnd\[[1-9]\])\/tbar\[0\]\/btn\[0\]$/.exec(step.target?.id ?? String(a.id ?? ""));
    if (m) return m[1];
  }
  const popup = step.on?.popup;
  if (!diag || !popup || !a || !step.on?.message || step.risk === "commit") return undefined;
  if (a.do === "press" || (a.do === "key" && vkeyNumber(a.key ?? a.value) === 0)) return popup;
  return undefined;
}

/** How long a step waits, at most, for a screen that came whole after one marked damaged (DIAG method). */
const DAMAGED_MS = 5000;

/**
 * The screen a step is judged on, when the DIAG method marked it damaged
 * (bytes lost on the connection): read again until an undamaged one comes,
 * within the step's own timeout (seconds) or DAMAGED_MS. Still damaged then:
 * undefined, and the step fails for that reason, not on a check.
 */
async function undamaged(driver: Driver, screen: ParsedScreen, timeout: unknown): Promise<ParsedScreen | undefined> {
  if (!screen.damaged) return screen;
  const t = Number(timeout);
  const until = Date.now() + (Number.isFinite(t) && t > 0 ? t * 1000 : DAMAGED_MS);
  let now = screen;
  while (now.damaged && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    now = await read(driver);
  }
  return now.damaged ? undefined : now;
}

const DAMAGED_TEXT =
  "screen damaged in transit: bytes were lost on the connection while SAP sent it, and no whole screen came after it, so the step was not judged. Look at the screen (sap_look), then run the replay again from this step";

/** At most this many unrecorded windows are answered after one step (VA02 shows two Information popups in a row). */
const MAX_DETOURS = 5;

export async function replay(driver: Driver, policy: Policy, recorded: SapTest, options: ReplayOptions = {}): Promise<ReplayResult> {
  const t0 = Date.now();
  // The replay's own copy: a capture added by a repair changes the steps after it.
  const test = structuredClone(recorded);
  const resumed = options.from !== undefined || options.repair !== undefined;
  const from = options.from ?? 1;
  // Only the test's own variables: an unknown name is refused below, not shown as a value.
  const given = Object.fromEntries(Object.entries(options.variables ?? {}).filter(([k]) => k in test.variables));
  const vars: Record<string, string> = { ...Object.fromEntries(Object.entries(test.variables).map(([k, v]) => [k, v.value])), ...given };
  const captures = new Set(test.steps.flatMap((s) => (s.capture ?? []).map((c) => c.var)));
  const captured_ = new Set<string>();
  const info = await driver.refresh();
  const result: ReplayResult = { name: test.name, passed: false, system: `${info.system ?? "?"}${info.client ? `/${info.client}` : ""}`, surface: info.surface, steps: [], variables: vars, ms: 0 };
  const strict = (options.screens ?? "strict") === "strict";
  const finish = (aborted?: string): ReplayResult => {
    if (aborted) result.aborted = aborted;
    const missed = [...captures].filter((v) => !captured_.has(v) && !(v in given));
    if (missed.length) result.notCaptured = missed;
    result.passed = !aborted && result.steps.length === test.steps.length - (from - 1) && result.steps.every((s) => s.outcome === "pass");
    result.ms = Date.now() - t0;
    return result;
  };
  const unknown = Object.keys(options.variables ?? {}).filter((k) => !(k in test.variables));
  if (unknown.length) return finish(`the test has no variable ${unknown.map((k) => `\${${k}}`).join(", ")} (it has: ${Object.keys(test.variables).join(", ") || "none"})`);
  const missing = inputsOf(test).filter((k) => vars[k] === undefined);
  if (missing.length) return finish(`no value for ${missing.map((k) => `\${${k}}`).join(", ")}`);
  if (!test.steps.length) return finish("the recording has no steps");
  if (options.repair && options.from === undefined) return finish('a repair needs "from", the step it is for');
  if (!Number.isInteger(from) || from < 1 || from > test.steps.length) return finish(`"from" is a step of the test, 1 to ${test.steps.length} (got ${from})`);
  if (resumed) result.from = from;
  if (info.surface !== test.recorded.surface) return finish(`the test was recorded on ${test.recorded.surface}; this session is ${info.surface}. Ids differ between Fiori and SAP GUI screens.`);
  // SAP GUI read by scripting and by the DIAG method name controls differently (wnd[0]/usr/ctxtVBAK-VBELN, VBAK-VBELN).
  const method = (m: string | undefined) => (m === "diag" ? "the DIAG method (SAP_GUI_METHOD=diag)" : "SAP GUI scripting");
  const diag = test.recorded.method === "diag";
  if (info.surface === "sapgui" && method(info.method) !== method(test.recorded.method))
    return finish(`the test was recorded through ${method(test.recorded.method)}; this session is read through ${method(info.method)}. The two name controls differently: replay it with the method it was recorded with`);

  /** A clean start: popups left open are closed, and the recording's first transaction is opened fresh. */
  const cleanStart = async (at: ParsedScreen): Promise<ParsedScreen> => {
    let screen = at;
    // A popup left open blocks the command field: an Information popup is confirmed, any other is cancelled
    // (Cancel never saves; the /n that follows drops unsaved input, as every replay start does).
    for (let i = 0; i < MAX_DETOURS && popupOf(screen) && info.surface !== "fiori"; i++) {
      const d = detour(screen);
      const pass = d?.kind === "pass" && d.action;
      await guarded(driver, policy, pass ? (d.action as NormalizedAction) : normalizeAction({ do: "key", key: 12 }));
      (result.before ??= []).push(`${d?.what ?? "a popup"} was open: ${pass ? d.answer : "cancelled it (key 12)"}`);
      screen = await read(driver);
    }
    const left = popupOf(screen);
    if (left) throw new Abort(`a popup is open and the replay could not close it: "${left.title}". Answer it, then run the replay again`);
    // A clean start: the recording's first transaction, opened fresh.
    const opens = test.steps[0]?.action;
    const startsClean = opens?.do === "okcode" && /^\/n\S/i.test(String(opens.value ?? ""));
    const t = test.start.transaction;
    if (!startsClean && t && !HOME.has(t.toUpperCase()) && info.surface !== "fiori") {
      await guarded(driver, policy, normalizeAction({ do: "okcode", value: `/n${t}` }));
      screen = await read(driver);
      if (strict && test.start.program && screen.program && (screen.program !== test.start.program || screen.screen !== test.start.screen))
        throw new Abort(`/n${t} opened ${where(screen)}, but the recording started on ${where(test.start)}: record the test from /n${t} on`);
    }
    return screen;
  };

  let screen: ParsedScreen;
  try {
    screen = await read(driver);
    if (screen.logon) return finish("the session is on the logon screen: log on first");
    // A resumed run goes on from the screen as it is: what is open there is the step's business.
    if (!resumed) screen = await cleanStart(screen);
  } catch (e) {
    return finish(e instanceof Abort ? e.message : `could not start: ${first(e)}`);
  }
  let failed = false;
  for (const [i, step] of test.steps.entries()) {
    if (i < from - 1) continue;
    const r: StepResult = { n: i + 1, outcome: "pass", ms: 0, failures: [], warnings: [], passed: [], ...(step.note ? { note: step.note } : {}) };
    result.steps.push(r);
    if (failed) {
      r.outcome = "skipped";
      if (step.action) r.action = actionText(step.action as NormalizedAction);
      continue;
    }
    const s0 = Date.now();
    // The repair, when this is the step the run resumed at with one.
    const repair = i === from - 1 ? options.repair : undefined;
    let phase: Phase = "act";
    let added: Step[] = [];
    let captured: { now: string; recorded: string } | undefined;
    try {
      // Does the recorded action run? Not when a repair stands in for it, or it ran before the run resumed.
      let runs = true;
      if (repair) {
        r.repair = { why: repair.why, outcome: "refused", did: [], ...(repair.place ? { place: repair.place } : {}) };
        const no = repairRefusal(step, repair, test);
        if (no) throw new RepairRefused(no);
        // A screen whose ways on decide what is saved is the person's to answer, as in a replay without a repair.
        const open = detour(screen);
        if (open?.kind === "choice" && options.choices !== "continue")
          throw new RepairRefused(`SAP shows ${a(open.what)} that offers a choice (${(open.ways ?? []).join("; ")}): which one is taken decides what is saved, so a repair does not take it. Record the test on data that shows this screen`);
        if (repair.actions?.length) {
          const run = await runRepairActions(driver, test, step, repair, vars, screen, (a, rated) => guarded(driver, policy, a, rated), () => read(driver), test.steps[i - 1]).catch((e) => {
            // An action SAP did not take: the repair was tried and did not work.
            if (!(e instanceof RepairRefused) && !(e instanceof GuardRefusal) && r.repair) r.repair.outcome = "failed";
            throw e;
          });
          screen = run.screen;
          added = run.steps;
          r.repair.did = run.did;
        }
        r.repair.outcome = "failed";
        runs = repair.place === "before";
      }
      if (step.action) {
        let action = actionWith(step.action, vars);
        // The screen may have moved the control: find it by its field name before giving up on the id.
        if (runs && action.id && step.target) {
          const found = locate(screen, step.target.id) ?? locate(screen, action.id);
          if (found && found.by !== "exact") {
            r.warnings.push(`${step.target.id} was found as ${found.control.id} (same field name)`);
            action = normalizeAction({ ...action, id: found.control.id });
          }
        }
        r.action = actionText(action);
        // The recording confirmed an Information popup here that SAP did not show this time: nothing to answer.
        const confirms = confirming(step, diag);
        // On the DIAG method a popup is named by its place only (wnd[1]): the one on show must be the one recorded.
        const recordedPopup = diag ? step.on?.popup : undefined;
        const shown = recordedPopup ? screen.windows.find((w) => w.id === recordedPopup) : undefined;
        const other = !!shown && !!step.on?.title && !!shown.title && !sameText(step.on.title, shown.title, vars);
        if (runs && confirms && !screen.windows.some((w) => w.id === confirms)) {
          // Its action is not sent; the screen is judged and its checks run as for any step (where the Continue would have led).
          r.warnings.push(`the recording confirmed a popup here ("${step.on?.title ?? ""}") that SAP did not show this time: its answer was not sent`);
          runs = false;
        } else if (runs && recordedPopup && (!shown || other)) {
          // A question's answer (or a popup not known to be a plain message) is never skipped, nor given to another popup.
          r.failures.push(
            other
              ? `the recording answered the popup "${step.on?.title ?? ""}" here, and SAP shows the popup "${shown?.title ?? ""}" instead: nothing was pressed`
              : `the recording answered the popup "${step.on?.title ?? ""}" here (${actionText(action)}), and SAP did not show it this time. An answer to a question is never skipped, so the step fails: look at what changed in the steps before it`,
          );
          throw undefined;
        }
        if (runs) {
          const a0 = Date.now();
          await guarded(driver, policy, action);
          r.actMs = Date.now() - a0;
          screen = await read(driver);
        }
        phase = "landing";
        // A screen with bytes lost on the way is not judged: the next whole one is waited for.
        const whole = await undamaged(driver, screen, action.timeout);
        if (!whole) {
          r.failures.push(DAMAGED_TEXT);
          throw undefined;
        }
        screen = whole;
        // Windows SAP showed that the recording does not have here: passed when they only inform, else the step fails.
        for (let k = 0; k < MAX_DETOURS && !asRecorded(step, screen, vars); k++) {
          const d = detour(screen);
          if (!d) break;
          if (d.kind === "stop" || !d.action) {
            r.failures.push(`SAP showed ${a(d.what)} that the recording does not have here. The replay answers only popups that inform (a Continue button, no question): record the test on data that shows this window, or answer it and run the steps after it by hand`);
            break;
          }
          if (d.kind === "choice" && options.choices !== "continue") {
            r.failures.push(
              `SAP showed ${a(d.what)} that the recording does not have here. It offers a choice (${(d.ways ?? []).join("; ")}), and which one is taken decides what is saved, so the replay pressed nothing. Record the test on data that shows this screen, or run the replay with "choices":"continue" to go on with ${d.answer?.replace(/^pressed /, "") ?? "Continue"} (the result then says so)`,
            );
            break;
          }
          await guarded(driver, policy, d.action);
          r.warnings.push(`SAP showed ${a(d.what)} that the recording does not have: the replay ${d.answer}${d.kind === "choice" ? ', as "choices":"continue" asked; what was saved may differ from the recording' : ""}`);
          screen = await read(driver);
          const after = await undamaged(driver, screen, action.timeout);
          if (!after) {
            r.failures.push(DAMAGED_TEXT);
            throw undefined;
          }
          screen = after;
        }
        const landed = sessionRefusal(policy, await driver.refresh());
        if (landed) r.failures.push(`this led to a transaction the replay may not work in: ${landed}`);
        // The recording had popups here that the next steps confirm, and SAP showed none this time:
        // the step is judged by where those steps led.
        let judged = step;
        if (!asRecorded(step, screen, vars) && !popupOf(screen)) {
          let j = i + 1;
          while (test.steps[j] && confirming(test.steps[j] as Step, diag)) j++;
          const last = test.steps[j - 1];
          if (j > i + 1 && last && asRecorded(last, screen, vars)) judged = { ...step, ...(last.after ? { after: last.after } : {}) };
        }
        if (!r.failures.length) implicit(judged, screen, strict, r, vars);
      } else if (!repair) {
        screen = await read(driver);
        const whole = await undamaged(driver, screen, undefined);
        if (!whole) {
          r.failures.push(DAMAGED_TEXT);
          throw undefined;
        }
        screen = whole;
      }
      // On the wrong screen or after an error, the marked checks would only repeat the failure.
      if (r.failures.length) throw undefined;
      phase = "check";
      // A capture a repair adds: the step and the steps after it now hold the variable where they held the recorded number.
      if (repair?.capture) {
        captured = applyCapture(test, i, repair, screen, vars);
        if (r.repair) r.repair.captured = `\${${repair.capture.var}} = "${captured.now}" (recorded "${captured.recorded}")`;
      }
      // Captures first: a check on the same step may use what was captured.
      for (const c of step.capture ?? []) {
        const got = captureValue(screen, c);
        if ("error" in got) r.failures.push(got.error);
        else {
          vars[c.var] = got.value;
          captured_.add(c.var);
          r.passed.push(`\${${c.var}} = "${got.value}"`);
        }
      }
      for (const c of step.expect ?? []) {
        const v = evaluate(screen, c, vars);
        (v.ok ? r.passed : r.failures).push(v.text);
        if (v.ok && v.relocated) r.warnings.push(`${c.id} was found as ${v.relocated}`);
      }
    } catch (e) {
      if (e instanceof GuardRefusal && !r.repair) phase = "refused";
      if (e instanceof RepairRefused) {
        if (r.repair) r.repair.outcome = "refused";
        r.failures.push(`the repair was refused: ${e.message}`);
      }
      else if (e !== undefined) r.failures.push(first(e));
    }
    r.ms = Date.now() - s0;
    if (step.ms !== undefined) r.recordedMs = step.ms;
    const slower = slowerNote(r.actMs, step.ms);
    if (slower) r.slower = slower;
    if (r.repair) {
      if (r.failures.length) {
        if (r.repair.outcome !== "refused") r.repair.outcome = "failed";
        r.repair.problem = r.failures[0] ?? "";
      } else {
        r.repair.outcome = "repaired";
        result.proposal = propose(recorded, test, i, repair as Repair, added, captured);
      }
    }
    if (r.failures.length) {
      r.outcome = "fail";
      r.phase = phase;
      failed = true;
      const full = await driver.look({ compact: false }).catch(() => undefined);
      if (full) {
        result.screenFull = full;
        result.screen = compact(full);
      }
    }
    options.onStep?.(r);
  }
  if (failed && (options.leaveOnFailure ?? true) && info.surface !== "fiori")
    await guarded(driver, policy, normalizeAction({ do: "okcode", value: "/n" })).catch(() => {});
  return finish();
}

/** Runs several tests in order on one session; what one captures, the next can use. Stops at the first that fails. */
export async function replayAll(driver: Driver, policy: Policy, tests: SapTest[], options: ReplayOptions = {}): Promise<ReplayResult[]> {
  const out: ReplayResult[] = [];
  let carried: Record<string, string> = { ...(options.variables ?? {}) };
  for (const t of tests) {
    const mine = Object.fromEntries(Object.entries(carried).filter(([k]) => k in t.variables));
    const r = await replay(driver, policy, t, { ...options, variables: mine });
    out.push(r);
    if (!r.passed) break;
    carried = { ...carried, ...r.variables };
  }
  return out;
}

/** Over twice as long as recorded and over a second more: worth saying, not failing. */
const SLOWER_FACTOR = 2;
const SLOWER_MS = 1000;

/** The note for an action that took much longer than when it was recorded, if it did. */
export function slowerNote(actMs: number | undefined, recordedMs: number | undefined): string | undefined {
  if (actMs === undefined || recordedMs === undefined) return undefined;
  if (actMs <= recordedMs * SLOWER_FACTOR || actMs - recordedMs <= SLOWER_MS) return undefined;
  return `the action took ${duration(actMs)}, ${(actMs / Math.max(recordedMs, 1)).toFixed(1)}x the ${duration(recordedMs)} recorded`;
}

export function resultText(r: ReplayResult): string {
  // What the replay did that the recording does not have (a popup it confirmed, a control it found elsewhere)
  // is said in the first line too: a PASS with notes is not the recorded run.
  const noted = r.steps.filter((s) => s.warnings.length).map((s) => s.n);
  const notes = noted.length + (r.before?.length ? 1 : 0);
  const repaired = r.steps.filter((s) => s.repair?.outcome === "repaired").map((s) => s.n);
  const lines = [
    `${r.passed ? "PASS" : "FAIL"}  ${r.name}  on ${r.surface} ${r.system}  (${r.steps.filter((s) => s.outcome === "pass").length}/${r.steps.length} steps, ${(r.ms / 1000).toFixed(1)} s)${
      r.passed && repaired.length ? `  REPAIRED at step ${repaired.join(", ")}: this run is not the recorded one (see "repaired:" and the proposed change below)` : ""
    }${
      r.passed && notes ? `  WITH NOTES: this run differed from the recording${noted.length ? ` at step${noted.length > 1 ? "s" : ""} ${noted.join(", ")}` : " before step 1"} (see "note:" below)` : ""
    }`,
  ];
  if (r.aborted) lines.push(`Not run: ${r.aborted}.`);
  if (r.from !== undefined) lines.push(`Resumed at step ${r.from}, on the screen as it was.`);
  for (const b of r.before ?? []) lines.push(`Before step 1: ${b}.`);
  for (const s of r.steps) {
    const took = s.outcome === "skipped" ? "" : `  (${duration(s.ms)}${s.recordedMs !== undefined ? `; recorded ${duration(s.recordedMs)}` : ""})`;
    lines.push(`${s.outcome === "pass" ? "ok  " : s.outcome === "fail" ? "FAIL" : "skip"} ${s.n}. ${s.action ?? "(check only)"}${s.note ? `  — ${s.note}` : ""}${took}`);
    if (s.slower) lines.push(`       slower: ${s.slower}`);
    for (const f of s.failures) lines.push(`       failed${s.phase ? ` (${s.phase})` : ""}: ${f}`);
    if (s.repair) lines.push(`       ${s.repair.outcome === "repaired" ? "repaired" : `repair ${s.repair.outcome}`}: ${s.repair.why}${s.repair.did.length ? `  did: ${s.repair.did.join(", ")}${s.repair.place ? ` (${s.repair.place})` : ""}` : ""}${s.repair.captured ? `  ${s.repair.captured}` : ""}`);
    for (const w of s.warnings) lines.push(`       note: ${w}`);
    for (const p of s.passed) lines.push(`       ok: ${p}`);
  }
  const missed = new Set(r.notCaptured ?? []);
  const vars = Object.entries(r.variables);
  if (vars.length) lines.push(`Variables: ${vars.map(([k, v]) => (missed.has(k) ? `\${${k}} not captured in this run (recorded "${v}")` : `\${${k}} = "${v}"`)).join(", ")}`);
  if (r.proposal) lines.push("", "Proposed change to the test (nothing was saved):", ...r.proposal.changes.map((c) => `  ${c}`));
  if (r.screen) lines.push("", "Screen at the failure:", r.screen);
  return lines.join("\n");
}

export const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** JUnit XML, the format CI servers read: one suite per test, one case per step. */
export function junit(results: ReplayResult[]): string {
  const suites = results.map((r) => {
    const cases = r.steps.map((s) => {
      const head = `    <testcase name="${xml(`${s.n}. ${s.action ?? "check"}`)}" classname="${xml(r.name)}" time="${(s.ms / 1000).toFixed(3)}"`;
      if (s.outcome === "skipped") return `${head}><skipped/></testcase>`;
      // The recorded time, and a step much slower than recorded: said in the case's output.
      const said = [s.recordedMs !== undefined ? `recorded ${(s.recordedMs / 1000).toFixed(3)} s` : "", s.slower ? `slower: ${s.slower}` : ""].filter(Boolean).join("\n");
      const out = said ? `<system-out>${xml(said)}</system-out>` : "";
      if (s.outcome === "fail") return `${head}><failure message="${xml(s.failures[0] ?? "failed")}">${xml([...s.failures, "", r.screen ?? ""].join("\n"))}</failure>${out}</testcase>`;
      return out ? `${head}>${out}</testcase>` : `${head}/>`;
    });
    if (r.aborted) cases.unshift(`    <testcase name="start" classname="${xml(r.name)}"><error message="${xml(r.aborted)}"/></testcase>`);
    const fails = r.steps.filter((s) => s.outcome === "fail").length;
    return `  <testsuite name="${xml(r.name)}" tests="${cases.length}" failures="${fails}" errors="${r.aborted ? 1 : 0}" skipped="${r.steps.filter((s) => s.outcome === "skipped").length}" time="${(r.ms / 1000).toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join("\n")}\n</testsuites>\n`;
}
