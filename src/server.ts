/**
 * The MCP server: six tools over the registry of open SAP sessions, and two
 * that turn a session into a repeatable test (record/tools.ts).
 *
 *   sap_sessions    list the SAP sessions open on this machine
 *   sap_use         make one the active session
 *   sap_look        the active screen as compact text (or full)
 *   sap_act         one action (guardrails first), then the new screen
 *   sap_confirm     run an action that waits for the user's yes (SAP_WRITE=confirm only)
 *   sap_screenshot  a PNG of the session's window or tab
 */
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionText, normalizeAction, type NormalizedAction, VERBS } from "./core/action.js";
import { MAX_BATCH, parseBatch, stopAfter, unseenWrite } from "./batch.js";
import { commandFieldRefusal, decide, leavesTransaction, type Policy, sessionRefusal, tcodeOf, tcodeRefusal } from "./core/guard.js";
import { type Turn, SessionQueue, waitedLine } from "./core/queue.js";
import { Registry } from "./core/registry.js";
import { ActionError, type Assessment, type Driver, type LookOptions, type SessionInfo, type Surface } from "./core/types.js";
import { type ViewMode, Views } from "./core/views.js";
import { Recorder, type RecorderOptions, recorderOptionsFromEnv } from "./record/recorder.js";
import { type ParsedScreen, parseScreen, stillWorking } from "./record/screen.js";
import { registerRecordTools } from "./record/tools.js";
import { registerCodeTools } from "./record/code-tools.js";
import { codeOf } from "./sdk/code.js";

export const SERVER_NAME = "sap-gui";
export const SERVER_VERSION = "0.1.0";

/**
 * What the agent is told about actions that may write, for the write setting
 * the server runs with: one sentence, true for this server. sap_confirm
 * exists only in confirm mode, the one mode that hands out tokens.
 */
export function writeRule(policy: Policy): string {
  if (policy.write === "off") return "An action that may write (save, post, delete...) is refused: the user has set writing off.";
  if (policy.write === "on") return "An action that may write (save, post, delete...) runs: the user has set writing on.";
  return "An action that may write (save, post, delete...) waits for the user's yes: the client asks the user if it can; if not, the answer holds a token for sap_confirm, to call only after the user said yes to that exact action.";
}

