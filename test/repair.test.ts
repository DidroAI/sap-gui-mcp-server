import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { policyFromEnv } from "../src/core/guard.js";
import { parseTest, type SapTest, serializeTest } from "../src/record/format.js";
import { recorderOptionsFromEnv } from "../src/record/recorder.js";
import { normalizeAction } from "../src/core/action.js";
import { confirms, writeInFlight } from "../src/record/repair.js";
import { replay, resultText } from "../src/record/replay.js";
import { parseScreen } from "../src/record/screen.js";
import { createServer } from "../src/server.js";
import { FakeSap } from "./record-fakes.js";

async function setup(env: Record<string, string> = { SAP_WRITE: "on" }, sap = new FakeSap()) {
  const dir = await mkdtemp(join(tmpdir(), "saprepair-"));
  const record = recorderOptionsFromEnv({ SAP_RECORD_DIR: dir, ...env }, "test");
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

/** Display order 5000 and go back: 4 steps, the title checked after Enter. */
async function recordDisplay() {
  const s = await setup();
  await s.rec("start", { name: "display", description: "Display order 5000 of customer 2200" });
  await s.act({ do: "okcode", value: "/nZA03" });
  await s.act({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
  await s.act({ do: "key", key: 0 });
  await s.rec("assert", { check: "field", id: "ctxtZORD-KUNNR", equals: "2200" });
  await s.rec("note", { text: "Step 1: Display the order" });
  await s.act({ do: "key", key: 3 });
  await s.rec("stop");
  return { ...s, test: await s.file("display.saptest.json") };
}

/** Create an order and display it, the number written as it was (no capture): 8 steps. */
async function recordCreate() {
  const s = await setup();
  await s.rec("start", { name: "create", description: "Create an order for customer 2200, then display it" });
  await s.act({ do: "okcode", value: "/nZA01" });
  await s.act({ do: "set", id: "ctxtZORD-KUNNR", value: "2200" });
  await s.act({ do: "set", id: "txtZORD-MENGE", value: "7" });
  await s.act({ do: "key", key: 0 });
  await s.act({ do: "key", key: 11 });
  await s.rec("assert", { check: "status", equals: "Order 5001 has been saved" });
  await s.act({ do: "okcode", value: "/nZA03" });
  await s.act({ do: "set", id: "ctxtZORD-VBELN", value: "5001" });
  await s.act({ do: "key", key: 0 });
  await s.rec("assert", { check: "title", contains: "Display Order 5001" });
  await s.rec("stop");
  return { ...s, test: await s.file("create.saptest.json") };
}

const question = { title: "Subsequent documents", text: "The order has deliveries. Display it anyway?", question: true };

describe("a failure says where the step failed", () => {
  test("landing: a question popup the recording does not have", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    sap.popupsFor.set("5000", [question]);
    const r = await replay(sap.driver(), policy, t, { leaveOnFailure: false });
    expect(r.passed).toBe(false);
    expect(r.steps[2]?.phase).toBe("landing");
    expect(resultText(r)).toContain("failed (landing): SAP showed a popup");
  });

  test("act: the control is not on the screen; check: a marked check does not hold; refused: the guard", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    const renamed = structuredClone(t);
    (renamed.steps[1] as { action: Record<string, unknown>; target?: unknown }).action.id = "ctxtZORD-AUFNR";
    delete (renamed.steps[1] as { target?: unknown }).target;
    expect((await replay(sap.driver(), policy, renamed)).steps[1]?.phase).toBe("act");
    (sap.orders.get("5000") as { customer: string }).customer = "3300";
    expect((await replay(sap.driver(), policy, t)).steps[2]?.phase).toBe("check");
    const c = await recordCreate();
    expect((await replay(c.sap.driver(), policyFromEnv({}), c.test)).steps[4]?.phase).toBe("refused");
  });
});

describe("a repair for one step", () => {
  test("after: the popup is answered, the step is judged by the recording, the rest runs as recorded", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    sap.popupsFor.set("5000", [question]);
    const first = await replay(sap.driver(), policy, t, { leaveOnFailure: false });
    expect(first.steps[2]?.outcome).toBe("fail");
    sap.acts = [];
    const r = await replay(sap.driver(), policy, t, {
      from: 3,
      variables: first.variables,
      repair: { why: "SAP asks whether to display an order that has deliveries", actions: [{ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }], place: "after" },
    });
    expect(r.passed).toBe(true);
    expect(r.from).toBe(3);
    expect(r.steps.map((s) => s.n)).toEqual([3, 4]);
    expect(r.steps[0]?.repair).toMatchObject({ outcome: "repaired", did: ['{"do":"press","id":"wnd[1]/usr/btnSPOP-OPTION1"}'] });
    // Enter was not pressed again: the popup's button, then the recorded Back.
    expect(sap.acts.map((a) => a.do)).toEqual(["press", "key"]);
    const text = resultText(r);
    expect(text).toContain("REPAIRED at step 3");
    expect(text).toContain("Proposed change to the test (nothing was saved):");
    // The proposed test: the answer is a step of its own, and it carries the checks and the business note.
    const p = r.proposal as NonNullable<typeof r.proposal>;
    expect(p.origin).toEqual([1, 2, 3, 3, 4]);
    expect(p.test.steps.length).toBe(5);
    expect(p.test.steps[2]?.expect).toBeUndefined();
    expect(p.test.steps[2]?.after?.title).toBe("Subsequent documents");
    expect(p.test.steps[3]?.expect?.[0]?.value).toBe("2200");
    expect(p.test.steps[3]?.note).toBe("Step 1: Display the order");
    expect(t.steps.length).toBe(4);
    // The proposed test replays with no model on the changed system.
    expect((await replay(sap.driver(), policy, parseTest(serializeTest(p.test)))).passed).toBe(true);
  });

  test("instead: a renamed field is set under its new id", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    const old = structuredClone(t);
    (old.steps[1] as { action: Record<string, unknown> }).action.id = "ctxtZORD-AUFNR";
    delete (old.steps[1] as { target?: unknown }).target;
    await replay(sap.driver(), policy, old, { leaveOnFailure: false });
    const r = await replay(sap.driver(), policy, old, { from: 2, repair: { why: "the order field has another name", actions: [{ do: "set", id: "ctxtZORD-VBELN", value: "5000" }], place: "instead" } });
    expect(r.passed).toBe(true);
    expect(r.proposal?.test.steps[1]?.action).toEqual({ do: "set", id: "ctxtZORD-VBELN", value: "5000" });
    expect(r.proposal?.origin).toEqual([1, 2, 3, 4]);
    expect(r.proposal?.changes[1]).toContain("Step 2 replaced by");
  });

  test("before: a field that is now required is filled with a value of the recording, then the recorded action runs", async () => {
    const { test: t, sap, policy } = await recordCreate();
    // As if the customer had been a default when recorded: the step that typed it is not in the test.
    const lean = structuredClone(t);
    lean.steps.splice(1, 1);
    const first = await replay(sap.driver(), policy, lean, { leaveOnFailure: false });
    expect(first.steps[2]).toMatchObject({ outcome: "fail", phase: "landing" });
    const r = await replay(sap.driver(), policy, lean, { from: 3, repair: { why: "Customer is empty and required", actions: [{ do: "set", id: "ctxtZORD-KUNNR", value: "2200" }], place: "before" } });
    expect(r.steps[0]?.repair?.outcome).toBe("repaired");
    expect(r.proposal?.test.steps.length).toBe(lean.steps.length + 1);
    expect(r.proposal?.origin.slice(0, 5)).toEqual([1, 2, 3, 3, 4]);
    expect(r.proposal?.test.steps[2]?.note).toContain("Added by a repair");
  });

  test("before, after the recorded action already led elsewhere: the proposed test holds the action, the repair, the action again", async () => {
    const { test: t, sap, policy } = await recordDisplay();
    // As if SAP had proposed another order: the recorded Enter opens order 4990, whose customer is not the checked one.
    sap.orders.set("4990", { customer: "1000", quantity: "1", rush: false });
    const other = structuredClone(t);
    (other.steps[1] as { action: Record<string, unknown> }).action.value = "4990";
    const first = await replay(sap.driver(), policy, other, { leaveOnFailure: false });
    expect(first.steps[2]).toMatchObject({ outcome: "fail", phase: "check" });
    const r = await replay(sap.driver(), policy, other, {
      from: 3,
      repair: { why: "another order opened", actions: [{ do: "key", key: 3 }, { do: "set", id: "ctxtZORD-VBELN", value: "5000" }], place: "before" },
    });
    expect(r.passed).toBe(true);
    const p = r.proposal as NonNullable<typeof r.proposal>;
    expect(p.test.steps.map((s) => `${s.action?.do}${s.action?.key ?? ""}`)).toEqual(["okcode", "set", "key0", "key3", "set", "key0", "key3"]);
    expect(p.origin).toEqual([1, 2, 3, 3, 3, 3, 4]);
    expect(p.test.steps[2]?.expect).toBeUndefined();
    expect(p.test.steps[2]?.after?.screen).toBe("300");
    expect(p.test.steps[5]?.expect?.length).toBe(1);
    expect(p.test.steps[5]?.note).toBe("Step 1: Display the order");
    expect(p.changes[1]).toContain("then the action of step 3 again");
    // It replays as it is, with no repair.
    expect((await replay(sap.driver(), policy, parseTest(serializeTest(p.test)))).passed).toBe(true);
  });

  test("capture: a new document number becomes a variable, and the later steps use it", async () => {
    const { test: t, sap, policy } = await recordCreate();
    const first = await replay(sap.driver(), policy, t, { leaveOnFailure: false });
    expect(first.steps[4]).toMatchObject({ outcome: "fail", phase: "check" });
    sap.acts = [];
    const r = await replay(sap.driver(), policy, t, { from: 5, repair: { why: "SAP gave the order a new number", capture: { var: "order", from: "status", pattern: "Order (\\d+) has been saved" } } });
    expect(r.passed).toBe(true);
    // Save was not pressed again; the display typed this run's number.
    expect(sap.acts.some((a) => a.do === "key" && a.key === 11)).toBe(false);
    expect(sap.acts.find((a) => a.id === "ctxtZORD-VBELN")?.value).toBe("5002");
    expect(r.steps[0]?.repair?.captured).toBe('${order} = "5002" (recorded "5001")');
    const p = r.proposal?.test as SapTest;
    expect(p.variables.order?.value).toBe("5001");
    expect(p.steps[4]?.expect?.[0]?.value).toBe("Order ${order} has been saved");
    expect(p.steps[6]?.action?.value).toBe("${order}");
    expect(p.steps[7]?.expect?.[0]?.value).toBe("Display Order ${order}");
    // The recording itself was not changed, and the proposed test passes on its own.
    expect(t.variables.order).toBeUndefined();
    expect((await replay(sap.driver(), policy, p)).passed).toBe(true);
  });
});

