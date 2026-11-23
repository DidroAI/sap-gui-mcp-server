/**
 * The Fiori driver: one Chrome tab where SAPUI5 runs (a launchpad or a
 * stand-alone app), read and driven through the UI5 controls.
 *
 * - look: the UI5 reader in every frame with UI5; a Web GUI app the launchpad
 *   shows in an iframe is read by the Web GUI reader and added below a
 *   `WEBGUI FRAME` line.
 * - act: the control is found by its UI5 id, then clicked or typed into with
 *   real input events on its DOM element; only dropdown entries and scrolling
 *   go through the control's API. An id that no UI5 frame knows goes to the
 *   Web GUI frame.
 * - idle: UI5's own state (see ui5Idle), after every action and before a look.
 */
import type { Frame, Page } from "playwright-core";
import type { ChromeTab } from "../browser/chrome.js";
import { ONE_LINE_NOTE, oneLine } from "../core/action.js";
import { type Action, ActionError, type Assessment, type Driver, type LookOptions, type SessionInfo } from "../core/types.js";
import { webguiActInFrame, webguiAssessInFrame, webguiLookInFrame } from "../webgui/index.js";
import { LOGON_REFUSAL } from "../core/words.js";
import { assessAction, intentOf, keyOf } from "./risk.js";
import { type ControlRequest, type ControlResult, TARGET_ATTR, ui5Back, ui5Control, ui5Draft, ui5Idle, ui5Info, type Ui5Info, ui5Logon, ui5Look, ui5Open } from "./ui5.js";

export const WEBGUI_MARK = "WEBGUI FRAME";
const WEBGUI_URL = /\/sap\/bc\/gui\/sap\/its\//i;
const LAUNCHPAD_URL = /\/sap\/bc\/ui2\/flp|\/ui#|\/ui\?|cp\.portal|launchpad/i;
/** Actions only SAP GUI screens have: they go to the Web GUI frame. */
const WEBGUI_ONLY = new Set(["okcode", "tree", "grid", "toolbar"]);
/** Shared action names -> what the UI5 reader does with the control. */
const OPS: Record<string, ControlRequest["op"]> = {
  set: "fill",
  fill: "fill",
  press: "click",
  click: "click",
  dblclick: "dblclick",
  double: "dblclick",
  select: "select",
  check: "check",
  combo: "combo",
  f4: "f4",
  scroll: "scroll",
};

/** Is this URL a Web GUI page of its own (the Web GUI surface's tab, not ours)? */
export const isWebguiUrl = (url: string) => WEBGUI_URL.test(url);
export const isLaunchpadUrl = (url: string) => LAUNCHPAD_URL.test(url);

const KEY_HELP = "Fiori keys: Enter, Space, Escape, Tab, Shift+Tab, F4, Delete, Backspace, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, PageDown, PageUp, Home, End, Back, Control+S, Control+Enter (or SAP GUI's 0, 3, 4, 11, 12).";
const unknownKey = (action: Action) => new ActionError(`Unknown key ${JSON.stringify(action.key ?? action.value ?? "")}. ${KEY_HELP}`);
const OPEN_HELP = 'open takes the intent of a launchpad app, e.g. {"do":"open","app":"#SalesOrder-manage"} (parameters allowed: "#SalesOrder-display?SalesOrder=4711"); never a URL: the tab stays on its launchpad.';

/** A control whose press leaves the page: the launchpad's back and home buttons. */
const LEAVES_PAGE = /(?:^|[-:])(backBtn|homeBtn|shell-header-logo)$/;

/** What an answer says after the agent left a draft (see ui5Draft): the draft stays, and so does its lock. */
export function leftDraftNote(before: { title: string; hash: string } | null, after: { title: string; hash: string } | null): string {
  if (!before || (after && after.hash === before.hash)) return "";
  return `\nNOTE the page you left was a draft${before.title ? ` ("${before.title}")` : ""}: it stays on the server and keeps the document locked for other users. To remove it, open the document again and press "Discard Draft".`;
}

/** The launchpad's home page, as an intent. */
export const HOME_INTENT = "#Shell-home";

/**
 * The launchpad intent an okcode means in a Fiori tab, or undefined. Agents
 * send SAP GUI's command for an app: "#Material-transferStock",
 * "/nPurchaseOrder-manage", "/n#PurchaseOrder-manage" (42 refusals in one
 * benchmark), and "/n" for "leave to the start", which here is the home page.
 */
