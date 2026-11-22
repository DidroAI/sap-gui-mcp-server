/**
 * The SAP window: a Chrome the server starts itself, so that the user sets
 * nothing up in Chrome (no chrome://inspect, no --remote-debugging-port).
 *
 * `SAP_BROWSER=launch` (the default) starts the installed Google Chrome with
 * a profile directory of the server's own and a DevTools port that Chrome
 * chooses (`--remote-debugging-port=0`). Chrome writes the port and its
 * browser path to `DevToolsActivePort` in that directory; the server reads
 * the file, as it does for the user's everyday Chrome in attach mode.
 *
 * - Chrome is started detached and is never closed by the server: every new
 *   agent session starts a new server process, and the SAP logon must stay.
 * - A server that starts while the window runs finds it through the same file
 *   and connects to it. A file left by a Chrome that has ended is not
 *   believed: its port must answer as that Chrome (`/json/version`).
 * - Two servers that start at the same moment both start Chrome; Chrome's own
 *   profile lock makes the second one hand over to the first and end, and
 *   both servers read the first one's port.
 * - The window opens on the last SAP address the server saw in it (kept in a
 *   small JSON file next to the profile), else on `SAP_START_URL`, else on a
 *   local page that says what to do.
 *
 * `SAP_BROWSER=attach` is the other mode: the user's everyday Chrome, found
 * as before (see chrome.ts). `SAP_CHROME_CDP`, when set, wins over both.
 *
 * Nothing here talks CDP: this file finds Chrome, starts it and names its
 * endpoint. chrome.ts connects.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { NotOpenYet } from "../core/types.js";
import { originOf } from "./classify.js";

type Env = Record<string, string | undefined>;

export type BrowserMode = "launch" | "attach";

/** `SAP_BROWSER`: launch (default) or attach. */
export function browserMode(env: Env): BrowserMode {
  const raw = (env.SAP_BROWSER ?? "").trim().toLowerCase();
  if (!raw || raw === "launch") return "launch";
  if (raw === "attach") return "attach";
  throw new Error(`SAP_BROWSER must be launch or attach (got "${env.SAP_BROWSER}")`);
}

const paths = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Where an installed Google Chrome can be, most likely first. On Linux, Chromium after Chrome. */
export function chromeCandidates(platform: NodeJS.Platform, env: Env, home: string = homedir()): string[] {
  if (platform === "darwin") {
    const app = posix.join("Google Chrome.app", "Contents", "MacOS", "Google Chrome");
    return [posix.join("/Applications", app), posix.join(home, "Applications", app)];
  }
  if (platform === "win32") {
    const tail = ["Google", "Chrome", "Application", "chrome.exe"];
    const roots = [env.PROGRAMFILES || "C:\\Program Files", env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", env.LOCALAPPDATA || win32.join(home, "AppData", "Local")];
    return [...new Set(roots.map((r) => win32.join(r, ...tail)))];
  }
  // Linux and the like: the names on PATH, then the usual folders (a client started from the desktop may have a short PATH).
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), "/usr/bin", "/usr/local/bin", "/snap/bin"];
  const out = names.flatMap((n) => dirs.map((d) => posix.join(d, n)));
  out.push("/opt/google/chrome/chrome");
  return [...new Set(out)];
}

/** The Chrome to start: `SAP_CHROME_PATH` when set (it must exist), else the first candidate that exists. Throws with the step to take. */
export function findChrome(platform: NodeJS.Platform, env: Env, home: string = homedir(), exists: (path: string) => boolean = existsSync): string {
  const named = env.SAP_CHROME_PATH?.trim();
  if (named) {
    if (!exists(named)) throw new Error(`SAP_CHROME_PATH names ${named}, which does not exist. Set it to the Chrome program file, or unset it to let the server find Google Chrome.`);
    return named;
  }
  const found = chromeCandidates(platform, env, home).find(exists);
  if (found) return found;
  throw new Error(
    `Google Chrome was not found on this machine. Install Google Chrome (https://www.google.com/chrome/), or set SAP_CHROME_PATH to the program file of a Chrome or Chromium. To use a browser that already runs, set SAP_BROWSER=attach.`,
  );
}

/** The profile directory of the SAP window: `SAP_CHROME_PROFILE` when set, else a folder of the server's own. */
export function sapProfileDir(platform: NodeJS.Platform, env: Env, home: string = homedir()): string {
  const named = env.SAP_CHROME_PROFILE?.trim();
  if (named) return named;
  const app = "sap-gui-mcp-server";
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), app, "chrome");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", app, "chrome");
  return posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), app, "chrome");
}

