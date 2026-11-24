/**
 * The scripting API: one SAP session, driven from code.
 *
 *   import { connect } from "sap-ui-automation";
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
import { checkedList, commandFieldRefusal, decide, leavesTransaction, type Policy, policyFromEnv, sessionRefusal, type WriteMode } from "../core/guard.js";
import { Registry } from "../core/registry.js";
import { type Action, ActionError, type Assessment, type Driver, type SessionInfo, type Surface, type SurfaceName } from "../core/types.js";
import { Recorder } from "../record/recorder.js";
import { detour, popupOf } from "../record/replay.js";
import { type ParsedScreen, parseScreen, readSettled } from "../record/screen.js";
import { codeOf, draftTest } from "./code.js";
import { callSite, type Performed, Verifier, type VerifyHost, type VerifyOptions } from "./verify.js";
import { ButtonLocator, ControlLocator, GridLocator, type StatusState, StatusLocator } from "./locators.js";

/** Where `sap.at` asks the session to be: "SAPLATP4/0500", "SAPLATP4", or the parts by name. */
export type Place = string | { program?: string; screen?: string; transaction?: string };

/** Dynpro numbers compare as numbers: "500" is "0500". */
const sameNumber = (a: string, b: string) => a.replace(/^0+(?=\d)/, "") === b.replace(/^0+(?=\d)/, "");

/** Does the screen stand where `place` says? Only the parts given are compared. */
export function isAt(screen: ParsedScreen, place: Place): boolean {
  const [program = "", dynpro = ""] = typeof place === "string" ? place.split("/") : [];
  const p: { program?: string | undefined; screen?: string | undefined; transaction?: string | undefined } = typeof place === "string" ? { program, screen: dynpro } : place;
  if (p.program && (screen.program ?? "").toUpperCase() !== p.program.toUpperCase()) return false;
  if (p.screen && !sameNumber(screen.screen ?? "", p.screen)) return false;
  if (p.transaction && (screen.transaction ?? "").toUpperCase() !== p.transaction.toUpperCase()) return false;
  return !!(p.program || p.screen || p.transaction);
}

/** Errors already named with their step: an error that leaves nested steps is named once, by the innermost. */
const named = new WeakSet<object>();

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
  /**
   * Verified mode (sdk/verify.ts): each action is compared with the lock file
   * and throws `Drift` where SAP answers otherwise; a passing run (`sap.lock.finish(true)`,
   * which the runner calls) adds what the lock does not have yet.
   */
  verify?: VerifyOptions;
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
  /** The `sap.step` block it ran in. */
  step?: string;
}

const SURFACES: SurfaceName[] = ["sapgui", "webgui", "fiori"];

