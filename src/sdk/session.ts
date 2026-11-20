/**
 * The scripting API: one SAP session, driven from code.
 *
 *   import { connect } from "sap-gui-mcp-server";
 *   const sap = await connect({ surface: "webgui", system: "ABA" });
 *   await sap.okcode("/nVA03");
 *   await sap.set("VBAK-VBELN", "4711");
 *   await sap.key("Enter");
 *   await expect(sap.field("VBAK-NETWR")).toHaveValue("100.00");
 *   await sap.close();
 *
 * It runs over the same `Registry` and `Driver`s as the MCP server, and every
 * action goes through the same guard (core/guard.ts): with SAP_WRITE=off a
 * save is refused in a script exactly as it is for an agent. A script has
 * nobody to ask, so `write: "confirm"` refuses unless `onConfirm` says yes.
 *
 * Waits: the drivers already wait for SAP after each action (the round trip,
 * busy indicators, a page that redraws). Assertions (`expect`) retry on top
 * of that until their timeout.
 */
import { actionText, normalizeAction, type NormalizedAction } from "../core/action.js";
import { commandFieldRefusal, decide, leavesTransaction, type Policy, policyFromEnv, sessionRefusal, type WriteMode } from "../core/guard.js";
import { Registry } from "../core/registry.js";
import { type Action, ActionError, type Assessment, type Driver, type SessionInfo, type Surface, type SurfaceName } from "../core/types.js";
import { Recorder } from "../record/recorder.js";
import { type ParsedScreen, parseScreen, readSettled } from "../record/screen.js";
import { codeOf, draftTest } from "./code.js";
import { ControlLocator, GridLocator, StatusLocator } from "./locators.js";

export const SDK_VERSION = "0.1.0";

/** The guard said no: the action did not run. */
export class Refused extends Error {
  override name = "Refused";
}

/** What a script is asked to confirm under `write: "confirm"`. */
export interface ConfirmRequest {
  action: NormalizedAction;
  /** Why it may write, e.g. 'button "Save (Ctrl+S)"'. */
  reason: string;
  session: SessionInfo;
}

export interface ConnectOptions {
  /** Which surface(s) to look on. Default: SAP_SURFACES, else every one this machine can serve. */
  surface?: SurfaceName | SurfaceName[];
  /** The system to attach to: "ABA" or "ABA/800". The first session of that system is used. */
  system?: string;
  /** Any session reference `sap_sessions` accepts: a list number, an id, a transaction, part of a title. */
  session?: string;
  /** Actions that may write: refused (default), confirmed by `onConfirm`, or run. Default: SAP_WRITE. */
  write?: WriteMode;
  allowTcodes?: string[];
  blockTcodes?: string[];
  /** Default: SAP_ALLOW_SYSTEMS. */
  allowSystems?: string[];
  allowLogoff?: boolean;
  /** Asked for each action that may write when `write` is "confirm"; no answer is no. */
  onConfirm?: (request: ConfirmRequest) => boolean | Promise<boolean>;
  /** Default timeout of `expect` and `waitFor`, in ms. Default 5000. */
  timeout?: number;
  /**
   * Record the run as a trace (`.saptest.json` with step timings and screens):
   * the directory and the trace's name. The runner sets it for each test.
   */
  trace?: { dir: string; name: string; screenshots?: boolean };
  /** Environment to read defaults from; default process.env. */
  env?: Record<string, string | undefined>;
  /** Surfaces to use instead of the real ones (tests). */
  surfaces?: Surface[];
}

/** One action the script ran: what it was, the line that repeats it, and how long it took. */
export interface Done {
  action: NormalizedAction;
  code: string;
  note: string;
  ms: number;
}

const SURFACES: SurfaceName[] = ["sapgui", "webgui", "fiori"];

/** The policy of a script: the environment's, with what the options say on top. */
export function policyOf(o: ConnectOptions): Policy {
  const base = policyFromEnv(o.env ?? process.env);
  const up = (l: string[] | undefined) => l?.map((s) => s.trim().toUpperCase()).filter(Boolean);
  return {
    write: o.write ?? base.write,
    allowLogoff: o.allowLogoff ?? base.allowLogoff ?? false,
    allowSystems: up(o.allowSystems) ?? base.allowSystems,
    allowTcodes: up(o.allowTcodes) ?? base.allowTcodes,
    blockTcodes: up(o.blockTcodes) ?? base.blockTcodes,
  };
}

async function surfacesOf(o: ConnectOptions): Promise<{ surfaces: Surface[]; ours: boolean }> {
  if (o.surfaces) return { surfaces: o.surfaces, ours: false };
  const env = { ...(o.env ?? process.env) };
  if (o.surface) env.SAP_SURFACES = ([] as SurfaceName[]).concat(o.surface).join(",");
  const { surfacesFromEnv } = await import("../surfaces.js");
  return { surfaces: surfacesFromEnv(env), ours: true };
}

