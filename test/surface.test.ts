/**
 * The tool surface an agent sees: what tools/list holds (schemas,
 * annotations), the input shapes sap_act takes, and what the answers say.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { policyFromEnv } from "../src/core/guard.js";
import { type Action, ActionError, type Assessment } from "../src/core/types.js";
import { goOnText } from "../src/record/tools.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recorderOptionsFromEnv } from "../src/record/recorder.js";
import { codeFromEnv, createServer, type ServerOptions, withNextStep } from "../src/server.js";
import { confirmLogNote } from "../src/stdio.js";
import { FakeSurface } from "./fakes.js";

/** Save (key 11) commits; everything else navigates. */
const assess = (a: Action): Assessment => (a.do === "key" && a.key === 11 ? { risk: "commit", reason: "key 11: Save" } : { risk: "navigate", reason: a.do });

async function setup(env: Record<string, string> = {}, more: Partial<ServerOptions> = {}) {
  const surface = new FakeSurface("webgui");
  const { server } = createServer({ policy: policyFromEnv(env), surfaces: [surface], ...more });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };
    return { error: r.isError === true, text: r.content.map((c) => c.text ?? `<${c.type}>`).join("\n"), structured: r.structuredContent };
  };
  return { surface, client, call };
}

describe("tools/list", () => {
  test('no input schema carries "$schema"', async () => {
    for (const write of ["off", "confirm", "on"]) {
      const { client } = await setup({ SAP_WRITE: write });
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(6);
      expect(JSON.stringify(tools)).not.toContain('"$schema"');
      // The spec's default, said for every tool by the SDK.
      expect(JSON.stringify(tools)).not.toContain('"taskSupport":"forbidden"');
    }
  });

  test("annotations: a closed system everywhere; reads are idempotent; acting is destructive with writes on", async () => {
    const { client } = await setup({ SAP_WRITE: "on" });
    const { tools } = await client.listTools();
    const of = (name: string) => tools.find((t) => t.name === name)?.annotations ?? {};
    for (const t of tools) expect([t.name, t.annotations?.openWorldHint]).toEqual([t.name, false]);
    for (const name of ["sap_look", "sap_sessions", "sap_screenshot"]) expect([name, of(name).readOnlyHint, of(name).idempotentHint]).toEqual([name, true, true]);
    for (const name of ["sap_act", "sap_replay"]) expect([name, of(name).destructiveHint]).toEqual([name, true]);
    expect([of("sap_use").readOnlyHint, of("sap_use").idempotentHint]).toEqual([true, true]);
  });
  test("acting is destructive only when a write or a log off can run without the server asking", async () => {
    // Under confirm (the default) the server asks before each write itself: the client need not ask before each call.
    for (const [env, want] of [
      [{}, false],
      [{ SAP_WRITE: "confirm" }, false],
      [{ SAP_WRITE: "off" }, false],
      [{ SAP_WRITE: "confirm", SAP_ALLOW_LOGOFF: "on" }, true],
      [{ SAP_WRITE: "off", SAP_ALLOW_LOGOFF: "on" }, true],
      [{ SAP_WRITE: "on" }, true],
    ] as const) {
      const { client } = await setup(env);
      const { tools } = await client.listTools();
      for (const name of ["sap_act", "sap_replay"]) expect([env, name, tools.find((t) => t.name === name)?.annotations?.destructiveHint]).toEqual([env, name, want]);
    }
  });
  test("the server says who it is", async () => {
    const { client } = await setup({});
    expect(client.getServerVersion()).toMatchObject({ name: "sap-ui-automation", title: "SAP UI Automation", websiteUrl: "https://github.com/DidroAI/sap-ui-automation" });
  });
});

