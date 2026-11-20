/**
 * Tidy: a recording as an agent made it (detours, corrections, error round
 * trips) turned into the test a person would have written. Deterministic
 * rules, each removal or addition with a reason in the log:
 *
 *   abandoned  a visit opened with /n<tcode> where nothing was saved, checked,
 *              captured or noted, and that the next /n left: dropped;
 *   error      a key or button that only raised an error (E/A) and stayed on
 *              the screen, with steps after it: dropped (the steps after it
 *              are the correction);
 *   repeat     a set, check or dropdown on the same control done again, or a
 *              tab of the same tab strip selected again, before any round
 *              trip: only the last one is kept;
 *   capture    a 5+ digit number in a status bar that later steps type or
 *              expect, and that no capture reads: captured (hints() advice);
 *   variable   a value typed into a field: a variable (hints() advice);
 *   status     the success message (S) a save led to: a check;
 *   title      the title a step landed on when it changed the screen, the
 *              first time that screen is reached and only where no other
 *              check says it: a check;
 *   handle     the shortest unique id recorded for each control
 *              (`target.handle`): used in actions and field checks. Numbered
 *              controls (btn[0]) keep their full id; code presses them by label.
 *
 * The tidied test is still a `.saptest.json`: replay runs it. What only code
 * can say (a screen SAP shows for some data only, a warning a save may
 * raise) goes to the TODO list and to the `*.sap.ts` export (export/sap-ts.ts
 * with `tidy`), which writes it as conditions.
 *
 * `verifyTidy` checks the removals on a system: it replays the tidied test
 * and, when it fails, puts back the last removal before the failing step and
 * tries again (a few rounds). That replay runs the whole test, writes
 * included when the test writes and the policy lets it: run it on a test
 * system or a fake.
 */
import { actionText, type NormalizedAction } from "../core/action.js";
import type { Policy } from "../core/guard.js";
import type { Driver } from "../core/types.js";
import type { Sap } from "../sdk/session.js";
import { vkeyNumber } from "../sapgui/keys.js";
import { type Check, parametriseStep, type SapTest, type ScreenRefT, type Step } from "./format.js";
import { OPTIONAL_SCREENS, replay, type ReplayOptions, type ReplayResult } from "./replay.js";
import type { ParsedScreen } from "./screen.js";

export interface Removal {
  rule: "abandoned" | "error" | "repeat";
  /** The steps of the original recording it dropped, from 1. */
  steps: number[];
  reason: string;
}

export interface TidyResult {
  test: SapTest;
  /** One line per change, with its reason. */
  log: string[];
  /** What tidy could not decide and a person should look at. */
  todo: string[];
  removed: Removal[];
  /** For each step of the tidied test, the step of the original it is (from 1). */
  origin: number[];
}

export interface TidyOptions {
  /** Steps of the original (from 1) no rule may drop: removals `verifyTidy` put back. */
  keep?: Iterable<number>;
}

interface Item {
  s: Step;
  /** Its number in the original, from 1. */
  n: number;
}

const TRACE_ONLY = ["screen", "shot", "code"] as const;
const isOpen = (s: Step) => s.action?.do === "okcode" && /^\/n\S/i.test(String(s.action.value ?? ""));
const marked = (s: Step) => !!(s.expect?.length || s.capture?.length || s.note);
const sameScreen = (a: ScreenRefT | undefined, b: ScreenRefT | undefined) => !!a && !!b && a.program === b.program && a.screen === b.screen && a.transaction === b.transaction;
const text = (s: Step) => (s.action ? actionText(s.action as NormalizedAction) : "(check only)");
const range = (ns: number[]) => (ns.length === 1 ? `step ${ns[0]}` : `steps ${ns[0]}-${ns.at(-1)}`);
const keyOf = (s: Step) => (s.action?.do === "key" ? vkeyNumber(s.action.key ?? s.action.value) : undefined);
const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A screen reference as the replay's screen tests read it (they only look at program and title). */
const asScreen = (r: ScreenRefT): ParsedScreen => ({ ...(JSON.parse(JSON.stringify(r)) as Record<string, string>), windows: [], controls: [], logon: false, text: "" });

