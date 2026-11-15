/**
 * One Web GUI screen in a browser frame, and the waits Web GUI needs.
 *
 * Web GUI answers every action with one POST and shows a "Loading data ..."
 * bar until the new screen is rendered. An action therefore waits for that
 * round trip to start, then for the frame to be quiet.
 */
import type { Frame, Page, Request } from "playwright-core";
import { ActionError } from "../core/types.js";

/** The URL path of SAP GUI for HTML. */
export const WEBGUI_PATH = "/sap/bc/gui/sap/its/webgui";

/**
 * Web GUI shows a "Loading data ..." message bar (#progressText, lsdata state
 * LOADING, icon class lsMessageBar__icon--L) for the whole round trip and
 * removes it when the new screen is rendered.
 */
const BUSY = "#progressText,.lsMessageBar__icon--L,[class*='lsBusyIndicator'],[class*='urBusy'],#ur-loading";

/** How long a round trip may take before the action gives up waiting; an action's own "timeout" replaces it. */
export const IDLE_TIMEOUT_MS = 180_000;
export const MAX_IDLE_TIMEOUT_MS = 600_000;
const QUIET_MS = 300;
/** A background tab gets its input about once a second: the quiet period, and the wait for a request to start, must be longer. */
const QUIET_SLOW_MS = 1300;
const START_SLOW_MS = 2500;
/** How long a click, a focus or a key may wait for its control. */
const ACTION_TIMEOUT_MS = 10_000;

interface Traffic {
  inflight: number;
  /** POST requests started so far: each Web GUI round trip is one POST. */
  posts: number;
  lastChange: number;
  /** The last round trip that failed on the network (the connection to SAP dropped), and when. */
  failed: { at: number; error: string } | undefined;
  /** When each step POST started, by its number: the start of SAP's part of a round trip. */
  postAt: number[];
  /** When the last request ended. */
  lastEnd: number;
  /** The longest pause between one request ending and the next starting, since it was last reset. */
  maxGap: number;
}
const trafficOf = new WeakMap<Page, Traffic>();

/** Is this request made by a Web GUI frame or a frame inside one (an HTML viewer)? */
function fromWebGui(r: Request): boolean {
  try {
    for (let f: Frame | null = r.frame(); f; f = f.parentFrame()) if (f.url().includes(WEBGUI_PATH)) return true;
    return false;
  } catch {
    // Requests without a frame (service workers).
    return r.url().includes(WEBGUI_PATH);
  }
}

/**
 * Does this request carry a step (a key, a button, a command), or only what
 * Web GUI sends on the side? A request is a list of posts. Posts marked
 * `"logic":"ignore"`, and a field's value or the focus on their own, do
 * nothing in SAP: Web GUI sends them when the focus leaves a field that was
 * typed into (its value, its type-ahead). In a tab in front they leave with
 * the step's request; in a background tab they left a second before it, or
 * instead of it, and the wait took them for the round trip.
 *   [{"post":"focus/wnd[1]/usr/ctxtX","logic":"ignore"},{"post":"typeahead/..."}]   on the side
 *   [{"content":"1000","post":"value/wnd[1]/usr/ctxtX"},{"post":"action/304/..."}]  a step
 * A body that cannot be read counts as a step.
 */
export function carriesStep(body: string | null | undefined): boolean {
  if (!body) return true;
  let posts: unknown;
  try {
    posts = JSON.parse(body);
  } catch {
    return true;
  }
  if (!Array.isArray(posts)) return true;
  return posts.some((p) => {
    const post = (p as { post?: unknown } | null)?.post;
    if (typeof post !== "string") return false;
    if ((p as { logic?: unknown }).logic === "ignore") return false;
    return !/^(value\/|focus\/|typea)/.test(post);
  });
}

function valueOnly(r: Request): boolean {
  try {
    return !carriesStep(r.postData());
  } catch {
    return false;
  }
}

/**
 * Counts the page's Web GUI requests, from the first use on. Other frames are
 * left out: a Fiori launchpad around Web GUI keeps a connection open and is
 * never quiet.
 */
