/**
 * The SAP window (SAP_BROWSER=launch): where Chrome and its profile are, when a
 * running window is used again and when Chrome is started, and that doctor and
 * SAP_CHROME_CDP start nothing. Chrome is played by a small HTTP server that
 * answers /json/version, and by a starter that writes DevToolsActivePort.
 *
 * With SAP_TEST_CHROME=/path/to/chrome the last block starts a real Chrome.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromeDoctor, chromeTabs, disconnectChrome, noSessionHint, openSapWindow } from "../src/browser/chrome.js";
import {
  browserMode,
  chromeArgs,
  chromeCandidates,
  ensureSapWindow,
  findChrome,
  lastSapAddress,
  rememberSapAddress,
  runningSapWindow,
  sapProfileDir,
  sapWindowStatus,
  startAddressOf,
  startUrl,
  type Starter,
  stateFile,
} from "../src/browser/launch.js";
import { policyFromEnv } from "../src/core/guard.js";
import { Registry } from "../src/core/registry.js";
import { NotOpenYet, type SessionInfo, type Surface } from "../src/core/types.js";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sap-gui-mcp-launch-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A "Chrome": answers /json/version with the browser path it was given. */
function fakeChrome(path = "/devtools/browser/fake"): { port: number; path: string; stop: () => void } {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req): Response => (new URL(req.url).pathname === "/json/version" ? Response.json({ Browser: "Chrome/150.0.0.0", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}${path}` }) : new Response("no", { status: 404 })),
  });
  const stop = () => server.stop(true);
  cleanups.push(stop);
  return { port: server.port as number, path, stop };
}

const never = new Promise<number | null>(() => {});

describe("SAP_BROWSER", () => {
  test("launch is the default; attach is the other mode; anything else is refused", () => {
    expect(browserMode({})).toBe("launch");
    expect(browserMode({ SAP_BROWSER: " Launch " })).toBe("launch");
    expect(browserMode({ SAP_BROWSER: "attach" })).toBe("attach");
    expect(() => browserMode({ SAP_BROWSER: "firefox" })).toThrow("SAP_BROWSER must be launch or attach");
  });
});

describe("finding the installed Chrome", () => {
  test("macOS: /Applications, then the user's Applications", () => {
    expect(chromeCandidates("darwin", {}, "/Users/u")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
    expect(findChrome("darwin", {}, "/Users/u", (p) => p.startsWith("/Users/u/"))).toBe("/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });
  test("Windows: Program Files, Program Files (x86), then the user's LOCALAPPDATA", () => {
    const env = { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
    expect(chromeCandidates("win32", env, "C:\\Users\\u")).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ]);
    // Without the variables: the usual folders.
    expect(chromeCandidates("win32", {}, "C:\\Users\\u")).toContain("C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
    expect(findChrome("win32", env, "C:\\Users\\u", (p) => p.includes("AppData"))).toBe("C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
  });
  test("Linux: google-chrome, google-chrome-stable, then chromium, on PATH and in the usual folders", () => {
    const c = chromeCandidates("linux", { PATH: "/opt/bin:/usr/bin" }, "/home/u");
    expect(c[0]).toBe("/opt/bin/google-chrome");
    expect(c.indexOf("/usr/bin/google-chrome-stable")).toBeLessThan(c.indexOf("/opt/bin/chromium"));
    expect(c).toContain("/snap/bin/chromium");
    expect(c).toContain("/opt/google/chrome/chrome");
    expect(findChrome("linux", { PATH: "/opt/bin" }, "/home/u", (p) => p === "/usr/bin/chromium-browser")).toBe("/usr/bin/chromium-browser");
  });
  test("SAP_CHROME_PATH wins, and must exist", () => {
    expect(findChrome("linux", { SAP_CHROME_PATH: "/x/chrome" }, "/home/u", () => true)).toBe("/x/chrome");
    expect(() => findChrome("linux", { SAP_CHROME_PATH: "/x/chrome" }, "/home/u", (p) => p !== "/x/chrome")).toThrow("SAP_CHROME_PATH names /x/chrome, which does not exist");
  });
  test("no Chrome: the error says to install it or to set SAP_CHROME_PATH", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const e = (() => {
        try {
          return findChrome(platform, {}, "/home/u", () => false);
        } catch (x) {
          return (x as Error).message;
        }
      })();
      expect(e).toContain("Google Chrome was not found");
      expect(e).toContain("Install Google Chrome");
      expect(e).toContain("SAP_CHROME_PATH");
    }
  });
});

describe("the profile directory of the SAP window", () => {
  test("per platform", () => {
    expect(sapProfileDir("darwin", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/sap-gui-mcp-server/chrome");
    expect(sapProfileDir("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Local\\sap-gui-mcp-server\\chrome");
    expect(sapProfileDir("win32", {}, "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Local\\sap-gui-mcp-server\\chrome");
    expect(sapProfileDir("linux", {}, "/home/u")).toBe("/home/u/.local/share/sap-gui-mcp-server/chrome");
    expect(sapProfileDir("linux", { XDG_DATA_HOME: "/data" }, "/home/u")).toBe("/data/sap-gui-mcp-server/chrome");
  });
  test("SAP_CHROME_PROFILE names another one", () => {
    expect(sapProfileDir("linux", { SAP_CHROME_PROFILE: "/tmp/p" }, "/home/u")).toBe("/tmp/p");
  });
  test("it is never Chrome's own default directory", () => {
    expect(sapProfileDir("darwin", {}, "/Users/u")).not.toContain("Google");
    expect(sapProfileDir("linux", {}, "/home/u")).not.toContain("google-chrome");
  });
  test("the state file lies next to it", () => {
    expect(stateFile("/data/sap-gui-mcp-server/chrome")).toBe("/data/sap-gui-mcp-server/chrome.json");
    expect(stateFile("C:\\x\\chrome\\")).toBe("C:\\x\\chrome.json");
  });
});

describe("the start address", () => {
  test("a SAP address is kept without its transaction, app or session", () => {
    expect(startAddressOf("https://h:44300/sap/bc/gui/sap/its/webgui?sap-client=800&sap-language=EN&~transaction=VA03&x=1#frag")).toBe("https://h:44300/sap/bc/gui/sap/its/webgui?sap-client=800&sap-language=EN");
    expect(startAddressOf("https://h/sap/bc/ui2/flp#SalesOrder-manage")).toBe("https://h/sap/bc/ui2/flp");
    expect(startAddressOf("chrome://newtab")).toBeUndefined();
  });
  test("the last SAP address, else SAP_START_URL, else the local start page", async () => {
    const profile = join(await tempDir(), "chrome");
    const page = await startUrl({}, profile);
    expect(page).toMatch(/^file:\/\/.*chrome-start\.html$/);
    const html = await readFile(new URL(page), "utf8");
    expect(html).toContain("Open your SAP system here (Web GUI or Fiori launchpad address) and log on.");
    expect(html).toContain("The agent works on the SAP screen in this window.");
    expect(await startUrl({ SAP_START_URL: "https://h/sap/bc/ui2/flp" }, profile)).toBe("https://h/sap/bc/ui2/flp");
    await expect(startUrl({ SAP_START_URL: "javascript:alert(1)" }, profile)).rejects.toThrow("SAP_START_URL must be an http or https address");
    await rememberSapAddress(profile, "http://h:8010/sap/bc/gui/sap/its/webgui?sap-client=800&~okcode=x");
    expect(await lastSapAddress(profile)).toBe("http://h:8010/sap/bc/gui/sap/its/webgui?sap-client=800");
    expect(await startUrl({ SAP_START_URL: "https://h/sap/bc/ui2/flp" }, profile)).toBe("http://h:8010/sap/bc/gui/sap/its/webgui?sap-client=800");
  });
  test("a broken state file is no address", async () => {
    const profile = join(await tempDir(), "chrome");
    await writeFile(stateFile(profile), '{"lastSapUrl":"file:///etc/passwd"}');
    expect(await lastSapAddress(profile)).toBeUndefined();
    await writeFile(stateFile(profile), "not json");
    expect(await lastSapAddress(profile)).toBeUndefined();
  });
});

describe("Chrome's switches", () => {
  test("its own profile, a port Chrome chooses, no first-run pages, no automation bar", () => {
    const args = chromeArgs({}, "/p", "https://h/");
    expect(args).toEqual(["--user-data-dir=/p", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "https://h/"]);
    expect(args.join(" ")).not.toContain("enable-automation");
    expect(chromeArgs({ SAP_CHROME_ARGS: "--headless=new  --no-sandbox" }, "/p", "u").slice(4)).toEqual(["--headless=new", "--no-sandbox", "u"]);
  });
});

describe("the window that runs is used again; else Chrome is started", () => {
  const env = (profile: string) => ({ SAP_CHROME_PROFILE: profile, SAP_CHROME_PATH: "/fake/chrome" });
  const exists = () => true;

  test("a DevToolsActivePort whose port answers as that Chrome: no start", async () => {
    const profile = await tempDir();
    const chrome = fakeChrome();
    await writeFile(join(profile, "DevToolsActivePort"), `${chrome.port}\n${chrome.path}\n`);
    let starts = 0;
    const w = await ensureSapWindow(env(profile), { exists, start: () => (starts++, { exited: never }) });
    expect(w).toEqual({ url: `ws://127.0.0.1:${chrome.port}${chrome.path}`, port: chrome.port, profileDir: profile, launched: false });
    expect(starts).toBe(0);
  });

  test("no file: Chrome is started with the profile, and its port is read when it appears", async () => {
    const profile = join(await tempDir(), "sub", "chrome");
    const chrome = fakeChrome("/devtools/browser/new");
    const calls: { exe: string; args: string[] }[] = [];
    const start: Starter = (exe, args) => {
      calls.push({ exe, args });
      setTimeout(() => void writeFile(join(profile, "DevToolsActivePort"), `${chrome.port}\n${chrome.path}\n`), 150);
      return { exited: never };
    };
    const w = await ensureSapWindow(env(profile), { exists, start });
    expect(w.launched).toBe(true);
    expect(w.url).toBe(`ws://127.0.0.1:${chrome.port}/devtools/browser/new`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.exe).toBe("/fake/chrome");
    expect(calls[0]?.args[0]).toBe(`--user-data-dir=${profile}`);
    expect(calls[0]?.args).toContain("--remote-debugging-port=0");
    expect(calls[0]?.args.at(-1)).toMatch(/^file:.*chrome-start\.html$/);
  });

  test("a stale file (its Chrome has ended): Chrome is started again", async () => {
    const profile = await tempDir();
    await writeFile(join(profile, "DevToolsActivePort"), "1\n/devtools/browser/old\n");
    expect(await runningSapWindow(profile)).toBeUndefined();
    const chrome = fakeChrome("/devtools/browser/again");
    let starts = 0;
    const start: Starter = () => {
      starts++;
      void writeFile(join(profile, "DevToolsActivePort"), `${chrome.port}\n${chrome.path}\n`);
      return { exited: never };
    };
    const w = await ensureSapWindow(env(profile), { exists, start });
    expect(starts).toBe(1);
    expect(w.launched).toBe(true);
    expect(w.port).toBe(chrome.port);
  });

  test("a port that another program took over is not believed", async () => {
    const profile = await tempDir();
    const other = fakeChrome("/devtools/browser/someone-else");
    await writeFile(join(profile, "DevToolsActivePort"), `${other.port}\n/devtools/browser/old\n`);
    expect(await runningSapWindow(profile)).toBeUndefined();
  });

  test("the window opens on the last SAP address", async () => {
    const profile = await tempDir();
    await rememberSapAddress(profile, "https://h/sap/bc/ui2/flp?sap-client=100#Shell-home");
    const chrome = fakeChrome();
    let url: string | undefined;
    const start: Starter = (_exe, args) => {
      url = args.at(-1);
      void writeFile(join(profile, "DevToolsActivePort"), `${chrome.port}\n${chrome.path}\n`);
      return { exited: never };
    };
    await ensureSapWindow(env(profile), { exists, start });
    expect(url).toBe("https://h/sap/bc/ui2/flp?sap-client=100");
  });

  test("a second Chrome that hands over to the running one and ends: the running one's port is read", async () => {
    // Chrome's profile lock: the process we started ends with 0, and the Chrome that holds the profile has the port.
    const profile = await tempDir();
    const chrome = fakeChrome();
    const start: Starter = () => {
      setTimeout(() => void writeFile(join(profile, "DevToolsActivePort"), `${chrome.port}\n${chrome.path}\n`), 300);
      return { exited: Promise.resolve(0) };
    };
    const w = await ensureSapWindow(env(profile), { exists, start, graceMs: 2000 });
    expect(w.port).toBe(chrome.port);
  });

  test("it hands over to a Chrome that opened no port: the error says to close that window", async () => {
    const profile = await tempDir();
    const e = await ensureSapWindow(env(profile), { exists, start: () => ({ exited: Promise.resolve(0) }), graceMs: 200 }).catch((x: Error) => x.message);
    expect(e).toContain("may already use the profile");
    expect(e).toContain("close that Chrome window");
  });

  test("Chrome ends with an error, cannot be started, or never opens its port", async () => {
    const profile = await tempDir();
    const crashed = await ensureSapWindow(env(profile), { exists, start: () => ({ exited: Promise.resolve(1) }), graceMs: 100 }).catch((x: Error) => x.message);
    expect(crashed).toContain("Chrome ended at once (exit code 1)");
    const missing = await ensureSapWindow(env(profile), { exists, start: () => ({ exited: Promise.reject(new Error("spawn /fake/chrome ENOENT")) }) }).catch((x: Error) => x.message);
    expect(missing).toContain("Chrome could not be started (/fake/chrome): spawn /fake/chrome ENOENT");
    const silent = await ensureSapWindow(env(profile), { exists, start: () => ({ exited: never }), timeoutMs: 300 }).catch((x: Error) => x.message);
    expect(silent).toContain("did not open the SAP window within");
  });

  test("no Chrome installed: nothing is started, and the error says what to do", async () => {
    const profile = await tempDir();
    let starts = 0;
    const e = await ensureSapWindow({ SAP_CHROME_PROFILE: profile }, { platform: "linux", exists: () => false, start: () => (starts++, { exited: never }) }).catch((x: Error) => x.message);
    expect(e).toContain("Google Chrome was not found");
    expect(starts).toBe(0);
  });

  test("launch: false starts nothing and says NotOpenYet", async () => {
    const profile = await tempDir();
    let starts = 0;
    const e = await ensureSapWindow(env(profile), { exists, launch: false, start: () => (starts++, { exited: never }) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotOpenYet);
    expect(starts).toBe(0);
  });
});

