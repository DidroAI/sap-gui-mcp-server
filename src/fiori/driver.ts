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
import { type Action, ActionError, type Assessment, type Driver, type LookOptions, type SessionInfo } from "../core/types.js";
import { webguiActInFrame, webguiAssessInFrame, webguiLookInFrame } from "../webgui/index.js";
import { LOGON_REFUSAL } from "../core/words.js";
import { assessAction, keyOf } from "./risk.js";
import { type ControlRequest, type ControlResult, TARGET_ATTR, ui5Control, ui5Idle, ui5Info, type Ui5Info, ui5Logon, ui5Look } from "./ui5.js";

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

const within = <T>(p: Promise<T>, ms: number, otherwise: T): Promise<T> =>
  Promise.race([p.catch(() => otherwise), new Promise<T>((r) => setTimeout(() => r(otherwise), ms))]);

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
      if (!top && (isWebguiUrl(f.url()) || kind === "webgui")) webguiFrames.push(f);
      else if (kind === "ui5") ui5.push(f);
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
      const r = await f.evaluate(ui5Look, { compact: options.compact }).catch((e: Error) => `[frame error] ${e.message.split("\n")[0]}`);
      if (r) parts.push(r);
    }
    if (!ui5.length) parts.push("[SAPUI5 is not running in this tab: a logon page, or the app is still loading]");
    for (const f of wf) {
      const r = await webguiLookInFrame(f, options.compact).catch((e: Error) => `[Web GUI frame error] ${e.message.split("\n")[0]}`);
      if (r) parts.push(`${WEBGUI_MARK} (SAP GUI for HTML inside the launchpad; its ids are SAP GUI scripting ids, its actions those of Web GUI)\n${r.replace(/\s+$/, "")}`);
    }
    return parts.join("\n");
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
    const { ui5, webgui: wf } = await this.frames();
    const frame = await this.toWebgui(action, ui5, wf);
    if (frame) return webguiAssessInFrame(frame, action);
    if (WEBGUI_ONLY.has(action.do)) return { risk: "read", reason: `"${action.do}" needs a Web GUI screen, and none is open in this tab` };
    // The focused control and the open dialog's default button (Enter and Space press them), and the page's language.
    const here = (await this.control({ handle: "", op: "facts" }, ui5))?.result;
    const ctx = { focused: here?.facts, dialogDefault: here?.dialogDefault, language: here?.language };
    if (action.do === "key" || !action.id) return assessAction(action, undefined, ctx);
    const hit = await this.control({ handle: action.id, op: "facts" }, ui5);
    return assessAction(action, hit?.result.facts, { ...ctx, language: hit?.result.language ?? ctx.language });
  }

  // ---- act

  async act(action: Action): Promise<string> {
    await this.refuseLogon();
    const { ui5, webgui: wf } = await this.frames();
    const frame = await this.toWebgui(action, ui5, wf);
    if (frame) {
      const note = await webguiActInFrame(frame, action);
      await this.idle();
      return note;
    }
    if (WEBGUI_ONLY.has(action.do)) throw new ActionError(`"${action.do}" works on SAP GUI screens only; this Fiori tab shows none. Use ids from sap_look with set, press, select, check, combo, key, f4 or scroll.`);
    if (!ui5.length) throw new ActionError("SAPUI5 is not running in this tab (a logon page, or the app is still loading).");

    if (action.do === "key") {
      const k = keyOf(action);
      if (!k) throw new ActionError(`Unknown key ${JSON.stringify(action.key ?? action.value ?? "")}. Fiori keys: Enter, Escape, Tab, Shift+Tab, F4, ArrowDown, ArrowUp, PageDown, PageUp, Home, End, Back, Control+S, Control+Enter (or SAP GUI's 0, 3, 4, 11, 12).`);
      if (k.name === "back") await this.page.mainFrame().evaluate(() => history.back());
      else await this.page.keyboard.press(k.press);
      return `key ${k.press}; ${await this.idle()}`;
    }

    const op = OPS[action.do];
    if (!op) throw new ActionError(`Unknown action "${action.do}" for Fiori. Use set, press (or click), dblclick, select, check, combo, key, f4 or scroll.`);
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
    const target = f.locator(`[${TARGET_ATTR}]`).first();
    const unmark = () => f.evaluate((attr) => document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr)), TARGET_ATTR).catch(() => {});
    try {
      switch (r.status) {
        case "DONE":
          break;
        case "TARGET":
          if (op === "fill") {
            await target.fill(action.value == null ? "" : String(action.value), { timeout: 8000 });
            // Tab leaves the field, which is when UI5 takes the value; a search field searches on Enter.
            await target.press(r.enter || action.enter === true ? "Enter" : "Tab", { timeout: 8000 });
          } else if (op === "dblclick") await target.dblclick({ timeout: 8000 });
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
            await f
              .getByRole("option", { name: String(value ?? ""), exact: false })
              .first()
              .click({ timeout: 8000 });
          }
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
    return `${action.do} ${r.note}; ${await this.idle()}`;
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
