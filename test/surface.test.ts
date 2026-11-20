/**
 * The tool surface an agent sees: what tools/list holds (schemas,
 * annotations), the input shapes sap_act takes, and what the answers say.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { policyFromEnv } from "../src/core/guard.js";
import type { Action, Assessment } from "../src/core/types.js";
import { createServer, type ServerOptions } from "../src/server.js";
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
    }
  });

  test("annotations: a closed system everywhere; reads are idempotent; acting is destructive", async () => {
    const { client } = await setup({ SAP_WRITE: "confirm" });
    const { tools } = await client.listTools();
    const of = (name: string) => tools.find((t) => t.name === name)?.annotations ?? {};
    for (const t of tools) expect([t.name, t.annotations?.openWorldHint]).toEqual([t.name, false]);
    for (const name of ["sap_look", "sap_sessions", "sap_screenshot"]) expect([name, of(name).readOnlyHint, of(name).idempotentHint]).toEqual([name, true, true]);
    for (const name of ["sap_act", "sap_confirm", "sap_replay"]) expect([name, of(name).destructiveHint]).toEqual([name, true]);
    expect(of("sap_use").readOnlyHint).toBe(true);
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