/** A program that leaves a mark when it is run: the tests below prove that it was not. */
async function markerChrome(): Promise<{ exe: string; ran: () => boolean; profile: string }> {
  const dir = await tempDir();
  const exe = join(dir, "chrome.sh");
  const mark = join(dir, "started");
  await writeFile(exe, `#!/bin/sh\ntouch "${mark}"\n`);
  await chmod(exe, 0o755);
  return { exe, ran: () => existsSync(mark), profile: join(dir, "profile") };
}

describe("what starts no Chrome", () => {
  test("doctor: it says that the window is not running yet, and how it opens", async () => {
    const m = await markerChrome();
    const env = { SAP_CHROME_PATH: m.exe, SAP_CHROME_PROFILE: m.profile };
    const checks = await chromeDoctor(env);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks[0]?.detail).toBe(`found at ${m.exe}`);
    expect(checks[1]?.check).toBe("SAP window");
    expect(checks[1]?.detail).toContain("not running yet: it opens the first time the agent needs SAP, or run sap-gui-mcp-server browser");
    expect(m.ran()).toBe(false);
    expect(existsSync(m.profile)).toBe(false);
    expect((await sapWindowStatus(env)).running).toBeUndefined();
  });

  test("doctor without a Chrome: not ok, with the step to take", async () => {
    const m = await markerChrome();
    const checks = await chromeDoctor({ SAP_CHROME_PATH: join(m.profile, "nope"), SAP_CHROME_PROFILE: m.profile });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toContain("which does not exist");
    expect(checks[0]?.fix).toContain("Set it to the Chrome program file");
  });

  test("SAP_CHROME_CDP wins over launch mode and is tried alone", async () => {
    const m = await markerChrome();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not found", { status: 404 }) });
    cleanups.push(() => server.stop(true));
    const env = { SAP_CHROME_CDP: `http://127.0.0.1:${server.port}`, SAP_BROWSER: "launch", SAP_CHROME_PATH: m.exe, SAP_CHROME_PROFILE: m.profile };
    const e = await chromeTabs(env).catch((x: Error) => x.message);
    expect(e).toContain("No Chrome answers at SAP_CHROME_CDP");
    expect(m.ran()).toBe(false);
    const doctor = await chromeDoctor(env);
    expect(doctor[0]?.detail).toContain("No Chrome answers at SAP_CHROME_CDP");
    expect(m.ran()).toBe(false);
    await expect(openSapWindow(env)).rejects.toThrow("SAP_CHROME_CDP is set");
  });

  test("attach mode: the everyday Chrome is looked for as before, and nothing is started", async () => {
    const m = await markerChrome();
    const env = { SAP_BROWSER: "attach", SAP_CHROME_PATH: m.exe, SAP_CHROME_PROFILE: m.profile, CHROME_CONFIG_HOME: "/nonexistent-sap-gui-mcp", XDG_CONFIG_HOME: "/nonexistent-sap-gui-mcp" };
    const e = await chromeTabs(env).catch((x: Error) => x.message);
    expect(e).toContain("No Chrome to attach to.");
    expect(e).toContain("chrome://inspect/#remote-debugging");
    const doctor = await chromeDoctor(env);
    expect(doctor[0]?.ok).toBe(false);
    expect(doctor[0]?.fix).toMatch(/chrome:\/\/inspect|quit Chrome completely/);
    expect(m.ran()).toBe(false);
    expect(noSessionHint(env)).toBeUndefined();
    await expect(openSapWindow(env)).rejects.toThrow("SAP_BROWSER=attach");
  });

  test("a quiet look for tabs (the registry's first pass) says NotOpenYet", async () => {
    const m = await markerChrome();
    const e = await chromeTabs({ SAP_CHROME_PATH: m.exe, SAP_CHROME_PROFILE: m.profile }, { quiet: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotOpenYet);
    expect(m.ran()).toBe(false);
  });
});

