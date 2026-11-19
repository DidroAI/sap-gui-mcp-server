import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { policyFromEnv } from "../src/core/guard.js";
import { diagView } from "../src/diag/index.js";
import type { Surface } from "../src/core/types.js";
import { exportTest } from "../src/record/export/index.js";
import { parseTest, type SapTest } from "../src/record/format.js";
import { recorderOptionsFromEnv } from "../src/record/recorder.js";
import { detour, type ReplayResult, replay } from "../src/record/replay.js";
import { locate, parseScreen } from "../src/record/screen.js";
import { createServer } from "../src/server.js";
import { FakeDiagSap } from "./diag-record-fakes.js";
import { FakeSap } from "./record-fakes.js";

async function setup(sap: Surface = new FakeDiagSap(), env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sapdiagrec-"));
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
  const json = async (args: Record<string, unknown>) => {
    const r = await call("sap_replay", { format: "json", ...args });
    if (!r.text.startsWith("{")) throw new Error(r.text);
    return { error: r.error, result: JSON.parse(r.text) as ReplayResult & { text: string } };
  };
  return { dir, policy, call, act, rec, json };
}

/** VA03-like: open ZA03, type the order, Enter, check the customer, the item's material and the title, capture the net value. */
async function recordDisplay(sap = new FakeDiagSap()) {
  const s = await setup(sap);
  const said = [
    await s.rec("start", { name: "diag display" }),
    await s.act({ do: "okcode", value: "/nZA03" }),
    await s.act({ do: "set", id: "ZORD-VBELN", value: "5000" }),
    await s.act({ do: "key", key: 0 }),
    await s.rec("assert", { check: "field", id: "ZORD-KUNNR", equals: "2200" }),
    await s.rec("assert", { check: "field", id: "ZPOS-MATNR[0]" }),
    await s.rec("assert", { check: "title", contains: "Overview" }),
    await s.rec("capture", { name: "net", from: "field", id: "ZORD-NETWR" }),
  ];
  for (const r of said) expect(r.error).toBe(false);
  await s.rec("stop");
  const test = parseTest(await readFile(join(s.dir, "diag-display.saptest.json"), "utf8"));
  return { ...s, sap, test };
}