/** Attaches to an SAP session that is open now (it never logs on). */
export async function connect(options: ConnectOptions = {}): Promise<Sap> {
  const policy = policyOf(options);
  const { surfaces, ours } = await surfacesOf(options);
  const registry = new Registry(surfaces, policy);
  const { sessions, errors } = await registry.discover();
  const wanted = options.surface ? ([] as SurfaceName[]).concat(options.surface) : SURFACES;
  const [sys, cl] = (options.system ?? "").toUpperCase().split("/");
  const fits = (s: SessionInfo) => wanted.includes(s.surface) && (!sys || (s.system ?? "").toUpperCase() === sys) && (!cl || (s.client ?? "") === cl);
  let info: SessionInfo | undefined;
  if (options.session) {
    info = registry.resolve(options.session);
    if (info && !fits(info)) info = undefined;
  } else info = sessions.find(fits);
  if (!info) {
    await registry.closeAll();
    const what = [options.surface && `surface ${wanted.join("/")}`, options.system && `system ${options.system}`, options.session && `session "${options.session}"`].filter(Boolean).join(", ");
    const found = sessions.length ? ` Open now: ${sessions.map((s) => `${s.surface} ${s.system ?? "?"}${s.client ? `/${s.client}` : ""} ${s.transaction ?? ""}`.trim()).join("; ")}.` : "";
    throw new Error(`No open SAP session${what ? ` with ${what}` : ""}.${found}${errors.length ? ` Discovery: ${errors.join(" | ")}` : ""}`);
  }
  registry.active = info.id;
  const sap = new Sap(registry, info.id, policy, options, ours);
  await sap.attach();
  return sap;
}

export class Sap {
  /** Every action run so far, in order. */
  readonly history: Done[] = [];
  readonly timeout: number;
  private recorder: Recorder | undefined;
  private driverInfo: SessionInfo | undefined;

  constructor(
    readonly registry: Registry,
    /** The session id this object works on; it never moves to another one by itself. */
    readonly sessionId: string,
    readonly policy: Policy,
    private options: ConnectOptions = {},
    private ownsSurfaces = false,
  ) {
    this.timeout = options.timeout ?? 5000;
  }

  /** Opens the driver and, when asked, starts the trace. */
  async attach(): Promise<void> {
    const { driver, info } = await this.registry.session(this.sessionId);
    this.driverInfo = info;
    const t = this.options.trace;
    if (t) {
      this.recorder = new Recorder({ dir: t.dir, auto: false, by: `sap-gui-mcp-server sdk ${SDK_VERSION}`, trace: { screens: true, screenshots: t.screenshots ?? false } });
      await this.recorder.start(driver, info, t.name, undefined, true);
    }
  }

  /** The session as it was last refreshed: system, client, transaction, title. */
  get info(): SessionInfo {
    return this.driverInfo as SessionInfo;
  }

  /** The trace file, while one is being written. */
  get traceFile(): string | undefined {
    return this.recorder?.file;
  }

  private async driver(): Promise<Driver> {
    const { driver, info } = await this.registry.session(this.sessionId);
    this.driverInfo = info;
    return driver;
  }

  // ---- reading ----------------------------------------------------------------

  /** The screen as text: compact by default (what an agent reads), `full` for every id and column. */
  async look(options: { full?: boolean; id?: string; rows?: { from: number; to: number }; cols?: string[] } = {}): Promise<string> {
    const d = await this.driver();
    return d.look({ compact: !options.full, ...(options.id ? { id: options.id } : {}), ...(options.rows ? { rows: options.rows } : {}), ...(options.cols ? { cols: options.cols } : {}) });
  }

  /** The screen parsed: transaction, program, screen, title, status bar and every control (full view). */
  async screen(): Promise<ParsedScreen> {
    const d = await this.driver();
    return readSettled(() => d.look({ compact: false }));
  }

  /** A PNG of the session's window or tab. */
  async screenshot(): Promise<Buffer> {
    return (await this.driver()).screenshot();
  }

  // ---- locators -----------------------------------------------------------------

  /** A field, checkbox, dropdown, button... by its id (short ids work: "VBAK-VBELN", "ctxtVBAK-VBELN", "btn[8]"). */
  field(id: string): ControlLocator {
    return new ControlLocator(this, id);
  }

  /** Same as `field`, for controls that are not fields. */
  control(id: string): ControlLocator {
    return new ControlLocator(this, id);
  }

  /** A grid (ALV), a table control, a tree or a list. */
  grid(id: string): GridLocator {
    return new GridLocator(this, id);
  }

  /** The status bar. */
  status(): StatusLocator {
    return new StatusLocator(this);
  }

  // ---- acting -------------------------------------------------------------------