describe("arguments that do not fit (agent-practice review, 2026-11-24)", () => {
  test("are said in plain words, with the field", async () => {
    const { client } = await setup({});
    const r = (await client.callTool({ name: "sap_look", arguments: { full: "yes" } })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe('sap_look was called with arguments that do not fit: "full": expected boolean, received string. The tool\'s description lists its fields.');
  });
  test('sap_record takes "do" for "op"', async () => {
    const { client } = await setup({});
    const r = (await client.callTool({ name: "sap_record", arguments: { do: "help" } })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toStartWith("sap_record ops");
  });
  test("a tool without parameters says it takes none", async () => {
    const { client } = await setup({});
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "sap_sessions")?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });
});

describe("descriptions as instructions", () => {
  test("each description fits what clients show whole (under 4,096 characters), and says when to use the tool", async () => {
    for (const write of ["off", "confirm", "on"]) {
      const { client } = await setup({ SAP_WRITE: write });
      for (const t of (await client.listTools()).tools) {
        expect([t.name, (t.description ?? "").length < 4096]).toEqual([t.name, true]);
        expect([t.name, (t.description ?? "").length > 150]).toEqual([t.name, true]);
      }
    }
  });
  test("the first 512 characters of the instructions name the user's words and where to start", async () => {
    const { client } = await setup();
    const head = (client.getInstructions() ?? "").slice(0, 512);
    for (const w of ["SAP GUI", "Web GUI", "Fiori", "VA01", "ALV", "popup", "sap_look", "okcode /n<transaction>", "never logs on"]) expect([w, head.includes(w)]).toEqual([w, true]);
  });
  test("sap_act carries the SAP habits and the batch", async () => {
    const { client } = await setup();
    const act = (await client.listTools()).tools.find((t) => t.name === "sap_act")?.description ?? "";
    for (const w of ["set only types", "one Enter", "f4 on the field", "answer it before anything else", "actions:", "expect", "show:true", "unseen:true", "timeout", "focus", "tell the user what you would have saved"])
      expect([w, act.includes(w)]).toEqual([w, true]);
  });
  test('sap_record {"op":"help"} gives every op with an example; the description does not', async () => {
    const { client, call } = await setup();
    const help = await call("sap_record", { op: "help" });
    expect(help.error).toBe(false);
    for (const op of ["start", "assert", "variable", "capture", "note", "undo", "status", "code", "stop", "list", "export"]) expect([op, help.text.includes(`{"op":"${op}"`)]).toEqual([op, true]);
    const record = (await client.listTools()).tools.find((t) => t.name === "sap_record")?.description ?? "";
    expect(record).toContain('{"op":"help"}');
    expect(record).not.toContain('{"op":"capture"');
  });
});

describe("the code: line", () => {
  const recording = async (code?: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "sap-surface-"));
    const s = await setup({}, { record: recorderOptionsFromEnv({ SAP_RECORD_DIR: dir }, "test"), ...(code === undefined ? {} : { code }) });
    s.surface.add({ id: "chrome:1", system: "ABA", transaction: "VA03" }, { assess, view: "TRANSACTION VA03  PROGRAM SAPMV45A  SCREEN 102\nctxtVBAK-VBELN  field  Order = \"\"  (edit)" });
    return s;
  };
  test("is off by default, on while a recording is on, in single answers and in a batch", async () => {
    const { call } = await recording();
    expect((await call("sap_act", { do: "set", id: "ctxtVBAK-VBELN", value: "1" })).text).not.toContain("code:");
    expect((await call("sap_act", { actions: [{ do: "set", id: "ctxtVBAK-VBELN", value: "2" }] })).text).not.toContain("code:");
    // The draft needs no recording.
    expect((await call("sap_record", { op: "code" })).text).toContain('await sap.set("ctxtVBAK-VBELN", "2");');
    expect((await call("sap_record", { op: "start", name: "t" })).error).toBe(false);
    expect((await call("sap_act", { do: "set", id: "ctxtVBAK-VBELN", value: "3" })).text).toContain('code: await sap.set("ctxtVBAK-VBELN", "3");');
    expect((await call("sap_act", { actions: [{ do: "set", id: "ctxtVBAK-VBELN", value: "4" }] })).text).toContain('code:\nawait sap.set("ctxtVBAK-VBELN", "4");');
    await call("sap_record", { op: "stop" });
    expect((await call("sap_act", { do: "set", id: "ctxtVBAK-VBELN", value: "5" })).text).not.toContain("code:");
  });
  test("SAP_CODE forces it: off even while recording, on without a recording", async () => {
    const off = await recording(false);
    await off.call("sap_record", { op: "start", name: "t" });
    expect((await off.call("sap_act", { do: "set", id: "ctxtVBAK-VBELN", value: "1" })).text).not.toContain("code:");
    const on = await recording(true);
    expect((await on.call("sap_act", { do: "set", id: "ctxtVBAK-VBELN", value: "1" })).text).toContain("code: await sap.set");
    expect([codeFromEnv("on"), codeFromEnv("OFF"), codeFromEnv(undefined), codeFromEnv("")]).toEqual([true, false, undefined, undefined]);
  });
});

