import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { policyFromEnv } from "../src/core/guard.js";
import { exportCommand, replayCommand } from "../src/record/cli.js";
import { exportTest, toCalm } from "../src/record/export/index.js";
import { tsString } from "../src/record/export/playwright.js";
import { vbsString, vkeyNumber } from "../src/record/export/vbs.js";
import { fill, FORMAT, inputsOf, parseTest, type SapTest, slug, withVariable } from "../src/record/format.js";
import { hints, recorderOptionsFromEnv, stepLine } from "../src/record/recorder.js";
import { detour, junit, replay, replayAll, resultText, slowerNote, type StepResult } from "../src/record/replay.js";
import { locate, parseScreen } from "../src/record/screen.js";
import { connect } from "../src/sdk/index.js";
import { createServer } from "../src/server.js";
import { FakeSap } from "./record-fakes.js";

const SCREEN = [
  "TRANSACTION VA03  PROGRAM SAPMV45A  SCREEN 4001  SYSTEM ABA (800) host",
  'WINDOW wnd[0]  "Display Standard Order 19097: Overview"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  "wnd[0]/tbar[1]/btn[5]  button  Display document flow (F5)",
  'wnd[0]/usr/subHEAD:SAPMV45A:4021/ctxtVBAK-VBELN  field  Standard Order = "19097"  (read-only)',
  'wnd[0]/usr/subHEAD:SAPMV45A:4021/txtVBAK-NETWR  field  Net value = "2.500,00"  (read-only)',
  "wnd[0]/usr/subHEAD:SAPMV45A:4021/chkVBAK-AUTLF  checkbox  [x] Complete dlv.",
  "wnd[0]/usr/tabsTAXI/tabpT\\01  tab  Sales (selected)",
  "wnd[0]/usr/tabsTAXI/tabpT\\02  tab  Item overview",
  'wnd[0]/usr/tabsTAXI/tabpT\\01/cmbVBAK-LIFSK  dropdown  Delivery block = "01" Credit limit  options: 01:Credit limit',
  'wnd[0]/usr/tabsTAXI/tabpT\\01/tblITEMS  table  rows 5 (visible 5) "All items"; columns: Item | Material | Order Quantity',
  'wnd[0]/usr/tabsTAXI/tabpT\\01/tblITEMS/ctxtRV45A-MABNR[1,0]  field   = "M-08"  (read-only)',
  "wnd[0]/sbar  status  S: Order 19097 has been saved",
  "mbar  menubar  Sales document {menu[0]}",
].join("\n");

describe("reading a screen from its text view", () => {
  const s = parseScreen(SCREEN);
  test("header, top window title and status bar", () => {
    expect([s.transaction, s.program, s.screen, s.system, s.title]).toEqual(["VA03", "SAPMV45A", "4001", "ABA (800) host", "Display Standard Order 19097: Overview"]);
    expect(s.status).toEqual({ type: "S", text: "Order 19097 has been saved" });
  });
  test("a control's label and value, by kind", () => {
    const of = (id: string) => {
      const c = locate(s, id)?.control;
      return [c?.type, c?.label, c?.value];
    };
    expect(of("txtVBAK-NETWR")).toEqual(["field", "Net value", "2.500,00"]);
    expect(of("chkVBAK-AUTLF")).toEqual(["checkbox", "Complete dlv.", "true"]);
    expect(of("tabpT\\01")).toEqual(["tab", "Sales", "selected"]);
    expect(of("tabpT\\02")).toEqual(["tab", "Item overview", ""]);
    expect(of("cmbVBAK-LIFSK")).toEqual(["dropdown", "Delivery block", "01"]);
    // A table cell takes its column's title.
    expect(of("ctxtRV45A-MABNR[1,0]")).toEqual(["field", "Material, row 1", "M-08"]);
  });
  test("the title is the popup's while one is open", () => {
    const p = parseScreen(`${SCREEN}\nWINDOW wnd[1]  "Information"\nwnd[1]/usr/txtMESSTXT1  label  No data`);
    expect(p.title).toBe("Information");
  });
  test("the logon screen is recognised", () => {
    expect(parseScreen('TRANSACTION   PROGRAM SAPMSYST  SCREEN \nWINDOW wnd[0]  "SAP"\nNOTE this is the SAP logon screen. Log on yourself.').logon).toBe(true);
  });
  test("Fiori: the intent, and toasts as the status", () => {
    const f = parseScreen('FIORI  SalesOrder-display  system S4H/100  user X\n  Button "Go" id=btnGo\nTOAST "Sales order 12 saved"');
    expect([f.transaction, f.system, f.status?.text]).toEqual(["SalesOrder-display", "S4H/100", "Sales order 12 saved"]);
  });
});

describe("finding a control again", () => {
  const s = parseScreen(SCREEN);
  test("by its recorded id, or by a short id", () => {
    expect(locate(s, "wnd[0]/usr/subHEAD:SAPMV45A:4021/txtVBAK-NETWR")?.by).toBe("exact");
    expect(locate(s, "txtVBAK-NETWR")?.by).toBe("exact");
  });
  test("by its last segment when the subscreen around it changed", () => {
    const l = locate(s, "wnd[0]/usr/subOTHER:SAPMV45A:9999/txtVBAK-NETWR");
    expect([l?.by, l?.control.id]).toEqual(["segment", "wnd[0]/usr/subHEAD:SAPMV45A:4021/txtVBAK-NETWR"]);
  });
  test("by its field name when the control type changed (txt to ctxt)", () => {
    expect(locate(s, "wnd[0]/usr/ctxtVBAK-NETWR")?.by).toBe("name");
  });
  test("a numbered button elsewhere is another button, not a moved one", () => {
    expect(locate(s, "wnd[0]/tbar[1]/btn[3]")).toBeUndefined();
    expect(locate(s, "wnd[1]/tbar[0]/btn[5]")).toBeUndefined();
  });
  test("an unknown control is not found", () => {
    expect(locate(s, "wnd[0]/usr/ctxtVBAK-XXXXX")).toBeUndefined();
  });
});