  /**
   * Runs one action, as `sap_act` takes it, through the guard. Returns the
   * driver's one-line note. Throws `Refused` when the guard says no, and an
   * `ActionError` when the action cannot run on this screen.
   */
  async act(input: Action): Promise<string> {
    const action = normalizeAction(input);
    const field = commandFieldRefusal(action);
    if (field) throw new Refused(field);
    const { driver, info } = await this.registry.session(this.sessionId);
    this.driverInfo = info;
    const here = sessionRefusal(this.policy, info);
    if (here && !leavesTransaction(this.policy, action)) throw new Refused(`this session is in a transaction scripts may not work in: ${here}`);
    if (action.do === "open" && info.surface !== "fiori") throw new ActionError('open works in a Fiori launchpad tab only; elsewhere use okcode("/n<transaction>").');
    const assessment = await driver.assess(action);
    await this.allowed(action, assessment, info);
    const t0 = Date.now();
    const run = () => driver.act(action);
    const note = this.recorder ? await this.recorder.act(driver, action, assessment.risk, run) : await run();
    const ms = Date.now() - t0;
    // A menu entry or a tree node can open a transaction no okcode named.
    const after = await driver.refresh().catch(() => undefined);
    if (after) this.driverInfo = after;
    const landed = after && sessionRefusal(this.policy, after);
    if (landed) {
      await driver.act(normalizeAction({ do: "okcode", value: "/n" })).catch(() => {});
      throw new Refused(`${note}: this led to a transaction scripts may not work in (${landed}); left it with /n.`);
    }
    this.history.push({ action, code: codeOf(action), note, ms });
    return note;
  }

  private async allowed(action: NormalizedAction, assessment: Assessment, session: SessionInfo): Promise<void> {
    const verdict = decide(this.policy, action, assessment);
    if (verdict.run) return;
    if ("refused" in verdict) throw new Refused(`${actionText(action)}: ${verdict.refused}`);
    const yes = this.options.onConfirm ? await this.options.onConfirm({ action, reason: verdict.confirm, session }) : false;
    if (!yes) throw new Refused(`${actionText(action)} may write to SAP (${verdict.confirm}) and was not confirmed${this.options.onConfirm ? "" : ' (write: "confirm" needs an onConfirm callback in a script)'}.`);
  }

  /** Types a command into the command field: "/nVA03", "/n", "/11". */
  okcode(value: string): Promise<string> {
    return this.act({ do: "okcode", value });
  }
  /** Types into a field; for a grid cell pass `{ row, col }`. */
  set(id: string, value: string | number | boolean, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "set", id, value });
  }
  /** Pushes a button. */
  press(id: string, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "press", id });
  }
  /** Fiori: clicks any control by its UI5 id tail. */
  click(id: string, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "click", id });
  }
  /** A virtual key (0 Enter, 3 Back, 11 Save, 12 Cancel) or a key name ("Enter", "F8", "Control+S"). */
  key(key: number | string): Promise<string> {
    return this.act({ do: "key", key });
  }
  /** Selects a tab, radio button, menu entry or list item; with `{ row }` a row of a table or grid. */
  select(id: string, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "select", id });
  }
  /** Ticks (or with `false` clears) a checkbox. */
  check(id: string, value = true, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "check", id, value });
  }
  /** Picks a dropdown entry by key or shown text. */
  combo(id: string, key: string, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "combo", id, key });
  }
  /** Value help on a field. */
  f4(id: string, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "f4", id });
  }
  /** Double-clicks a list entry or a label. */
  dblclick(id: string, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "dblclick", id });
  }
  /** Puts the cursor on a control. */
  focus(id: string, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "focus", id });
  }
  /** Scrolls a grid, table control, tree or list to a row, or "next", "prev", "first", "last". */
  scroll(id: string, to: number | string, more: Partial<Action> = {}): Promise<string> {
    return this.act({ ...more, do: "scroll", id, to });
  }
  /** Fiori: opens a launchpad app by its intent, e.g. "#SalesOrder-manage". */
  open(app: string): Promise<string> {
    return this.act({ do: "open", app });
  }

  /** Waits until `f` holds on the parsed screen, re-reading it, up to `timeout` ms. */
  async waitFor(f: (screen: ParsedScreen) => boolean, timeout = this.timeout): Promise<ParsedScreen> {
    const until = Date.now() + timeout;
    for (;;) {
      const s = await this.screen();
      if (f(s)) return s;
      if (Date.now() >= until) throw new Error(`waitFor: the condition did not hold within ${timeout} ms (on ${s.transaction ?? "?"} ${s.program ?? ""}/${s.screen ?? ""}).`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** The script so far, one SDK line per action. */
  code(): string[] {
    return this.history.map((h) => h.code);
  }

  /** The actions so far as a whole `*.sap.ts` test. */
  draft(name = "recorded"): string {
    return draftTest({ name, lines: this.code() });
  }

  /** Ends the trace (if any) and lets the session go. SAP is not touched: the session stays open where it is. */
  async close(): Promise<{ trace?: string }> {
    let trace: string | undefined;
    if (this.recorder?.recording) trace = (await this.recorder.stop().catch(() => undefined))?.path;
    await this.registry.closeAll();
    if (this.ownsSurfaces) {
      const { disconnectChrome } = await import("../browser/chrome.js");
      await disconnectChrome().catch(() => {});
    }
    return trace ? { trace } : {};
  }

  /** `await using sap = await connect()` closes it at the end of the block. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export { parseScreen };
