import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseTest } from "../src/record/format.js";
import { configFor, explainTypeScriptLoad, globToRegExp, resolveConfig } from "../src/runner/config.js";
import { parseTestArgs, testCommand } from "../src/runner/cli.js";
import { htmlReport, junitReport, listLine } from "../src/runner/reporters.js";
import { runTests } from "../src/runner/run.js";
import { FakeSap } from "./record-fakes.js";

const RUNNER = JSON.stringify(resolve(import.meta.dir, "../src/runner/index.ts"));
const head = `import { expect, test } from ${RUNNER};\n`;

/** A project in a temp dir: files by relative path. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sap-runner-"));
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), text);
  }
  return dir;
}

/** Runs `sap-ui-automation test` in `dir` on a FakeSap; returns the exit code and what it printed. */
async function cli(dir: string, argv: string[] = [], fake = new FakeSap()) {
  const lines: string[] = [];
  const code = await testCommand(argv, { cwd: dir, surfaces: [fake], print: (l) => lines.push(l) });
  return { code, out: lines.join("\n"), fake };
}

async function run(dir: string, extra: Partial<Parameters<typeof runTests>[0]> = {}) {
  return runTests({ config: await configFor(dir), surfaces: [new FakeSap()], ...extra });
}

const DISPLAY = `
test("displays order 5000", async ({ sap }) => {
  await sap.okcode("/nZA03");
  await sap.set("ctxtZORD-VBELN", "5000");
  await sap.key(0);
  await expect(sap.field("ZORD-KUNNR")).toHaveValue("2200");
});
`;

describe("declaring and running", () => {
  test("pass, fail, skip and describe; the list reporter", async () => {
    const dir = await project({
      "sap.config.json": JSON.stringify({ expectTimeout: 200 }),
      "orders.sap.ts":
        head +
        DISPLAY +
        `
test.describe("unknown orders", () => {
  test("shows an error", async ({ sap }) => {
    await sap.okcode("/nZA03");
    await sap.set("ctxtZORD-VBELN", "9999");
    await sap.key(0);
    await expect(sap.status()).toBeSuccess();
  });
  test.skip("not yet", async () => {});
  test("skips itself", async () => { test.skip(true, "later"); throw new Error("not reached"); });
});
`,
    });
    const { code, out } = await cli(dir);
    expect(code).toBe(1);
    expect(out).toContain("  ✓ orders.sap.ts › displays order 5000 (");
    expect(out).toContain("  ✘ orders.sap.ts › unknown orders › shows an error (");
    expect(out).toContain("  - orders.sap.ts › unknown orders › not yet");
    expect(out).toContain("  - orders.sap.ts › unknown orders › skips itself");
    expect(out).toContain("  1) orders.sap.ts › unknown orders › shows an error");
    expect(out).toContain('the status bar is E: "Order 9999 does not exist"');
    expect(out).toMatch(/at orders\.sap\.ts:\d+:\d+/);
    expect(out).toMatch(/trace: .*unknown-orders-shows-an-error\.saptest\.json/);
    expect(out).toMatch(/1 passed, 1 failed, 2 skipped/);
  });

  test("only runs the tests marked only", async () => {
    const dir = await project({
      "a.sap.ts": `${head}test("one", async () => {});\ntest.only("two", async () => {});\ntest.describe.only("group", () => { test("three", async () => {}); });`,
    });
    const r = await run(dir);
    expect(r.tests.map((t) => t.title)).toEqual(["two", "group › three"]);
  });

  test("beforeEach and afterEach get the fixtures; the session is let go after each test", async () => {
    const dir = await project({
      "a.sap.ts": `${head}
const seen = (globalThis as any).seen = [] as string[];
test.beforeEach(async ({ sap, info }) => { seen.push("before " + info.title); await sap.okcode("/nZA03"); });
test.afterEach(async ({ sap, info }) => { seen.push("after " + info.title + " " + info.retry); });
test("uses the fixture", async ({ sap, info }) => {
  seen.push("test " + sap.info.transaction + " " + info.file.endsWith("a.sap.ts"));
  (globalThis as any).sap = sap;
  throw new Error("boom");
});`,
    });
    const r = await run(dir);
    expect(r.tests[0]?.status).toBe("failed");
    expect((globalThis as { seen?: string[] }).seen).toEqual(["before uses the fixture", "test ZA03 true", "after uses the fixture 0"]);
    // Closed: the registry holds no driver any more.
    const sap = (globalThis as { sap?: { registry: { drivers: Map<string, unknown> } } }).sap;
    expect(sap?.registry.drivers.size).toBe(0);
  });

  test("a file that cannot load is a failure of its own", async () => {
    const dir = await project({ "bad.sap.ts": `${head}throw new Error("syntax of a kind");` });
    const r = await run(dir);
    expect(r.tests[0]?.title).toBe("loading bad.sap.ts");
    expect(r.tests[0]?.error?.message).toContain("syntax of a kind");
    expect(r.ok).toBe(false);
  });

  test("grep and file filters", async () => {
    const dir = await project({
      "a.sap.ts": `${head}test("alpha", async () => {});\ntest("beta", async () => {});`,
      "sub/b.sap.ts": `${head}test("gamma", async () => {});`,
      "c.test.ts": `${head}test("not a sap test", async () => {});`,
    });
    expect((await run(dir)).tests.map((t) => t.title)).toEqual(["alpha", "beta", "gamma"]);
    expect((await run(dir, { grep: /alp|gam/ })).tests.map((t) => t.title)).toEqual(["alpha", "gamma"]);
    expect((await run(dir, { filters: ["sub/"] })).tests.map((t) => t.title)).toEqual(["gamma"]);
  });
});

