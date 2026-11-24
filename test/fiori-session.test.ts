import { describe, expect, test } from "bun:test";
import { isLaunchpadUrl, isWebguiUrl } from "../src/browser/classify.js";
import { pickEntry, sessionOf } from "../src/fiori/driver.js";
import type { Ui5Info } from "../src/fiori/ui5.js";

const info = (more: Partial<Ui5Info> = {}): Ui5Info => ({ ui5: true, launchpad: true, title: "Manage Things", sources: {}, ...more });

describe("fiori sessions", () => {
  test("launchpad URLs: the ABAP launchpad's two addresses; elsewhere the page's sap.ushell decides (classify.ts)", () => {
    for (const u of ["https://host:44300/sap/bc/ui2/flp?sap-client=100#Shell-home", "https://host/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html#Thing-display"]) expect(isLaunchpadUrl(u)).toBe(true);
    for (const u of ["https://host/ui#Thing-manage", "https://tenant.launchpad.cfapps.eu10.hana.ondemand.com/site?siteId=1#Shell-home", "https://tenant.cp.portal.example/site#Shell-home", "https://example.com/shop"])
      expect(isLaunchpadUrl(u)).toBe(false);
  });
  test("a tab whose own page is Web GUI is not a Fiori tab", () => {
    expect(isWebguiUrl("https://host:44300/sap/bc/gui/sap/its/webgui?sap-client=100")).toBe(true);
    expect(isWebguiUrl("https://host:44300/SAP/BC/GUI/SAP/ITS/WEBGUI")).toBe(true);
    expect(isWebguiUrl("https://host:44300/sap/bc/ui2/flp#Thing-display")).toBe(false);
  });
  test("a dropdown entry: the whole text first, a part of it only when one entry has it", () => {
    const plants = ["10 Plant Ten", "100 Plant Hundred", "1000 Plant Thousand"];
    expect(pickEntry(plants, "10")).toBe(0);
    expect(pickEntry(plants, "100")).toBe(1);
    expect(pickEntry(plants, "100 plant hundred")).toBe(1);
    expect(pickEntry(plants, "Thousand")).toBe(2);
    // A part of more than one entry picks none, and names them.
    expect(pickEntry(plants, "Plant")).toEqual(plants);
    expect(pickEntry(["100", "10"], "10")).toBe(1);
    expect(pickEntry(["100", "1000"], "10")).toEqual(["100", "1000"]);
    expect(pickEntry(["Open  ", " In Process"], "in process")).toBe(1);
    expect(pickEntry(plants, "Zeta")).toEqual([]);
    expect(pickEntry(plants, " ")).toEqual([]);
    // Two entries of the very same text cannot be told apart: the first.
    expect(pickEntry(["A", "A"], "A")).toBe(0);
  });
  test("session line: system, client and user from the page, the app as transaction", () => {
    const s = sessionOf(
      { id: "T1", title: "tab title", url: "https://host:44300/sap/bc/ui2/flp?sap-client=100&sap-language=EN#Thing-manage&/detail" },
      3,
      info({ system: "XYZ", client: "100", user: "TESTER", intent: "Thing-manage", appId: "F0000" }),
    );
    expect(s).toEqual({
      id: "chrome:T1",
      surface: "fiori",
      where: "Chrome tab 3",
      title: "Manage Things",
      url: "https://host:44300/sap/bc/ui2/flp",
      system: "XYZ",
      client: "100",
      user: "TESTER",
      transaction: "Thing-manage",
    });
  });
  test("a stand-alone app: client from the URL, the app id as transaction, no system", () => {
    const s = sessionOf({ id: "T2", title: "tab title", url: "https://host/sap/bc/ui5_ui5/sap/zapp/index.html?sap-client=200" }, 1, info({ launchpad: false, title: "", appId: "z.app" }));
    expect(s).toMatchObject({ client: "200", transaction: "z.app", title: "tab title" });
    expect(s.system).toBeUndefined();
    expect(s.user).toBeUndefined();
  });
});

describe("FIORI-12: a tab at a launchpad address that shows no launchpad", () => {
  const { PendingTab, pendingSession } = require("../src/fiori/pending.js") as typeof import("../src/fiori/pending.js");
  const { ActionError } = require("../src/core/types.js") as typeof import("../src/core/types.js");
  /** A tab whose page answers `facts`, or never answers. */
  const tab = (facts: { title: string; password: boolean; text: string } | "never") =>
    ({
      id: "T9",
      title: "Change Password",
      url: "https://host:44300/sap/bc/ui2/flp?sap-client=100",
      page: {
        isClosed: () => false,
        url: () => "https://host:44300/sap/bc/ui2/flp?sap-client=100",
        mainFrame: () => ({ evaluate: () => (facts === "never" ? new Promise(() => {}) : Promise.resolve(facts)) }),
      },
    }) as never;
  test("the session line says what the tab is", () => {
    const s = pendingSession({ id: "T9", url: "https://host:44300/sap/bc/ui2/flp?sap-client=100", title: "x" }, { kind: "password", title: "Change Password", text: "" });
    expect(s).toMatchObject({ id: "chrome:T9", surface: "fiori", client: "100", title: "Change Password [no launchpad in this tab: logon or password page]" });
  });
  test("a password page: the look names it and says who has to act; every action is refused", async () => {
    const t = tab({ title: "Change Password", password: true, text: "Change Password | Current Password | New Password" });
    const d = new PendingTab(t, pendingSession(t, { kind: "password", title: "Change Password", text: "" }));
    const view = await d.look();
    expect(view).toContain("PAGE Change Password");
    expect(view).toContain("it asks for a password");
    expect(view).toContain("never types a password: ask the user to finish this page");
    expect(view).toContain("TEXT Change Password | Current Password | New Password");
    await expect(d.assess({ do: "key", key: "Enter" })).rejects.toBeInstanceOf(ActionError);
    await expect(d.act({ do: "set", id: "x", value: "y" })).rejects.toThrow("Nothing was done");
  });
  test("a tab that does not answer is said to be that, within a few seconds", async () => {
    const t = tab("never");
    const d = new PendingTab(t, pendingSession(t, { kind: "silent", title: "Home", text: "" }));
    const t0 = Date.now();
    expect(await d.look()).toContain("the tab does not answer");
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 8000);
});
