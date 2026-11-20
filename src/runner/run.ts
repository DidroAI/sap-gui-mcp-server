/**
 * Runs the tests: finds the files, imports them (which declares the tests),
 * then runs each test once per project, one after the other.
 *
 * Each run of a test gets its own `sap` from `connect()`, with a trace in
 * `<outputDir>/<test>/`, and lets it go after (the SAP session stays open).
 * A failing test runs again up to `retries` times; one that then passes is
 * flaky. A test that runs past its timeout fails, but the SAP action in
 * progress cannot be aborted: it may still finish in SAP, so the afterEach
 * hooks are skipped (they would act while it runs) and the next test may
 * find SAP still busy.
 */
import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Surface } from "../core/types.js";
import { slug } from "../record/format.js";
import { connect, type Sap } from "../sdk/session.js";
import { beginFile, endFile, isSkip, registry, suitesOf, type TestCase, type TestInfo, titlePath } from "./collect.js";
import type { ProjectConfig, ResolvedConfig, UseOptions } from "./config.js";

export type Status = "passed" | "failed" | "skipped" | "flaky";

export interface Attempt {
  status: "passed" | "failed" | "skipped";
  ms: number;
  error?: { message: string; stack?: string };
  /** The `.saptest.json` this run wrote. */
  trace?: string;
}

export interface TestResult {
  title: string;
  titlePath: string[];
  /** Relative to the config's directory. */
  file: string;
  project: string | undefined;
  status: Status;
  /** All runs together. */
  ms: number;
  attempts: Attempt[];
  /** The last run's error and trace. */
  error?: { message: string; stack?: string };
  trace?: string;
}

export interface RunResult {
  config: ResolvedConfig;
  tests: TestResult[];
  stats: Record<Status, number>;
  ms: number;
  startedAt: string;
  /** No test failed (flaky ones passed in the end). */
  ok: boolean;
}

export interface RunOptions {
  config: ResolvedConfig;
  /** Test files to run; default every file under testDir that testMatch takes. */
  files?: string[];
  /** Keeps only files whose path (relative to the config's directory) contains one of these, or matches it as a regular expression. */
  filters?: string[];
  /** Keeps only tests whose title path (joined with spaces) matches. */
  grep?: RegExp;
  /** Project names to run; default all. */
  projects?: string[];
  retries?: number;
  /** Surfaces to connect over instead of the real ones (tests of the runner). */
  surfaces?: Surface[];
  onTestEnd?: (result: TestResult) => void;
}