/** The small JSON file next to the profile directory: the last SAP address seen in the window. */
export const stateFile = (profileDir: string): string => `${profileDir.replace(/[\\/]+$/, "")}.json`;
/** The local start page, next to the profile directory. */
export const startPageFile = (profileDir: string): string => `${profileDir.replace(/[\\/]+$/, "")}-start.html`;

export const START_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>SAP window</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 12vh auto; max-width: 34em; padding: 0 1.5em; color: #1d2d3e; }
  h1 { font-size: 1.4em; }
  p { margin: 0.8em 0; }
  small { color: #556b82; }
</style>
<h1>SAP window</h1>
<p>Open your SAP system here (Web GUI or Fiori launchpad address) and log on.</p>
<p>The agent works on the SAP screen in this window.</p>
<p><small>Opened by sap-gui-mcp-server. It never logs on and never types a password. You can close this window when you are done.</small></p>
</html>
`;

/**
 * The part of a SAP address worth opening again: origin and path, with the
 * client and the language. The rest of the query and the hash are dropped
 * (they name a transaction, an app or a session, not the system).
 */
export function startAddressOf(url: string): string | undefined {
  if (!originOf(url)) return undefined;
  const u = new URL(url);
  const keep = new URLSearchParams();
  for (const k of ["sap-client", "sap-language"]) {
    const v = u.searchParams.get(k);
    if (v) keep.set(k, v);
  }
  const q = keep.toString();
  return `${u.origin}${u.pathname}${q ? `?${q}` : ""}`;
}

/** The last SAP address the server saw in the window, if the file holds one. */
export async function lastSapAddress(profileDir: string): Promise<string | undefined> {
  try {
    const state = JSON.parse(await readFile(stateFile(profileDir), "utf8")) as { lastSapUrl?: unknown };
    return typeof state.lastSapUrl === "string" && originOf(state.lastSapUrl) ? state.lastSapUrl : undefined;
  } catch {
    return undefined;
  }
}

const remembered = new Map<string, string>();

/** Keeps the address of a SAP tab of the window for the next start. Writes only when it changed; never throws. */
export async function rememberSapAddress(profileDir: string, url: string): Promise<void> {
  const address = startAddressOf(url);
  if (!address || remembered.get(profileDir) === address) return;
  remembered.set(profileDir, address);
  try {
    await writeFile(stateFile(profileDir), `${JSON.stringify({ lastSapUrl: address }, null, 2)}\n`);
  } catch {
    remembered.delete(profileDir);
  }
}

/** What the window opens on: the last SAP address, else SAP_START_URL, else the local start page (written here). */
export async function startUrl(env: Env, profileDir: string): Promise<string> {
  const last = await lastSapAddress(profileDir);
  if (last) return last;
  const named = env.SAP_START_URL?.trim();
  if (named) {
    if (!originOf(named)) throw new Error(`SAP_START_URL must be an http or https address (got "${named}")`);
    return named;
  }
  const file = startPageFile(profileDir);
  await mkdir(paths(process.platform).dirname(file), { recursive: true });
  await writeFile(file, START_PAGE);
  return pathToFileURL(file).href;
}

/** `DevToolsActivePort`: the port on the first line, the browser's WebSocket path on the second. */
function parseActivePort(content: string): { port: number; path: string } | undefined {
  const [rawPort, rawPath] = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!rawPort || !rawPath || !/^\d+$/.test(rawPort) || !rawPath.startsWith("/")) return undefined;
  const port = Number(rawPort);
  return port > 0 && port <= 65535 ? { port, path: rawPath } : undefined;
}

export interface SapWindowEndpoint {
  /** ws://127.0.0.1:<port>/devtools/browser/<id> */
  url: string;
  port: number;
}

/**
 * The endpoint of the Chrome that runs on this profile directory, or
 * undefined: no `DevToolsActivePort`, or one left by a Chrome that has ended.
 * The port must answer `/json/version` with the browser path the file names,
 * so a port that another program took over since is not mistaken for Chrome.
 */
export async function runningSapWindow(profileDir: string, platform: NodeJS.Platform = process.platform): Promise<SapWindowEndpoint | undefined> {
  let content: string;
  try {
    content = await readFile(paths(platform).join(profileDir, "DevToolsActivePort"), "utf8");
  } catch {
    return undefined;
  }
  const named = parseActivePort(content);
  if (!named) return undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${named.port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return undefined;
    const version = (await r.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof version.webSocketDebuggerUrl !== "string" || new URL(version.webSocketDebuggerUrl).pathname !== named.path) return undefined;
  } catch {
    return undefined;
  }
  return { url: `ws://127.0.0.1:${named.port}${named.path}`, port: named.port };
}

