import { describe, expect, test } from "bun:test";
import { allowedOrigins, classify, isLaunchpadUrl, isWebguiUrl, NO_SIGNS, originAllowed, tabSigns, tabWhere, type TabSigns } from "../src/browser/classify.js";

const signs = (s: Partial<TabSigns>): TabSigns => ({ ...NO_SIGNS, ...s });
const H = "https://host:44300";

describe("one owner per tab", () => {
  test("Web GUI by its path, in any case, or by its content", () => {
    expect(classify(`${H}/sap/bc/gui/sap/its/webgui?sap-client=100`, NO_SIGNS)).toBe("webgui");
    expect(classify(`${H}/SAP/BC/GUI/SAP/ITS/WEBGUI/!?~transaction=VA03`, NO_SIGNS)).toBe("webgui");
    expect(classify(`${H}/some/proxy/path`, signs({ webgui: true }))).toBe("webgui");
  });
  test("Web GUI wins over Fiori", () => {
    expect(classify(`${H}/sap/bc/gui/sap/its/webgui`, signs({ ui5: true, ushell: true }))).toBe("webgui");
    expect(classify(`${H}/sap/bc/ui2/flp`, signs({ webgui: true, ui5: true, ushell: true }))).toBe("webgui");
  });
  test("Fiori needs UI5, plus a launchpad URL under /sap/ or sap.ushell", () => {
    expect(classify(`${H}/sap/bc/ui2/flp?sap-client=100#Shell-home`, signs({ ui5: true }))).toBe("fiori");
    expect(classify(`${H}/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html`, signs({ ui5: true }))).toBe("fiori");
    expect(classify("https://tenant.launchpad.cfapps.eu10.hana.ondemand.com/site?siteId=1#Shell-home", signs({ ui5: true, ushell: true }))).toBe("fiori");
    // A launchpad address whose page has no UI5 yet (the logon page) is nobody's.
    expect(classify(`${H}/sap/bc/ui2/flp`, NO_SIGNS)).toBeNull();
    // UI5 alone is not SAP's launchpad.
    expect(classify("https://ui5.sap.com/#/controls", signs({ ui5: true }))).toBeNull();
    expect(classify(`${H}/sap/bc/ui5_ui5/sap/zapp/index.html`, signs({ ui5: true }))).toBeNull();
    expect(classify(`${H}/sap/bc/ui5_ui5/sap/zapp/index.html`, signs({ ui5: true, ushell: true }))).toBe("fiori");
  });
  test("a loose 'launchpad' or '/ui#' in the address is not enough", () => {
    for (const url of ["https://example.com/launchpad", "https://launchpad.net/ubuntu", "https://example.com/ui#home", "https://example.com/ui?x=1", "https://example.com/x?next=/sap/bc/ui2/flp", "https://example.com/blog/sap/bc/ui2/flp", "https://x.cp.portal.example/"]) {
      expect([url, isLaunchpadUrl(url)]).toEqual([url, false]);
      expect([url, classify(url, signs({ ui5: true }))]).toEqual([url, null]);
    }
    expect(isLaunchpadUrl(`${H}/sap/bc/ui2/flp`)).toBe(true);
    expect(isLaunchpadUrl(`${H}/sap/bc/ui2/flp/`)).toBe(true);
    expect(isLaunchpadUrl(`${H}/sap/bc/ui2/flpx`)).toBe(false);
  });
  test("the Web GUI path counts in the path only", () => {
    expect(isWebguiUrl("https://example.com/?next=/sap/bc/gui/sap/its/webgui")).toBe(false);
    expect(isWebguiUrl("https://example.com/#/sap/bc/gui/sap/its/webgui")).toBe(false);
    expect(isWebguiUrl(`${H}/sap/bc/ui2/flp#Thing-display`)).toBe(false);
  });
  test("pages that are not web pages have no owner, whatever they say", () => {
    for (const url of ["chrome://settings", "chrome-extension://abc/sap/bc/gui/sap/its/webgui", "devtools://devtools/x", "about:blank", "file:///sap/bc/gui/sap/its/webgui", "", "not a url"])
      expect([url, classify(url, signs({ webgui: true, ui5: true, ushell: true }))]).toEqual([url, null]);
  });
});

describe("tab signs", () => {
  test("a page that answers", async () => {
    const page = { mainFrame: () => ({ evaluate: async () => ({ webgui: false, ui5: true, ushell: true }) }) };
    expect(await tabSigns(page as never)).toEqual({ webgui: false, ui5: true, ushell: true });
  });
  test("a page that fails or never answers has no signs", async () => {
    const failing = { mainFrame: () => ({ evaluate: async () => Promise.reject(new Error("Execution context was destroyed")) }) };
    expect(await tabSigns(failing as never)).toEqual(NO_SIGNS);
    const frozen = { mainFrame: () => ({ evaluate: () => new Promise(() => {}) }) };
    const t0 = Date.now();
    expect(await tabSigns(frozen as never, 50)).toEqual(NO_SIGNS);
    expect(Date.now() - t0).toBeLessThan(1000);
    const closed = {
      mainFrame: () => {
        throw new Error("Target page has been closed");
      },
    };
    expect(await tabSigns(closed as never)).toEqual(NO_SIGNS);
  });
});

describe("origins (SAP_ALLOW_ORIGINS)", () => {
  test("none set: every http and https page", () => {
    expect(allowedOrigins({})).toBeUndefined();
    expect(allowedOrigins({ SAP_ALLOW_ORIGINS: " " })).toBeUndefined();
    expect(originAllowed("https://anything.example/x", undefined)).toBe(true);
    expect(originAllowed("chrome://settings", undefined)).toBe(false);
    expect(originAllowed("chrome-extension://abc/page.html", undefined)).toBe(false);
  });
  test("a list: only those origins, exactly", () => {
    const allowed = allowedOrigins({ SAP_ALLOW_ORIGINS: "https://MyHost:44300/, http://dev.local:8000/sap/bc" });
    expect(allowed).toEqual(["https://myhost:44300", "http://dev.local:8000"]);
    expect(originAllowed("https://myhost:44300/sap/bc/ui2/flp#Shell-home", allowed)).toBe(true);
    expect(originAllowed("http://dev.local:8000/x", allowed)).toBe(true);
    expect(originAllowed("https://myhost:44301/sap/bc/ui2/flp", allowed)).toBe(false);
    expect(originAllowed("http://myhost:44300/", allowed)).toBe(false);
    expect(originAllowed("https://myhost:44300.evil.example/", allowed)).toBe(false);
    expect(originAllowed("https://evil.example/?https://myhost:44300", allowed)).toBe(false);
  });
  test("an entry that is not an origin is an error, not an open door", () => {
    expect(() => allowedOrigins({ SAP_ALLOW_ORIGINS: "myhost:44300" })).toThrow(/SAP_ALLOW_ORIGINS/);
    expect(() => allowedOrigins({ SAP_ALLOW_ORIGINS: "https://ok.example,*" })).toThrow(/SAP_ALLOW_ORIGINS/);
  });
});

describe("where a tab lives", () => {
  test("by its title, without a number", () => {
    expect(tabWhere("Display  Sales Order\n4711")).toBe("Chrome tab 'Display Sales Order 4711'");
    expect(tabWhere("x".repeat(100))).toHaveLength("Chrome tab ''".length + 60);
    expect(tabWhere("", "https://host:44300/sap/bc/ui2/flp")).toBe("Chrome tab at https://host:44300");
    expect(tabWhere(undefined)).toBe("Chrome tab");
  });
});
