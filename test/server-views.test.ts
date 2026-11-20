/** What the tools answer with: the whole screen, the changes, one control, a range of rows. */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { policyFromEnv } from "../src/core/guard.js";
import { ActionError } from "../src/core/types.js";
import type { ViewMode } from "../src/core/views.js";
import { createServer, parseRows } from "../src/server.js";
import { FakeSurface } from "./fakes.js";

// A synthetic compact view: no SAP data.
const screen = (type = "", status = "") =>
  [
    "TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100)",
    'WINDOW wnd[0]  "Synthetic Order: Initial Screen"',
    "okcd  command-field",
    "btn[3]  button  Back (F3)",
    "btn[15]  button  Exit (Shift+F3)",
    `ctxtZHDR-TYPE  field  Order Type = "${type}"  (edit)`,
    'ctxtZHDR-ORG  field  Sales Organization = "1000"  (edit)',
    'ctxtZHDR-CHAN  field  Distribution Channel = "10"  (edit)',
    ...(status ? [`sbar  status  ${status}`] : []),
    "mbar  menubar  Order {menu[0]}, Edit {menu[1]}, Goto {menu[2]}",
  ].join("\n");
const OVERVIEW = ["TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 200  SYSTEM XYZ (100)", 'WINDOW wnd[0]  "Synthetic Order: Overview"', 'ctxtZHDR-TYPE  field  Order Type = "AB"  (read-only)'].join("\n");

async function setup(view?: ViewMode) {
  const surface = new FakeSurface("webgui");
  // The SDK line each action answers with is tested in server.test.ts; here, the views.
  const { server } = createServer({ policy: policyFromEnv({}), surfaces: [surface], code: false, ...(view ? { view } : {}) });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    return { error: r.isError === true, text: r.content.map((c) => c.text ?? `<${c.type}>`).join("\n") };
  };
  return { surface, call };
}

describe("sap_act answers with what changed", () => {
  test("the same screen with one field changed: the note, then that line", async () => {
    const { surface, call } = await setup();
    const s = surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen(), onAct: (a, x) => void (x.view = screen(String(a.value))) });
    expect((await call("sap_look")).text).toBe(screen());
    const r = await call("sap_act", { action: { do: "set", id: "ctxtZHDR-TYPE", value: "AB" } });
    expect(r.text).toBe('did set\n\nCHANGED 1 of 9 lines (same screen; sap_look shows all of it):\n~ ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)');
    // The next answer counts from that one.
    delete s.onAct;
    expect((await call("sap_act", { action: { do: "set", id: "ctxtZHDR-TYPE", value: "AB" } })).text).toBe("did set\n\nNO CHANGE on the screen (9 lines; sap_look shows it).");
  });
  test("a new screen is always whole", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen("AB"), onAct: (_a, x) => void (x.view = OVERVIEW) });
    await call("sap_look");
    expect((await call("sap_act", { action: { do: "key", key: 0 } })).text).toBe(`did key\n\n${OVERVIEW}`);
  });
  test("the first action of a session, with no view given before, is whole", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen() });
    expect((await call("sap_act", { action: { do: "key", key: 0 } })).text).toBe(`did key\n\n${screen()}`);
  });
  test("full: true on the action, or SAP_VIEW=full, gives the whole screen", async () => {
    const one = await setup();
    one.surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen(), onAct: (a, x) => void (x.view = screen(String(a.value))) });
    await one.call("sap_look");
    expect((await one.call("sap_act", { action: { do: "set", id: "ctxtZHDR-TYPE", value: "AB" }, full: true })).text).toBe(`did set\n\n${screen("AB")}`);
    const all = await setup("full");
    all.surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen(), onAct: (a, x) => void (x.view = screen(String(a.value))) });
    await all.call("sap_look");
    expect((await all.call("sap_act", { action: { do: "set", id: "ctxtZHDR-TYPE", value: "AB" } })).text).toBe(`did set\n\n${screen("AB")}`);
  });
});

