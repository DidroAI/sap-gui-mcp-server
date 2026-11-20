import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAX_BATCH, parseBatch, stopAfter } from "../src/batch.js";
import { normalizeAction } from "../src/core/action.js";
import { policyFromEnv } from "../src/core/guard.js";
import { parseTest } from "../src/record/format.js";
import { recorderOptionsFromEnv } from "../src/record/recorder.js";
import { parseScreen } from "../src/record/screen.js";
import { createServer } from "../src/server.js";
import { FakeSap } from "./record-fakes.js";

async function setup(env: Record<string, string> = {}, elicit?: "accept" | "decline") {
  const sap = new FakeSap();
  const dir = await mkdtemp(join(tmpdir(), "sapbatch-"));
  const { server } = createServer({ policy: policyFromEnv(env), surfaces: [sap], record: recorderOptionsFromEnv({ SAP_RECORD_DIR: dir }, "test") });
  const client = new Client({ name: "test", version: "0" }, { capabilities: elicit ? { elicitation: {} } : {} });
  const asked: string[] = [];
  if (elicit)
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push((request.params as { message: string }).message);
      return { action: elicit };
    });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { error: r.isError === true, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  const batch = (actions: unknown[], more: Record<string, unknown> = {}) => call("sap_act", { actions, ...more });
  return { sap, dir, call, batch, asked };
}

const OPEN = { do: "okcode", value: "/nZA01", expect: { transaction: "ZA01" } };
const CUSTOMER = { do: "set", id: "ctxtZORD-KUNNR", value: "2200" };
const QUANTITY = { do: "set", id: "txtZORD-MENGE", value: "7" };
const ENTER = { do: "key", key: 0 };
const SAVE = { do: "key", key: 11 };
const dos = (sap: FakeSap) => sap.acts.map((a) => (a.do === "key" ? `key ${a.key}` : a.do));