/** A test to run: a declared test in one project. */
export interface Planned {
  test: TestCase;
  project: ProjectConfig | undefined;
  title: string;
  titlePath: string[];
  file: string;
  skip: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Every file under `dir` that one of `match` takes (on its path relative to `dir`, with /). */
export function findTestFiles(dir: string, match: RegExp[], skipDirs: string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && !skipDirs.includes(p)) walk(p);
      } else if (match.some((m) => m.test(relative(dir, p).split(sep).join("/")))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * What each file declared when it was first imported. A module runs once per
 * process: importing the file again (a second run from the API) declares
 * nothing, so its tests come from here.
 */
const declared = new Map<string, TestCase[]>();

/** Imports test files and returns what they declared. A file that fails to load is a failed test of its own. */
export async function collect(files: string[]): Promise<{ tests: TestCase[]; broken: { file: string; error: Error }[] }> {
  const r = registry();
  const tests: TestCase[] = [];
  const broken: { file: string; error: Error }[] = [];
  for (const file of files) {
    r.tests = [];
    beginFile(file);
    try {
      await import(pathToFileURL(file).href);
      if (r.tests.length || !declared.has(file)) declared.set(file, r.tests);
      tests.push(...(declared.get(file) ?? []));
    } catch (e) {
      broken.push({ file, error: e as Error });
    } finally {
      endFile();
    }
  }
  r.tests = [];
  return { tests, broken };
}

/** The tests to run in order, after only, skip, grep and projects. */
export function plan(tests: TestCase[], config: ResolvedConfig, o: Pick<RunOptions, "grep" | "projects"> = {}): Planned[] {
  const only = tests.some((t) => t.mode === "only" || suitesOf(t).some((s) => s.mode === "only"));
  const kept = tests.filter((t) => !only || t.mode === "only" || suitesOf(t).some((s) => s.mode === "only"));
  let projects: (ProjectConfig | undefined)[] = config.projects.length ? config.projects : [undefined];
  if (o.projects?.length) {
    const missing = o.projects.filter((p) => !config.projects.some((c) => c.name === p));
    if (missing.length) throw new Error(`No project ${missing.join(", ")}. Projects: ${config.projects.map((p) => p.name).join(", ") || "none"}.`);
    projects = config.projects.filter((p) => o.projects?.includes(p.name));
  }
  const out: Planned[] = [];
  for (const project of projects)
    for (const test of kept) {
      const path = titlePath(test);
      if (o.grep && !o.grep.test(path.join(" "))) continue;
      const skip = test.mode === "skip" || suitesOf(test).some((s) => s.mode === "skip");
      out.push({ test, project, title: path.join(" › "), titlePath: path, file: relative(config.rootDir, test.file).split(sep).join("/"), skip });
    }
  return out;
}

/** Waits for `p` until `ms`; the limit can be changed while it waits. */
class Deadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fire: (() => void) | undefined;
  private start = Date.now();
  readonly expired: Promise<never>;
  constructor(public ms: number) {
    this.expired = new Promise<never>((_, reject) => (this.fire = () => reject(new TimeoutSignal(this.ms))));
    this.expired.catch(() => {});
    this.reset(ms);
  }
  reset(ms: number): void {
    this.ms = ms;
    clearTimeout(this.timer);
    if (ms > 0) this.timer = setTimeout(() => this.fire?.(), Math.max(0, this.start + ms - Date.now()));
  }
  stop(): void {
    clearTimeout(this.timer);
  }
}

class TimeoutSignal extends Error {
  constructor(ms: number) {
    super(`Test timeout of ${ms} ms exceeded. The SAP action in progress cannot be aborted and may still finish in SAP; the afterEach hooks were skipped and the session was let go.`);
    this.name = "TimeoutError";
  }
}

const errorOf = (e: unknown) => (e instanceof Error ? { message: e.message, ...(e.stack ? { stack: e.stack } : {}) } : { message: String(e) });

/** One run of one test: connect, beforeEach, the test, afterEach, close. */
async function attempt(p: Planned, retry: number, slugDir: string, config: ResolvedConfig, surfaces: Surface[] | undefined): Promise<Attempt> {
  const suites = suitesOf(p.test);
  const use: UseOptions = Object.assign({}, config.use, p.project?.use, ...suites.map((s) => s.use), p.test.details.use);
  const timeout = p.test.details.timeout ?? suites.reduce<number | undefined>((t, s) => s.timeout ?? t, undefined) ?? config.timeout;
  const outputDir = join(config.outputDir, retry ? `${slugDir}-retry${retry}` : slugDir);
  const info: TestInfo = { title: p.test.title, titlePath: p.titlePath, file: p.test.file, project: p.project?.name, retry, outputDir, timeout };
  const { screenshots, ...connectUse } = use;
  const t0 = Date.now();
  const deadline = new Deadline(timeout);
  const r = registry();
  r.running = { info, setTimeout: (ms) => deadline.reset(ms) };
  const sapP: Promise<Sap> = connect({
    ...connectUse,
    timeout: config.expectTimeout,
    trace: { dir: outputDir, name: p.title, screenshots: screenshots ?? false },
    ...(surfaces ? { surfaces } : {}),
  });
  sapP.catch(() => {});
  let error: unknown;
  let skipped = false;
  let timedOut = false;
  const body = (async () => {
    const sap = await sapP;
    for (const s of suites) for (const h of s.beforeEach) await h({ sap, info });
    await p.test.fn({ sap, info });
  })();
  body.catch(() => {});
  try {
    await Promise.race([body, deadline.expired]);
  } catch (e) {
    if (isSkip(e)) skipped = true;
    else error = e;
    timedOut = e instanceof TimeoutSignal;
  }
  // Teardown gets a time of its own, as long as the test's.
  const down = new Deadline(deadline.ms);
  let trace: string | undefined;
  const teardown = (async () => {
    const sap = await sapP.catch(() => undefined);
    if (!sap) return;
    try {
      if (!timedOut)
        for (const s of [...suites].reverse())
          for (const h of s.afterEach)
            await Promise.resolve(h({ sap, info })).catch((e: unknown) => {
              if (!isSkip(e)) error ??= e;
            });
    } finally {
      trace = (await sap.close().catch(() => ({ trace: sap.traceFile }))).trace ?? sap.traceFile;
    }
  })();
  teardown.catch(() => {});
  try {
    await Promise.race([teardown, down.expired]);
  } catch (e) {
    error ??= new Error(`Teardown (afterEach hooks, closing the session) did not end within ${down.ms} ms.`);
    void e;
  }
  deadline.stop();
  down.stop();
  r.running = undefined;
  const ms = Date.now() - t0;
  const status = error ? "failed" : skipped ? "skipped" : "passed";
  return { status, ms, ...(error ? { error: errorOf(error) } : {}), ...(trace ? { trace } : {}) };
}