describe("sap_act's input: flat, with the older action object as an alias", () => {
  const cases: Record<string, unknown>[] = [
    { do: "set", id: "ctxtVBAK-AUART", value: "OR" },
    { do: "key", key: 0 },
    { do: "check", id: "chkX", value: false },
    { do: "grid", id: "cntlGRID/shellcont/shell", row: 3, col: "VBELN", how: "double" },
    { do: "scroll", id: "tblX", to: "next" },
    { do: "okcode", value: "/nVA03" },
  ];
  test("the same action reaches the surface either way", async () => {
    for (const a of cases) {
      const flat = await setup();
      flat.surface.add({ id: "chrome:1", system: "ABA" }, { assess });
      const old = await setup();
      old.surface.add({ id: "chrome:1", system: "ABA" }, { assess });
      const r1 = await flat.call("sap_act", a);
      const r2 = await old.call("sap_act", { action: a });
      expect([a, r1.error]).toEqual([a, false]);
      expect(r1.text).toBe(r2.text);
      expect(flat.surface.log).toEqual(old.surface.log);
      expect(flat.surface.acts().length).toBe(1);
    }
  });
  test('"timing" and "timeout" go with a flat action as they did inside "action"', async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA" }, { timing: "5 ms" });
    const r = await call("sap_act", { do: "key", key: 0, timeout: 300, timing: true });
    expect(r.text).toContain("(timing:");
    expect(surface.acts()).toEqual([{ do: "key", key: 0, timeout: 300 }]);
  });
  test("both shapes at once, or a flat action with actions, is refused and nothing runs", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA" }, { assess });
    expect((await call("sap_act", { do: "key", key: 0, action: { do: "key", key: 0 } })).error).toBe(true);
    expect((await call("sap_act", { do: "key", key: 0, actions: [{ do: "key", key: 0 }] })).error).toBe(true);
    expect(surface.log).toEqual([]);
  });
  test("an object as value is refused by the schema", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA" }, { assess });
    expect((await call("sap_act", { do: "set", id: "x", value: { a: 1 } })).error).toBe(true);
    expect(surface.log).toEqual([]);
  });
});

