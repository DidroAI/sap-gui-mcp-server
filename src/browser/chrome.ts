/**
 * The Chrome the server works in, found without configuration, and its tabs.
 *
 * Order of attempts:
 * 1. `SAP_CHROME_CDP`, an http or ws DevTools endpoint, when set (nothing else is tried then);
 * 2. with `SAP_BROWSER=launch` (the default): the SAP window, a Chrome the
 *    server starts itself with a profile of its own, the first time a tool
 *    needs the browser (see launch.ts). Only that window's tabs are seen;
 * 3. with `SAP_BROWSER=attach`: the running Chrome that allows remote debugging (Chrome 144+, switched on
 *    once at chrome://inspect/#remote-debugging). Chrome then writes its port
 *    and browser path to `DevToolsActivePort` in its user-data directory; we
 *    read that file for Chrome stable and beta, as chrome-devtools-mcp's
 *    `--autoConnect` (Puppeteer's `channel` connect) does, then for Microsoft
 *    Edge. In this mode Chrome serves no http endpoints (`/json/version`),
 *    only the WebSocket, and asks the user to allow each new connection: so
 *    we keep one connection.
 *
 * With SAP_BROWSER=extension, none of these: the server reaches Chrome through the
 * sap-ui-automation extension and its local relay (src/browser/extension/).
 *
 * Nothing else is tried. In attach mode in particular the server does not attach to
 * 127.0.0.1:9222 on its own: a browser listening there may be another tool's
 * (a test runner's, another agent's), not the user's. A Chrome started with
 * `--remote-debugging-port` is named with `SAP_CHROME_CDP`.
 *
 * Only http and https tabs are listed, and with SAP_ALLOW_ORIGINS only those
 * of the listed origins.
 *
 * The connection is Playwright's `connectOverCDP` with `noDefaults`, so the
 * user's browser keeps its own settings. We never close the browser: we only
 * disconnect.
 */
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { allowedOrigins, classify, originAllowed, originOf, type TabOwner, type TabSigns, tabSigns } from "./classify.js";
import { browserMode, ensureSapWindow, rememberSapAddress, sapWindowStatus, startUrl } from "./launch.js";
import type { DoctorCheck } from "../core/types.js";

export interface ChromeTab {
  /** The CDP target id, stable for the life of the tab. */
  id: string;
  title: string;
  url: string;
  /** "https://myhost:44300". */
  origin: string;
  page: Page;
}

type Env = Record<string, string | undefined>;

/** Chrome's remote debugging switch at chrome://inspect/#remote-debugging exists since this version. */
export const MIN_CHROME_AUTO_CONNECT = 144;
/** Since Chrome 136, --remote-debugging-port is ignored on the default profile: it needs --user-data-dir with it. */
export const MIN_CHROME_PORT_NEEDS_DATA_DIR = 136;

const HOW_TO_ALLOW = `In Chrome ${MIN_CHROME_AUTO_CONNECT} or newer, open chrome://inspect/#remote-debugging and tick "Allow remote debugging for this browser instance"; Chrome then asks you to allow the connection. Or start Chrome with --remote-debugging-port=<port> and set SAP_CHROME_CDP=http://127.0.0.1:<port>: since Chrome ${MIN_CHROME_PORT_NEEDS_DATA_DIR} the port only opens together with --user-data-dir=<a directory other than Chrome's default>. The server does not try port 9222 by itself.`;

export type ChromeChannel = "stable" | "beta";

/** Chrome's default user-data directory for a channel, as Puppeteer resolves it. */
export function chromeUserDataDir(platform: NodeJS.Platform, channel: ChromeChannel, env: Env, home: string = homedir()): string | undefined {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return win32.join(local, "Google", channel === "stable" ? "Chrome" : "Chrome Beta", "User Data");
  }
  if (platform === "darwin")
    return posix.join(home, "Library", "Application Support", "Google", channel === "stable" ? "Chrome" : "Chrome Beta");
  if (platform === "linux") {
    const config = env.CHROME_CONFIG_HOME || env.XDG_CONFIG_HOME || posix.join(home, ".config");
    return posix.join(config, channel === "stable" ? "google-chrome" : "google-chrome-beta");
  }
  return undefined;
}

