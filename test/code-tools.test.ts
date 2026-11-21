/** record/code-tools.ts: the checks on code an agent saves, the gate, and running it through the runner. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { policyFromEnv } from "../src/core/guard.js";
import { Registry } from "../src/core/registry.js";
import { checkCode, codePath, commitCalls, registerCodeTools, scan, staticProblems } from "../src/record/code-tools.js";
import { exportSapTs } from "../src/record/export/sap-ts.js";
import { serializeTest } from "../src/record/format.js";
import { Recorder, recorderOptionsFromEnv } from "../src/record/recorder.js";
import { createServer } from "../src/server.js";
import { FakeSap } from "./record-fakes.js";
import { messyRun, quirkyFake, unmarkedRun } from "./tidy-fixtures.js";

const HEAD = 'import { expect, test } from "sap-gui-mcp-server/test";\n';
const wrap = (body: string) => `${HEAD}\ntest("t", async ({ sap }) => {\n${body}\n});\n`;

async function connected(server: McpServer) {
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
      return { error: r.isError === true, text: r.content.map((c) => c.text ?? "").join("\n") };
    },
  };
}

/** The code tools alone on a fake, with recordings in a temp directory. */
async function tools(fake: FakeSap, env: Record<string, string> = { SAP_WRITE: "on" }) {
  const dir = await mkdtemp(join(tmpdir(), "sap-code-"));
  const policy = policyFromEnv(env);
  const registry = new Registry([fake], policy);
  await registry.discover();
  const recorder = new Recorder({ dir, auto: false, by: "test" });
  const server = new McpServer({ name: "t", version: "0" });
  expect(registerCodeTools(server, registry, policy, recorder, undefined, { SAP_CODE_TOOLS: "on" })).toBe(true);
  return { dir, recorder, ...(await connected(server)) };
}

describe("the gate", () => {
  test("off unless SAP_CODE_TOOLS=on", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const registry = new Registry([new FakeSap()], policyFromEnv({}));
    const recorder = new Recorder({ dir: tmpdir(), auto: false, by: "test" });
    for (const env of [{}, { SAP_CODE_TOOLS: "off" }, { SAP_CODE_TOOLS: "1" }, { SAP_CODE_TOOLS: "yes" }]) expect(registerCodeTools(server, registry, policyFromEnv({}), recorder, undefined, env)).toBe(false);
    const { server: full } = createServer({ policy: policyFromEnv({}), surfaces: [new FakeSap()], record: recorderOptionsFromEnv({ SAP_RECORD_DIR: tmpdir() }, "test") });
    const { client } = await connected(full);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("sap_record");
    expect(names).not.toContain("sap_code_save");
    expect(names).not.toContain("sap_code_test");
  });
});

describe("static checks", () => {
  test("forbidden words outside strings and comments", () => {
    const bad: [string, string][] = [
      ["const e = process.env.HOME;", "process"],
      ['const fs = require("fs");', "require"],
      ['await import("node:fs");', "import()"],
      ['eval("1");', "eval"],
      ['new Function("return 1")();', "Function"],
      ["globalThis.x = 1;", "globalThis"],
      ['await fetch("https://example.com");', "fetch"],
      ['Bun.spawn(["ls"]);', "Bun"],
      ["Deno.exit();", "Deno"],
      ["const f = sap.constructor;", "constructor"],
      ["const d = await sap.registry.driver();", "registry"],
      ['sap.policy.write = "on";', "policy"],
      ['const k = "constr" + "uctor"; const f = (sap as never)[k];', "x[k]"],
      ['const f = (sap as never)["con" + "structor"];', "x["],
      ['const n = "constructor";', 'the string "constructor"'],
      ["Object.getPrototypeOf(sap);", "Object"],
    ];
    for (const [code, word] of bad) {
      const p = staticProblems(wrap(code));
      expect(p.length > 0 && p.some((x) => x.includes(word))).toBe(true);
    }
  });

  test("the same words inside strings, comments, templates and regular expressions are text", () => {
    const code = wrap(
      [
        "  // fetch the order; process it",
        '  await expect(sap.status()).toContainText("in process");',
        "  const order = await expect(sap.status()).capture(/Order (\\d+) (process|eval)/);",
        "  await expect(sap).toHaveTitle(`Display ${order}: require Function`);",
        "  const rows = [1, 2];",
        "  const first = rows[0];",
        "  return [first];",
      ].join("\n"),
    );
    expect(staticProblems(code)).toEqual([]);
    // The blanked view keeps lines.
    expect(scan(code).code.split("\n").length).toBe(code.split("\n").length);
  });

  test("imports: only expect and test from the package, named", () => {
    const one = (line: string) => staticProblems(`${line}\ntest("t", async ({ sap }) => {});\n`);
    expect(one('import { expect, test } from "sap-gui-mcp-server/test";')).toEqual([]);
    expect(one('import { test } from "sap-gui-mcp-server/test";\nimport type { Sap } from "sap-gui-mcp-server";')).toEqual([]);
    expect(one('import { test, type TestInfo } from "sap-gui-mcp-server/test";')).toEqual([]);
    expect(one('import { readFileSync } from "node:fs";')[0]).toContain('imports only from "sap-gui-mcp-server/test" or "sap-gui-mcp-server" (not "node:fs")');
    expect(one('import { exec } from "child_process";').length).toBeGreaterThan(0);
    expect(one('import { connect } from "sap-gui-mcp-server";')[0]).toContain('"connect" from "sap-gui-mcp-server" is not allowed');
    expect(one('import { test, runTests } from "sap-gui-mcp-server/test";')[0]).toContain('"runTests"');
    expect(one('import * as t from "sap-gui-mcp-server/test";')[0]).toContain("named exports only");
    expect(one('export { test } from "sap-gui-mcp-server/test";')[0]).toContain("does not re-export");
    expect(one('import "./other.js";')[0]).toContain("imports only from");
  });

  test("a syntax error is refused", async () => {
    const c = await checkCode(wrap("  await sap.okcode(;"), undefined);
    expect(c.ok).toBe(false);
    expect(c.problems[0]).toMatch(/^syntax: /);
    expect(c.checked[0]).toMatch(/^syntax \((node:module|Bun\.Transpiler)\)$/);
  });

  test("names, never paths", () => {
    for (const bad of ["../x", "a/b", "a\\b", ".hidden", "C:x", "x/../../y"]) expect(() => codePath("/r", bad)).toThrow("is not a name");
    expect(codePath("/r", "VA01 create order")).toBe("/r/va01-create-order.sap.ts");
    expect(codePath("/r", "messy create.sap.ts")).toBe("/r/messy-create.sap.ts");
  });
});

