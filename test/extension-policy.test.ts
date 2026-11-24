/**
 * The extension's policy (extension/policy.js): which CDP commands, sites and
 * network events the relay may reach. No Chrome here: extension-chrome.test.ts
 * runs the real extension.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

type Scope = { patterns: string[]; paused: boolean };
type Event = [string, Record<string, unknown>];
interface Policy {
  methodDenied(method: string): string | null;
  siteUrls(method: string, params?: Record<string, unknown>): (string | null)[];
  patternMatches(pattern: string, url: URL): boolean;
  isAllowedUrl(url: unknown, s: Scope): boolean;
  isAllowedResourceUrl(url: unknown, s: Scope): boolean;
  isAllowedChildUrl(url: unknown, s: Scope): boolean;
  isBareWildcard(p: string): boolean;
  carriesPassword(req: unknown): boolean;
  createNetworkLog(allowed: (url: unknown) => boolean): {
    requests: Map<number, Map<string, { url: string; ok: boolean; secret: boolean }>>;
    filterNetworkEvent(tabId: number, sid: string | undefined, method: string, p: Record<string, unknown>): Event[];
  };
}
// A path in a variable: tsc does not look for the types of this plain .js file.
const path = resolve(import.meta.dir, "../extension/policy.js");
const p = (await import(path)) as Policy;

const SAP = "https://sap.example.com/*";
const scope: Scope = { patterns: [SAP, "http://*.corp.example:8000/sap/*"], paused: false };

describe("commands", () => {
  test("browser-wide and other-tab methods are denied; the Storage domain only for its origin methods", () => {
    for (const m of ["Target.createTarget", "Browser.close", "Network.getAllCookies", "Fetch.enable", "CacheStorage.requestEntries", "IO.read", "Storage.getCookies", "Storage.setSharedStorageEntry"]) {
      expect(p.methodDenied(m)).toBe(`${m} is not available through the extension`);
    }
    for (const m of ["Page.navigate", "Runtime.evaluate", "Network.getCookies", "Storage.getStorageKeyForFrame", "Storage.clearDataForOrigin"]) expect(p.methodDenied(m)).toBeNull();
  });

  test("siteUrls names every site a command reaches; null when a site must be named", () => {
    expect(p.siteUrls("Network.getCookies", {})).toEqual([null]);
    expect(p.siteUrls("Network.getCookies", { urls: ["https://a/", 3] })).toEqual(["https://a/", null]);
    expect(p.siteUrls("Network.setCookie", { domain: ".corp.example" })).toEqual(["https://corp.example/"]);
    expect(p.siteUrls("Network.setCookies", { cookies: [{ url: "https://a/" }, { domain: "b" }] })).toEqual(["https://a/", "https://b/"]);
    expect(p.siteUrls("Page.navigate", { url: "https://a/x" })).toEqual(["https://a/x"]);
    expect(p.siteUrls("Page.navigate", {})).toEqual([null]);
    expect(p.siteUrls("Storage.clearDataForOrigin", { origin: "https://a" })).toEqual(["https://a/"]);
    expect(p.siteUrls("Storage.clearDataForStorageKey", { storageKey: "https://a/^0https://top/" })).toEqual(["https://a/"]);
    expect(p.siteUrls("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: "https://a" } })).toEqual(["https://a/"]);
    expect(p.siteUrls("DOMStorage.enable", {})).toEqual([]);
    expect(p.siteUrls("IndexedDB.requestData", { storageBucket: { storageKey: "https://a/" } })).toEqual(["https://a/"]);
    expect(p.siteUrls("Runtime.evaluate", { expression: "1" })).toEqual([]);
  });
});

describe("scope", () => {
  test("match patterns: scheme, host, subdomains, port and path", () => {
    const m = (pattern: string, url: string) => p.patternMatches(pattern, new URL(url));
    expect(m(SAP, "https://sap.example.com/sap/bc/gui")).toBe(true);
    expect(m(SAP, "http://sap.example.com/")).toBe(false);
    expect(m(SAP, "https://evil.sap.example.com/")).toBe(false);
    expect(m("*://*.example.com/*", "http://a.b.example.com/x")).toBe(true);
    expect(m("*://*.example.com/*", "https://example.com/")).toBe(true);
    expect(m("*://*.example.com/*", "https://notexample.com/")).toBe(false);
    expect(m("https://h:8443/*", "https://h:8443/")).toBe(true);
    expect(m("https://h:8443/*", "https://h/")).toBe(false);
    expect(m("https://h/sap/*", "https://h/other")).toBe(false);
    expect(m("https://h/sap/*", "https://h/sap/x?y=1")).toBe(true);
    // bare wildcards never count
    expect(m("https://*/*", "https://anything/")).toBe(false);
    expect(m("not a pattern", "https://h/")).toBe(false);
  });

  test("bare wildcards", () => {
    for (const w of ["<all_urls>", "https://*/*", "http://*/*", "*://*/*", "https://*:8080/*"]) expect(p.isBareWildcard(w)).toBe(true);
    expect(p.isBareWildcard("https://*.example.com/*")).toBe(false);
  });

  test("allowed URLs: http(s) in the patterns, nothing while paused", () => {
    expect(p.isAllowedUrl("https://sap.example.com/x", scope)).toBe(true);
    expect(p.isAllowedUrl("http://a.corp.example:8000/sap/bc", scope)).toBe(true);
    expect(p.isAllowedUrl("http://a.corp.example:8001/sap/bc", scope)).toBe(false);
    expect(p.isAllowedUrl("https://other.example/", scope)).toBe(false);
    expect(p.isAllowedUrl("file:///etc/passwd", { patterns: ["*://*/*"], paused: false })).toBe(false);
    expect(p.isAllowedUrl("not a url", scope)).toBe(false);
    expect(p.isAllowedUrl("https://sap.example.com/x", { ...scope, paused: true })).toBe(false);
  });

  test("resources: data: and blobs of allowed origins; children: blank frames too", () => {
    expect(p.isAllowedResourceUrl("data:text/plain,x", scope)).toBe(true);
    expect(p.isAllowedResourceUrl("blob:https://sap.example.com/1234", scope)).toBe(true);
    expect(p.isAllowedResourceUrl("blob:https://other.example/1234", scope)).toBe(false);
    expect(p.isAllowedResourceUrl(undefined, scope)).toBe(false);
    for (const u of [undefined, null, "", "about:blank", "about:srcdoc"]) expect(p.isAllowedChildUrl(u, scope)).toBe(true);
    expect(p.isAllowedChildUrl("data:text/html,x", scope)).toBe(false);
    expect(p.isAllowedChildUrl("https://sap.example.com/frame", scope)).toBe(true);
  });
});

