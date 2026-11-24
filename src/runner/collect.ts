/**
 * What a test file calls: `test`, `test.describe`, `test.skip`, `test.only`,
 * `test.beforeEach`, `test.afterEach`, `test.use`, `test.setTimeout`.
 *
 *   import { expect, test } from "sap-ui-automation/test";
 *   test.describe("sales orders", () => {
 *     test.beforeEach(async ({ sap }) => { await sap.okcode("/nVA03"); });
 *     test("shows an order", async ({ sap }) => {
 *       await sap.set("VBAK-VBELN", "4711");
 *       await sap.key("Enter");
 *       await expect(sap.field("VBAK-NETWR")).toHaveValue("100.00");
 *     });
 *   });
 *
 * Importing a test file only declares its tests; the runner runs them after.
 * The declarations go to one registry on `globalThis`, not in this module:
 * a test file may load another copy of this module than the runner's (a
 * global `sap-ui-automation` running a project's local install), and both
 * must fill the same list.
 */
import type { Sap } from "../sdk/session.js";
import type { UseOptions } from "./config.js";

/** About the test that runs: the `info` fixture, also `test.info()`. */
export interface TestInfo {
  title: string;
  /** Describe titles, then the test's. */
  titlePath: string[];
  file: string;
  project: string | undefined;
  /** 0 on the first run, 1 on the first retry... */
  retry: number;
  /** This run's own directory: its trace is written there. */
  outputDir: string;
  timeout: number;
}

export interface Fixtures {
  /** The session the test drives, connected from the config's `use`; closed after the test. */
  sap: Sap;
  info: TestInfo;
}

export type TestFn = (fixtures: Fixtures) => unknown | Promise<unknown>;
export type HookFn = TestFn;

/** Options of one test: `test("name", { timeout: 120_000, use: { write: "on" } }, async ({ sap }) => ...)`. */
export interface TestDetails {
  timeout?: number;
  use?: UseOptions;
}

type Mode = "run" | "skip" | "only";

export interface Suite {
  title: string;
  parent: Suite | undefined;
  mode: Mode;
  beforeEach: HookFn[];
  afterEach: HookFn[];
  use: UseOptions;
  timeout: number | undefined;
}

export interface TestCase {
  title: string;
  file: string;
  suite: Suite;
  fn: TestFn;
  mode: Mode;
  details: TestDetails;
}

/** The test that runs now, so `test.setTimeout` and `test.info` reach it. */
interface Running {
  info: TestInfo;
  setTimeout(ms: number): void;
}

interface Registry {
  file: string | undefined;
  suite: Suite | undefined;
  tests: TestCase[];
  running: Running | undefined;
}

const KEY = Symbol.for("sap-ui-automation/test-registry");

export function registry(): Registry {
  const g = globalThis as { [KEY]?: Registry };
  g[KEY] ??= { file: undefined, suite: undefined, tests: [], running: undefined };
  return g[KEY];
}

const newSuite = (title: string, parent: Suite | undefined, mode: Mode): Suite => ({ title, parent, mode, beforeEach: [], afterEach: [], use: {}, timeout: undefined });

/** Starts collecting the tests of one file. */
export function beginFile(file: string): void {
  const r = registry();
  r.file = file;
  r.suite = newSuite("", undefined, "run");
}

export function endFile(): void {
  const r = registry();
  r.file = undefined;
  r.suite = undefined;
}

function current(): Suite {
  const s = registry().suite;
  if (!s) throw new Error("test() declares a test for the runner: run the file with `sap-ui-automation test`.");
  return s;
}

/** Thrown by `test.skip()` inside a test. Marked by name, not class: it may come from another copy of this module. */
export class SkipSignal extends Error {
  override name = "SkipSignal";
}
export const isSkip = (e: unknown) => e instanceof Error && e.name === "SkipSignal";

/** The suites a test is in, outermost first. */
export function suitesOf(t: TestCase): Suite[] {
  const out: Suite[] = [];
  for (let s: Suite | undefined = t.suite; s; s = s.parent) out.unshift(s);
  return out;
}

export function titlePath(t: TestCase): string[] {
  return [...suitesOf(t).map((s) => s.title).filter(Boolean), t.title];
}

function declare(mode: Mode) {
  return (title: string, a: TestDetails | TestFn, b?: TestFn): void => {
    const [details, fn] = typeof a === "function" ? [{}, a] : [a, b];
    if (typeof fn !== "function") throw new Error(`test("${title}"): the test needs a function`);
    const r = registry();
    r.tests.push({ title, file: r.file as string, suite: current(), fn, mode, details });
  };
}

function describe(mode: Mode) {
  return (title: string, body: () => void): void => {
    const r = registry();
    const parent = current();
    r.suite = newSuite(title, parent, mode);
    try {
      body();
    } finally {
      r.suite = parent;
    }
  };
}

/**
 * `test.skip("name", fn)` declares a skipped test. Inside a test,
 * `test.skip()` or `test.skip(condition, reason)` stops it as skipped; in a
 * describe body, `test.skip(condition)` skips the group.
 */
function skip(title: string, a: TestDetails | TestFn, b?: TestFn): void;
function skip(condition?: boolean, reason?: string): void;
function skip(a?: string | boolean, b?: TestDetails | TestFn | string, c?: TestFn): void {
  if (typeof a === "string" && b !== undefined && typeof b !== "string") return declare("skip")(a, b, c);
  const yes = a === undefined || a === true || (typeof a === "string" && b === undefined);
  if (!yes) return;
  const reason = typeof b === "string" ? b : typeof a === "string" ? a : "skipped";
  if (registry().running) throw new SkipSignal(reason);
  current().mode = "skip";
}

export const test = Object.assign(declare("run"), {
  only: declare("only"),
  skip,
  describe: Object.assign(describe("run"), { only: describe("only"), skip: describe("skip") }),
  /** Runs before each test of this file or describe, with the test's fixtures. */
  beforeEach(fn: HookFn): void {
    current().beforeEach.push(fn);
  },
  /** Runs after each test of this file or describe, even a failed one. */
  afterEach(fn: HookFn): void {
    current().afterEach.push(fn);
  },
  /** Connect options for the tests of this file or describe, over the config's. */
  use(options: UseOptions): void {
    Object.assign(current().use, options);
  },
  /** Inside a test: its timeout from now on. Elsewhere: the timeout of this file's or describe's tests. */
  setTimeout(ms: number): void {
    const run = registry().running;
    if (run) run.setTimeout(ms);
    else current().timeout = ms;
  },
  /** The running test's info. */
  info(): TestInfo {
    const run = registry().running;
    if (!run) throw new Error("test.info() works inside a test only.");
    return run.info;
  },
});