/** Microsoft Edge's default user-data directory (the stable channel). */
export function edgeUserDataDir(platform: NodeJS.Platform, env: Env, home: string = homedir()): string | undefined {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "Microsoft", "Edge", "User Data");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Microsoft Edge");
  if (platform === "linux") return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "microsoft-edge");
  return undefined;
}

/** `DevToolsActivePort` holds the port on its first line and the browser's WebSocket path on the second. */
export function parseDevToolsActivePort(content: string): string | undefined {
  const [rawPort, rawPath] = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!rawPort || !rawPath || !/^\d+$/.test(rawPort) || !rawPath.startsWith("/")) return undefined;
  const port = Number(rawPort);
  if (port <= 0 || port > 65535) return undefined;
  return `ws://127.0.0.1:${port}${rawPath}`;
}

function portOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export interface ChromeEndpoint {
  url: string;
  /** How it was found, for doctor and error messages. */
  from: string;
}

/** The explicit endpoint, when SAP_CHROME_CDP is set. */
function explicitEndpoint(env: Env): ChromeEndpoint | undefined {
  const explicit = env.SAP_CHROME_CDP?.trim();
  if (!explicit) return undefined;
  if (!/^(https?|wss?):\/\//.test(explicit)) throw new Error(`SAP_CHROME_CDP must be an http or ws URL (got "${explicit}")`);
  return { url: explicit, from: "SAP_CHROME_CDP" };
}

/**
 * Running browsers that allow remote debugging, from the `DevToolsActivePort`
 * file of Chrome stable, Chrome beta and Microsoft Edge, in that order. Reads
 * files and checks that the port listens; connects to nothing. `tried` says
 * what was looked at, for messages.
 */
/** DevToolsActivePort files that exist but that this app may not read (macOS privacy protection). */
export const blockedFiles: string[] = [];

export async function activePortEndpoints(
  env: Env,
  tried: string[] = [],
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Promise<ChromeEndpoint[]> {
  const found: ChromeEndpoint[] = [];
  const browsers: { name: string; dir: string | undefined }[] = [
    { name: "Chrome stable", dir: chromeUserDataDir(platform, "stable", env, home) },
    { name: "Chrome beta", dir: chromeUserDataDir(platform, "beta", env, home) },
    { name: "Microsoft Edge", dir: edgeUserDataDir(platform, env, home) },
  ];
  for (const { name, dir } of browsers) {
    if (!dir) continue;
    const file = (platform === "win32" ? win32 : posix).join(dir, "DevToolsActivePort");
    let content: string | undefined;
    try {
      content = await readFile(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        // macOS privacy protection: the file is there, but this app may not read another app's data. Without
        // it there is no way in: a Chrome that allows remote debugging from chrome://inspect answers only on
        // the WebSocket path the file names, and its /json/version is a 404 (live on macOS, 2026-11-22: the
        // fallback to http://127.0.0.1:9222 that stood here got that 404, and Playwright's error ended the process).
        blockedFiles.push(file);
        tried.push(`${file}: macOS does not let this app read it`);
        continue;
      }
      tried.push(`${file}: not there (${name} is not running, or remote debugging is not allowed)`);
      continue;
    }
    const url = parseDevToolsActivePort(content);
    if (!url) {
      tried.push(`${file}: unreadable content`);
      continue;
    }
    // A browser that crashed leaves the file behind: nothing listens on its port then.
    if (!(await portOpen("127.0.0.1", Number(new URL(url).port)))) {
      tried.push(`${file}: names port ${new URL(url).port}, where nothing listens (left by an earlier ${name})`);
      continue;
    }
    tried.push(`${file}: port ${new URL(url).port}`);
    found.push({ url, from: `${name} with remote debugging allowed (${file})` });
  }
  return found;
}

interface Connection {
  browser: Browser;
  endpoint: ChromeEndpoint;
  key: string;
  /** Set when this is the SAP window the server starts itself (SAP_BROWSER=launch): its profile directory. */
  sapWindow?: { profileDir: string; launched: boolean };
}

/** Is the SAP window used: launch mode, and no endpoint named in SAP_CHROME_CDP? */
const usesSapWindow = (env: Env): boolean => !env.SAP_CHROME_CDP?.trim() && browserMode(env) === "launch";

/** A call that must not start Chrome (doctor) says so. */
interface OpenOptions {
  launch?: boolean;
}
let connection: Connection | undefined;
let connecting: { key: string; promise: Promise<Connection> } | undefined;
const targetIds = new WeakMap<Page, string>();

/**
 * Playwright dismisses JavaScript dialogs (alert, confirm, "Leave site?") when nobody listens.
 * This is the user's browser: with a listener that does nothing, their dialogs stay for them to answer.
 * Called for every context each time tabs are listed, so a context that appears later is covered too.
 */
const quietContexts = new WeakSet<BrowserContext>();
function keepDialogs(browser: Browser): void {
  for (const context of browser.contexts()) {
    if (quietContexts.has(context)) continue;
    quietContexts.add(context);
    context.on("dialog", () => {});
  }
}

/** The time the user has to answer Chrome's "Allow remote debugging?" prompt. */
const CONNECT_TIMEOUT_MS = 45_000;

async function open(env: Env, key: string, options: OpenOptions = {}): Promise<Connection> {
  const tried: string[] = [];
  const errors: string[] = [];
  const attach = async (endpoint: ChromeEndpoint): Promise<Connection | undefined> => {
    try {
      // An http endpoint must serve /json/version, where Playwright finds the WebSocket. Asked first here: when
      // it does not (a Chrome that allows debugging from chrome://inspect answers 404), Playwright's own
      // request leaves an error on its socket that nothing handles, and the process ends.
      if (/^https?:/.test(endpoint.url)) {
        const r = await fetch(`${endpoint.url.replace(/\/+$/, "")}/json/version`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok)
          throw new Error(
            `${endpoint.url}/json/version answers ${r.status}: this is not a Chrome started with --remote-debugging-port. A Chrome that allows remote debugging from chrome://inspect is reached at the ws:// address its DevToolsActivePort file names`,
          );
      }
      const browser = await chromium.connectOverCDP(endpoint.url, { noDefaults: true, isLocal: true, timeout: CONNECT_TIMEOUT_MS });
      keepDialogs(browser);
      const c: Connection = { browser, endpoint, key };
      browser.on("disconnected", () => {
        if (connection === c) connection = undefined;
      });
      return c;
    } catch (e) {
      // The extension relay's CDP path is its secret: Playwright's errors repeat the URL.
      errors.push(`${endpoint.from}: ${(e as Error).message.split("\n")[0]?.replace(/\/cdp\/[0-9a-f]+/g, "/cdp/…")}`);
      return undefined;
    }
  };
  // 1. The endpoint the user named; nothing else is tried then.
  const explicit = explicitEndpoint(env);
  if (explicit) {
    const c = await attach(explicit);
    if (c) return c;
    throw new Error(`No Chrome answers at SAP_CHROME_CDP=${explicit.url} (${errors.join("; ")}).`);
  }
  // >>> SAP_BROWSER=extension: the extension's relay is the endpoint (src/browser/extension/); nothing else is tried (SAP_CHROME_CDP wins, as over the other modes).
  if (extensionMode(env)) {
    const { extensionEndpoint } = await import("./extension/index.js");
    const endpoint = await extensionEndpoint(env);
    const c = await attach(endpoint);
    if (c) return c;
    throw new Error(`The sap-ui-automation extension is connected, but the server could not attach through it (${errors.join("; ")}).`);
  }
  // <<< SAP_BROWSER=extension
  // 2. The SAP window: the one that runs, else a Chrome started now.
  if (browserMode(env) === "launch") {
    const window = await ensureSapWindow(env, options.launch === false ? { launch: false } : {});
    const c = await attach({ url: window.url, from: `the SAP window (${window.launched ? "started now" : "already open"}, profile ${window.profileDir})` });
    if (c) {
      c.sapWindow = { profileDir: window.profileDir, launched: window.launched };
      return c;
    }
    throw new Error(`The SAP window runs, but the connection to it failed (${errors.join("; ")}). Close that Chrome window and try again.`);
  }
  // 3. The running Chrome that allows remote debugging.
  for (const endpoint of await activePortEndpoints(env, tried)) {
    const c = await attach(endpoint);
    if (c) return c;
  }
  throw new Error(
    errors.length
      ? `Chrome was found but the connection failed (${errors.join("; ")}). If Chrome asks "Allow remote debugging?", click Allow, then try again.`
      : `No Chrome to attach to. ${HOW_TO_ALLOW} Looked at: ${tried.join("; ")}.`,
  );
}

/** SAP_BROWSER=extension: Chrome is reached through the sap-ui-automation extension (src/browser/extension/). */
export const extensionMode = (env: Env): boolean => env.SAP_BROWSER?.trim().toLowerCase() === "extension" && !env.SAP_CHROME_CDP?.trim();

async function chrome(env: Env, options: OpenOptions = {}): Promise<Connection> {
  const cdp = env.SAP_CHROME_CDP?.trim() ?? "";
  // The key names the browser: the extension, the endpoint, the SAP window of a profile directory, or the everyday Chrome ("").
  const key = cdp || (extensionMode(env) ? "extension|" : browserMode(env) === "launch" ? `launch|${env.SAP_CHROME_PROFILE?.trim() ?? ""}` : "");
  if (connection?.key === key && connection.browser.isConnected()) return connection;
  // A call that may not start Chrome and one that may do not share a pending connection.
  const pending = options.launch === false ? `${key}|quiet` : key;
  if (connecting?.key === pending) return connecting.promise;
  const mine = {
    key: pending,
    promise: open(env, key, options).then(
      (c) => {
        connection = c;
        return c;
      },
    ),
  };
  connecting = mine;
  try {
    return await mine.promise;
  } finally {
    if (connecting === mine) connecting = undefined;
  }
}

async function targetId(page: Page): Promise<string | undefined> {
  const known = targetIds.get(page);
  if (known) return known;
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      targetIds.set(page, targetInfo.targetId);
      return targetInfo.targetId;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    return undefined; // the tab closed meanwhile
  }
}

/** A tab Chrome has frozen or discarded never answers: its title is "" after this long. */
const TITLE_TIMEOUT_MS = 800;

/** The tab's title; "" for a tab Chrome has frozen or discarded, which never answers. */
function titleOf(page: Page): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), TITLE_TIMEOUT_MS);
  });
  return Promise.race([page.title().catch(() => ""), late]).finally(() => clearTimeout(timer));
}

