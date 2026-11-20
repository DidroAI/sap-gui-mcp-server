/**
 * What a run reports:
 *
 *   list   one line per test as it ends, then each failure with its error and trace
 *   junit  JUnit XML for CI servers: one suite per file, one case per test
 *   json   the whole result
 *   html   one self-contained page, linking to each test's trace page
 *
 * junit, json and html write a file (`outputFile`, default in outputDir).
 */
import { renderTraceHtml } from "../trace/html.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseTest } from "../record/format.js";
import { xml } from "../record/replay.js";
import type { ReporterName, ReporterOptions, ResolvedConfig } from "./config.js";
import type { RunResult, Status, TestResult } from "./run.js";

/** Writes a trace's HTML page next to it and returns its path, or undefined when it cannot. */
export type TraceHtml = (tracePath: string) => Promise<string | undefined>;

export interface ReportContext {
  /** Where `list` prints; default stdout. */
  print?: (line: string) => void;
  traceHtml?: TraceHtml;
}

export interface Reporter {
  onTestEnd?(r: TestResult): void;
  /** Returns the files it wrote. */
  onEnd(run: RunResult): Promise<string[]>;
}

const MARK: Record<Status, string> = { passed: "✓", flaky: "✓", failed: "✘", skipped: "-" };
const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const name = (r: TestResult) => [r.project && `[${r.project}]`, r.file, ...r.titlePath].filter(Boolean).join(" › ");

export function listLine(r: TestResult): string {
  return `  ${MARK[r.status]} ${name(r)}${r.status === "skipped" ? "" : ` (${secs(r.ms)})`}${r.status === "flaky" ? ` flaky, passed on retry ${r.attempts.length - 1}` : ""}${lockNote(r)}`;
}

/** What the lock said, when it says something worth a look: a repair it applied, actions it had not seen. */
function lockNote(r: TestResult): string {
  const l = r.lock;
  if (!l || r.status === "failed") return "";
  const said = [l.repairs.length && `${l.repairs.length} repair${l.repairs.length > 1 ? "s" : ""} from the lock`, l.written && l.unverified && `${l.unverified} unverified action${l.unverified > 1 ? "s" : ""} added to the lock`].filter(Boolean);
  return said.length ? ` [${said.join(", ")}]` : "";
}

/** The drift a test failed on, in two lines: where, and the lock. */
export function driftLines(r: TestResult): string[] {
  const d = r.drift;
  if (!d) return [];
  return [`drift: step ${d.step ? `"${d.step}"` : "(outside any sap.step)"}${d.ordinal > 1 ? ` (run ${d.ordinal})` : ""}, action ${d.actionIndex + 1} ${d.code} (${d.phase})`, `lock: ${d.lock}`];
}

