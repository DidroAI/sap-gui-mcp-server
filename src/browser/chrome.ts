/**
 * The user's Chrome, found without configuration, and its tabs.
 *
 * Order of attempts:
 * 1. `SAP_CHROME_CDP`, an http or ws DevTools endpoint, when set (nothing else is tried then);
 * 2. the running Chrome that allows remote debugging (Chrome 144+, switched on
 *    once at chrome://inspect/#remote-debugging). Chrome then writes its port
 *    and browser path to `DevToolsActivePort` in its user-data directory; we
 *    read that file for the stable and beta channels, as chrome-devtools-mcp's
 *    `--autoConnect` (Puppeteer's `channel` connect) does. In this mode Chrome
 *    serves no http endpoints (`/json/version`), only the WebSocket, and asks
 *    the user to allow each new connection: so we keep one connection;
 * 3. `http://127.0.0.1:9222`, when a DevTools endpoint answers there
 *    (Chrome started with `--remote-debugging-port=9222`).
 *
 * The connection is Playwright's `connectOverCDP` with `noDefaults`, so the
 * user's browser keeps its own settings. We never close the browser: we only
 * disconnect.
 */
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

export interface ChromeTab {
  /** The CDP target id, stable for the life of the tab. */
  id: string;
  title: string;
  url: string;
  page: Page;
}

type Env = Record<string, string | undefined>;

/** Chrome's remote debugging switch at chrome://inspect/#remote-debugging exists since this version. */
export const MIN_CHROME_AUTO_CONNECT = 144;
const DEFAULT_PORT_URL = "http://127.0.0.1:9222";

const HOW_TO_ALLOW = `In Chrome ${MIN_CHROME_AUTO_CONNECT} or newer, open chrome://inspect/#remote-debugging and tick "Allow remote debugging for this browser instance"; Chrome then asks you to allow the connection. (Or start Chrome with --remote-debugging-port=9222 and a --user-data-dir of its own, or set SAP_CHROME_CDP to a DevTools endpoint.)`;

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