const allPages = (browser: Browser): Page[] => browser.contexts().flatMap((context) => context.pages());

/** When a window was last opened in the SAP window's Chrome, so that two calls close together open one. */
let windowOpenedAt = 0;

/**
 * The SAP window's Chrome can run with no window at all (on macOS, closing
 * the last window leaves Chrome running). Then a window is opened on the
 * start address, as a start of Chrome would. Answers whether it opened one.
 */
async function ensureWindow(c: Connection, env: Env): Promise<boolean> {
  if (!c.sapWindow || allPages(c.browser).length > 0 || Date.now() - windowOpenedAt < 5000) return false;
  windowOpenedAt = Date.now();
  try {
    const url = await startUrl(env, c.sapWindow.profileDir);
    const session = await c.browser.newBrowserCDPSession();
    try {
      await session.send("Target.createTarget", { url, newWindow: true });
    } finally {
      await session.detach().catch(() => {});
    }
    return true;
  } catch {
    return false; // the next call tries again
  }
}

export interface TabsOptions {
  /** Start nothing: when the SAP window does not run, throw NotOpenYet (see Surface.discover). */
  quiet?: boolean;
}

/**
 * The tabs the server may look at, in the order the connection reports them:
 * http and https pages only (never chrome://, DevTools, extensions or the
 * new-tab page), and with SAP_ALLOW_ORIGINS only those origins. Ids and titles
 * are asked from all tabs at once. Throws, with the step to take, when no
 * Chrome can be reached.
 */