describe("the DIAG view as the recorder reads it", () => {
  const sap = new FakeDiagSap();
  sap.run({ do: "okcode", value: "/nZA03" });
  sap.run({ do: "set", id: "ZORD-VBELN", value: "5000" });
  sap.run({ do: "key", key: 0 });
  const s = parseScreen(diagView(sap.screen()));

  test("header, window, title, method", () => {
    expect([s.method, s.transaction, s.program, s.screen, s.system, s.title]).toEqual(["diag", "ZA03", "SAPMZA03", "300", "XYZ (100)", "Display Order 5000: Overview"]);
    expect(s.windows).toEqual([{ id: "wnd[0]", title: "Display Order 5000: Overview" }]);
  });

  test("fields by SAP name with their label and value; checkbox, button, tab, table cell", () => {
    const of = (id: string) => {
      const c = locate(s, id)?.control;
      return [c?.type, c?.label, c?.value];
    };
    expect(of("ZORD-VBELN")).toEqual(["field", "Order", "5000"]);
    expect(of("ZORD-KUNNR")).toEqual(["field", "Customer", "2200"]);
    expect(of("ZORD-NETWR")).toEqual(["field", "Net value", "1.250,00"]);
    expect(of("ZORD-RUSH")).toEqual(["checkbox", "Rush order", "true"]);
    expect(of("{HEAD}")).toEqual(["button", "Header", "Header"]);
    expect(of("{T\\01}")).toEqual(["tab", "Sales", "selected"]);
    expect(of("{T\\02}")).toEqual(["tab", "Shipping", ""]);
    expect(of("ZPOS-MATNR[0]")).toEqual(["field", "Material, row 1", "M-08"]);
    expect(of("TC_ITEMS")?.[0]).toBe("table");
    // A function key: its text, with the key it is.
    expect(locate(s, "Back")?.control.vkey).toBe(3);
    expect(locate(s, "Document flow")?.control.vkey).toBe(5);
    expect(locate(s, "ZORD-VBELN")?.control.rest).toContain("(read-only)");
  });

  test("status bar, in either form", () => {
    const a = parseScreen('TRANSACTION ZA03  PROGRAM SAPMZA03  SCREEN 100  SYSTEM XYZ (100)  USER T  MODE 0\nstatus  E: Order 9 does not exist  (ZZ 001)\nWINDOW 0  "Display Order: Initial Screen"  area 20x100\nr2  Order  ZORD-VBELN@18=[9]');
    expect(a.status).toEqual({ type: "E", text: "Order 9 does not exist" });
    expect(locate(a, "ZORD-VBELN")?.control.value).toBe("9");
    const b = parseScreen('TRANSACTION ZA03  PROGRAM SAPMZA03  SCREEN 100  SYSTEM XYZ (100)  USER T  MODE 0\nWINDOW 0  "x"  area 20x100\nsbar  status  W: Check the date');
    expect(b.status).toEqual({ type: "W", text: "Check the date" });
  });

  test("popups, lists, grids, trees, text editors, notes after an element", () => {
    const v = [
      "TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 101  SYSTEM XYZ (100)  USER T  MODE 0",
      'WINDOW 0  "Create Order: Initial Screen"  area 20x100',
      "(behind the popup: its keys and toolbar are left out)",
      "r2  Order Type  VBAK-AUART@22=[OR] (required) (typed, sent with the next Enter)  [ ] Rush ZORD-RUSH@40  ( ) A ZORD-A@50 (read-only)",
      "r3  Block  VBAK-LIFSK@18=dropdown [07]  VBAK-FAKSK@30=dropdown \"\"",
      "r4  tree NAV (shell 7)  2 nodes on show",
      "  [-] Sales  {N1}",
      "    Orders (selected)  {N2}",
      'r5  text-editor TXT (shell 8) (read-only)  "Deliver to gate 1"',
      "r6  grid GRID1 (shell 9)  2 rows, 2 columns: VBELN=Order / Ord. | NETWR=Net value",
      "  row 0: 10792 | 55.269,00",
      "  row 1: 10804 | 43.750,00",
      'WINDOW 1 popup  "Order Type 3 Entries"  SAPMSSY0 0120  at r3 c24  area 24x34',
      "toolbar: Copy (Enter) | Cancel (F12)",
      "list  3 rows; columns at c1 c6",
      "r1  SaTy | Description",
      "r3  OR | Standard Order",
      "r4  RE | Returns",
      "cursor: r3 c1",
    ].join("\n");
    const p = parseScreen(v);
    expect(p.title).toBe("Order Type 3 Entries");
    expect(p.windows.map((w) => w.id)).toEqual(["wnd[0]", "wnd[1]"]);
    const c = (id: string) => locate(p, id)?.control;
    expect([c("VBAK-AUART")?.value, c("VBAK-AUART")?.label, c("VBAK-AUART")?.rest]).toEqual(["OR", "Order Type", "VBAK-AUART@22=[OR] (required) (typed, sent with the next Enter)"]);
    expect([c("ZORD-RUSH")?.type, c("ZORD-RUSH")?.value, c("ZORD-A")?.type, c("ZORD-A")?.value]).toEqual(["checkbox", "false", "radio", "false"]);
    expect([c("VBAK-LIFSK")?.value, c("VBAK-FAKSK")?.rest]).toEqual(["07", 'VBAK-FAKSK@30=dropdown "" (read-only)']);
    expect([c("{N1}")?.type, c("{N1}")?.value, c("{N2}")?.value]).toEqual(["node", "Sales", "Orders"]);
    expect([c("TXT")?.type, c("TXT")?.value]).toEqual(["textedit", "Deliver to gate 1"]);
    expect([c("GRID1[1]")?.type, c("GRID1[1]")?.value, c("GRID1[1].NETWR")?.value]).toEqual(["row", "10804 | 43.750,00", "43.750,00"]);
    expect([c("@3,1")?.value, c("@4,6")?.value, c("@4,6")?.window]).toEqual(["OR", "Returns", "wnd[1]"]);
    expect([c("Copy")?.vkey, c("Copy")?.window]).toEqual([0, "wnd[1]"]);
    // A hit list is a choice: a replay does not answer it.
    expect(detour(p)?.kind).toBe("stop");
  });

  test("an Information popup on the DIAG view is passed with its Enter key; a question stops", () => {
    const head = 'TRANSACTION ZA03  PROGRAM SAPLSPO1  SCREEN 100  SYSTEM XYZ (100)  USER T  MODE 0\nWINDOW 0  "Display Order"  area 20x100\nWINDOW 1 popup  "Information"  SAPLSPO1 0100  area 6x50';
    const info = detour(parseScreen(`${head}\nkeys: Cancel (F12)\ntoolbar: Continue (Enter)\nr1  Order is blocked`));
    expect([info?.kind, info?.action, info?.answer, info?.what]).toEqual(["pass", { do: "key", key: 0 }, "pressed Continue", 'popup "Information" (Order is blocked)']);
    expect(detour(parseScreen(`${head}\nkeys: Cancel (F12)\nr1  Display it anyway  <Yes>{SPOP1}@2  <No>{SPOP2}@14`))?.kind).toBe("stop");
  });

  test("the logon screen is recognised", () => {
    expect(parseScreen('TRANSACTION   PROGRAM SAPMSYST  SCREEN 20  SYSTEM XYZ (100)  MODE 0\nWINDOW 0  "SAP"  area 20x100').logon).toBe(true);
  });
});

