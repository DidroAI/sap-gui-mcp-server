/**
 * The MCP server: six tools over the registry of open SAP sessions.
 *
 *   sap_sessions    list the SAP sessions open on this machine
 *   sap_use         make one the active session
 *   sap_look        the active screen as compact text (or full)
 *   sap_act         one action (guardrails first), then the new screen
 *   sap_confirm     run an action that waits for the user's yes
 *   sap_screenshot  a PNG of the session's window or tab
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { decide, type Policy, systemAllowed } from "./core/guard.js";
import { Registry } from "./core/registry.js";
import type { Action, SessionInfo, Surface } from "./core/types.js";

export const SERVER_NAME = "sap-gui";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Sees and drives SAP screens the user already has open: SAP GUI for Windows, SAP GUI for HTML (Web GUI) in Chrome, and SAP Fiori in Chrome. It never logs on; it works in the user's own sessions, as the user.
Start with sap_look (or sap_sessions when several are open). The view has one line per control: its id, its type, its label and value, and its state. Act with sap_act on those ids, one action at a time; each action answers with the new screen, so you rarely need sap_look in between. Read the status bar line after each action: SAP reports errors there.
Actions that may write to SAP (save, post, delete, release...) follow the user's write setting: refused, held for the user's confirmation (sap_confirm, only after the user said yes to that exact action), or run.`;

function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}
function fail(t: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: t }] };
}
async function answer(f: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await f();
  } catch (e) {
    return fail((e as Error).message);
  }
}

function sessionLine(s: SessionInfo, i: number, active: boolean): string {
  const sys = [s.system && `${s.system}${s.client ? ` (${s.client})` : ""}`, s.user].filter(Boolean).join(" ");
  return `${i + 1}. ${active ? "* " : "  "}${s.surface.padEnd(6)} ${sys.padEnd(22)} ${(s.transaction ?? "").padEnd(8)} "${s.title ?? ""}"  [${s.where}]  id=${s.id}`;
}

const actionSchema = z
  .object({
    do: z.string().describe("set, press, key, select, check, combo, okcode, f4, dblclick, tree, grid, toolbar, click"),
    id: z.string().optional().describe("control id from sap_look (short ids work)"),
    value: z.any().optional(),
    key: z.any().optional(),
    node: z.string().optional(),
    how: z.string().optional(),
    row: z.number().int().optional(),
    col: z.string().optional(),
    button: z.string().optional(),
  })
  .passthrough();

export interface ServerOptions {
  policy: Policy;
  surfaces: Surface[];
}

export function createServer({ policy, surfaces }: ServerOptions) {
  const registry = new Registry(surfaces, policy);
  const pending = new Map<string, { session: string; action: Action; reason: string; at: number }>();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const session = z.string().optional().describe("session from sap_sessions (number, id, system or transaction); default: the active one");

  server.registerTool(
    "sap_sessions",
    {
      title: "List open SAP sessions",
      description: "Lists the SAP sessions open on this machine (SAP GUI windows, Web GUI and Fiori tabs in Chrome), with system, client, user and transaction. * marks the active one.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      answer(async () => {
        const { sessions, hidden, errors } = await registry.discover();
        const lines = sessions.map((s, i) => sessionLine(s, i, s.id === registry.active));
        if (!sessions.length) lines.push("No SAP session found.");
        if (hidden) lines.push(`${hidden} session(s) of systems outside SAP_ALLOW_SYSTEMS are hidden.`);
        for (const e of errors) lines.push(`(${e})`);
        return text(lines.join("\n"));
      }),
  );

  server.registerTool(
    "sap_use",
    {
      title: "Switch the active SAP session",
      description: "Makes a session the active one for sap_look and sap_act.",
      inputSchema: { session: z.string().describe("number, id, system or transaction from sap_sessions") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref }) =>
      answer(async () => {
        const d = await registry.driver(ref);
        registry.active = d.info.id;
        return text(await d.look({ compact: true }));
      }),
  );

  server.registerTool(
    "sap_look",
    {
      title: "Look at the SAP screen",
      description: "The current SAP screen as text: header (transaction, program, screen, system), then one line per control with its id, type, label, value and state; tables as rows, popups as their own windows. full=true gives every id and column (larger).",
      inputSchema: { session, full: z.boolean().optional().describe("full view instead of compact") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref, full }) => answer(async () => text(await (await registry.driver(ref)).look({ compact: !full }))),
  );

  async function run(ref: string | undefined, action: Action, confirmed: boolean): Promise<CallToolResult> {
    const d = await registry.driver(ref);
    const info = await d.refresh();
    if (!systemAllowed(policy, info)) return fail(`System ${info.system ?? "?"} is outside SAP_ALLOW_SYSTEMS.`);
    if (!confirmed) {
      const verdict = decide(policy, action, await d.assess(action));
      if (!verdict.run) {
        if ("refused" in verdict) return fail(`Refused: ${verdict.refused}`);
        const token = randomUUID().slice(0, 8);
        pending.set(token, { session: d.info.id, action, reason: verdict.confirm, at: Date.now() });
        return text(
          `Needs the user's confirmation: ${verdict.confirm}, on ${info.system ?? "?"}${info.client ? `/${info.client}` : ""} ${info.transaction ?? ""}.\nAsk the user; only after they say yes to this exact action, call sap_confirm with token "${token}".`,
        );
      }
    }
    const note = await d.act(action);
    return text(`${note}\n\n${await d.look({ compact: true })}`);
  }

  server.registerTool(
    "sap_act",
    {
      title: "Act on the SAP screen",
      description: `One action on the active SAP screen, by an id from sap_look; answers with the new screen. Actions:
  {"do":"set","id":"ctxtVBAK-AUART","value":"OR"}   type into a field (Fiori: an input)
  {"do":"press","id":"btn[8]"}                      button (Fiori: "click" works too)
  {"do":"key","key":0}                              0 Enter, 3 Back, 4 F4, 8 F8, 11 Save, 12 Cancel
  {"do":"select","id":"tabpT\\\\08"}                tab, radio button, menu entry, list item
  {"do":"check","id":"...","value":true}            checkbox
  {"do":"combo","id":"...","key":"PROG"}            dropdown entry, by key or shown text
  {"do":"okcode","value":"/nVA03"}                  command field (SAP GUI, Web GUI)
  {"do":"f4","id":"..."}                            value help
  {"do":"dblclick","id":"..."}                      list entry or label
  {"do":"tree","id":"...","node":"<key>","how":"double|select|expand"}
  {"do":"grid","id":"...","row":0,"col":"VBELN","how":"double|select"}
  {"do":"toolbar","id":"...","button":"<id>"}`,
      inputSchema: { action: actionSchema, session },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ action, session: ref }) => answer(() => run(ref, action as Action, false)),
  );

  server.registerTool(
    "sap_confirm",
    {
      title: "Run a confirmed SAP action",
      description: "Runs an action that sap_act held for confirmation. Call it only after the user said yes to that exact action.",
      inputSchema: { token: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ token }) =>
      answer(async () => {
        const p = pending.get(token);
        if (!p || Date.now() - p.at > 10 * 60_000) return fail("Unknown or expired token: call sap_act again.");
        pending.delete(token);
        return run(p.session, p.action, true);
      }),
  );

  server.registerTool(
    "sap_screenshot",
    {
      title: "Screenshot of the SAP session",
      description: "A PNG of the session's window or tab, to check a result or see what the text view cannot (charts, HTML panels).",
      inputSchema: { session },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref }) =>
      answer(async () => {
        const png = await (await registry.driver(ref)).screenshot();
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      }),
  );

  return { server, registry };
}