/** The screen SAP shows for some data only that a recorded screen is, if it is one (replay.ts OPTIONAL_SCREENS). */
export function optionalScreen(r: ScreenRefT | undefined): (typeof OPTIONAL_SCREENS)[number] | undefined {
  return r ? OPTIONAL_SCREENS.find((o) => o.is(asScreen(r))) : undefined;
}

/** Is this step a save: key 11 (Ctrl+S), or the press of a toolbar button 11? */
export function isSave(s: Step): boolean {
  if (keyOf(s) === 11) return true;
  return s.action?.do === "press" && /(^|\/)btn\[11\]$/.test(String(s.target?.id ?? s.action.id ?? ""));
}

/** Is this step the Enter that acknowledges a warning a save raised (the step before it)? */
export function acknowledgesWarning(prev: Step | undefined, s: Step): boolean {
  return !!prev && isSave(prev) && prev.after?.status?.type === "W" && keyOf(s) === 0 && sameScreen(prev.after, s.on);
}

/** Does this step confirm a popup that only informed (the recorder's `on.message`)? */
export function confirmsInfo(s: Step): boolean {
  const a = s.action;
  // The recorder marks a popup `message` only when it has text and a Continue, nothing else to press.
  if (!s.on?.popup || !s.on.message || !a || s.risk === "commit") return false;
  return a.do === "press" || keyOf(s) === 0;
}

