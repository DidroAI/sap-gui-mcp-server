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
import { ActionError, type Assessment, type Driver, type LookOptions, type SessionInfo, type Surface } from "./core/types.js";
import { type ViewMode, Views } from "./core/views.js";

export const SERVER_NAME = "sap-gui";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Sees and drives SAP screens the user already has open: SAP GUI for Windows, SAP GUI for HTML (Web GUI) in Chrome, and SAP Fiori in Chrome. It never logs on; it works in the user's own sessions, as the user.
Start with sap_look (or sap_sessions when several are open). The view has one line per control: its id, its type, its label and value, and its state. Act with sap_act on those ids, one action at a time; each action answers with the new screen, so you rarely need sap_look in between. Read the status bar line after each action: SAP reports errors there.
When an action leaves you on the same screen, the answer holds only what changed since your last view: "~" a changed line, "+" a new one, "-" one that is gone, "=" an unchanged line for context; everything else is as you saw it. A new transaction, screen or popup is always shown whole, and sap_look shows the whole screen at any time.
Long lists show the rows on screen and the total: {"do":"scroll"} moves them, sap_look with id and rows reads a range. A dropdown shows its current entry and how many it has: {"do":"combo","id":...} without a key lists them.
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
    to: z.union([z.number().int(), z.string()]).optional().describe('scroll: a row counted from 0, or "next", "prev", "first", "last"'),
  })
  .passthrough();

export interface ServerOptions {
  policy: Policy;
  surfaces: Surface[];
  /** What sap_act answers with: the changes when that is shorter ("diff", the default), or always the whole screen ("full"). */
  view?: ViewMode;
}

/** "120-180" or "120": the first and last row, counted from 0. */
export function parseRows(rows: string): { from: number; to: number } {
  const m = /^\s*(\d+)\s*(?:(?:-|to|\.\.)\s*(\d+))?\s*$/.exec(rows);
  if (!m) throw new ActionError('"rows" is a range counted from 0, such as "120-180".');
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) throw new ActionError(`"rows" ends before it starts: ${rows}.`);
  if (to - from >= MAX_ROWS) throw new ActionError(`"rows" may span ${MAX_ROWS} rows at most; ask for ${from}-${from + MAX_ROWS - 1}, then go on from there.`);
  return { from, to };
}
/** The most rows one sap_look reads by scrolling. */
const MAX_ROWS = 200;

