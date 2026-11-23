/**
 * The MCP server: six tools over the registry of open SAP sessions, and two
 * that turn a session into a repeatable test (record/tools.ts).
 *
 *   sap_sessions    list the SAP sessions open on this machine
 *   sap_use         make one the active session
 *   sap_look        the active screen as compact text (or full)
 *   sap_act         one action (guardrails first), then the new screen
 *   sap_screenshot  a PNG of the session's window or tab
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionText, normalizeAction, type NormalizedAction, VERBS } from "./core/action.js";
import { MAX_BATCH, parseBatch, staleWrite, stopAfter, unseenWrite } from "./batch.js";
import { commandFieldRefusal, decide, LEAVE_UNSAVED, leavesTransaction, type Policy, sessionRefusal, tcodeOf, tcodeRefusal } from "./core/guard.js";
import { type Turn, SessionQueue, waitedLine } from "./core/queue.js";
import { Registry } from "./core/registry.js";
import { ActionError, type Assessment, type Driver, type LookOptions, type SessionInfo, type Surface } from "./core/types.js";
import { type ViewMode, Views } from "./core/views.js";
import { Recorder, type RecorderOptions, recorderOptionsFromEnv } from "./record/recorder.js";
import { type ParsedScreen, parseScreen, stillWorking } from "./record/screen.js";
import { registerRecordTools } from "./record/tools.js";
import { registerCodeTools } from "./record/code-tools.js";
import { codeOf } from "./sdk/code.js";
import { type ActOutput, actOutput, screenOf, screenOfInfo, sessionsData, sessionsOutput, structuredFromEnv, withData } from "./structured.js";

export const SERVER_NAME = "sap-gui";
export const SERVER_VERSION = "0.1.0";

/**
 * What the agent is told about actions that may write, for the write setting
 * the server runs with: one sentence, true for this server. Under confirm the
 * client asks the user (MCP elicitation); a client that cannot gets writes
 * refused, and the first answer says so (`confirmNotice`).
 */
export function writeRule(policy: Policy): string {
  if (policy.write === "off")
    return "An action that may write (save, post, delete...) is refused: the user has set writing off. Then tell the user what you would have saved, leave the transaction without saving (okcode /n) so its lock is released, and stop: do not look for another way.";
  if (policy.write === "on") return "An action that may write (save, post, delete...) runs: the user has set writing on. Say what you saved, with the document number from the status bar.";
  return "An action that may write (save, post, delete...) runs only after the user says yes in a dialog the client shows; if they decline, leave the transaction without saving (okcode /n), then ask how to go on. A client that cannot ask the user gets it refused: then tell the user what you would have saved.";
}

/**
 * The server instructions. Some clients read only the first 512 characters
 * (Codex), so the first paragraph stands on its own: what this is, in the
 * user's words, and where to start. Routing between the tools follows.
 */
function instructions(policy: Policy): string {
  return `Works in the SAP screens the user already has open, as that user: SAP GUI for Windows, SAP Web GUI and Fiori in Chrome (transactions such as VA01 or ME23N, ALV grids, popups). It never logs on.
Start with sap_look, or directly with sap_act okcode /n<transaction> when the task names it. Each sap_act answer is the new screen: act again from it. Read the status bar after each call: SAP reports errors there.
${writeRule(policy)}
Which tool: read a screen, a long list or a grid: sap_look. Type, press, Enter, open a transaction, answer a popup: sap_act ("actions": a whole screen in one call). Several sessions or systems: sap_sessions, sap_use. Charts and HTML areas: sap_screenshot. Record a flow as a test or automate it: sap_record, then sap_replay.`;
}

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

/**
 * An answer that leaves out the status bar because it did not change still
 * says it when it is an error, a warning or an abort: an agent that reads
 * only the last answer must not take a second Enter on the same error for
 * a step that went through.
 */
export function withStatus(shown: string, view: string): string {
  const status = view.split("\n").find((l) => /^(wnd\[0\]\/)?sbar {2}status {2}[EWA]: /.test(l));
  if (!status || shown.includes(status)) return shown;
  return `${shown}\n= ${status}`;
}

/** What to do about a message of the status bar, by its type. */
const STATUS_HINT: Record<string, string> = {
  E: "error: correct the input it names, then Enter",
  W: "warning: Enter accepts it and goes on; another warning may follow, and each takes its own Enter. SAP may keep the fields closed until then, and fills nothing in before",
  A: "termination: SAP ended the transaction",
};

/**
 * An error, a warning or a termination in the status bar is the first thing
 * the answer says, with what to do about it: in the view the status bar is
 * the last line, after every field the message closed. This is that line,
 * to go right under the action's note; undefined when there is no such
 * message, or the answer already has the status line within its first lines.
 */
export function statusTop(shown: string, view: string): string | undefined {
  const m = /^(?:wnd\[0\]\/)?sbar {2}status {2}([EWA]): (.*)$/m.exec(view);
  if (!m || shown.split("\n").slice(0, 2).some((l) => l.endsWith(m[0]))) return undefined;
  return `STATUS ${m[1]}: ${m[2]}  (${STATUS_HINT[m[1] as string]})`;
}