describe("commit parity", () => {
  test("finds the calls that may write", () => {
    const code = wrap(
      [
        "  await sap.save();",
        "  await sap.key(11);",
        '  await sap.key("Control+S");',
        '  await sap.key("Enter");',
        '  await sap.button("Save").press();',
        '  await sap.button("Continue").press();',
        '  await sap.press("wnd[0]/tbar[0]/btn[11]");',
        '  await sap.act({ do: "key", key: 11 });',
        '  await sap.okcode("/11");',
      ].join("\n"),
    );
    const lines = commitCalls(code).map((x) => Number(/^line (\d+)/.exec(x)?.[1]));
    expect(lines.sort((a, b) => a - b)).toEqual([4, 5, 6, 8, 10, 11, 12]);
    expect(commitCalls(code).some((x) => x.includes("Enter") || x.includes("Continue"))).toBe(false);
  });

  test("a write the recording does not have is refused; one it has is not", async () => {
    const save = wrap("  await sap.save();");
    const read = await unmarkedRun();
    const noWrite = { ...read, steps: read.steps.filter((s) => s.risk !== "commit") };
    expect((await checkCode(save, undefined)).problems.at(-1)).toContain("there is no recording of this name to compare with");
    expect((await checkCode(save, noWrite)).problems.at(-1)).toContain('the recording "unmarked create" has no write');
    expect((await checkCode(save, read)).ok).toBe(true);
    expect((await checkCode(wrap('  await sap.key("Enter");'), noWrite)).ok).toBe(true);
  });

  test("the code tidy writes passes every check against its recording", async () => {
    const t = await messyRun();
    const c = await checkCode(exportSapTs(t, { tidy: true }), t);
    expect(c.problems).toEqual([]);
    expect(c.checked.at(-1)).toBe("commit parity (1 call(s) that may write; recording has write)");
  });
});

