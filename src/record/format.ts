/**
 * The recorded test: one JSON file per run (`<name>.saptest.json`).
 *
 * A test is a list of steps. A step is one `sap_act` action as the server
 * ran it, the screen it was done on, the screen and status bar it led to,
 * and the checks and captures marked on that result. Values that change
 * from run to run are variables, written `${name}` wherever they occur.
 */
import { z } from "zod";
import { normalizeAction, type NormalizedAction } from "../core/action.js";
import type { Action } from "../core/types.js";

export const FORMAT = "sap-gui-test/1";
export const FILE_SUFFIX = ".saptest.json";

const screenRef = z.object({
  transaction: z.string().optional(),
  program: z.string().optional(),
  screen: z.string().optional(),
  title: z.string().optional(),
});

const statusMessage = z.object({ type: z.string().optional(), text: z.string() });

const OPS = ["equals", "contains", "matches"] as const;
export type Op = (typeof OPS)[number];
const SUBJECTS = ["status", "field", "title", "transaction", "text"] as const;
export type Subject = (typeof SUBJECTS)[number];

/** One thing that must hold on the screen a step leads to. */
const check = z.object({
  /** status: the status bar text. field: a control's value. title: the top window's title. transaction: the code. text: the whole view. */
  check: z.enum(SUBJECTS),
  /** For field: the control's SAP id, and what it was called when recorded. */
  id: z.string().optional(),
  label: z.string().optional(),
  type: z.string().optional(),
  op: z.enum(OPS),
  /** What is expected; may hold `${variables}`. For `matches`, a regular expression. */
  value: z.string(),
});

/** A value read from the screen a step leads to, kept as a variable for the steps after it. */
const capture = z.object({
  var: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  from: z.enum(["status", "field", "title"]),
  id: z.string().optional(),
  label: z.string().optional(),
  /** A regular expression; its first group is the value (the whole match without a group). Without it, the whole text. */
  pattern: z.string().optional(),
});

const step = z.object({
  /** The action, as `sap_act` takes it; absent for a step that only checks. */
  action: z.record(z.string(), z.unknown()).optional(),
  /** The control the action was done on: full SAP id, type and label when recorded. */
  target: z.object({ id: z.string(), type: z.string().optional(), label: z.string().optional() }).optional(),
  /** read, navigate or commit, as the surface classified the action when recorded. */
  risk: z.string().optional(),
  /** What this step is for, in the recorder's words. */
  note: z.string().optional(),
  /** The screen the action was done on. */
  /**
   * The screen the step was done on; `popup`: the popup window on top then
   * (wnd[1]...), if one was; `message`: that popup only informed (text and a
   * Continue, no question, no input), so a replay may skip the step when SAP
   * does not show it.
   */
  on: screenRef.extend({ popup: z.string().optional(), message: z.boolean().optional() }).optional(),
  /** The screen and status bar the action led to. */
  after: screenRef.extend({ status: statusMessage.optional() }).optional(),
  expect: z.array(check).optional(),
  capture: z.array(capture).optional(),
  /** How long the action took, from sending it to SAP having answered (the driver's own wait included), in ms. */
  ms: z.number().nonnegative().optional(),
  /** When the step started (ISO time). */
  at: z.string().optional(),
  /** Trace only: the screen the action led to, as the compact view an agent reads. */
  screen: z.string().optional(),
  /** Trace only: a screenshot of the screen the action led to, a path relative to the test file. */
  shot: z.string().optional(),
  /** Trace only: the SDK line that repeats this action. */
  code: z.string().optional(),
});

const variable = z.object({ value: z.string(), description: z.string().optional() });

export const testSchema = z.object({
  format: z.literal(FORMAT),
  name: z.string().min(1),
  description: z.string().optional(),
  recorded: z.object({
    at: z.string(),
    by: z.string().optional(),
    surface: z.string(),
    /** SAP GUI: "diag" when recorded through the DIAG method (its ids are SAP field names); absent for scripting. */
    method: z.string().optional(),
    system: z.string().optional(),
    client: z.string().optional(),
  }),
  /** The screen the recording started on. */
  start: screenRef,
  variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), variable),
  steps: z.array(step),
});