describe("sap_look", () => {
  test("is the whole screen, even when nothing changed; diff: true gives the changes", async () => {
    const { surface, call } = await setup();
    const s = surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen() });
    expect((await call("sap_look")).text).toBe(screen());
    expect((await call("sap_look")).text).toBe(screen());
    expect((await call("sap_look", { diff: true })).text).toBe("NO CHANGE on the screen (9 lines; sap_look shows it).");
    s.view = screen("", "E: Enter an order type");
    expect((await call("sap_look", { diff: true })).text).toBe("CHANGED 1 of 10 lines (same screen; sap_look shows all of it):\n+ sbar  status  E: Enter an order type");
  });
  test("full: true gives the full view, and later changes are counted from it", async () => {
    const { surface, call } = await setup();
    const s = surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen() });
    expect((await call("sap_look", { full: true })).text).toBe(`FULL ${screen()}`);
    s.view = screen("AB");
    expect((await call("sap_look", { diff: true })).text).toContain('~ ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)');
  });
  test("id and rows go to the surface, and leave what the agent holds of the screen alone", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen() });
    await call("sap_look");
    expect((await call("sap_look", { id: "cntlGRID1/shell" })).text).toBe("ONE cntlGRID1/shell");
    expect((await call("sap_look", { id: "cntlGRID1/shell", rows: "120-180" })).text).toBe("ONE cntlGRID1/shell rows 120-180");
    expect(surface.log.filter((l) => l.options).map((l) => l.options)).toEqual([
      { compact: true, id: "cntlGRID1/shell" },
      { compact: true, id: "cntlGRID1/shell", rows: { from: 120, to: 180 } },
    ]);
    expect((await call("sap_look", { diff: true })).text).toStartWith("NO CHANGE");
  });
  test("cols without rows reads the first rows; cols without an id is refused", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen() });
    await call("sap_look", { id: "cntlGRID1/shell", cols: "VBELN, NETWR" });
    expect(surface.log.filter((l) => l.options).map((l) => l.options)).toEqual([{ compact: true, id: "cntlGRID1/shell", rows: { from: 0, to: 49 }, cols: ["VBELN", " NETWR"] }]);
    expect((await call("sap_look", { cols: "VBELN" })).text).toContain('"cols" needs "id"');
  });
  test("rows without an id, or a range that is not one, is refused", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" });
    expect((await call("sap_look", { rows: "0-9" })).text).toContain('"rows" needs "id"');
    expect((await call("sap_look", { id: "x", rows: "ten" })).text).toContain('"rows" is a range counted from 0');
    expect(parseRows("120-180")).toEqual({ from: 120, to: 180 });
    expect(parseRows(" 7 ")).toEqual({ from: 7, to: 7 });
    expect(parseRows("5 to 9")).toEqual({ from: 5, to: 9 });
    expect(() => parseRows("9-5")).toThrow("ends before it starts");
    expect(() => parseRows("0-200")).toThrow("200 rows at most");
  });
});

describe("an action that cannot run", () => {
  const missing = new ActionError('No control "ctxtZOLD" on this screen. Use an id from the screen you are on (it may have changed since your last look).');
  test("an id of an earlier screen: the error, then the screen the session is really on", async () => {
    const { surface, call } = await setup();
    const s = surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen() });
    await call("sap_look");
    // The user, or SAP, moved the session on since.
    s.view = OVERVIEW;
    s.failAct = missing;
    const r = await call("sap_act", { action: { do: "set", id: "ctxtZOLD", value: "1" } });
    expect(r.error).toBe(true);
    expect(r.text).toBe(`${missing.message}\nThe screen is not as you last saw it:\n\n${OVERVIEW}`);
  });
  test("on the screen the agent already holds: the error and where the session is, in one line", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen(), failAct: missing });
    await call("sap_look");
    const r = await call("sap_act", { action: { do: "set", id: "ctxtZOLD", value: "1" } });
    expect(r.error).toBe(true);
    expect(r.text).toBe(`${missing.message}\nThe screen is as you last saw it: TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100)  WINDOW wnd[0]  "Synthetic Order: Initial Screen"`);
  });
  test("any other failure comes with the screen too, when it can be read", async () => {
    const { surface, call } = await setup();
    const s = surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: screen(), failAct: new Error("the step timed out") });
    await call("sap_look");
    const r = await call("sap_act", { action: { do: "key", key: 0 } });
    expect(r).toEqual({ error: true, text: 'the step timed out\nThe screen is as you last saw it: TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100)  WINDOW wnd[0]  "Synthetic Order: Initial Screen"' });
    expect(s.info.id).toBe("chrome:1");
  });
});
