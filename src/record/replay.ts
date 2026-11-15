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
 * result carries the screen at the failure.
 */
import { actionText, normalizeAction, type NormalizedAction } from "../core/action.js";
import { commandFieldRefusal, decide, leavesTransaction, type Policy, sessionRefusal, systemAllowed } from "../core/guard.js";
import type { Driver } from "../core/types.js";
import { compact } from "../core/compact.js";
import { captureValue, evaluate } from "./checks.js";
import { actionWith, fill, inputsOf, type SapTest, type Step } from "./format.js";
import { type Control, locate, type ParsedScreen, parseScreen } from "./screen.js";

export interface ReplayOptions {
  /** Values for the test's variables; the file's defaults fill the rest. */
  variables?: Record<string, string>;
  /** strict (default): another program or screen number after a step fails it. loose: it is a warning. */
  screens?: "strict" | "loose";
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
  /** Why it failed. */
  failures: string[];
  /** What differed without failing the step. */
  warnings: string[];
  /** Checks that held. */
  passed: string[];
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
  ms: number;
}

const HOME = new Set(["SESSION_MANAGER", "SMEN", "S000"]);
const first = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
const where = (r: { transaction?: string | undefined; program?: string | undefined; screen?: string | undefined }) => `${r.transaction ?? "?"} ${r.program ?? "?"}/${r.screen ?? "?"}`;

async function read(driver: Driver): Promise<ParsedScreen> {
  return parseScreen(await driver.look({ compact: false }));
}