describe("the registry opens the SAP window only when nothing else is open", () => {
  const session = (surface: "sapgui" | "webgui", id: string): SessionInfo => ({ id, surface, where: id, system: "ABA" });
  function web(found: SessionInfo[], hint?: string) {
    const calls: boolean[] = [];
    const s: Surface = {
      name: "webgui",
      discover: async (options) => {
        calls.push(options?.quiet === true);
        if (options?.quiet) throw new NotOpenYet("The SAP window is not running.");
        return found;
      },
      open: async () => {
        throw new Error("no");
      },
      doctor: async () => [],
      whenEmpty: () => hint,
    };
    return { s, calls };
  }
  const gui = (found: SessionInfo[]): Surface => ({ name: "sapgui", discover: async () => found, open: async () => { throw new Error("no"); }, doctor: async () => [] });

  test("SAP GUI has a session: the web surface is asked quietly only, and its closed window is no error", async () => {
    const w = web([session("webgui", "chrome:1")]);
    const r = await new Registry([gui([session("sapgui", "ses[0]")]), w.s], policyFromEnv({})).discover();
    expect(w.calls).toEqual([true]);
    expect(r.sessions.map((x) => x.id)).toEqual(["ses[0]"]);
    expect(r.errors).toEqual([]);
    expect(r.allFailed).toBe(false);
  });

  test("nothing open anywhere: the web surface is asked again and may open its window", async () => {
    const w = web([session("webgui", "chrome:1")]);
    const r = await new Registry([gui([]), w.s], policyFromEnv({})).discover();
    expect(w.calls).toEqual([true, false]);
    expect(r.sessions.map((x) => x.id)).toEqual(["chrome:1"]);
  });

  test("the window is open and empty: the answer tells the agent to ask the user to log on there", async () => {
    const w = web([], "Ask the user to open their SAP address in that window and log on.");
    const registry = new Registry([w.s], policyFromEnv({}));
    const r = await registry.discover();
    expect(r.hint).toContain("log on");
    const e = await registry.session().catch((x: Error) => x.message);
    expect(e).toBe("No open SAP session found. Ask the user to open their SAP address in that window and log on.");
  });
});