/**
 * A failure that leaves the agent at a loss, with the step to take next. A
 * field SAP closed and a control that does not scroll are, most of the time,
 * a status message or a popup the agent has not answered: SAP keeps the
 * fields closed until then.
 */
export function withNextStep(message: string): string {
  if (/\b(is read-only|greyed out|does not scroll)\b/.test(message) && !/status bar|popup/i.test(message))
    return `${message}\nNext: read the status bar and any popup (WINDOW wnd[1]) in the screen below and answer them first: SAP keeps fields closed until a warning is accepted with Enter or a popup is answered. A field that stays closed cannot be changed on this screen.`;
  return message;
}

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

/** The time the user has to answer the client's confirmation dialog. */
const ELICIT_TIMEOUT_MS = 5 * 60_000;

/**
 * The fields of one action, flat: sap_act takes them at the top level, and
 * each entry of "actions" takes them too. Plain types and no union of
 * objects, so the schema converts to OpenAI's strict mode; normalizeAction
 * checks the rest (a whole "row", a known "key", "to" of a scroll).
 */
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const actionFields = {
  do: z.enum(VERBS),
  id: z.string().optional(),
  value: scalar.optional(),
  key: z.union([z.number(), z.string()]).optional().describe('key: "Enter", "Back", "Execute", "Save", "Cancel", "Exit", "F4", "Shift+F3", or an SAP key number. combo: the entry\'s key or text'),
  // Whole numbers, checked by normalizeAction: .int() would put the safe-integer bounds into tools/list.
  row: z.number().optional(),
  col: z.string().optional(),
  how: z.string().optional(),
  node: z.string().optional(),
  button: z.string().optional(),
  to: z.union([z.number(), z.string()]).optional(),
  app: z.string().optional(),
  timeout: z.number().optional(),
};
/**
 * What a step of "actions" adds to an action (batch.ts reads them). Loose, so
 * that batch.ts, not the schema, refuses a key it does not know, with the list
 * of the ones it does ("expect" has no "screeen"), and nothing runs.
 */
const stepSchema = z
  .object({
    ...actionFields,
    expect: z
      .object({ screen: z.union([z.string(), z.number()]).optional(), transaction: z.string().optional(), title: z.string().optional(), status: z.string().optional(), popup: z.boolean().optional() })
      .passthrough()
      .optional(),
    show: z.boolean().optional(),
    unseen: z.boolean().optional(),
  })
  .passthrough();
/** The keys of sap_act's input that are not part of the action. */
const CALL_KEYS = new Set(["session", "full", "actions", "action"]);

export interface ServerOptions {
  policy: Policy;
  surfaces: Surface[];
  /** What sap_act answers with: the changes when that is shorter ("diff", the default), or always the whole screen ("full"). */
  view?: ViewMode;
  /** Where recordings go and whether every session is recorded; default: from SAP_RECORD_DIR and SAP_RECORD. */
  record?: RecorderOptions;
  /**
   * Ends each answer of an action that ran with the SDK line that repeats it.
   * Default (undefined): only while a recording is on, where the agent is
   * building a script; SAP_CODE=on or off forces it either way (codeFromEnv).
   */
  code?: boolean;
  /** Adds structuredContent (structured.ts) to the answers code reads, and declares their output schemas; default: SAP_STRUCTURED=on. */
  structured?: boolean;
}

/** The actions kept per session for a draft test (sap_record {"op":"code"} with no recording on). */
const MAX_HISTORY = 200;

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
/** The rows read when "cols" comes without "rows": from the first row on. */
const COLS_ONLY_ROWS = { from: 0, to: 49 };

/** SAP_CODE: "on" or "off" forces the code line; anything else leaves it to the recording (undefined). */
export function codeFromEnv(value: string | undefined): boolean | undefined {
  if (/^(on|true|1)$/i.test(value ?? "")) return true;
  if (/^(off|false|0)$/i.test(value ?? "")) return false;
  return undefined;
}