export async function chromeTabs(env: Record<string, string | undefined>, options: TabsOptions = {}): Promise<ChromeTab[]> {
  const allowed = allowedOrigins(env);
  const c = await chrome(env, options.quiet ? { launch: false } : {});
  const { browser } = c;
  keepDialogs(browser);
  if (!options.quiet) await ensureWindow(c, env);
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => !page.isClosed() && originAllowed(page.url(), allowed));
  const tabs = await Promise.all(
    pages.map(async (page): Promise<ChromeTab | undefined> => {
      const [id, title] = await Promise.all([targetId(page), titleOf(page)]);
      const url = page.url();
      const origin = originOf(url);
      // The tab may have closed or moved to another address while we asked.
      if (!id || !origin || !originAllowed(url, allowed)) return undefined;
      return { id, title, url, origin, page };
    }),
  );
  return tabs.filter((t) => t !== undefined);
}

export interface SapTab {
  tab: ChromeTab;
  owner: Exclude<TabOwner, null>;
  signs: TabSigns;
}

/**
 * Key presses reach a page only while it has focus. Playwright's defaults turn
 * on focus emulation, but `noDefaults` (which keeps the user's viewport and
 * settings as they are) leaves it off, so Enter on a popup in a background or
 * headless tab went nowhere while clicks worked. Focus emulation changes
 * nothing the user sees; it lasts as long as this CDP session.
 */
