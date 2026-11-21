/**
 * Cached verified steps: run a recording that is known to work with no model
 * at all, and call a model (or a person, or any function) only at the step
 * where the screen is not what the recording expects. See docs/cached-steps.md.
 *
 *   const r = await runVerified(sap, "sap-tests/create-order.saptest.json", {
 *     variables: { customer: "2200" },
 *     fallback: async (drift) => askAgentForRepair(drift),   // only on drift
 *     save: true,                                            // keep the repaired version
 *   });
 *
 * The replay (record/replay.ts) does the work: the same guard as `sap_act`,
 * screens compared step by step, checks evaluated. On the first step that
 * drifts it stops; `fallback` gets that step, the screen as it is, and the
 * steps left, and answers with a repair (record/repair.ts: a few actions, or
 * a capture). The repair runs under the repair rules (no write the recording
 * does not have, no leaving the transaction, no invented values), the step is
 * judged by what the recording expected, and the replay goes on. Each repair
 * that works is written into a new version of the recording, so the next run
 * is model-free again.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseTest, type SapTest, serializeTest, type Step } from "../record/format.js";
import type { Phase, Repair } from "../record/repair.js";
import { replay, type ReplayResult, type StepResult } from "../record/replay.js";
import { registry } from "../runner/collect.js";
import { lockPathFor } from "./lock.js";
import type { Sap } from "./session.js";
import { Drift, type VerifySummary } from "./verify.js";

/** What the fallback is told when a step of a recording drifts (for code, see verify.ts `Drift`). */
export interface ReplayDrift {
  /** The recording as it stands now (with earlier repairs of this run written in). */
  test: SapTest;
  /** The step that drifted, from 1, in `test`. */
  step: number;
  /** That step as recorded. */
  recorded: Step;
  /** act: its control is not there; landing: it led elsewhere; check: a check failed. */
  phase: Phase;
  failures: string[];
  /** The screen now, compact, as an agent reads it. */
  screen: string;
  /** The steps after it, which the replay will run once this one is repaired. */
  remaining: Step[];
  /** How many repairs were already tried on this step in this run. */
  attempt: number;
  /** Variables at this point (inputs, defaults, what earlier steps captured). */
  variables: Record<string, string>;
}

export interface RunVerifiedOptions {
  variables?: Record<string, string>;
  /** Called only on drift; returns a repair for that step, or undefined to give up. */
  fallback?: (drift: ReplayDrift) => Promise<Repair | undefined> | Repair | undefined;
  /** At most this many repairs in one run (default 5), and 2 tries per step. */
  maxRepairs?: number;
  /** Write the repaired recording back: true for the file it was read from, or a path. Never with no repair. */
  save?: boolean | string;
  screens?: "strict" | "loose";
}

export interface RunVerifiedResult {
  passed: boolean;
  /** Each replay segment: the first from step 1, then one per repair. */
  runs: ReplayResult[];
  /** How many times `fallback` was called: 0 when the cache held. */
  fallbacks: number;
  /** The repairs that worked, in words. */
  changes: string[];
  /** The recording with every working repair written in, when there was one. */
  repaired?: SapTest;
  /** Where it was saved. */
  saved?: string;
  ms: number;
}

const failedStep = (r: ReplayResult): StepResult | undefined => r.steps.find((s) => s.outcome === "fail");

/** Code to run verified: a function, or a module's export (default "default"). Called as `fn(sap, params)`. */
export type VerifiedCode<P> = ((sap: Sap, params: P) => unknown) | { file: string; export?: string };

export interface RunVerifiedCodeOptions {
  /** The lock file. Default: next to `file` (`x.sap.ts` -> `x.sap.lock.json`); needed for a function. */
  lock?: string;
  /** The entry in the lock. Default: the export's name, else the function's, else "default". */
  key?: string;
  /** Called on drift that no repair saved in the lock fixes: a repair (record/repair.ts), or undefined to fail. */
  fallback?: (drift: Drift) => Promise<Repair | undefined> | Repair | undefined;
  /** At most this many fallback calls (default 5), 2 per action. */
  maxRepairs?: number;
  /** Write the lock when the run passes: what it saw, the repairs that worked. Default true. */
  save?: boolean;
  /** "write": compare nothing, only record (as `--update-locks`). Default "verify". */
  mode?: "verify" | "write";
}

export interface RunVerifiedCodeResult extends VerifySummary {
  passed: boolean;
  /** What the code returned. */
  value?: unknown;
  /** Why it failed. */
  error?: Error;
  /** The drift it failed on, if that is why. */
  drift?: Drift;
  ms: number;
}

/**
 * Imports a code file for its exports. A `*.sap.ts` file usually also declares runner tests (`test(...)` at its top
 * level), which throw outside a runner's collection: they are collected here into a scratch suite and dropped
 * (live 2026-11-21: `runVerified(sap, { file: "x.sap.ts", export })` failed on the file's own `test(...)`).
 */
async function importCode(file: string): Promise<Record<string, unknown>> {
  const r = registry();
  const was = { file: r.file, suite: r.suite, count: r.tests.length };
  if (!r.suite) {
    r.file = file;
    r.suite = { title: "", parent: undefined, mode: "skip", beforeEach: [], afterEach: [], use: {}, timeout: undefined };
  }
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } finally {
    if (!was.suite) {
      r.tests.length = was.count;
      r.file = was.file;
      r.suite = was.suite;
    }
  }
}

const isCode = (x: unknown): x is VerifiedCode<unknown> => typeof x === "function" || (typeof x === "object" && x !== null && "file" in x && !("format" in x));

