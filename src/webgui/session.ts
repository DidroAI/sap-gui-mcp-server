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
/**
 * Where Web GUI's own event queue cannot be watched (see `watchQueue`): after
 * the page has handled a key or a click (two frames drawn), how long its
 * request may still take to leave before the action counts as one that sends
 * nothing. Web GUI with SAP Screen Personas holds every step for 300 ms
 * before it sends it (measured on ECC: the request left 300 to 311 ms after
 * the key, every time), so the guess must be well over that: 250 ms answered
 * "nothing was sent" for steps that did go to SAP.
 */
export const LEAVE_MS = 450;
/** A step the queue has held for longer than this is no longer waited for: its timer is 300 ms at most. */
const QUEUE_MAX_MS = 1500;
/** A step still running when an action comes, for this long or more, makes the action stop: the screen it was chosen on is gone. */
const BUSY_BEFORE_MS = 1000;
/** How often a wait looks at the traffic and the page. */
const POLL_MS = 25;
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
 *   [{"post":"focus/...","logic":"ignore"},{"content":"A04","post":"value/.../cmbX"},{"get":"state/ur"}]  a step (a dropdown)
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
  // The request asks for the screen back: SAP then works on what it was sent.
  const asksScreen = posts.some((p) => (p as { get?: unknown } | null)?.get === "state/ur");
  return posts.some((p) => {
    const post = (p as { post?: unknown } | null)?.post;
    if (typeof post !== "string") return false;
    if ((p as { logic?: unknown }).logic === "ignore") return false;
    // A value that is not marked "ignore", sent with a request for the screen, is a step: a dropdown
    // whose choice SAP acts on sends just that (the role of a business partner, the action of MIGO).
    if (/^value\//.test(post)) return asksScreen;
    return !/^(focus\/|typea)/.test(post);
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

/**
 * Runs in the page: what a page says when the SAP session in it has ended
 * (logged off with /nex or /i, ended by the server), or "" while Web GUI is
 * there. Web GUI's own screens carry controls with scripting ids; the page
 * after a logoff has none and says so in words. The logon page is not an
 * end: the reader reports it as the logon screen. No String.prototype.trim:
 * Web GUI patches it.
 */
export function extractEnded(): string {
  if (document.querySelector("[lsdata*='wnd['],[data-ls*='wnd['],#ToolbarOkCode")) return "";
  if (document.querySelector("input[type='password'],[name='sap-user'],#sap-user")) return "";
  const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").replace(/^ | $/g, "");
  const said = /logged off|logged out|log off|session (has )?(ended|terminated|expired)|abgemeldet|d[ée]connect[ée]|goodbye|auf wiedersehen/i;
  if (said.test(text) || said.test(document.title)) return text.slice(0, 160) || document.title;
  return "";
}

/** The answer when the session has ended, with what the page says. */
export function endedText(said: string): string {
  return `The SAP session in this tab has ended: the page says "${said}". Nothing more can be done in it: the user has to log on again (this server never logs on), then call sap_sessions.`;
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

/** What the waits read from the page on every poll. */
export interface PageState {
  /** Web GUI's loading sign is shown. */
  busy: boolean;
  /** Web GUI's lock (`oLS.bLocked()`); undefined when this Web GUI does not say. */
  locked: boolean | undefined;
  /**
   * Web GUI's event queue: "waiting" while it holds a step it has not sent
   * yet (or is about to put one there), "idle" when it holds none. Undefined
   * when the queue is not watched: this Web GUI is built differently, or the
   * watch was not there before the input.
   */
  queue: "waiting" | "idle" | undefined;
  /**
   * After an answer: the queue holds nothing and no delayed call is left
   * but the scroll report (`fireScrollSync`), which rides with the next
   * request and sends none itself. False when the queue is not watched.
   */
  calm: boolean;
}

/**
 * Runs in the page: Web GUI's loading sign (BUSY) is shown, its lock
 * (`oLS.bLocked()`, undefined when this Web GUI does not say), and its event
 * queue. One round trip for what the waits look at on every poll. "Shown" is
 * Playwright's `visible`: not hidden by style, and a box that is not empty.
 *
 * The event queue. Web GUI does not send a step from the key or click
 * handler: the handler puts an event in a queue (`enqueueEvent` of the
 * object Lightspeed hands its events to), and a timer sends the queue: at
 * once, or 300 ms later when SAP Screen Personas is on. Between the two the
 * page is not locked and no request is under way, so a wait that looks only
 * at those answered "nothing was sent" for steps that were about to go. The
 * queue itself is private to Web GUI. With `watch`, the two functions around
 * it are wrapped once per page: the wrapper notes when an event goes in and
 * when the queue is processed, and calls the original. A key or a click
 * that does nothing in SAP puts nothing in the queue: that is known as soon
 * as the page has handled it.
 *
 * Lightspeed's delayed calls count as "waiting" too: a control that was
 * scrolled puts its event in the queue 200 ms later (`fireScrollSync`). Two
 * of them never lead to a request and stay for seconds: the loading
 * animation (`show`) and the layout filter (`timedMassNotificationFilter`).
 */
export function pageState(arg: { busy: string; watch: boolean; maxMs: number }): PageState {
  const shown = (e: Element) => {
    const st = getComputedStyle(e);
    if (typeof (e as HTMLElement).checkVisibility === "function" && !(e as HTMLElement).checkVisibility()) return false;
    if (st.visibility !== "visible") return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  let busy = false;
  try {
    busy = Array.from(document.querySelectorAll(arg.busy)).some(shown);
  } catch {
    busy = false;
  }
  const w = window as unknown as {
    oLS?: { bLocked?: () => unknown };
    UCF_System?: { oLS?: { oSemanticEventHandlerObject?: QueueOwner } };
    UCF_JsUtil?: { mDelayedCalls?: Record<string, { sMethodName?: unknown } | undefined> };
  };
  interface QueueWatch {
    /** When the oldest event still in the queue went in; 0 when the queue was processed since. */
    at: number;
    /** When the queue was last processed. */
    done: number;
  }
  interface QueueOwner {
    enqueueEvent?: (...a: unknown[]) => unknown;
    processEventQueue?: (...a: unknown[]) => unknown;
    sapGuiMcpWatch?: QueueWatch;
  }
  const isLocked = (): boolean | undefined => {
    const ls = w.oLS;
    if (typeof ls?.bLocked !== "function") return undefined;
    try {
      return ls.bLocked() === true;
    } catch {
      return undefined;
    }
  };
  const locked = isLocked();
  let queue: "waiting" | "idle" | undefined;
  let calm = false;
  try {
    const owner = w.UCF_System?.oLS?.oSemanticEventHandlerObject;
    if (owner && typeof owner.enqueueEvent === "function" && typeof owner.processEventQueue === "function") {
      const watch = owner.sapGuiMcpWatch;
      if (!watch && arg.watch) {
        const made: QueueWatch = { at: 0, done: 0 };
        const enqueue = owner.enqueueEvent;
        const process = owner.processEventQueue;
        owner.enqueueEvent = function (this: unknown, ...a: unknown[]) {
          try {
            // As Web GUI decides it: a focus change is not queued, and an event that comes while a
            // round trip runs is dropped (all but a grid's request for more rows).
            const name = (a[0] as { sEvName?: unknown } | undefined)?.sEvName;
            if (name !== "FocusChange" && !(isLocked() === true && name !== "RequestData") && !made.at) made.at = Date.now();
          } catch {
            // The watch must never break the page.
          }
          return enqueue.apply(this, a);
        };
        owner.processEventQueue = function (this: unknown, ...a: unknown[]) {
          made.at = 0;
          made.done = Date.now();
          return process.apply(this, a);
        };
        owner.sapGuiMcpWatch = made;
        // An event already in the queue is not known: this poll cannot say.
      } else if (watch) {
        const now = Date.now();
        const held = watch.at > 0 && now - watch.at < arg.maxMs;
        // Just processed: a Personas script may run before the request leaves (a timer of 1 ms).
        const justDone = now - watch.done < 50;
        const calls = w.UCF_JsUtil?.mDelayedCalls;
        const names = calls ? Object.keys(calls).map((k) => String(calls[k]?.sMethodName ?? "")) : [];
        const delayed = names.some((n) => !/^(show|timedMassNotificationFilter)$/.test(n));
        queue = held || justDone || delayed ? "waiting" : "idle";
        calm = !held && !justDone && !names.some((n) => !/^(show|timedMassNotificationFilter|fireScrollSync)$/.test(n));
      }
    }
  } catch {
    queue = undefined;
  }
  return { busy, locked, queue, calm };
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

  /**
   * The loading sign, the lock and the event queue, in one round trip; none
   * of them when the page cannot be read. `watch` starts the watch of the
   * queue where there is none yet: only before an input, never after it (an
   * event already in the queue would be missed).
   */
  private state(watch = false): Promise<PageState> {
    return this.frame.evaluate(pageState, { busy: BUSY, watch, maxMs: QUEUE_MAX_MS }).catch(() => ({ busy: false, locked: undefined, queue: undefined, calm: false }));
  }

  /** Before an input: Web GUI's event queue is watched from here on (see `pageState`). */
  async watchQueue(): Promise<void> {
    await this.state(true);
  }

  /**
   * Waits `ms` between two looks at the page. The wait itself needs no round
   * trip to the browser; on a closed page it fails as Playwright's does.
   */
  private async pause(ms: number): Promise<void> {
    if (this.page.isClosed()) return this.page.waitForTimeout(ms);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * After an action that may cause a round trip (Enter, F-keys, clicks, OK-code):
   * Web GUI sends the POST a little after the key event (300 ms after it
   * with SAP Screen Personas on). The wait for it ends when the request
   * leaves or the page locks. It also ends, with nothing sent, once the page
   * has handled the input (it drew two frames after it) and Web GUI's event
   * queue holds nothing: then nothing goes to SAP, and there is nothing to
   * wait for. Where the queue cannot be watched, `LEAVE_MS` without a
   * request, a loading sign or a lock stand in for it. `startMs` is the most
   * it waits when the page does not draw (a busy machine, a tab in the
   * background). Then it waits for idle. First calls on a fresh system can
   * take long (ABAP loads compile), hence the generous idle timeout.
   *
   * `leaveMs`: for input that reaches Web GUI's queue by another way than
   * its own handlers (a click inside an HTML viewer's frame is posted to the
   * page as a message), the least time before "nothing was sent" is said.
   */
  async waitRoundtrip(startMs = 1500, before = this.traffic.posts, leaveMs = 0): Promise<void> {
    const t0 = Date.now();
    if (this.slow) startMs = Math.max(startMs, START_SLOW_MS);
    // A tab Chrome draws once a second hands input on late: there, only the long wait is safe.
    let handled: number | undefined;
    if (!this.slow)
      void this.framesDrawn(startMs).then((drawn) => {
        if (drawn) handled = Date.now();
      });
    let sent = false;
    // The queue was seen empty on the poll before: said twice, so a request that left in between has reached the count.
    let empty = false;
    while (Date.now() - t0 < startMs) {
      if (this.traffic.posts > before) {
        sent = true;
        break;
      }
      const st = await this.state();
      if (st.busy || st.locked === true) {
        sent = true;
        break;
      }
      if (handled !== undefined) {
        if (st.queue === undefined && Date.now() - handled >= LEAVE_MS) break;
        if (st.queue === "idle" && empty && this.traffic.posts === before && Date.now() - handled >= leaveMs) break;
      }
      empty = handled !== undefined && st.queue === "idle";
      await this.pause(POLL_MS);
    }
    const seen = Date.now();
    this.traffic.maxGap = 0;
    // Nothing left and nothing is under way: no round trip to wait for.
    if (sent || this.traffic.inflight > 0 || this.traffic.posts > before) await this.waitIdle(this.quietMs, false, sent ? 0 : 100, "answer");
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
   * Did the page draw two frames within `ms`? It has then handled the input
   * sent before. `unreadable` is the answer when the page cannot be asked.
   */
  private framesDrawn(ms: number, unreadable = false): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drawn = this.frame
      .evaluate(() => new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))
      .catch(() => unreadable);
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    return Promise.race([drawn, late]).finally(() => clearTimeout(timer));
  }

  /** Requests that carried a step so far: an action that ends with the same count sent nothing to SAP. */
  get posts(): number {
    return this.traffic.posts;
  }

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

  /**
   * Runs what causes the round trip, then waits for it. The count of POSTs
   * is taken before the click: a round trip that starts while the click is
   * still being awaited is then seen at once, where counting afterwards
   * waited the whole `startMs` for a POST that had already gone.
   */
  async roundtrip<T>(cause: () => Promise<T>, startMs = 1500): Promise<T> {
    // The page may have been loaded anew since the action began (a step before this one in the same action).
    await this.watchQueue();
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
    // A page that cannot be asked does not count as slow.
    return !(await this.framesDrawn(200, true));
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

  /** What the page says when the SAP session in it has ended; "" while it has not (or the page cannot be read). */
  async ended(): Promise<string> {
    return this.frame.evaluate(extractEnded).catch(() => "");
  }

  /**
   * Waits until no request has been in flight for a quiet period and Web GUI
   * is done with the answer: its page is unlocked, or, where it does not say,
   * its loading sign is gone.
   *
   * `after: "answer"`: the wait follows a step's request. The quiet period is a
   * guess at "no second request follows" (a step can be two round trips with
   * a timer between them). Where Web GUI's event queue is watched the guess
   * is not needed: the step is over when the page is unlocked, no request is
   * under way, and the queue and Lightspeed's delayed calls hold nothing
   * that could send one (`PageState.calm`), seen on two looks in a row.
   * Measured on ECC over 16 kinds of step: the page changed nothing between
   * its unlock and the end of the old 300 ms, and sent nothing. Not in a tab
   * Chrome draws once a second.
   *
   * `after: "typing"`: the wait follows typing into a field, which sends SAP nothing
   * (the list of earlier entries is asked for on the side, half a second
   * later, and waits for no one). Where the queue is watched, the page is
   * ready for the next input when it is unlocked with no request under way,
   * on two looks in a row; the lead and the quiet period were there for
   * pages that do not say.
   */
  async waitIdle(quietMs = this.quietMs, timed = true, leadMs = 100, after?: "answer" | "typing"): Promise<void> {
    const start = Date.now();
    if (timed) {
      try {
        return await this.waitIdle(quietMs, false, leadMs, after);
      } finally {
        this.timing.idle += Date.now() - start;
      }
    }
    const answered = after === "answer";
    const deadline = start + this.idleTimeoutMs;
    if (after === "typing" && !this.slow) {
      const free = async () => {
        const st = await this.state();
        return st.queue !== undefined && st.locked === false && this.traffic.inflight === 0;
      };
      if (await free()) {
        await this.pause(POLL_MS);
        if (await free()) return;
      }
    }
    if (leadMs > 0) await this.pause(leadMs);
    let checked = 0;
    // After an answer: the step was seen over on the look before.
    let calm = false;
    while (Date.now() < deadline) {
      // A round trip that failed on the network never ends: the caller reports it.
      if (this.traffic.failed && this.traffic.failed.at >= start) return;
      // A session that ended (logged off) never becomes idle: say so at once, not after the timeout.
      if (Date.now() - checked > 1000) {
        checked = Date.now();
        const gone = await this.ended();
        if (gone) throw new ActionError(endedText(gone));
      }
      const quiet = this.traffic.inflight === 0 && Date.now() - this.traffic.lastChange >= quietMs;
      if (!quiet && answered && !this.slow && this.traffic.inflight === 0) {
        const st = await this.state();
        const over = st.locked === false && st.calm && this.traffic.inflight === 0;
        if (over && calm) {
          await this.frame.waitForLoadState("domcontentloaded").catch(() => {});
          return;
        }
        calm = over;
      } else if (!quiet) calm = false;
      if (quiet) {
        const { locked, busy } = await this.state();
        if (locked === false) {
          await this.frame.waitForLoadState("domcontentloaded").catch(() => {});
          return;
        }
        if (locked === undefined) {
          // The loading sign can outlast its round trip; after 5 s without traffic the wait ends, and says so.
          if (!busy || Date.now() - this.traffic.lastChange > 5000) {
            if (busy) this.unsettled = true;
            await this.frame.waitForLoadState("domcontentloaded").catch(() => {});
            return;
          }
        }
      }
      await this.pause(POLL_MS);
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
    // A tab Chrome still sees as hidden is brought to the front, whether focus emulation took or not.
    await keepAwake(this.page);
    if (await hidden(this.frame)) await this.page.bringToFront().catch(() => {});
    this.slow = await this.framesSlow();
    this.quietMs = this.slow ? QUIET_SLOW_MS : QUIET_MS;
    // The step before may still be running (it was given up on, or the user started one): input would be lost.
    const t0 = Date.now();
    // The same look starts the watch of Web GUI's event queue, before any input of this action.
    let busy = (await this.state(true)).locked === true;
    for (let i = 0; i < 100 && busy; i++) {
      await this.pause(100);
      busy = (await this.locked()) === true;
    }
    if (busy) {
      const gone = await this.ended();
      if (gone) throw new ActionError(endedText(gone));
      throw new ActionError(
        "SAP is still working on the step before this one, so nothing was done. Look at the screen again in a moment (sap_look). If it stays like this, the page has lost its connection to SAP: ask the user to reload the tab.",
      );
    }
    // It ended while this action waited: the screen is not the one the action was chosen on.
    if (Date.now() - t0 >= BUSY_BEFORE_MS)
      throw new ActionError(
        `SAP was still working on the step before this one; it finished ${((Date.now() - t0) / 1000).toFixed(1)} s later, and the screen may have changed since you chose this action. Nothing was done: check the screen, then act again.`,
      );
  }

  /** Types a command into the command field and sends it. */
  async okCode(command: string): Promise<void> {
    const ok = this.frame.locator("#ToolbarOkCode");
    // A popup blocks the main window: the click would wait for its timeout.
    if ((await this.frame.locator("#urPopupWindowBlockLayer, #sesTimeoutPopupWindow").filter({ visible: true }).count().catch(() => 0)) > 0)
      throw new ActionError("A popup window is open and blocks the command field: answer or close the popup first (see the WINDOW lines of sap_look).");
    await ok.click();
    await ok.fill("");
    // Typed as keys, one after the other without a pause (it was 20 ms a key); the check below catches a key that was lost.
    await ok.pressSequentially(command);
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
      await this.pause(150);
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