describe("sap_act with actions: several actions, one answer", () => {
  test("a whole transaction in one call: every action runs in order, the screen comes once", async () => {
    const { sap, batch } = await setup({ SAP_WRITE: "on" });
    // The save runs on screen 200, which the agent named but has not seen: it says so with "unseen".
    const r = await batch([OPEN, CUSTOMER, QUANTITY, { ...ENTER, expect: { screen: "200" } }, { ...SAVE, unseen: true }]);
    expect(r.error).toBe(false);
    expect(dos(sap)).toEqual(["okcode", "set", "set", "key 0", "key 11"]);
    expect(r.text.split("\n")[0]).toBe("Ran 5 actions.");
    expect(r.text).toContain("2. set wnd[0]/usr/ctxtZORD-KUNNR");
    // No recording is on: no SDK lines (test/surface.test.ts has them while recording).
    expect(r.text).not.toContain("code:");
    expect(r.text).toContain("S: Order 5001 has been saved");
    // One screen in the answer: the last one.
    expect(r.text.match(/^TRANSACTION /gm)?.length).toBe(1);
    expect(sap.orders.get("5001")).toEqual({ customer: "2200", quantity: "7", rush: false });
  });

  test("the fields of the screen in view and the key that sends them: the next screen is the answer", async () => {
    const { sap, call, batch } = await setup();
    await call("sap_act", { action: { do: "okcode", value: "/nZA01" } });
    const r = await batch([CUSTOMER, QUANTITY, { do: "check", id: "chkZORD-RUSH" }, ENTER]);
    expect(r.error).toBe(false);
    expect(r.text.split("\n")[0]).toBe("Ran 4 actions.");
    expect(r.text).toContain("SCREEN 200");
    expect(sap.screen).toBe("200");
  });

  test("an error in the status bar ends the batch before the next action", async () => {
    const { sap, call, batch } = await setup({ SAP_WRITE: "on" });
    await call("sap_act", { action: { do: "okcode", value: "/nZA01" } });
    const r = await batch([QUANTITY, ENTER, SAVE]);
    expect(r.error).toBe(false);
    expect(r.text.split("\n")[0]).toBe("Ran 2 of 3 actions. Stopped: after action 2, the status bar shows E: Fill in all required fields. Action 3 did not run.");
    expect(r.text).toContain("STATUS E: Fill in all required fields");
    expect(dos(sap)).toEqual(["okcode", "set", "key 0"]);
  });

  test("a screen the batch did not name ends it: the actions after were written for the screen before", async () => {
    const { sap, call, batch } = await setup({ SAP_WRITE: "on" });
    await call("sap_act", { action: { do: "okcode", value: "/nZA01" } });
    const r = await batch([CUSTOMER, QUANTITY, ENTER, SAVE]);
    expect(r.text.split("\n")[0]).toBe('Ran 3 of 4 actions. Stopped: after action 3, the screen changed: it is now ZA01, program SAPMZA01, screen 200 ("Create Order: Overview"). Action 4 did not run.');
    expect(r.text).toContain("SCREEN 200");
    expect(sap.orders.size).toBe(1);
  });

  test("a screen that is not the one expected ends it too", async () => {
    const { sap, call, batch } = await setup({ SAP_WRITE: "on" });
    sap.available = 5;
    await call("sap_act", { action: { do: "okcode", value: "/nZA01" } });
    const r = await batch([CUSTOMER, QUANTITY, { ...ENTER, expect: { screen: "200" } }, SAVE]);
    expect(r.text.split("\n")[0]).toBe("Ran 3 of 4 actions. Stopped: after action 3, expected screen 200 (it is 500). Action 4 did not run.");
    expect(r.text).toContain("Availability Control");
    expect(sap.orders.size).toBe(1);
  });

  test("a popup ends the batch, whatever screen was expected: it asks something the agent has not read", async () => {
    const { sap, call, batch } = await setup();
    sap.popupsFor.set("5000", [{ title: "Credit check", text: "Credit limit exceeded. Continue?", question: true }]);
    await call("sap_act", { action: { do: "okcode", value: "/nZA03" } });
    const r = await batch([{ do: "set", id: "ctxtZORD-VBELN", value: "5000" }, { ...ENTER, expect: { screen: "300" } }, { do: "select", id: "tabpT\\02" }]);
    expect(r.text.split("\n")[0]).toBe('Ran 2 of 3 actions. Stopped: after action 2, a popup opened ("Credit check"). Action 3 did not run.');
    expect(r.text).toContain("btnSPOP-OPTION1  button  Yes");
    expect(dos(sap)).toEqual(["okcode", "set", "key 0"]);
  });

  test('"expect":{"popup":true} goes on through a popup the agent knows comes', async () => {
    const { sap, call, batch } = await setup();
    sap.popupsFor.set("5000", [{ title: "Information", text: "Order is blocked for delivery" }]);
    await call("sap_act", { action: { do: "okcode", value: "/nZA03" } });
    const r = await batch([{ do: "set", id: "ctxtZORD-VBELN", value: "5000" }, { ...ENTER, expect: { popup: true } }, ENTER, { do: "select", id: "tabpT\\02" }]);
    expect(r.text.split("\n")[0]).toBe("Ran 4 actions.");
    expect(sap.tab).toBe("T\\02");
  });

  test('a warning ends the batch; "expect":{"status":"W"} goes on through it', async () => {
    const one = await setup({ SAP_WRITE: "on" });
    one.sap.saveWarning = "Delivery date is in the past";
    await one.batch([OPEN, CUSTOMER, { ...ENTER, expect: { screen: "200" } }]);
    const r = await one.batch([SAVE, ENTER]);
    expect(r.text.split("\n")[0]).toBe("Ran 1 of 2 actions. Stopped: after action 1, the status bar shows W: Delivery date is in the past. Action 2 did not run.");
    expect(one.sap.orders.size).toBe(1);

    const two = await setup({ SAP_WRITE: "on" });
    two.sap.saveWarning = "Delivery date is in the past";
    await two.batch([OPEN, CUSTOMER, { ...ENTER, expect: { screen: "200" } }]);
    const r2 = await two.batch([{ ...SAVE, expect: { status: "W" } }, { ...ENTER, expect: { screen: "100", status: "has been saved" } }]);
    expect(r2.text.split("\n")[0]).toBe("Ran 2 actions.");
    expect(two.sap.orders.size).toBe(2);
  });

  test("an action SAP does not take ends the batch with the screen as it is", async () => {
    const { sap, call, batch } = await setup();
    await call("sap_act", { action: { do: "okcode", value: "/nZA01" } });
    const r = await batch([CUSTOMER, { do: "set", id: "ctxtZORD-NOPE", value: "1" }, ENTER]);
    expect(r.error).toBe(true);
    expect(r.text.split("\n")[0]).toBe('Ran 1 of 3 actions. Stopped: action 2 ({"do":"set","id":"ctxtZORD-NOPE","value":"1"}) failed: no control named ctxtZORD-NOPE. Action 3 did not run.');
    expect(r.text).toContain('Customer = "2200"');
    // The fake logs the action it then refuses; the Enter after it never came.
    expect(dos(sap)).not.toContain("key 0");
  });

  test('"show":true gives the screen after that action too: one tab after another in one call', async () => {
    const { call, batch } = await setup();
    await call("sap_act", { action: { do: "okcode", value: "/nZA03" } });
    const r = await batch([{ do: "set", id: "ctxtZORD-VBELN", value: "5000" }, { ...ENTER, expect: { screen: "300" }, show: true }, { do: "select", id: "tabpT\\02" }]);
    expect(r.text.split("\n")[0]).toBe("Ran 3 actions.");
    const shown = r.text.slice(r.text.indexOf("--- the screen after action 2"), r.text.indexOf("\n---\n"));
    expect(shown).toContain("tabpT\\01  tab  Sales (selected)");
    // The last screen is given as what changed since the one shown.
    expect(r.text).toContain("tblITEMS  table");
  });
});

