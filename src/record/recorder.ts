/**
 * Records a session as a test while an agent drives it.
 *
 * The server calls `act` around every action it runs. While a recording is
 * on, each action that worked becomes a step: the action, the control it
 * was done on, the screen before, and the screen and status bar after. An
 * action that failed or was refused is not a step. The agent marks checks,
 * captures and variables with the other methods; each is tried on the
 * screen as it is, and refused if it does not hold there.
 *
 * The file is written after every change, so a recording survives a crash.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedAction } from "../core/action.js";
import type { Driver, SessionInfo } from "../core/types.js";
import { captureValue, evaluate } from "./checks.js";
import { type Capture, type Check, FILE_SUFFIX, FORMAT, type Op, parametriseStep, parseTest, type SapTest, serializeTest, slug, type Step, type Subject, withVariable } from "./format.js";
import { locate, type ParsedScreen, readSettled, refOf } from "./screen.js";

export interface RecorderOptions {
  /** Where recordings are written and read (SAP_RECORD_DIR). */
  dir: string;
  /** Record from the first action on, without `start` (SAP_RECORD=on). */
  auto: boolean;
  /** "sap-gui-mcp-server 0.1.0", written into the file. */
  by: string;
  now?: () => Date;
}

type Env = Record<string, string | undefined>;

export function recorderOptionsFromEnv(env: Env, by: string, cwd = process.cwd()): RecorderOptions {
  const mode = (env.SAP_RECORD ?? "off").toLowerCase();
  if (mode !== "off" && mode !== "on") throw new Error(`SAP_RECORD must be off or on (got "${env.SAP_RECORD}")`);
  return { dir: env.SAP_RECORD_DIR || join(cwd, "sap-tests"), auto: mode === "on", by };
}

export interface AssertInput {
  check: Subject;
  id?: string | undefined;
  equals?: string | undefined;
  contains?: string | undefined;
  matches?: string | undefined;
}

export interface CaptureInput {
  name: string;
  from: "status" | "field" | "title";
  id?: string | undefined;
  pattern?: string | undefined;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOME = new Set(["SESSION_MANAGER", "SMEN", "S000"]);

/** The screen as it is, once the step before it is over: never one from before that step. */
async function screenOf(driver: Driver): Promise<ParsedScreen> {
  return readSettled(() => driver.look({ compact: false }));
}

/** One line per step, for the agent to read back what it recorded. */
export function stepLine(s: Step, i: number): string {
  const a = s.action ? JSON.stringify(s.action) : "(check only)";
  const t = s.target?.label ? `  on ${s.target.type ?? "control"} "${s.target.label}"` : "";
  const st = s.after?.status ? `  -> status ${s.after.status.type ? `${s.after.status.type}: ` : ""}${s.after.status.text}` : "";
  const sc = s.after?.program ? `  -> ${s.after.transaction ?? ""} ${s.after.program}/${s.after.screen ?? ""}` : "";
  const more = [
    ...(s.expect ?? []).map((c) => `     expect ${c.check}${c.id ? ` ${c.id}` : ""} ${c.op} "${c.value}"`),
    ...(s.capture ?? []).map((c) => `     capture \${${c.var}} from ${c.from}${c.id ? ` ${c.id}` : ""}${c.pattern ? ` /${c.pattern}/` : ""}`),
    ...(s.note ? [`     note: ${s.note}`] : []),
  ];
  return [`${i + 1}. ${a}${t}${sc}${st}${s.risk === "commit" ? "  [writes]" : ""}`, ...more].join("\n");
}

/** What a finished recording probably still needs: values to make variables, documents to capture. */
export function hints(t: SapTest): string[] {
  const out: string[] = [];
  const known = new Set(Object.values(t.variables).map((v) => v.value));
  const typed = new Map<string, string>();
  t.steps.forEach((s) => {
    const v = s.action?.do === "set" && typeof s.action.value === "string" ? s.action.value : "";
    if (v && !v.includes("${") && !known.has(v) && !typed.has(v)) typed.set(v, s.target?.label || String(s.action?.id ?? ""));
  });
  if (typed.size)
    out.push(`Typed values that are fixed in the test: ${[...typed].map(([v, l]) => `"${v}" (${l})`).join(", ")}. Make one a variable with {"op":"variable","name":"...","value":"..."} if it changes from run to run.`);
  t.steps.forEach((s, i) => {
    const text = s.after?.status?.text ?? "";
    for (const m of text.matchAll(/\b\d{5,}\b/g)) {
      const n = m[0];
      const later = t.steps.slice(i + 1).some((x) => JSON.stringify(x.action ?? {}).includes(n) || (x.expect ?? []).some((c) => c.value.includes(n)));
      if (later && !(s.capture ?? []).length) out.push(`Step ${i + 1}'s status bar holds ${n}, which later steps use: it looks like a document this step created. Record it again with a capture after that step, or the test will reuse ${n}.`);
    }
  });
  if (t.steps.length && !t.steps.some((s) => s.expect?.length)) out.push("No check was marked: the replay will only verify that each action runs, lands on the same screen and raises no error.");
  const first = t.steps[0]?.action;
  if (first && !(first.do === "okcode" && /^\/n\S/i.test(String(first.value ?? ""))) && !t.start.transaction)
    out.push("The recording does not start with an okcode such as /nVA03, and the start screen has no transaction: the replay cannot make a clean start.");
  return out;
}

export class Recorder {
  private test: SapTest | undefined;
  private sessionId: string | undefined;
  private path: string | undefined;
  /** Actions on other sessions that were not recorded. */
  private skipped = 0;