const focused = new WeakSet<Page>();
async function emulateFocus(page: Page): Promise<void> {
  if (focused.has(page)) return;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    focused.add(page);
  } catch {
    // A page that cannot take a CDP session still works for reading and clicking.
  }
}

/** The tabs that are SAP's, each with the one surface that owns it (see classify.ts). */
export async function sapTabs(env: Record<string, string | undefined>, options: TabsOptions = {}): Promise<SapTab[]> {
  const tabs = await chromeTabs(env, options);
  const window = connection?.sapWindow;
  const found = await Promise.all(
    tabs.map(async (tab): Promise<SapTab | undefined> => {
      const signs = await tabSigns(tab.page);
      const owner = classify(tab.page.url(), signs);
      if (owner) await emulateFocus(tab.page);
      return owner ? { tab, owner, signs } : undefined;
    }),
  );
  const mine = found.filter((t) => t !== undefined);
  // The SAP window opens on this address the next time it is started.
  if (window && mine[0]) await rememberSapAddress(window.profileDir, mine[0].tab.url);
  return mine;
}

/**
 * Is this page still what a driver was opened for: open, on a live browser
 * connection, at an allowed origin, and owned by the same surface? A Web GUI
 * tab that went to the launchpad is the Fiori surface's from then on.
 */
export async function stillOwned(page: Page, owner: Exclude<TabOwner, null>, env: Record<string, string | undefined>): Promise<boolean> {
  try {
    if (page.isClosed()) return false;
    const browser = page.context().browser();
    if (browser && !browser.isConnected()) return false;
    if (!originAllowed(page.url(), allowedOrigins(env))) return false;
    return classify(page.url(), await tabSigns(page)) === owner;
  } catch {
    return false;
  }
}