describe("error answers say what to do next", () => {
  test("a write under confirm, with a client that cannot ask: refused, nothing ran, what the user can do", async () => {
    const { surface, call } = await setup({ SAP_WRITE: "confirm" });
    surface.add({ id: "chrome:1", system: "ABA", client: "800", transaction: "VA02" }, { assess });
    const r = await call("sap_act", { do: "key", key: 11 });
    expect(r.error).toBe(true);
    for (const w of ["cannot ask the user", "Nothing ran", "do not look for another way", "SAP_WRITE=on", "MCP elicitation"]) expect([w, r.text.includes(w)]).toEqual([w, true]);
    expect(surface.acts()).toEqual([]);
  });
  test("by default (confirm, never chosen), a client that cannot ask gets the write refused, and how to get writes or go read-only", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA", client: "800", transaction: "VA02" }, { assess });
    const look = await call("sap_look");
    expect(look.text).toStartWith("NOTE: writing is set to confirm, and this client cannot ask the user");
    const r = await call("sap_act", { do: "key", key: 11 });
    expect(r.error).toBe(true);
    for (const w of ["writing is set to confirm", "cannot ask the user", "Nothing ran", "use a client that asks", "SAP_WRITE=on on a test system", "SAP_WRITE=off makes the server read-only"])
      expect([w, r.text.includes(w)]).toEqual([w, true]);
    expect(surface.acts()).toEqual([]);
  });
  test("the server log says once that a client that cannot ask gets writes refused, and how to get writes or silence it", () => {
    const unset = confirmLogNote({}, false) ?? "";
    expect(unset).toContain("SAP_WRITE is confirm (the default)");
    for (const w of ["will be refused", "use a client that supports elicitation", "SAP_WRITE=on on a test system", "SAP_WRITE=off to make the server read-only"]) expect([w, unset.includes(w)]).toEqual([w, true]);
    expect(confirmLogNote({ SAP_WRITE: "confirm" }, false)).toContain("SAP_WRITE=confirm, but");
    expect(confirmLogNote({}, true)).toBeUndefined();
    expect(confirmLogNote({ SAP_WRITE: "off" }, false)).toBeUndefined();
    expect(confirmLogNote({ SAP_WRITE: "on" }, false)).toBeUndefined();
  });
  test("a write refused with writing off: tell the user, do not look for another way", async () => {
    const { surface, call } = await setup({ SAP_WRITE: "off" });
    surface.add({ id: "chrome:1", system: "ABA" }, { assess });
    const r = await call("sap_act", { do: "key", key: 11 });
    expect(r.error).toBe(true);
    expect(r.text).toContain("Tell the user what you would have saved; do not look for another way.");
    // How to leave so the lock is released (live 2026-11-20: VA02 and MM02 were left open and locked).
    expect(r.text).toContain('leave it now without saving so SAP releases the lock on that document: {"do":"okcode","value":"/n"}');
    expect(r.text).toContain("Do not leave it open for the user to save by hand");
  });
  test("a declined confirmation says to stop", async () => {
    const surface = new FakeSurface("webgui");
    surface.add({ id: "chrome:1", system: "ABA", transaction: "VA02" }, { assess });
    const { server } = createServer({ policy: policyFromEnv({ SAP_WRITE: "confirm" }), surfaces: [surface] });
    const client = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: "sap_act", arguments: { do: "key", key: 11 } })) as { content: { text: string }[] };
    expect(r.content[0]?.text).toContain("the user declined");
    expect(r.content[0]?.text).toContain("Stop here: do not retry it");
    expect(r.content[0]?.text).toContain('{"do":"okcode","value":"/n"}');
    expect(surface.acts()).toEqual([]);
  });
  test('"read-only" and "does not scroll" add the next step, with the screen', async () => {
    for (const message of ["ctxtVBAK-VKORG is read-only.", "tblX does not scroll."]) {
      const { surface, call } = await setup();
      surface.add({ id: "chrome:1", system: "ABA" }, { view: "TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 101\nsbar  status  W: Check the date", failAct: new ActionError(message) });
      const r = await call("sap_act", { do: "set", id: "ctxtVBAK-VKORG", value: "1000" });
      expect(r.error).toBe(true);
      expect(r.text).toStartWith(`${message}\nNext: read the status bar and any popup`);
      expect(r.text).toContain("W: Check the date");
    }
    expect(withNextStep("No control ctxtX.")).toBe("No control ctxtX.");
  });
  test("a failed replay says how to go on (from, repair); the schema no longer does", async () => {
    const text = goOnText(4);
    for (const w of ['"from":4', '"repair":{"why"', "before|instead|after", '"capture":{"var"', "nothing is saved", "Do not replay to retry a failed write"]) expect([w, text.includes(w)]).toEqual([w, true]);
    const { client } = await setup();
    const replay = (await client.listTools()).tools.find((t) => t.name === "sap_replay");
    expect(JSON.stringify(replay)).not.toContain("before|instead|after");
  });
});