describe("retries and timeouts", () => {
  test("a test that passes on a retry is flaky; each run has its own trace", async () => {
    const dir = await project({
      "a.sap.ts": `${head}
let n = 0;
test("flaky one", async ({ sap, info }) => {
  await sap.okcode("/nZA03");
  if (n++ === 0) throw new Error("first time fails");
});
test("always fails", async () => { throw new Error("no"); });`,
    });
    const r = await run(dir, { retries: 2 });
    const [flaky, failed] = r.tests;
    expect(flaky?.status).toBe("flaky");
    expect(flaky?.attempts.map((a) => a.status)).toEqual(["failed", "passed"]);
    expect(flaky?.attempts[0]?.trace).toMatch(/a-flaky-one[\\/]/);
    expect(flaky?.attempts[1]?.trace).toMatch(/a-flaky-one-retry1[\\/]/);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts.length).toBe(3);
    expect(r.ok).toBe(false);
    expect(listLine(flaky as never)).toContain("flaky, passed on retry 1");
  });

  test("a test past its timeout fails and says the SAP action was not aborted", async () => {
    const dir = await project({
      "sap.config.json": JSON.stringify({ timeout: 150 }),
      "a.sap.ts": `${head}
test("hangs", async () => { await new Promise((r) => setTimeout(r, 1000)); });
test("own timeout", { timeout: 2000 }, async () => { await new Promise((r) => setTimeout(r, 300)); });
test("sets its timeout", async () => { test.setTimeout(2000); await new Promise((r) => setTimeout(r, 300)); });`,
    });
    const r = await run(dir);
    expect(r.tests.map((t) => t.status)).toEqual(["failed", "passed", "passed"]);
    expect(r.tests[0]?.error?.message).toMatch(/Test timeout of 150 ms exceeded\. The SAP action in progress cannot be aborted/);
    expect(r.tests[0]?.ms).toBeLessThan(900);
  });
});