const exe = process.env.SAP_TEST_CHROME;
describe.skipIf(!exe)("a real Chrome", () => {
  test("is started once, used again, started again after it ended; only its tabs are seen", async () => {
    const dir = await tempDir();
    const profile = join(dir, "chrome");
    const page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<title>Start</title>hello", { headers: { "content-type": "text/html" } }) });
    cleanups.push(() => page.stop(true));
    const env = { SAP_CHROME_PATH: exe, SAP_CHROME_PROFILE: profile, SAP_CHROME_ARGS: "--headless=new --no-sandbox", SAP_START_URL: `http://127.0.0.1:${page.port}/` };
    const end = async () => {
      const w = await runningSapWindow(profile);
      if (!w) return;
      const b = await chromium.connectOverCDP(w.url, { noDefaults: true, isLocal: true });
      const s = await b.newBrowserCDPSession();
      await s.send("Browser.close").catch(() => {});
      await b.close().catch(() => {});
      for (let i = 0; i < 50 && (await runningSapWindow(profile)); i++) await Bun.sleep(100);
    };
    cleanups.push(async () => {
      await disconnectChrome();
      await end();
    });

    expect((await chromeDoctor(env))[1]?.detail).toContain("not running yet");
    expect(await runningSapWindow(profile)).toBeUndefined();

    // 1. The first call starts Chrome, on the start address.
    const waitTabs = async () => {
      for (let i = 0; i < 50; i++) {
        const t = await chromeTabs(env);
        if (t.length) return t;
        await Bun.sleep(100);
      }
      return [];
    };
    const tabs = await waitTabs();
    expect(tabs.map((t) => t.origin)).toEqual([`http://127.0.0.1:${page.port}`]);
    const first = await runningSapWindow(profile);
    expect(first).toBeDefined();
    expect(noSessionHint(env)).toContain("Ask the user to open their SAP address in that window");
    const doctor = await chromeDoctor(env);
    expect(doctor[0]?.detail).toContain("through the SAP window");

    // 2. Another connection (as a new server process makes) uses the same Chrome.
    await disconnectChrome();
    expect((await runningSapWindow(profile))?.url).toBe(first!.url);
    const again = await openSapWindow(env);
    expect(again.started).toBe(false);
    expect((await runningSapWindow(profile))?.url).toBe(first!.url);

    // 3. Chrome ends: the next call starts it again.
    await disconnectChrome();
    await end();
    expect(await runningSapWindow(profile)).toBeUndefined();
    expect((await waitTabs()).length).toBe(1);
    const second = await runningSapWindow(profile);
    expect(second).toBeDefined();
    expect(second!.url).not.toBe(first!.url);
  }, 60_000);
});