/** Runs one planned test with its retries. */
async function runOne(p: Planned, slugDir: string, config: ResolvedConfig, retries: number, surfaces: Surface[] | undefined): Promise<TestResult> {
  const base = { title: p.title, titlePath: p.titlePath, file: p.file, project: p.project?.name };
  if (p.skip) return { ...base, status: "skipped", ms: 0, attempts: [] };
  const attempts: Attempt[] = [];
  for (let retry = 0; retry <= retries; retry++) {
    const a = await attempt(p, retry, slugDir, config, surfaces);
    attempts.push(a);
    if (a.status !== "failed") break;
  }
  const last = attempts[attempts.length - 1] as Attempt;
  const status: Status = last.status === "failed" ? "failed" : last.status === "passed" && attempts.length > 1 ? "flaky" : last.status;
  const failed = [...attempts].reverse().find((a) => a.error);
  return {
    ...base,
    status,
    ms: attempts.reduce((n, a) => n + a.ms, 0),
    attempts,
    ...(status === "failed" && failed?.error ? { error: failed.error } : {}),
    ...(last.trace ? { trace: last.trace } : {}),
  };
}

/** Finds, plans and runs the tests. */
export async function runTests(o: RunOptions): Promise<RunResult> {
  const { config } = o;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let files = (o.files ?? findTestFiles(config.testDir, config.testMatch, [config.outputDir])).map((f) => resolve(config.rootDir, f));
  if (o.filters?.length) {
    const fits = (f: string) => {
      const rel = relative(config.rootDir, f).split(sep).join("/");
      return o.filters?.some((x) => rel.includes(x) || resolve(x) === f || safeRegExp(x)?.test(rel));
    };
    files = files.filter(fits);
  }
  const { tests, broken } = await collect(files);
  const planned = plan(tests, config, o);
  const results: TestResult[] = broken.map(({ file, error }) => ({
    title: `loading ${relative(config.rootDir, file)}`,
    titlePath: [],
    file: relative(config.rootDir, file).split(sep).join("/"),
    project: undefined,
    status: "failed",
    ms: 0,
    attempts: [],
    error: errorOf(error),
  }));
  for (const r of results) o.onTestEnd?.(r);
  const used = new Map<string, number>();
  for (const p of planned) {
    // The test's directory: unique, readable, stable across runs.
    let dir = slug([p.project?.name, p.file.replace(/\.sap\.[mc]?[jt]s$/, ""), ...p.titlePath].filter(Boolean).join(" ")) || "test";
    const n = (used.get(dir) ?? 0) + 1;
    used.set(dir, n);
    if (n > 1) dir = `${dir}-${n}`;
    const r = await runOne(p, dir, config, o.retries ?? config.retries, o.surfaces);
    results.push(r);
    o.onTestEnd?.(r);
  }
  const stats: Record<Status, number> = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const r of results) stats[r.status]++;
  return { config, tests: results, stats, ms: Date.now() - t0, startedAt, ok: stats.failed === 0 };
}

function safeRegExp(s: string): RegExp | undefined {
  try {
    return new RegExp(s);
  } catch {
    return undefined;
  }
}