describe("traces", () => {
  test("every test leaves a .saptest.json trace named after the test", async () => {
    const dir = await project({ "orders.sap.ts": head + DISPLAY });
    const r = await run(dir);
    const trace = r.tests[0]?.trace as string;
    expect(trace).toBe(join(dir, "sap-results", "orders-displays-order-5000", "displays-order-5000.saptest.json"));
    const t = parseTest(await readFile(trace, "utf8"));
    expect(t.name).toBe("displays order 5000");
    expect(t.steps.map((s) => s.code)).toEqual(['await sap.okcode("/nZA03");', 'await sap.set("ctxtZORD-VBELN", "5000");', "await sap.key(0);"]);
  });
});

describe("reporters", () => {
  const files = {
    "sap.config.ts": `import { defineConfig } from ${RUNNER};
export default defineConfig({
  expectTimeout: 100,
  reporter: ["list", ["junit", { outputFile: "out/junit.xml" }], "json", "html"],
});`,
    "orders.sap.ts":
      head +
      DISPLAY +
      `test("fails <here>", async ({ sap }) => { await sap.okcode("/nZA03"); await expect(sap).toHaveTransaction("VA03"); });
test.skip("skipped", async () => {});`,
  };

  test("junit, json and html write their files", async () => {
    const dir = await project(files);
    const { code, out } = await cli(dir);
    expect(code).toBe(1);
    expect(out).toContain(`report: ${join(dir, "out/junit.xml")}`);

    const xml = await readFile(join(dir, "out/junit.xml"), "utf8");
    expect(xml).toContain('<testsuites name="sap-ui-automation test" tests="3" failures="1" skipped="1"');
    expect(xml).toContain('<testsuite name="orders.sap.ts" tests="3" failures="1" errors="0" skipped="1"');
    expect(xml).toContain('<testcase name="fails &lt;here&gt;" classname="orders.sap.ts"');
    expect(xml).toContain("<failure message=");
    expect(xml).toContain('<testcase name="skipped" classname="orders.sap.ts" time="0.000"><skipped/></testcase>');

    const json = JSON.parse(await readFile(join(dir, "sap-results/results.json"), "utf8"));
    expect(json.stats).toEqual({ passed: 1, failed: 1, flaky: 0, skipped: 1 });
    expect(json.tests.map((t: { status: string }) => t.status)).toEqual(["passed", "failed", "skipped"]);
    expect(json.tests[1].error.message).toContain("toHaveTransaction");
    expect(json.config).toBe(join(dir, "sap.config.ts"));

    const html = await readFile(join(dir, "sap-results/index.html"), "utf8");
    expect(html).toContain("1 passed · 1 failed · 0 flaky · 1 skipped");
    expect(html).toContain("fails &lt;here&gt;");
    // Each trace gets its page from the trace viewer, and the report links it.
    expect(html).toContain('<a href="orders-displays-order-5000/displays-order-5000.saptest.html">trace</a>');
    expect(await readFile(join(dir, "sap-results/orders-displays-order-5000/displays-order-5000.saptest.html"), "utf8")).toContain("<!doctype html>");
  });

  test("html links each trace's page made by the trace hook", async () => {
    const dir = await project(files);
    const made: string[] = [];
    await testCommand(["--reporter", "html"], {
      cwd: dir,
      surfaces: [new FakeSap()],
      print: () => {},
      traceHtml: async (p) => {
        made.push(p);
        const out = p.replace(/\.json$/, ".html");
        await writeFile(out, "<html></html>");
        return out;
      },
    });
    expect(made.length).toBe(2);
    const html = await readFile(join(dir, "sap-results/index.html"), "utf8");
    expect(html).toContain('<a href="orders-displays-order-5000/displays-order-5000.saptest.html">trace</a>');
    expect(existsSync(join(dir, "out/junit.xml"))).toBe(false);
  });

  test("the html page escapes and the junit marks flaky tests passed", () => {
    const config = resolveConfig({}, "/r");
    const run = {
      config,
      startedAt: "now",
      ms: 5,
      ok: true,
      stats: { passed: 0, failed: 0, flaky: 1, skipped: 0 },
      tests: [{ title: "<b>", titlePath: ["<b>"], file: "a.sap.ts", project: "s4", status: "flaky" as const, ms: 5, attempts: [{ status: "failed" as const, ms: 2, error: { message: "first" } }, { status: "passed" as const, ms: 3 }] }],
    };
    expect(htmlReport(run, "/r/sap-results/index.html", new Map())).toContain("&lt;b&gt;");
    expect(junitReport(run)).toContain('<testcase name="[s4] › &lt;b&gt;" classname="a.sap.ts" time="0.005"><system-out>flaky: passed on retry 1; first error: first</system-out></testcase>');
  });
});