describe("a batch and the guard: each action has its own decision", () => {
  test("a write on a screen the agent has not seen in the batch does not run; the answer is that screen", async () => {
    const { sap, batch } = await setup({ SAP_WRITE: "on" });
    const r = await batch([OPEN, CUSTOMER, QUANTITY, { ...ENTER, expect: { screen: "200" } }, SAVE]);
    expect(r.error).toBe(false);
    expect(dos(sap)).toEqual(["okcode", "set", "set", "key 0"]);
    expect(r.text.split("\n")[0]).toBe('Ran 4 of 5 actions. Stopped: action 5 ({"do":"key","key":11}) did not run: it may write, on a screen you have not seen in this batch (ZA01, program SAPMZA01, screen 200 ("Create Order: Overview")). Read the screen below, then send it, or mark the step "unseen": true when you know that screen. Action 5 did not run.');
    expect(r.text).toContain("SCREEN 200");
    expect(sap.orders.size).toBe(1);
    // Sent again on the screen it has now seen: it runs.
    const again = await batch([SAVE]);
    expect(again.text).toContain("S: Order 5001 has been saved");
  });
  test("writes off: the batch runs up to the save, which is refused", async () => {
    const { sap, batch } = await setup();
    const r = await batch([OPEN, CUSTOMER, { ...ENTER, expect: { screen: "200" } }, SAVE, { do: "okcode", value: "/nZA03", expect: { transaction: "ZA03" } }]);
    expect(r.error).toBe(true);
    expect(r.text.split("\n")[0]).toContain('Ran 3 of 5 actions. Stopped: action 4 ({"do":"key","key":11}) was refused: this action may write to SAP (key 11: Save) and writes are off.');
    expect(r.text.split("\n")[0]).toEndWith("Action 5 did not run.");
    expect(dos(sap)).toEqual(["okcode", "set", "key 0"]);
    expect(r.text).toContain("SCREEN 200");
  });

  test("confirm: the save is held with a token and ends the batch; sap_confirm runs it alone", async () => {
    const { sap, call, batch } = await setup({ SAP_WRITE: "confirm" });
    const r = await batch([OPEN, CUSTOMER, { ...ENTER, expect: { screen: "200" } }, { ...SAVE, unseen: true }, { do: "okcode", value: "/nZA03", expect: { transaction: "ZA03" } }]);
    expect(r.error).toBe(false);
    expect(r.text.split("\n")[0]).toBe('Ran 3 of 5 actions. Stopped: action 4 ({"do":"key","key":11}) may write and waits for the user\'s yes. Action 5 did not run.');
    expect(r.text).toContain("NOT RUN YET: needs the user's confirmation: key 11: Save, on ABA/800, ZA01");
    expect(sap.orders.size).toBe(1);
    const token = /token "([0-9a-f]+)"/.exec(r.text)?.[1] ?? "";
    const c = await call("sap_confirm", { token });
    expect(c.text).toContain("S: Order 5001 has been saved");
    expect(dos(sap)).toEqual(["okcode", "set", "key 0", "key 11"]);
  });

  test("confirm, with a client that asks the user: one question, for the save only; what follows it does not run", async () => {
    const { sap, batch, asked } = await setup({ SAP_WRITE: "confirm" }, "accept");
    const r = await batch([OPEN, CUSTOMER, { ...ENTER, expect: { screen: "200" } }, { ...SAVE, unseen: true }, { do: "okcode", value: "/nZA03" }]);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('Action: {"do":"key","key":11}');
    expect(r.text).toContain("S: Order 5001 has been saved");
    expect(r.text.split("\n")[0]).toEndWith("Action 5 did not run.");
    expect(sap.transaction).toBe("ZA01");

    const no = await setup({ SAP_WRITE: "confirm" }, "decline");
    const d = await no.batch([OPEN, CUSTOMER, { ...ENTER, expect: { screen: "200" } }, { ...SAVE, unseen: true }]);
    expect(d.text).toContain("the user declined");
    expect(no.sap.orders.size).toBe(1);
  });

  test("what needs no screen to be refused is refused before anything runs", async () => {
    const { sap, call, batch } = await setup({ SAP_WRITE: "on", SAP_BLOCK_TCODES: "ZA03" });
    for (const [bad, why] of [
      [{ do: "set", id: "okcd", value: "/nZA03" }, "command field"],
      [{ do: "okcode", value: "/nZA03" }, "ZA03 is blocked"],
      [{ do: "okcode", value: "/oZA01" }, "opens a new session"],
      [{ do: "key", key: 0, expect: { screeen: "1" } }, '"expect" has no "screeen"'],
    ] as const) {
      const r = await batch([OPEN, CUSTOMER, bad]);
      expect([why, r.error]).toEqual([why, true]);
      expect(r.text).toContain(why);
      expect(r.text.toLowerCase()).toContain("action 3 of 3");
      expect(r.text).toEndWith("Nothing ran.");
    }
    // A "do" the schema does not list is refused by the input validation, before the server runs anything.
    const unknown = await batch([OPEN, CUSTOMER, { do: "eval", id: "x" }]);
    expect(unknown.error).toBe(true);
    expect(unknown.text).toContain("actions[2].do");
    expect(sap.acts).toEqual([]);
    expect((await batch(Array.from({ length: MAX_BATCH + 1 }, () => ENTER))).text).toContain(`${MAX_BATCH} actions at most`);
    expect((await batch([])).error).toBe(true);
    expect((await call("sap_act", { action: ENTER, actions: [ENTER] })).text).toBe('Send one action ("do" and its fields) or "actions", not both.');
    expect((await call("sap_act", { ...ENTER, actions: [ENTER] })).error).toBe(true);
    expect(sap.acts).toEqual([]);
  });

  test("a recording gets one step per action of the batch, each with its own risk and screens", async () => {
    const { dir, call, batch } = await setup({ SAP_WRITE: "on" });
    await call("sap_record", { op: "start", name: "Batch" });
    await batch([OPEN, CUSTOMER, QUANTITY, { ...ENTER, expect: { screen: "200" } }, { ...SAVE, unseen: true }]);
    await call("sap_record", { op: "stop" });
    const t = parseTest(await readFile(join(dir, "batch.saptest.json"), "utf8"));
    expect(t.steps.map((s) => s.action?.do)).toEqual(["okcode", "set", "set", "key", "key"]);
    // The step is the action alone: what the batch needed to know ("expect", "unseen") is not part of it.
    expect(t.steps[3]?.action).toEqual({ do: "key", key: 0 });
    expect(t.steps[3]).toMatchObject({ on: { screen: "100" }, after: { screen: "200" } });
    expect(t.steps[4]).toMatchObject({ risk: "commit", after: { screen: "100", status: { type: "S" } } });
    const again = await call("sap_replay", { name: "Batch" });
    expect(again.text).toContain("PASS  Batch");
  });
});