/** A variable name from a label ("Sold-to party" -> soldToParty) or else a field (ctxtZORD-KUNNR -> kunnr). */
function nameFrom(label: string | undefined, id: string | undefined, taken: Set<string>): string {
  const words = (label ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let base = words.map((w, i) => (i ? w[0]?.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("");
  if (!base || /^\d/.test(base)) base = (lastSegment(id ?? "").replace(/^[a-z]+/, "").split("-").at(-1) ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!base || /^\d/.test(base)) base = "value";
  if (RESERVED.has(base)) base = `${base}Value`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return name;
}

const RESERVED = new Set("sap vars expect test info await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield async undefined arguments eval".split(" "));

/** The recording tidied; the original is not changed. */
export function tidy(original: SapTest, options: TidyOptions = {}): TidyResult {
  const test = structuredClone(original);
  const keep = new Set(options.keep ?? []);
  const log: string[] = [];
  const todo: string[] = [];
  const removed: Removal[] = [];
  let items: Item[] = test.steps.map((s, i) => {
    for (const k of TRACE_ONLY) delete s[k];
    return { s, n: i + 1 };
  });
  const drop = (rule: Removal["rule"], gone: Item[], reason: string) => {
    const steps = gone.map((x) => x.n);
    removed.push({ rule, steps, reason });
    log.push(`${range(steps)}: dropped (${rule}): ${reason}`);
  };

  // 1. Abandoned visits: /n<tcode> ... up to the next /n, with nothing kept there.
  {
    const out: Item[] = [];
    for (let i = 0; i < items.length; ) {
      let j = i + 1;
      while (j < items.length && !isOpen((items[j] as Item).s)) j++;
      const seg = items.slice(i, j);
      const head = (seg[0] as Item).s;
      const dead = j < items.length && isOpen(head) && !seg.some((x) => x.s.risk === "commit" || marked(x.s) || keep.has(x.n));
      if (dead) drop("abandoned", seg, `a visit to ${String(head.action?.value)} where nothing was saved, checked, captured or noted before the next /n`);
      else out.push(...seg);
      i = j;
    }
    items = out;
  }

  // 2. A key or a button that only raised an error and stayed on the screen; the steps after it correct the input.
  items = items.filter((x, i) => {
    const s = x.s;
    const st = s.after?.status;
    const err =
      (s.action?.do === "key" || s.action?.do === "press") &&
      (st?.type === "E" || st?.type === "A") &&
      sameScreen(s.on, s.after) &&
      !s.on?.popup &&
      !marked(s) &&
      s.risk !== "commit" &&
      i < items.length - 1 &&
      !keep.has(x.n);
    if (err) drop("error", [x], `${text(s)} only raised "${st?.type}: ${st?.text}" and stayed on the screen; the steps after it correct the input`);
    return !err;
  });

  // 3. The same control set again (or the same tab strip selected again) before any round trip: the last one counts.
  {
    const tabStrip = (s: Step) => {
      const id = String(s.target?.id ?? s.action?.id ?? "");
      return /^tabp/.test(lastSegment(id)) ? id.slice(0, id.lastIndexOf("/")) : undefined;
    };
    const local = (s: Step) => {
      const d = s.action?.do;
      const kind = d === "set" || d === "check" || d === "combo" || (d === "select" && !!tabStrip(s) && s.action?.row === undefined);
      return kind && s.risk !== "commit" && sameScreen(s.on, s.after);
    };
    const control = (s: Step) => (s.action?.do === "select" ? `select ${tabStrip(s)}` : `${s.action?.do} ${String(s.target?.id ?? s.action?.id ?? "")}${s.action?.row !== undefined ? `[${String(s.action.row)},${String(s.action.col)}]` : ""}`);
    const gone = new Set<Item>();
    for (let i = 0; i < items.length; i++) {
      const x = items[i] as Item;
      if (!local(x.s) || marked(x.s) || keep.has(x.n)) continue;
      for (let k = i + 1; k < items.length && local((items[k] as Item).s); k++) {
        const y = items[k] as Item;
        if (control(y.s) !== control(x.s)) {
          // A tab is only dropped when nothing between was done on the tab it showed.
          if (x.s.action?.do === "select") break;
          continue;
        }
        drop("repeat", [x], `${text(x.s)}: step ${y.n} ${x.s.action?.do === "select" ? "selects a tab of the same tab strip" : "sets the same control"} again before any round trip`);
        gone.add(x);
        break;
      }
    }
    items = items.filter((x) => !gone.has(x));
  }

  const steps = () => items.map((x) => x.s);
  const taken = new Set([...Object.keys(test.variables)]);

  // 4a. A number SAP made (in a status bar) that later steps use: a capture, so the test does not reuse it.
  items.forEach((x, i) => {
    const st = x.s.after?.status?.text ?? "";
    for (const m of st.matchAll(/(?<![A-Za-z0-9])\d{5,}(?![A-Za-z0-9])/g)) {
      const n = m[0];
      const uses = (y: Step) => JSON.stringify(y.action ?? {}).includes(n) || (y.expect ?? []).some((c) => c.value.includes(n));
      if (!items.slice(i + 1).some((y) => uses(y.s))) continue;
      const word = /([A-Za-z][A-Za-z0-9]*)\s*$/.exec(st.slice(0, m.index))?.[1];
      const name = nameFrom(word, undefined, taken);
      const pattern = word ? `${reEscape(word)} (\\d+)` : "(\\d{5,})";
      (x.s.capture ??= []).push({ var: name, from: "status", pattern });
      test.variables[name] = { value: n, description: `read from the status bar after this step at every run (tidy)` };
      parametriseStep(x.s, name, n, { actions: false });
      for (const y of items.slice(i + 1)) parametriseStep(y.s, name, n);
      log.push(`step ${x.n}: captured \${${name}} from the status bar (/${pattern}/): later steps use ${n}, a number SAP made`);
      todo.push(`\${${name}} is read from the status bar after step ${x.n} with /${pattern}/: check that the pattern holds for the messages SAP gives there.`);
    }
  });

  // 4b. Typed values: variables, so another run can give other data.
  const typed: string[] = [];
  const byValue = new Map(Object.entries(test.variables).map(([k, v]) => [v.value, k]));
  for (const x of items) {
    const a = x.s.action;
    if (a?.do !== "set" || typeof a.value !== "string" || !a.value.trim() || a.value.includes("${")) continue;
    const value = a.value;
    let name = byValue.get(value);
    if (!name) {
      name = nameFrom(x.s.target?.label, x.s.target?.id ?? String(a.id ?? ""), taken);
      test.variables[name] = { value, description: `typed into ${x.s.target?.label || String(a.id ?? "a field")} (tidy)` };
      byValue.set(value, name);
      typed.push(`\${${name}} = "${value}"`);
    }
    // A value of one character would match unrelated text: only the fields typed with it take the variable.
    if (value.length >= 2) for (const y of steps()) parametriseStep(y, name, value);
    else for (const y of steps()) if (y.action?.do === "set" && y.action.value === value) y.action.value = `\${${name}}`;
  }
  if (typed.length) {
    log.push(`variables: ${typed.join(", ")} (typed values)`);
    todo.push(`Typed values became variables (${typed.join(", ")}): give other values per run, or inline the ones that never change.`);
  }

  // 5. The success message a save led to: a check.
  let added = 0;
  items.forEach((x, i) => {
    const s = x.s;
    const st = s.after?.status;
    const prev = items[i - 1]?.s;
    if (st?.type !== "S" || !(s.risk === "commit" || isSave(s) || (prev && (prev.risk === "commit" || isSave(prev)) && sameScreen(prev.after, s.on)))) return;
    if (s.expect?.some((c) => c.check === "status")) return;
    // A long number nobody captured: matched as any number, never as the one of this recording.
    const loose = /\d{5,}/.test(st.text) && !st.text.includes("${");
    const c: Check = loose ? { check: "status", op: "matches", value: reEscape(st.text).replace(/\d{5,}/g, "\\d+") } : { check: "status", op: "contains", value: st.text };
    (s.expect ??= []).push(c);
    added++;
    log.push(`step ${x.n}: check added: the status bar ${c.op === "matches" ? "matches" : "contains"} "${c.value}" (the success message the save led to)`);
  });

  // 6. The title a step landed on, when it changed the screen to one not reached before.
  const seen = new Set<string>();
  items.forEach((x, i) => {
    const s = x.s;
    const after = s.after;
    const next = items[i + 1]?.s;
    if (!after?.title || !s.action || isOpen(s)) {
      if (after) seen.add(`${after.program}/${after.screen}`);
      return;
    }
    const where = `${after.program}/${after.screen}`;
    const changed = !sameScreen(s.on, after) || !!s.on?.popup;
    const intoPopup = !!next?.on?.popup && sameScreen(next.on, after);
    const signal = changed && !intoPopup && !seen.has(where) && !optionalScreen(after) && !s.expect?.length && after.title !== s.on?.title;
    seen.add(where);
    if (!signal) return;
    (s.expect ??= []).push({ check: "title", op: "equals", value: after.title });
    added++;
    log.push(`step ${x.n}: check added: lands on "${after.title}"`);
  });
  if (!original.steps.some((s) => s.expect?.length))
    todo.push(`The recording marked no check${added ? `; tidy added ${added} from what SAP showed (a save's message, landing titles)` : ""}. Add one for what this test is meant to prove.`);

  // 7. Short ids: the handle recorded for each control, where it is a tail of the full id.
  let short = 0;
  for (const s of steps()) {
    const a = s.action;
    const h = s.target?.handle;
    if (a && h && typeof a.id === "string" && (a.id === s.target?.id || s.target?.id.endsWith(`/${a.id}`)) && a.id !== h) {
      a.id = h;
      short++;
    }
    for (const c of [...(s.expect ?? []), ...(s.capture ?? [])])
      if (c.id && c.handle && c.id !== c.handle) {
        c.id = c.handle;
        short++;
      }
  }
  if (short) log.push(`short ids: ${short} control(s) named by their shortest unique id on the screen (numbered buttons such as btn[0] keep their full id)`);

  // What only code can say, and what a person should look at.
  items.forEach((x, i) => {
    const s = x.s;
    const o = optionalScreen(s.on);
    if (o && s.action) {
      const neutral = s.action.do === "press" && o.button.test(s.target?.label ?? "");
      todo.push(
        neutral
          ? `Recorded step ${x.n} went through ${o.what} ("${s.on?.title ?? ""}"), a screen SAP shows for some data only: the code presses ${s.target?.label} only when it is there. Check that this is the choice the test should make.`
          : `Recorded step ${x.n} answers ${o.what} ("${s.on?.title ?? ""}") with ${text(s)}, not its neutral Continue: SAP shows it for some data only, and the test then fails where it is not shown.`,
      );
    }
    if (confirmsInfo(s)) todo.push(`Recorded step ${x.n} confirms an information popup ("${s.on?.title ?? ""}"): the code confirms it only when SAP shows it (sap.dismissInfo).`);
    if (acknowledgesWarning(items[i - 1]?.s, s))
      todo.push(`Recorded step ${x.n} acknowledges the warning the save answered with ("${items[i - 1]?.s.after?.status?.text ?? ""}"): the code saves with { acceptWarnings: true }, which accepts any warning.`);
    if (s.action?.do === "press" && /\[\d+\]$/.test(String(s.action.id ?? "")) && !s.target?.label)
      todo.push(`Recorded step ${x.n} presses ${String(s.action.id)}, a numbered button without a label: the code keeps its full id.`);
  });
  const first = items[0]?.s;
  if (first && !isOpen(first) && !test.start.transaction) todo.push("The test does not begin with /n<transaction>, and its start screen has no transaction: a run cannot make a clean start.");

  test.steps = steps();
  const origin = items.map((x) => x.n);
  if (removed.length || log.length) log.unshift(`${original.steps.length} steps -> ${test.steps.length} (step numbers here are the recording's).`);
  return { test, log, todo, removed, origin };
}

// ---- verifying on a system ----------------------------------------------------

export interface VerifyTidyOptions extends Pick<ReplayOptions, "variables" | "choices" | "screens"> {
  /** The policy to replay under; default: the Sap's own (required with a bare driver). */
  policy?: Policy;
  /** How many runs at most (each one runs the whole test). Default 4. */
  rounds?: number;
}

export interface VerifyTidyResult {
  passed: boolean;
  /** The tidied test as last run: with the removals that had to go back. */
  tidied: TidyResult;
  /** Removals put back because the test failed without them. */
  reverted: Removal[];
  runs: ReplayResult[];
  /** One line per run. */
  report: string[];
}

/**
 * Replays the tidied test on a system; when a step fails, puts back the last
 * removal before that step (in the original's order) and runs again, at most
 * `rounds` times. Accepted: every removal still out when a run passes.
 * Each run is a whole replay: it writes when the test writes and the policy
 * lets it (use a test system or a fake).
 */
export async function verifyTidy(target: Driver | Sap, original: SapTest, options: VerifyTidyOptions = {}): Promise<VerifyTidyResult> {
  const isSap = (t: Driver | Sap): t is Sap => "registry" in t && "sessionId" in t;
  const driver = isSap(target) ? await target.registry.driver(target.sessionId) : target;
  const policy = options.policy ?? (isSap(target) ? target.policy : undefined);
  if (!policy) throw new Error("verifyTidy: pass a policy with a bare driver");
  const keep = new Set<number>();
  const reverted: Removal[] = [];
  const runs: ReplayResult[] = [];
  const report: string[] = [];
  let tidied = tidy(original);
  for (let round = 1; round <= (options.rounds ?? 4); round++) {
    const r = await replay(driver, policy, tidied.test, {
      ...(options.variables ? { variables: options.variables } : {}),
      ...(options.choices ? { choices: options.choices } : {}),
      ...(options.screens ? { screens: options.screens } : {}),
    });
    runs.push(r);
    if (r.passed) {
      report.push(`run ${round}: PASS (${tidied.test.steps.length} steps; ${tidied.removed.length} removal(s) accepted)`);
      return { passed: true, tidied, reverted, runs, report };
    }
    const failed = r.steps.find((s) => s.outcome === "fail");
    if (!failed) {
      report.push(`run ${round}: not run: ${r.aborted ?? "no step failed"}`);
      break;
    }
    const at = tidied.origin[failed.n - 1] ?? Number.POSITIVE_INFINITY;
    // The removal nearest before the failing step: the likeliest cause.
    const back = [...tidied.removed].filter((m) => (m.steps[0] ?? 0) < at).sort((a, b) => (b.steps[0] ?? 0) - (a.steps[0] ?? 0))[0];
    const why = failed.failures[0] ?? "failed";
    if (!back) {
      report.push(`run ${round}: FAIL at step ${failed.n} (original step ${at}): ${why}. No removal comes before it: the failure is not tidy's.`);
      break;
    }
    report.push(`run ${round}: FAIL at step ${failed.n} (original step ${at}): ${why}. Putting back ${range(back.steps)} (${back.rule}).`);
    for (const n of back.steps) keep.add(n);
    reverted.push(back);
    tidied = tidy(original, { keep });
  }
  return { passed: false, tidied, reverted, runs, report };
}
