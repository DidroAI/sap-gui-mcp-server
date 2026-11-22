import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORMAT, parseTest, type SapTest } from "../src/record/format.js";
import type { ReplayResult } from "../src/record/replay.js";
import { connect } from "../src/sdk/index.js";
import { formatMs, htmlPathFor, renderTraceHtml, showTraceCommand, slower, timings, traceSummary } from "../src/trace/index.js";
import { FakeSap } from "./record-fakes.js";

/** A trace of a display flow made with the fake: three steps, screenshots on. */
async function fakeTrace(): Promise<{ dir: string; file: string; test: SapTest }> {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  const sap = await connect({ surfaces: [new FakeSap()], trace: { dir, name: "za03 trace", screenshots: true } });
  await sap.okcode("/nZA03");
  await sap.set("ctxtZORD-VBELN", "5000");
  await sap.key(0);
  const { trace } = await sap.close();
  const file = trace as string;
  return { dir, file, test: parseTest(await readFile(file, "utf8")) };
}

const bare = (steps: SapTest["steps"]): SapTest => ({
  format: FORMAT,
  name: "old",
  recorded: { at: "2025-01-01T00:00:00Z", surface: "sapgui" },
  start: {},
  variables: {},
  steps,
});

describe("trace page", () => {
  test("renders a FakeSap trace: header, timeline, steps, SDK lines, inlined screenshots", async () => {
    const { dir, test: t } = await fakeTrace();
    const html = await renderTraceHtml(t, { baseDir: dir });
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<title>za03 trace</title>");
    expect(html).toContain("ABA client 800");
    expect(html).toContain("3 steps");
    expect(html).toContain('class="tl"');
    expect(html.match(/<section class="step/g)?.length).toBe(3);
    expect(html).toContain("await sap.okcode(&quot;/nZA03&quot;);");
    expect(html).toContain("ZA03 SAPMZA03/300");
    // Screenshots are data URIs; the page references no other file or host.
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from("png").toString("base64")}"`);
    expect(html).not.toMatch(/(src|href)="(https?:|\/\/|[a-z0-9_-]+\.(png|css|js))/i);
  });

  test("the same screen shows a diff against the step before; another screen says so", async () => {
    const { dir, test: t } = await fakeTrace();
    const html = await renderTraceHtml(t, { baseDir: dir });
    const step2 = html.slice(html.indexOf('id="step-2"'), html.indexOf('id="step-3"'));
    expect(step2).toContain("CHANGED 1 of");
    expect(step2).toMatch(/<span class="dc">~ wnd\[0\]\/usr\/ctxtZORD-VBELN {2}field {2}Order = &quot;5000&quot;/);
    const step3 = html.slice(html.indexOf('id="step-3"'));
    expect(step3).toContain('<pre class="diff" hidden>new screen</pre>');
    // The first step has nothing to compare with.
    const step1 = html.slice(html.indexOf('id="step-1"'), html.indexOf('id="step-2"'));
    expect(step1).not.toContain('class="tog"');
  });

  test("escapes everything that comes from SAP or the file", async () => {
    const evil = '<script>alert("x")</script>';
    const t = bare([
      {
        action: { do: "set", id: "wnd[0]/usr/txtA", value: evil },
        target: { id: "wnd[0]/usr/txtA", label: `<img src=x onerror=alert(1)>` },
        after: { title: evil, status: { type: "E", text: evil } },
        screen: `TRANSACTION X\n${evil}`,
        note: "a & b",
        ms: 5,
      },
    ]);
    t.name = evil;
    const html = await renderTraceHtml(t, { baseDir: tmpdir() });
    expect(html.match(/<script>/g)?.length).toBe(1); // the page's own
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toContain('class="status st-err"');
  });

  test("a screenshot path outside the trace's folder, or not an image, is not read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-"));
    await writeFile(join(dir, "secret.txt"), "secret");
    const html = await renderTraceHtml(bare([{ shot: "../../etc/passwd" }, { shot: "secret.txt" }]), { baseDir: join(dir) });
    expect(html).not.toContain("data:image");
  });

  test("old recordings without times, screens or code still render", async () => {
    const html = await renderTraceHtml(
      bare([{ action: { do: "okcode", value: "/nVA03" }, after: { transaction: "VA03", program: "SAPMV45A", screen: "102" } }, { expect: [{ check: "status", op: "contains", value: "saved" }] }]),
      { baseDir: tmpdir() },
    );
    expect(html).toContain("await sap.okcode(&quot;/nVA03&quot;);"); // computed from the action
    expect(html).toContain("check only");
    expect(html).toContain("expect status contains &quot;saved&quot;");
    expect(html).not.toContain("in steps");
    expect(html).not.toContain("Screen the agent saw");
    expect(await renderTraceHtml(bare([]), { baseDir: tmpdir() })).toContain("No steps.");
  });

  test("durations: recorded, total, and replay slower than recorded", async () => {
    const t = bare([
      { action: { do: "key", key: 0 }, ms: 400, at: "2025-01-01T00:00:00.000Z", risk: "navigate" },
      { action: { do: "key", key: 11 }, ms: 1200, at: "2025-01-01T00:00:01.000Z", risk: "commit" },
    ]);
    const replay: ReplayResult = {
      name: "old",
      passed: true,
      system: "ABA",
      surface: "sapgui",
      variables: {},
      ms: 5000,
      steps: [
        { n: 1, outcome: "pass", ms: 500, failures: [], warnings: [], passed: [] },
        { n: 2, outcome: "pass", ms: 3000, failures: [], warnings: [], passed: [] },
      ],
    };
    const html = await renderTraceHtml(t, { baseDir: tmpdir(), replay });
    expect(html).toContain("1.6 s in steps, 2.2 s overall");
    expect(html).toContain("replay passed in 5.0 s");
    const s1 = html.slice(html.indexOf('id="step-1"'), html.indexOf('id="step-2"'));
    const s2 = html.slice(html.indexOf('id="step-2"'));
    expect(s1).toContain("400 ms recorded");
    expect(s1).not.toContain("(slower)");
    expect(s2).toContain("3.0 s replayed (slower)");
    expect(html).toContain('<section class="step commit" id="step-2">');
    expect(s2).toContain('class="badge risk-commit"');
    expect(html).toMatch(/style="flex:1200 0 0" title="2\. await sap\.key\(11\); \(1\.2 s\)"/);
    expect(slower(100, 1000)).toBe(false); // 10x, but under a second more
    expect(slower(2000, 4100)).toBe(true);
  });
});