describe("the rules that end a batch", () => {
  const screen = (lines: string[], head = "TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 101") => parseScreen([head, 'WINDOW wnd[0]  "Create"', ...lines].join("\n"));
  const set = normalizeAction({ do: "set", id: "a", value: "1" });
  const enter = normalizeAction({ do: "key", key: 0 });
  const error = "sbar  status  E: Enter a sales organization";

  test("an error that was there before does not end the batch at the field that corrects it; the same error after Enter does", () => {
    expect(stopAfter(set, screen([error]), screen([error]))).toBeUndefined();
    expect(stopAfter(enter, screen([error]), screen([error]))?.why).toBe("status");
    expect(stopAfter(set, screen([]), screen([error]))?.why).toBe("status");
  });
  test("a success or an information message does not end it", () => {
    expect(stopAfter(enter, screen([]), screen(["sbar  status  S: Saved"]))).toBeUndefined();
  });
  test("screen numbers compare without leading zeros; a popup that closes over the same main window is not another screen", () => {
    const next = screen([], "TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 4001");
    expect(stopAfter(enter, screen([]), next, { screen: "04001" })).toBeUndefined();
    expect(stopAfter(enter, screen([]), next, { screen: "4002" })?.why).toBe("expect");
    const popup = screen(['WINDOW wnd[1]  "Information"'], "TRANSACTION VA01  PROGRAM SAPMSDYP  SCREEN 10");
    expect(stopAfter(enter, popup, screen([]))).toBeUndefined();
    expect(stopAfter(enter, screen([]), popup)?.why).toBe("popup");
    expect(stopAfter(enter, screen([]), popup, { popup: true })).toBeUndefined();
    expect(stopAfter(enter, screen([]), screen([]), { popup: true })?.text).toBe("expected a popup (none opened)");
  });
  test("SAP still working on the step ends it", () => {
    expect(stopAfter(enter, screen([]), screen(["NOTE SAP is still working on a step (locked)"]))?.why).toBe("busy");
  });
  test("expect and show are not part of the action", () => {
    const [s] = parseBatch([{ do: "key", value: 0, expect: { screen: 4001, popup: false }, show: true }]);
    expect(s).toEqual({ action: normalizeAction({ do: "key", key: 0 }), expect: { screen: "4001", popup: false }, show: true, unseen: false });
  });
});
