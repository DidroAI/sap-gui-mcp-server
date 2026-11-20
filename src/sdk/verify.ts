/**
 * Verified mode: a `*.sap.ts` test run against its lock (lock.ts).
 *
 * Each action the code runs is matched to the lock by its `sap.step` (name
 * and ordinal) and its place in that step. After it runs, the screen it led
 * to is compared with what the lock holds, as a replay compares a recording
 * (record/replay.ts): program, dynpro and transaction strictly, a popup or
 * none, the title not at all, and no new error (E or A) in the status bar.
 * On a difference the action throws `Drift`, unless:
 *   1. a repair saved in the lock for this action (an overlay) brings the
 *      screen back to what the lock holds: no model;
 *   2. else `fallback(drift)` answers with a repair, run under the rules of
 *      record/repair.ts (at most 4 actions, no write the action does not
 *      make, no leaving the transaction, no value that is in neither the
 *      lock nor on the screen). If the screen then holds what the lock says,
 *      the action returns and the code goes on; the repair is saved as an
 *      overlay and a source patch is proposed. The .sap.ts is never changed.
 * An action the lock has no entry for (new code, a branch not seen yet) is
 * "unverified", not a failure: a passing run adds it to the lock.
 */
import { fileURLToPath } from "node:url";
import { normalizeAction, type NormalizedAction } from "../core/action.js";
import { tailHandle } from "../core/ids.js";
import type { Assessment, Driver, SessionInfo } from "../core/types.js";
import { FORMAT, type SapTest, type Step } from "../record/format.js";
import { MAX_REPAIR_ACTIONS, type Repair, repairRefusal, runRepairActions } from "../record/repair.js";
import { popupOf } from "../record/replay.js";
import { locate, type ParsedScreen, refOf } from "../record/screen.js";
import { codeOf } from "./code.js";
import { identity, type LockAction, type LockRef, type LockRepair, type LockStep, type LockTest, newError, readLock, refText, sameLanding, samePath, writeLockEntry } from "./lock.js";

/**
 * verify  compare each action with the lock; a passing run adds what the lock does not have yet (default);
 * write   compare nothing; a passing run adds its paths to the lock (`--update-locks`);
 * off     no lock.
 */
export type LockMode = "verify" | "write" | "off";

export type DriftPhase = "act" | "landing" | "check";

export interface VerifyOptions {
  /** The lock file. */
  lock: string;
  /** The test's entry in it. Default "default". */
  key?: string;
  mode?: LockMode;
  /** Called on drift that no saved repair fixes; answers a repair (record/repair.ts) or undefined to let the Drift be thrown. */
  fallback?: (drift: Drift) => Repair | undefined | Promise<Repair | undefined>;
  /** At most this many fallback calls in one run (default 5), and 2 per action. */
  maxRepairs?: number;
  /** Values the run was given: a repair may type them (it types nothing that is not in the lock, here or on the screen). */
  variables?: Record<string, string>;
}

/** What drifted, in a form that survives JSON (reporters, sap_code_test). */
export interface DriftInfo {
  step: string;
  ordinal: number;
  /** The action's place in its step, from 0. */
  actionIndex: number;
  phase: DriftPhase;
  /** The SDK line of the action. */
  code: string;
  /** Where the code ran it: file:line, when the stack says. */
  site?: string;
  expected: LockAction;
  actual: { after: LockRef; status?: { type?: string | undefined; text: string } | undefined };
  /** The screen now, compact, as an agent reads it. */
  screen: string;
  variables?: Record<string, string>;
  lock: string;
  /** Fallback calls made for this action before this one. */
  attempt: number;
  /** Repairs tried on this action, and why each did not do. */
  tried: string[];
}

const stepName = (s: string) => (s ? `"${s}"` : "(outside any sap.step)");

/** The screen drifted from the lock. Thrown by the action that drifted; also what `fallback` is given. */
export class Drift extends Error implements DriftInfo {
  override name = "Drift";
  step!: string;
  ordinal!: number;
  actionIndex!: number;
  phase!: DriftPhase;
  code!: string;
  site?: string;
  expected!: LockAction;
  actual!: DriftInfo["actual"];
  screen!: string;
  variables?: Record<string, string>;
  lock!: string;
  attempt!: number;
  tried!: string[];

