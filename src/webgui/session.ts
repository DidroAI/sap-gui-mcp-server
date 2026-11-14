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

const IDLE_TIMEOUT_MS = 180_000;

interface Traffic {
  inflight: number;
  /** POST requests started so far: each Web GUI round trip is one POST. */
  posts: number;
  lastChange: number;
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
 * Counts the page's Web GUI requests, from the first use on. Other frames are
 * left out: a Fiori launchpad around Web GUI keeps a connection open and is
 * never quiet.
 */
function watch(page: Page): Traffic {
  let t = trafficOf.get(page);
  if (t) return t;
  const traffic: Traffic = { inflight: 0, posts: 0, lastChange: Date.now() };
  t = traffic;
  page.on("request", (r) => {
    if (!fromWebGui(r)) return;
    traffic.inflight++;
    if (r.method() === "POST") traffic.posts++;
    traffic.lastChange = Date.now();
  });
  const done = (r: Request) => {
    if (!fromWebGui(r)) return;
    traffic.inflight = Math.max(0, traffic.inflight - 1);
    traffic.lastChange = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  trafficOf.set(page, t);
  return t;
}

export class WebGuiSession {
  readonly page: Page;
  private readonly traffic: Traffic;

  constructor(readonly frame: Frame) {
    this.page = frame.page();
    this.traffic = watch(this.page);
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
  async waitRoundtrip(startMs = 1500): Promise<void> {
    const before = this.traffic.posts;
    const t0 = Date.now();
    while (Date.now() - t0 < startMs) {
      if (this.traffic.posts > before || (await this.busyShown())) break;
      await this.page.waitForTimeout(50);
    }
    await this.waitIdle();
  }

  /** Waits until no request has been in flight for a quiet period and no busy indicator shows. */
  async waitIdle(quietMs = 300): Promise<void> {
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    await this.page.waitForTimeout(100);
    while (Date.now() < deadline) {
      const quiet = this.traffic.inflight === 0 && Date.now() - this.traffic.lastChange >= quietMs;
      if (quiet && (!(await this.busyShown()) || Date.now() - this.traffic.lastChange > 5000)) {
        await this.frame.waitForLoadState("domcontentloaded").catch(() => {});
        return;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error("Web GUI did not become idle in time");
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
    await ok.press("Enter");
    await this.waitRoundtrip();
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
