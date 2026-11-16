/**
 * A repair of one step of a replay.
 *
 * A replay stops at the first step that does not go as recorded. Whoever
 * runs it (a person, an agent, a program that asks a model about that one
 * step) can hand back a repair for that step: a few actions, or a capture
 * of a number SAP makes anew at each run. The replay carries it out under
 * the rules of this file, judges the step by what the recording expected,
 * and goes on with the steps after it. This file calls no model.
 *
 * The rules, whatever the repair says:
 *   - every action passes the guard, as in `sap_act`;
 *   - no write the recording does not have: an action rated "commit" is
 *     refused unless the recorded step is itself a write, the repair stands
 *     in for it or completes it (not "before"), and it is the only one;
 *   - a confirmation is the write it completes: while SAP holds a warning or
 *     a popup it raised at a write (the step being repaired, or the step
 *     before it), Enter or a confirming button there counts as that write.
 *     So it is refused on any step that is not that write, and before the
 *     recorded write (the write would run twice);
 *   - no leaving: an okcode that opens a transaction or ends the session is
 *     refused;
 *   - no invented data: a typed value is in the recording or on the screen;
 *   - the recorded checks are never dropped. The one change to a check is a
 *     capture, verified here: the texts differ by that one value only.
 *
 * A repair that worked gives a proposed test: the recording with the change
 * written in. Nothing is saved; the person decides.
 */
import { z } from "zod";
import { actionText, normalizeAction, type NormalizedAction } from "../core/action.js";
import { okcodeKind } from "../core/guard.js";
import type { Assessment, Driver } from "../core/types.js";
import { captureValue } from "./checks.js";
import { type Capture, fill, parametriseStep, type SapTest, type Step } from "./format.js";
import { locate, type ParsedScreen, refOf } from "./screen.js";

export const MAX_REPAIR_ACTIONS = 4;

/**
 * Where a step failed:
 *   act      the recorded action could not run (its control is not there, SAP refused the input);
 *   landing  it ran and led elsewhere: a popup, another screen, an error in the status bar;
 *   check    the screen is the recorded one, a marked check or capture does not hold;
 *   refused  the guard refused the recorded action (not drift: never repaired).
 */
export type Phase = "act" | "landing" | "check" | "refused";

export const repairSchema = z.object({
  /** What changed since the recording, in one sentence. Goes into the result and the proposed test. */
  why: z.string().min(1),
  /** Actions as `sap_act` takes them. */
  actions: z.array(z.record(z.string(), z.unknown())).optional(),
  /**
   * How the actions relate to the recorded action of the step:
   *   before   do them, then the recorded action runs;
   *   instead  they stand in for it (it could not run);
   *   after    it already ran; they complete it (a popup it raised).
   */
  place: z.enum(["before", "instead", "after"]).optional(),
  /** A value SAP makes anew at each run (a document number), read into a variable from now on. */
  /**
   * With place "after": actions an earlier try at this step already ran, in order, when that try did not get the
   * step through. They are not run again; the proposed test holds them before `actions`, because the run did.
   */
  earlier: z.array(z.record(z.string(), z.unknown())).optional(),
  capture: z.object({ var: z.string(), from: z.enum(["status", "field", "title"]), id: z.string().optional(), pattern: z.string().min(1) }).optional(),
});
export type Repair = z.infer<typeof repairSchema>;

/** What a repair did, in the step's result. */
export interface RepairRecord {
  why: string;
  outcome: "repaired" | "refused" | "failed";
  /** The actions run, as text. */
  did: string[];
  place?: Repair["place"];
  /** `${order} = "19105" (recorded "19097")`. */
  captured?: string;
  /** Why it was refused or did not work. */
  problem?: string;
}

export interface Proposal {
  /** The change in words, one line each. */
  changes: string[];
  /** The recording with the change written in. */
  test: SapTest;
  /** For each step of `test`, the number of the step of the replayed test it comes from (added steps: the repaired step). */
  origin: number[];
}