/** Drops the connection. The browser and its tabs stay as they are. */
export async function disconnectChrome(): Promise<void> {
  const c = connection;
  connection = undefined;
  // On a browser reached with connectOverCDP, close() disconnects; it does not end the browser.
  if (c?.browser.isConnected()) await c.browser.close().catch(() => {});
  // >>> SAP_BROWSER=extension: the relay's port is closed too, so the process can end.
  if (c?.endpoint.from.includes("extension")) await (await import("./extension/index.js")).stopExtensionRelay().catch(() => {});
  // <<< SAP_BROWSER=extension
}

/** Doctor gives an asleep extension worker one wake-up (Chrome's alarms fire every 30 s at most). */
const EXTENSION_DOCTOR_WAIT_MS = 35_000;

/** Setup checks: is there a Chrome we can attach to, which version, how many tabs; when not, the one step to take. */
export async function chromeDoctor(env: Record<string, string | undefined>): Promise<DoctorCheck[]> {
  const check = "Chrome";
  // >>> SAP_BROWSER=extension: is the extension installed, paired and connected; then the same checks as below.
  if (extensionMode(env)) {
    const { extensionDoctor } = await import("./extension/index.js");
    const checks = await extensionDoctor(env, EXTENSION_DOCTOR_WAIT_MS);
    if (!checks.every((x) => x.ok)) return checks;
  }
  // <<< SAP_BROWSER=extension
  let c: Connection;
  if (usesSapWindow(env)) {
    // Doctor starts nothing: it says whether the SAP window runs, and connects only to one that does.
    const status = await sapWindowStatus(env);
    if (!status.running) {
      if (!status.exe) {
        // The first sentence says what is wrong, the rest what to do.
        const [detail, ...fix] = (status.problem ?? "Google Chrome was not found on this machine.").split(/(?<=\.) /);
        return [{ ok: false, check, detail: (detail ?? "").replace(/\.$/, ""), fix: fix.join(" ") || "Install Google Chrome, or set SAP_CHROME_PATH." }];
      }
      return [
        { ok: true, check, detail: `found at ${status.exe}` },
        { ok: true, check: "SAP window", detail: `not running yet: it opens the first time the agent needs SAP, or run sap-ui-automation browser. Log on to SAP there once (profile ${status.profileDir})` },
      ];
    }
  }
  try {
    c = await chrome(env, { launch: false });
  } catch (e) {
    const message = (e as Error).message;
    if (extensionMode(env)) return [{ ok: false, check, detail: message }];
    if (env.SAP_CHROME_CDP)
      return [{ ok: false, check, detail: message.split(/(?<=\.) /)[0] ?? message, fix: "Check that this Chrome runs with --remote-debugging-port and --user-data-dir, or unset SAP_CHROME_CDP to use your everyday Chrome." }];
    if (usesSapWindow(env)) return [{ ok: false, check, detail: message, fix: "Close the SAP window (the Chrome that this server opened), then run sap-ui-automation browser." }];
    if (blockedFiles.length)
      return [
        {
          ok: false,
          check,
          detail: `Chrome may allow remote debugging, but macOS does not let this app read Chrome's DevToolsActivePort file (privacy protection), and the server cannot reach Chrome without it`,
          fix: `Give the app that runs the server (Terminal or iTerm for doctor; Claude, Codex or your editor for the MCP server) access in System Settings > Privacy & Security > Full Disk Access, restart that app, then run doctor again. Or set SAP_CHROME_CDP to ws://127.0.0.1:<port><path> from the two lines of that file (it changes each time Chrome starts).`,
        },
      ];
    const busy = await portOpen("127.0.0.1", 9222);
    return [
      {
        ok: false,
        check,
        detail: busy
          ? "something listens on 127.0.0.1:9222, but no Chrome has written its DevToolsActivePort file, so the server cannot tell it is your Chrome"
          : "no Chrome with remote debugging allowed is running (looked for Chrome, Chrome Beta and Edge)",
        fix: busy
          ? `If it is your Chrome: quit Chrome completely and open it again, then run doctor again. If it is a Chrome you started for testing: set SAP_CHROME_CDP=http://127.0.0.1:9222.`
          : `In Chrome ${MIN_CHROME_AUTO_CONNECT} or later, open chrome://inspect/#remote-debugging and tick "Allow remote debugging for this browser instance". Then run doctor again and click Allow when Chrome asks.`,
      },
    ];
  }
  const version = c.browser.version();
  const out = [{ ok: true, check, detail: `attached to Chrome ${version} through ${c.endpoint.from}` }];
  const major = Number(/^(\d+)\./.exec(version)?.[1] ?? NaN);
  if (!c.sapWindow && major < MIN_CHROME_AUTO_CONNECT)
    out.push({
      ok: true,
      check: "Chrome version",
      detail: `Chrome ${major} is older than ${MIN_CHROME_AUTO_CONNECT}: it cannot allow remote debugging from chrome://inspect, so it must be started with --remote-debugging-port (as it is now)${major >= MIN_CHROME_PORT_NEEDS_DATA_DIR ? "" : `; from Chrome ${MIN_CHROME_PORT_NEEDS_DATA_DIR} on, that switch also needs --user-data-dir`}.`,
    });
  const origins = allowedOrigins(env);
  if (origins) out.push({ ok: true, check: "Origins", detail: `only tabs of ${origins.join(", ")} are looked at (SAP_ALLOW_ORIGINS)` });
  const tabs = await chromeTabs(env).catch(() => []);
  out.push({ ok: true, check: "Chrome tabs", detail: tabs.length ? `${tabs.length} web page tab(s) open${origins ? " at these origins" : ""}` : "no web page open yet (Chrome's own pages, such as chrome://inspect, are not counted)" });
  return out;
}