async function answersDevTools(httpUrl: string, timeoutMs = 600): Promise<boolean> {
  try {
    const u = new URL(httpUrl);
    u.pathname = `${u.pathname.replace(/\/?$/, "")}/json/version`;
    const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok && typeof ((await r.json()) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
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
 * Running Chromes that allow remote debugging, from the `DevToolsActivePort`
 * file of the stable and beta channels. Reads files and checks that the port
 * listens; connects to nothing. `tried` says what was looked at, for messages.
 */
export async function activePortEndpoints(env: Env, tried: string[] = [], platform: NodeJS.Platform = process.platform): Promise<ChromeEndpoint[]> {
  const found: ChromeEndpoint[] = [];
  for (const channel of ["stable", "beta"] as const) {
    const dir = chromeUserDataDir(platform, channel, env);
    if (!dir) continue;
    const file = (platform === "win32" ? win32 : posix).join(dir, "DevToolsActivePort");
    const content = await readFile(file, "utf8").catch(() => undefined);
    if (content === undefined) {
      tried.push(`${file}: not there (Chrome ${channel} is not running, or remote debugging is not allowed)`);
      continue;
    }
    const url = parseDevToolsActivePort(content);
    if (!url) {
      tried.push(`${file}: unreadable content`);
      continue;
    }
    // A Chrome that crashed leaves the file behind: nothing listens on its port then.
    if (!(await portOpen("127.0.0.1", Number(new URL(url).port)))) {
      tried.push(`${file}: names port ${new URL(url).port}, where nothing listens (left by an earlier Chrome)`);
      continue;
    }
    tried.push(`${file}: port ${new URL(url).port}`);
    found.push({ url, from: `Chrome ${channel} with remote debugging allowed (${file})` });
  }
  return found;
}

/** The classic debugging port, when a DevTools endpoint answers there. */
async function defaultPortEndpoint(tried: string[]): Promise<ChromeEndpoint | undefined> {
  if (await answersDevTools(DEFAULT_PORT_URL)) {
    tried.push(`${DEFAULT_PORT_URL}: answers`);
    return { url: DEFAULT_PORT_URL, from: `the debugging port at ${DEFAULT_PORT_URL}` };
  }
  tried.push(`${DEFAULT_PORT_URL}: no DevTools endpoint`);
  return undefined;
}

interface Connection {
  browser: Browser;
  endpoint: ChromeEndpoint;
  key: string;
}
let connection: Connection | undefined;
let connecting: { key: string; promise: Promise<Connection> } | undefined;
const targetIds = new WeakMap<Page, string>();

/** The time the user has to answer Chrome's "Allow remote debugging?" prompt. */
const CONNECT_TIMEOUT_MS = 45_000;

async function open(env: Env, key: string): Promise<Connection> {
  const tried: string[] = [];
  const errors: string[] = [];
  const attach = async (endpoint: ChromeEndpoint): Promise<Connection | undefined> => {
    try {
      const browser = await chromium.connectOverCDP(endpoint.url, { noDefaults: true, isLocal: true, timeout: CONNECT_TIMEOUT_MS });
      // Playwright dismisses JavaScript dialogs (alert, confirm, "Leave site?") when nobody listens.
      // This is the user's browser: with a listener that does nothing, their dialogs stay for them to answer.
      for (const context of browser.contexts()) context.on("dialog", () => {});
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
  // 3. The classic debugging port.
  const fallback = await defaultPortEndpoint(tried);
  const c = fallback && (await attach(fallback));
  if (c) return c;
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

/** The tab's title; "" for a tab Chrome has frozen or discarded, which never answers. */
function titleOf(page: Page): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), 1500);
  });
  return Promise.race([page.title().catch(() => ""), late]).finally(() => clearTimeout(timer));
}

/** Pages that are the browser's own (settings, DevTools, extensions, the new-tab page) are not tabs to read. */
const INTERNAL = /^(chrome|chrome-untrusted|devtools|chrome-extension|chrome-search|edge|about):/;

/** The tabs open in the user's Chrome, in the browser's order. Throws, with the step to take, when no Chrome can be reached. */
export async function chromeTabs(env: Record<string, string | undefined>): Promise<ChromeTab[]> {
  const { browser } = await chrome(env);
  const tabs: ChromeTab[] = [];
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const url = page.url();
      if (!url || INTERNAL.test(url)) continue;
      const id = await targetId(page);
      if (!id) continue;
      tabs.push({ id, title: await titleOf(page), url, page });
    }
  return tabs;
}

/** Drops the connection. The browser and its tabs stay as they are. */
export async function disconnectChrome(): Promise<void> {
  const c = connection;
  connection = undefined;
  // On a browser reached with connectOverCDP, close() disconnects; it does not end the browser.
  if (c?.browser.isConnected()) await c.browser.close().catch(() => {});
}

/** Setup checks: is there a Chrome we can attach to, which version, how many tabs; when not, the one step to take. */
export async function chromeDoctor(env: Record<string, string | undefined>): Promise<{ ok: boolean; check: string; detail: string }[]> {
  const check = "Chrome";
  let c: Connection;
  try {
    c = await chrome(env);
  } catch (e) {
    return [{ ok: false, check, detail: (e as Error).message }];
  }
  const version = c.browser.version();
  const out = [{ ok: true, check, detail: `attached to Chrome ${version} through ${c.endpoint.from}` }];
  const major = Number(/^(\d+)\./.exec(version)?.[1] ?? NaN);
  if (major < MIN_CHROME_AUTO_CONNECT)
    out.push({
      ok: true,
      check: "Chrome version",
      detail: `Chrome ${major} is older than ${MIN_CHROME_AUTO_CONNECT}: it cannot allow remote debugging from chrome://inspect, so it must be started with --remote-debugging-port (as it is now).`,
    });
  const tabs = await chromeTabs(env).catch(() => []);
  out.push({ ok: true, check: "Chrome tabs", detail: `${tabs.length} tab(s) open` });
  return out;
}