describe("what a repair may not do", () => {
  async function popupAt3() {
    const s = await recordDisplay();
    s.sap.popupsFor.set("5000", [question]);
    await replay(s.sap.driver(), s.policy, s.test, { leaveOnFailure: false });
    s.sap.acts = [];
    return s;
  }
  const refusedWith = async (repair: Record<string, unknown>) => {
    const { test: t, sap, policy } = await popupAt3();
    const r = await replay(sap.driver(), policy, t, { from: 3, repair: repair as never, leaveOnFailure: false });
    expect(r.passed).toBe(false);
    expect(r.proposal).toBeUndefined();
    return { r, sap, said: r.steps[0]?.failures[0] ?? "" };
  };

  test("a write the recorded step does not have", async () => {
    const { r, sap, said } = await refusedWith({ why: "x", actions: [{ do: "key", key: 11 }], place: "after" });
    expect(said).toContain("the repair was refused");
    expect(said).toContain("a repair adds no write");
    expect(r.steps[0]?.repair?.outcome).toBe("refused");
    expect(sap.acts).toEqual([]);
  });

  test("leaving the transaction, an invented value, too many actions, no actions", async () => {
    expect((await refusedWith({ why: "x", actions: [{ do: "okcode", value: "/nZA01" }], place: "after" })).said).toContain("stays in the recorded flow");
    expect((await refusedWith({ why: "x", actions: [{ do: "okcode", value: "/n" }], place: "after" })).said).toContain("stays in the recorded flow");
    expect((await refusedWith({ why: "x", actions: [{ do: "set", id: "ctxtZORD-VBELN", value: "4711" }], place: "after" })).said).toContain("does not invent data");
    expect((await refusedWith({ why: "x", actions: Array(5).fill({ do: "key", key: 0 }), place: "after" })).said).toContain("at most 4 actions");
    expect((await refusedWith({ why: "x" })).said).toContain("needs actions or a capture");
    expect((await refusedWith({ why: "x", actions: [{ do: "key", key: 0 }] })).said).toContain('"place"');
  });

  test("a second write next to the recorded one", async () => {
    const { test: t, sap, policy } = await recordCreate();
    const r = await replay(sap.driver(), policy, t, { from: 5, repair: { why: "x", actions: [{ do: "key", key: 11 }], place: "before" } });
    expect(r.steps[0]?.failures[0]).toContain("the recorded write would run after it");
  });

  test("a capture on a step that does not write; a capture that hides another difference", async () => {
    const d = await recordDisplay();
    (d.sap.orders.get("5000") as { customer: string }).customer = "3300";
    await replay(d.sap.driver(), d.policy, d.test, { leaveOnFailure: false });
    const r = await replay(d.sap.driver(), d.policy, d.test, { from: 3, repair: { why: "x", capture: { var: "customer", from: "field", id: "ctxtZORD-KUNNR", pattern: "(\\d+)" } } });
    expect(r.steps[0]?.failures[0]).toContain("this step does not write");

    const c = await recordCreate();
    // The recording expected another sentence, not only another number.
    const other = structuredClone(c.test);
    ((other.steps[4] as { expect: { value: string }[] }).expect[0] as { value: string }).value = "Order 5001 has been saved and released";
    await replay(c.sap.driver(), c.policy, other, { leaveOnFailure: false });
    const r2 = await replay(c.sap.driver(), c.policy, other, { from: 5, repair: { why: "x", capture: { var: "order", from: "status", pattern: "Order (\\d+)" } } });
    expect(r2.passed).toBe(false);
    expect(r2.steps[0]?.repair?.outcome).toBe("failed");
    expect(r2.steps[0]?.failures[0]).toContain('is not "Order 5002 has been saved and released"');
    expect(r2.proposal).toBeUndefined();
  });

  test("a repair that does not lead where the recording led fails the step", async () => {
    const { test: t, sap, policy } = await popupAt3();
    // Cancel closes the popup but the fake stays on the order: use a wrong tab press instead, which SAP refuses.
    const r = await replay(sap.driver(), policy, t, { from: 3, repair: { why: "x", actions: [{ do: "select", id: "tabpT\\02" }], place: "after" }, leaveOnFailure: false });
    expect(r.passed).toBe(false);
    expect(r.steps[0]?.repair?.outcome).toBe("failed");
  });

  test("a screen that offers a choice (availability control) is not a repair's to answer", async () => {
    const { test: t, sap, policy } = await recordCreate();
    sap.available = 5;
    const first = await replay(sap.driver(), policy, t, { leaveOnFailure: false });
    expect(first.steps[3]).toMatchObject({ outcome: "fail", phase: "landing" });
    const r = await replay(sap.driver(), policy, t, { from: 4, repair: { why: "x", actions: [{ do: "press", id: "wnd[0]/tbar[1]/btn[0]" }], place: "after" }, leaveOnFailure: false });
    expect(r.steps[0]?.failures[0]).toContain("offers a choice");
    expect(r.steps[0]?.repair?.outcome).toBe("refused");
    expect(sap.screen).toBe("500");
  });

  test("a warning SAP raises while saving: the Enter that acknowledges it is the save", async () => {
    const warned = async () => {
      const c = await recordCreate();
      c.sap.saveWarning = "Minimum quantity of free goods has not been reached";
      const first = await replay(c.sap.driver(), c.policy, c.test, { leaveOnFailure: false });
      // Save answered with the warning and saved nothing: the step did not lead where it was recorded to lead.
      expect(first.steps[4]).toMatchObject({ outcome: "fail", phase: "landing" });
      expect(c.sap.next).toBe(5002);
      c.sap.acts = [];
      return c;
    };
    // Before the recorded Save: refused, the write would run twice (the Enter saves, then Save meets an empty screen).
    let c = await warned();
    let r = await replay(c.sap.driver(), c.policy, c.test, { from: 5, repair: { why: "a warning", actions: [{ do: "key", key: 0 }], place: "before" }, leaveOnFailure: false });
    expect(r.steps[0]?.failures[0]).toContain("completes the save");
    expect(r.steps[0]?.failures[0]).toContain("the recorded write would run after it");
    expect(r.steps[0]?.repair?.outcome).toBe("refused");
    expect(c.sap.acts).toEqual([]);
    expect(c.sap.next).toBe(5002);
    // After it, as the one write of the repair, on the step that is that write: allowed, and the order is the step's.
    r = await replay(c.sap.driver(), c.policy, c.test, { from: 5, repair: { why: "a warning", actions: [{ do: "key", key: 0 }], place: "after" }, leaveOnFailure: false });
    expect(c.sap.next).toBe(5003);
    expect(r.steps[0]?.repair?.did).toEqual(['{"do":"key","key":0}']);
    // On a step that is not the write (the one after it), with the warning still there: refused, nothing saved.
    c = await warned();
    r = await replay(c.sap.driver(), c.policy, c.test, { from: 6, repair: { why: "a warning", actions: [{ do: "key", key: 0 }], place: "before" }, leaveOnFailure: false });
    expect(r.steps[0]?.failures[0]).toContain("which SAP raised at the write of the step before");
    expect(r.steps[0]?.repair?.outcome).toBe("refused");
    expect(c.sap.next).toBe(5002);
    // With write off the same Enter is refused by the guard as a write.
    c = await warned();
    r = await replay(c.sap.driver(), policyFromEnv({}), c.test, { from: 5, repair: { why: "a warning", actions: [{ do: "key", key: 0 }], place: "after" }, leaveOnFailure: false });
    expect(c.sap.next).toBe(5002);
  });

  test("a popup SAP raises at a write: its confirming button is the write, its Cancel is not", async () => {
    const screen = parseScreen(
      ['TRANSACTION ZA01  PROGRAM SAPMZA01  SCREEN 200', 'WINDOW wnd[0]  "Create Order: Overview"', 'WINDOW wnd[1]  "Save incomplete document"', "wnd[1]/usr/btnSPOP-OPTION1  button  Save", "wnd[1]/usr/btnSPOP-OPTION2  button  Edit", "wnd[1]/tbar[0]/btn[12]  button  Cancel (Escape)"].join("\n"),
    );
    const write = { action: { do: "key", key: 11 }, risk: "commit" };
    const plain = { action: { do: "key", key: 0 }, risk: "navigate" };
    expect(writeInFlight(write, undefined, screen)).toBe("this");
    expect(writeInFlight(plain, write, screen)).toBe("previous");
    expect(writeInFlight(plain, plain, screen)).toBeUndefined();
    expect(confirms(normalizeAction({ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }), screen)).toBe(true);
    expect(confirms(normalizeAction({ do: "key", key: 0 }), screen)).toBe(true);
    expect(confirms(normalizeAction({ do: "press", id: "wnd[1]/tbar[0]/btn[12]" }), screen)).toBe(false);
    expect(confirms(normalizeAction({ do: "key", key: 12 }), screen)).toBe(false);
    expect(confirms(normalizeAction({ do: "set", id: "x", value: "1" }), screen)).toBe(false);
  });

  test("write off: a repair cannot write either", async () => {
    const c = await recordCreate();
    const r = await replay(c.sap.driver(), policyFromEnv({}), c.test, { from: 5, repair: { why: "x", actions: [{ do: "key", key: 11 }], place: "instead" } });
    expect(r.steps[0]?.failures[0]).toContain("refused");
    expect(c.sap.next).toBe(5002);
  });
});