describe("sap_code_save and sap_code_test", () => {
  test("save, then run on the active session: pass, with the trace; variables override", async () => {
    const fake = quirkyFake();
    const { dir, call } = await tools(fake);
    const t = await messyRun(quirkyFake());
    await writeFile(join(dir, "messy-create.saptest.json"), serializeTest(t));
    const code = exportSapTs(t, { tidy: true });
    const saved = await call("sap_code_save", { name: "messy create", code });
    expect(saved.error).toBe(false);
    expect(saved.text).toContain(`Saved ${join(dir, "messy-create.sap.ts")}`);
    expect(await readFile(join(dir, "messy-create.sap.ts"), "utf8")).toBe(code);
    const run = await call("sap_code_test", { name: "messy create" });
    expect(run.error).toBe(false);
    expect(run.text).toMatch(/^PASS {2}messy create/);
    expect(run.text).toMatch(/trace: .*\.saptest\.json/);
    expect(fake.orders.get("5001")?.quantity).toBe("50");
    const five = await call("sap_code_test", { name: "messy create", variables: { quantity: "5" } });
    expect(five.error).toBe(false);
    expect(fake.orders.get("5002")?.quantity).toBe("5");
  });

  test("a failure says the line, the step, the screen and the trace", async () => {
    const fake = new FakeSap();
    const { call } = await tools(fake);
    const code = wrap(
      [
        '  await sap.step("Display order", async () => {',
        '    await sap.okcode("/nZA03");',
        '    await sap.set("ctxtZORD-VBELN", "9999");',
        '    await sap.key("Enter");',
        "    await expect(sap.status(), { timeout: 200 }).toBeSuccess();",
        "  });",
      ].join("\n"),
    );
    expect((await call("sap_code_save", { name: "display", code })).error).toBe(false);
    const r = await call("sap_code_test", { name: "display" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/^FAILED {2}t/);
    expect(r.text).toContain('error: expect(status bar).toBeSuccess(): the status bar is E: "Order 9999 does not exist"');
    expect(r.text).toContain("line 8: await expect(sap.status(), { timeout: 200 }).toBeSuccess();");
    expect(r.text).toContain("step: Display order");
    expect(r.text).toMatch(/trace: .*\.saptest\.json/);
    expect(r.text).toContain("Screen now:");
  });

  test("verified against the lock next to the saved file: the first pass writes it, a drift is reported with the screen", async () => {
    const fake = new FakeSap();
    const { dir, call } = await tools(fake);
    const code = wrap(['  await sap.step("Display", async () => {', '    await sap.okcode("/nZA03");', '    await sap.set("ctxtZORD-VBELN", "5000");', '    await sap.key("Enter");', "  });"].join("\n"));
    expect((await call("sap_code_save", { name: "display", code })).error).toBe(false);
    const lockFile = join(dir, "display.sap.lock.json");
    const first = await call("sap_code_test", { name: "display" });
    expect(first.error).toBe(false);
    expect(first.text).toContain(`lock: 0 action(s) as the lock has them, 3 new; written to ${lockFile}`);
    const second = await call("sap_code_test", { name: "display" });
    expect(second.text).toContain(`lock: 3 action(s) as the lock has them, 0 new; written to ${lockFile}`);

    fake.popupsFor.set("5000", [{ title: "Proceed", text: "Display the order anyway?", question: true }]);
    const r = await call("sap_code_test", { name: "display" });
    expect(r.error).toBe(true);
    expect(r.text).toContain('error: Drift in step "Display", action 3 (await sap.key("Enter");');
    expect(r.text).toContain(`at ${join(dir, "display.sap.ts")}:7`);
    expect(r.text).toContain('drift: step "Display", action 3 await sap.key("Enter"); (landing)');
    expect(r.text).toContain(`lock: ${lockFile}`);
    expect(r.text).toContain("Screen now:");
    expect(r.text).toContain("Display the order anyway?");
    expect(r.text).not.toContain(".sap-code-runs");
  });

  test("the server's write policy holds, whatever the test asks for", async () => {
    const fake = new FakeSap();
    const { dir, call } = await tools(fake, { SAP_WRITE: "off" });
    const t = await unmarkedRun();
    await writeFile(join(dir, "unmarked-create.saptest.json"), serializeTest(t));
    const code = `${HEAD}\ntest.use({ write: "on" });\ntest("t", { use: { write: "on" } }, async ({ sap }) => {\n  await sap.okcode("/nZA01");\n  await sap.set("ctxtZORD-KUNNR", "2200");\n  await sap.key("Enter");\n  await sap.save();\n});\n`;
    expect((await call("sap_code_save", { name: "unmarked create", code })).error).toBe(false);
    const r = await call("sap_code_test", { name: "unmarked create" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("may write to SAP (key 11: Save) and writes are off");
    expect(fake.orders.size).toBe(1);
  });

  test("refusals: forbidden code, a path, a write without one recorded, an unknown test", async () => {
    const { call } = await tools(new FakeSap());
    const bad = await call("sap_code_save", { name: "x", code: wrap("  const e = process.env;") });
    expect(bad.error).toBe(true);
    expect(bad.text).toContain('Not saved: 1 problem(s).\n- line 4: "process" is not allowed in a test');
    expect((await call("sap_code_save", { name: "../x", code: wrap("") })).text).toContain("is not a name");
    const w = await call("sap_code_save", { name: "y", code: wrap("  await sap.save();") });
    expect(w.text).toContain("there is no recording of this name to compare with");
    expect((await call("sap_code_test", { name: "nothing" })).text).toContain('No test "nothing"');
  });
});

describe("sap_record code with tidy", () => {
  test("answers the tidied draft, the removal log and the TODO list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sap-code-rec-"));
    await writeFile(join(dir, "messy-create.saptest.json"), serializeTest(await messyRun()));
    const { server } = createServer({ policy: policyFromEnv({}), surfaces: [new FakeSap()], record: recorderOptionsFromEnv({ SAP_RECORD_DIR: dir }, "test") });
    const { call } = await connected(server);
    const r = await call("sap_record", { op: "code", tidy: true, name: "messy create" });
    expect(r.error).toBe(false);
    expect(r.text).toContain('await sap.step("Create Order: Initial Screen", async () => {');
    expect(r.text).toContain("Changes (tidy):\n- 23 steps -> 13");
    expect(r.text).toContain("TODO:\n- Typed values became variables");
    expect(r.text).toContain("Not verified on a system");
    expect((await call("sap_record", { op: "code", tidy: true })).text).toContain("needs a recording");
  });
});