describe("network events", () => {
  test("a post that sends a password is seen in forms, encoded forms, JSON and multipart", () => {
    const post = (postData: string) => ({ hasPostData: true, postData });
    expect(p.carriesPassword(post("sap-user=JDOE&sap-password=secret"))).toBe(true);
    expect(p.carriesPassword(post("a=1&j_password=x"))).toBe(true);
    expect(p.carriesPassword(post("x=%26password%3Dsecret"))).toBe(true);
    expect(p.carriesPassword(post('{"user":"a","password":"b"}'))).toBe(true);
    expect(p.carriesPassword(post('Content-Disposition: form-data; name="sap-password"'))).toBe(true);
    expect(p.carriesPassword({ hasPostData: true, postDataEntries: [{ bytes: btoa("pwd=1") }] })).toBe(true);
    expect(p.carriesPassword(post("okcode=/nVA03"))).toBe(false);
    expect(p.carriesPassword({ hasPostData: false, postData: "password=x" })).toBe(false);
    expect(p.carriesPassword(undefined)).toBe(false);
  });

  const setup = () => {
    const log = p.createNetworkLog((u) => p.isAllowedResourceUrl(u, scope));
    return { log, f: (method: string, params: Record<string, unknown>) => log.filterNetworkEvent(1, undefined, method, params) };
  };
  const sent = (requestId: string, url: string, more: Record<string, unknown> = {}) => ({ requestId, request: { url, method: "GET", ...more } });

  test("requests to shared sites pass with their events; others are dropped", () => {
    const { f } = setup();
    expect(f("Network.requestWillBeSent", sent("1", "https://sap.example.com/a"))).toEqual([["Network.requestWillBeSent", sent("1", "https://sap.example.com/a")]]);
    expect(f("Network.responseReceived", { requestId: "1" })).toEqual([["Network.responseReceived", { requestId: "1" }]]);
    expect(f("Network.requestWillBeSent", sent("2", "https://other.example/a"))).toEqual([]);
    expect(f("Network.responseReceived", { requestId: "2" })).toEqual([]);
    expect(f("Network.loadingFinished", { requestId: "3" })).toEqual([]);
    // events without a request id: by the URLs they name
    expect(f("Network.webSocketClosed", { url: "https://sap.example.com/ws" })).toHaveLength(1);
    expect(f("Network.webSocketClosed", { url: "https://other.example/ws" })).toEqual([]);
  });

  test("a logon post keeps its body in the browser, and is marked as such", () => {
    const { f, log } = setup();
    const out = f("Network.requestWillBeSent", sent("1", "https://sap.example.com/logon", { hasPostData: true, postData: "sap-password=secret" }));
    expect(out).toHaveLength(1);
    const req = (out[0]![1] as { request: Record<string, unknown> }).request;
    expect(req.postData).toBeUndefined();
    expect(req.hasPostData).toBe(true);
    expect(log.requests.get(1)?.get("|1")).toEqual({ url: "https://sap.example.com/logon", ok: true, secret: true });
    // a post whose body Chrome left out cannot be checked: kept back too
    const unknown = f("Network.requestWillBeSent", sent("2", "https://sap.example.com/big", { hasPostData: true }));
    expect(log.requests.get(1)?.get("|2")?.secret).toBe(true);
    expect((unknown[0]![1] as { request: Record<string, unknown> }).request.postData).toBeUndefined();
  });

  test("a shared request redirected off the shared sites ends as blocked", () => {
    const { f } = setup();
    f("Network.requestWillBeSent", sent("1", "https://sap.example.com/a"));
    expect(f("Network.requestWillBeSent", { ...sent("1", "https://other.example/b"), timestamp: 5, type: "Document" })).toEqual([
      ["Network.loadingFailed", { requestId: "1", timestamp: 5, type: "Document", errorText: "net::ERR_BLOCKED_BY_CLIENT", canceled: true }],
    ]);
    expect(f("Network.responseReceived", { requestId: "1" })).toEqual([]);
  });

  test("ExtraInfo that comes before its request is held, then follows it; a redirect hop's headers wait for its URL", () => {
    const { f } = setup();
    const extra = { requestId: "1", headers: { Host: "sap.example.com" } };
    expect(f("Network.requestWillBeSentExtraInfo", extra)).toEqual([]);
    expect(f("Network.requestWillBeSent", sent("1", "https://sap.example.com/a"))).toEqual([
      ["Network.requestWillBeSent", sent("1", "https://sap.example.com/a")],
      ["Network.requestWillBeSentExtraInfo", extra],
    ]);
    // headers of a hop to another host: held, then dropped with the hop as it is not shared
    const hop = { requestId: "1", headers: { ":authority": "other.example" } };
    expect(f("Network.requestWillBeSentExtraInfo", hop)).toEqual([]);
    expect(f("Network.requestWillBeSent", sent("1", "https://other.example/b"))).toHaveLength(1);
    expect(f("Network.responseReceivedExtraInfo", { requestId: "1" })).toEqual([]);
  });
});