function instructions(policy: Policy): string {
  return `Sees and drives the SAP screens the user already has open (SAP GUI for Windows; Web GUI and Fiori in Chrome), as the user. It never logs on.
Start with sap_look (sap_sessions when several are open). Act with sap_act on the ids the view shows: one action, or with "actions" the fields of the screen you see and the key that sends them, in one call. Each answer is the new screen, so look again only when you need to. Read the status bar after each call: SAP reports errors there.
${writeRule(policy)}
sap_record turns a run into a test; sap_replay runs it again without a model.`;
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
    id: z.string().optional(),
    value: z.any().optional(),
    key: z.any().optional(),
    node: z.string().optional(),
    how: z.string().optional(),
    // Whole numbers, checked by normalizeAction: .int() would put the safe-integer bounds into tools/list.
    row: z.number().optional(),
    col: z.string().optional(),
    button: z.string().optional(),
    app: z.string().optional(),
    to: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

/**
 * An action of a batch: an action, with "expect" and "show" (batch.ts checks both).
 * Loose on purpose: the fields are the ones of `action`, and writing them twice into tools/list costs 250 tokens in every conversation.
 */
const batchSchema = z.object({ do: z.string() }).passthrough();

export interface ServerOptions {
  policy: Policy;
  surfaces: Surface[];
  /** What sap_act answers with: the changes when that is shorter ("diff", the default), or always the whole screen ("full"). */
  view?: ViewMode;
  /** Where recordings go and whether every session is recorded; default: from SAP_RECORD_DIR and SAP_RECORD. */
  record?: RecorderOptions;
  /** Ends each answer of an action that ran with the SDK line that repeats it; default: on unless SAP_CODE=off. */
  code?: boolean;
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

export function createServer({ policy, surfaces, view = "diff", record, code = !/^(off|false|0)$/i.test(process.env.SAP_CODE ?? "") }: ServerOptions) {
  const registry = new Registry(surfaces, policy);
  const views = new Views(view);
  const recorder = new Recorder(record ?? recorderOptionsFromEnv(process.env, `${SERVER_NAME}-mcp-server ${SERVER_VERSION}`));
  const pending = new Map<string, { shown: Shown; at: number }>();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: instructions(policy) });
  const session = z.string().optional().describe("from sap_sessions: number, id, system, transaction, or sapgui, webgui, fiori; default: the active one");
  const queue = new SessionQueue();
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
      description: "The SAP sessions open on this machine (SAP GUI windows; Web GUI and Fiori tabs in Chrome): system, client, user, transaction. * marks the active one.",
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
      description: "Makes a session the active one for the other tools, and shows its screen.",
      inputSchema: { session: z.string().describe("from sap_sessions: number, id, system, transaction, or sapgui, webgui, fiori") },
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
      description:
        'The current SAP screen as compact text: a header (transaction or app, screen, system), then one line per control (id, type, label, value, state); tables as rows, popups as their own windows. Long lists show the rows on screen and the total: read others with id and rows, or {"do":"scroll"}. id "mbar" lists every menu entry.',
      inputSchema: {
        session,
        full: z.boolean().optional().describe("every id, column, toolbar button and its key (larger)"),
        diff: z.boolean().optional().describe("only what changed since your last view"),
        id: z.string().optional().describe("one control, whole: every dropdown entry, every row read of a grid, table, tree or list"),
        rows: z.string().optional().describe('with id: rows counted from 0, e.g. "120-180" (scrolls there)'),
        cols: z.string().optional().describe(`with id, a grid or table control: only these columns, by id or title, e.g. "VBELN,NETWR"; without rows, the first ${COLS_ONLY_ROWS.to + 1} rows`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref, full, diff, id, rows, cols }) =>
      answer(() => serial(ref, "sap_look", () => look(ref, full, diff, id, rows, cols))),
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

  /** Can the client ask the user itself (MCP elicitation, form mode)? Then no token is needed. */
  const canElicit = () => !!server.server.getClientCapabilities()?.elicitation?.form;

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
    const line = code ? `\ncode: ${codeOf(action)}` : "";
    const ok = (t: string) => {
      remember(session, action);
      return text(t);
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
          return ok(`${n}\nA new session opened (${fresh.where}); it is now the active one. The previous session is still open (sap_sessions lists both).${line}\n\n${views.present(fresh.id, v, true)}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const { v, n } = await note(() => d.look({ compact: true }));
      return ok(`${n}\nNo new session appeared within 5 s (SAP allows at most 6 per logon): this is still the previous session.${line}\n\n${views.present(session, v, whole)}`);
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
    return ok(`${n}${top ? `\n${top}` : ""}${line}\n\n${shown}`);
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
      if (verdict.run) return withTurn(await perform(driver, action, whole, assessment.risk, { t0: q0, judged: Date.now() - q0, wanted }).catch((e: unknown) => failedOn(ref, e)), turn);
      if ("refused" in verdict) return withTurn(fail(`Refused: ${verdict.refused}`), turn);
      box.held = { info, assessment, confirm: verdict.confirm };
      return undefined;
    });
    if (done || !box.held) return done ?? fail("Not run.");
    return confirmHeld(box.held, action, whole);
  }

  /** An action the guard holds for the user's yes: asks the user when the client can, else answers with a token for sap_confirm. */
  async function confirmHeld(held: { info: SessionInfo; assessment: Assessment; confirm: string }, action: NormalizedAction, whole: boolean): Promise<CallToolResult> {
    const { info, assessment } = held;
    const verdict = { confirm: held.confirm };
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
      return serial(shown.session, actionText(action), () => runConfirmed(shown, whole));
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
    const box: { held?: Held; head?: string } = {};
    const done = await queue.run(await laneOf(ref), `${total} actions`, async (turn): Promise<CallToolResult | undefined> => {
      const lines: string[] = [];
      const codes: string[] = [];
      let ran = 0;
      /** Why the batch ended early; `error` when an action failed or was refused; `next` is the first action after the one it names. */
      let end: { text: string; error: boolean; next: number } | undefined;
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
          end = { text: `${what} could not run: ${(e as Error).message}`, error: true, next: n + 1 };
          view = undefined;
          break;
        }
        driver = j.driver;
        id = j.info.id;
        if ("refused" in j) {
          end = { text: `${what} was refused: ${j.refused}`, error: true, next: n + 1 };
          break;
        }
        if (!j.verdict.run && "refused" in j.verdict) {
          end = { text: `${what} was refused: ${j.verdict.refused}`, error: true, next: n + 1 };
          break;
        }
        before ??= parseScreen(await settled(driver));
        start ??= before;
        const blind = j.assessment.risk === "commit" && i > 0 ? unseenWrite(s, start, before) : undefined;
        if (blind) {
          end = { text: `${what} did not run: ${blind}`, error: false, next: n };
          break;
        }
        if (!j.verdict.run) {
          box.held = { info: j.info, assessment: j.assessment, confirm: j.verdict.confirm, action: s.action };
          end = { text: `${what} may write and waits for the user's yes`, error: false, next: n + 1 };
          break;
        }
        let said: string;
        try {
          const d = driver;
          said = await recorder.act(d, s.action, j.assessment.risk, () => d.act(s.action));
        } catch (e) {
          end = { text: `${what} failed: ${(e as Error).message}`, error: true, next: n + 1 };
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
          end = { text: `action ${n} led to a transaction the agent may not work in: ${landed}. ${await leave(driver)}`, error: true, next: n + 1 };
          view = undefined;
          break;
        }
        view = await settled(driver);
        const after = parseScreen(view);
        const stop = stopAfter(s.action, before, after, s.expect);
        if (stop && n < total) {
          end = { text: `after action ${n}, ${stop.text}`, error: false, next: n + 1 };
          break;
        }
        // Nothing follows the last action: only what it said it expects is worth a line.
        if (stop?.why === "expect") note = `Action ${n}: ${stop.text}.`;
        if (s.show && n < total) lines.push(`--- the screen after action ${n}\n${views.present(id, view, whole)}\n---`);
        before = after;
      }
      const head = end ? `Ran ${ran} of ${total} actions. Stopped: ${end.text.replace(/[.\s]+$/, "")}.${rest(end.next)}` : `Ran ${total} action${total === 1 ? "" : "s"}.`;
      const body = [head, ...(note ? [note] : []), ...lines, ...(code && codes.length ? [`code:\n${codes.join("\n")}`] : [])].join("\n");
      if (box.held) {
        // The held action's own answer follows (the user's yes, or a token); the screen comes with it or with sap_confirm.
        box.head = body;
        return undefined;
      }
      let screen = "";
      if (driver && id) {
        try {
          const v = view ?? (await settled(driver));
          const shown = withStatus(views.present(id, v, whole), v);
          const top = statusTop(shown, v);
          screen = `${top ? `\n${top}` : ""}\n\n${shown}`;
        } catch (e) {
          screen = `\n\n(the screen could not be read: ${(e as Error).message.split("\n")[0]})`;
        }
      }
      return withTurn(end?.error ? fail(`${body}${screen}`) : text(`${body}${screen}`), turn);
    });
    if (done || !box.held) return done ?? fail("Not run.");
    const r = await confirmHeld(box.held, box.held.action, whole);
    const first = r.content[0];
    if (first?.type !== "text") return r;
    return { ...r, content: [{ ...first, text: `${box.head}\n\n${first.text}` }, ...r.content.slice(1)] };
  }

  server.registerTool(
    "sap_act",
    {
      title: "Act on the SAP screen",
      description: `One action on the SAP screen, on an id from the view. Answers with the new screen; on the same screen, only what changed: "~" changed line, "+" new, "-" gone, "=" unchanged, for context.
  {"do":"set","id":"ctxtVBAK-AUART","value":"OR"}  type into a field; a grid cell: add "row" and "col"; in a text editor "\\n" is a line break
  {"do":"press","id":"btn[8]"}  button ("click" too); btn[N] is function key N
  {"do":"key","key":0}  0 Enter, 3 Back, 4 F4, 8 F8, 11 Save, 12 Cancel, or a name: "Enter", "F4", "Control+S"
  {"do":"select","id":"tabpT\\08"}  tab, radio button, menu entry, list item; with "row": a table or grid row ("value":false deselects)
  {"do":"check","id":"...","value":true}  checkbox
  {"do":"combo","id":"...","key":"PROG"}  dropdown entry, by key or text; without "key": lists the entries
  {"do":"okcode","value":"/nVA03"}  commands go here only: the command field cannot be typed into
  {"do":"f4","id":"..."}  value help
  {"do":"dblclick","id":"..."}  list entry or label
  {"do":"tree","id":"...","node":"<key>","how":"double|select|expand|collapse"}
  {"do":"grid","id":"...","row":0,"col":"VBELN","how":"double|select|cell"}  any row (scrolled to); "select" without "row" selects the column
  {"do":"toolbar","id":"...","button":"<id>"}
  {"do":"scroll","id":"...","to":120}  a row counted from 0, "next", "prev", "first", "last"; a table control's columns "right", "left" (Fiori: when the view ends with SCROLL)
  {"do":"open","app":"#SalesOrder-manage"}  Fiori launchpad only: an app by its intent (parameters allowed), never a URL
Short ids work; an id that names several controls is refused with the list, one from an earlier screen with the screen you are on.
"actions":[...] in place of "action" runs up to ${MAX_BATCH} in order and answers once: what ran, then the screen. Use it for the screen you see: its fields, then the key that sends them. It ends before the next action when one fails, is refused or waits for confirmation, a popup opens, the status bar shows an error or a warning, or the screen changes. An action goes on through what its "expect" names: {"screen":"4001"}, {"popup":true}, {"status":"W"}. "show":true adds the screen after that action (one tab after another).
${writeRule(policy)}`,
      inputSchema: {
        action: actionSchema.optional(),
        actions: z.array(batchSchema).optional().describe("in place of action: several, each as action"),
        session,
        full: z.boolean().optional().describe("answer with the whole screen, not the changes"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ action, actions, session: ref, full }) =>
      answer(async () => {
        if (actions !== undefined && action !== undefined) return fail('Send "action" or "actions", not both.');
        if (actions !== undefined) return runBatch(ref, actions, full === true);
        return run(ref, action, full === true);
      }),
  );

  // Only confirm mode holds actions for a token: with writing off or on, sap_confirm could never run anything.
  if (policy.write === "confirm") server.registerTool(
    "sap_confirm",
    {
      title: "Run a confirmed SAP action",
      description:
        "Runs an action sap_act held, with the token it gave. Call it only after the user said yes to that exact action. Refused when the session, the screen or the action changed. The server cannot see the user's yes: without a client that asks the user itself (MCP elicitation), this confirmation is advisory.",
      inputSchema: { token: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ token }) =>
      answer(async () => {
        const p = pending.get(token.trim());
        // A token works once, whatever the outcome.
        pending.delete(token.trim());
        if (!p || Date.now() - p.at > TOKEN_LIFE_MS) return fail("Unknown or expired token: call sap_act again.");
        return serial(p.shown.session, actionText(p.shown.action), () => runConfirmed(p.shown));
      }),
  );

  server.registerTool(
    "sap_screenshot",
    {
      title: "Screenshot of the SAP session",
      description: "A PNG of the session's window or tab, for what the text view cannot show (charts, HTML panels).",
      inputSchema: { session },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ session: ref }) =>
      answer(async () => {
        const png = await (await registry.driver(ref)).screenshot();
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      }),
  );

  registerRecordTools(server, registry, policy, recorder, serial, (id) => history.get(id) ?? []);
  registerCodeTools(server, registry, policy, recorder, serial);

  return { server, registry, recorder };
}
