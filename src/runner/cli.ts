/**
 *   sap-gui-mcp-server test [files or filters] [--config f] [--project p] [--reporter list,junit]
 *                           [--grep re] [--retries n] [--list] [--update-locks]
 *
 * Exit code 0 when no test failed (flaky ones count as passed), 1 otherwise.
 *
 * Test files and configs may be TypeScript. Bun loads it as is; Node strips
 * the types itself from 22.18 (and 23.6). An older Node 22 needs
 * --experimental-strip-types, so the command starts itself again with it.
 */
import { spawnSync } from "node:child_process";
import type { Surface } from "../core/types.js";
import { configFor, type ReporterName, type ResolvedConfig } from "./config.js";
import { reporters, type TraceHtml } from "./reporters.js";
import { collect, findTestFiles, plan, runTests } from "./run.js";

export const TEST_HELP = `  sap-gui-mcp-server test [files or filters] [--config f] [--project p] [--reporter list,junit,json,html]
                         [--grep re] [--retries n] [--list] [--update-locks]
                                run *.sap.ts tests (sap.config.ts) on open sessions; exit code 1 on a failure.
                                Each test is verified against x.sap.lock.json next to it (written by a passing run);
                                --update-locks compares nothing and adds this run's screens to the locks`;

const VALUE_FLAGS = new Set(["--config", "--project", "--reporter", "--grep", "--retries"]);
const BOOL_FLAGS = new Set(["--list", "--update-locks"]);

export interface TestArgs {
  filters: string[];
  config?: string;
  projects: string[];
  reporters: ReporterName[];
  grep?: RegExp;
  retries?: number;
  list: boolean;
  /** --update-locks: lock mode "write" for every test. */
  updateLocks: boolean;
}

export function parseTestArgs(argv: string[]): TestArgs {
  const out: TestArgs = { filters: [], projects: [], reporters: [], list: false, updateLocks: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i] as string;
    let v: string | undefined;
    if (!a.startsWith("--")) {
      out.filters.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) [a, v] = [a.slice(0, eq), a.slice(eq + 1)];
    if (BOOL_FLAGS.has(a)) {
      if (a === "--list") out.list = true;
      else out.updateLocks = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw new Error(`Unknown option ${a}.\n${TEST_HELP}`);
    v ??= argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === "--config") out.config = v;
    else if (a === "--project") out.projects.push(...v.split(",").filter(Boolean));
    else if (a === "--reporter") out.reporters.push(...(v.split(",").filter(Boolean) as ReporterName[]));
    else if (a === "--grep") out.grep = new RegExp(v);
    else if (a === "--retries") {
      out.retries = Number(v);
      if (!Number.isInteger(out.retries) || out.retries < 0) throw new Error("--retries needs a whole number");
    }
  }
  return out;
}

/** Whether this runtime can import .ts files. */
function loadsTypeScript(): boolean {
  if ("Bun" in globalThis) return true;
  return Boolean((process.features as { typescript?: unknown }).typescript);
}

/** On a Node that cannot load .ts by default, runs this command again with type stripping on; else undefined. */
function rerunWithTypes(): number | undefined {
  if (loadsTypeScript() || process.env.SAP_TEST_STRIP_TYPES === "1") return undefined;
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 6)) return undefined; // .js tests still run
  const r = spawnSync(process.execPath, [...process.execArgv, "--experimental-strip-types", "--no-warnings", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, SAP_TEST_STRIP_TYPES: "1" },
  });
  return r.status ?? 1;
}

export interface TestCommandOptions {
  cwd?: string;
  print?: (line: string) => void;
  /** For the runner's own tests. */
  surfaces?: Surface[];
  traceHtml?: TraceHtml;
}

export async function testCommand(argv: string[], o: TestCommandOptions = {}): Promise<number> {
  const args = parseTestArgs(argv);
  if (!o.surfaces) {
    const code = rerunWithTypes();
    if (code !== undefined) return code;
  }
  const print = o.print ?? ((l: string) => console.log(l));
  let config: ResolvedConfig = await configFor(o.cwd ?? process.cwd(), args.config);
  if (args.reporters.length) config = { ...config, reporter: args.reporters.map((r) => [r, {}]) };
  for (const [r] of config.reporter) if (!["list", "junit", "json", "html"].includes(r)) throw new Error(`Unknown reporter "${r}": use list, junit, json, html.`);

  if (args.list) {
    const files = findTestFiles(config.testDir, config.testMatch, [config.outputDir]).filter((f) => !args.filters.length || args.filters.some((x) => f.includes(x)));
    const { tests, broken } = await collect(files);
    const planned = plan(tests, config, { ...(args.grep ? { grep: args.grep } : {}), projects: args.projects });
    for (const p of planned) print(`  ${[p.project && `[${p.project.name}]`, p.file, ...p.titlePath].filter(Boolean).join(" › ")}${p.skip ? " (skipped)" : ""}`);
    for (const b of broken) print(`  cannot load ${b.file}: ${b.error.message}`);
    print(`Total: ${planned.length} test${planned.length === 1 ? "" : "s"}`);
    return broken.length ? 1 : 0;
  }

  const reps = reporters(config, { print, ...(o.traceHtml ? { traceHtml: o.traceHtml } : {}) });
  const run = await runTests({
    config,
    filters: args.filters,
    projects: args.projects,
    ...(args.grep ? { grep: args.grep } : {}),
    ...(args.retries !== undefined ? { retries: args.retries } : {}),
    ...(args.updateLocks ? { lock: "write" as const } : {}),
    ...(o.surfaces ? { surfaces: o.surfaces } : {}),
    onTestEnd: (r) => reps.forEach((x) => x.onTestEnd?.(r)),
  });
  if (!run.tests.length) {
    print("No tests found.");
    return 1;
  }
  for (const r of reps) for (const f of await r.onEnd(run)) print(`  report: ${f}`);
  return run.ok ? 0 : 1;
}
