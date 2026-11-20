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