function watch(page: Page): Traffic {
  let t = trafficOf.get(page);
  if (t) return t;
  const traffic: Traffic = { inflight: 0, posts: 0, lastChange: Date.now(), failed: undefined, postAt: [], lastEnd: 0, maxGap: 0 };
  t = traffic;
  page.on("request", (r) => {
    if (!fromWebGui(r)) return;
    const now = Date.now();
    if (traffic.inflight === 0 && traffic.lastEnd) traffic.maxGap = Math.max(traffic.maxGap, now - traffic.lastEnd);
    traffic.inflight++;
    if (r.method() === "POST" && !valueOnly(r)) traffic.postAt[traffic.posts++] = now;
    traffic.lastChange = now;
  });
  const done = (r: Request) => {
    if (!fromWebGui(r)) return;
    traffic.inflight = Math.max(0, traffic.inflight - 1);
    traffic.lastChange = Date.now();
    traffic.lastEnd = traffic.lastChange;
  };
  page.on("requestfinished", done);
  page.on("requestfailed", (r) => {
    done(r);
    // A round trip (a POST) that got no answer: the connection is down. A request the page itself
    // cancelled (a navigation) is not a failure.
    const error = r.failure()?.errorText ?? "";
    if (fromWebGui(r) && r.method() === "POST" && error && !/ERR_ABORTED/.test(error)) traffic.failed = { at: Date.now(), error };
  });
  trafficOf.set(page, t);
  return t;
}

/** Pages whose focus emulation was asked for, and how that went. */
const awake = new WeakMap<Page, Promise<boolean>>();

/**
 * Makes a tab behave as the visible, focused one while the server drives it.
 *
 * Chrome gives a tab in the background no animation frames and slows its
 * timers. Web GUI draws and sends on those, so in a background tab a typed
 * command stayed in the command field, a click waited for a page that never
 * settled, and keys did not reach popups; the answer then showed the old
 * screen as if the step had run. Chrome's focus emulation (DevTools:
 * "Emulate a focused page") lifts this for the tab the server is attached
 * to, without bringing it to the front: the user's own tab stays where it is.
 * It ends when the server disconnects.
 */
export function keepAwake(page: Page): Promise<boolean> {
  let p = awake.get(page);
  if (!p) {
    p = (async () => {
      try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        return true;
      } catch {
        // Not Chromium, or the browser refuses: the server works as before, in a tab that is in front.
        return false;
      }
    })();
    awake.set(page, p);
  }
  return p;
}

/** Is the page hidden from Chrome's point of view (a background tab, a minimised window)? */
export async function hidden(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => document.visibilityState === "hidden").catch(() => false);
}

/**
 * Where the time of one action went, in milliseconds. "sap" is the part
 * that is SAP's (and the network's): from the first request of a step to
 * the end of the last one. "start" and "settle" are the server's own
 * waiting: for a request to leave after the key or click, and after the
 * last answer until the step counts as over.
 */
export interface Timing {
  /** Before the action: focus emulation, the frame check, the wait for a step still running. */
  wake: number;
  /** After the key or click, until its request left (or the wait for one gave up). */
  start: number;
  /** From the first request of a step to the end of the last one. */
  sap: number;
  /** After the last answer, until the wait ended (quiet period, lock checks). */
  settle: number;
  /** Waits for quiet when no request was expected (after typing). */
  idle: number;
  /** Requests that carried a step. */
  posts: number;
  /** The longest pause between two requests of one step. */
  gap: number;
}

export const noTiming = (): Timing => ({ wake: 0, start: 0, sap: 0, settle: 0, idle: 0, posts: 0, gap: 0 });

/** "1306 ms: sap 812, start 40, settle 402, wake 30, other 22 (1 request)" */
export function timingText(t: Timing, total: number): string {
  const other = Math.max(0, total - t.wake - t.start - t.sap - t.settle - t.idle);
  const parts = [`sap ${t.sap}`, `start ${t.start}`, `settle ${t.settle}`, ...(t.idle ? [`idle ${t.idle}`] : []), `wake ${t.wake}`, `other ${other}`];
  return `${total} ms: ${parts.join(", ")} (${t.posts} request${t.posts === 1 ? "" : "s"}${t.gap ? `, longest pause between requests ${t.gap} ms` : ""})`;
}

export class WebGuiSession {
  readonly page: Page;
  private readonly traffic: Traffic;
  /** How long the current action waits for Web GUI to be idle. */
  idleTimeoutMs = IDLE_TIMEOUT_MS;
  /**
   * Set when a wait ended while Web GUI still showed its "loading" sign with
   * no request under way: the step may not be over. The action's answer says so.
   */
  unsettled = false;
  /**
   * How long Web GUI must send nothing before a step counts as over. One
   * step can be two round trips with a timer between them (a field's check,
   * then the button's function): 300 ms bridges that in a tab in front, and
   * `wake` raises it for a tab Chrome draws only once a second.
   */
  quietMs = QUIET_MS;
  /** The tab is in the background: input reaches it late (see `framesSlow`). */
  slow = false;
  /** Did the last `waitRoundtrip` see a request that carries a function leave for SAP? */
  started = false;
  /** The last full view read, for the step that follows it (assess, then act). */
  view: { at: number; text: string } | undefined;
  /** Where the time of the current (or last) action went. */
  timing: Timing = noTiming();
  /** The last action's timing as one line (`timingText`). */
  timingText: string | undefined;

