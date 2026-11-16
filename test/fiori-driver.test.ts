/**
 * The Fiori driver on a fake tab: what it refuses before it touches the page
 * (the logon page), and the screenshot of a tab in the background.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ChromeTab } from "../src/browser/chrome.js";
import { ActionError, type SessionInfo } from "../src/core/types.js";
import { FioriDriver } from "../src/fiori/driver.js";
import { ui5Logon } from "../src/fiori/ui5.js";

interface Fake {
  /** What `ui5Logon` answers in each frame. */
  logon: boolean[];
  /** Functions the driver ran in the page, by name. */
  ran: string[];
  keys: string[];
  /** Screenshots fail until the tab is brought to the front. */
  background: boolean;
  front: number;
}

function fakeTab(fake: Fake): ChromeTab {
  const frame = (i: number) => ({
    isDetached: () => false,
    url: () => "https://host/sap/bc/ui2/flp",
    evaluate: async (fn: (...a: unknown[]) => unknown) => {
      fake.ran.push(fn.name || "inline");
      if (fn === (ui5Logon as unknown)) return fake.logon[i] ?? false;
      return undefined;
    },
    waitForLoadState: async () => {},
  });
  const frames = fake.logon.map((_, i) => frame(i));
  const page = {
    frames: () => frames,
    mainFrame: () => frames[0],
    url: () => "https://host/sap/bc/ui2/flp",
    title: async () => "Logon",
    keyboard: { press: async (k: string) => void fake.keys.push(k) },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    bringToFront: async () => {
      fake.front++;
      fake.background = false;
    },
    screenshot: async (o: { type: string; timeout?: number }) => {
      if (fake.background) throw new Error(`Timeout ${o.timeout}ms exceeded`);
      return Buffer.from("PNG");
    },
  };
  return { id: "T1", title: "Logon", url: page.url(), page } as unknown as ChromeTab;
}

const INFO: SessionInfo = { id: "chrome:T1", surface: "fiori", where: "Chrome tab 1" };
const driver = (fake: Fake) => new FioriDriver(fakeTab(fake), INFO, 1, { recordReplay: false, idleTimeoutMs: 2000 });
const fresh = (more: Partial<Fake> = {}): Fake => ({ logon: [false], ran: [], keys: [], background: false, front: 0, ...more });