export function createServer({ policy, surfaces, view = "diff" }: ServerOptions) {
  const registry = new Registry(surfaces, policy);
  const views = new Views(view);
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
        return text(views.present(info.id, await driver.look({ compact: true }), true));
      }),
  );

  server.registerTool(
    "sap_look",
    {
      title: "Look at the SAP screen",
      description: `The current SAP screen as text: header (where you are: transaction or app, screen, and the system when known), then one line per control with its id, type, label, value and state; tables as rows, popups as their own windows.
  full=true   every id, every column, each toolbar button and its key on a line of its own (larger)
  diff=true   only what changed since the view you got last
  id="..."    one control, whole: all the entries of a dropdown, all the rows read of a grid, table, tree or list; id="mbar" lists every menu entry
  id="...", rows="120-180"   those rows of a grid, table control, tree or list (counted from 0; the control is scrolled there)`,
      inputSchema: {
        session,
        full: z.boolean().optional().describe("full view instead of compact"),
        diff: z.boolean().optional().describe("only what changed since your last view"),
        id: z.string().optional().describe("one control, whole (an id from the view)"),
        rows: z.string().optional().describe('with id: a range of rows counted from 0, e.g. "120-180"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref, full, diff, id, rows }) =>
      answer(async () => {
        const { driver, info } = await registry.session(ref);
        if (rows !== undefined && !id) throw new ActionError('"rows" needs "id": the grid, table, tree or list to read.');
        if (id) {
          const options: LookOptions = { compact: !full, id, ...(rows !== undefined ? { rows: parseRows(rows) } : {}) };
          // One control is not the screen: what the agent holds of the screen stays as it is.
          return text(await driver.look(options));
        }
        if (full) {
          const whole = await driver.look({ compact: false });
          // The full view holds everything the compact one does: later changes are counted from here.
          views.remember(info.id, await driver.look({ compact: true }));
          return text(whole);
        }
        return text(views.present(info.id, await driver.look({ compact: true }), !diff));
      }),
  );

  /** Can the client ask the user itself (MCP elicitation, form mode)? Then no token is needed. */
  const canElicit = () => !!server.server.getClientCapabilities()?.elicitation?.form;

  /** Runs an action that passed the guard, then checks where it led. */
  async function perform(d: Driver, action: NormalizedAction, whole = false): Promise<CallToolResult> {
    const session = d.info.id;
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
          return text(`${note}\nA new session opened (${fresh.where}); it is now the active one. The previous session is still open (sap_sessions lists both).\n\n${views.present(fresh.id, await nd.look({ compact: true }), true)}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return text(`${note}\nNo new session appeared within 5 s (SAP allows at most 6 per logon): this is still the previous session.\n\n${views.present(session, await d.look({ compact: true }), whole)}`);
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
      const screen = await d
        .look({ compact: true })
        .then((v) => views.present(session, v, true))
        .catch((e: Error) => `(the screen could not be read: ${e.message.split("\n")[0]})`);
      return fail(`${note}\nThis led to a transaction the agent may not work in: ${landed}. ${left}\n\n${screen}`);
    }
    return text(`${note}\n\n${views.present(session, await d.look({ compact: true }), whole)}`);
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
  async function runConfirmed(shown: Shown, whole = false): Promise<CallToolResult> {
    const j = await judge(shown.session, shown.action);
    if ("refused" in j) return fail(`Refused: ${j.refused}`);
    if (!j.verdict.run && "refused" in j.verdict) return fail(`Refused: ${j.verdict.refused}`);
    const changed = changedSince(shown, shownOf(j.info, shown.action, j.assessment));
    if (changed.length) return fail(`Not run: the screen changed since the confirmation was asked (${changed.join("; ")}). Look at the screen and call sap_act again.`);
    return perform(j.driver, shown.action, whole);
  }

  /**
   * An action that could not run, said with where the session is now when
   * that is not what the agent last saw: an id from an earlier screen fails
   * here, and the agent gets the screen it is really on in the same answer.
   */
  async function failedOn(ref: string | undefined, e: unknown): Promise<CallToolResult> {
    const message = (e as Error).message;
    if (!(e instanceof ActionError)) return fail(message);
    try {
      const { driver, info } = await registry.session(ref);
      const now = await driver.look({ compact: true });
      const last = views.last(info.id);
      // Where the session is, in one line: the header and the window in front.
      const lines = now.split("\n");
      const here = [lines[0], lines.filter((l) => l.startsWith("WINDOW ")).at(-1)].filter(Boolean).join("  ");
      if (last === now) return fail(`${message}\nThe screen is as you last saw it: ${here}`);
      return fail(`${message}\n${last === undefined ? "The screen is:" : "The screen is not as you last saw it:"}\n\n${views.present(info.id, now)}`);
    } catch {
      return fail(message);
    }
  }

  async function run(ref: string | undefined, raw: unknown, whole = false): Promise<CallToolResult> {
    // One normalised action for the guard, for assess and for act.
    const action = normalizeAction(raw);
    const field = commandFieldRefusal(action);
    if (field) return fail(`Refused: ${field}`);
    let j: Awaited<ReturnType<typeof judge>>;
    try {
      j = await judge(ref, action);
    } catch (e) {
      return failedOn(ref, e);
    }
    if ("refused" in j) return fail(`Refused: ${j.refused}`);
    const { driver, info, assessment, verdict } = j;
    if (verdict.run) return perform(driver, action, whole).catch((e: unknown) => failedOn(ref, e));
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
      return runConfirmed(shown, whole);
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
      description: `One action on the active SAP screen, by an id from sap_look; answers with the new screen, or with only what changed when the screen is the same one ("~" changed line, "+" new, "-" gone, "=" unchanged, for context). Actions:
  {"do":"set","id":"ctxtVBAK-AUART","value":"OR"}   type into a field (Fiori: an input)
  {"do":"press","id":"btn[8]"}                      button (Fiori: "click" works too)
  {"do":"key","key":0}                              0 Enter, 3 Back, 4 F4, 8 F8, 11 Save, 12 Cancel
  {"do":"select","id":"tabpT\\08"}                tab, radio button, menu entry, list item
  {"do":"check","id":"...","value":true}            checkbox
  {"do":"combo","id":"...","key":"PROG"}            dropdown entry, by key or shown text; without "key": lists the entries, changes nothing
  {"do":"okcode","value":"/nVA03"}                  command field (SAP GUI, Web GUI)
  {"do":"f4","id":"..."}                            value help
  {"do":"dblclick","id":"..."}                      list entry or label
  {"do":"tree","id":"...","node":"<key>","how":"double|select|expand"}
  {"do":"grid","id":"...","row":0,"col":"VBELN","how":"double|select"}   any row of the grid: one that is not on screen is scrolled to first
  {"do":"toolbar","id":"...","button":"<id>"}
  {"do":"scroll","id":"...","to":120}               grid, table control, tree or list: to a row counted from 0, or "next", "prev", "first", "last" (Fiori: scrolls a table or the page when the view ends with SCROLL)
Ids: use them as the view shows them. A toolbar button btn[N] is function key N: press it, or send the key. A handle such as cntlGRID1/shell or shellcont[1]/shell is a shortened id; an id that names several controls is refused with the list of them, and an id from an earlier screen is refused with the screen you are on.
For "key", "key" is an SAP virtual key number (0 to 99) or a key name (Enter, Escape, Tab, F4, Control+S). The command field takes commands through "okcode" only.
An action that may write to SAP is refused, run, or held for the user's yes, as the user set it up. When held, the client asks the user itself if it can, and the answer here is the result; if it cannot, the answer holds a token for sap_confirm.`,
      inputSchema: { action: actionSchema, session, full: z.boolean().optional().describe("answer with the whole screen even when little changed") },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ action, session: ref, full }) => answer(() => run(ref, action, full === true)),
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
