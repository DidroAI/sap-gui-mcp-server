import { describe, expect, test } from "bun:test";
import { isLaunchpadUrl, isWebguiUrl, sessionOf } from "../src/fiori/driver.js";
import type { Ui5Info } from "../src/fiori/ui5.js";

const info = (more: Partial<Ui5Info> = {}): Ui5Info => ({ ui5: true, launchpad: true, title: "Manage Things", sources: {}, ...more });

describe("fiori sessions", () => {
  test("launchpad URLs", () => {
    for (const u of [
      "https://host:44300/sap/bc/ui2/flp?sap-client=100#Shell-home",
      "https://host/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html#Thing-display",
      "https://host/ui#Thing-manage",
      "https://tenant.launchpad.cfapps.eu10.hana.ondemand.com/site?siteId=1#Shell-home",
      "https://tenant.cp.portal.example/site#Shell-home",
    ])
      expect(isLaunchpadUrl(u)).toBe(true);
    expect(isLaunchpadUrl("https://example.com/shop")).toBe(false);
  });
  test("a tab whose own page is Web GUI is not a Fiori tab", () => {
    expect(isWebguiUrl("https://host:44300/sap/bc/gui/sap/its/webgui?sap-client=100")).toBe(true);
    expect(isWebguiUrl("https://host:44300/sap/bc/ui2/flp#Thing-display")).toBe(false);
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