describe("summary", () => {
  test("per-step timings, slowest first, totals", () => {
    const t = bare([
      { action: { do: "okcode", value: "/nVA03" }, ms: 300, after: { transaction: "VA03", program: "SAPMV45A", screen: "102" } },
      { action: { do: "key", key: 0 }, ms: 900 },
      { expect: [{ check: "title", op: "contains", value: "x" }] },
    ]);
    expect(timings(t)).toEqual([
      { step: 1, action: 'await sap.okcode("/nVA03");', ms: 300, screen: "VA03 SAPMV45A/102" },
      { step: 2, action: "await sap.key(0);", ms: 900 },
      { step: 3, action: "(check)", ms: null },
    ]);
    const s = traceSummary(t);
    expect(s.totalMs).toBe(1200);
    expect(s.timed).toBe(2);
    expect(s.slowest.map((x) => x.step)).toEqual([2, 1]);
    expect(s.wallMs).toBeUndefined();
    expect([formatMs(12), formatMs(1250), formatMs(125_000)]).toEqual(["12 ms", "1.3 s", "2m 05s"]);
  });
});

describe("show-trace", () => {
  test("writes the page next to the file and prints its path; --open opens it", async () => {
    const { file } = await fakeTrace();
    const logs: string[] = [];
    const log = console.log;
    console.log = (s: string) => logs.push(s);
    const opened: string[] = [];
    try {
      expect(await showTraceCommand([file, "--open"], (p) => opened.push(p))).toBe(0);
    } finally {
      console.log = log;
    }
    const html = htmlPathFor(file);
    expect(html).toEndWith("za03-trace.html");
    expect(logs).toEqual([html]);
    expect(opened).toEqual([html]);
    expect(await readFile(html, "utf8")).toContain("za03 trace");
  });
  test("--out, and errors", async () => {
    const { dir, file } = await fakeTrace();
    const out = join(dir, "page.html");
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await showTraceCommand([file, "--out", out])).toBe(0);
      expect(await showTraceCommand([])).toBe(2);
      expect(await showTraceCommand([join(dir, "missing.saptest.json")])).toBe(1);
    } finally {
      console.log = log;
      console.error = err;
    }
    expect(await readFile(out, "utf8")).toContain("<!doctype html>");
  });
});
