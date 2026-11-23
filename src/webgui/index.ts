/**
 * The Web GUI surface: SAP GUI for HTML tabs in the user's Chrome.
 *
 * Which tabs are Web GUI is decided in one place, browser/classify.ts: the
 * URL path contains /sap/bc/gui/sap/its/webgui, or the main frame holds Web
 * GUI's controls (`lsdata`) with its system information items or command
 * field. Web GUI inside a Fiori launchpad (an iframe) belongs to the Fiori
 * surface, which reads and drives it with the three `...InFrame` functions.
 */
import type { Frame, Page } from "playwright-core";
import { chromeAttached, chromeDoctor, chromeTabs, type ChromeTab, noSessionHint, sapTabs, stillOwned } from "../browser/chrome.js";
import { isWebguiUrl, tabWhere, WEBGUI_PATH } from "../browser/classify.js";
import { compact } from "../core/compact.js";
import { type Action, ActionError, type Assessment, type DiscoverOptions, type Driver, type LookOptions, type SessionInfo, type Surface } from "../core/types.js";
import { extractFacts, type PageFacts } from "./page.js";
import { act, assess, look, view } from "./reader.js";
import { runningSince } from "./running.js";
import { lookRead } from "./screen.js";
import { endedText, WebGuiSession } from "./session.js";

export { assessAction } from "./assess.js";

type Env = Record<string, string | undefined>;

const sessions = new WeakMap<Frame, WebGuiSession>();
function sessionOf(frame: Frame): WebGuiSession {
  let s = sessions.get(frame);
  if (!s) {
    s = new WebGuiSession(frame);
    sessions.set(frame, s);
  }
  return s;
}

/** A tab Chrome has frozen or discarded never answers: discovery must not wait for it. */
const FACTS_TIMEOUT_MS = 3000;

function facts(frame: Frame): Promise<PageFacts | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), FACTS_TIMEOUT_MS);
  });
  return Promise.race([frame.evaluate(extractFacts).catch(() => undefined), late]).finally(() => clearTimeout(timer));
}

async function isWebGui(frame: Frame): Promise<boolean> {
  return (await facts(frame))?.webgui === true;
}

/** The screen of a Web GUI frame as text, compact or full; null if the frame is not Web GUI. */
export async function webguiLookInFrame(frame: Frame, compactView: boolean): Promise<string | null> {
  if (!(await isWebGui(frame))) return null;
  const full = await look(sessionOf(frame));
  return compactView ? compact(full) : full;
}

/** Runs one action in a Web GUI frame and waits for the new screen. Returns a one-line note. */
export async function webguiActInFrame(frame: Frame, action: Action): Promise<string> {
  return act(sessionOf(frame), action);
}

/** Classifies an action on a Web GUI frame from its current screen: read, navigate or commit. */
export async function webguiAssessInFrame(frame: Frame, action: Action): Promise<Assessment> {
  // reader.ts reads the view, the menus, the logon language and the focused control; it refuses on a logon screen.
  return assess(sessionOf(frame), action);
}

/** SAP names its session cookie SAP_SESSIONID_<system>_<client>. */
async function identityFromCookies(page: Page): Promise<{ system?: string; client?: string }> {
  const cookies = await page
    .context()
    .cookies(page.url())
    .catch(() => []);
  // Two logons in one browser share the cookies of a host (any port): only a single one says which this is.
  const ids = [...new Set(cookies.map((c) => /^SAP_SESSIONID_([A-Z0-9]{3})_(\d{3})$/.exec(c.name)).flatMap((m) => (m?.[1] && m[2] ? [`${m[1]} ${m[2]}`] : [])))];
  if (ids.length !== 1) return {};
  const [system = "", client = ""] = (ids[0] ?? "").split(" ");
  return { system, client };
}

async function describe(page: Page, id: string, f: PageFacts | undefined): Promise<SessionInfo> {
  const url = new URL(page.url());
  // A logon page belongs to no session yet: a cookie names another tab's (sap_sessions called an ECC logon tab
  // "S4H (300)", live 2026-11-23).
  const cookie = (f?.system && f.client) || f?.logon ? {} : await identityFromCookies(page);
  const system = f?.system || cookie.system;
  const client = f?.client || cookie.client || url.searchParams.get("sap-client") || undefined;
  const title = f?.title || (await page.title().catch(() => ""));
  return {
    id,
    surface: "webgui",
    ...(system ? { system } : {}),
    ...(client ? { client } : {}),
    ...(f?.user ? { user: f.user } : {}),
    ...(f?.transaction ? { transaction: f.transaction } : {}),
    ...(title ? { title } : {}),
    where: tabWhere(title, page.url()),
    url: `${url.origin}${url.pathname}`,
  };
}

const isWebGuiTab = (url: string, f: PageFacts | undefined) => isWebguiUrl(url) || f?.webgui === true;