  constructor(readonly frame: Frame) {
    this.page = frame.page();
    this.traffic = watch(this.page);
    // A click on a control that is covered or gone fails after this long, not after Playwright's 30 s:
    // the agent gets the reason and the screen while it can still use them.
    this.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  }

  private async busyShown(): Promise<boolean> {
    return (
      (await this.frame
        .locator(BUSY)
        .filter({ visible: true })
        .count()
        .catch(() => 0)) > 0
    );
  }

  /**
   * After an action that may cause a round trip (Enter, F-keys, clicks, OK-code):
   * Web GUI sends the POST a little after the key event, so first wait up to
   * `startMs` for the POST or the busy bar to appear, then wait for idle.
   * First calls on a fresh system can take long (ABAP loads compile), hence
   * the generous idle timeout.
   */
  async waitRoundtrip(startMs = 1500, before = this.traffic.posts): Promise<void> {
    const t0 = Date.now();
    if (this.slow) startMs = Math.max(startMs, START_SLOW_MS);
    while (Date.now() - t0 < startMs) {
      if (this.traffic.posts > before || (await this.busyShown())) break;
      await this.page.waitForTimeout(50);
    }
    const seen = Date.now();
    this.traffic.maxGap = 0;
    await this.waitIdle(this.quietMs, false);
    this.started = this.traffic.posts > before;
    this.account(t0, seen, before);
    const failed = this.traffic.failed;
    if (failed && failed.at >= t0 - 50) {
      this.traffic.failed = undefined;
      throw new ActionError(
        `SAP did not answer: the request failed (${failed.error}). The connection to the SAP system is down or was interrupted, and the step may not have run. The page may show the old screen and take no input until it is reloaded: ask the user to check the connection and reload the tab.`,
      );
    }
  }

  /**
   * Runs what causes the round trip, then waits for it. The count of POSTs
   * is taken before the click: a round trip that starts while the click is
   * still being awaited is then seen at once, where counting afterwards
   * waited the whole `startMs` for a POST that had already gone.
   */
  /** Adds one wait to `timing`: `t0` when the wait began, `seen` when the request was seen (or the wait for it ended). */
  private account(t0: number, seen: number, before: number): void {
    const end = Date.now();
    const t = this.timing;
    const first = this.traffic.postAt[before];
    if (this.traffic.posts > before && first !== undefined) {
      const last = Math.max(this.traffic.lastEnd, first);
      t.start += Math.max(0, first - t0);
      t.sap += Math.max(0, last - first);
      t.settle += Math.max(0, end - Math.max(last, t0));
      t.posts += this.traffic.posts - before;
      t.gap = Math.max(t.gap, this.traffic.maxGap);
    } else {
      t.start += seen - t0;
      t.idle += end - seen;
    }
  }

  async roundtrip<T>(cause: () => Promise<T>, startMs = 1500): Promise<T> {
    const before = this.traffic.posts;
    const result = await cause();
    await this.waitRoundtrip(startMs, before);
    return result;
  }