describe("config", () => {
  test("found by walking up; testDir and outputDir relative to it", async () => {
    const dir = await project({
      "sap.config.mjs": `export default { testDir: "tests", outputDir: "results", retries: 3, use: { system: "ABA" } };`,
      "tests/deep/a.sap.ts": `${head}test("x", async ({ sap }) => { void sap; });`,
    });
    const c = await configFor(join(dir, "tests/deep"));
    expect(c.file).toBe(join(dir, "sap.config.mjs"));
    expect(c.testDir).toBe(join(dir, "tests"));
    expect(c.outputDir).toBe(join(dir, "results"));
    expect(c.retries).toBe(3);
    const r = await runTests({ config: c, surfaces: [new FakeSap()], retries: 0 });
    expect(r.tests[0]?.trace?.startsWith(join(dir, "results/"))).toBe(true);
  });

  test("--config names one; defaults without any", async () => {
    const dir = await project({ "conf/my.json": JSON.stringify({ timeout: 5 }) });
    expect((await configFor(dir, "conf/my.json")).timeout).toBe(5);
    const none = await configFor(dir);
    expect(none.file).toBeUndefined();
    expect(none.timeout).toBe(60_000);
    expect(none.outputDir).toBe(join(dir, "sap-results"));
  });

  test("workers other than 1 is refused, with why", () => {
    expect(() => resolveConfig({ workers: 2 as 1 }, "/r")).toThrow(/one SAP session cannot be driven by two tests at once/);
  });

  test("globs", () => {
    const m = globToRegExp("**/*.sap.{ts,js,mjs}");
    expect(["a.sap.ts", "x/y/a.sap.mjs"].every((p) => m.test(p))).toBe(true);
    expect(m.test("a.ts")).toBe(false);
    expect(globToRegExp("e2e/*.sap.ts").test("e2e/sub/a.sap.ts")).toBe(false);
  });

  test("args", () => {
    const a = parseTestArgs(["orders", "--project=s4,ecc", "--reporter", "list,junit", "--grep", "save", "--retries", "2", "--list"]);
    expect(a).toEqual({ filters: ["orders"], projects: ["s4", "ecc"], reporters: ["list", "junit"], grep: /save/, retries: 2, list: true, updateLocks: false });
    expect(parseTestArgs(["--update-locks"]).updateLocks).toBe(true);
    expect(() => parseTestArgs(["--workers", "2"])).toThrow(/Unknown option --workers/);
  });
});

