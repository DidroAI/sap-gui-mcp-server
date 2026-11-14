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
import { actionWith, inputsOf, type SapTest, type Step } from "./format.js";
import { locate, type ParsedScreen, parseScreen } from "./screen.js";

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
function implicit(step: Step, screen: ParsedScreen, strict: boolean, r: StepResult): void {
  const was = step.after;
  const type = screen.status?.type;
  if ((type === "E" || type === "A") && was?.status?.type !== type) r.failures.push(`SAP reported an error in the status bar: ${screen.status?.text ?? ""}`);
  if (!was) return;
  const moved = (["transaction", "program", "screen"] as const).filter((k) => was[k] && screen[k] && was[k] !== screen[k]);
  if (moved.length) (strict ? r.failures : r.warnings).push(`landed on another screen: ${where(screen)}${screen.title ? ` "${screen.title}"` : ""}, recorded ${where(was)}`);
}

export async function replay(driver: Driver, policy: Policy, test: SapTest, options: ReplayOptions = {}): Promise<ReplayResult> {
  const t0 = Date.now();
  const vars: Record<string, string> = { ...Object.fromEntries(Object.entries(test.variables).map(([k, v]) => [k, v.value])), ...(options.variables ?? {}) };
  const info = await driver.refresh();
  const result: ReplayResult = { name: test.name, passed: false, system: `${info.system ?? "?"}${info.client ? `/${info.client}` : ""}`, surface: info.surface, steps: [], variables: vars, ms: 0 };
  const strict = (options.screens ?? "strict") === "strict";
  const finish = (aborted?: string): ReplayResult => {
    if (aborted) result.aborted = aborted;
    result.passed = !aborted && result.steps.length === test.steps.length && result.steps.every((s) => s.outcome === "pass");
    result.ms = Date.now() - t0;
    return result;
  };
  const unknown = Object.keys(options.variables ?? {}).filter((k) => !(k in test.variables));
  if (unknown.length) return finish(`the test has no variable ${unknown.map((k) => `\${${k}}`).join(", ")} (it has: ${Object.keys(test.variables).join(", ") || "none"})`);
  const missing = inputsOf(test).filter((k) => vars[k] === undefined);
  if (missing.length) return finish(`no value for ${missing.map((k) => `\${${k}}`).join(", ")}`);
  if (info.surface !== test.recorded.surface) return finish(`the test was recorded on ${test.recorded.surface}; this session is ${info.surface}. Ids differ between Fiori and SAP GUI screens.`);

  let screen: ParsedScreen;
  try {
    screen = await read(driver);
    if (screen.logon) return finish("the session is on the logon screen: log on first");
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
        await guarded(driver, policy, action);
        screen = await read(driver);
        const landed = sessionRefusal(policy, await driver.refresh());
        if (landed) r.failures.push(`this led to a transaction the replay may not work in: ${landed}`);
        implicit(step, screen, strict, r);
      } else screen = await read(driver);
      // On the wrong screen or after an error, the marked checks would only repeat the failure.
      if (r.failures.length) throw undefined;
      // Captures first: a check on the same step may use what was captured.
      for (const c of step.capture ?? []) {
        const got = captureValue(screen, c);
        if ("error" in got) r.failures.push(got.error);
        else {
          vars[c.var] = got.value;
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
  for (const s of r.steps) {
    lines.push(`${s.outcome === "pass" ? "ok  " : s.outcome === "fail" ? "FAIL" : "skip"} ${s.n}. ${s.action ?? "(check only)"}${s.note ? `  — ${s.note}` : ""}`);
    for (const f of s.failures) lines.push(`       failed: ${f}`);
    for (const w of s.warnings) lines.push(`       note: ${w}`);
    for (const p of s.passed) lines.push(`       ok: ${p}`);
  }
  const vars = Object.entries(r.variables);
  if (vars.length) lines.push(`Variables: ${vars.map(([k, v]) => `\${${k}} = "${v}"`).join(", ")}`);
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