  constructor(readonly options: RecorderOptions) {}

  get recording(): boolean {
    return !!this.test;
  }

  get file(): string | undefined {
    return this.path;
  }

  /** The path of a recording by name, always inside the recordings directory. */
  pathOf(name: string): string {
    return join(this.options.dir, `${slug(name.replace(/\.saptest\.json$/i, ""))}${FILE_SUFFIX}`);
  }

  async load(name: string): Promise<SapTest> {
    const p = this.pathOf(name);
    let text: string;
    try {
      text = await readFile(p, "utf8");
    } catch {
      throw new Error(`No recording "${name}" in ${this.options.dir} (looked for ${p}).`);
    }
    return parseTest(text);
  }

  private async save(): Promise<void> {
    if (!this.test || !this.path) return;
    await mkdir(this.options.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, serializeTest(this.test), "utf8");
    await rename(tmp, this.path);
  }

  private need(): SapTest {
    if (!this.test) throw new Error('No recording is on. Start one with {"op":"start","name":"..."}.');
    return this.test;
  }

  private vars(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.test?.variables ?? {}).map(([k, v]) => [k, v.value]));
  }

  async start(driver: Driver, info: SessionInfo, name: string, description?: string, replace = false): Promise<string> {
    if (this.test) throw new Error(`A recording is already on ("${this.test.name}", ${this.test.steps.length} steps). Stop it first with {"op":"stop"}.`);
    const path = this.pathOf(name);
    if (!replace && (await readFile(path, "utf8").then(() => true, () => false))) throw new Error(`${path} exists. Choose another name, or pass replace=true to record over it.`);
    const screen = await screenOf(driver);
    if (screen.logon) throw new Error("The session is on the logon screen: log on first.");
    this.test = {
      format: FORMAT,
      name,
      ...(description ? { description } : {}),
      recorded: {
        at: (this.options.now?.() ?? new Date()).toISOString(),
        by: this.options.by,
        surface: info.surface,
        ...(info.system ? { system: info.system } : {}),
        ...(info.client ? { client: info.client } : {}),
      },
      start: refOf(screen),
      variables: {},
      steps: [],
    };
    this.sessionId = info.id;
    this.path = path;
    this.skipped = 0;
    await this.save();
    const t = screen.transaction;
    const clean = !t || HOME.has(t.toUpperCase()) ? `Begin with {"do":"okcode","value":"/n<transaction>"} so the replay starts clean.` : `The session is in ${t}: if the first step is not an okcode, the replay will start with /n${t}. Begin with {"do":"okcode","value":"/n<transaction>"} so the test does not depend on that.`;
    return `Recording "${name}" on ${info.surface} ${info.system ?? "?"}${info.client ? `/${info.client}` : ""}, to ${path}. Every sap_act that works is now a step. ${clean}`;
  }

  /** Runs an action through `run` and, when a recording is on for this session, records it as a step. */
  async act(driver: Driver, action: NormalizedAction, risk: string | undefined, run: () => Promise<string>): Promise<string> {
    if (!this.test && this.options.auto) {
      const stamp = (this.options.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").slice(0, 15);
      await this.start(driver, driver.info, `session ${stamp}`, undefined, true).catch(() => {});
    }
    const test = this.test;
    if (!test) return run();
    if (driver.info.id !== this.sessionId) {
      this.skipped++;
      return run();
    }
    // Recording must never break the action: a screen that cannot be read leaves gaps, not errors.
    const before = await screenOf(driver).catch(() => undefined);
    const note = await run();
    const after = await screenOf(driver).catch(() => undefined);
    // "do" first: the file is read by people.
    const { do: verb, ...rest } = action;
    const step: Step = { action: { do: verb, ...rest } };
    const found = before && action.id ? locate(before, action.id) : undefined;
    if (found) step.target = { id: found.control.id, type: found.control.type, ...(found.control.label ? { label: found.control.label } : {}) };
    if (risk) step.risk = risk;
    if (before) step.on = refOf(before);
    if (after) step.after = { ...refOf(after), ...(after.status ? { status: after.status } : {}) };
    for (const [name, v] of Object.entries(test.variables)) parametriseStep(step, name, v.value);
    test.steps.push(step);
    await this.save().catch(() => {});
    return note;
  }

  /** The last step, or a new step without an action when nothing was recorded yet. */
  private lastStep(screen: ParsedScreen): { step: Step; index: number } {
    const test = this.need();
    if (!test.steps.length) test.steps.push({ on: refOf(screen), after: { ...refOf(screen), ...(screen.status ? { status: screen.status } : {}) } });
    const index = test.steps.length - 1;
    return { step: test.steps[index] as Step, index };
  }

  async assert(driver: Driver, input: AssertInput): Promise<string> {
    const test = this.need();
    const screen = await screenOf(driver);
    const given = (["equals", "contains", "matches"] as Op[]).filter((op) => input[op] !== undefined);
    if (given.length > 1) throw new Error("Give one of equals, contains or matches.");
    const c: Check = { check: input.check, op: given[0] ?? "equals", value: given[0] ? String(input[given[0]]) : "" };
    if (input.check === "field") {
      if (!input.id) throw new Error('A field check needs "id", the control\'s id from sap_look.');
      const found = locate(screen, input.id);
      if (!found) throw new Error(`No control ${input.id} on this screen. Take the id from sap_look.`);
      c.id = found.control.id;
      c.type = found.control.type;
      if (found.control.label) c.label = found.control.label;
      // "This field, as it is now."
      if (!given.length) c.value = found.control.value;
    } else if (!given.length) {
      if (input.check === "text") throw new Error('A text check needs "contains" or "matches".');
      c.value = (input.check === "status" ? screen.status?.text : input.check === "title" ? screen.title : screen.transaction) ?? "";
      if (!c.value) throw new Error(`There is no ${input.check} on this screen to check.`);
    }
    if (c.op !== "matches") for (const [name, v] of Object.entries(test.variables)) c.value = withVariable(c.value, name, v.value);
    const v = evaluate(screen, c, this.vars());
    if (!v.ok) throw new Error(`Not recorded: this check does not hold on the screen now: ${v.text}.`);
    const { step, index } = this.lastStep(screen);
    (step.expect ??= []).push(c);
    await this.save();
    return `Check added to step ${index + 1}: ${v.text}.`;
  }

  async capture(driver: Driver, input: CaptureInput): Promise<string> {
    const test = this.need();
    if (!NAME.test(input.name)) throw new Error("A variable name is letters, digits and _, not starting with a digit.");
    const screen = await screenOf(driver);
    const c: Capture = { var: input.name, from: input.from, ...(input.pattern ? { pattern: input.pattern } : {}) };
    if (input.from === "field") {
      if (!input.id) throw new Error('A capture from a field needs "id".');
      const found = locate(screen, input.id);
      if (!found) throw new Error(`No control ${input.id} on this screen.`);
      c.id = found.control.id;
      if (found.control.label) c.label = found.control.label;
    }
    const got = captureValue(screen, c);
    if ("error" in got) throw new Error(`Not recorded: ${got.error}.`);
    const { step, index } = this.lastStep(screen);
    (step.capture ??= []).push(c);
    test.variables[input.name] = { value: got.value, description: `read from the ${input.from === "field" ? `field ${c.label ?? c.id}` : input.from === "status" ? "status bar" : "window title"} after step ${index + 1}` };
    // The step that produced the value still types what it typed; what it shows is the variable.
    parametriseStep(step, input.name, got.value, { actions: false });
    await this.save();
    return `\${${input.name}} = "${got.value}", read after step ${index + 1} at every replay. Later steps that use "${got.value}" will use the variable.`;
  }

  async variable(name: string, value: string, description?: string): Promise<string> {
    const test = this.need();
    if (!NAME.test(name)) throw new Error("A variable name is letters, digits and _, not starting with a digit.");
    if (!value) throw new Error("A variable needs the value it has in this recording.");
    test.variables[name] = { value, ...(description ? { description } : {}) };
    const before = JSON.stringify(test.steps);
    for (const s of test.steps) parametriseStep(s, name, value);
    const changed = test.steps.filter((s, i) => JSON.stringify(s) !== JSON.stringify((JSON.parse(before) as Step[])[i])).length;
    await this.save();
    return `\${${name}} = "${value}" by default; ${changed} recorded step(s) now use it, and so will later ones. A replay can give another value.`;
  }

  async note(text: string): Promise<string> {
    const test = this.need();
    const step = test.steps.at(-1);
    if (!step) throw new Error("There is no step yet to put a note on.");
    step.note = text;
    await this.save();
    return `Note put on step ${test.steps.length}.`;
  }

  /** Drops the last step from the recording. SAP is not touched: what the step did there stays done. */
  async undo(): Promise<string> {
    const test = this.need();
    const dropped = test.steps.pop();
    if (!dropped) throw new Error("There is no step to drop.");
    for (const c of dropped.capture ?? []) delete test.variables[c.var];
    await this.save();
    return `Dropped step ${test.steps.length + 1} from the recording (${dropped.action ? JSON.stringify(dropped.action) : "check only"}). SAP was not touched: the screen is where that step left it.`;
  }

  status(): string {
    const t = this.test;
    if (!t) return `No recording is on. Recordings are kept in ${this.options.dir}.`;
    const vars = Object.entries(t.variables).map(([k, v]) => `\${${k}} = "${v.value}"`);
    return [
      `Recording "${t.name}" (${t.steps.length} steps) to ${this.path}`,
      ...(vars.length ? [`Variables: ${vars.join(", ")}`] : []),
      ...t.steps.map(stepLine),
      ...(this.skipped ? [`${this.skipped} action(s) on other sessions were not recorded.`] : []),
    ].join("\n");
  }

  async stop(): Promise<{ test: SapTest; path: string; text: string }> {
    const test = this.need();
    const path = this.path as string;
    await this.save();
    const summary = this.status().replace(/^Recording/, "Recorded");
    this.test = undefined;
    this.sessionId = undefined;
    const h = hints(test);
    return { test, path, text: [summary, ...(h.length ? ["", ...h.map((x) => `Hint: ${x}`)] : []), "", `Replay it with sap_replay {"name":"${test.name}"}, or: sap-gui-mcp-server replay ${path}`].join("\n") };
  }
}