/** The line of the stack that is in the test's file, if any: where it failed. */
function where(r: TestResult, rootDir: string): string | undefined {
  const file = r.file.split("/").join(sep);
  const line = r.error?.stack?.split("\n").find((l) => l.includes(file));
  const m = line?.match(/\(?((?:file:\/\/)?[^()]+:\d+:\d+)\)?\s*$/);
  return m?.[1] ? relative(rootDir, m[1].replace(/^file:\/\//, "")) : undefined;
}

/** The failures, numbered, then the counts. */
export function listSummary(run: RunResult): string {
  const out: string[] = [];
  const failed = run.tests.filter((t) => t.status === "failed");
  failed.forEach((t, i) => {
    out.push("", `  ${i + 1}) ${name(t)}`, "");
    out.push(...(t.error?.message ?? "failed").split("\n").map((l) => `     ${l}`));
    const at = where(t, run.config.rootDir);
    if (at) out.push(`     at ${at}`);
    for (const l of driftLines(t)) out.push(`     ${l}`);
    if (t.trace) out.push(`     trace: ${relative(process.cwd(), t.trace) || t.trace}`);
  });
  const s = run.stats;
  const counts = [s.passed && `${s.passed} passed`, s.failed && `${s.failed} failed`, s.flaky && `${s.flaky} flaky`, s.skipped && `${s.skipped} skipped`].filter(Boolean);
  out.push("", `  ${counts.join(", ") || "no tests"} (${secs(run.ms)})`);
  return out.join("\n");
}

/** JUnit XML: one suite per file, one case per test (and project). A flaky test passes, with a note. */
export function junitReport(run: RunResult): string {
  const files = [...new Set(run.tests.map((t) => t.file))];
  const suites = files.map((file) => {
    const tests = run.tests.filter((t) => t.file === file);
    const cases = tests.map((t) => {
      const head = `    <testcase name="${xml([t.project && `[${t.project}]`, ...t.titlePath].filter(Boolean).join(" › ") || t.title)}" classname="${xml(file)}" time="${(t.ms / 1000).toFixed(3)}"`;
      const said = [t.trace && `trace: ${t.trace}`, ...driftLines(t)].filter(Boolean).join("\n");
      const traceOut = said ? `<system-out>${xml(said)}</system-out>` : "";
      if (t.status === "skipped") return `${head}><skipped/></testcase>`;
      if (t.status === "failed") return `${head}><failure message="${xml(t.error?.message.split("\n")[0] ?? "failed")}">${xml(t.error?.stack ?? t.error?.message ?? "")}</failure>${traceOut}</testcase>`;
      if (t.status === "flaky") return `${head}><system-out>${xml(`flaky: passed on retry ${t.attempts.length - 1}; first error: ${t.attempts[0]?.error?.message ?? ""}${t.trace ? `\ntrace: ${t.trace}` : ""}`)}</system-out></testcase>`;
      return traceOut ? `${head}>${traceOut}</testcase>` : `${head}/>`;
    });
    const n = (s: Status) => tests.filter((t) => t.status === s).length;
    return `  <testsuite name="${xml(file)}" tests="${tests.length}" failures="${n("failed")}" errors="0" skipped="${n("skipped")}" time="${(tests.reduce((a, t) => a + t.ms, 0) / 1000).toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  const total = run.tests.length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="sap-gui-mcp-server test" tests="${total}" failures="${run.stats.failed}" skipped="${run.stats.skipped}" time="${(run.ms / 1000).toFixed(3)}">\n${suites.join("\n")}\n</testsuites>\n`;
}

export function jsonReport(run: RunResult): string {
  const { config, ...rest } = run;
  return `${JSON.stringify({ rootDir: config.rootDir, config: config.file, outputDir: config.outputDir, ...rest }, null, 2)}\n`;
}

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The trace page of the trace viewer (src/trace/html.ts), written next to the trace as `<name>.saptest.html`; undefined when it cannot be made (the report then links the JSON). */
export const defaultTraceHtml: TraceHtml = async (tracePath) => {
  try {
    const page = await renderTraceHtml(parseTest(await readFile(tracePath, "utf8")), { baseDir: dirname(tracePath) });
    const out = tracePath.replace(/\.json$/i, ".html");
    await writeFile(out, page);
    return out;
  } catch {
    return undefined;
  }
};

/** One page: counts, then a row per test with status, duration, error and trace link. `links` maps a trace to the page to link. */
export function htmlReport(run: RunResult, at: string, links: Map<string, string>): string {
  const href = (p: string) => relative(dirname(at), p).split(sep).map(encodeURIComponent).join("/");
  const rows = run.tests.map((t) => {
    const link = t.trace ? (links.get(t.trace) ?? t.trace) : undefined;
    const error = t.error ? `<pre>${html([t.error.message, ...driftLines(t)].join("\n"))}</pre>` : t.status === "flaky" ? `<pre class="flaky">${html(`passed on retry ${t.attempts.length - 1}; first: ${t.attempts[0]?.error?.message ?? ""}`)}</pre>` : "";
    return `<tr class="${t.status}"><td class="st">${MARK[t.status]} ${t.status}</td><td><div class="t">${html(t.titlePath.join(" › ") || t.title)}</div><div class="f">${html([t.project && `[${t.project}]`, t.file].filter(Boolean).join(" "))}</div>${error}</td><td class="ms">${secs(t.ms)}</td><td>${link ? `<a href="${html(href(link))}">trace</a>` : ""}</td></tr>`;
  });
  const s = run.stats;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SAP test report</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--line:#e5e5ea;--pass:#1a7f37;--fail:#cf222e;--flaky:#9a6700;--code:#f6f8fa}
@media (prefers-color-scheme: dark){:root{--bg:#161618;--fg:#f2f2f7;--mute:#a1a1a6;--line:#2c2c2e;--pass:#3fb950;--fail:#f85149;--flaky:#d29922;--code:#1f1f23}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.sum{color:var(--mute);margin-bottom:16px}
table{width:100%;border-collapse:collapse}td{border-top:1px solid var(--line);padding:8px 6px;vertical-align:top}
.st{white-space:nowrap;font-weight:600}.passed .st{color:var(--pass)}.failed .st{color:var(--fail)}.flaky .st{color:var(--flaky)}.skipped .st{color:var(--mute)}
.f,.ms{color:var(--mute)}.ms{white-space:nowrap;text-align:right}pre{background:var(--code);padding:8px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0}
a{color:inherit}
</style></head><body><main>
<h1>SAP test report</h1>
<div class="sum">${s.passed} passed · ${s.failed} failed · ${s.flaky} flaky · ${s.skipped} skipped · ${secs(run.ms)} · ${html(run.startedAt)}</div>
<table><tbody>
${rows.join("\n")}
</tbody></table>
</main></body></html>
`;
}

const DEFAULT_FILE: Record<Exclude<ReporterName, "list">, string> = { junit: "junit.xml", json: "results.json", html: "index.html" };

async function write(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

/** The reporters a config names. */
export function reporters(config: ResolvedConfig, ctx: ReportContext = {}): Reporter[] {
  const print = ctx.print ?? ((l: string) => console.log(l));
  return config.reporter.map(([kind, opts]: [ReporterName, ReporterOptions]): Reporter => {
    if (kind === "list") return { onTestEnd: (r) => print(listLine(r)), onEnd: async (run) => (print(listSummary(run)), []) };
    const file = opts.outputFile ? (isAbsolute(opts.outputFile) ? opts.outputFile : join(config.rootDir, opts.outputFile)) : join(config.outputDir, DEFAULT_FILE[kind]);
    if (kind === "junit") return { onEnd: async (run) => [await write(file, junitReport(run))] };
    if (kind === "json") return { onEnd: async (run) => [await write(file, jsonReport(run))] };
    return {
      onEnd: async (run) => {
        const make = ctx.traceHtml ?? defaultTraceHtml;
        const links = new Map<string, string>();
        for (const t of run.tests) {
          if (!t.trace) continue;
          const page = await make(t.trace).catch(() => undefined);
          if (page) links.set(t.trace, page);
        }
        return [await write(file, htmlReport(run, file, links))];
      },
    };
  });
}