/** Runs one action the way sap_act does: the same guard, then the driver. Returns the driver's note, or throws with the refusal. */
async function guarded(driver: Driver, policy: Policy, action: NormalizedAction): Promise<string> {
  const field = commandFieldRefusal(action);
  if (field) throw new Error(`refused: ${field}`);
  const info = await driver.refresh();
  if (!systemAllowed(policy, info)) throw new Error(`refused: system ${info.system ?? "(unknown)"} is outside SAP_ALLOW_SYSTEMS`);
  const here = sessionRefusal(policy, info);
  if (here && !leavesTransaction(policy, action)) throw new Error(`refused: ${here}`);
  const verdict = decide(policy, action, await driver.assess(action));
  if (!verdict.run)
    throw new Error("refused" in verdict ? `refused: ${verdict.refused}` : `refused: this step may write to SAP (${verdict.confirm}). A replay cannot ask for each step: run it with SAP_WRITE=on, on a system where the test may write.`);
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
 *   pass  an Information popup (text and a Continue button, no question, no
 *         input, no choice) or a known optional screen: answered as noted;
 *   stop  anything else: a question, a choice, input. The replay does not
 *         answer what it was not shown how to answer.
 */
export interface Detour {
  kind: "pass" | "stop";
  /** What it is, for the report: `popup "Information" (Consider the subsequent documents)`. */
  what: string;
  /** The answer, for a pass. */
  action?: NormalizedAction;
  /** How the answer is said in the report: "pressed Continue". */
  answer?: string;
}

/**
 * Screens of the main window that SAP shows for some data only and that
 * have a neutral way on, with that way. Availability control (VA01, VA02:
 * the quantity is not available on the date asked) shows what can be
 * confirmed; "Continue" takes the order on with what the check confirmed,
 * as a user who only wants to go on does.
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
    const go = mine.find((c) => c.id === `${pop.id}/tbar[0]/btn[0]`);
    const question =
      mine.some((c) => c.type === "button" && c.id.includes("/usr/")) ||
      mine.some(editable) ||
      mine.some((c) => /^(table|grid|list|tree|checkbox|radio|dropdown|textedit|html-viewer)$/.test(c.type)) ||
      /\?\s*$/.test(words) ||
      /\?/.test(pop.title);
    if (!go || question) return { kind: "stop", what };
    return { kind: "pass", what, action: normalizeAction({ do: "press", id: go.id }), answer: `pressed ${go.label || "Continue"}` };
  }
  for (const o of OPTIONAL_SCREENS) {
    if (!o.is(screen)) continue;
    const go = screen.controls.find((c) => c.type === "button" && c.window === "wnd[0]" && o.button.test(c.label));
    const what = `${o.what} screen "${screen.title ?? ""}"`;
    if (!go) return { kind: "stop", what: `${what} (no Continue button the replay could press)` };
    return { kind: "pass", what, action: normalizeAction({ do: "press", id: go.id }), answer: `pressed ${go.label}` };
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

/** The popup a recorded step confirms with its Continue button (wnd[1]/tbar[0]/btn[0]), if that is what it does. */
function confirming(step: Step): string | undefined {
  if (step.action?.do !== "press") return undefined;
  const m = /^(wnd\[[1-9]\])\/tbar\[0\]\/btn\[0\]$/.exec(step.target?.id ?? String(step.action.id ?? ""));
  return m?.[1];
}

/** At most this many unrecorded windows are answered after one step (VA02 shows two Information popups in a row). */
const MAX_DETOURS = 5;

export async function replay(driver: Driver, policy: Policy, test: SapTest, options: ReplayOptions = {}): Promise<ReplayResult> {
  const t0 = Date.now();
  // Only the test's own variables: an unknown name is refused below, not shown as a value.
  const given = Object.fromEntries(Object.entries(options.variables ?? {}).filter(([k]) => k in test.variables));
  const vars: Record<string, string> = { ...Object.fromEntries(Object.entries(test.variables).map(([k, v]) => [k, v.value])), ...given };
  const captures = new Set(test.steps.flatMap((s) => (s.capture ?? []).map((c) => c.var)));
  const captured = new Set<string>();
  const info = await driver.refresh();
  const result: ReplayResult = { name: test.name, passed: false, system: `${info.system ?? "?"}${info.client ? `/${info.client}` : ""}`, surface: info.surface, steps: [], variables: vars, ms: 0 };
  const strict = (options.screens ?? "strict") === "strict";
  const finish = (aborted?: string): ReplayResult => {
    if (aborted) result.aborted = aborted;
    const missed = [...captures].filter((v) => !captured.has(v) && !(v in given));
    if (missed.length) result.notCaptured = missed;
    result.passed = !aborted && result.steps.length === test.steps.length && result.steps.every((s) => s.outcome === "pass");
    result.ms = Date.now() - t0;
    return result;
  };
  const unknown = Object.keys(options.variables ?? {}).filter((k) => !(k in test.variables));
  if (unknown.length) return finish(`the test has no variable ${unknown.map((k) => `\${${k}}`).join(", ")} (it has: ${Object.keys(test.variables).join(", ") || "none"})`);
  const missing = inputsOf(test).filter((k) => vars[k] === undefined);
  if (missing.length) return finish(`no value for ${missing.map((k) => `\${${k}}`).join(", ")}`);
  if (!test.steps.length) return finish("the recording has no steps");
  if (info.surface !== test.recorded.surface) return finish(`the test was recorded on ${test.recorded.surface}; this session is ${info.surface}. Ids differ between Fiori and SAP GUI screens.`);

  let screen: ParsedScreen;
  try {
    screen = await read(driver);
    if (screen.logon) return finish("the session is on the logon screen: log on first");
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
    if (left) return finish(`a popup is open and the replay could not close it: "${left.title}". Answer it, then run the replay again`);
    // A clean start: the recording's first transaction, opened fresh.
    const opens = test.steps[0]?.action;
    const startsClean = opens?.do === "okcode" && /^\/n\S/i.test(String(opens.value ?? ""));
    const t = test.start.transaction;
    if (!startsClean && t && !HOME.has(t.toUpperCase()) && info.surface !== "fiori") {
      await guarded(driver, policy, normalizeAction({ do: "okcode", value: `/n${t}` }));
      screen = await read(driver);
      if (strict && test.start.program && screen.program && (screen.program !== test.start.program || screen.screen !== test.start.screen))
        return finish(`/n${t} opened ${where(screen)}, but the recording started on ${where(test.start)}: record the test from /n${t} on`);
    }
  } catch (e) {
    return finish(`could not start: ${first(e)}`);
  }

  let failed = false;
  for (const [i, step] of test.steps.entries()) {
    const r: StepResult = { n: i + 1, outcome: "pass", ms: 0, failures: [], warnings: [], passed: [], ...(step.note ? { note: step.note } : {}) };
    result.steps.push(r);
    if (failed) {
      r.outcome = "skipped";
      if (step.action) r.action = actionText(step.action as NormalizedAction);
      continue;
    }
    const s0 = Date.now();
    try {
      if (step.action) {
        let action = actionWith(step.action, vars);
        // The screen may have moved the control: find it by its field name before giving up on the id.
        if (action.id && step.target) {
          const found = locate(screen, step.target.id) ?? locate(screen, action.id);
          if (found && found.by !== "exact") {
            r.warnings.push(`${step.target.id} was found as ${found.control.id} (same field name)`);
            action = normalizeAction({ ...action, id: found.control.id });
          }
        }
        r.action = actionText(action);
        // The recording confirmed an Information popup here that SAP did not show this time: nothing to answer.
        const confirms = confirming(step);
        if (confirms && !screen.windows.some((w) => w.id === confirms)) {
          r.warnings.push(`the recording confirmed a popup here ("${step.on?.title ?? ""}") that SAP did not show this time: step skipped`);
          r.ms = Date.now() - s0;
          options.onStep?.(r);
          continue;
        }
        await guarded(driver, policy, action);
        screen = await read(driver);
        // Windows SAP showed that the recording does not have here: passed when they only inform, else the step fails.
        for (let k = 0; k < MAX_DETOURS && !asRecorded(step, screen, vars); k++) {
          const d = detour(screen);
          if (!d) break;
          if (d.kind === "stop" || !d.action) {
            r.failures.push(`SAP showed a ${d.what} that the recording does not have here. The replay answers only popups that inform (a Continue button, no question) and known optional screens: record the test on data that shows this window, or answer it and run the steps after it by hand`);
            break;
          }
          await guarded(driver, policy, d.action);
          r.warnings.push(`SAP showed a ${d.what} that the recording does not have: the replay ${d.answer}`);
          screen = await read(driver);
        }
        const landed = sessionRefusal(policy, await driver.refresh());
        if (landed) r.failures.push(`this led to a transaction the replay may not work in: ${landed}`);
        // The recording had popups here that the next steps confirm, and SAP showed none this time:
        // the step is judged by where those steps led.
        let judged = step;
        if (!asRecorded(step, screen, vars) && !popupOf(screen)) {
          let j = i + 1;
          while (test.steps[j] && confirming(test.steps[j] as Step)) j++;
          const last = test.steps[j - 1];
          if (j > i + 1 && last && asRecorded(last, screen, vars)) judged = { ...step, ...(last.after ? { after: last.after } : {}) };
        }
        if (!r.failures.length) implicit(judged, screen, strict, r, vars);
      } else screen = await read(driver);
      // On the wrong screen or after an error, the marked checks would only repeat the failure.
      if (r.failures.length) throw undefined;
      // Captures first: a check on the same step may use what was captured.
      for (const c of step.capture ?? []) {
        const got = captureValue(screen, c);
        if ("error" in got) r.failures.push(got.error);
        else {
          vars[c.var] = got.value;
          captured.add(c.var);
          r.passed.push(`\${${c.var}} = "${got.value}"`);
        }
      }
      for (const c of step.expect ?? []) {
        const v = evaluate(screen, c, vars);
        (v.ok ? r.passed : r.failures).push(v.text);
        if (v.ok && v.relocated) r.warnings.push(`${c.id} was found as ${v.relocated}`);
      }
    } catch (e) {
      if (e !== undefined) r.failures.push(first(e));
    }
    r.ms = Date.now() - s0;
    if (r.failures.length) {
      r.outcome = "fail";
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

export function resultText(r: ReplayResult): string {
  const lines = [`${r.passed ? "PASS" : "FAIL"}  ${r.name}  on ${r.surface} ${r.system}  (${r.steps.filter((s) => s.outcome === "pass").length}/${r.steps.length} steps, ${(r.ms / 1000).toFixed(1)} s)`];
  if (r.aborted) lines.push(`Not run: ${r.aborted}.`);
  for (const b of r.before ?? []) lines.push(`Before step 1: ${b}.`);
  for (const s of r.steps) {
    lines.push(`${s.outcome === "pass" ? "ok  " : s.outcome === "fail" ? "FAIL" : "skip"} ${s.n}. ${s.action ?? "(check only)"}${s.note ? `  — ${s.note}` : ""}`);
    for (const f of s.failures) lines.push(`       failed: ${f}`);
    for (const w of s.warnings) lines.push(`       note: ${w}`);
    for (const p of s.passed) lines.push(`       ok: ${p}`);
  }
  const missed = new Set(r.notCaptured ?? []);
  const vars = Object.entries(r.variables);
  if (vars.length) lines.push(`Variables: ${vars.map(([k, v]) => (missed.has(k) ? `\${${k}} not captured in this run (recorded "${v}")` : `\${${k}} = "${v}"`)).join(", ")}`);
  if (r.screen) lines.push("", "Screen at the failure:", r.screen);
  return lines.join("\n");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** JUnit XML, the format CI servers read: one suite per test, one case per step. */
export function junit(results: ReplayResult[]): string {
  const suites = results.map((r) => {
    const cases = r.steps.map((s) => {
      const head = `    <testcase name="${xml(`${s.n}. ${s.action ?? "check"}`)}" classname="${xml(r.name)}" time="${(s.ms / 1000).toFixed(3)}"`;
      if (s.outcome === "skipped") return `${head}><skipped/></testcase>`;
      if (s.outcome === "fail") return `${head}><failure message="${xml(s.failures[0] ?? "failed")}">${xml([...s.failures, "", r.screen ?? ""].join("\n"))}</failure></testcase>`;
      return `${head}/>`;
    });
    if (r.aborted) cases.unshift(`    <testcase name="start" classname="${xml(r.name)}"><error message="${xml(r.aborted)}"/></testcase>`);
    const fails = r.steps.filter((s) => s.outcome === "fail").length;
    return `  <testsuite name="${xml(r.name)}" tests="${cases.length}" failures="${fails}" errors="${r.aborted ? 1 : 0}" skipped="${r.steps.filter((s) => s.outcome === "skipped").length}" time="${(r.ms / 1000).toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join("\n")}\n</testsuites>\n`;
}
