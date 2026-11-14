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
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionText, normalizeAction, type NormalizedAction, VERBS } from "./core/action.js";
import { commandFieldRefusal, decide, leavesTransaction, type Policy, sessionRefusal } from "./core/guard.js";
import { Registry } from "./core/registry.js";
import type { Assessment, Driver, SessionInfo, Surface } from "./core/types.js";

export const SERVER_NAME = "sap-gui";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Sees and drives SAP screens the user already has open: SAP GUI for Windows, SAP GUI for HTML (Web GUI) in Chrome, and SAP Fiori in Chrome. It never logs on; it works in the user's own sessions, as the user.
Start with sap_look (or sap_sessions when several are open). The view has one line per control: its id, its type, its label and value, and its state. Act with sap_act on those ids, one action at a time; each action answers with the new screen, so you rarely need sap_look in between. Read the status bar line after each action: SAP reports errors there.
Actions that may write to SAP (save, post, delete, release...) follow the user's write setting: refused, held for the user's confirmation, or run. When held, the user is asked in the client itself where the client can do that; otherwise sap_act answers with a token for sap_confirm, to call only after the user said yes to that exact action.
Commands go through {"do":"okcode"} only; the command field itself cannot be typed into.`;

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

/** "https://myhost:44300" for a browser session; undefined for SAP GUI. */
function originOf(s: SessionInfo): string | undefined {
  try {
    return s.url ? new URL(s.url).origin : undefined;
  } catch {
    return undefined;
  }
}

export function sessionLine(s: SessionInfo, i: number, active: boolean): string {
  const sys = [s.system && `${s.system}${s.client ? ` (${s.client})` : ""}`, s.user].filter(Boolean).join(" ");
  const origin = originOf(s);
  return `${i + 1}. ${active ? "* " : "  "}${s.surface.padEnd(6)} ${sys.padEnd(22)} ${(s.transaction ?? "").padEnd(8)} "${s.title ?? ""}"  [${s.where}]${origin ? `  origin=${origin}` : ""}  id=${s.id}`;
}

const place = (s: SessionInfo) => `${s.system ?? "?"}${s.client ? `/${s.client}` : ""}${s.transaction ? `, ${s.transaction}` : ""}${s.title ? ` ("${s.title}")` : ""}`;

/** What the user was shown when asked to confirm: the action runs only if all of it still holds. */
interface Shown {
  session: string;
  surface: string;
  system: string | undefined;
  client: string | undefined;
  transaction: string | undefined;
  title: string | undefined;
  action: NormalizedAction;
  risk: string;
  reason: string;
}

function shownOf(info: SessionInfo, action: NormalizedAction, a: Assessment): Shown {
  return { session: info.id, surface: info.surface, system: info.system, client: info.client, transaction: info.transaction, title: info.title, action, risk: a.risk, reason: a.reason };
}

/** What differs between what the user confirmed and what is there now; empty when nothing does. */
export function changedSince(then: Shown, now: Shown): string[] {
  const out: string[] = [];
  const was = (name: string, a: string | undefined, b: string | undefined) => {
    if ((a ?? "") !== (b ?? "")) out.push(`${name} was "${a ?? ""}", is now "${b ?? ""}"`);
  };
  was("session", then.session, now.session);
  was("surface", then.surface, now.surface);
  was("system", then.system, now.system);
  was("client", then.client, now.client);
  was("transaction", then.transaction, now.transaction);
  was("window title", then.title, now.title);
  was("action", actionText(then.action), actionText(now.action));
  was("what the action does", `${then.risk}: ${then.reason}`, `${now.risk}: ${now.reason}`);
  return out;
}

const TOKEN_LIFE_MS = 10 * 60_000;
const MAX_PENDING = 50;
/** The time the user has to answer the client's confirmation dialog. */
const ELICIT_TIMEOUT_MS = 5 * 60_000;

const actionSchema = z
  .object({
    do: z.string().describe(VERBS.join(", ")),
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
  const pending = new Map<string, { shown: Shown; at: number }>();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const session = z.string().optional().describe("session from sap_sessions (number, id, system, transaction, or a surface: sapgui, webgui, fiori); default: the active one");

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
      inputSchema: { session: z.string().describe("number, id, system or transaction from sap_sessions, or a surface name: sapgui, webgui, fiori") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref }) =>
      answer(async () => {
        const { driver, info } = await registry.session(ref);
        registry.active = info.id;
        return text(await driver.look({ compact: true }));
      }),
  );

  server.registerTool(
    "sap_look",
    {
      title: "Look at the SAP screen",
      description: "The current SAP screen as text: header (where you are: transaction or app, screen, and the system when known), then one line per control with its id, type, label, value and state; tables as rows, popups as their own windows. full=true gives every id and column (larger).",
      inputSchema: { session, full: z.boolean().optional().describe("full view instead of compact") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref, full }) => answer(async () => text(await (await registry.driver(ref)).look({ compact: !full }))),
  );

  /** Can the client ask the user itself (MCP elicitation, form mode)? Then no token is needed. */
  const canElicit = () => !!server.server.getClientCapabilities()?.elicitation?.form;

  /** Runs an action that passed the guard, then checks where it led. */
  async function perform(d: Driver, action: NormalizedAction): Promise<CallToolResult> {
    // "/oVA03" opens the transaction in a new SAP GUI session: follow it there.
    const opens = action.do === "okcode" && typeof action.value === "string" && /^\/o\S/i.test(action.value) && d.info.surface === "sapgui";
    const before = opens ? new Set((await registry.discover()).sessions.map((s) => s.id)) : undefined;
    const note = await d.act(action);
    if (before) {
      for (let i = 0; i < 10; i++) {
        const fresh = (await registry.discover()).sessions.find((s) => s.surface === "sapgui" && !before.has(s.id));
        if (fresh) {
          registry.active = fresh.id;
          const nd = await registry.driver(fresh.id);
          return text(`${note}\nA new session opened (${fresh.where}); it is now the active one. The previous session is still open (sap_sessions lists both).\n\n${await nd.look({ compact: true })}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return text(`${note}\nNo new session appeared within 5 s (SAP allows at most 6 per logon): this is still the previous session.\n\n${await d.look({ compact: true })}`);
    }
    // A menu entry, a favourite or a tree node can open a transaction no okcode named.
    const after = await d.refresh().catch(() => undefined);
    const landed = after && sessionRefusal(policy, after);
    if (landed) {
      let left: string;
      try {
        await d.act(normalizeAction({ do: "okcode", value: "/n" }));
        left = "The server left it with /n; input that was not saved there is gone.";
      } catch (e) {
        left = `The server could not leave it with /n (${(e as Error).message.split("\n")[0]}): leave it before doing anything else.`;
      }
      const screen = await d.look({ compact: true }).catch((e: Error) => `(the screen could not be read: ${e.message.split("\n")[0]})`);
      return fail(`${note}\nThis led to a transaction the agent may not work in: ${landed}. ${left}\n\n${screen}`);
    }
    return text(`${note}\n\n${await d.look({ compact: true })}`);
  }

  /** The session as it is now, and what the guard says about this action on it. */
  async function judge(ref: string | undefined, action: NormalizedAction) {
    const { driver, info } = await registry.session(ref);
    // The transaction the session is in counts too, however it was opened.
    const here = sessionRefusal(policy, info);
    if (here && !leavesTransaction(policy, action))
      return { driver, info, refused: `this session is in a transaction the agent may not work in: ${here}. Leave it with {"do":"okcode","value":"/n"} or open an allowed transaction with {"do":"okcode","value":"/n<transaction>"}.` };
    const assessment = await driver.assess(action);
    return { driver, info, assessment, verdict: decide(policy, action, assessment) };
  }

  /** Runs a held action if the session and the action's assessment are still what the user was shown. */
  async function runConfirmed(shown: Shown): Promise<CallToolResult> {
    const j = await judge(shown.session, shown.action);
    if ("refused" in j) return fail(`Refused: ${j.refused}`);
    if (!j.verdict.run && "refused" in j.verdict) return fail(`Refused: ${j.verdict.refused}`);
    const changed = changedSince(shown, shownOf(j.info, shown.action, j.assessment));
    if (changed.length) return fail(`Not run: the screen changed since the confirmation was asked (${changed.join("; ")}). Look at the screen and call sap_act again.`);
    return perform(j.driver, shown.action);
  }

  async function run(ref: string | undefined, raw: unknown): Promise<CallToolResult> {
    // One normalised action for the guard, for assess and for act.
    const action = normalizeAction(raw);
    const field = commandFieldRefusal(action);
    if (field) return fail(`Refused: ${field}`);
    const j = await judge(ref, action);
    if ("refused" in j) return fail(`Refused: ${j.refused}`);
    const { driver, info, assessment, verdict } = j;
    if (verdict.run) return perform(driver, action);
    if ("refused" in verdict) return fail(`Refused: ${verdict.refused}`);
    const shown = shownOf(info, action, assessment);
    const what = `${verdict.confirm}, on ${place(info)}`;
    if (canElicit()) {
      let answer: Awaited<ReturnType<typeof server.server.elicitInput>>;
      try {
        answer = await server.server.elicitInput(
          {
            mode: "form",
            message: `Allow this action in SAP? It may write to the system.\n\nWhat: ${verdict.confirm}\nWhere: ${place(info)} [${info.where}]\nAction: ${actionText(action)}`,
            requestedSchema: { type: "object", properties: {} },
          },
          { timeout: ELICIT_TIMEOUT_MS },
        );
      } catch (e) {
        return fail(`Not run: the user could not be asked to confirm (${(e as Error).message.split("\n")[0]}).`);
      }
      if (answer.action !== "accept") return text(`Not run: the user ${answer.action === "decline" ? "declined" : "dismissed the confirmation of"} this action (${what}).`);
      return runConfirmed(shown);
    }
    const now = Date.now();
    for (const [t, p] of pending) if (now - p.at > TOKEN_LIFE_MS) pending.delete(t);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
    const token = randomBytes(6).toString("hex");
    pending.set(token, { shown, at: now });
    return text(
      `Needs the user's confirmation: ${what}.\nAction: ${actionText(action)}\nAsk the user; only after they say yes to this exact action, call sap_confirm with token "${token}". The token is for this screen and this action only: if the screen changes, it is refused.`,
    );
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
  {"do":"toolbar","id":"...","button":"<id>"}
  {"do":"scroll","id":"..."}                        Fiori: scroll a table or page when the view ends with SCROLL
For "key", "key" is an SAP virtual key number (0 to 99) or a key name (Enter, Escape, Tab, F4, Control+S). The command field takes commands through "okcode" only.
An action that may write to SAP is refused, run, or held for the user's yes, as the user set it up. When held, the client asks the user itself if it can, and the answer here is the result; if it cannot, the answer holds a token for sap_confirm.`,
      inputSchema: { action: actionSchema, session },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ action, session: ref }) => answer(() => run(ref, action)),
  );

  server.registerTool(
    "sap_confirm",
    {
      title: "Run a confirmed SAP action",
      description:
        "Runs an action that sap_act held for confirmation, with the token sap_act gave. Call it only after the user said yes to that exact action. The server checks that the session, the screen and the action are still the ones the token was given for, and refuses otherwise. It cannot check that the user said yes: without a client that asks the user itself (MCP elicitation), this confirmation is advisory and rests on the agent asking. Not used when the client asks the user itself.",
      inputSchema: { token: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ token }) =>
      answer(async () => {
        const p = pending.get(token.trim());
        // A token works once, whatever the outcome.
        pending.delete(token.trim());
        if (!p || Date.now() - p.at > TOKEN_LIFE_MS) return fail("Unknown or expired token: call sap_act again.");
        return runConfirmed(p.shown);
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