  /**
   * Does Chrome draw this tab only now and then? It gives a tab in the
   * background about one frame a second, focus emulation or not, and hands
   * clicks and keys to the page with a frame. A click then reaches Web GUI
   * up to a second late: its request started after the server had stopped
   * waiting, and the answer showed the screen from before the step
   * (measured: a button's request 1.0 s after the click in a background
   * tab, at once in the tab in front).
   */
  async framesSlow(): Promise<boolean> {
    const drawn = this.frame.evaluate(() => new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))).catch(() => true);
    const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200));
    return !(await Promise.race([drawn, late]));
  }

  /**
   * Is Web GUI in the middle of a round trip? It locks its page from the
   * request to the end of drawing the answer (`oLS.bLocked()`; measured on
   * ECC: false when idle, also with a popup open). Undefined when this Web
   * GUI does not say.
   */
  async locked(): Promise<boolean | undefined> {
    return this.frame
      .evaluate(() => {
        const ls = (window as unknown as { oLS?: { bLocked?: () => unknown } }).oLS;
        if (typeof ls?.bLocked !== "function") return undefined;
        try {
          return ls.bLocked() === true;
        } catch {
          return undefined;
        }
      })
      .catch(() => undefined);
  }

  /**
   * Waits until no request has been in flight for a quiet period and Web GUI
   * is done with the answer: its page is unlocked, or, where it does not say,
   * its loading sign is gone.
   */
  async waitIdle(quietMs = this.quietMs, timed = true): Promise<void> {
    const start = Date.now();
    if (timed) {
      try {
        return await this.waitIdle(quietMs, false);
      } finally {
        this.timing.idle += Date.now() - start;
      }
    }
    const deadline = start + this.idleTimeoutMs;
    await this.page.waitForTimeout(100);
    while (Date.now() < deadline) {
      // A round trip that failed on the network never ends: the caller reports it.
      if (this.traffic.failed && this.traffic.failed.at >= start) return;
      const quiet = this.traffic.inflight === 0 && Date.now() - this.traffic.lastChange >= quietMs;
      if (quiet) {
        const locked = await this.locked();
        if (locked === false) {
          await this.frame.waitForLoadState("domcontentloaded").catch(() => {});
          return;
        }
        if (locked === undefined) {
          const busy = await this.busyShown();
          // The loading sign can outlast its round trip; after 5 s without traffic the wait ends, and says so.
          if (!busy || Date.now() - this.traffic.lastChange > 5000) {
            if (busy) this.unsettled = true;
            await this.frame.waitForLoadState("domcontentloaded").catch(() => {});
            return;
          }
        }
      }
      await this.page.waitForTimeout(100);
    }
    throw new ActionError(
      `SAP was still working after ${Math.round(this.idleTimeoutMs / 1000)} s. The step may still finish: look at the screen again in a moment (sap_look), or give a long step more time with "timeout" (seconds, up to ${MAX_IDLE_TIMEOUT_MS / 1000}).`,
    );
  }

  /**
   * Before an action: the tab must draw and take input even when it is not
   * the one in front. When Chrome cannot be told so, the tab is brought to
   * the front, which is the one way left that works.
   */
  async wake(): Promise<void> {
    if (!(await keepAwake(this.page)) || (await hidden(this.frame))) {
      if (await hidden(this.frame)) await this.page.bringToFront().catch(() => {});
    }
    this.slow = await this.framesSlow();
    this.quietMs = this.slow ? QUIET_SLOW_MS : QUIET_MS;
    // The step before may still be running (it was given up on, or the user started one): input would be lost.
    for (let i = 0; i < 100 && (await this.locked()) === true; i++) await this.page.waitForTimeout(100);
    if ((await this.locked()) === true)
      throw new ActionError(
        "SAP is still working on the step before this one, so nothing was done. Look at the screen again in a moment (sap_look). If it stays like this, the page has lost its connection to SAP: ask the user to reload the tab.",
      );
  }

  /** Types a command into the command field and sends it. */
  async okCode(command: string): Promise<void> {
    const ok = this.frame.locator("#ToolbarOkCode");
    // A popup blocks the main window: the click would wait for its timeout.
    if (
      (await this.frame.locator("#urPopupWindowBlockLayer").filter({ visible: true }).count().catch(() => 0)) ||
      (await this.frame.locator("#sesTimeoutPopupWindow").filter({ visible: true }).count().catch(() => 0))
    )
      throw new ActionError("A popup window is open and blocks the command field: answer or close the popup first (see the WINDOW lines of sap_look).");
    await ok.click();
    await ok.fill("");
    await ok.pressSequentially(command, { delay: 20 });
    // What the field holds is what Enter sends: a command that did not arrive whole must not run as another one.
    const typed = await ok.inputValue().catch(() => command);
    if (typed.trim().toLowerCase() !== command.trim().toLowerCase()) {
      await ok.fill("").catch(() => {});
      throw new ActionError(`The command field took "${typed}" instead of "${command}", so nothing was sent. Look at the screen and try again.`);
    }
    // A command always sends a request: waited for also when the browser is slow to hand Enter on.
    await this.roundtrip(() => ok.press("Enter"), 5000);
  }

  /**
   * Web GUI opens a type-ahead list of earlier entries under some fields while
   * typing. It covers the fields below. Tab closes it and keeps the typed
   * value (Escape would be Cancel, F12). No round trip.
   */
  async closeSuggestions(): Promise<void> {
    const list = this.frame.locator("[role='listbox'],.lsListbox,[ct='LIB']").filter({ visible: true });
    if ((await list.count().catch(() => 0)) > 0) {
      await this.page.keyboard.press("Tab");
      await this.page.waitForTimeout(150);
    }
  }

  /** Sends a key to the screen. When Web GUI sits in an iframe, the key must land in that frame. */
  async pressKey(key: string): Promise<void> {
    if (this.frame !== this.page.mainFrame())
      await this.frame
        .evaluate(() => {
          if (!document.hasFocus()) window.focus();
        })
        .catch(() => {});
    await this.page.keyboard.press(key);
  }
}