  constructor(info: DriftInfo, cause?: string) {
    super(driftMessage(info, cause));
    Object.assign(this, info);
  }

  toJSON(): DriftInfo {
    const { name: _n, message: _m, stack: _s, ...rest } = this as unknown as DriftInfo & Error;
    return rest;
  }
}

function driftMessage(d: DriftInfo, cause?: string): string {
  const what =
    d.phase === "act"
      ? `the action could not run${cause ? `: ${cause}` : ""}`
      : d.phase === "landing"
        ? `it led to ${refText(d.actual.after)}`
        : `SAP answered with ${d.actual.status?.type ?? "?"}: ${d.actual.status?.text ?? ""}`;
  const where = `step ${stepName(d.step)}${d.ordinal > 1 ? ` (run ${d.ordinal})` : ""}, action ${d.actionIndex + 1} (${d.code}${d.site ? ` at ${d.site}` : ""})`;
  const tried = d.tried.length ? ` Tried: ${d.tried.join("; ")}.` : "";
  return `Drift in ${where}: ${what}. The lock ${d.lock} has ${refText(d.expected.after)}${d.expected.after.status?.type ? ` with status ${d.expected.after.status.type}` : ""}.${tried} If this screen is expected now (other data, a branch the lock has not seen), run with --update-locks (use: { lock: "write" }) to add it.`;
}

/** What the session gives the verifier: its raw action (guard, trace, history; no verification), and reads. */
export interface VerifyHost {
  perform(action: NormalizedAction, rated?: Assessment): Promise<Performed>;
  screen(): Promise<ParsedScreen>;
  look(): Promise<string>;
  driver(): Promise<Driver>;
}

export interface Performed {
  note: string;
  risk?: string | undefined;
  /** The screens around it, when the trace read them. */
  before?: ParsedScreen | undefined;
  after?: ParsedScreen | undefined;
}

/** A repair applied in this run. */
export interface AppliedRepair {
  step: string;
  ordinal: number;
  actionIndex: number;
  place: LockRepair["place"];
  why: string;
  /** lock: an overlay saved earlier (no model); fallback: new in this run. */
  by: "lock" | "fallback";
  did: string[];
}

export interface VerifySummary {
  lock: string;
  key: string;
  mode: LockMode;
  /** Actions compared with the lock and found as it says. */
  verified: number;
  /** Actions the lock had nothing for. */
  unverified: number;
  fallbacks: number;
  repairs: AppliedRepair[];
  /** For a person to put into the code (never applied). */
  patches: string[];
  /** Why the lock was not used or written, and the like. */
  notes: string[];
  /** The lock was written by `finish`. */
  written: boolean;
}

/** One run of a step block: the actions done in it and the lock's paths still consistent with them. */
interface Occurrence {
  name: string;
  ordinal: number;
  lockStep: LockStep | undefined;
  actions: LockAction[];
  /** Indexes of the lock's paths that every action so far matched. */
  cands: number[];
  /** No path holds the actions so far: nothing more is compared in this block. */
  unverified: boolean;
  newRepairs: LockRepair[];
}

interface Ctx {
  occ: Occurrence;
  index: number;
  id: string;
  action: NormalizedAction;
  code: string;
  site: string | undefined;
  cands: number[];
  risk: string | undefined;
  before: ParsedScreen | undefined;
  last?: Observation;
}

interface Observation {
  screen: ParsedScreen;
  ref: LockRef;
  status: { type?: string | undefined; text: string } | undefined;
}