describe("sap_replay with from, repair and format json", () => {
  test("the tool resumes with a repair and answers as data", async () => {
    const s = await recordDisplay();
    s.sap.popupsFor.set("5000", [question]);
    const first = JSON.parse((await s.call("sap_replay", { name: "display", format: "json" })).text);
    expect(first.passed).toBe(false);
    expect(first.steps[2].phase).toBe("landing");
    expect(first.screenFull).toContain("btnSPOP-OPTION1");
    const again = await s.call("sap_replay", { name: "display", format: "json", from: 3, variables: first.variables, repair: { why: "a question popup", actions: [{ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }], place: "after" } });
    expect(again.error).toBe(false);
    const r = JSON.parse(again.text);
    expect(r.passed).toBe(true);
    expect(r.proposal.test.steps.length).toBe(5);
    expect(r.text).toContain("REPAIRED at step 3");
    // Nothing was written next to the recording.
    await writeFile(join(s.dir, "x"), "");
    expect((await s.file("display.saptest.json")).steps.length).toBe(4);
  });

  test("a repair without from is not run", async () => {
    const s = await recordDisplay();
    const r = await s.call("sap_replay", { name: "display", repair: { why: "x", capture: { var: "a", from: "status", pattern: "x" } } });
    expect(r.error).toBe(true);
    expect(r.text).toContain('a repair needs "from"');
  });
});