/** The switches Chrome is started with. No --enable-automation: the window shows no "controlled by automated test software" bar. */
export function chromeArgs(env: Env, profileDir: string, url: string): string[] {
  const extra = (env.SAP_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean);
  return [`--user-data-dir=${profileDir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", ...extra, url];
}

/** A started Chrome, as much as the launcher needs of it. */
export interface Started {
  /** Resolves with the exit code when the process ends, and rejects when it could not be started. */
  exited: Promise<number | null>;
}
export type Starter = (exe: string, args: string[]) => Started;

/** Starts Chrome detached, with no pipes to this process: it lives on when the server ends. */
export const startDetached: Starter = (exe, args) => {
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  child.unref();
  return { exited };
};

export interface LaunchOptions {
  platform?: NodeJS.Platform;
  home?: string;
  start?: Starter;
  exists?: (path: string) => boolean;
  /** How long Chrome has to write its port. */
  timeoutMs?: number;
  /** false: only a window that runs already is used; none is started (doctor). */
  launch?: boolean;
  /** How long after Chrome's process ended its port is still waited for (a Chrome that handed over to a running one). */
  graceMs?: number;
}

export interface SapWindow extends SapWindowEndpoint {
  profileDir: string;
  /** true when this call started Chrome; false when the window ran already. */
  launched: boolean;
}

/** Said when a call that must not start Chrome finds no SAP window. */
export const NOT_RUNNING = "The SAP window is not running.";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The SAP window's endpoint: the Chrome that already runs on the profile
 * directory, else a Chrome started now. Throws with the step to take when
 * Chrome is not installed, cannot start, or does not open its port.
 */
export async function ensureSapWindow(env: Env, options: LaunchOptions = {}): Promise<SapWindow> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const profileDir = sapProfileDir(platform, env, home);
  const running = await runningSapWindow(profileDir, platform);
  if (running) return { ...running, profileDir, launched: false };
  if (options.launch === false) throw new NotOpenYet(NOT_RUNNING);

  const exe = findChrome(platform, env, home, options.exists);
  await mkdir(profileDir, { recursive: true });
  const url = await startUrl(env, profileDir);
  let ended: { code: number | null; at: number } | undefined;
  let failed: Error | undefined;
  (options.start ?? startDetached)(exe, chromeArgs(env, profileDir, url)).exited.then(
    (code) => {
      ended = { code, at: Date.now() };
    },
    (e: unknown) => {
      failed = e as Error;
    },
  );

  const timeoutMs = options.timeoutMs ?? 30_000;
  const graceMs = options.graceMs ?? 4000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const up = await runningSapWindow(profileDir, platform);
    if (up) return { ...up, profileDir, launched: true };
    if (failed) throw new Error(`Chrome could not be started (${exe}): ${failed.message}. Set SAP_CHROME_PATH to the program file of your Chrome.`);
    if (ended && Date.now() - ended.at > graceMs) {
      if (ended.code === 0)
        throw new Error(
          `Chrome started and ended at once without opening the SAP window's port. A Chrome that this server cannot reach may already use the profile ${profileDir}: close that Chrome window, then try again.`,
        );
      throw new Error(
        `Chrome ended at once (exit code ${ended.code ?? "none"}) and opened no window. Start it by hand to see why: "${exe}" --user-data-dir="${profileDir}". On a machine without a screen Chrome cannot open a window.`,
      );
    }
    if (Date.now() > deadline) throw new Error(`Chrome was started (${exe}) but did not open the SAP window within ${Math.round(timeoutMs / 1000)} s. Look for a Chrome window that waits for an answer, then try again.`);
    await sleep(100);
  }
}

export interface SapWindowStatus {
  profileDir: string;
  /** The Chrome that would be started; undefined when none is found (see `problem`). */
  exe?: string;
  problem?: string;
  /** The window, when it runs now. */
  running?: SapWindowEndpoint;
}

/** What doctor says about the SAP window. Starts nothing. */
export async function sapWindowStatus(env: Env, options: Pick<LaunchOptions, "platform" | "home" | "exists"> = {}): Promise<SapWindowStatus> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const profileDir = sapProfileDir(platform, env, home);
  const out: SapWindowStatus = { profileDir };
  try {
    out.exe = findChrome(platform, env, home, options.exists);
  } catch (e) {
    out.problem = (e as Error).message;
  }
  const running = await runningSapWindow(profileDir, platform);
  if (running) out.running = running;
  return out;
}