/** A repair that is not allowed. The step fails with this message; SAP was not touched by the refused part. */
export class RepairRefused extends Error {
  override name = "RepairRefused";
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** One token of letters and digits, at least one digit: a document number, not an amount or a sentence. */
const TOKEN = /^(?=.*\d)[A-Za-z0-9]+$/;

/** Why the repair cannot be tried at all, before anything runs. */
export function repairRefusal(step: Step, repair: Repair, test: SapTest): string | undefined {
  const n = repair.actions?.length ?? 0;
  if (repair.capture && n) return "a repair is either actions or a capture, not both";
  if (!repair.capture && !n) return "a repair needs actions or a capture";
  if (n > MAX_REPAIR_ACTIONS) return `a repair is at most ${MAX_REPAIR_ACTIONS} actions (got ${n}): a step that needs more has changed too much, record it again`;
  if (n && !repair.place) return 'a repair with actions says "place": before (then the recorded action runs), instead (they replace it) or after (it already ran)';
  if (n && repair.place === "instead" && !step.action) return "this step has no action to replace";
  if (repair.earlier?.length && repair.place !== "after") return 'actions of an earlier try ("earlier") go with place "after": they ran after the recorded action';
  if (repair.capture) {
    if (step.risk !== "commit") return "a capture is for a number SAP makes when it saves: this step does not write, so a different value here is a different result, not a new number";
    if (!NAME.test(repair.capture.var)) return "a variable name is letters, digits and _, not starting with a digit";
    if (repair.capture.var in test.variables) return `the test already has a variable \${${repair.capture.var}}`;
    if (repair.capture.from === "field" && !repair.capture.id) return 'a capture from a field needs "id"';
  }
  return undefined;
}

/** Is this value in the recording or on the screen? A repair types nothing else. */
export function valueKnown(value: string, test: SapTest, vars: Record<string, string>, screen: ParsedScreen): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  const hay = `${JSON.stringify(test)}\n${Object.values(vars).join("\n")}\n${screen.text}`.toLowerCase();
  return hay.includes(v);
}

const isPopup = (window: string) => /^wnd\[[1-9]\d*\]/.test(window);
/** Cancel, No, Back, the x of a popup: answers that decline. They complete nothing. */
const declines = (id: string, label: string) => /\/btn\[(12|3|15)\]$|\/close$|CANCEL|OPTION_CAN/i.test(id) || /^(cancel|no|back|exit|abbrechen|nein|zur(ü|ue)ck|beenden)\b/i.test(label.trim());

/**
 * The write SAP is in the middle of, if any: right after a step that writes
 * (the one being repaired, or the one before it), SAP shows a warning in the
 * status bar or a popup. What confirms it carries the write through: SAP
 * saves on the Enter that acknowledges "Minimum quantity not reached".
 */
export function writeInFlight(step: Step, previous: Step | undefined, screen: ParsedScreen): "this" | "previous" | undefined {
  const held = screen.status?.type === "W" || screen.windows.some((w) => isPopup(w.id));
  if (!held) return undefined;
  if (step.risk === "commit") return "this";
  return previous?.risk === "commit" ? "previous" : undefined;
}

/** Does this action confirm what the screen holds: Enter, or a button of a popup that does not decline? */
export function confirms(action: NormalizedAction, screen: ParsedScreen): boolean {
  if (action.do === "key") return action.key === 0 || /^enter$/i.test(String(action.key));
  if (action.do !== "press" && action.do !== "click") return false;
  const found = action.id ? locate(screen, action.id) : undefined;
  const id = found?.control.id ?? String(action.id ?? "");
  if (declines(id, found?.control.label ?? "")) return false;
  // The Enter button of the main toolbar, or any other button of a popup.
  return /^wnd\[0\]\/tbar\[0\]\/btn\[0\]$/.test(id) || isPopup(found?.control.window ?? id);
}

export interface RepairRun {
  screen: ParsedScreen;
  /** The actions as steps, for the proposed test. */
  steps: Step[];
  did: string[];
}

/**
 * Runs the actions of a repair. `guarded` and `read` are the replay's own:
 * the same guard and the same settled read as every recorded step.
 */