/**
 * Runs a recording verified: the fallback is called only where the screen drifted from it.
 *
 * Or, with code (`fn` or `{ file, export }`), runs the code in verified mode
 * against its lock (sdk/verify.ts): the fallback is called inside the action
 * that drifted, its repair runs under the repair rules and, when the screen
 * is then what the lock holds, the code goes on. A repair that worked is
 * saved in the lock (applied with no model next time) and proposed as a
 * patch of the source; the source is never changed.
 */
export function runVerified(sap: Sap, recording: SapTest | string, options?: RunVerifiedOptions): Promise<RunVerifiedResult>;
export function runVerified<P>(sap: Sap, code: VerifiedCode<P>, params: P, options?: RunVerifiedCodeOptions): Promise<RunVerifiedCodeResult>;
export function runVerified(sap: Sap, what: unknown, a?: unknown, b?: unknown): Promise<RunVerifiedResult | RunVerifiedCodeResult> {
  if (isCode(what)) return runVerifiedCode(sap, what, a, (b ?? {}) as RunVerifiedCodeOptions);
  return runVerifiedRecording(sap, what as SapTest | string, (a ?? {}) as RunVerifiedOptions);
}

async function runVerifiedCode<P>(sap: Sap, code: VerifiedCode<P>, params: P, options: RunVerifiedCodeOptions): Promise<RunVerifiedCodeResult> {
  const t0 = Date.now();
  let fn: (sap: Sap, params: P) => unknown;
  let key = options.key;
  let lock = options.lock;
  if (typeof code === "function") {
    fn = code;
    key ??= code.name || "default";
    if (!lock) throw new Error("runVerified: a function needs options.lock, the lock file to verify it against.");
  } else {
    const file = resolve(code.file);
    const name = code.export ?? "default";
    const m = await importCode(file);
    const f = m[name];
    if (typeof f !== "function") throw new Error(`runVerified: ${file} has no function export "${name}".`);
    fn = f as typeof fn;
    key ??= name;
    lock ??= lockPathFor(file);
  }
  const variables = params && typeof params === "object" ? Object.fromEntries(Object.entries(params as Record<string, unknown>).filter(([, v]) => ["string", "number"].includes(typeof v)).map(([k, v]) => [k, String(v)])) : {};
  const previous = sap.lock;
  const verifier = await sap.useLock({
    lock,
    key,
    mode: options.mode ?? "verify",
    ...(options.fallback ? { fallback: options.fallback } : {}),
    ...(options.maxRepairs !== undefined ? { maxRepairs: options.maxRepairs } : {}),
    variables,
  });
  let value: unknown;
  let error: Error | undefined;
  try {
    value = await fn(sap, params);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  // A drift the code did not branch on, left at its end, is settled here.
  if (!error) await verifier?.settle().catch((e: unknown) => (error = e as Error));
  const passed = !error;
  const summary = verifier ? await verifier.finish(passed && options.save !== false) : undefined;
  // The session goes back to how it was.
  await sap.useLock(previous);
  return {
    ...(summary as VerifySummary),
    passed,
    ...(value !== undefined ? { value } : {}),
    ...(error ? { error } : {}),
    ...(error instanceof Drift ? { drift: error } : {}),
    ms: Date.now() - t0,
  };
}

async function runVerifiedRecording(sap: Sap, recording: SapTest | string, options: RunVerifiedOptions = {}): Promise<RunVerifiedResult> {

  const t0 = Date.now();
  const path = typeof recording === "string" ? recording : undefined;
  let test: SapTest = typeof recording === "string" ? parseTest(await readFile(recording, "utf8")) : structuredClone(recording);
  const driver = await sap.registry.driver(sap.sessionId);
  const base = { ...(options.screens ? { screens: options.screens } : {}), leaveOnFailure: false };
  const out: RunVerifiedResult = { passed: false, runs: [], fallbacks: 0, changes: [], ms: 0 };
  const max = options.maxRepairs ?? 5;
  const tries = new Map<number, number>();

  let r = await replay(driver, sap.policy, test, { ...base, ...(options.variables ? { variables: options.variables } : {}) });
  out.runs.push(r);
  for (;;) {
    if (r.passed || r.aborted) break;
    const bad = failedStep(r);
    // A refusal is the guard's answer, not drift: it is never repaired.
    if (!bad || bad.phase === "refused" || !options.fallback || out.fallbacks >= max) break;
    const attempt = tries.get(bad.n) ?? 0;
    if (attempt >= 2) break;
    tries.set(bad.n, attempt + 1);
    out.fallbacks++;
    const repair = await options.fallback({
      test,
      step: bad.n,
      recorded: test.steps[bad.n - 1] as Step,
      phase: bad.phase ?? "landing",
      failures: bad.failures,
      screen: r.screen ?? "",
      remaining: test.steps.slice(bad.n),
      attempt,
      variables: r.variables,
    });
    if (!repair) break;
    r = await replay(driver, sap.policy, test, { ...base, variables: r.variables, from: bad.n, repair });
    out.runs.push(r);
    if (r.proposal) {
      out.changes.push(...r.proposal.changes);
      // The rest of the run goes on in the repaired recording's numbering.
      const origin = r.proposal.origin;
      test = r.proposal.test;
      const next = failedStep(r);
      if (next) {
        // The first step of the new recording that comes from the failed one of the old.
        const at = origin.indexOf(next.n);
        if (at >= 0) r = { ...r, steps: r.steps.map((s) => (s === next ? { ...s, n: at + 1 } : s)) };
      }
      out.repaired = test;
    }
  }
  out.passed = r.passed;
  if (out.repaired && out.passed && options.save) {
    const target = typeof options.save === "string" ? options.save : path;
    if (target) {
      await writeFile(`${target}.tmp`, serializeTest(out.repaired), "utf8");
      await rename(`${target}.tmp`, target);
      out.saved = target;
    }
  }
  out.ms = Date.now() - t0;
  return out;
}
