/**
 * The user's Chrome, found without configuration, and its tabs.
 *
 * Order of attempts:
 * 1. `SAP_CHROME_CDP`, an http or ws DevTools endpoint, when set (nothing else is tried then);
 * 2. the running Chrome that allows remote debugging (Chrome 144+, switched on
 *    once at chrome://inspect/#remote-debugging). Chrome then writes its port
 *    and browser path to `DevToolsActivePort` in its user-data directory; we
 *    read that file for Chrome stable and beta, as chrome-devtools-mcp's
 *    `--autoConnect` (Puppeteer's `channel` connect) does, then for Microsoft
 *    Edge. In this mode Chrome serves no http endpoints (`/json/version`),
 *    only the WebSocket, and asks the user to allow each new connection: so
 *    we keep one connection.
 *
 * Nothing else is tried. In particular the server does not attach to
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

/** The name of the process listening on a local port (macOS and Linux, through lsof), if it can be told. */
export async function portOwner(port: number, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform === "win32") return undefined;
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fc"], { encoding: "utf8", timeout: 3000 });
  const name = /^c(.+)$/m.exec(r.stdout ?? "")?.[1];
  return name || undefined;
}

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
        // macOS privacy protection: the file is there, but this app may not read another app's data.
        // Chrome's remote debugging listens on 9222 by default: use it when Chrome's own process holds that port.
        blockedFiles.push(file);
        const owner = await portOwner(9222, platform);
        if (owner && /chrome|google|edge/i.test(owner)) {
          tried.push(`${file}: macOS does not let this app read it; ${owner} listens on 127.0.0.1:9222`);
          found.push({ url: "http://127.0.0.1:9222", from: `${name} with remote debugging allowed (port 9222; ${file} could not be read)` });
        } else tried.push(`${file}: macOS does not let this app read it`);
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

async function open(env: Env, key: string): Promise<Connection> {
  const tried: string[] = [];
  const errors: string[] = [];
  const attach = async (endpoint: ChromeEndpoint): Promise<Connection | undefined> => {
    try {
      const browser = await chromium.connectOverCDP(endpoint.url, { noDefaults: true, isLocal: true, timeout: CONNECT_TIMEOUT_MS });
      keepDialogs(browser);
      const c: Connection = { browser, endpoint, key };
      browser.on("disconnected", () => {
        if (connection === c) connection = undefined;
      });
      return c;
    } catch (e) {
      errors.push(`${endpoint.from}: ${(e as Error).message.split("\n")[0]}`);
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
  // 2. The running Chrome that allows remote debugging.
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

async function chrome(env: Env): Promise<Connection> {
  const key = env.SAP_CHROME_CDP?.trim() ?? "";
  if (connection?.key === key && connection.browser.isConnected()) return connection;
  if (connecting?.key === key) return connecting.promise;
  const mine = {
    key,
    promise: open(env, key).then(
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

/**
 * The tabs the server may look at, in the order the connection reports them:
 * http and https pages only (never chrome://, DevTools, extensions or the
 * new-tab page), and with SAP_ALLOW_ORIGINS only those origins. Ids and titles
 * are asked from all tabs at once. Throws, with the step to take, when no
 * Chrome can be reached.
 */
export async function chromeTabs(env: Record<string, string | undefined>): Promise<ChromeTab[]> {
  const allowed = allowedOrigins(env);
  const { browser } = await chrome(env);
  keepDialogs(browser);
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
export async function sapTabs(env: Record<string, string | undefined>): Promise<SapTab[]> {
  const tabs = await chromeTabs(env);
  const found = await Promise.all(
    tabs.map(async (tab): Promise<SapTab | undefined> => {
      const signs = await tabSigns(tab.page);
      const owner = classify(tab.page.url(), signs);
      if (owner) await emulateFocus(tab.page);
      return owner ? { tab, owner, signs } : undefined;
    }),
  );
  return found.filter((t) => t !== undefined);
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
}

/** Setup checks: is there a Chrome we can attach to, which version, how many tabs; when not, the one step to take. */
export async function chromeDoctor(env: Record<string, string | undefined>): Promise<DoctorCheck[]> {
  const check = "Chrome";
  let c: Connection;
  try {
    c = await chrome(env);
  } catch (e) {
    const message = (e as Error).message;
    if (env.SAP_CHROME_CDP)
      return [{ ok: false, check, detail: message.split(/(?<=\.) /)[0] ?? message, fix: "Check that this Chrome runs with --remote-debugging-port and --user-data-dir, or unset SAP_CHROME_CDP to use your everyday Chrome." }];
    if (blockedFiles.length)
      return [
        {
          ok: false,
          check,
          detail: `Chrome allows remote debugging, but macOS does not let this app read Chrome's DevToolsActivePort file (privacy protection), and Chrome did not answer on port 9222 without it`,
          fix: `Give the app that runs the server (Terminal or iTerm for doctor; Claude, Codex or your editor for the MCP server) access in System Settings > Privacy & Security > Full Disk Access, restart that app, then run doctor again.`,
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
  if (major < MIN_CHROME_AUTO_CONNECT)
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