describe("recording on the DIAG method", () => {
  test("steps with their targets, the screen they led to, checks and a capture", async () => {
    const { test: t } = await recordDisplay();
    expect(t.recorded).toMatchObject({ surface: "sapgui", method: "diag", system: "XYZ", client: "100" });
    expect(t.start).toMatchObject({ transaction: "SMEN", program: "SAPLSMTR_NAVIGATION" });
    expect(t.steps.map((s) => s.action)).toEqual([{ do: "okcode", value: "/nZA03" }, { do: "set", id: "ZORD-VBELN", value: "5000" }, { do: "key", key: 0 }]);
    expect(t.steps[1]?.target).toEqual({ id: "ZORD-VBELN", type: "field", label: "Order" });
    expect(t.steps[0]?.after).toMatchObject({ transaction: "ZA03", program: "SAPMZA03", screen: "100", title: "Display Order: Initial Screen" });
    expect(t.steps[2]?.after).toMatchObject({ program: "SAPMZA03", screen: "300", title: "Display Order 5000: Overview" });
    expect(t.steps[2]?.expect).toEqual([
      { check: "field", id: "ZORD-KUNNR", type: "field", label: "Customer", op: "equals", value: "2200" },
      { check: "field", id: "ZPOS-MATNR[0]", type: "field", label: "Material, row 1", op: "equals", value: "M-08" },
      { check: "title", op: "contains", value: "Overview" },
    ]);
    expect(t.steps[2]?.capture).toEqual([{ var: "net", from: "field", id: "ZORD-NETWR", label: "Net value" }]);
    expect(t.variables.net?.value).toBe("1.250,00");
  });

  test("a check that does not hold on the DIAG screen is refused, an unknown id too", async () => {
    const s = await setup();
    await s.rec("start", { name: "x" });
    await s.act({ do: "okcode", value: "/nZA03" });
    expect((await s.rec("assert", { check: "field", id: "ZORD-VBELN", equals: "1" })).text).toContain("does not hold");
    expect((await s.rec("assert", { check: "field", id: "NOPE-NOPE" })).text).toContain("No control NOPE-NOPE");
  });

  test("a DIAG recording does not become a SAP GUI script", async () => {
    const { test: t } = await recordDisplay();
    expect(() => exportTest(t, "vbs")).toThrow("DIAG method");
    expect(exportTest(t, "gherkin").text).toContain("ZORD-VBELN");
  });
});