/** The Web GUI tabs among the open tabs (the classifier's answer), with their session facts. */
async function discover(env: Env, options: DiscoverOptions = {}): Promise<{ tab: ChromeTab; info: SessionInfo }[]> {
  const mine = (await sapTabs(env, options)).filter((t) => t.owner === "webgui");
  return Promise.all(mine.map(async ({ tab }) => ({ tab, info: await describe(tab.page, `chrome:${tab.id}`, await facts(tab.page.mainFrame())) })));
}

/** The last line of a view read while Web GUI is still busy with a step. */
export const STILL_WORKING =
  "NOTE SAP is still working on a step (Web GUI has locked the page until its answer is drawn): this screen is from before that step and will change. Look again in a moment, and act when the step has ended.";

/** The view of a tab whose SAP session has ended. */
export function endedView(said: string): string {
  return ["TRANSACTION   PROGRAM   SCREEN ", `WINDOW wnd[0]  "${said.slice(0, 60).replace(/"/g, "'")}"`, `NOTE ${endedText(said)}`].join("\n");
}

/**
 * The screen as sap_look shows it, and what it is: the page of a session
 * that has ended says so; a screen read while Web GUI is still busy with a
 * step (one given up on after its timeout) says that it is from before it.
 */
export async function webguiView(session: WebGuiSession, options: LookOptions): Promise<string> {
  if (!options.id) {
    // The whole screen: the end of the session, the screen and the lock come from one read of the page.
    const r = await lookRead(session, true);
    if (r.ended) return endedView(r.ended);
    const text = options.compact ? compact(r.text) : r.text;
    return r.locked === true ? `${text}\n${STILL_WORKING}${runningSince(session)}` : text;
  }
  const gone = await session.ended();
  if (gone) return endedView(gone);
  const text = await view(session, options);
  if ((await session.locked()) === true) return `${text}\n${STILL_WORKING}${runningSince(session)}`;
  return text;
}

class WebGuiDriver implements Driver {
  constructor(
    public info: SessionInfo,
    private readonly page: Page,
    private readonly env: Env,
  ) {}

  /** The tab is open, its browser connected, and it is still Web GUI's (not, say, the launchpad now). */
  valid(): Promise<boolean> {
    return stillOwned(this.page, "webgui", this.env);
  }

  private get frame(): Frame {
    if (this.page.isClosed()) throw new Error(`${this.info.where} was closed. Call sap_sessions to list the open sessions.`);
    return this.page.mainFrame();
  }

  /** Reads the tab again: after an okcode the transaction differs, and the tab may have left Web GUI. */
  async refresh(): Promise<SessionInfo> {
    const f = await facts(this.frame);
    if (!isWebGuiTab(this.page.url(), f)) throw new Error(`${this.info.where} is no longer a Web GUI session. Call sap_sessions to list the open sessions.`);
    this.info = await describe(this.page, this.info.id, f);
    return this.info;
  }

  look(options: LookOptions): Promise<string> {
    return webguiView(sessionOf(this.frame), options);
  }

  async assess(action: Action): Promise<Assessment> {
    const gone = await sessionOf(this.frame).ended();
    if (gone) throw new ActionError(endedText(gone));
    return webguiAssessInFrame(this.frame, action);
  }

  act(action: Action): Promise<string> {
    return act(sessionOf(this.frame), action);
  }

  timing(): string | undefined {
    return this.page.isClosed() ? undefined : sessionOf(this.frame).timingText;
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

  /** Nothing to release: the tab is the user's, and the Chrome connection is shared with the other surfaces. */
  async close(): Promise<void> {}
}

export function webguiSurface(env: Record<string, string | undefined>): Surface {
  return {
    name: "webgui",
    discover: async (options) => (await discover(env, options)).map((x) => x.info),
    open: async (session) => {
      const tab = (await chromeTabs(env)).find((t) => `chrome:${t.id}` === session.id);
      if (!tab) throw new Error(`${session.where} is not open any more. Call sap_sessions to list the open sessions.`);
      if (!(await stillOwned(tab.page, "webgui", env))) throw new Error(`${session.where} is no longer a Web GUI session. Call sap_sessions to list the open sessions.`);
      return new WebGuiDriver(session, tab.page, env);
    },
    doctor: async () => {
      const checks = await chromeDoctor(env);
      // No browser connected (the SAP window is not open yet): nothing to read, and doctor opens nothing.
      if (checks.some((c) => !c.ok) || !chromeAttached()) return checks;
      const found = await discover(env).catch(() => []);
      checks.push({
        ok: true,
        check: "Web GUI",
        detail: found.length
          ? found.map((x) => `${x.info.where}: ${x.info.system ?? "?"} (${x.info.client ?? "?"}) ${x.info.transaction ?? ""}`).join("; ")
          : `no Web GUI tab open (a tab whose address contains ${WEBGUI_PATH})`,
      });
      return checks;
    },
    whenEmpty: () => noSessionHint(env),
  };
}
