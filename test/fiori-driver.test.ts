/**
 * The Fiori driver on a fake tab: what it refuses before it touches the page
 * (the logon page), and the screenshot of a tab in the background.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ChromeTab } from "../src/browser/chrome.js";
import { ActionError, type SessionInfo } from "../src/core/types.js";
import { FioriDriver, fioriGridOp, fioriIntentOfOkcode, HOME_INTENT, ui5RowOf } from "../src/fiori/driver.js";
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
  function shellTab(answers: Record<string, unknown>, ran: string[], clicks: string[], target?: Record<string, unknown>): ChromeTab {
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
      locator: () => ({ first: () => ({ click: async () => void clicks.push("target"), ...target }) }),
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
  const on = (answers: Record<string, unknown>, target?: Record<string, unknown>) => {
    const ran: string[] = [];
    const clicks: string[] = [];
    return { d: new FioriDriver(shellTab(answers, ran, clicks, target), INFO, 1, { recordReplay: false, idleTimeoutMs: 2000 }), ran, clicks };
  };

  test("FIORI-05: a field that UI5 draws again while it is filled still gets its key, at once", async () => {
    // The marked element is gone after the fill (a date range that was cleared): the key on it times out.
    const gone = { evaluate: async () => false, fill: async () => {}, press: async () => Promise.reject(new Error("locator.press: Timeout 1500ms exceeded.")), count: async () => 0 };
    const cleared = on({ ui5Control: { status: "TARGET", note: "sap.m.DynamicDateRange app--Date-inner" } }, gone);
    expect(await cleared.d.act({ do: "set", id: "Date-inner", value: "" })).toContain("set sap.m.DynamicDateRange app--Date-inner; idle");
    expect(cleared.clicks).toEqual(["Tab"]);
    // Still there and not taking the key: that is said.
    const covered = on({ ui5Control: { status: "TARGET", note: "sap.m.Input app--X" } }, { ...gone, count: async () => 1 });
    await expect(covered.d.act({ do: "set", id: "X", value: "1" })).rejects.toThrow("the control is covered, hidden or not ready");
  });

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

  test("an okcode that names an app opens it; /n opens the home page; a transaction is still refused", async () => {
    for (const [value, intent] of [
      ["/nPurchaseOrder-manage", "#PurchaseOrder-manage"],
      ["#Material-transferStock", "#Material-transferStock"],
      ["/n#SalesOrder-display?SalesOrder=4711", "#SalesOrder-display?SalesOrder=4711"],
      ["/n", "#Shell-home"],
    ] as const) {
      const { d, ran } = on({ ui5Open: "OK" });
      expect(await d.assess({ do: "okcode", value })).toMatchObject({ risk: "navigate" });
      const said = await d.act({ do: "okcode", value });
      expect([value, said]).toEqual([value, expect.stringContaining(`okcode ${value} in a Fiori tab is `)]);
      expect(said).toContain(`open ${intent}; idle`);
      expect(ran).toContain(`ui5Open(${intent})`);
    }
    const { d } = on({ ui5Open: "OK" });
    await expect(d.act({ do: "okcode", value: "/nVA01" })).rejects.toThrow('"okcode" works on SAP GUI screens only');
  });
  test("a grid row selected or opened is the row selected or pressed", async () => {
    const pressed = on({ ui5RowOf: { id: "app--items-row3" }, ui5Control: { status: "TARGET", note: "sap.m.ColumnListItem app--items-row3" } });
    expect(await pressed.d.act({ do: "grid", id: "items", row: 3, how: "double" })).toStartWith("grid row 3 in a Fiori tab is press on the row; press sap.m.ColumnListItem app--items-row3; idle");
    expect(pressed.clicks).toEqual(["target"]);
    const selected = on({ ui5RowOf: { id: "app--items-row0" }, ui5Control: { status: "DONE", note: "sap.m.ColumnListItem app--items-row0 selected" } });
    expect(await selected.d.act({ do: "grid", id: "items", row: 0, how: "select" })).toStartWith("grid row 0 in a Fiori tab is select on the row; select ");
    const missing = on({ ui5RowOf: { why: "row 40 of items is not on screen (rows 0 to 19 are): scroll to it first" } });
    await expect(missing.d.act({ do: "grid", id: "items", row: 40, how: "select" })).rejects.toThrow("row 40 of items is not on screen");
    // A cell, or a grid without a row, has no Fiori meaning.
    await expect(on({}).d.act({ do: "grid", id: "items", row: 1, col: "A", how: "cell" })).rejects.toThrow('"grid" works on SAP GUI screens only');
  });
});

describe("fiori: what SAP GUI actions mean in a Fiori tab", () => {
  test("okcode values that are an app's intent, or the home page", () => {
    expect(fioriIntentOfOkcode("/nPurchaseOrder-manage")).toBe("#PurchaseOrder-manage");
    expect(fioriIntentOfOkcode(" /N#Material-transferStock ")).toBe("#Material-transferStock");
    expect(fioriIntentOfOkcode("#X-y")).toBe("#X-y");
    expect(fioriIntentOfOkcode("/n")).toBe(HOME_INTENT);
    for (const v of ["/nVA01", "VA01", "PurchaseOrder-manage", "/oX-y", "/nhttps://evil.example/x-y", "=SAVE", 3]) expect([v, fioriIntentOfOkcode(v)]).toEqual([v, undefined]);
  });
  test("grid how: select is select, double (and open, press) is a press; others none", () => {
    expect(fioriGridOp({ do: "grid", id: "t", row: 1 })).toBe("select");
    expect(fioriGridOp({ do: "grid", id: "t", row: 1, how: "double" })).toBe("press");
    expect(fioriGridOp({ do: "grid", id: "t", row: 1, how: "cell" })).toBeUndefined();
    expect(fioriGridOp({ do: "grid", id: "t", how: "select" })).toBeUndefined();
  });
  test("ui5RowOf finds the row of a list, of a grid table on screen, through a smart table", () => {
    const ctl = (id: string, more: Record<string, unknown> = {}) => ({ getId: () => id, ...more });
    const rows = [0, 1, 2].map((i) => ctl(`app--grid-rows-row${i}`, { getBindingContext: () => ({}) }));
    const items = [0, 1].map((i) => ctl(`app--list-item${i}`));
    const inner = ctl("app--smart-ui5table", { getItems: () => items });
    const all = [ctl("app--list", { getItems: () => items }), ctl("app--grid", { getRows: () => rows, getFirstVisibleRow: () => 10 }), ctl("app--smart", { getTable: () => inner }), ctl("app--text")];
    const g = globalThis as unknown as { window?: unknown };
    const had = g.window;
    g.window = { sap: { ui: { getCore: () => ({ mElements: Object.fromEntries(all.map((c) => [c.getId(), c])) }) } } };
    try {
      expect(ui5RowOf({ handle: "list", row: 1 })).toEqual({ id: "app--list-item1" });
      expect(ui5RowOf({ handle: "#grid", row: 11 })).toEqual({ id: "app--grid-rows-row1" });
      expect(ui5RowOf({ handle: "grid", row: 3 })).toEqual({ why: "row 3 of grid is not on screen (rows 10 to 12 are): scroll to it first" });
      expect(ui5RowOf({ handle: "smart", row: 0 })).toEqual({ id: "app--list-item0" });
      expect(ui5RowOf({ handle: "list", row: 5 })).toEqual({ why: "list has 2 rows loaded; row 5 is not among them" });
      expect(ui5RowOf({ handle: "text", row: 0 })).toEqual({ why: "text is not a table or a list" });
      expect(ui5RowOf({ handle: "nope", row: 0 })).toBeNull();
    } finally {
      g.window = had;
    }
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