/** The policy of a script: the environment's, with what the options say on top. */
export function policyOf(o: ConnectOptions): Policy {
  const base = policyFromEnv(o.env ?? process.env);
  const up = (l: string[] | undefined) => l?.map((s) => s.trim().toUpperCase()).filter(Boolean);
  return {
    write: o.write ?? base.write,
    allowLogoff: o.allowLogoff ?? base.allowLogoff ?? false,
    allowSystems: checkedList("allowSystems", up(o.allowSystems) ?? base.allowSystems, "system"),
    allowTcodes: checkedList("allowTcodes", up(o.allowTcodes) ?? base.allowTcodes),
    blockTcodes: checkedList("blockTcodes", up(o.blockTcodes) ?? base.blockTcodes),
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
  private verifier: Verifier | undefined;

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
      this.recorder = new Recorder({ dir: t.dir, auto: false, by: `sap-ui-automation sdk ${SDK_VERSION}`, trace: { screens: true, screenshots: t.screenshots ?? false } });
      await this.recorder.start(driver, info, t.name, undefined, true);
    }
    if (this.options.verify) await this.useLock(this.options.verify);
  }

  /** Turns verified mode on (or off with undefined) from the next action on; a Verifier puts back one that was on. */
  async useLock(options: VerifyOptions | Verifier | undefined): Promise<Verifier | undefined> {
    if (options instanceof Verifier) return (this.verifier = options);
    this.verifier = options && options.mode !== "off" ? await Verifier.open(options, this.info ?? (await this.registry.session(this.sessionId)).info, this.host) : undefined;
    // Blocks already open count from here.
    if (this.verifier && this.stepName) this.verifier.enter(this.stepName);
    return this.verifier;
  }

  /** The verifier of verified mode, when it is on: what was verified, repaired, and `finish(passed)`. */
  get lock(): Verifier | undefined {
    return this.verifier;
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
    await this.checkpoint();
    const d = await this.driver();
    return d.look({ compact: !options.full, ...(options.id ? { id: options.id } : {}), ...(options.rows ? { rows: options.rows } : {}), ...(options.cols ? { cols: options.cols } : {}) });
  }

  /** The screen parsed: transaction, program, screen, title, status bar and every control (full view). */
  async screen(): Promise<ParsedScreen> {
    await this.checkpoint();
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
    if (!this.verifier) return (await this.perform(action)).note;
    // Before any await: the stack still holds the test's line.
    const site = callSite();
    return this.verifier.act(action, site);
  }

  /** What the verifier runs actions and reads screens with. */
  private readonly host: VerifyHost = {
    perform: (a, rated) => this.perform(a, rated),
    screen: async () => readSettled(async () => (await this.driver()).look({ compact: false })),
    look: async () => (await this.driver()).look({ compact: true }),
    driver: () => this.driver(),
  };

  /** Reads that branch on the screen (sap.at, popup, exists...): nested count. */
  private asking = 0;

  /**
   * Before a read, in verified mode: a read that asks about the screen
   * accepts an action that led elsewhere as a branch; any other read
   * settles it as drift (verify.ts).
   */
  private async checkpoint(): Promise<void> {
    if (!this.verifier) return;
    if (this.asking) this.verifier.branch();
    else await this.verifier.settle();
  }

  /** Runs `f` as a question about the screen, which the code branches on (see `checkpoint`). */
  async asks<T>(f: () => Promise<T>): Promise<T> {
    this.asking++;
    try {
      return await f();
    } finally {
      this.asking--;
    }
  }

  /** One action through the guard, the driver and the trace; no lock. `rated`: a repair's own rating of it. */
  private async perform(action: NormalizedAction, rated?: Assessment): Promise<Performed> {
    const field = commandFieldRefusal(action);
    if (field) throw new Refused(field);
    const { driver, info } = await this.registry.session(this.sessionId);
    this.driverInfo = info;
    const here = sessionRefusal(this.policy, info);
    if (here && !leavesTransaction(this.policy, action)) throw new Refused(`this session is in a transaction scripts may not work in: ${here}`);
    if (action.do === "open" && info.surface !== "fiori") throw new ActionError('open works in a Fiori launchpad tab only; elsewhere use okcode("/n<transaction>").');
    const assessment = rated ?? (await driver.assess(action));
    await this.allowed(action, assessment, info);
    const t0 = Date.now();
    const run = () => driver.act(action);
    if (this.recorder) this.recorder.last = undefined;
    const note = this.recorder ? await this.recorder.act(driver, action, assessment.risk, run) : await run();
    const seen = this.recorder?.last;
    const ms = Date.now() - t0;
    // A menu entry or a tree node can open a transaction no okcode named.
    const after = await driver.refresh().catch(() => undefined);
    if (after) this.driverInfo = after;
    const landed = after && sessionRefusal(this.policy, after);
    if (landed) {
      await driver.act(normalizeAction({ do: "okcode", value: "/n" })).catch(() => {});
      throw new Refused(`${note}: this led to a transaction scripts may not work in (${landed}); left it with /n.`);
    }
    this.history.push({ action, code: codeOf(action), note, ms, ...(this.stepName ? { step: this.stepName } : {}) });
    return { note, risk: assessment.risk, before: seen?.before, after: seen?.after };
  }

  // ---- steps and screens SAP shows for some data only ----------------------------

  private stepName: string | undefined;

  /** The `sap.step` block that runs now (nested ones joined with " › "). */
  get currentStep(): string | undefined {
    return this.stepName;
  }

  /**
   * Runs `fn` as one named step: the actions it runs carry the name in the
   * trace (`group` of each recorded step), and an error thrown inside it says
   * `(in step "name")`. Returns what `fn` returns.
   *
   *   const order = await sap.step("Save the order", async () => {
   *     await sap.save({ acceptWarnings: true });
   *     return await expect(sap.status()).capture(/Order (\d+)/);
   *   });
   */
  async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const outer = this.stepName;
    const full = outer ? `${outer} › ${name}` : name;
    this.stepName = full;
    if (this.recorder) this.recorder.group = full;
    this.verifier?.enter(full);
    try {
      return await fn();
    } catch (e) {
      // A drift names its own step (it may be settled in a later one).
      if (e instanceof Error && !named.has(e) && e.name !== "Drift") {
        named.add(e);
        e.message = `${e.message} (in step "${full}")`;
      }
      throw e;
    } finally {
      this.verifier?.exit();
      this.stepName = outer;
      if (this.recorder) this.recorder.group = outer;
    }
  }

  /** Is the session on this screen now? `sap.at("SAPLATP4/0500")`, `sap.at({ transaction: "VA01" })`. Reads once, never waits. */
  async at(place: Place): Promise<boolean> {
    return this.asks(async () => isAt(await this.screen(), place));
  }

  /** The popup in front, if one is open: its title and text. */
  async popup(): Promise<{ title: string; text: string } | undefined> {
    const s = await this.asks(() => this.screen());
    const p = popupOf(s);
    if (!p) return undefined;
    const text = s.controls
      .filter((c) => c.window === p.id && (c.type === "label" || (c.type === "field" && /\(read-only\)/.test(c.rest))))
      .map((c) => (c.type === "field" ? c.value : c.label || c.rest))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { title: p.title, text };
  }

  /** A button by its label ("Continue", "Save"): in the popup in front first. Refuses a label several buttons have. */
  button(label: string): ButtonLocator {
    return new ButtonLocator(this, label);
  }

  /**
   * Saves (key 11, through the guard: refused unless writes are allowed).
   * With `acceptWarnings`, while SAP answers with a warning (W) in the status
   * bar, presses Enter, as a user acknowledges it, at most `max` times (3);
   * a warning still there after that throws. Returns the status bar.
   */
  async save(options: { acceptWarnings?: boolean; max?: number } = {}): Promise<StatusState> {
    await this.key(11);
    // With acceptWarnings, a warning is a branch the code expects.
    const read = () => (options.acceptWarnings ? this.asks(() => this.status().state()) : this.status().state());
    let st = await read();
    const max = options.max ?? 3;
    for (let i = 0; options.acceptWarnings && st.type === "W" && i < max; i++) {
      await this.key(0);
      st = await read();
    }
    if (options.acceptWarnings && st.type === "W") throw new Error(`save: SAP still answers with a warning after ${max} Enter: ${st.text}`);
    return st;
  }

  /**
   * Confirms the popup in front when it only informs (text and a Continue,
   * no question, no input: the rule a replay uses, record/replay.ts `detour`).
   * True when it confirmed one; false, pressing nothing, when there is no
   * popup or it asks something.
   */
  async dismissInfo(): Promise<boolean> {
    const s = await this.asks(() => this.screen());
    if (!popupOf(s)) return false;
    const d = detour(s);
    if (d?.kind !== "pass" || !d.action) return false;
    await this.act(d.action);
    return true;
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