/** Is a browser connected now? Doctor reads tabs only then: it must not start the SAP window by asking for them. */
export const chromeAttached = (): boolean => connection?.browser.isConnected() === true;

/**
 * What to tell the agent when no SAP session is found and the browser is the
 * SAP window: the user has to open SAP there and log on. undefined in attach
 * mode, with SAP_CHROME_CDP, and while no window is connected (the error of
 * the failed start says more then).
 */
export function noSessionHint(env: Record<string, string | undefined>): string | undefined {
  try {
    if (!usesSapWindow(env) || !connection?.sapWindow || !connection.browser.isConnected()) return undefined;
  } catch {
    return undefined;
  }
  return "The server has a Chrome window open for SAP (the SAP window), and no SAP screen is in it. Ask the user to open their SAP address in that window (Web GUI or the Fiori launchpad) and log on, then call sap_sessions again. This server never logs on.";
}

export interface OpenedWindow {
  /** true when Chrome was started by this call. */
  started: boolean;
  version: string;
  profileDir: string;
  /** The addresses of the tabs open in the window. */
  tabs: string[];
}

/**
 * `sap-ui-automation browser`: opens the SAP window, or brings it to the
 * front when it runs. Only for SAP_BROWSER=launch without SAP_CHROME_CDP.
 */
export async function openSapWindow(env: Record<string, string | undefined>): Promise<OpenedWindow> {
  if (!usesSapWindow(env)) throw new Error(env.SAP_CHROME_CDP?.trim() ? "SAP_CHROME_CDP is set: the server uses that Chrome and opens no window of its own." : "SAP_BROWSER=attach: the server uses your everyday Chrome and opens no window of its own.");
  const c = await chrome(env);
  if (!c.sapWindow) throw new Error("The SAP window could not be opened.");
  const opened = await ensureWindow(c, env);
  let pages = allPages(c.browser);
  // A window opened just now, or by Chrome's start, shows up a moment later.
  for (let i = 0; i < 30 && !pages.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pages = allPages(c.browser);
  }
  const front = pages.find((p) => originOf(p.url())) ?? pages[0];
  await front?.bringToFront().catch(() => {});
  return { started: c.sapWindow.launched || opened, version: c.browser.version(), profileDir: c.sapWindow.profileDir, tabs: pages.map((p) => p.url()) };
}
