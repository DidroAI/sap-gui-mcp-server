/**
 * The runner's configuration: `sap.config.ts` (or .js, .mjs, .json), found by
 * walking up from the working directory, or named with `--config`.
 *
 *   import { defineConfig } from "sap-ui-automation/test";
 *   export default defineConfig({
 *     testDir: "tests",
 *     retries: 1,
 *     reporter: ["list", ["junit", { outputFile: "sap-results/junit.xml" }]],
 *     use: { surface: "sapgui", system: "ABA/800", write: "off" },
 *     projects: [
 *       { name: "ecc", use: { surface: "webgui", system: "ECC" } },
 *       { name: "s4", use: { surface: "fiori", system: "S4H" } },
 *     ],
 *   });
 *
 * Paths in the config are relative to the directory the config is in.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTestFilesAsModules } from "./esm.js";
import type { WriteMode } from "../core/guard.js";
import type { SurfaceName } from "../core/types.js";

/** How a test's `sap` is connected: the `connect()` options a config, project, describe or test may set. */
export interface UseOptions {
  surface?: SurfaceName | SurfaceName[];
  /** "ABA" or "ABA/800": the first open session of that system is used. */
  system?: string;
  /** Any session reference `sap_sessions` accepts. */
  session?: string;
  /** Actions that may write: refused (default), or run. "confirm" refuses too: a test has nobody to ask. */
  write?: WriteMode;
  allowTcodes?: string[];
  blockTcodes?: string[];
  /** Keep a PNG of each step in the trace. Default false. */
  screenshots?: boolean;
  /**
   * The lock file next to each test file (`x.sap.ts` -> `x.sap.lock.json`, sdk/lock.ts):
   * verify (default) compares each action with it, throws Drift where SAP answers otherwise,
   * and a passing test adds what the lock does not have yet (all of it when there is none);
   * write compares nothing and adds this run's screens (`--update-locks`); off leaves it alone.
   */
  lock?: "verify" | "write" | "off";
}

export type ReporterName = "list" | "junit" | "json" | "html";
export interface ReporterOptions {
  /** Where junit, json and html write; relative to the config's directory. */
  outputFile?: string;
}
export type ReporterSpec = ReporterName | [ReporterName] | [ReporterName, ReporterOptions];

/** A named variant of `use`, e.g. the same tests on ECC in the Web GUI and on S/4 in Fiori. */
export interface ProjectConfig {
  name: string;
  use?: UseOptions;
}

export interface SapConfig {
  /** Where test files are looked for. Default: the config's directory. */
  testDir?: string;
  /** Which files are tests: globs (relative to testDir) or regular expressions. Default `**\/*.sap.{ts,js,mjs}`. */
  testMatch?: string | RegExp | (string | RegExp)[];
  /** Per test, hooks included, in ms. Default 60000. */
  timeout?: number;
  /** How long `expect` waits by default, in ms. Default 5000. */
  expectTimeout?: number;
  /** How often a failing test is run again. A test that passes on a retry is reported flaky. Default 0. */
  retries?: number;
  /**
   * Always 1: tests run one after the other. An SAP session is one user on one
   * screen; two tests driving it at once would type into each other's fields.
   */
  workers?: 1;
  /** Default "list". */
  reporter?: ReporterName | ReporterSpec[];
  /** Traces and reports. Default `sap-results`. */
  outputDir?: string;
  use?: UseOptions;
  projects?: ProjectConfig[];
}

/** Only gives a config its type. */
export function defineConfig(config: SapConfig): SapConfig {
  return config;
}

/** A config with every default filled in and its paths made absolute. */
export interface ResolvedConfig {
  /** The config file, when there is one. */
  file: string | undefined;
  rootDir: string;
  testDir: string;
  testMatch: RegExp[];
  timeout: number;
  expectTimeout: number;
  retries: number;
  reporter: [ReporterName, ReporterOptions][];
  outputDir: string;
  use: UseOptions;
  projects: ProjectConfig[];
}