export async function runRepairActions(
  driver: Driver,
  test: SapTest,
  step: Step,
  repair: Repair,
  vars: Record<string, string>,
  screen: ParsedScreen,
  guarded: (action: NormalizedAction, rated?: Assessment) => Promise<string>,
  read: () => Promise<ParsedScreen>,
  /** The recorded step before this one: a write it made may still be waiting for a confirmation. */
  previous?: Step,
): Promise<RepairRun> {
  const steps: Step[] = [];
  const did: string[] = [];
  let commits = 0;
  for (const raw of repair.actions ?? []) {
    let action: NormalizedAction;
    try {
      action = normalizeAction(raw);
    } catch (e) {
      throw new RepairRefused(`not an action: ${(e as Error).message.split("\n")[0]}`);
    }
    if (action.do === "open") throw new RepairRefused("a repair stays in the recorded flow: it does not open another app");
    if (action.do === "okcode") {
      const v = String(action.value ?? "").trim();
      if (okcodeKind(v).kind !== "other" || /^\/[nNoOiI*]/.test(v)) throw new RepairRefused(`a repair stays in the recorded flow: okcode ${v} leaves it`);
    }
    for (const k of ["value", "key"] as const) {
      if ((action.do === "set" || action.do === "combo") && typeof action[k] === "string" && !valueKnown(action[k], test, vars, screen))
        throw new RepairRefused(`"${action[k]}" is neither in the recording nor on the screen: a repair does not invent data. The test needs this value from a person`);
    }
    let assessment = await driver.assess(action);
    // A confirmation of what SAP raised at a write is that write, whatever the surface rates an Enter.
    const pending = assessment.risk === "commit" ? undefined : writeInFlight(step, previous, screen);
    if (pending && confirms(action, screen)) {
      const held = screen.windows.some((w) => isPopup(w.id)) ? `the popup "${screen.title ?? ""}"` : `the warning "${screen.status?.text ?? ""}"`;
      if (pending === "previous")
        throw new RepairRefused(`${actionText(action)} would confirm ${held}, which SAP raised at the write of the step before: confirming it completes that write, and the step being repaired is not that write. The run stops here; a person decides`);
      assessment = { risk: "commit", reason: `it confirms ${held} that SAP raised while saving, which completes the save` };
    }
    if (assessment.risk === "commit") {
      if (step.risk !== "commit") throw new RepairRefused(`${actionText(action)} may write to SAP (${assessment.reason}), and the recorded step does not write: a repair adds no write`);
      if (repair.place === "before") throw new RepairRefused(`${actionText(action)} may write to SAP (${assessment.reason}) and the recorded write would run after it: use "instead" or "after"`);
      if (commits++) throw new RepairRefused("a repair holds at most one action that may write");
    }
    const before = screen;
    // The guard decides on the rating used here: with writing off, a confirmation that completes a write is refused as one.
    await guarded(action, assessment);
    did.push(actionText(action));
    screen = await read();
    const { do: verb, ...rest } = action;
    const found = action.id ? locate(before, action.id) : undefined;
    steps.push({
      action: { do: verb, ...rest },
      ...(found ? { target: { id: found.control.id, type: found.control.type, ...(found.control.label ? { label: found.control.label } : {}) } } : {}),
      risk: assessment.risk,
      note: `Added by a repair: ${repair.why}`,
      on: refOf(before),
      after: { ...refOf(screen), ...(screen.status ? { status: screen.status } : {}) },
    });
  }
  return { screen, steps, did };
}

const safeFill = (text: string, vars: Record<string, string>) => {
  try {
    return fill(text, vars);
  } catch {
    return text;
  }
};

/**
 * Applies a capture to the test (changed in place: pass a copy): the step
 * reads the value at every run, and wherever this or a later step holds the
 * recorded value, it holds the variable. Verified: the pattern finds a value
 * on the screen now and the recorded value in what the step recorded there.
 * Returns the two values. The step's checks are evaluated by the replay
 * after this, with the variable: they must all hold.
 */
export function applyCapture(test: SapTest, index: number, repair: Repair, screen: ParsedScreen, vars: Record<string, string>): { now: string; recorded: string } {
  const step = test.steps[index] as Step;
  const c = repair.capture as NonNullable<Repair["capture"]>;
  const capture: Capture = { var: c.var, from: c.from, pattern: c.pattern };
  if (c.from === "field") {
    const found = locate(screen, c.id ?? "");
    if (!found) throw new RepairRefused(`no control ${c.id} on the screen to capture from`);
    capture.id = found.control.id;
    if (found.control.label) capture.label = found.control.label;
  }
  const got = captureValue(screen, capture);
  if ("error" in got) throw new RepairRefused(got.error);
  if (!TOKEN.test(got.value)) throw new RepairRefused(`"${got.value}" is not a document number (one token of letters and digits): a capture is not for texts or amounts`);
  // The recorded value: the same pattern on what the step recorded at the same place.
  const texts: string[] = [];
  if (c.from === "status" && step.after?.status?.text) texts.push(step.after.status.text);
  if (c.from === "title" && step.after?.title) texts.push(step.after.title);
  for (const e of step.expect ?? []) if (e.op !== "matches" && e.check === c.from && (c.from !== "field" || e.id === capture.id || e.id === c.id)) texts.push(e.value);
  let recorded: string | undefined;
  for (const t of texts) {
    const m = new RegExp(c.pattern).exec(safeFill(t, vars));
    recorded = m?.[1] ?? m?.[0];
    if (recorded) break;
  }
  if (!recorded) throw new RepairRefused(`the pattern ${c.pattern} does not find a value in what the recording holds for the ${c.from} of this step, so the recorded number is unknown`);
  if (recorded === got.value) throw new RepairRefused(`the ${c.from} holds the recorded value "${recorded}": nothing changed there`);
  if (!TOKEN.test(recorded)) throw new RepairRefused(`the recorded value "${recorded}" is not a document number`);
  (step.capture ??= []).push(capture);
  test.variables[c.var] = { value: recorded, description: `read from the ${c.from === "field" ? `field ${capture.label ?? capture.id}` : c.from === "status" ? "status bar" : "window title"} after step ${index + 1} (added by a repair)` };
  // The step that produced the value still types what it typed; what it shows is the variable.
  parametriseStep(step, c.var, recorded, { actions: false });
  for (const later of test.steps.slice(index + 1)) parametriseStep(later, c.var, recorded);
  return { now: got.value, recorded };
}