describe("replaying on the DIAG method", () => {
  test("the same screens: passes, with the checks and the capture judged", async () => {
    const { json } = await recordDisplay();
    const { error, result } = await json({ name: "diag display" });
    expect(error).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.steps.map((s) => s.outcome)).toEqual(["pass", "pass", "pass"]);
    expect(result.steps[2]?.passed).toEqual(['${net} = "1.250,00"', '"Customer" (ZORD-KUNNR) is "2200"', '"Material, row 1" (ZPOS-MATNR[0]) is "M-08"', 'the window title contains "Overview" (it is "Display Order 5000: Overview")']);
    expect(result.text).toStartWith("PASS  diag display  on sapgui XYZ/100");
  });

  test("an order SAP does not have fails at the landing, with SAP's error", async () => {
    const sap = new FakeDiagSap();
    const { json } = await recordDisplay(sap);
    sap.orders.delete("5000");
    const { result } = await json({ name: "diag display" });
    expect(result.passed).toBe(false);
    expect(result.steps[2]?.phase).toBe("landing");
    expect(result.steps[2]?.failures[0]).toBe("SAP reported an error in the status bar: Order 5000 does not exist");
  });

  test("a renamed field fails honestly at the check of the changed step", async () => {
    const sap = new FakeDiagSap();
    const { json } = await recordDisplay(sap);
    sap.customerField = "ZORD-KUNAG";
    const { result } = await json({ name: "diag display" });
    expect(result.passed).toBe(false);
    expect(result.steps.map((s) => s.outcome)).toEqual(["pass", "pass", "fail"]);
    expect(result.steps[2]?.phase).toBe("check");
    expect(result.steps[2]?.failures).toEqual(['"Customer" (ZORD-KUNNR) is not on the screen; expected it to be "2200"']);
    expect(result.screenFull).toContain("ZORD-KUNAG@17=");
  });

  test("an unrecorded screen stops the run at the landing", async () => {
    const sap = new FakeDiagSap();
    const { json } = await recordDisplay(sap);
    sap.overview = "0310";
    const { result } = await json({ name: "diag display" });
    expect(result.steps[2]?.phase).toBe("landing");
    expect(result.steps[2]?.failures[0]).toContain("landed on another screen: ZA03 SAPMZA03/310");
  });

  test("an Information popup is confirmed with Enter and noted; a question stops the step", async () => {
    const sap = new FakeDiagSap();
    const { json } = await recordDisplay(sap);
    sap.popupsFor.set("5000", [{ title: "Information", text: "Order is blocked for delivery" }]);
    const ok = await json({ name: "diag display" });
    expect(ok.result.passed).toBe(true);
    expect(ok.result.steps[2]?.warnings).toEqual(['SAP showed a popup "Information" (Order is blocked for delivery) that the recording does not have: the replay pressed Continue']);
    expect(sap.acts.at(-1)).toEqual({ do: "key", key: 0 });
    sap.popupsFor.set("5000", [{ title: "Archived order", text: "Display it anyway", question: true }]);
    const no = await json({ name: "diag display" });
    expect(no.result.passed).toBe(false);
    expect(no.result.steps[2]?.phase).toBe("landing");
    expect(no.result.steps[2]?.failures[0]).toContain('SAP showed a popup "Archived order" (Display it anyway)');
  });

  test("a repair answers the question and the recorded checks judge the step: a proposed test", async () => {
    const sap = new FakeDiagSap();
    const { json, test: t } = await recordDisplay(sap);
    sap.popupsFor.set("5000", [{ title: "Archived order", text: "Display it anyway", question: true }]);
    expect((await json({ name: "diag display" })).result.steps[2]?.phase).toBe("landing");
    const { error, result } = await json({ name: "diag display", from: 3, repair: { why: "SAP asks whether to display an archived order", actions: [{ do: "press", id: "{SPOP1}" }], place: "after" } });
    expect(error).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.steps[0]?.repair).toMatchObject({ outcome: "repaired", did: ['{"do":"press","id":"{SPOP1}"}'] });
    const p = result.proposal as NonNullable<ReplayResult["proposal"]>;
    expect(p.changes[1]).toBe('Added after step 3: {"do":"press","id":"{SPOP1}"}. The checks of step 3 now follow the added action.');
    const added = p.test.steps[3];
    expect(added?.action).toEqual({ do: "press", id: "{SPOP1}" });
    expect(added?.target).toEqual({ id: "{SPOP1}", type: "button", label: "Display" });
    expect(added?.expect).toEqual(t.steps[2]?.expect);
    expect(p.test.recorded.method).toBe("diag");
  });

  test("a repair for a field that has another name now: typed into the new one instead", async () => {
    const sap = new FakeDiagSap();
    const { json } = await recordDisplay(sap);
    sap.orderField = "ZORD-AUFNR";
    const first = (await json({ name: "diag display" })).result;
    expect(first.steps[1]?.phase).toBe("act");
    expect(first.steps[1]?.failures[0]).toContain('Nothing on the screen matches "ZORD-VBELN"');
    const { result } = await json({ name: "diag display", from: 2, repair: { why: "the order field is ZORD-AUFNR now", actions: [{ do: "set", id: "ZORD-AUFNR", value: "5000" }], place: "instead" } });
    expect(result.passed).toBe(true);
    expect(result.proposal?.changes[1]).toBe('Step 2 replaced by: {"do":"set","id":"ZORD-AUFNR","value":"5000"}. Its checks are unchanged.');
    expect(result.proposal?.test.steps[1]?.target).toEqual({ id: "ZORD-AUFNR", type: "field", label: "Order" });
    // A repair does not type what is neither recorded nor on the screen.
    const made = await json({ name: "diag display", from: 2, repair: { why: "x", actions: [{ do: "set", id: "ZORD-AUFNR", value: "7777" }], place: "instead" } });
    expect(made.result.steps[0]?.failures[0]).toContain("a repair does not invent data");
  });

  test("a DIAG recording is not replayed through SAP GUI scripting, nor the other way", async () => {
    const { test: t, policy } = await recordDisplay();
    const scripting = new FakeSap("sapgui");
    const r = await replay(scripting.driver(), policy, t);
    expect(r.aborted).toContain("recorded through the DIAG method (SAP_GUI_METHOD=diag); this session is read through SAP GUI scripting");
    const back: SapTest = { ...t, recorded: { ...t.recorded, method: undefined } as SapTest["recorded"] };
    const r2 = await replay(new FakeDiagSap().driver(), policy, back);
    expect(r2.aborted).toContain("recorded through SAP GUI scripting");
  });

  test("a popup left open is closed before step 1 with the DIAG ids", async () => {
    const sap = new FakeDiagSap();
    const { test: t, policy } = await recordDisplay(sap);
    sap.run({ do: "okcode", value: "/nZA03" });
    sap.popups = [{ title: "Information", text: "Welcome" }];
    const r = await replay(sap.driver(), policy, t);
    expect(r.passed).toBe(true);
    expect(r.before).toEqual(['popup "Information" (Welcome) was open: pressed Continue']);
  });
});