export type ScreenRefT = z.infer<typeof screenRef>;
export type Check = z.infer<typeof check>;
export type Capture = z.infer<typeof capture>;
export type Step = z.infer<typeof step>;
export type SapTest = z.infer<typeof testSchema>;

export function parseTest(json: string): SapTest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  const r = testSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`not a ${FORMAT} file: ${i ? `${i.path.join(".") || "(root)"}: ${i.message}` : "invalid"}`);
  }
  // Every action must be one the server accepts today.
  r.data.steps.forEach((s, n) => {
    if (!s.action) return;
    try {
      normalizeAction(s.action);
    } catch (e) {
      throw new Error(`step ${n + 1}: ${(e as Error).message}`);
    }
  });
  return r.data;
}

export const serializeTest = (t: SapTest): string => `${JSON.stringify(t, null, 2)}\n`;

/** "VA03 display order" -> "va03-display-order": a file name with nothing a path could use. */
export function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
  if (!s) throw new Error("a recording needs a name with at least one letter or digit");
  return s;
}

// ---- variables ---------------------------------------------------------------

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class MissingVariable extends Error {
  override name = "MissingVariable";
}

/** Replaces `${name}` with its value; an unknown name is an error, never an empty string. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(VAR, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new MissingVariable(`variable \${${name}} has no value`);
    return v;
  });
}

/** The variable names a text uses. */
export const usedIn = (text: string): string[] => Array.from(text.matchAll(VAR), (m) => m[1] ?? "");

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces a value by `${name}` where it stands alone, not inside a longer word or number ("19097", not "219097"). */
export function withVariable(text: string, name: string, value: string): string {
  if (!value) return text;
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${reEscape(value)}(?![A-Za-z0-9])`, "g"), `\${${name}}`);
}

const ACTION_TEXT_KEYS = ["value", "key", "node"] as const;

/** The action with its variables filled in, normalised as `sap_act` would. */
export function actionWith(action: Record<string, unknown>, vars: Record<string, string>): NormalizedAction {
  const out: Record<string, unknown> = { ...action };
  for (const k of ACTION_TEXT_KEYS) if (typeof out[k] === "string") out[k] = fill(out[k], vars);
  return normalizeAction(out);
}

/** Writes `${name}` for `value` in one step: what is typed, what is expected, and the recorded status bar and titles. */
export function parametriseStep(s: Step, name: string, value: string, opts: { actions: boolean } = { actions: true }): void {
  const sub = (t: string) => withVariable(t, name, value);
  if (s.action && opts.actions) for (const k of ACTION_TEXT_KEYS) if (typeof s.action[k] === "string") s.action[k] = sub(s.action[k]);
  for (const c of s.expect ?? []) if (c.op !== "matches") c.value = sub(c.value);
  if (s.after?.status) s.after.status.text = sub(s.after.status.text);
  if (s.after?.title) s.after.title = sub(s.after.title);
  if (s.on?.title && opts.actions) s.on.title = sub(s.on.title);
}

/** The variables a test needs from outside: used before any step captures them. */
export function inputsOf(t: SapTest): string[] {
  const captured = new Set<string>();
  const need = new Set<string>();
  for (const s of t.steps) {
    const use = (x: unknown) => {
      if (typeof x === "string") for (const v of usedIn(x)) if (!captured.has(v)) need.add(v);
    };
    for (const k of ACTION_TEXT_KEYS) use(s.action?.[k]);
    // A step's captures are read before its checks, so a check may use them.
    for (const c of s.capture ?? []) captured.add(c.var);
    for (const c of s.expect ?? []) use(c.value);
  }
  return [...need];
}

export type { Action };