describe("variables", () => {
  test("a value becomes a variable only where it stands alone", () => {
    expect(withVariable("Order 19097 saved, not 219097 or 19097X", "order", "19097")).toBe("Order ${order} saved, not 219097 or 19097X");
    expect(withVariable("2.500,00", "v", "2.500,00")).toBe("${v}");
  });
  test("an unknown variable is an error, never an empty string", () => {
    expect(fill("a ${x} b", { x: "1" })).toBe("a 1 b");
    expect(() => fill("${y}", {})).toThrow("variable ${y} has no value");
  });
  test("a file name cannot leave the directory", () => {
    expect(slug("../../etc/passwd")).toBe("etc-passwd");
    expect(() => slug("../..")).toThrow();
  });
  test("a file with an action the server would refuse is refused", () => {
    const t = { format: FORMAT, name: "x", recorded: { at: "now", surface: "webgui" }, start: {}, variables: {}, steps: [{ action: { do: "eval", id: "x" } }] };
    expect(() => parseTest(JSON.stringify(t))).toThrow("step 1");
    expect(() => parseTest("{}")).toThrow(`not a ${FORMAT} file`);
  });
});

// ---- recording through the MCP server ---------------------------------------

async function setup(env: Record<string, string> = {}, sap = new FakeSap()) {
  const dir = await mkdtemp(join(tmpdir(), "saprec-"));
  const record = recorderOptionsFromEnv({ SAP_RECORD_DIR: dir, ...env }, "test");
  record.now = () => new Date("2026-01-02T03:04:05Z");
  const policy = policyFromEnv(env);
  const { server } = createServer({ policy, surfaces: [sap], record });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { error: r.isError === true, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  const act = (action: Record<string, unknown>) => call("sap_act", { action });
  const rec = (op: string, more: Record<string, unknown> = {}) => call("sap_record", { op, ...more });
  const file = async (name: string) => parseTest(await readFile(join(dir, name), "utf8"));
  return { sap, dir, policy, call, act, rec, file };
}

/** Records "create an order, then display it" and returns the test. */
async function recordCreateAndDisplay(env: Record<string, string> = { SAP_WRITE: "on" }) {
  const s = await setup(env);
  await s.rec("start", { name: "Create and display" });
  await s.act({ do: "okcode", value: "/nZA01" });
  await s.act({ do: "set", id: "ctxtZORD-KUNNR", value: "2200" });
  await s.act({ do: "set", id: "txtZORD-MENGE", value: "7" });
  await s.act({ do: "key", key: 0 });
  await s.act({ do: "key", key: 11 });
  await s.rec("assert", { check: "status", contains: "has been saved" });
  await s.rec("capture", { name: "order", from: "status", pattern: "Order (\\d+)" });
  await s.act({ do: "okcode", value: "/nZA03" });
  await s.act({ do: "set", id: "ctxtZORD-VBELN", value: "5001" });
  await s.act({ do: "key", key: 0 });
  await s.rec("assert", { check: "field", id: "ctxtZORD-KUNNR", equals: "2200" });
  await s.act({ do: "select", id: "tabpT\\02" });
  await s.rec("assert", { check: "field", id: "txtZPOS-MENGE[2,0]" });
  await s.rec("variable", { name: "customer", value: "2200", description: "a customer of sales area 1000" });
  const stop = await s.rec("stop");
  return { ...s, stop, test: await s.file("create-and-display.saptest.json") };
}

describe("sap_record", () => {
  test("nothing is recorded before start, and the tool says so", async () => {
    const { act, rec, dir } = await setup();
    await act({ do: "okcode", value: "/nZA03" });
    expect((await rec("status")).text).toContain("No recording is on");
    expect((await rec("assert", { check: "title", contains: "x" })).error).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  test("each action that works is a step, with the control, the screens and the status bar", async () => {
    const { test: t, stop } = await recordCreateAndDisplay();
    expect(t.recorded).toEqual({ at: "2026-01-02T03:04:05.000Z", by: "test", surface: "webgui", system: "ABA", client: "800" });
    expect(t.steps.length).toBe(9);
    expect(t.steps[1]).toMatchObject({
      action: { do: "set", id: "ctxtZORD-KUNNR", value: "${customer}" },
      target: { id: "wnd[0]/usr/ctxtZORD-KUNNR", type: "field", label: "Customer" },
      risk: "navigate",
      on: { transaction: "ZA01", program: "SAPMZA01", screen: "100" },
    });
    expect(t.steps[4]).toMatchObject({ action: { do: "key", key: 11 }, risk: "commit", after: { screen: "100", status: { type: "S", text: "Order ${order} has been saved" } } });
    expect(stop.text).toContain("Recorded");
  });

  test("a screen read while SAP is still working on the step is not what the step led to (NEW-4)", async () => {
    const sap = new FakeSap();
    const { act, rec, file, policy } = await setup({}, sap);
    await rec("start", { name: "late" });
    sap.lag = 2;
    await act({ do: "okcode", value: "/nZA03" });
    await act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    await act({ do: "key", key: 0 });
    sap.lag = 0;
    await rec("stop");
    const t = await file("late.saptest.json");
    // Not SMEN, the screen the okcode was typed on.
    expect(t.steps.map((s) => `${s.after?.transaction} ${s.after?.program}/${s.after?.screen}`)).toEqual(["ZA03 SAPMZA03/100", "ZA03 SAPMZA03/100", "ZA03 SAPMZA03/300"]);
    // And the replay waits the same way before it compares.
    sap.lag = 2;
    const r = await replay(sap.driver(), policy, t);
    expect(resultText(r).split("\n")[0]).toStartWith("PASS  late");
  });

  test("a captured value is the variable in the steps after it, and not in the step that made it", async () => {
    const { test: t } = await recordCreateAndDisplay();
    expect(t.variables.order?.value).toBe("5001");
    expect(t.steps[4]?.capture).toEqual([{ var: "order", from: "status", pattern: "Order (\\d+)" }]);
    expect(t.steps[6]?.action).toMatchObject({ do: "set", value: "${order}" });
    // A declared variable is written everywhere, also in steps recorded before it.
    expect(t.steps[8]?.expect ?? t.steps[7]?.expect).toBeDefined();
    expect(t.steps[7]?.expect?.[0]).toMatchObject({ check: "field", id: "wnd[0]/usr/subHEAD:SAPMZA03:0301/ctxtZORD-KUNNR", label: "Customer", op: "equals", value: "${customer}" });
    // "This field, as it is now."
    expect(t.steps[8]?.expect?.[0]).toMatchObject({ label: "Quantity, row 1", op: "equals", value: "7" });
    // The test needs only the customer from outside: the order is made by step 5.
    expect(inputsOf(t)).toEqual(["customer"]);
  });

  test("a check that does not hold now is refused, with what is there", async () => {
    const { act, rec, file } = await setup();
    await rec("start", { name: "t" });
    await act({ do: "okcode", value: "/nZA03" });
    const r = await rec("assert", { check: "title", equals: "Something else" });
    expect(r.error).toBe(true);
    expect(r.text).toContain('it is "Display Order: Initial Screen"');
    expect((await rec("assert", { check: "field", id: "ctxtNOPE" })).text).toContain("No control ctxtNOPE");
    expect((await file("t.saptest.json")).steps[0]?.expect).toBeUndefined();
  });

  test("an action that fails or is refused is not a step", async () => {
    const { act, rec, file } = await setup(); // SAP_WRITE off
    await rec("start", { name: "t" });
    await act({ do: "okcode", value: "/nZA01" });
    expect((await act({ do: "press", id: "btnNOPE" })).error).toBe(true);
    expect((await act({ do: "key", key: 11 })).text).toContain("writes are off");
    expect((await file("t.saptest.json")).steps.map((s) => s.action?.do)).toEqual(["okcode"]);
  });

  test('{"op":"code"} is the recording so far as a *.sap.ts test', async () => {
    const { act, rec } = await setup();
    await rec("start", { name: "Draft so far" });
    await act({ do: "okcode", value: "/nZA03" });
    await act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    await rec("variable", { name: "order", value: "5000" });
    const r = await rec("code");
    expect(r.error).toBe(false);
    expect(r.text).toContain('test("Draft so far", async ({ sap }) => {');
    expect(r.text).toContain('  await sap.set("ctxtZORD-VBELN", vars.order);');
  });

  test("undo drops the last step and the variable it captured", async () => {
    const { act, rec, file } = await setup({ SAP_WRITE: "on" });
    await rec("start", { name: "t" });
    await act({ do: "okcode", value: "/nZA03" });
    await act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    await rec("capture", { name: "typed", from: "field", id: "ctxtZORD-VBELN" });
    expect((await rec("undo")).text).toContain("SAP was not touched");
    const t = await file("t.saptest.json");
    expect([t.steps.length, Object.keys(t.variables)]).toEqual([1, []]);
  });

  test("the file is written after every step, and a second recording of the name needs replace", async () => {
    const { act, rec, file } = await setup();
    await rec("start", { name: "Same name" });
    await act({ do: "okcode", value: "/nZA03" });
    expect((await file("same-name.saptest.json")).steps.length).toBe(1);
    expect((await rec("start", { name: "other" })).text).toContain("already on");
    await rec("stop");
    expect((await rec("start", { name: "Same name" })).text).toContain("exists");
    expect((await rec("start", { name: "Same name", replace: true })).error).toBe(false);
  });

  test("SAP_RECORD=on records from the first action, without start", async () => {
    const { act, dir } = await setup({ SAP_RECORD: "on" });
    await act({ do: "okcode", value: "/nZA03" });
    const files = await readdir(dir);
    expect(files).toEqual(["session-20260102t030405.saptest.json"]);
  });

  test("hints at the end: fixed typed values, and no check", async () => {
    const { act, rec } = await setup();
    await rec("start", { name: "t" });
    await act({ do: "okcode", value: "/nZA03" });
    await act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    const r = await rec("stop");
    expect(r.text).toContain('"5000" (Order)');
    expect(r.text).toContain("No check was marked");
  });

  test("a document number in the status bar that later steps use is pointed out", () => {
    const t: SapTest = {
      format: FORMAT,
      name: "x",
      recorded: { at: "", surface: "webgui" },
      start: {},
      variables: {},
      steps: [{ action: { do: "key", key: 11 }, after: { status: { type: "S", text: "Order 50017 saved" } } }, { action: { do: "set", id: "a", value: "50017" } }],
    };
    expect(hints(t).join("\n")).toContain("Step 1's status bar holds 50017");
  });
});

// ---- replay -------------------------------------------------------------------

describe("replay", () => {
  test("runs the same actions with no model and passes; a created document flows to the later steps", async () => {
    const { test: t, sap, policy } = await recordCreateAndDisplay();
    sap.acts = [];
    const r = await replay(sap.driver(), policy, t);
    expect(resultText(r)).toContain("PASS");
    expect(r.passed).toBe(true);
    // The replay created order 5002 and displayed that one, not the recorded 5001.
    expect(r.variables.order).toBe("5002");
    expect(sap.acts.find((a) => a.id === "ctxtZORD-VBELN")?.value).toBe("5002");
    expect(r.steps.every((s) => s.outcome === "pass")).toBe(true);
  });

  test("other data through variables; the check follows the variable", async () => {
    const { test: t, sap, policy } = await recordCreateAndDisplay();
    const r = await replay(sap.driver(), policy, t, { variables: { customer: "3300" } });
    expect(r.passed).toBe(true);
    expect(r.steps[7]?.passed[0]).toContain('"Customer" (wnd[0]/usr/subHEAD:SAPMZA03:0301/ctxtZORD-KUNNR) is "3300"');
    const bad = await replay(sap.driver(), policy, t, { variables: { nope: "1" } });
    expect(bad.aborted).toContain("no variable ${nope}");
  });

  test("an SAP error fails the step, skips the rest, and gives the screen there", async () => {
    const { rec, act, file, sap, policy } = await setup();
    await rec("start", { name: "d" });
    await act({ do: "okcode", value: "/nZA03" });
    await act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    await rec("variable", { name: "order", value: "5000" });
    await act({ do: "key", key: 0 });
    await rec("assert", { check: "field", id: "chkZORD-RUSH", equals: "true" });
    await act({ do: "key", key: 3 });
    await rec("stop");
    const t = await file("d.saptest.json");
    const r = await replay(sap.driver(), policy, t, { variables: { order: "999" } });
    expect(r.passed).toBe(false);
    expect(r.steps.map((s) => s.outcome)).toEqual(["pass", "pass", "fail", "skipped"]);
    expect(r.steps[2]?.failures[0]).toBe("SAP reported an error in the status bar: Order 999 does not exist");
    expect(r.steps[2]?.failures[1]).toContain("landed on another screen: ZA03 SAPMZA03/100");
    // The marked checks are not run on the wrong screen: they would only repeat the failure.
    expect(r.steps[2]?.failures.length).toBe(2);
    expect(r.screen).toContain("status  E: Order 999 does not exist");
    // After a failure the replay leaves the transaction.
    expect(sap.transaction).toBe("SMEN");
    expect(junit([r])).toContain('<testsuite name="d" tests="4" failures="1" errors="0" skipped="1"');
    expect(resultText(r)).toContain("Screen at the failure:");
  });

  test("a failed check fails the step", async () => {
    const { test: t, sap, policy } = await recordCreateAndDisplay();
    t.steps[7]!.expect![0]!.value = "9999";
    const r = await replay(sap.driver(), policy, t);
    expect(r.steps[7]?.outcome).toBe("fail");
    expect(r.steps[7]?.failures[0]).toContain('is not "9999" (it is "2200")');
  });

  test("a field that moved to another subscreen is found by its name, and the step says so", async () => {
    const { test: t, sap, policy } = await recordCreateAndDisplay();
    sap.moved = true;
    const r = await replay(sap.driver(), policy, t);
    expect(r.passed).toBe(true);
    expect(r.steps[7]?.warnings[0]).toContain("was found as wnd[0]/usr/subNEW:SAPMZA03:0310/ctxtZORD-KUNNR");
  });

  test("a step that may write is refused unless writes are on", async () => {
    const { test: t, sap } = await recordCreateAndDisplay();
    const before = sap.orders.size;
    const r = await replay(sap.driver(), policyFromEnv({}), t);
    expect(r.steps[4]?.outcome).toBe("fail");
    expect(r.steps[4]?.failures[0]).toContain("writes are off");
    expect(sap.orders.size).toBe(before);
    const c = await replay(sap.driver(), policyFromEnv({ SAP_WRITE: "confirm" }), t);
    expect(c.steps[4]?.failures[0]).toContain("SAP_WRITE=on");
    expect(sap.orders.size).toBe(before);
  });

  test("the transaction lists apply to a replay", async () => {
    const { test: t, sap } = await recordCreateAndDisplay();
    const r = await replay(sap.driver(), policyFromEnv({ SAP_WRITE: "on", SAP_BLOCK_TCODES: "ZA01" }), t);
    expect(r.steps[0]?.failures[0]).toContain("transaction ZA01 is blocked");
  });

  test("another screen than recorded fails in strict mode and is a note in loose mode", async () => {
    const { test: t, sap, policy } = await recordCreateAndDisplay();
    t.steps[3]!.after!.screen = "250";
    expect((await replay(sap.driver(), policy, t)).steps[3]?.outcome).toBe("fail");
    const loose = await replay(sap.driver(), policy, t, { screens: "loose" });
    expect(loose.passed).toBe(true);
    expect(loose.steps[3]?.warnings[0]).toContain("landed on another screen");
  });

  test("a recording that does not start with an okcode is started from its transaction", async () => {
    const { act, rec, file, sap, policy } = await setup();
    await act({ do: "okcode", value: "/nZA03" });
    await rec("start", { name: "mid" });
    await act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    await act({ do: "key", key: 0 });
    await rec("stop");
    sap.acts = [];
    const r = await replay(sap.driver(), policy, await file("mid.saptest.json"));
    expect(r.passed).toBe(true);
    expect(sap.acts[0]).toEqual({ do: "okcode", value: "/nZA03" });
  });

  test("a recording of another surface is not run", async () => {
    const { test: t, policy } = await recordCreateAndDisplay();
    const r = await replay(new FakeSap("fiori").driver(), policy, t);
    expect(r.aborted).toContain("recorded on webgui");
  });

  test("two tests in a row: what the first captures, the second uses", async () => {
    const { test: t, sap, policy } = await recordCreateAndDisplay();
    const create: SapTest = { ...t, name: "create", steps: t.steps.slice(0, 5) };
    const display: SapTest = { ...t, name: "display", steps: t.steps.slice(5), variables: { order: { value: "5000" }, customer: { value: "2200" } } };
    const rs = await replayAll(sap.driver(), policy, [create, display], { variables: { customer: "4400" } });
    expect(rs.map((r) => r.passed)).toEqual([true, true]);
    expect(rs[1]?.variables.order).toBe(rs[0]?.variables.order as string);
    expect(rs[1]?.variables.order).not.toBe("5000");
  });

  test("sap_replay: by name, with variables, and the failure as an error result", async () => {
    const { call, test: t } = await recordCreateAndDisplay();
    expect(t.name).toBe("Create and display");
    const ok = await call("sap_replay", {});
    expect([ok.error, ok.text.split("\n")[0]]).toEqual([false, expect.stringContaining("PASS  Create and display  on webgui ABA/800  (9/9 steps")]);
    const missing = await call("sap_replay", { name: "nope" });
    expect(missing.text).toContain('No recording "nope"');
    const escape = await call("sap_replay", { name: "../../etc/passwd" });
    expect(escape.text).toContain("etc-passwd.saptest.json");
  });
});

// ---- windows the recording does not have ---------------------------------------

/** Records "display order 5000" (no popup) and returns the test, with order as a variable. */
async function recordDisplay() {
  const s = await setup();
  await s.rec("start", { name: "display" });
  await s.act({ do: "okcode", value: "/nZA03" });
  await s.act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
  await s.act({ do: "key", key: 0 });
  await s.rec("variable", { name: "order", value: "5000" });
  await s.act({ do: "key", key: 3 });
  await s.rec("stop");
  return { ...s, test: await s.file("display.saptest.json") };
}

describe("replay: windows the recording does not have", () => {
  const info = { title: "Information", text: "Consider the subsequent documents" };
  const question = { title: "Exit display", text: "Do you wish to save your data first?", question: true };

  test("Information popups SAP shows for other data are confirmed and noted", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    sap.orders.set("4990", { customer: "1000", quantity: "1", rush: false });
    sap.popupsFor.set("4990", [info, { ...info, text: "Order is blocked for delivery" }]);
    sap.acts = [];
    const r = await replay(sap.driver(), policy, t, { variables: { order: "4990" } });
    expect(resultText(r)).toContain("PASS");
    expect(r.steps[2]?.warnings).toEqual([
      'SAP showed a popup "Information" (Consider the subsequent documents) that the recording does not have: the replay pressed Continue (Enter)',
      'SAP showed a popup "Information" (Order is blocked for delivery) that the recording does not have: the replay pressed Continue (Enter)',
    ]);
    expect(sap.acts.filter((a) => a.id === "wnd[1]/tbar[0]/btn[0]").length).toBe(2);
  });

  test("a popup that asks a question is not answered: the step fails and says why", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    sap.orders.set("4990", { customer: "1000", quantity: "1", rush: false });
    sap.popupsFor.set("4990", [question]);
    sap.acts = [];
    const r = await replay(sap.driver(), policy, t, { variables: { order: "4990" }, leaveOnFailure: false });
    expect(r.passed).toBe(false);
    expect(r.steps[2]?.failures[0]).toStartWith('SAP showed a popup "Exit display" (Do you wish to save your data first?) that the recording does not have here.');
    expect(sap.acts.some((a) => /SPOP-OPTION/.test(String(a.id)))).toBe(false);
  });

  test("detour: an Information popup passes; a question, a choice or an input stops", () => {
    const pop = (lines: string[]) =>
      parseScreen(["TRANSACTION VA02  PROGRAM SAPMV45A  SCREEN 102", 'WINDOW wnd[0]  "Change Order"', 'WINDOW wnd[1]  "Information"', ...lines].join("\n"));
    const go = "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)";
    expect(detour(pop(["wnd[1]/usr/txtMESSTXT1  label  Consider the subsequent documents", go]))?.kind).toBe("pass");
    expect(detour(pop(["wnd[1]/usr/txtMESSTXT1  label  Save first?", go]))?.kind).toBe("stop");
    expect(detour(pop(["wnd[1]/usr/btnSPOP-OPTION1  button  Yes", go]))?.kind).toBe("stop");
    expect(detour(pop(['wnd[1]/usr/ctxtX-PLANT  field  Plant = ""  (edit)', go]))?.kind).toBe("stop");
    expect(detour(pop(["wnd[1]/usr/tblX  table  rows 3 (visible 3)", go]))?.kind).toBe("stop");
    expect(detour(pop(["wnd[1]/usr/txtMESSTXT1  label  No Continue button"]))?.kind).toBe("stop");
    expect(detour(parseScreen('TRANSACTION VA03  PROGRAM SAPMV45A  SCREEN 4001\nWINDOW wnd[0]  "Display Order"'))).toBeUndefined();
  });

  test("the availability control screen is a choice: the replay stops unless asked to continue", async () => {
    const s = await setup({ SAP_WRITE: "on" });
    await s.rec("start", { name: "create" });
    await s.act({ do: "okcode", value: "/nZA01" });
    await s.act({ do: "set", id: "ctxtZORD-KUNNR", value: "2200" });
    await s.act({ do: "set", id: "txtZORD-MENGE", value: "7" });
    await s.rec("variable", { name: "qty", value: "7" });
    await s.act({ do: "key", key: 0 });
    await s.act({ do: "key", key: 11 });
    await s.rec("assert", { check: "status", contains: "has been saved" });
    await s.rec("stop");
    const t = await s.file("create.saptest.json");
    s.sap.available = 100;
    // By default the replay does not choose: the step fails, names the ways on, and nothing is pressed or saved.
    s.sap.acts = [];
    const stop = await replay(s.sap.driver(), s.policy, t, { variables: { qty: "500" }, leaveOnFailure: false });
    expect(stop.passed).toBe(false);
    expect(stop.steps[3]?.outcome).toBe("fail");
    expect(stop.steps[3]?.failures[0]).toStartWith('SAP showed an availability control screen "Create Order: Availability Control" that the recording does not have here. It offers a choice (');
    expect(stop.steps[3]?.failures[0]).toContain('so the replay pressed nothing');
    expect(stop.steps[3]?.failures[0]).toContain('"choices":"continue"');
    expect(stop.steps[4]?.outcome).toBe("skipped");
    expect(s.sap.acts.filter((x) => x.do === "press").length).toBe(0);
    expect(resultText(stop)).toStartWith("FAIL");
    // Asked to continue, it presses the neutral way on and the first line says the run differed.
    const r = await replay(s.sap.driver(), s.policy, t, { variables: { qty: "500" }, choices: "continue" });
    expect(r.passed).toBe(true);
    expect(r.steps[3]?.warnings[0]).toBe(
      'SAP showed an availability control screen "Create Order: Availability Control" that the recording does not have: the replay pressed Continue (Enter), as "choices":"continue" asked; what was saved may differ from the recording',
    );
    expect(resultText(r).split("\n")[0]).toContain('WITH NOTES: this run differed from the recording at step 4 (see "note:" below)');
  });

  test("a run like the recording has a plain first line", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    const r = await replay(sap.driver(), policy, t);
    expect(r.passed).toBe(true);
    expect(resultText(r).split("\n")[0]).not.toContain("WITH NOTES");
  });

  test("a recording started with a popup open says that the popup is not part of it", async () => {
    const s = await setup();
    s.sap.popupsFor.set("5000", [info]);
    await s.act({ do: "okcode", value: "/nZA03" });
    await s.act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    await s.act({ do: "key", key: 0 });
    expect((await s.rec("start", { name: "late" })).text).toContain('A popup is open ("Information"): a replay closes any popup before its first step');
    await s.rec("stop");
    await s.act({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" });
    expect((await s.rec("start", { name: "clean" })).text).not.toContain("A popup is open");
  });

  test("a popup the recording confirmed but SAP does not show this time: the step is skipped", async () => {
    const s = await setup();
    s.sap.popupsFor.set("5000", [info]);
    await s.rec("start", { name: "with popup" });
    await s.act({ do: "okcode", value: "/nZA03" });
    await s.act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    await s.act({ do: "key", key: 0 });
    await s.act({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" });
    await s.rec("stop");
    const t = await s.file("with-popup.saptest.json");
    s.sap.popupsFor.clear();
    const r = await replay(s.sap.driver(), s.policy, t);
    expect(r.passed).toBe(true);
    expect(r.steps[3]?.warnings[0]).toContain("that SAP did not show this time: its answer was not sent");
  });

  test("a replay can start with a popup open: an Information popup is confirmed, a question cancelled", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    sap.popups = [info];
    const a = await replay(sap.driver(), policy, t);
    expect(a.passed).toBe(true);
    expect(resultText(a)).toContain('Before step 1: popup "Information" (Consider the subsequent documents) was open: pressed Continue (Enter).');
    sap.popups = [question];
    sap.acts = [];
    const b = await replay(sap.driver(), policy, t);
    expect(b.passed).toBe(true);
    expect(sap.acts[0]).toEqual({ do: "key", key: 12 });
    expect(b.before?.[0]).toContain("cancelled it (key 12)");
  });

  test("an error after Enter fails the step, also when the recording ended on another error", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    const r = await replay(sap.driver(), policy, t, { variables: { order: "999" }, leaveOnFailure: false });
    expect(r.steps[2]?.failures[0]).toBe("SAP reported an error in the status bar: Order 999 does not exist");
    // Recorded on an error: the same error (variables filled in) passes, another one fails.
    t.steps[2]!.after!.status = { type: "E", text: "Order ${order} does not exist" };
    t.steps[2]!.after!.screen = "100";
    t.steps[2]!.after!.title = "Display Order: Initial Screen";
    const same = await replay(sap.driver(), policy, { ...t, steps: t.steps.slice(0, 3) }, { variables: { order: "998" } });
    expect(same.passed).toBe(true);
    t.steps[2]!.after!.status = { type: "E", text: "Enter an order number" };
    const other = await replay(sap.driver(), policy, { ...t, steps: t.steps.slice(0, 3) }, { variables: { order: "998" } });
    expect(other.steps[2]?.failures[0]).toBe("SAP reported an error in the status bar: Order 998 does not exist");
  });

  test("each step's time, and the recorded one; a step much slower than recorded is said, never failed", async () => {
    const { test: t, sap, policy, rec } = await recordDisplay();
    expect(t.steps.every((s) => typeof s.ms === "number")).toBe(true);
    expect(stepLine({ action: { do: "key", key: 0 }, ms: 812 }, 2)).toBe('3. {"do":"key","key":0}  (812 ms)');
    expect(stepLine({ action: { do: "key", key: 0 }, ms: 2400 }, 2)).toBe('3. {"do":"key","key":0}  (2.4 s)');
    expect((await rec("status")).text).toContain("No recording");
    const r = await replay(sap.driver(), policy, t);
    expect(r.passed).toBe(true);
    expect(r.steps.every((s) => s.recordedMs !== undefined && s.actMs !== undefined && !s.slower)).toBe(true);
    expect(resultText(r)).toMatch(/^ok {3}1\. \{"do":"okcode","value":"\/nZA03"\} {2}\(\d+ ms; recorded \d+ ms\)$/m);
    // Over twice and over a second more than recorded.
    expect(slowerNote(3100, 800)).toBe("the action took 3.1 s, 3.9x the 800 ms recorded");
    expect(slowerNote(1300, 400)).toBeUndefined();
    expect(slowerNote(9000, 5000)).toBeUndefined();
    expect(slowerNote(3100, undefined)).toBeUndefined();
    const slow = { ...r, steps: [{ ...(r.steps[0] as StepResult), ms: 3300, actMs: 3100, recordedMs: 800, slower: slowerNote(3100, 800) as string }] };
    expect(resultText(slow)).toContain('ok   1. {"do":"okcode","value":"/nZA03"}  (3.3 s; recorded 800 ms)\n       slower: the action took 3.1 s, 3.9x the 800 ms recorded');
    expect(resultText(slow).split("\n")[0]).not.toContain("NOTES");
    expect(junit([slow])).toContain('time="3.300"><system-out>recorded 0.800 s\nslower: the action took 3.1 s, 3.9x the 800 ms recorded</system-out></testcase>');
  });

  test("the report: values not captured in this run, unknown variables, an empty recording", async () => {
    const { test: t, sap, policy } = await recordCreateAndDisplay();
    const r = await replay(sap.driver(), policy, t, { variables: { customer: "" } });
    expect(r.passed).toBe(false);
    expect(resultText(r)).toContain('${order} not captured in this run (recorded "5001")');
    const bad = await replay(sap.driver(), policy, t, { variables: { foo: "1" } });
    expect(bad.variables.foo).toBeUndefined();
    expect(resultText(bad)).not.toContain("${foo} =");
    const empty = await replay(sap.driver(), policy, { ...t, steps: [] });
    expect([empty.passed, empty.aborted]).toEqual([false, "the recording has no steps"]);
  });
});

// ---- exports ------------------------------------------------------------------

describe("exports", () => {
  test("Cloud ALM: the input of calm_create_test_case, within its limits", async () => {
    const { test: t } = await recordCreateAndDisplay();
    const c = toCalm(t);
    expect(c.title).toBe("Create and display");
    expect(c.activities.map((a) => a.title)).toEqual(["Preparation", "ZA01: Create Order: Initial Screen", "ZA01: Create Order: Overview", "ZA03: Display Order: Initial Screen", "ZA03: Display Order <order>: Overview"]);
    const save = c.activities[2]?.steps[0];
    expect(save).toEqual({
      title: "Press Ctrl+S (Save)",
      description: "Press Ctrl+S (Save).",
      expected: 'The screen "Create Order: Initial Screen" appears.\nThe status bar contains "has been saved".\nNote the value of the status bar as ${order}.'.replace("${order}", "<order>"),
      evidence: true,
    });
    expect(c.activities[0]?.steps[0]?.description).toContain("- <customer> = 2200 (a customer of sales area 1000)");
    // The shape and limits of a Cloud ALM MCP server's calm_create_test_case tool: title 250, step title 500, texts 1 to 4000, 1 to 50 steps, 1 to 30 activities.
    expect(c.activities.length).toBeLessThanOrEqual(30);
    for (const a of c.activities) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.title.length).toBeLessThanOrEqual(250);
      expect(a.steps.length).toBeGreaterThan(0);
      expect(a.steps.length).toBeLessThanOrEqual(50);
      for (const s of a.steps) for (const x of [s.title, s.description, s.expected]) expect(x.length > 0 && x.length <= 4000).toBe(true);
    }
    expect(JSON.parse(exportTest(t, "calm").text).tool).toBe("calm_create_test_case");
  });

  test("SAP GUI scripting: findById on full ids, variables as arguments, the checks", async () => {
    const { test: t } = await recordCreateAndDisplay();
    const v = exportTest(t, "vbs").text;
    expect(v).toContain('v_customer = Var("customer", "2200")');
    expect(v).toContain('session.findById("wnd[0]/tbar[0]/okcd").text = "/nZA01"');
    expect(v).toContain('session.findById("wnd[0]/usr/ctxtZORD-KUNNR").text = v_customer');
    expect(v).toContain("session.ActiveWindow.sendVKey 11");
    expect(v).toContain('v_order = Capture(5, session.findById("wnd[0]/sbar").Text, "Order (\\d+)")');
    expect(v).toContain('session.findById("wnd[0]/usr/ctxtZORD-VBELN").text = v_order');
    expect(v).toContain('session.findById("wnd[0]/usr/tabsTS/tabpT\\02").select');
    expect(v).toContain('Landed 4, "SAPMZA01", "200"');
    expect(v).toContain('Expect 8, "Customer", session.findById("wnd[0]/usr/subHEAD:SAPMZA03:0301/ctxtZORD-KUNNR").Text, "equals", v_customer');
    expect(v.split("\r\n").length).toBeGreaterThan(50);
    expect(vbsString('say "hi" to ${a}!')).toBe('"say ""hi"" to " & v_a & "!"');
    expect([vkeyNumber("Enter"), vkeyNumber("Shift+F3"), vkeyNumber("Control+s"), vkeyNumber("Tab")]).toEqual([0, 15, 11, undefined]);
    expect(() => exportTest({ ...t, recorded: { ...t.recorded, surface: "fiori" } }, "vbs")).toThrow("Fiori");
  });

  test("Playwright: controls by SAP id, variables from the environment, checks as expect", async () => {
    const { test: t } = await recordCreateAndDisplay();
    const p = exportTest(t, "playwright").text;
    expect(p).toContain('import { expect, type Locator, type Page, test } from "@playwright/test";');
    expect(p).toContain('customer: process.env.SAP_VAR_CUSTOMER ?? "2200",');
    expect(p).toContain('await okcode(page, "/nZA01");');
    expect(p).toContain('await type(page, sid(page, "wnd[0]/usr/ctxtZORD-KUNNR"), `${vars.customer}`);');
    expect(p).toContain('await page.keyboard.press("Control+s");');
    expect(p).toContain('const m = new RegExp("Order (\\\\d+)").exec((await statusBar(page).innerText()).trim());');
    expect(p).toContain('await sid(page, "wnd[0]/usr/tabsTS/tabpT\\\\02").click();');
    expect(p).toContain("vars.order = m![1] ?? m![0];");
    const s = exportTest(t, "playwright-sap").text;
    expect(s).toContain('from "playwright-sap";');
    expect(s).toContain("page.locateSID(id)");
    expect(tsString("a `b` ${x} $ {y}")).toBe("`a \\`b\\` ${vars.x} $ {y}`");
    expect(tsString("plain")).toBe('"plain"');
  });

  test("Playwright: what has no id of its own in the page is a fixme, not a wrong click", () => {
    const t: SapTest = {
      format: FORMAT,
      name: "grid",
      recorded: { at: "", surface: "webgui" },
      start: {},
      variables: {},
      steps: [{ action: { do: "grid", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", row: 0, col: "VBELN" }, target: { id: "wnd[0]/usr/cntlGRID1/shellcont/shell" } }],
    };
    expect(exportTest(t, "playwright").text).toContain("test.fixme(true,");
    expect(exportTest(t, "vbs").text).toContain('.setCurrentCell 0, "VBELN"');
  });

  test("Gherkin: a scenario outline with the variables as examples", async () => {
    const { test: t } = await recordCreateAndDisplay();
    const g = exportTest(t, "gherkin").text;
    expect(g).toContain("Scenario Outline: Create and display");
    expect(g).toContain('When I enter "<customer>" in the field "Customer" (ZORD-KUNNR)');
    expect(g).toContain('Then the screen "Create Order: Initial Screen" appears');
    expect(g).toContain("| order | customer |");
    expect(() => exportTest(t, "tosca")).toThrow("Unknown export target");
  });

  test("sap-ts: SDK lines, variables in vars, captures as consts, checks as expect", async () => {
    const { test: t } = await recordCreateAndDisplay();
    const s = exportTest(t, "sap-ts");
    expect(s.suffix).toBe(".sap.ts");
    expect(s.text).toContain('import { expect, test } from "sap-gui-mcp-server/test";');
    expect(s.text).toContain('test("Create and display", async ({ sap }) => {');
    expect(s.text).toContain('    // a customer of sales area 1000\n    customer: "2200",');
    expect(s.text).toContain('  await sap.set("ctxtZORD-KUNNR", vars.customer);');
    expect(s.text).toContain('  const order = /Order (\\d+)/.exec(await sap.status().text())?.[1] ?? "";\n  expect(order).toBeTruthy();');
    expect(s.text).toContain('  await expect(sap.status()).toContainText("has been saved");');
    expect(s.text).toContain('  await sap.set("ctxtZORD-VBELN", order);');
    expect(s.text).toContain('  await expect(sap.field("wnd[0]/usr/subHEAD:SAPMZA03:0301/ctxtZORD-KUNNR")).toHaveValue(vars.customer);');
    expect(s.text).not.toContain("order:");
  });

  test("sap-ts: the generated tests type-check against the SDK and pass on the fake SAP", async () => {
    const { test: created } = await recordCreateAndDisplay();
    // An Information popup confirmed while recording, that SAP does not show at the next run.
    const p = await setup();
    p.sap.popupsFor.set("5000", [{ title: "Information", text: "Consider the subsequent documents" }]);
    await p.rec("start", { name: "with popup" });
    await p.act({ do: "okcode", value: "/nZA03" });
    await p.act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    await p.act({ do: "key", key: 0 });
    await p.act({ do: "press", id: "wnd[1]/tbar[0]/btn[0]" });
    await p.rec("stop");
    const popup = await p.file("with-popup.saptest.json");
    // Every kind of check and capture, a capture under a reserved word, a note on two lines.
    const kinds: SapTest = {
      format: FORMAT,
      name: 'kinds "of" `checks`',
      description: "every check",
      recorded: { at: "2026-01-02T03:04:05Z", surface: "webgui", system: "ABA", client: "800" },
      start: { transaction: "SMEN" },
      variables: { order: { value: "5000" }, class: { value: "5000" }, cust: { value: "2200" } },
      steps: [
        { action: { do: "okcode", value: "/nZA03" }, note: "open\nthe order" },
        { action: { do: "set", id: "ctxtZORD-VBELN", value: "${order}" } },
        {
          action: { do: "key", key: 0 },
          capture: [
            { var: "class", from: "title", pattern: "Order (\\d+)" },
            { var: "cust", from: "field", id: "ctxtZORD-KUNNR" },
          ],
          expect: [
            { check: "title", op: "contains", value: "Order ${order}" },
            { check: "title", op: "matches", value: "Order \\d+|a/b" },
            { check: "title", op: "equals", value: "Display Order ${class}: Overview" },
            { check: "transaction", op: "equals", value: "ZA03" },
            { check: "transaction", op: "matches", value: "^ZA0\\d$" },
            { check: "transaction", op: "contains", value: "A0" },
            { check: "text", op: "contains", value: "${cust}" },
            { check: "text", op: "matches", value: "Customer" },
            { check: "field", id: "ctxtZORD-KUNNR", op: "contains", value: "22" },
            { check: "field", id: "ctxtZORD-KUNNR", op: "matches", value: "^\\d{4}$" },
            { check: "status", op: "equals", value: "" },
          ],
        },
      ],
    };
    const gen = join(import.meta.dir, `.sap-ts-${process.pid}`);
    await mkdir(gen, { recursive: true });
    try {
      const files: string[] = [];
      for (const [i, t] of [created, popup, kinds].entries()) {
        const f = `t${i}.sap.ts`;
        await writeFile(join(gen, f), exportTest(t, "sap-ts").text.replace('"sap-gui-mcp-server/test"', '"../../src/runner/index.js"'));
        files.push(f);
      }
      expect(await readFile(join(gen, "t1.sap.ts"), "utf8")).toContain('  if (await sap.control("wnd[1]/tbar[0]/btn[0]").exists()) await sap.press("wnd[1]/tbar[0]/btn[0]");');
      const k = await readFile(join(gen, "t2.sap.ts"), "utf8");
      expect(k).toContain("  // open\n  // the order\n");
      expect(k).toContain("vars.class = /Order (\\d+)/.exec");
      expect(k).toContain("  const cust = await sap.field(\"ctxtZORD-KUNNR\").value();");
      expect(k).toContain("toHaveTitle(/Order \\d+|a\\/b/)");
      expect(k).toContain("toHaveTitle(new RegExp(`Order ${vars.order}`))");
      expect(k).toContain("await expect(sap).toContainText(cust);");
      // Type-checked as the repository is, against the SDK's own types.
      await writeFile(join(gen, "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.json", include: [], files }));
      const tsc = Bun.spawnSync([join(import.meta.dir, "../node_modules/.bin/tsc"), "-p", join(gen, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
      expect(`${tsc.stdout.toString()}${tsc.stderr.toString()}`).toBe("");
      expect(tsc.exitCode).toBe(0);
      // Run by the test runner itself, on a fake SAP with writes on: the popup does not come again, the order is created anew.
      const { resolveConfig, runTests } = await import("../src/runner/index.js");
      const config = resolveConfig({ use: { write: "on" }, expectTimeout: 300, outputDir: "out" }, gen);
      const run = await runTests({ config, files: files.map((f) => join(gen, f)), surfaces: [new FakeSap()], retries: 0 });
      expect(run.tests.map((t) => [t.title, t.status, t.error?.message])).toEqual([
        ["Create and display", "passed", undefined],
        ["with popup", "passed", undefined],
        ['kinds "of" `checks`', "passed", undefined],
      ]);
    } finally {
      await rm(gen, { recursive: true, force: true });
    }
  });
});

// ---- command line ---------------------------------------------------------------

describe("command line", () => {
  test("replay: exit code 0 on a pass, 1 on a failure, with a JUnit report", async () => {
    const { test: t, sap, dir, policy } = await recordCreateAndDisplay();
    const path = join(dir, "create-and-display.saptest.json");
    const out: string[] = [];
    expect(await replayCommand([path, "--var", "customer=3300", "--junit", join(dir, "r.xml")], [sap], policy, (s) => out.push(s))).toBe(0);
    expect(out.join("\n")).toContain("PASS  Create and display");
    expect(await readFile(join(dir, "r.xml"), "utf8")).toContain('failures="0"');
    t.steps[7]!.expect![0]!.value = "nope";
    await writeFile(path, JSON.stringify(t));
    expect(await replayCommand([path, "--json"], [sap], policy, (s) => out.push(s))).toBe(1);
    expect(JSON.parse(out.at(-1) as string)[0].passed).toBe(false);
    await expect(replayCommand([path, "--var", "nope=1"], [sap], policy)).rejects.toThrow("no test has a variable nope");
  });

  test("export: writes the file next to the recording", async () => {
    const { dir } = await recordCreateAndDisplay();
    const out: string[] = [];
    expect(await exportCommand([join(dir, "create-and-display.saptest.json"), "--to", "gherkin"], (s) => out.push(s))).toBe(0);
    expect(out[0]).toBe(join(dir, "create-and-display.feature"));
    expect(await readFile(out[0] as string, "utf8")).toContain("Feature: Create and display");
    expect(await exportCommand([join(dir, "create-and-display.saptest.json"), "--to", "sap-ts"], (s) => out.push(s))).toBe(0);
    expect(out[1]).toBe(join(dir, "create-and-display.sap.ts"));
    expect(await readFile(out[1] as string, "utf8")).toContain('await sap.okcode("/nZA01");');
  });
});