describe("structuredContent: SAP_STRUCTURED=on only", () => {
  const VIEW = 'TRANSACTION VA02  PROGRAM SAPMV45A  SCREEN 4001  SYSTEM ABA (800)\nWINDOW wnd[0]  "Change Standard Order 4711"\nctxtVBAK-VBELN  field  Order = "4711"  (edit)\nsbar  status  S: Ready';
  const make = async (on: boolean, env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "sap-structured-"));
    const s = await setup(env, { structured: on, record: recorderOptionsFromEnv({ SAP_RECORD_DIR: dir }, "test") });
    s.surface.add({ id: "chrome:1", system: "ABA", client: "800", user: "DEMO", transaction: "VA02", title: "Change Standard Order 4711" }, { assess, view: VIEW });
    return s;
  };

  test("off: no structuredContent, no outputSchema; on: an outputSchema on the tools code reads", async () => {
    const off = await make(false, { SAP_WRITE: "confirm" });
    expect(JSON.stringify((await off.client.listTools()).tools)).not.toContain("outputSchema");
    expect((await off.call("sap_act", { do: "key", key: 0 })).structured).toBeUndefined();
    expect((await off.call("sap_sessions")).structured).toBeUndefined();
    const on = await make(true, { SAP_WRITE: "confirm" });
    const tools = (await on.client.listTools()).tools;
    expect(tools.filter((t) => t.outputSchema).map((t) => t.name).sort()).toEqual(["sap_act", "sap_record", "sap_replay", "sap_sessions"]);
    // The same list every time for one setting.
    expect(JSON.stringify((await on.client.listTools()).tools)).toBe(JSON.stringify(tools));
  });

  test("sap_act: ran, total, the screen and the status bar, no control list", async () => {
    const { call } = await make(true);
    const one = await call("sap_act", { do: "set", id: "ctxtVBAK-VBELN", value: "4711" });
    expect(one.structured).toEqual({ ran: 1, total: 1, screen: { transaction: "VA02", program: "SAPMV45A", number: "4001", title: "Change Standard Order 4711" }, status: { type: "S", text: "Ready" } });
    const batch = await call("sap_act", { actions: [{ do: "set", id: "ctxtVBAK-VBELN", value: "1" }, { do: "key", key: 0 }] });
    expect(batch.structured).toMatchObject({ ran: 2, total: 2, screen: { number: "4001" } });
    // Refused with writing off: an error, its text is the answer.
    expect((await call("sap_act", { do: "key", key: 11 })).error).toBe(true);
  });

  test("a batch that stops, and a write refused under confirm: why it stopped", async () => {
    const { surface, call } = await make(true, { SAP_WRITE: "confirm" });
    const s = surface.sessions[0]!;
    s.onAct = (a, x) => {
      if (a.do === "key" && a.key === 0) x.view = VIEW.replace("S: Ready", "E: Order 4799 does not exist");
    };
    const stopped = await call("sap_act", { actions: [{ do: "key", key: 0 }, { do: "set", id: "ctxtVBAK-VBELN", value: "1" }] });
    expect(stopped.structured).toMatchObject({ ran: 1, total: 2, stopped: { why: "status" }, status: { type: "E" } });
    s.view = VIEW;
    delete s.onAct;
    // A refusal is an error: its text is the answer, and it names the action that did not run.
    const refused = await call("sap_act", { actions: [{ do: "set", id: "ctxtVBAK-VBELN", value: "1" }, { do: "key", key: 11 }] });
    expect(refused.error).toBe(true);
    expect(refused.text).toStartWith('Ran 1 of 2 actions. Stopped: action 2 ({"do":"key","key":11}) was refused');
  });

  test("sap_sessions and sap_record", async () => {
    const { call } = await make(true);
    expect((await call("sap_sessions")).structured).toEqual({ sessions: [{ n: 1, active: true, id: "chrome:1", surface: "webgui", system: "ABA", client: "800", user: "DEMO", transaction: "VA02", title: "Change Standard Order 4711", where: "fake chrome:1" }] });
    expect((await call("sap_record", { op: "status" })).structured).toEqual({ recording: false });
    await call("sap_record", { op: "start", name: "s" });
    await call("sap_act", { do: "okcode", value: "/nVA02" });
    expect((await call("sap_record", { op: "status" })).structured).toEqual({ recording: true, name: "s", steps: 1 });
    expect((await call("sap_record", { op: "stop" })).structured).toEqual({ recording: false });
    const replay = await call("sap_replay", { name: "s" });
    expect(replay.structured).toMatchObject({ steps: [{ n: 1, outcome: expect.any(String), failures: expect.any(Array) }], variables: {} });
    expect(typeof (replay.structured as { passed: boolean }).passed).toBe("boolean");
  });
});