/**
 * The recording with a repair that worked written in.
 *   original  the test as it was replayed
 *   working   the replay's copy (it holds a capture's changes)
 *   index     the repaired step
 *   added     the repair's actions as steps
 */
export function propose(original: SapTest, working: SapTest, index: number, repair: Repair, added: Step[], captured?: { now: string; recorded: string }): Proposal {
  const n = index + 1;
  const step = original.steps[index] as Step;
  const what = step.action ? actionText(normalizeAction(step.action)) : "(check only)";
  if (repair.capture) {
    const uses = working.steps.slice(index + 1).filter((s, k) => JSON.stringify(s) !== JSON.stringify(original.steps[index + 1 + k])).length;
    return {
      test: structuredClone(working),
      origin: working.steps.map((_, i) => i + 1),
      changes: [
        `Step ${n} (${what}): ${repair.why}`,
        `New variable \${${repair.capture.var}}, read from the ${repair.capture.from} after step ${n} with ${repair.capture.pattern} (recorded "${captured?.recorded ?? ""}", this run "${captured?.now ?? ""}").`,
        `The checks of step ${n}${uses ? ` and ${uses} later step(s)` : ""} use the variable in place of "${captured?.recorded ?? ""}".`,
      ],
    };
  }
  const test = structuredClone(original);
  // What an earlier try ran comes first: the screens it was done on are not known here, so those steps hold none.
  const earlier: Step[] = (repair.earlier ?? []).map((raw) => {
    const { do: verb, ...rest } = normalizeAction(raw);
    return { action: { do: verb, ...rest }, note: `Added by a repair: ${repair.why}` };
  });
  const fresh = [...earlier, ...structuredClone(added)];
  const list = fresh.map((s) => actionText(normalizeAction(s.action as Record<string, unknown>))).join(", then ");
  let changes: string[];
  // "before" on a screen the step was not recorded on: the recorded action had already run in this run and led
  // there, and it ran again after the repair. The proposed test holds what the run did: the action, the added
  // actions, the action again with its checks.
  const at = added[0]?.on;
  const ranBefore = repair.place === "before" && !!step.action && !!step.on && !!at && (["transaction", "program", "screen"] as const).some((k) => step.on?.[k] && at[k] && step.on[k] !== at[k]);
  if (ranBefore) {
    const { note: _note, expect: _expect, capture: _capture, ...bare } = structuredClone(step);
    test.steps.splice(index, 0, { ...bare, ...(at ? { after: at } : {}) }, ...fresh);
    changes = [`Step ${n} (${what}): ${repair.why}`, `Added after step ${n}: ${list}, then the action of step ${n} again, with its checks.`];
  } else if (repair.place === "before") {
    test.steps.splice(index, 0, ...fresh);
    changes = [`Step ${n} (${what}): ${repair.why}`, `Added before step ${n}: ${list}.`];
  } else {
    // The last added action now leads where the recorded step led: it takes the step's note, result, checks and captures.
    const last = fresh.at(-1) as Step;
    const kept = structuredClone(step);
    if (kept.note) last.note = kept.note;
    if (kept.after) last.after = kept.after;
    if (kept.expect) last.expect = kept.expect;
    if (kept.capture) last.capture = kept.capture;
    if (repair.place === "instead") {
      test.steps.splice(index, 1, ...fresh);
      changes = [`Step ${n} (${what}): ${repair.why}`, `Step ${n} replaced by: ${list}. Its checks are unchanged.`];
    } else {
      const first = fresh[0] as Step;
      // The step now leads to the screen the first added action was done on; when that is not known, to no checked screen.
      const { note: _note, expect: _expect, capture: _capture, after: _after, ...bare } = kept;
      test.steps.splice(index, 1, { ...bare, ...(first.on ? { after: first.on } : {}) }, ...fresh);
      changes = [`Step ${n} (${what}): ${repair.why}`, `Added after step ${n}: ${list}. The checks of step ${n} now follow the added action${fresh.length > 1 ? "s" : ""}.`];
    }
  }
  const origin: number[] = [];
  test.steps.forEach((_, i) => {
    const grew = test.steps.length - original.steps.length;
    origin.push(i < index ? i + 1 : i <= index + grew ? n : i + 1 - grew);
  });
  return { test, origin, changes };
}