export const CONFIG_NAMES = ["sap.config.ts", "sap.config.mjs", "sap.config.js", "sap.config.json"];
const REPORTERS: ReporterName[] = ["list", "junit", "json", "html"];

/** The nearest config file at or above `from`. */
export function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const n of CONFIG_NAMES) if (existsSync(join(dir, n))) return join(dir, n);
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Node loads TypeScript without a flag from 22.18, with --experimental-strip-types
 * from 22.6 (the test command re-runs itself with it), and not at all before.
 * Where it cannot, its error is only `Unknown file extension ".ts" for <file>`:
 * this says what to do. Other errors come back as they are.
 */
export function explainTypeScriptLoad(e: unknown, node: string = process.versions.node): unknown {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err?.code !== "ERR_UNKNOWN_FILE_EXTENSION" || typeof err.message !== "string" || !/"\.[cm]?ts"/.test(err.message)) return e;
  return new Error(`${err.message}: Node ${node} cannot load TypeScript here. Use Node 22.18 or later, which loads it without a flag, or write the file as .js or .mjs.`, { cause: e });
}

/** Reads a config file: JSON, or a module whose default export is the config. */
export async function loadConfig(file: string): Promise<SapConfig> {
  if (file.endsWith(".json")) return JSON.parse(await readFile(file, "utf8")) as SapConfig;
  loadTestFilesAsModules();
  const m = (await import(pathToFileURL(file).href).catch((e: unknown) => {
    throw explainTypeScriptLoad(e);
  })) as { default?: SapConfig; config?: SapConfig };
  const c = m.default ?? m.config;
  if (!c || typeof c !== "object") throw new Error(`${file}: export the config as default (export default defineConfig({...}))`);
  return c;
}

/** A glob (`**`, `*`, `?`, `{a,b}`) as a regular expression on a /-separated path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches no directory too.
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(?:${glob.slice(i + 1, end).split(",").map(esc).join("|")})`;
      i = end;
    } else re += esc(c);
  }
  return new RegExp(`^${re}$`);
}
const esc = (s: string) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

export function resolveConfig(config: SapConfig, rootDir: string, file?: string): ResolvedConfig {
  const at = (p: string) => (isAbsolute(p) ? p : join(rootDir, p));
  if (config.workers !== undefined && config.workers !== 1) throw new Error("workers must be 1: one SAP session cannot be driven by two tests at once.");
  const reporter = ([] as ReporterSpec[]).concat(config.reporter ?? "list").map((r): [ReporterName, ReporterOptions] => (typeof r === "string" ? [r, {}] : [r[0], r[1] ?? {}]));
  for (const [r] of reporter) if (!REPORTERS.includes(r)) throw new Error(`Unknown reporter "${r}": use ${REPORTERS.join(", ")}.`);
  const names = (config.projects ?? []).map((p) => p.name);
  if (new Set(names).size !== names.length) throw new Error("Project names must differ.");
  return {
    file,
    rootDir,
    testDir: at(config.testDir ?? "."),
    testMatch: ([] as (string | RegExp)[]).concat(config.testMatch ?? "**/*.sap.{ts,js,mjs}").map((m) => (typeof m === "string" ? globToRegExp(m) : m)),
    timeout: config.timeout ?? 60_000,
    expectTimeout: config.expectTimeout ?? 5000,
    retries: config.retries ?? 0,
    reporter,
    outputDir: at(config.outputDir ?? "sap-results"),
    use: config.use ?? {},
    projects: config.projects ?? [],
  };
}

/** The config named, else the nearest one, else the defaults in `cwd`. */
export async function configFor(cwd: string, file?: string): Promise<ResolvedConfig> {
  const path = file ? resolve(cwd, file) : findConfig(cwd);
  if (!path) return resolveConfig({}, resolve(cwd));
  if (!existsSync(path)) throw new Error(`No config file ${path}.`);
  return resolveConfig(await loadConfig(path), dirname(path), path);
}