describe("fiori driver: the logon page", () => {
  test("every action is refused, in assess and in act, before anything else runs in the page", async () => {
    const fake = fresh({ logon: [true] });
    const d = driver(fake);
    for (const action of [
      { do: "set", id: "USERNAME_FIELD-inner", value: "ME" },
      { do: "set", id: "PASSWORD_FIELD-inner", value: "secret" },
      { do: "key", key: "Enter" },
      { do: "press", id: "LOGIN_LINK" },
      { do: "okcode", value: "/nVA03" },
    ]) {
      await expect(d.assess(action)).rejects.toThrow("This server never logs on; log on yourself, then ask again");
      await expect(d.act(action)).rejects.toThrow("This server never logs on; log on yourself, then ask again");
      await expect(d.act(action)).rejects.toBeInstanceOf(ActionError);
    }
    expect(fake.keys).toEqual([]);
    expect(new Set(fake.ran)).toEqual(new Set(["ui5Logon"]));
  });

  test("a logon page in a frame of the tab counts too", async () => {
    const d = driver(fresh({ logon: [false, true] }));
    await expect(d.act({ do: "key", key: "Enter" })).rejects.toThrow("never logs on");
  });

  test("a page that is not a logon page is not refused for that reason", async () => {
    const fake = fresh();
    const e = (await driver(fake)
      .act({ do: "key", key: "Enter" })
      .catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain("never logs on");
    expect(fake.ran[0]).toBe("ui5Logon");
  });
});

describe("fiori driver: open, Back and unknown keys", () => {
  /** A launchpad tab whose page answers each in-page function by name. */
  function shellTab(answers: Record<string, unknown>, ran: string[], clicks: string[]): ChromeTab {
    const frame = {
      isDetached: () => false,
      url: () => "https://host/sap/bc/ui2/flp",
      evaluate: async (fn: (...a: unknown[]) => unknown, arg?: unknown) => {
        ran.push(`${fn.name || "inline"}${typeof arg === "string" ? `(${arg})` : ""}`);
        if (fn.name in answers) return answers[fn.name];
        if (fn.name === "ui5Idle") return "idle (busy state, 1 ms)";
        if (fn.name === "ui5Logon") return false;
        // The frame check: a UI5 frame.
        return fn.name ? undefined : "ui5";
      },
      waitForLoadState: async () => {},
      locator: () => ({ first: () => ({ click: async () => void clicks.push("target") }) }),
    };
    const page = {
      frames: () => [frame],
      mainFrame: () => frame,
      url: () => "https://host/sap/bc/ui2/flp",
      title: async () => "Home",
      keyboard: { press: async (k: string) => void clicks.push(k) },
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
    };
    return { id: "T1", title: "Home", url: page.url(), page } as unknown as ChromeTab;
  }
  const on = (answers: Record<string, unknown>) => {
    const ran: string[] = [];
    const clicks: string[] = [];
    return { d: new FioriDriver(shellTab(answers, ran, clicks), INFO, 1, { recordReplay: false, idleTimeoutMs: 2000 }), ran, clicks };
  };

  test("open sets the launchpad's hash and is rated before any control is looked up", async () => {
    const { d, ran } = on({ ui5Open: "OK" });
    expect(await d.assess({ do: "open", app: "#SalesOrder-manage" })).toMatchObject({ risk: "navigate" });
    expect(ran).toEqual(["ui5Logon"]);
    expect(await d.act({ do: "open", app: "SalesOrder-manage" })).toContain("open #SalesOrder-manage; idle");
    expect(ran).toContain("ui5Open(#SalesOrder-manage)");
  });
  test("open refuses a URL, in assess and in act, and a tab without a launchpad", async () => {
    const { d, ran } = on({ ui5Open: "NOSHELL" });
    for (const app of ["https://evil.example/sap/bc/ui2/flp#SalesOrder-manage", "//evil.example", "javascript:alert(1)"]) {
      await expect(d.assess({ do: "open", app })).rejects.toThrow("never a URL");
      await expect(d.act({ do: "open", app })).rejects.toThrow("never a URL");
    }
    expect(ran.some((r) => r.startsWith("ui5Open"))).toBe(false);
    await expect(d.act({ do: "open", app: "#SalesOrder-manage" })).rejects.toThrow("launchpad tab only");
  });
  test("a key the surface does not have fails in assess: the user is not asked to confirm it", async () => {
    const { d } = on({});
    await expect(d.assess({ do: "key", key: "F9" })).rejects.toThrow('Unknown key "F9". Fiori keys: Enter');
  });
  test("Back presses the launchpad's back button; without one it opens the home page, never the browser's earlier site", async () => {
    const shell = on({ ui5Back: "BUTTON" });
    expect(await shell.d.act({ do: "key", key: "Back" })).toContain("key Back: the launchpad's back button");
    expect(shell.clicks).toEqual(["target"]);
    const first = on({ ui5Back: "HOME" });
    expect(await first.d.act({ do: "key", key: 3 })).toContain("the launchpad's home page was opened");
    expect(first.clicks).toEqual([]);
  });
});

describe("fiori driver: a Web GUI frame the launchpad keeps hidden", () => {
  const frame = (answer: boolean | "throws") => ({ frameElement: async () => ({ evaluate: async () => (answer === "throws" ? Promise.reject(new Error("detached")) : answer) }) }) as never;
  test("is not a screen: keys and looks do not go there", async () => {
    const { frameShown } = await import("../src/fiori/driver.js");
    expect(await frameShown(frame(false))).toBe(false);
    expect(await frameShown(frame(true))).toBe(true);
    // a frame that cannot say is treated as before
    expect(await frameShown(frame("throws"))).toBe(true);
  });
});

describe("fiori driver: screenshot", () => {
  test("a tab in the background is brought to the front, then tried once more", async () => {
    const fake = fresh({ background: true });
    expect((await driver(fake).screenshot()).toString()).toBe("PNG");
    expect(fake.front).toBe(1);
  });
  test("a tab in front is not touched", async () => {
    const fake = fresh();
    expect((await driver(fake).screenshot()).toString()).toBe("PNG");
    expect(fake.front).toBe(0);
  });
});

describe("ui5Logon", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, window: g.window, sap: g.sap };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });
  const el = (shown = true) => ({ getBoundingClientRect: () => (shown ? { width: 200, height: 30 } : { width: 0, height: 0 }) });
  /** A page with `passwords` password inputs; `known` says whether SAP's logon ids are on it. */
  function page(passwords: unknown[], known: boolean, sap?: unknown): boolean {
    g.document = {
      querySelectorAll: (sel: string) => (sel === "input[type='password']" ? passwords : []),
      querySelector: (sel: string) => (known && sel.includes("#LOGIN_FORM") ? {} : null),
    };
    g.window = g;
    if (sap === undefined) delete g.sap;
    else g.sap = sap;
    return ui5Logon();
  }
  const ui5 = (components: number, launchpad = false) => ({
    ui: {
      getCore: () => ({}),
      require: (n: string) => (n === "sap/ui/core/Component" ? { registry: { all: () => Object.fromEntries(Array.from({ length: components }, (_, i) => [`c${i}`, {}])) } } : n === "sap/ushell/Container" && launchpad ? {} : undefined),
    },
  });

  test("SAP's logon pages: a password input and the logon form", () => {
    expect(page([el()], true)).toBe(true);
    expect(page([el()], true, ui5(1, true))).toBe(true);
  });
  test("a password input on a page that runs no app is a logon page", () => {
    expect(page([el()], false)).toBe(true);
    expect(page([el()], false, ui5(0))).toBe(true);
  });
  test("a password field inside a running app or launchpad is not", () => {
    expect(page([el()], false, ui5(1))).toBe(false);
    expect(page([el()], false, ui5(0, true))).toBe(false);
  });
  test("no visible password input: not a logon page", () => {
    expect(page([], true)).toBe(false);
    expect(page([el(false)], true)).toBe(false);
  });
});