export function createServer({ policy, surfaces, view = "diff", record, code = codeFromEnv(process.env.SAP_CODE), structured = structuredFromEnv(process.env.SAP_STRUCTURED) }: ServerOptions) {
  const registry = new Registry(surfaces, policy);
  const views = new Views(view);
  const recorder = new Recorder(record ?? recorderOptionsFromEnv(process.env, `${SERVER_NAME}-mcp-server ${SERVER_VERSION}`));
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: instructions(policy) });
  const session = z.string().optional().describe("from sap_sessions: number, id, system, transaction, or sapgui, webgui, fiori; default: the active one");
  const queue = new SessionQueue();
  /** The data of an answer, when structured output is on; undefined (nothing added) when it is off. */
  const data = <T extends Record<string, unknown>>(make: () => T): T | undefined => (structured ? make() : undefined);
  /** What an action that ran answers as data: one of one, and where the session is now. */
  const ranOn = (v: string): ActOutput => ({ ran: 1, total: 1, ...screenOf(v) });
  /** Does an answer end with the SDK line? Asked after the action: a recording is on or off by then. */
  const codeLine = () => code ?? recorder.recording;
  /** The actions that ran, per session, oldest first. */
  const history = new Map<string, NormalizedAction[]>();
  function remember(session: string, action: NormalizedAction): void {
    const list = history.get(session) ?? [];
    list.push(action);
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    history.set(session, list);
  }

  /** The queue a call on `ref` waits in: the session's id, found without opening it. */
  async function laneOf(ref: string | undefined): Promise<string> {
    const pick = () => (ref ? registry.resolve(ref)?.id : registry.active);
    let key = pick();
    if (!key) {
      await registry.discover().catch(() => {});
      key = pick();
    }
    return key ?? "*";
  }

  /** The result, with a first line that says how long it waited for the call before it, when it did. */
  function withTurn(r: CallToolResult, turn: Turn): CallToolResult {
    const line = waitedLine(turn);
    const first = r.content[0];
    if (!line || first?.type !== "text") return r;
    return { ...r, content: [{ ...first, text: `${line}\n${first.text}` }, ...r.content.slice(1)] };
  }

  /** Runs `f` when every call before it on the session has ended: one call at a time per session. */
  async function serial(ref: string | undefined, label: string, f: () => Promise<CallToolResult>): Promise<CallToolResult> {
    return queue.run(await laneOf(ref), label, async (turn) => withTurn(await f(), turn));
  }

  server.registerTool(
    "sap_sessions",
    {
      title: "List open SAP sessions",
      description:
        "Lists the SAP sessions the user has open (SAP GUI windows; Web GUI and Fiori tabs in Chrome): number, system, client, user, transaction, title. * marks the active one. Call it when another tool says no session matches or a session is gone, or when the task names a system you are not on; with one session open, go straight to sap_look. An empty list: ask the user to open SAP and log on; this server never logs on.",
      inputSchema: {},
      ...(structured ? { outputSchema: sessionsOutput } : {}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      answer(async () => {
        const { sessions, hidden, errors, hint } = await registry.discover();
        const lines = sessions.map((s, i) => sessionLine(s, i, s.id === registry.active));
        if (!sessions.length) lines.push(hint ? `No SAP session found. ${hint}` : "No SAP session found.");
        if (hidden) lines.push(`${hidden} session(s) of systems outside SAP_ALLOW_SYSTEMS are hidden.`);
        for (const e of errors) lines.push(`(${e})`);
        return withData(text(lines.join("\n")), data(() => sessionsData(sessions, registry.active)));
      }),
  );

  server.registerTool(
    "sap_use",
    {
      title: "Switch the active SAP session",
      description:
        'Makes another session the active one and answers with its screen. Use it only to switch between several open sessions (two systems, or a second window opened with /o); every other tool also takes "session" for a single call.',
      inputSchema: { session: z.string().describe("from sap_sessions: number, id, system, transaction, or sapgui, webgui, fiori") },
      // Read-only for SAP: it changes only which session this server's other tools use by default, then reads that session's screen.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref }) =>
      answer(() =>
        serial(ref, "sap_use", async () => {
          const { driver, info } = await registry.session(ref);
          registry.active = info.id;
          return text(views.present(info.id, await driver.look({ compact: true }), true));
        }),
      ),
  );

  server.registerTool(
    "sap_look",
    {
      title: "Look at the SAP screen",
      description: `Reads the SAP screen as compact text (about 250 tokens): a header (transaction or Fiori app, program, screen, system), one line per control (id, type, label = "value", state), tables as rows, popups as their own WINDOW, the status bar last.
Call it first, to get the ids sap_act needs. Do not call it after sap_act: that answer already is the new screen. Call it again only to read more than the view shows:
- a long list or grid shows the rows on screen and the total: read others with id and rows (${MAX_ROWS} at most per call), and cols to keep the columns you need. Never conclude an entry is missing from the rows on screen.
- every entry of a dropdown, a tree or a text: id. Menus: id "mbar". Toolbar buttons and ids the compact view leaves out: full.
- after you lost track: sap_look (diff: only what changed since your last view).
For charts or HTML areas the view marks opaque, use sap_screenshot.`,
      inputSchema: {
        session,
        full: z.boolean().optional().describe("every id, column, toolbar button and its key (larger)"),
        diff: z.boolean().optional().describe("only what changed since your last view"),
        id: z.string().optional().describe("one control, whole: every dropdown entry, every row read of a grid, table, tree or list"),
        rows: z.string().optional().describe('with id: rows counted from 0, e.g. "120-180" (scrolls there)'),
        cols: z.string().optional().describe(`with id, a grid or table control: only these columns, by id or title, e.g. "VBELN,NETWR"; without rows, the first ${COLS_ONLY_ROWS.to + 1} rows`),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ session: ref, full, diff, id, rows, cols }) =>
      answer(() => serial(ref, "sap_look", () => look(ref, full, diff, id, rows, cols))).then(confirmNotice),
  );

  async function look(ref: string | undefined, full: boolean | undefined, diff: boolean | undefined, id: string | undefined, rows: string | undefined, cols: string | undefined): Promise<CallToolResult> {
        const { driver, info } = await registry.session(ref);
        if (rows !== undefined && !id) throw new ActionError('"rows" needs "id": the grid, table, tree or list to read.');
        if (cols !== undefined && !id) throw new ActionError('"cols" needs "id": the grid or table control whose columns to keep.');
        if (id) {
          // Columns without rows: the rows from the first one on (a page of them; the answer says where it ends).
          const range = rows !== undefined ? parseRows(rows) : cols !== undefined ? COLS_ONLY_ROWS : undefined;
          const options: LookOptions = { compact: !full, id, ...(range ? { rows: range } : {}), ...(cols !== undefined ? { cols: cols.split(",") } : {}) };
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
  }

  /** Can the client ask the user (MCP elicitation, form mode)? Under SAP_WRITE=confirm, a write runs only after it did. */
  const canElicit = () => !!server.server.getClientCapabilities()?.elicitation?.form;
  /** Why a write is refused under confirm when the client cannot ask the user. */
  const cannotAsk = (reason: string) =>
    `this action may write to SAP (${reason}) and writing is set to confirm, but this client cannot ask the user (it does not support MCP elicitation). Nothing ran. Tell the user what you would have saved; do not look for another way. ${LEAVE_UNSAVED} The user can set SAP_WRITE=on and approve sap_act in the client's own tool approval, or use a client that asks (MCP elicitation).`;
  /**
   * Confirm mode with a client that cannot ask the user: said once, before
   * anything else of the first answer, so the agent knows before the work
   * that a save will be refused (stdio.ts also says it in the server's log).
   */
  let noticed = false;
  function confirmNotice(r: CallToolResult): CallToolResult {
    if (noticed || policy.write !== "confirm" || r.isError) return r;
    noticed = true;
    if (canElicit()) return r;
    const first = r.content[0];
    if (first?.type !== "text") return r;
    return { ...r, content: [{ ...first, text: `NOTE: writing is set to confirm, and this client cannot ask the user (no MCP elicitation): actions that may write will be refused. Say so to the user before working towards a save.\n${first.text}` }, ...r.content.slice(1)] };
  }

  /**
   * Where the time of an action went, when asked for (SAP_TIMINGS=on, or "timing":true in the action):
   * a line after the note. `marks` are the times the phases ended, from the start of the call.
   */
  const timingsOn = /^(on|true|1)$/i.test(process.env.SAP_TIMINGS ?? "");
  function timed(note: string, d: Driver, wanted: boolean, t0: number, phases: [string, number][]): string {
    if (!wanted) return note;
    const total = Date.now() - t0;
    const driver = d.timing?.();
    return `${note}\n(timing: ${total} ms in the server: ${phases.map(([k, v]) => `${k} ${v}`).join(", ")}${driver ? `; the action ${driver}` : ""})`;
  }

  /** Leaves a transaction the agent may not work in, and says how that went. */
  async function leave(d: Driver): Promise<string> {
    try {
      await d.act(normalizeAction({ do: "okcode", value: "/n" }));
      return "The server left it with /n; input that was not saved there is gone.";
    } catch (e) {
      return `The server could not leave it with /n (${(e as Error).message.split("\n")[0]}): leave it before doing anything else.`;
    }
  }

  /**
   * With structured output on, an answer that is not an error must carry its
   * data (the SDK checks it against the output schema): one that has none
   * gets the counts alone.
   */
  function withAnyData(r: CallToolResult, actions?: unknown): CallToolResult {
    if (!structured || r.isError || r.structuredContent) return r;
    return withData(r, { ran: 0, total: Array.isArray(actions) ? actions.length : 1, screen: {} } satisfies ActOutput);
  }

  /** Runs an action that passed the guard, then checks where it led. */
  async function perform(d: Driver, action: NormalizedAction, whole = false, risk?: string, clock?: { t0: number; judged: number; wanted: boolean }): Promise<CallToolResult> {
    const session = d.info.id;
    const a0 = Date.now();
    // "/oVA03" opens the transaction in a new SAP GUI session: follow it there.
    const opens = action.do === "okcode" && typeof action.value === "string" && /^\/o\S/i.test(action.value) && d.info.surface === "sapgui";
    const before = opens ? new Set((await registry.discover()).sessions.map((s) => s.id)) : undefined;
    // While a recording is on, an action that works becomes a step of it.
    const done = await recorder.act(d, action, risk, () => d.act(action));
    const acted = Date.now();
    // The line that repeats this action in a script: last in the note block. Kept for a draft test when the action ran where it should.
    const line = codeLine() ? `\ncode: ${codeOf(action)}` : "";
    const ok = (t: string, v: string) => {
      remember(session, action);
      return withData(text(t), data(() => ranOn(v)));
    };
    const note = (screen: () => Promise<string>) =>
      screen().then((v) => ({ v, n: clock ? timed(done, d, clock.wanted, clock.t0, [["judge", clock.judged], ["act", acted - a0], ["answer", Date.now() - acted]]) : done }));
    if (before) {
      for (let i = 0; i < 10; i++) {
        const fresh = (await registry.discover()).sessions.find((s) => s.surface === "sapgui" && !before.has(s.id));
        if (fresh) {
          registry.active = fresh.id;
          const nd = await registry.driver(fresh.id);
          const { v, n } = await note(() => nd.look({ compact: true }));
          return ok(`${n}\nA new session opened (${fresh.where}); it is now the active one. The previous session is still open (sap_sessions lists both).${line}\n\n${views.present(fresh.id, v, true)}`, v);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const { v, n } = await note(() => d.look({ compact: true }));
      return ok(`${n}\nNo new session appeared within 5 s (SAP allows at most 6 per logon): this is still the previous session.${line}\n\n${views.present(session, v, whole)}`, v);
    }
    // A menu entry, a favourite or a tree node can open a transaction no okcode named.
    const after = await d.refresh().catch(() => undefined);
    const landed = after && sessionRefusal(policy, after);
    if (landed) {
      const left = await leave(d);
      const screen = await d
        .look({ compact: true })
        .then((v) => views.present(session, v, true))
        .catch((e: Error) => `(the screen could not be read: ${e.message.split("\n")[0]})`);
      return fail(`${done}\nThis led to a transaction the agent may not work in: ${landed}. ${left}\n\n${screen}`);
    }
    const { v, n } = await note(() => d.look({ compact: true }));
    const shown = withStatus(views.present(session, v, whole), v);
    const top = statusTop(shown, v);
    return ok(`${n}${top ? `\n${top}` : ""}${line}\n\n${shown}`, v);
  }

  /** The session as it is now, and what the guard says about this action on it. */
  async function judge(ref: string | undefined, action: NormalizedAction) {
    const { driver, info } = await registry.session(ref);
    // The transaction the session is in counts too, however it was opened.
    const here = sessionRefusal(policy, info);
    if (here && !leavesTransaction(policy, action))
      return { driver, info, refused: `this session is in a transaction the agent may not work in: ${here}. Leave it with {"do":"okcode","value":"/n"} or open an allowed transaction with {"do":"okcode","value":"/n<transaction>"}.` };
    // Opening an app by its intent is the Fiori launchpad's: said here, before the user is asked to confirm an action that cannot run.
    if (action.do === "open" && info.surface !== "fiori")
      throw new ActionError('open works in a Fiori launchpad tab only (sap_sessions lists the tabs). On an SAP GUI or Web GUI screen, open a transaction with {"do":"okcode","value":"/n<transaction>"}.');
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
    return perform(j.driver, shown.action, whole, j.assessment.risk);
  }

  /**
   * An action that could not run, said with where the session is now when
   * that is not what the agent last saw: an id from an earlier screen fails
   * here, and the agent gets the screen it is really on in the same answer.
   */
  async function failedOn(ref: string | undefined, e: unknown): Promise<CallToolResult> {
    const message = withNextStep((e as Error).message);
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

  async function run(ref: string | undefined, input: unknown, whole = false): Promise<CallToolResult> {
    // "timing" asks for where the time went; it is not part of the action.
    let raw = input;
    let wanted = timingsOn;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "timing" in raw) {
      const { timing, ...rest } = raw as Record<string, unknown>;
      wanted = timing === true || timingsOn;
      raw = rest;
    }
    // One normalised action for the guard, for assess and for act.
    const action = normalizeAction(raw);
    const field = commandFieldRefusal(action);
    if (field) return fail(`Refused: ${field}`);
    // The guard and the action run in the session's turn; asking the user does not hold the session.
    type Held = { info: SessionInfo; assessment: Assessment; confirm: string };
    const box: { held?: Held } = {};
    const done = await queue.run(await laneOf(ref), actionText(action), async (turn): Promise<CallToolResult | undefined> => {
      const q0 = Date.now();
      let j: Awaited<ReturnType<typeof judge>>;
      try {
        j = await judge(ref, action);
      } catch (e) {
        return withTurn(await failedOn(ref, e), turn);
      }
      if ("refused" in j) return withTurn(fail(`Refused: ${j.refused}`), turn);
      const { driver, info, assessment, verdict } = j;
      // A write goes only to the screen the agent was last shown (staleWrite); before any first view there is nothing to compare.
      const seen = assessment.risk === "commit" && !("refused" in verdict) ? views.last(info.id) : undefined;
      if (seen !== undefined) {
        const now = await settled(driver);
        const stale = staleWrite(parseScreen(seen), parseScreen(now));
        if (stale) return withTurn(fail(`Not run: ${stale}.\n\n${views.present(info.id, now, true)}`), turn);
      }
      if (verdict.run) return withTurn(await perform(driver, action, whole, assessment.risk, { t0: q0, judged: Date.now() - q0, wanted }).catch((e: unknown) => failedOn(ref, e)), turn);
      if ("refused" in verdict) return withTurn(fail(`Refused: ${verdict.refused}`), turn);
      if (!canElicit()) return withTurn(fail(`Refused: ${cannotAsk(verdict.confirm)}`), turn);
      box.held = { info, assessment, confirm: verdict.confirm };
      return undefined;
    });
    if (done || !box.held) return done ?? fail("Not run.");
    return confirmHeld(box.held, action, whole);
  }

  /** An action the guard holds for the user's yes: the client asks the user (MCP elicitation); it runs on a yes, if the screen is still what the user was shown. */
  async function confirmHeld(held: { info: SessionInfo; assessment: Assessment; confirm: string }, action: NormalizedAction, whole: boolean): Promise<CallToolResult> {
    const { info, assessment, confirm } = held;
    const shown = shownOf(info, action, assessment);
    const what = `${confirm}, on ${place(info)}`;
    let answer: Awaited<ReturnType<typeof server.server.elicitInput>>;
    try {
      answer = await server.server.elicitInput(
        {
          mode: "form",
          message: `Allow this action in SAP? It may write to the system.\n\nWhat: ${confirm}\nWhere: ${place(info)} [${info.where}]\nAction: ${actionText(action)}`,
          requestedSchema: { type: "object", properties: {} },
        },
        { timeout: ELICIT_TIMEOUT_MS },
      );
    } catch (e) {
      return fail(`Not run: the user could not be asked to confirm (${(e as Error).message.split("\n")[0]}).`);
    }
    if (answer.action !== "accept") {
      // Claude Code run headless (claude -p) says it can ask, then answers every question "cancel" at once, unseen by anyone.
      const who =
        answer.action === "decline"
          ? "the user declined"
          : "the confirmation was dismissed, or the client could not show it (a client run without a user, such as claude -p, dismisses every question): no yes came for";
      const said = `Not run: ${who} this action (${what}). Stop here: do not retry it or look for another way; tell the user it was not done and ask how to go on. ${LEAVE_UNSAVED}`;
      return withData(text(said), data((): ActOutput => ({ ran: 0, total: 1, stopped: { why: "declined", text: said.split(". Stop here")[0] as string }, screen: screenOfInfo(info) })));
    }
    const r = await serial(shown.session, actionText(action), () => runConfirmed(shown, whole));
    // The agent does not see the dialog: without this line it told the user a confirmed popup "Yes" had saved
    // without asking them (live 2026-11-21, interactive Claude Code).
    const [first, ...more] = r.content;
    if (r.isError || first?.type !== "text") return r;
    return { ...r, content: [{ ...first, text: `The user confirmed this action in the client (${confirm}).\n${first.text}` }, ...more] };
  }

  /** The screen once SAP is done with the step before it (at most 15 s), as the compact view. */
  async function settled(d: Driver): Promise<string> {
    const until = Date.now() + 15_000;
    let view = await d.look({ compact: true });
    while (stillWorking(view) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      view = await d.look({ compact: true });
    }
    return view;
  }

  /**
   * Several actions in one call (batch.ts). Each is judged by the guard when
   * its turn comes, on the screen as it is then, and recorded as its own
   * step. The batch holds the session for all of them: no other call runs
   * in between. It ends before the next action when one fails, is refused or
   * waits for the user's yes, and when the screen is not what the agent could
   * foresee (`stopAfter`). The answer says what ran and why it ended, then
   * the screen once.
   */
  async function runBatch(ref: string | undefined, input: unknown, whole = false): Promise<CallToolResult> {
    const steps = parseBatch(input);
    const total = steps.length;
    // What can be refused without a screen is refused before anything runs.
    for (const [i, s] of steps.entries()) {
      const no =
        commandFieldRefusal(s.action) ??
        tcodeRefusal(policy, tcodeOf(s.action)) ??
        (s.action.do === "okcode" && /^\/o\S/i.test(String(s.action.value)) ? `"${String(s.action.value)}" opens a new session: send it on its own, not in "actions"` : undefined);
      if (no) return fail(`Refused: action ${i + 1} of ${total}: ${no}\nNothing ran.`);
    }
    const rest = (from: number) => (from > total ? "" : from === total ? ` Action ${total} did not run.` : ` Actions ${from} to ${total} did not run.`);
    type Held = { info: SessionInfo; assessment: Assessment; confirm: string; action: NormalizedAction };
    const box: { held?: Held; head?: string; ran?: number; stopped?: { why: string; text: string } } = {};
    const done = await queue.run(await laneOf(ref), `${total} actions`, async (turn): Promise<CallToolResult | undefined> => {
      const lines: string[] = [];
      const codes: string[] = [];
      let ran = 0;
      /** Why the batch ended early (`why`: one word for code); `error` when an action failed or was refused; `next` is the first action after the one it names. */
      let end: { why: string; text: string; error: boolean; next: number } | undefined;
      let note: string | undefined;
      let driver: Driver | undefined;
      let id: string | undefined;
      let before: ParsedScreen | undefined;
      /** The screen the agent saw when it sent the batch. */
      let start: ParsedScreen | undefined;
      let view: string | undefined;
      for (const [i, s] of steps.entries()) {
        const n = i + 1;
        const what = `action ${n} (${actionText(s.action)})`;
        let j: Awaited<ReturnType<typeof judge>>;
        try {
          // The session the first action ran on is the session of all of them.
          j = await judge(id ?? ref, s.action);
        } catch (e) {
          // No session, or an id that names nothing here: with nothing run yet, the answer is the one of a single action.
          if (i === 0) return withTurn(await failedOn(ref, e), turn);
          end = { why: "failed", text: `${what} could not run: ${(e as Error).message}`, error: true, next: n + 1 };
          view = undefined;
          break;
        }
        driver = j.driver;
        id = j.info.id;
        if ("refused" in j) {
          end = { why: "refused", text: `${what} was refused: ${j.refused}`, error: true, next: n + 1 };
          break;
        }
        if (!j.verdict.run && "refused" in j.verdict) {
          end = { why: "refused", text: `${what} was refused: ${j.verdict.refused}`, error: true, next: n + 1 };
          break;
        }
        before ??= parseScreen(await settled(driver));
        // The screen the agent saw when it sent the batch: the one it was last shown, else the one the batch began on.
        if (!start) {
          const seen = views.last(id);
          start = seen === undefined ? before : parseScreen(seen);
        }
        const blind = j.assessment.risk === "commit" ? unseenWrite(s, start, before) : undefined;
        if (blind) {
          end = { why: "unseen", text: `${what} did not run: ${blind}`, error: false, next: n };
          break;
        }
        if (!j.verdict.run && !canElicit()) {
          end = { why: "refused", text: `${what} was refused: ${cannotAsk(j.verdict.confirm)}`, error: true, next: n + 1 };
          break;
        }
        if (!j.verdict.run) {
          box.held = { info: j.info, assessment: j.assessment, confirm: j.verdict.confirm, action: s.action };
          end = { why: "held", text: `${what} may write and waits for the user's yes`, error: false, next: n + 1 };
          break;
        }
        let said: string;
        try {
          const d = driver;
          said = await recorder.act(d, s.action, j.assessment.risk, () => d.act(s.action));
        } catch (e) {
          end = { why: "failed", text: `${what} failed: ${(e as Error).message}`, error: true, next: n + 1 };
          view = undefined;
          break;
        }
        ran = n;
        remember(id, s.action);
        lines.push(`${n}. ${said}`);
        codes.push(codeOf(s.action));
        // A menu entry, a favourite or a tree node can open a transaction no okcode named.
        const info = await driver.refresh().catch(() => undefined);
        const landed = info && sessionRefusal(policy, info);
        if (landed) {
          end = { why: "transaction", text: `action ${n} led to a transaction the agent may not work in: ${landed}. ${await leave(driver)}`, error: true, next: n + 1 };
          view = undefined;
          break;
        }
        view = await settled(driver);
        const after = parseScreen(view);
        const stop = stopAfter(s.action, before, after, s.expect);
        if (stop && n < total) {
          end = { why: stop.why, text: `after action ${n}, ${stop.text}`, error: false, next: n + 1 };
          break;
        }
        // Nothing follows the last action: only what it said it expects is worth a line.
        if (stop?.why === "expect") note = `Action ${n}: ${stop.text}.`;
        if (s.show && n < total) lines.push(`--- the screen after action ${n}\n${views.present(id, view, whole)}\n---`);
        before = after;
      }
      const head = end ? `Ran ${ran} of ${total} actions. Stopped: ${end.text.replace(/[.\s]+$/, "")}.${rest(end.next)}` : `Ran ${total} action${total === 1 ? "" : "s"}.`;
      const body = [head, ...(note ? [note] : []), ...lines, ...(codeLine() && codes.length ? [`code:\n${codes.join("\n")}`] : [])].join("\n");
      const stopped = end ? { why: end.why, text: end.text } : undefined;
      if (box.held) {
        // The held action's own answer follows: what it did after the user's yes, or that the user said no.
        box.head = body;
        box.ran = ran;
        if (stopped) box.stopped = stopped;
        return undefined;
      }
      let screen = "";
      let seen: string | undefined;
      if (driver && id) {
        try {
          const v = view ?? (await settled(driver));
          seen = v;
          const shown = withStatus(views.present(id, v, whole), v);
          const top = statusTop(shown, v);
          screen = `${top ? `\n${top}` : ""}\n\n${shown}`;
        } catch (e) {
          screen = `\n\n(the screen could not be read: ${(e as Error).message.split("\n")[0]})`;
        }
      }
      const said = data((): ActOutput => ({ ran, total, ...(stopped ? { stopped } : {}), ...(seen !== undefined ? screenOf(seen) : { screen: {} }) }));
      return withTurn(withData(end?.error ? fail(`${body}${screen}`) : text(`${body}${screen}`), said), turn);
    });
    if (done || !box.held) return done ?? fail("Not run.");
    const r = await confirmHeld(box.held, box.held.action, whole);
    const first = r.content[0];
    if (first?.type !== "text") return r;
    // As data: the actions before the held one, and what the held one did (ran after the user's yes, or not).
    const after = r.structuredContent as ActOutput | undefined;
    const merged = after && data((): ActOutput => ({ ...after, ran: (box.ran ?? 0) + after.ran, total, stopped: after.stopped ?? box.stopped }));
    return withData({ ...r, content: [{ ...first, text: `${box.head}\n\n${first.text}` }, ...r.content.slice(1)] }, merged);
  }

  server.registerTool(
    "sap_act",
    {
      title: "Act on the SAP screen",
      description: `Acts on the SAP screen: type into fields, press buttons and keys, open a transaction, answer a popup, open a grid row. Ids come from the latest view; the last part is enough ("ctxtVBAK-AUART"). Answers with the result, so act again from the answer instead of calling sap_look.
Read the answer in this order: (1) a "STATUS E/W/A" line: E means the step did not go through, correct the field it names; W: Enter accepts it; an S status says it worked (document numbers are there). (2) a new "WINDOW wnd[1]": a popup; answer it before anything else. (3) the screen: whole when it is another one; on the same screen only what changed: "~" changed line, "+" new, "-" gone, "=" unchanged, for context.
How SAP works: set only types. Fill every field of the screen, then send one Enter (key 0); SAP then checks the input and fills dependent fields. Do not guess codes: f4 on the field lists the valid ones.
do, with its fields:
  set  id, value. A field; a grid or table cell: add row, col; in a text editor "\\n" is a line break
  key  key: a name, "Enter", "Back", "Execute" (F8), "Save", "Cancel" (F12), "Exit", "F4", "Shift+F3", or SAP's number (0 Enter, 3 Back, 8 Execute)
  press  id. A button ("click" too); btn[N] is function key N
  okcode  value: "/nVA03" starts a transaction (unsaved input is lost), "/oVA03" opens it in a new session. Commands go here only: the command field cannot be typed into
  select  id. Tab, radio button, menu entry, list item; with row: a table or grid row (value false deselects)
  check  id, value true or false
  combo  id, key (the entry's key or text). Without key: lists the entries
  f4  id. Value help; pick from the popup with grid or dblclick
  focus  id. Puts the cursor on a control, as a click into it would
  dblclick  id. A list entry or a label
  grid  id, row, col, how double|select|cell. Any row of the total; select without row: the column
  tree  id, node, how double|select|expand|collapse
  toolbar  id, button
  scroll  id, to: a row from 0, "next", "prev", "first", "last"; a table control's columns "left", "right"
  open  app "#SalesOrder-manage". Fiori launchpad only, never a URL
timeout: the seconds a step may take (SAP GUI; default 180).
actions: [...] in place of one action, up to ${MAX_BATCH}: one screen's worth, its fields then the key that sends them, answered once ("Ran k of n", then the screen). It ends at the first surprise: a failure or refusal, a write waiting for a yes, a popup, an E, W or A status, another screen (an okcode "/n<tcode>" first goes on into that transaction). Per step, expect lets it go on through what you know comes: {"screen":"4001"}, {"popup":true}, {"status":"W"}; show:true adds the screen after that step; a write on a screen the batch reached after you sent it does not run unless its step says unseen:true.
Failures say what to do: an id from an earlier screen answers with the screen you are on, an ambiguous id with the candidates. Do not repeat a failed action unchanged.
${writeRule(policy)}`,
      // Loose: "action":{...}, the older shape of one action, still works (clients and recordings that send it), and so do "timing" and other keys an action passes on.
      inputSchema: z
        .object({
          ...actionFields,
          do: actionFields.do.optional(),
          actions: z.array(stepSchema).optional(),
          session,
          full: z.boolean().optional().describe("answer with the whole screen, not the changes"),
        })
        .passthrough(),
      ...(structured ? { outputSchema: actOutput } : {}),
      // A closed SAP system, not the open web: openWorldHint is false on every tool.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) =>
      answer(async () => {
        const { actions, action, session: ref, full } = input as { actions?: unknown; action?: unknown; session?: string; full?: boolean };
        // The action's fields at the top level, as the schema lists them; anything but the call's own keys goes with them.
        const flat = Object.fromEntries(Object.entries(input).filter(([k, v]) => !CALL_KEYS.has(k) && v !== undefined));
        const one = Object.keys(flat).length > 0;
        if (actions !== undefined && (one || action !== undefined)) return fail('Send one action ("do" and its fields) or "actions", not both.');
        if (one && action !== undefined) return fail('Send the action\'s fields ("do", "id", ...) at the top level, not also inside "action".');
        if (actions !== undefined) return withAnyData(await runBatch(ref, actions, full === true), actions);
        return withAnyData(await run(ref, one ? flat : action, full === true));
      }).then(confirmNotice),
  );

  server.registerTool(
    "sap_screenshot",
    {
      title: "Screenshot of the SAP session",
      description:
        "A PNG of the session's window or tab. Use it only for what sap_look cannot give as text (charts, HTML panels, an area the view marks opaque) or when the user asks for a picture: an image costs several times a text view. Never use it to find ids.",
      inputSchema: { session },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ session: ref }) =>
      answer(async () => {
        const png = await (await registry.driver(ref)).screenshot();
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      }),
  );

  registerRecordTools(server, registry, policy, recorder, serial, (id) => history.get(id) ?? [], structured);
  registerCodeTools(server, registry, policy, recorder, serial);
  withoutSdkDefaults(server);

  return { server, registry, recorder };
}

type ListTools = (request: unknown, extra: unknown) => Promise<{ tools: { inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; execution?: { taskSupport?: string } }[] }>;

/**
 * tools/list without what the SDK adds to every tool and no client needs: the
 * "$schema" keyword of its JSON Schema conversion, and
 * "execution":{"taskSupport":"forbidden"}, which is the spec's default. Some
 * 25 tokens per tool in every conversation. The SDK has no option for either,
 * so the handler it installed is wrapped (test/surface.test.ts checks it).
 */
function withoutSdkDefaults(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListTools> })._requestHandlers;
  const inner = handlers?.get("tools/list");
  if (!handlers || !inner) return;
  handlers.set("tools/list", async (request, extra) => {
    const out = await inner(request, extra);
    for (const t of out.tools) {
      delete t.inputSchema.$schema;
      if (t.outputSchema) delete t.outputSchema.$schema;
      if (t.execution && Object.keys(t.execution).length === 1 && t.execution.taskSupport === "forbidden") delete t.execution;
    }
    return out;
  });
}