describe("a Node that cannot load TypeScript (22.0-22.5; 22.6-22.12 inside the server)", () => {
  // What such a Node throws on importing a .ts file; a module that throws it stands in for one.
  const NODE_ERROR = `const e = new Error('Unknown file extension ".ts" for /p/helper.ts'); e.code = "ERR_UNKNOWN_FILE_EXTENSION"; throw e;`;

  test("says to use Node 22.18 or later, keeping Node's own words and error", () => {
    const e = Object.assign(new Error('Unknown file extension ".ts" for /p/a.sap.ts'), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
    const out = explainTypeScriptLoad(e, "22.5.1") as Error;
    expect(out.message).toBe('Unknown file extension ".ts" for /p/a.sap.ts: Node 22.5.1 cannot load TypeScript here. Use Node 22.18 or later, which loads it without a flag, or write the file as .js or .mjs.');
    expect(out.cause).toBe(e);
    const mts = Object.assign(new Error('Unknown file extension ".mts" for /p/a.mts'), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
    expect((explainTypeScriptLoad(mts, "22.5.1") as Error).message).toContain("Node 22.18 or later");
  });

  test("other errors come back as they are", () => {
    const css = Object.assign(new Error('Unknown file extension ".css" for /p/a.css'), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
    const plain = new Error('Unknown file extension ".ts"');
    for (const e of [css, plain, "text", null, undefined]) expect(explainTypeScriptLoad(e, "22.5.1")).toBe(e);
  });

  test("a test file that cannot load says it", async () => {
    const dir = await project({ "sap-tests/a.sap.mjs": NODE_ERROR, "sap-tests/b.sap.mjs": `throw new Error("broken");` });
    const { code, out } = await cli(dir, ["--list"]);
    expect(code).toBe(1);
    expect(out).toContain(`cannot load ${join(dir, "sap-tests/a.sap.mjs")}: Unknown file extension ".ts" for /p/helper.ts: Node ${process.versions.node} cannot load TypeScript here. Use Node 22.18 or later`);
    expect(out).toContain(`cannot load ${join(dir, "sap-tests/b.sap.mjs")}: broken\n`);
  });

  test("a config that cannot load says it", async () => {
    const dir = await project({ "sap.config.mjs": NODE_ERROR });
    await expect(configFor(dir)).rejects.toThrow(`Node ${process.versions.node} cannot load TypeScript here. Use Node 22.18 or later`);
  });
});

describe("projects", () => {
  const files = {
    "sap.config.json": JSON.stringify({
      use: { surface: "webgui" },
      projects: [
        { name: "ecc", use: { system: "ABA" } },
        { name: "s4", use: { system: "S4H" } },
      ],
    }),
    "a.sap.ts": `${head}test("system", async ({ sap, info }) => { expect(info.project).toBe(sap.info.system === "ABA" ? "ecc" : "s4"); });`,
  };

  test("every project runs by default; --project picks", async () => {
    const dir = await project(files);
    const all = await cli(dir);
    // The fake is system ABA only: the s4 project finds no session.
    expect(all.out).toContain("  ✓ [ecc] › a.sap.ts › system");
    expect(all.out).toContain("  ✘ [s4] › a.sap.ts › system");
    expect(all.out).toContain("No open SAP session with surface webgui, system S4H");
    const ecc = await cli(dir, ["--project", "ecc"]);
    expect(ecc.code).toBe(0);
    expect(ecc.out).not.toContain("[s4]");
    await expect(cli(dir, ["--project", "bw"])).rejects.toThrow(/No project bw\. Projects: ecc, s4/);
  });

  test("--list lists without running", async () => {
    const dir = await project(files);
    const { code, out, fake } = await cli(dir, ["--list"]);
    expect(code).toBe(0);
    expect(out).toBe("  [ecc] › a.sap.ts › system\n  [s4] › a.sap.ts › system\nTotal: 2 tests");
    expect(fake.acts.length).toBe(0);
  });

  test("test.use and per-test use override the project", async () => {
    const dir = await project({
      "sap.config.json": JSON.stringify({ projects: [{ name: "p", use: { system: "S4H" } }] }),
      "a.sap.ts": `${head}test.use({ system: "ABA" });\ntest("blocked here", { use: { blockTcodes: ["ZA03"] } }, async ({ sap }) => { await sap.okcode("/nZA03"); });\ntest("free", async ({ sap }) => { await sap.okcode("/nZA03"); });`,
    });
    const r = await run(dir);
    expect(r.tests.map((t) => t.status)).toEqual(["failed", "passed"]);
    expect(r.tests[0]?.error?.message).toMatch(/blocked/);
  });
});

describe("the sap fixture", () => {
  test("is asked for by name in the parameters", async () => {
    const { wantsSap } = await import("../src/runner/run.js");
    expect(wantsSap(async ({ sap }: { sap: unknown }) => sap)).toBe(true);
    expect(wantsSap(async ({ info, sap: s }: { info: unknown; sap: unknown }) => [info, s])).toBe(true);
    expect(wantsSap(async ({ info }: { info: unknown }) => info)).toBe(false);
    expect(wantsSap(async () => 1)).toBe(false);
    expect(wantsSap(async function (f: unknown) { return f; })).toBe(true);
    expect(wantsSap(async (f: unknown) => f)).toBe(true);
  });
});

describe("lock files", () => {
  const SHOW = `${head}
test("shows order 5000", async ({ sap }) => {
  await sap.step("Display", async () => {
    await sap.okcode("/nZA03");
    await sap.set("ctxtZORD-VBELN", "5000");
    await sap.key(0);
  });
  await expect(sap.field("ZORD-KUNNR")).toHaveValue("2200");
});
`;
  const informing = () => {
    const f = new FakeSap();
    f.popupsFor.set("5000", [{ title: "Information", text: "Order has a delivery block" }]);
    return f;
  };

  test("written by a pass, verified next; drift fails with the step and the lock; --update-locks adds the new screen", async () => {
    const dir = await project({ "sap.config.json": JSON.stringify({ expectTimeout: 300, reporter: ["list", "junit"] }), "orders.sap.ts": SHOW });
    const lockFile = join(dir, "orders.sap.lock.json");
    const first = await cli(dir);
    expect(first.code).toBe(0);
    expect(existsSync(lockFile)).toBe(true);
    expect(first.out).toContain("[3 unverified actions added to the lock]");
    const lock = JSON.parse(await readFile(lockFile, "utf8"));
    expect(Object.keys(lock.tests)).toEqual(["shows order 5000"]);
    expect(lock.tests["shows order 5000"].steps[0].step).toBe("Display");

    const again = await cli(dir);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("unverified");

    // SAP now shows an Information popup after Enter: the code would pass it, the lock has not seen it.
    const drift = await cli(dir, [], informing());
    expect(drift.code).toBe(1);
    expect(drift.out).toContain('Drift in step "Display", action 3 (await sap.key(0);');
    expect(drift.out).toContain('drift: step "Display", action 3 await sap.key(0); (landing)');
    expect(drift.out).toContain(`lock: ${lockFile}`);
    const junit = await readFile(join(dir, "sap-results", "junit.xml"), "utf8");
    expect(junit).toContain('<failure message="Drift in step &quot;Display&quot;, action 3');

    const update = await cli(dir, ["--update-locks"], informing());
    expect(update.code).toBe(0);
    const paths = JSON.parse(await readFile(lockFile, "utf8")).tests["shows order 5000"].steps[0].paths;
    expect(paths.length).toBe(2);
    expect((await cli(dir, [], informing())).code).toBe(0);
    expect((await cli(dir)).code).toBe(0);
  });

  test('use: { lock: "off" } writes no lock; the HTML report shows the drift', async () => {
    const off = await project({ "sap.config.json": JSON.stringify({ use: { lock: "off" } }), "orders.sap.ts": SHOW });
    expect((await cli(off)).code).toBe(0);
    expect(existsSync(join(off, "orders.sap.lock.json"))).toBe(false);

    const dir = await project({ "sap.config.json": JSON.stringify({ expectTimeout: 300 }), "orders.sap.ts": SHOW });
    await run(dir);
    const r = await runTests({ config: await configFor(dir), surfaces: [informing()] });
    expect(r.tests[0]?.drift).toMatchObject({ step: "Display", actionIndex: 2, phase: "landing" });
    const page = htmlReport(r, join(dir, "index.html"), new Map());
    expect(page).toContain("drift: step &quot;Display&quot;, action 3");
  });
});