export function fioriIntentOfOkcode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (/^\/n$/i.test(v)) return HOME_INTENT;
  const m = /^(?:\/n\s*)?(#?[A-Za-z0-9_]+-[A-Za-z0-9_].*)$/i.exec(v);
  if (!m || !(v.startsWith("#") || /^\/n/i.test(v))) return undefined;
  return intentOf(m[1]);
}

/** What SAP GUI's grid action means on a Fiori table: a row selected, or a row pressed (opened). */
export function fioriGridOp(action: Action): "select" | "press" | undefined {
  if (action.do !== "grid" || typeof action.row !== "number") return undefined;
  const how = String(action.how ?? "select").toLowerCase();
  if (how === "select") return "select";
  if (how === "double" || how === "dblclick" || how === "open" || how === "press" || how === "click") return "press";
  return undefined;
}

/** The answer of `ui5RowOf`: the row's id, or why there is none. */
type RowOf = { id: string } | { why: string } | null;

/**
 * In the page: the id of row `row` (counted from 0) of a UI5 table or list,
 * found by the table's id from the view; null when no control of this frame
 * has that id. Runs in the browser: it uses nothing from outside itself.
 */
export function ui5RowOf(a: { handle: string; row: number }): RowOf {
  // biome-ignore lint/suspicious/noExplicitAny: UI5 objects in the page
  type U = any;
  const sap = (window as U).sap;
  if (!sap?.ui?.getCore) return null;
  const El = sap.ui.require?.("sap/ui/core/Element") ?? sap.ui.core?.Element;
  const reg = El?.registry ?? sap.ui.getCore().mElements;
  const all: U[] = reg?.all ? Object.values(reg.all()) : Object.values(reg ?? {});
  const h = String(a.handle ?? "")
    .replace(/^#/, "")
    .replace(/^id=/, "");
  let c: U = all.find((x) => x.getId() === h);
  if (!c) {
    const hits = all.filter((x) => {
      const id: string = x.getId();
      return id.endsWith(`--${h}`) || id.endsWith(`::${h}`);
    });
    const vis = hits.filter((x) => x.getDomRef?.()?.getBoundingClientRect?.().width > 0);
    c = (vis.length ? vis : hits)[0];
  }
  if (!c) return null;
  // A smart or an mdc table wraps the table that holds the rows.
  for (let i = 0; i < 3 && c && !c.getItems && !c.getRows; i++) c = c.getTable?.() ?? c._oTable;
  if (!c) return { why: `${h} is not a table or a list` };
  if (typeof c.getItems === "function") {
    const items: U[] = c.getItems().filter((x: U) => !x.isA?.("sap.m.GroupHeaderListItem"));
    const it = items[a.row];
    return it ? { id: it.getId() } : { why: `${h} has ${items.length} rows loaded; row ${a.row} is not among them` };
  }
  if (typeof c.getRows === "function") {
    const first: number = c.getFirstVisibleRow?.() ?? 0;
    const rows: U[] = c.getRows();
    const r = rows[a.row - first];
    if (!r || !r.getBindingContext?.()) return { why: `row ${a.row} of ${h} is not on screen (rows ${first} to ${first + rows.length - 1} are): scroll to it first` };
    return { id: r.getId() };
  }
  return { why: `${h} is not a table or a list` };
}

/** SAP's user defaults as codes (USR01-DCPFM, USR01-DATFM) as a notation; undefined when neither is known. */
export function notationOfCodes(num: string | null, date: string | null): { sign?: "," | "."; spaced?: boolean; date?: string } | undefined {
  const out: { sign?: "," | "."; spaced?: boolean; date?: string } = {};
  if (num === " ") out.sign = ",";
  else if (num?.toUpperCase() === "X") out.sign = ".";
  else if (num?.toUpperCase() === "Y") {
    out.sign = ",";
    out.spaced = true;
  }
  const d = ({ "1": "DD.MM.YYYY", "2": "MM/DD/YYYY", "3": "MM-DD-YYYY", "4": "YYYY.MM.DD", "5": "YYYY/MM/DD", "6": "YYYY-MM-DD" } as Record<string, string>)[date ?? ""];
  if (d) out.date = d;
  return out.sign || out.date ? out : undefined;
}

const within = <T>(p: Promise<T>, ms: number, otherwise: T): Promise<T> =>
  Promise.race([p.catch(() => otherwise), new Promise<T>((r) => setTimeout(() => r(otherwise), ms))]);

/** Is the iframe of this frame drawn (not hidden by the launchpad, not of zero size)? A frame that cannot say counts as shown. */
export async function frameShown(f: Pick<Frame, "frameElement">): Promise<boolean> {
  const ask = async () => {
    const el = await f.frameElement();
    return el.evaluate((node) => {
      const e = node as Element;
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
    });
  };
  return within(Promise.resolve().then(ask), 3000, true);
}

/** What the top frame knows about itself; never throws, never waits long. */
export async function pageInfo(page: Page): Promise<Ui5Info> {
  const none: Ui5Info = { ui5: false, launchpad: false, title: "", sources: {} };
  return within(page.mainFrame().evaluate(ui5Info), 8000, none);
}

/** The session line of a tab, from what the page says and its URL. */
export function sessionOf(tab: { id: string; title: string; url: string }, n: number, i: Ui5Info): SessionInfo {
  const s: SessionInfo = { id: `chrome:${tab.id}`, surface: "fiori", where: `Chrome tab ${n}`, title: i.title || tab.title };
  let client = i.client;
  try {
    const u = new URL(tab.url);
    s.url = `${u.origin}${u.pathname}`;
    client ??= u.searchParams.get("sap-client") ?? undefined;
  } catch {
    /* not a URL we can parse */
  }
  if (i.system) s.system = i.system;
  if (client) s.client = client;
  if (i.user) s.user = i.user;
  const app = i.intent ?? i.appId;
  if (app) s.transaction = app;
  return s;
}

export const FIORI_LOGGED_OFF =
  "This launchpad tab is not logged on to SAP any more (the logon expired or was closed): SAP answers its requests with a logon (HTTP 401), so the app waits for data that will not come. Nothing more can be done in this tab until the user logs on again (reload the tab); input that was not saved is lost. Tell the user; do not retry.";

/**
 * Is this tab still logged on to SAP? One request the launchpad itself makes at start, with the tab's cookies.
 * It goes through Playwright's request API, not the page: SAP answers an expired logon with 401 and a Basic
 * challenge, and in the page the browser holds that request for a password prompt nobody sees (live
 * 2026-11-20: that is also why the app's own requests never came back). "expired": SAP or the identity
 * provider answered with a logon (401, 403, a redirect elsewhere, a logon form); "unknown": no answer in 5 s,
 * or the path is not there (another launchpad). Never claims more than it saw.
 * The request names the tab's client (its URL's sap-client, else `client`): without it SAP takes the client from
 * the sap-usercontext cookie, which is per host, not per port, so another SAP system on the same host can have
 * set it to another client, where this logon does not exist (live 2026-11-21: ECC client 800 on localhost:8010
 * made a logged-on S/4 tab on localhost:44300 read as expired).
 */
export async function logonState(page: Page, client?: string): Promise<"ok" | "expired" | "unknown"> {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return "unknown";
  }
  const origin = url.origin;
  if (!/^https?:/.test(origin)) return "unknown";
  const mandt = url.searchParams.get("sap-client") ?? client;
  const q = /^\d{3}$/.test(mandt ?? "") ? `&sap-client=${mandt}` : "";
  try {
    const r = await page.context().request.get(`${origin}/sap/bc/ui2/start_up?shellType=FLP&depth=0${q}`, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      timeout: 5000,
      maxRedirects: 0,
      failOnStatusCode: false,
      ignoreHTTPSErrors: true,
    });
    const status = r.status();
    if (status === 401 || status === 403) return "expired";
    const to = r.headers().location;
    if (status >= 300 && status < 400 && to) return new URL(to, origin).origin !== origin || /logon|login|saml/i.test(to) ? "expired" : "unknown";
    const type = r.headers()["content-type"] ?? "";
    if (r.ok() && type.includes("json")) return "ok";
    if (r.ok() && type.includes("html") && /<form[^>]*(logon|login)|name="(sap-user|j_username)"/i.test(await r.text())) return "expired";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export interface FioriOptions {
  /** Use RecordReplay.waitForUI5 to know when the page is idle (default), or only UI5's busy state. */
  recordReplay: boolean;
  idleTimeoutMs: number;
}

export class FioriDriver implements Driver {
  info: SessionInfo;
  private page: Page;
  private recordReplay: boolean;
  /** waitForUI5 timed out while the page showed no busy sign, this many times in a row. */
  private rrMisses = 0;
  /** When the last idle wait ended. */
  private idleAt = 0;

  constructor(
    private tab: ChromeTab,
    info: SessionInfo,
    private n: number,
    private options: FioriOptions,
  ) {
    this.info = info;
    this.page = tab.page;
    this.recordReplay = options.recordReplay;
  }

  async refresh(): Promise<SessionInfo> {
    this.info = sessionOf({ id: this.tab.id, title: await this.page.title().catch(() => this.tab.title), url: this.page.url() }, this.n, await pageInfo(this.page));
    return this.info;
  }

  // ---- frames

  private async frames(): Promise<{ ui5: Frame[]; webgui: Frame[] }> {
    const ui5: Frame[] = [];
    const webguiFrames: Frame[] = [];
    for (const f of this.page.frames()) {
      if (f.isDetached()) continue;
      const top = f === this.page.mainFrame();
      const kind = await within(
        f.evaluate(() => {
          const w = window as unknown as { sap?: { ui?: { getCore?: unknown } } };
          return w.sap?.ui?.getCore ? "ui5" : document.querySelector("[lsdata]") ? "webgui" : "";
        }),
        5000,
        "",
      );
      if (!top && (isWebguiUrl(f.url()) || kind === "webgui")) {
        // The launchpad keeps the frame of a Web GUI app it left, hidden: that screen is not on screen, and no key may go to it.
        if (await frameShown(f)) webguiFrames.push(f);
      } else if (kind === "ui5") ui5.push(f);
    }
    return { ui5, webgui: webguiFrames };
  }

  // ---- idle

  /** Waits until every UI5 frame is idle and frames that are loading have loaded. */
  private async idle(timeoutMs = this.options.idleTimeoutMs): Promise<string> {
    const t0 = Date.now();
    let note = "";
    for (let round = 0; round < 3; round++) {
      // A click may have started a page load (logon, a reload): let the new document come up.
      await this.page.waitForLoadState("domcontentloaded", { timeout: Math.max(1000, timeoutMs - (Date.now() - t0)) }).catch(() => {});
      const before = this.page.frames().length;
      for (const f of this.page.frames()) {
        if (f.isDetached()) continue;
        const left = Math.max(1500, timeoutMs - (Date.now() - t0));
        const r = await f.evaluate(ui5Idle, { timeoutMs: left, recordReplay: this.recordReplay }).catch((e: Error) => `frame changed (${e.message.split("\n")[0]?.slice(0, 60)})`);
        if (r === "no UI5") {
          if (f !== this.page.mainFrame()) await f.waitForLoadState("load", { timeout: Math.min(left, 20_000) }).catch(() => {});
          continue;
        }
        note = r;
        if (/waitForUI5 timed out/.test(r) && r.startsWith("idle")) {
          // The autowaiter saw work the page never finishes (a poll, a socket): after two such waits, trust the busy state alone.
          if (++this.rrMisses >= 2) this.recordReplay = false;
        } else if (r.startsWith("idle")) this.rrMisses = 0;
      }
      // Animations (a dialog opening, a page sliding in) end a moment after the model settles.
      await this.page.waitForTimeout(300);
      if (!note.startsWith("frame changed") && this.page.frames().length === before) break;
    }
    this.idleAt = Date.now();
    // A launchpad whose logon expired looks busy: its OData requests never come back (live 2026-11-20, an agent
    // spent 5 minutes on it). When a wait ran out, SAP is asked once whether this tab is still logged on.
    if (/^busy:|waitForUI5 timed out/.test(note) && (await logonState(this.page, this.info.client)) === "expired") throw new ActionError(FIORI_LOGGED_OFF);
    return note || "no UI5";
  }

  // ---- look

  async look(options: LookOptions): Promise<string> {
    // Right after an action the page was already waited for.
    if (Date.now() - this.idleAt > 800) await this.idle(Math.min(this.options.idleTimeoutMs, 15_000));
    const info = await this.refresh();
    const { ui5, webgui: wf } = await this.frames();
    const head = [
      "FIORI",
      info.transaction ?? "",
      info.system ? `system ${info.system}${info.client ? `/${info.client}` : ""}` : info.client ? `client ${info.client}` : "",
      info.user ? `user ${info.user}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    const parts: string[] = [head];
    for (const f of ui5) {
      const r = await f
        .evaluate(ui5Look, { compact: options.compact, ...(options.id ? { id: options.id } : {}), ...(options.id && options.rows ? { rows: options.rows } : {}), ...(options.id && options.cols?.length ? { cols: options.cols } : {}) })
        .catch((e: Error) => `[frame error] ${e.message.split("\n")[0]}`);
      if (r) parts.push(r);
    }
    if (options.id) {
      // One control: its lines only, also the part of it below the fold.
      if (parts.length === 1) throw new ActionError(`No control "${options.id}" on this Fiori screen (a control of a Web GUI app inside the launchpad is read with the whole screen). Take the id from sap_look: the text after # in the compact view.`);
      return parts.join("\n");
    }
    if (!ui5.length) {
      if ((await logonState(this.page, this.info.client)) === "expired") throw new ActionError(FIORI_LOGGED_OFF);
      parts.push("[SAPUI5 is not running in this tab: a logon page, or the app is still loading]");
    }
    for (const f of wf) {
      const r = await webguiLookInFrame(f, options.compact).catch((e: Error) => `[Web GUI frame error] ${e.message.split("\n")[0]}`);
      if (r) parts.push(`${WEBGUI_MARK} (SAP GUI for HTML inside the launchpad; its ids are SAP GUI scripting ids, its actions those of Web GUI)\n${r.replace(/\s+$/, "")}`);
    }
    return parts.join("\n");
  }

  /** The draft the page on screen is, if it is one (see ui5Draft); null when it is not or the page does not say. */
  private async draft(): Promise<{ title: string; hash: string } | null> {
    return within(this.page.mainFrame().evaluate(ui5Draft), 3000, null);
  }

  // ---- routing

  /** Runs the in-page control function in each UI5 frame until one knows the id. */
  private async control(req: ControlRequest, ui5: Frame[]): Promise<{ frame: Frame; result: ControlResult } | undefined> {
    let miss: { frame: Frame; result: ControlResult } | undefined;
    for (const f of ui5) {
      const result = await f.evaluate(ui5Control, req).catch((e: Error): ControlResult => ({ status: "NOUI5", note: e.message.split("\n")[0] ?? "" }));
      if (result.status === "NOUI5" || result.status === "NOTFOUND") continue;
      // A request without an id (the focused control, the page's scroll area) is answered by every frame: take the first that did something.
      if (!req.handle && result.status === "FACTS" && !result.facts && !result.dialogDefault) {
        miss ??= { frame: f, result };
        continue;
      }
      return { frame: f, result };
    }
    return miss;
  }

  /** Does this action belong to the Web GUI frame? Keys and id-less actions do when it is the app on screen and no UI5 popup covers it. */
  private async toWebgui(action: Action, ui5: Frame[], wf: Frame[]): Promise<Frame | undefined> {
    const frame = wf[0];
    if (!frame) return undefined;
    if (WEBGUI_ONLY.has(action.do)) return frame;
    if (action.id) return (await this.control({ handle: action.id, op: "facts" }, ui5)) ? undefined : frame;
    if (action.do === "scroll") return undefined;
    const popup = await within(
      this.page.mainFrame().evaluate(() => Array.from(document.querySelectorAll(".sapMDialog, .sapMPopover")).some((e) => (e as HTMLElement).offsetWidth > 0)),
      3000,
      false,
    );
    return popup ? undefined : frame;
  }

  /** Is the tab on a logon page? Every frame is asked: a launchpad can show the logon of another system in a frame. A frame that does not answer in time is not one. */
  private async onLogon(): Promise<boolean> {
    for (const f of this.page.frames()) {
      if (f.isDetached()) continue;
      if (await within(f.evaluate(ui5Logon), 3000, false)) return true;
    }
    return false;
  }

  /** This server never acts on a logon page: not a key, not a click. */
  private async refuseLogon(): Promise<void> {
    if (await this.onLogon()) throw new ActionError(LOGON_REFUSAL);
  }

  async assess(action: Action): Promise<Assessment> {
    await this.refuseLogon();
    // Opening an app is the launchpad's, whatever app is on screen.
    if (action.do === "open") {
      if (!intentOf(action.app)) throw new ActionError(OPEN_HELP);
      return assessAction(action, undefined);
    }
    const { ui5, webgui: wf } = await this.frames();
    const frame = await this.toWebgui(action, ui5, wf);
    if (frame) return webguiAssessInFrame(frame, action);
    // A key the surface does not have fails here, before the user is asked to confirm it.
    if (action.do === "key" && ui5.length && !keyOf(action)) throw unknownKey(action);
    if (WEBGUI_ONLY.has(action.do)) {
      // An okcode that names an app, a grid row: judged as the Fiori action it becomes.
      const as = await this.inFiori(action, ui5).catch(() => undefined);
      if (as) return this.assess(as.action);
      return { risk: "read", reason: `"${action.do}" needs a Web GUI screen, and none is open in this tab` };
    }
    // The focused control and the open dialog's default button (Enter and Space press them), and the page's language.
    const here = (await this.control({ handle: "", op: "facts" }, ui5))?.result;
    const ctx = { focused: here?.facts, dialogDefault: here?.dialogDefault, language: here?.language };
    if (action.do === "key" || !action.id) return assessAction(action, undefined, ctx);
    const hit = await this.control({ handle: action.id, op: "facts" }, ui5);
    return assessAction(action, hit?.result.facts, { ...ctx, language: hit?.result.language ?? ctx.language });
  }

  /**
   * What an okcode or a grid action means in a tab with no Web GUI screen:
   * "/nPurchaseOrder-manage" opens that app, "/n" the home page; a grid row
   * selected or opened is the row selected or pressed. Undefined when it
   * means nothing here; an ActionError when the row is not there.
   */
  private async inFiori(action: Action, ui5: Frame[]): Promise<{ action: Action; said: string } | undefined> {
    if (action.do === "okcode") {
      const app = fioriIntentOfOkcode(action.value);
      if (!app) return undefined;
      return { action: { do: "open", app }, said: `okcode ${String(action.value)} in a Fiori tab is ${app === HOME_INTENT ? "the launchpad's home page" : `open ${app}`}` };
    }
    const op = fioriGridOp(action);
    if (!op) return undefined;
    for (const f of ui5) {
      const r = await f.evaluate(ui5RowOf, { handle: String(action.id ?? ""), row: action.row as number }).catch((): RowOf => null);
      if (!r) continue;
      if ("why" in r) throw new ActionError(r.why);
      return { action: { do: op, id: r.id }, said: `grid row ${action.row} in a Fiori tab is ${op} on the row` };
    }
    throw new ActionError(`No table "${String(action.id ?? "")}" on this screen. Take the id from sap_look.`);
  }

  // ---- act

  async act(action: Action): Promise<string> {
    await this.refuseLogon();
    // Leaving a draft (Back, the back button, another app) keeps it on the server: the answer says so.
    const leaves = action.do === "open" || (action.do === "key" && keyOf(action)?.name === "back") || ((action.do === "press" || action.do === "click") && LEAVES_PAGE.test(String(action.id ?? "")));
    if (leaves) {
      const before = await this.draft();
      const said = await this.act1(action);
      return before ? `${said}${leftDraftNote(before, await this.draft())}` : said;
    }
    return this.act1(action);
  }

  private async act1(action: Action): Promise<string> {
    if (action.do === "open") return this.open(action);
    const { ui5, webgui: wf } = await this.frames();
    const frame = await this.toWebgui(action, ui5, wf);
    if (frame) {
      const note = await webguiActInFrame(frame, action);
      await this.idle();
      return note;
    }
    if (WEBGUI_ONLY.has(action.do)) {
      const as = await this.inFiori(action, ui5);
      if (as) return `${as.said}; ${await this.act(as.action)}`;
      throw new ActionError(
        `"${action.do}" works on SAP GUI screens only; this Fiori tab shows none. Use ids from sap_look with set, press, select, check, combo, key, f4 or scroll; open an app with {"do":"open","app":"#Object-action"}.`,
      );
    }
    if (!ui5.length) throw new ActionError("SAPUI5 is not running in this tab (a logon page, or the app is still loading).");

    if (action.do === "key") {
      const k = keyOf(action);
      if (!k) throw unknownKey(action);
      if (k.name === "back") return `key Back: ${await this.back()}; ${await this.idle()}`;
      await this.page.keyboard.press(k.press);
      return `key ${k.press}; ${await this.idle()}`;
    }

    const op = OPS[action.do];
    if (!op) throw new ActionError(`Unknown action "${action.do}" for Fiori. Use set, press (or click), dblclick, select, check, combo, key, f4, scroll or open.`);
    const id = action.id ?? "";
    if (!id && op !== "scroll") throw new ActionError(`"${action.do}" needs the id of a control from sap_look.`);
    const value = op === "combo" || (op === "select" && action.value == null) ? (action.key ?? action.value) : action.value;
    // "to" is the shared word for where a scroll goes (SAP GUI, Web GUI); here it means the same as "how".
    const TO: Record<string, string> = { next: "down", prev: "up", first: "top", last: "bottom" };
    const how = action.how ?? (op === "scroll" && typeof action.to === "string" ? TO[action.to] : undefined);
    const req: ControlRequest = { handle: id, op, ...(value !== undefined ? { value } : {}), ...(how ? { how } : {}) };
    const hit = await this.control(req, ui5);
    if (!hit) throw new ActionError(`No control "${id}" on this screen. Take the id from sap_look (the text after # in the compact view).`);
    const { frame: f, result: r } = hit;
    let said = "";
    const target = f.locator(`[${TARGET_ATTR}]`).first();
    const unmark = () => f.evaluate((attr) => document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr)), TARGET_ATTR).catch(() => {});
    try {
      switch (r.status) {
        case "DONE":
          break;
        case "TARGET":
          if (op === "fill") {
            // A text area has lines; an input has one, and the browser would drop the line breaks and join the words.
            const lines = await target.evaluate((e) => e.tagName === "TEXTAREA" || (e as HTMLElement).isContentEditable).catch(() => false);
            const single = oneLine(action.value == null ? "" : String(action.value));
            if (!lines && single.had) said = ` (${ONE_LINE_NOTE})`;
            await target.fill(lines ? String(action.value ?? "") : single.text, { timeout: 8000 });
            // Tab leaves the field, which is when UI5 takes the value; a search field searches on Enter.
            const key = r.enter || action.enter === true ? "Enter" : "Tab";
            try {
              await target.press(key, { timeout: 1500 });
            } catch (e) {
              // UI5 drew the field again while it was filled (a date range that was cleared does), so the
              // element that was marked is gone: the focus is still in the field, and the key goes there.
              if ((await target.count().catch(() => 1)) > 0) throw e;
              await this.page.keyboard.press(key);
            }
          } else if (op === "dblclick" && !r.single) await target.dblclick({ timeout: 8000 });
          else await target.click({ timeout: 8000 });
          break;
        case "TWOSTEP":
          if (op === "f4") {
            await target.focus({ timeout: 8000 });
            await this.page.keyboard.press("F4");
          } else {
            // A dropdown the API cannot set: open it, then pick the entry by its text.
            await target.click({ timeout: 8000 });
            await this.page.waitForTimeout(500);
            // The dropdown's own entries: the list is a popover (tokens of a filter field are "options" too).
            const inList = f.locator(".sapMPopover").filter({ visible: true }).getByRole("option").filter({ visible: true });
            const options = (await inList.count().catch(() => 0)) > 0 ? inList : f.getByRole("option").filter({ visible: true });
            const wanted = String(value ?? "").trim();
            if (!wanted) {
              // No entry named: say what the list holds and choose nothing.
              const texts = (await options.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
              await this.page.keyboard.press("Escape");
              await unmark();
              return `combo ${r.note}: nothing chosen. Entries: ${texts.slice(0, 60).join(" | ") || "(none shown)"}${texts.length > 60 ? ` ... (${texts.length} in all)` : ""}; ${await this.idle()}`;
            }
            const entry = options.filter({ hasText: wanted }).first();
            if (!(await entry.count())) {
              const texts = (await options.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
              await this.page.keyboard.press("Escape");
              throw new ActionError(`no entry "${wanted}" in ${r.note}. Entries: ${texts.slice(0, 60).join(" | ") || "(none shown)"}`);
            }
            await entry.click({ timeout: 8000 });
          }
          break;
        case "FOCUSENTER":
          // A row with no free place to click: Enter on the row is its press.
          await target.focus({ timeout: 8000 });
          await this.page.keyboard.press("Enter");
          break;
        case "NOITEM":
        case "DISABLED":
        case "NOTFIT":
        case "NODOM":
          throw new ActionError(r.note);
        default:
          throw new ActionError(`Could not act on "${id}": ${r.status} ${r.note}`);
      }
    } catch (e) {
      if (e instanceof ActionError) throw e;
      const m = (e as Error).message.split("\n")[0] ?? "";
      throw new ActionError(`Could not ${action.do} "${id}" (${r.note}): ${/Timeout/.test(m) ? "the control is covered, hidden or not ready; look at the screen again (a popup may be open)" : m}`);
    } finally {
      await unmark();
    }
    return `${action.do} ${r.note}${said}; ${await this.idle()}`;
  }

  /** Opens a launchpad app by its intent: the launchpad's own hash, on the page the tab is on. */
  private async open(action: Action): Promise<string> {
    const app = intentOf(action.app);
    if (!app) throw new ActionError(OPEN_HELP);
    const r = await within(this.page.mainFrame().evaluate(ui5Open, app), 8000, "NOANSWER");
    if (r === "NOSHELL") throw new ActionError("open works in a Fiori launchpad tab only; this tab runs no launchpad. In a Web GUI tab use okcode.");
    if (r === "NOANSWER") throw new ActionError("The launchpad did not answer within 8 s, so nothing was opened. Look at the screen, then try again.");
    const note = await this.idle();
    return r === "SAME" ? `open ${app}: this app is already on screen; ${note}` : `open ${app}; ${note}`;
  }

  /** Back, the launchpad's way: its back button; without one, history, but never out of the launchpad. */
  private async back(): Promise<string> {
    const top = this.page.mainFrame();
    const r = await within(top.evaluate(ui5Back, TARGET_ATTR), 5000, "HISTORY");
    if (r === "BUTTON") {
      const target = top.locator(`[${TARGET_ATTR}]`).first();
      try {
        await target.click({ timeout: 5000 });
        return "the launchpad's back button";
      } catch {
        throw new ActionError("Back: the launchpad's back button is covered (a popup may be open); look at the screen again.");
      } finally {
        await top.evaluate((attr) => document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr)), TARGET_ATTR).catch(() => {});
      }
    }
    if (r === "HOME") return "there is no page to go back to in this tab, so the launchpad's home page was opened";
    if (r === "ATHOME") return "this is the launchpad's home page, there is nothing to go back to";
    await top.evaluate(() => history.back());
    return "browser history";
  }

  /**
   * The user's decimal and date notation as the launchpad hands it to UI5
   * from the user's SAP defaults (the "legacy" ABAP formats: number " ", X,
   * Y; date 1-6). Undefined when UI5 was not given them.
   */
  async notation(): Promise<{ sign?: "," | "."; spaced?: boolean; date?: string } | undefined> {
    const r = await within(
      this.page.mainFrame().evaluate(() => {
        type Fmt = { getABAPNumberFormat?: () => unknown; getABAPDateFormat?: () => unknown; getLegacyNumberFormat?: () => unknown; getLegacyDateFormat?: () => unknown };
        const w = window as unknown as { sap?: { ui?: { require?: (n: string) => unknown; getCore?: () => { getConfiguration?: () => { getFormatSettings?: () => Fmt } } } } };
        let num: unknown;
        let date: unknown;
        try {
          const f = w.sap?.ui?.require?.("sap/base/i18n/Formatting") as Fmt | undefined;
          num = f?.getABAPNumberFormat?.();
          date = f?.getABAPDateFormat?.();
        } catch {
          /* an older UI5 */
        }
        try {
          const fs = w.sap?.ui?.getCore?.()?.getConfiguration?.()?.getFormatSettings?.();
          num ??= fs?.getLegacyNumberFormat?.();
          date ??= fs?.getLegacyDateFormat?.();
        } catch {
          /* no UI5 core */
        }
        return { num: typeof num === "string" ? num : null, date: typeof date === "string" ? date : null };
      }),
      3000,
      { num: null as string | null, date: null as string | null },
    );
    return notationOfCodes(r.num, r.date);
  }

  async screenshot(): Promise<Buffer> {
    const shot = () => this.page.screenshot({ type: "png", timeout: 8000 });
    try {
      return await shot();
    } catch {
      // Chrome does not paint a tab in the background: bring it to the front and try once more.
      await this.page.bringToFront();
      return shot();
    }
  }

  /** Nothing to release: the tab and the browser are the user's. */
  async close(): Promise<void> {}
}