const SDK_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The first frame of the stack outside the SDK: the line of the test that ran the action. */
export function callSite(stack = new Error().stack ?? ""): string | undefined {
  for (const line of stack.split("\n").slice(1)) {
    const m = /\(?((?:file:\/\/)?[^()\s]+:\d+):\d+\)?\s*$/.exec(line);
    if (!m?.[1]) continue;
    const at = m[1].replace(/^file:\/\//, "");
    if (at.startsWith(SDK_DIR) || at.startsWith("node:") || /\/node_modules\//.test(at) || at.includes("native")) continue;
    return at;
  }
  return undefined;
}

const popupRef = (s: ParsedScreen): LockRef => {
  const p = popupOf(s);
  return { ...refOf(s), ...(p ? { popup: p.id } : {}) };
};

export class Verifier {
  readonly key: string;
  readonly mode: LockMode;
  /** The test's entry as read; undefined when the lock has none. */
  private entry: LockTest | undefined;
  /** Compare actions with the lock. */
  private active: boolean;
  private writable = true;
  /** Write mode on another system: the entry is replaced, not merged. */
  private replace = false;
  private occurrences: Occurrence[] = [];
  private stack: Occurrence[] = [];
  private counts = new Map<string, number>();
  private last: LockAction | undefined;
  private summary: VerifySummary;

  private constructor(
    readonly options: VerifyOptions,
    private info: SessionInfo,
    entry: LockTest | undefined,
  ) {
    this.key = options.key ?? "default";
    this.mode = options.mode ?? "verify";
    this.entry = entry;
    this.summary = { lock: options.lock, key: this.key, mode: this.mode, verified: 0, unverified: 0, fallbacks: 0, repairs: [], patches: [], notes: [], written: false };
    this.active = this.mode === "verify" && !!entry;
    if (entry) {
      const v = entry.verified;
      const other = v.surface !== info.surface ? `surface ${v.surface}` : v.system && info.system && v.system.toUpperCase() !== info.system.toUpperCase() ? `system ${v.system}` : undefined;
      if (other) {
        this.active = false;
        if (this.mode === "write") this.replace = true;
        else {
          this.writable = false;
          this.summary.notes.push(`the lock's entry "${this.key}" was verified on ${other}; this session is ${info.surface} ${info.system ?? "?"}: not compared, not written (run with --update-locks to replace it)`);
        }
      }
    }
  }

  static async open(options: VerifyOptions, info: SessionInfo): Promise<Verifier> {
    const mode = options.mode ?? "verify";
    const lock = mode === "off" ? undefined : await readLock(options.lock);
    return new Verifier(options, info, lock?.tests[options.key ?? "default"]);
  }

  /** What this run did so far. */
  get result(): VerifySummary {
    return this.summary;
  }

  // ---- steps ----------------------------------------------------------------------

  private occurrence(name: string): Occurrence {
    const ordinal = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, ordinal);
    const lockStep = this.entry?.steps.find((s) => s.step === name && s.ordinal === ordinal);
    const occ: Occurrence = { name, ordinal, lockStep, actions: [], cands: lockStep ? lockStep.paths.map((_, i) => i) : [], unverified: !lockStep, newRepairs: [] };
    this.occurrences.push(occ);
    return occ;
  }

  /** `sap.step(name)` began (the full name, nested ones joined with " › "). */
  enter(name: string): void {
    this.stack.push(this.occurrence(name));
  }

  exit(): void {
    this.stack.pop();
  }

  private current(): Occurrence {
    const top = this.stack.at(-1);
    if (top) return top;
    // Actions outside any block: one implicit block, from the first such action on.
    const root = this.occurrences.find((o) => o.name === "" && o.ordinal === 1) ?? this.occurrence("");
    return root;
  }

  // ---- acting ---------------------------------------------------------------------

  /** Runs one action of the code, judged against the lock. */
  async act(action: NormalizedAction, host: VerifyHost, site?: string): Promise<string> {
    const occ = this.current();
    const index = occ.actions.length;
    const id = identity(action);
    const paths = occ.lockStep?.paths ?? [];
    let cands: number[] = [];
    if (this.active && !occ.unverified) {
      cands = occ.cands.filter((p) => {
        const e = paths[p]?.[index];
        return !!e && identity(e.action) === id;
      });
      if (!cands.length) occ.unverified = true;
    }
    const ctx: Ctx = { occ, index, id, action, code: codeOf(action), site, cands, risk: undefined, before: undefined };
    let obs: Observation;
    let done: Performed | undefined;
    try {
      done = await host.perform(action);
    } catch (e) {
      // The guard's no is policy, not drift; an action the lock does not know fails as it is.
      if (!cands.length || (e as Error).name === "Refused") throw e;
      obs = await this.recover(ctx, "act", host, (e as Error).message.split("\n")[0]);
      return this.done(ctx, obs, "(repaired)");
    }
    ctx.risk = done.risk;
    ctx.before = done.before;
    obs = await this.observe(host, done.after);
    ctx.last = obs;
    if (cands.length) {
      const bad = this.judge(ctx, obs);
      if (bad) obs = await this.recover(ctx, bad, host);
    }
    return this.done(ctx, obs, done.note);
  }

  private done(ctx: Ctx, obs: Observation, note: string): string {
    const { occ } = ctx;
    if (ctx.cands.length) {
      occ.cands = ctx.cands;
      this.summary.verified++;
    } else if (this.mode !== "off") {
      occ.unverified = true;
      this.summary.unverified++;
    }
    const { do: verb, ...rest } = ctx.action;
    const entry: LockAction = { action: { do: verb, ...rest }, after: { ...obs.ref, ...(obs.status ? { status: obs.status } : {}) } };
    const before = ctx.before;
    if (before) {
      const found = ctx.action.id ? locate(before, ctx.action.id) : undefined;
      if (found) {
        const handle = tailHandle(before.controls.map((c) => c.id), found.control.id);
        entry.target = { id: found.control.id, ...(handle ? { handle } : {}), ...(found.control.type ? { type: found.control.type } : {}), ...(found.control.label ? { label: found.control.label } : {}) };
      }
      entry.on = popupRef(before);
    }
    const risk = ctx.risk ?? this.expected(ctx)?.risk;
    if (risk) entry.risk = risk;
    // Keys in a fixed order: the file is read by people and diffed.
    occ.actions.push({ action: entry.action, ...(entry.target ? { target: entry.target } : {}), ...(entry.risk ? { risk: entry.risk } : {}), ...(entry.on ? { on: entry.on } : {}), after: entry.after });
    this.last = entry;
    return note;
  }

  private async observe(host: VerifyHost, after?: ParsedScreen): Promise<Observation> {
    const screen = after ?? (await host.screen());
    return { screen, ref: popupRef(screen), status: screen.status ? { ...(screen.status.type ? { type: screen.status.type } : {}), text: screen.status.text } : undefined };
  }

  private expected(ctx: Ctx): LockAction | undefined {
    const p = ctx.cands[0];
    return p === undefined ? undefined : ctx.occ.lockStep?.paths[p]?.[ctx.index];
  }

  /** Narrows the candidates to the paths the screen agrees with; the phase of the difference when none does. */
  private judge(ctx: Ctx, obs: Observation): DriftPhase | undefined {
    const paths = ctx.occ.lockStep?.paths ?? [];
    const at = (p: number) => paths[p]?.[ctx.index] as LockAction;
    const ok = ctx.cands.filter((p) => sameLanding(at(p).after, obs.ref) && !newError(at(p).after, obs.status?.type));
    if (ok.length) {
      ctx.cands = ok;
      return undefined;
    }
    return ctx.cands.some((p) => sameLanding(at(p).after, obs.ref)) ? "check" : "landing";
  }

  // ---- drift and repair -----------------------------------------------------------

  /** Overlays first, then the fallback; the screen as the lock has it, or a thrown Drift. */
  private async recover(ctx: Ctx, phase: DriftPhase, host: VerifyHost, cause?: string): Promise<Observation> {
    const tried: string[] = [];
    let now = phase;
    const fits = (place: LockRepair["place"]) => (now === "act" ? place !== "after" : place === "after");
    for (const o of ctx.occ.lockStep?.repairs ?? []) {
      if (o.index !== ctx.index || o.on !== ctx.id || !fits(o.place)) continue;
      const r = await this.tryRepair(ctx, now, { why: o.why, actions: o.actions, place: o.place }, host);
      if (r.ok) {
        this.summary.repairs.push({ step: ctx.occ.name, ordinal: ctx.occ.ordinal, actionIndex: ctx.index, place: o.place, why: o.why, by: "lock", did: r.did });
        return r.obs;
      }
      tried.push(`the repair saved in the lock ("${o.why}"): ${r.problem}`);
      if (r.phase) now = r.phase;
    }
    const fallback = this.options.fallback;
    const max = this.options.maxRepairs ?? 5;
    for (let attempt = 0; fallback && attempt < 2 && this.summary.fallbacks < max; attempt++) {
      const drift = await this.drift(ctx, now, host, attempt, tried, cause);
      this.summary.fallbacks++;
      const repair = await fallback(drift);
      if (!repair) return this.fail(drift, tried);
      const r = await this.tryRepair(ctx, now, repair, host);
      if (r.ok) {
        const place = repair.place as LockRepair["place"];
        const actions = (repair.actions ?? []).map((a) => {
          const { do: verb, ...rest } = normalizeAction(a);
          return { do: verb, ...rest };
        });
        ctx.occ.newRepairs.push({ index: ctx.index, on: ctx.id, place, actions, why: repair.why, at: new Date().toISOString() });
        this.summary.repairs.push({ step: ctx.occ.name, ordinal: ctx.occ.ordinal, actionIndex: ctx.index, place, why: repair.why, by: "fallback", did: r.did });
        this.summary.patches.push(patchText(ctx, place, actions, repair.why));
        return r.obs;
      }
      tried.push(`repair "${repair.why}": ${r.problem}`);
      if (r.phase) now = r.phase;
    }
    throw await this.drift(ctx, now, host, 0, tried, cause);
  }

  private fail(drift: Drift, tried: string[]): never {
    drift.tried = tried;
    throw drift;
  }

  private async drift(ctx: Ctx, phase: DriftPhase, host: VerifyHost, attempt: number, tried: string[], cause?: string): Promise<Drift> {
    const obs = phase === "act" || !ctx.last ? await this.observe(host).catch(() => undefined) : ctx.last;
    const screen = await host.look().catch(() => "");
    const expected = this.expected(ctx) as LockAction;
    return new Drift(
      {
        step: ctx.occ.name,
        ordinal: ctx.occ.ordinal,
        actionIndex: ctx.index,
        phase,
        code: ctx.code,
        ...(ctx.site ? { site: ctx.site } : {}),
        expected,
        actual: { after: obs?.ref ?? {}, status: obs?.status },
        screen,
        ...(this.options.variables ? { variables: this.options.variables } : {}),
        lock: this.options.lock,
        attempt,
        tried: [...tried],
      },
      cause,
    );
  }

  /** The action as a recorded step, for the repair rules. */
  private stepOf(ctx: Ctx): Step {
    const e = this.expected(ctx);
    const risk = ctx.risk ?? e?.risk;
    return { action: { ...ctx.action }, ...(risk ? { risk } : {}), ...(e?.on ? { on: e.on } : {}), ...(e ? { after: e.after } : {}) };
  }

  /** The lock and this run as a recording: what "no invented data" compares typed values with. */
  private known(): SapTest {
    const steps: Step[] = [];
    const add = (a: LockAction) => steps.push({ action: a.action, ...(a.risk ? { risk: a.risk } : {}) });
    for (const s of this.entry?.steps ?? []) for (const p of s.paths) p.forEach(add);
    for (const o of this.occurrences) o.actions.forEach(add);
    return { format: FORMAT, name: this.key, recorded: { at: "", surface: this.info.surface }, start: {}, variables: {}, steps };
  }

  private async tryRepair(ctx: Ctx, phase: DriftPhase, repair: Repair, host: VerifyHost): Promise<{ ok: true; obs: Observation; did: string[] } | { ok: false; problem: string; phase?: DriftPhase }> {
    const no = (problem: string, p?: DriftPhase) => ({ ok: false as const, problem, ...(p ? { phase: p } : {}) });
    if (repair.capture) return no("a capture is written in the code: const n = await expect(sap.status()).capture(/.../)");
    if ((repair.actions?.length ?? 0) > MAX_REPAIR_ACTIONS) return no(`a repair is at most ${MAX_REPAIR_ACTIONS} actions`);
    if (phase === "act" && repair.place === "after") return no('the action did not run: a repair is "before" (then it runs) or "instead"');
    if (phase !== "act" && repair.place !== "after") return no('the action already ran: a repair of where it led is "after"');
    const step = this.stepOf(ctx);
    const test = this.known();
    const refused = repairRefusal(step, repair, test);
    if (refused) return no(`refused: ${refused}`);
    const driver = await host.driver();
    const vars = { ...(this.options.variables ?? {}) };
    const previous: Step | undefined = this.last ? { action: this.last.action, ...(this.last.risk ? { risk: this.last.risk } : {}) } : undefined;
    let did: string[];
    try {
      const screen = await host.screen();
      const run = await runRepairActions(driver, test, step, repair, vars, screen, async (a, rated) => (await host.perform(a, rated)).note, () => host.screen(), previous);
      did = run.did;
    } catch (e) {
      return no(`${(e as Error).name === "RepairRefused" ? "refused: " : ""}${(e as Error).message.split("\n")[0]}`);
    }
    let obs: Observation;
    if (phase === "act" && repair.place === "before") {
      try {
        const d = await host.perform(ctx.action);
        ctx.risk = d.risk;
        ctx.before = d.before;
        obs = await this.observe(host, d.after);
      } catch (e) {
        return no(`the action still did not run: ${(e as Error).message.split("\n")[0]}`, "act");
      }
    } else obs = await this.observe(host);
    ctx.last = obs;
    const bad = this.judge(ctx, obs);
    if (bad) return no(`after it the screen is ${refText(obs.ref)}${obs.status?.type ? ` with ${obs.status.type}: ${obs.status.text}` : ""}`, bad);
    return { ok: true, obs, did };
  }

  // ---- writing ----------------------------------------------------------------------

  /** At the end of the run: when it passed, the lock gets what this run saw (and the repairs that worked). */
  async finish(passed: boolean): Promise<VerifySummary> {
    if (!passed || this.mode === "off" || !this.writable || this.summary.written) return this.summary;
    const now = new Date().toISOString();
    const base: LockTest = this.entry && !this.replace ? structuredClone(this.entry) : { verified: { at: now, surface: this.info.surface, runs: 0, lastPass: now }, steps: [] };
    for (const o of this.occurrences) {
      if (!o.actions.length && !o.newRepairs.length) continue;
      let s = base.steps.find((x) => x.step === o.name && x.ordinal === o.ordinal);
      if (!s) {
        s = { step: o.name, ordinal: o.ordinal, paths: [] };
        base.steps.push(s);
      }
      if (o.actions.length && !s.paths.some((p) => samePath(p, o.actions))) s.paths.push(o.actions);
      if (o.newRepairs.length) s.repairs = [...(s.repairs ?? []), ...o.newRepairs];
    }
    base.verified = {
      at: base.verified.at,
      ...(this.info.system ? { system: this.info.system } : {}),
      ...(this.info.client ? { client: this.info.client } : {}),
      surface: this.info.surface,
      runs: base.verified.runs + 1,
      lastPass: now,
    };
    await writeLockEntry(this.options.lock, this.key, base);
    this.summary.written = true;
    return this.summary;
  }
}

/** "In step "Save", after action 2 (await sap.key("Enter"); at create.sap.ts:14): await sap.press("wnd[1]/usr/btnSPOP-OPTION1");" */
export function patchText(ctx: { occ: { name: string; ordinal: number }; index: number; code: string; site?: string | undefined }, place: LockRepair["place"], actions: Record<string, unknown>[], why: string): string {
  const lines = actions.map((a) => `  ${codeOf(normalizeAction(a))}`);
  const at = `action ${ctx.index + 1} (${ctx.code}${ctx.site ? ` at ${ctx.site}` : ""})`;
  const verb = place === "instead" ? `replace ${at} with` : `${place} ${at} add`;
  return `In step ${stepName(ctx.occ.name)}${ctx.occ.ordinal > 1 ? ` (run ${ctx.occ.ordinal})` : ""}, ${verb}:\n${lines.join("\n")}\n  // ${why}${place === "after" ? " (SAP shows this for some data only? wrap it: if (await sap.popup()) { ... })" : ""}`;
}
