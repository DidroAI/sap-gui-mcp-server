// The extension's policy: which CDP commands, sites and network events the
// relay may reach. Plain functions, no chrome.* call, so that test/ can run
// them (test/extension-policy.test.ts); background.js holds the state and
// calls them.

// ---------------------------------------------------------------- commands

// Never forwarded, whatever chrome.debugger itself would allow: the server
// must not open, close or reach beyond the user's tabs.
export const DENIED_METHODS = new Set([
  "Target.createTarget",
  "Target.closeTarget",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.attachToBrowserTarget",
  "Target.attachToTarget",
  "Target.autoAttachRelated",
  "Target.sendMessageToTarget", // non-flat sessions bypass the child-session checks
  "Target.setDiscoverTargets",
  "Target.getTargets",
  "Target.activateTarget",
  "Target.exposeDevToolsProtocol",
  "Target.setRemoteLocations",
  "Browser.close",
  "Browser.crash",
  // Browser-wide cookie jars: chrome.debugger allows these on a tab session,
  // and they reach every site's cookies, not just the shared ones.
  "Network.getAllCookies",
  "Network.clearBrowserCookies",
  "Page.getCookies",
  // Reads of other sites' responses that bypass the page's own same-origin rules.
  "Network.loadNetworkResource",
  "Network.setRequestInterception",
  "Network.continueInterceptedRequest",
  "Network.getResponseBodyForInterception",
  "Network.takeResponseBodyForInterceptionAsStream",
  "Network.replayXHR",
  "IO.read",
]);
export const DENIED_PREFIXES = ["Fetch.", "CacheStorage."];

// The Storage domain is mostly browser-wide (shared storage, interest groups,
// trust tokens, cookies): only these pass, and only for allowed origins.
export const STORAGE_ALLOWED = new Set([
  "Storage.getStorageKeyForFrame",
  "Storage.getStorageKey",
  "Storage.clearDataForOrigin",
  "Storage.getUsageAndQuota",
  "Storage.trackCacheStorageForOrigin",
  "Storage.trackIndexedDBForOrigin",
  "Storage.untrackCacheStorageForOrigin",
  "Storage.untrackIndexedDBForOrigin",
  "Storage.clearDataForStorageKey",
  "Storage.trackCacheStorageForStorageKey",
  "Storage.trackIndexedDBForStorageKey",
  "Storage.untrackCacheStorageForStorageKey",
  "Storage.untrackIndexedDBForStorageKey",
]);

// Commands that read a response by requestId: allowed only for requests to
// allowed URLs this extension saw start.
export const BODY_READS = new Set(["Network.getResponseBody", "Network.getRequestPostData", "Network.searchInResponseBody", "Network.streamResourceContent"]);

// "https://host/" or "https://host/^0https://top/" (partitioned) -> "https://host/"
export function storageKeyUrl(k) {
  return typeof k === "string" ? k.split("^")[0] : null;
}

// Commands that name other sites in their parameters: allowed only when
// every site they name is allowed. null = a required site is missing.
export function siteUrls(method, params = {}) {
  const fromCookie = (c) => [c.url || (c.domain ? `https://${String(c.domain).replace(/^\./, "")}/` : null)];
  const origin = (o) => (typeof o === "string" ? o + "/" : null);
  switch (method) {
    case "Network.getCookies":
      // Without urls Chrome answers for the page and all its subframes, other sites included.
      return Array.isArray(params.urls) && params.urls.length ? params.urls.map((u) => (typeof u === "string" ? u : null)) : [null];
    case "Network.setCookie":
    case "Network.deleteCookies":
      return fromCookie(params);
    case "Network.setCookies":
      return (params.cookies || []).flatMap(fromCookie);
    case "Page.getResourceContent":
    case "Page.searchInResource":
      return [typeof params.url === "string" ? params.url : null];
    case "Page.navigate":
      return [typeof params.url === "string" ? params.url : null];
    case "Storage.clearDataForOrigin":
    case "Storage.getUsageAndQuota":
    case "Storage.trackCacheStorageForOrigin":
    case "Storage.trackIndexedDBForOrigin":
    case "Storage.untrackCacheStorageForOrigin":
    case "Storage.untrackIndexedDBForOrigin":
      return [origin(params.origin)];
    case "Storage.clearDataForStorageKey":
    case "Storage.trackCacheStorageForStorageKey":
    case "Storage.trackIndexedDBForStorageKey":
    case "Storage.untrackCacheStorageForStorageKey":
    case "Storage.untrackIndexedDBForStorageKey":
      return [storageKeyUrl(params.storageKey)];
    default:
      if (method.startsWith("DOMStorage.") && method !== "DOMStorage.enable" && method !== "DOMStorage.disable") {
        const id = params.storageId || {};
        return [id.storageKey ? storageKeyUrl(id.storageKey) : origin(id.securityOrigin)];
      }
      if (method.startsWith("IndexedDB.") && method !== "IndexedDB.enable" && method !== "IndexedDB.disable") {
        const k = params.storageKey || (params.storageBucket && params.storageBucket.storageKey);
        return [k ? storageKeyUrl(k) : origin(params.securityOrigin)];
      }
      return [];
  }
}

// Why a method is never forwarded, or null when it may be (its sites are checked apart, with siteUrls).
export function methodDenied(method) {
  if (DENIED_METHODS.has(method) || DENIED_PREFIXES.some((p) => method.startsWith(p)) || (method.startsWith("Storage.") && !STORAGE_ALLOWED.has(method))) {
    return `${method} is not available through the extension`;
  }
  return null;
}

// ---------------------------------------------------------------- scope

// A scope is { patterns, paused }: the match patterns of the shared sites.

// Chrome match patterns: <scheme>://<host><path>, scheme * = http|https,
// host * or *.domain or exact, optional :port (none = any port).
export function patternMatches(pattern, url) {
  const m = /^(\*|https?):\/\/(\*|\*\.[^/:*]+|[^/:*]+)(?::(\d+|\*))?(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, port, path] = m;
  if (scheme !== "*" && scheme + ":" !== url.protocol) return false;
  const h = url.hostname.toLowerCase();
  const ph = host.toLowerCase();
  if (ph === "*") return false; // bare wildcards never count (see isBareWildcard)
  if (ph.startsWith("*.")) {
    const base = ph.slice(2);
    if (h !== base && !h.endsWith("." + base)) return false;
  } else if (h !== ph && h !== `[${ph}]` && `[${h}]` !== ph) return false;
  if (port && port !== "*") {
    const up = url.port || (url.protocol === "https:" ? "443" : "80");
    if (up !== port) return false;
  }
  const re = new RegExp("^" + path.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(url.pathname + url.search);
}

export function isAllowedUrl(urlString, s) {
  if (s.paused) return false;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return s.patterns.some((p) => patternMatches(p, url));
}

// A resource the shared page loads: its own data: URLs and blobs of allowed origins count too.
export function isAllowedResourceUrl(u, s) {
  if (typeof u !== "string") return false;
  if (u.startsWith("data:")) return true;
  if (u.startsWith("blob:")) return isAllowedUrl(u.slice(5), s);
  return isAllowedUrl(u, s);
}

// A child target (OOPIF, worker) of a shared tab: empty, about:blank and
// about:srcdoc frames, or a URL (blob: by its origin) of an allowed site.
export function isAllowedChildUrl(u, s) {
  if (u === undefined || u === null || u === "" || u === "about:blank" || u === "about:srcdoc") return true;
  if (typeof u !== "string") return false;
  if (u.startsWith("blob:")) return isAllowedUrl(u.slice(5), s);
  return isAllowedUrl(u, s);
}

export function webPattern(p) {
  return p === "<all_urls>" || /^(\*|https?):\/\//.test(p);
}

// "On all sites" in Chrome grants https://*/*, http://*/*, *://*/* or
// <all_urls>; IT could push the same. Such patterns never make every site
// shared: only sites added one by one count.
export function isBareWildcard(p) {
  return p === "<all_urls>" || /^(\*|https?):\/\/\*(?::(\d+|\*))?\//.test(p);
}

// ---------------------------------------------------------------- network events

const MAX_REQUESTS_PER_TAB = 5000; // requestId -> url entries kept per tab
const MAX_PENDING_EXTRA_INFO = 500; // *ExtraInfo events held per tab until their request is known

export function hostOfHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if ((lk === "host" || lk === ":authority") && typeof v === "string") {
      const h = v.trim().toLowerCase();
      if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
      return h.split(":")[0];
    }
  }
  return null;
}

// Form fields that hold a password, as SAP's and other logon forms name them.
export const PASSWORD_FIELD = /(^|[&\s"'])(sap-password\w*|sap-system-login-password\w*|j_password|password|passwd|pwd)=/i;
export const PASSWORD_JSON = /"(sap-password\w*|password|passwd|pwd|j_password)"\s*:/i;

export function postBody(req) {
  if (!req) return "";
  if (typeof req.postData === "string") return req.postData;
  if (Array.isArray(req.postDataEntries)) {
    try {
      return req.postDataEntries.map((e) => (typeof e.bytes === "string" ? atob(e.bytes) : "")).join("");
    } catch {
      return "";
    }
  }
  return "";
}

export function carriesPassword(req) {
  if (!req || !req.hasPostData) return false;
  const body = postBody(req);
  // Chrome leaves out only large bodies (Web GUI's own JSON posts can be): a logon form is small.
  if (!body) return false;
  let decoded = body;
  try {
    decoded = decodeURIComponent(body.replace(/\+/g, " "));
  } catch {}
  return PASSWORD_FIELD.test(body) || PASSWORD_FIELD.test(decoded) || PASSWORD_JSON.test(body) || /name="(sap-password|password|j_password)"/i.test(body);
}

export function withoutBody(p) {
  const request = { ...p.request };
  delete request.postData;
  delete request.postDataEntries;
  return { ...p, request };
}

// The requests seen in each tab (is each to a shared site, does it send a
// password) and the ExtraInfo events held until their request is known.
// allowed(url) says whether a resource URL is on a shared site.
export function createNetworkLog(allowed) {
  const requests = new Map(); // tabId -> Map<"session|requestId", {url, ok, secret}>
  const pendingExtra = new Map(); // tabId -> Map<"session|requestId", [[method, params]...]>

  function reqMap(tabId) {
    let m = requests.get(tabId);
    if (!m) requests.set(tabId, (m = new Map()));
    return m;
  }

  function rememberRequest(tabId, key, url, secret = false) {
    const m = reqMap(tabId);
    const ok = allowed(url);
    m.delete(key); // re-insert: most recent last
    m.set(key, { url, ok, secret });
    while (m.size > MAX_REQUESTS_PER_TAB) m.delete(m.keys().next().value);
    return ok;
  }

  function holdExtraInfo(tabId, key, method, params) {
    let m = pendingExtra.get(tabId);
    if (!m) pendingExtra.set(tabId, (m = new Map()));
    let total = 0;
    for (const v of m.values()) total += v.length;
    if (total >= MAX_PENDING_EXTRA_INFO) m.delete(m.keys().next().value);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push([method, params]);
  }

  function takeExtraInfo(tabId, key) {
    const m = pendingExtra.get(tabId);
    if (!m) return [];
    const v = m.get(key) || [];
    m.delete(key);
    return v;
  }

  // Decide what to do with a Network.* event: returns a list of [method, params]
  // to forward (possibly empty, possibly with held ExtraInfo events after it).
  function filterNetworkEvent(tabId, sid, method, p) {
    const rid = p.requestId;
    if (typeof rid !== "string") {
      const urls = [p.url, p.documentURL, p.request && p.request.url, p.response && p.response.url].filter((u) => typeof u === "string");
      return urls.every((u) => allowed(u)) ? [[method, p]] : [];
    }
    const key = (sid || "") + "|" + rid;
    const m = reqMap(tabId);
    if (method === "Network.requestWillBeSent" || method === "Network.webSocketCreated") {
      const url = method === "Network.webSocketCreated" ? p.url : p.request && p.request.url;
      const before = m.get(key);
      // A form that sends a password (SAP's logon page resent by a reload or the history): its body stays here.
      // A page's own post (a form, a reload of one) whose body Chrome left out cannot be checked: it stays here too.
      const secret = method === "Network.requestWillBeSent" && (carriesPassword(p.request) || (p.request && p.request.hasPostData && !postBody(p.request)));
      if (secret) p = withoutBody(p);
      const ok = rememberRequest(tabId, key, url, secret);
      const held = takeExtraInfo(tabId, key);
      if (ok) return [[method, p], ...held];
      if (before && before.ok) {
        // A shared request redirected to a site that is not shared: the client
        // saw it start, so end it rather than leave it pending for ever.
        return [["Network.loadingFailed", { requestId: rid, timestamp: p.timestamp, type: p.type || "Other", errorText: "net::ERR_BLOCKED_BY_CLIENT", canceled: true }]];
      }
      return [];
    }
    const r = m.get(key);
    const end = method === "Network.loadingFinished" || method === "Network.loadingFailed";
    if (method.endsWith("ExtraInfo")) {
      if (!r) {
        holdExtraInfo(tabId, key, method, p);
        return [];
      }
      // Request headers of the next hop of a redirect can arrive before its
      // requestWillBeSent: hold them until the hop's URL is known.
      if (method === "Network.requestWillBeSentExtraInfo") {
        const h = hostOfHeaders(p.headers);
        let cur = null;
        try {
          cur = new URL(r.url).hostname.toLowerCase();
        } catch {}
        if (h && cur && h !== cur) {
          holdExtraInfo(tabId, key, method, p);
          return [];
        }
      }
      return r.ok ? [[method, p]] : [];
    }
    if (end) takeExtraInfo(tabId, key);
    if (!r) return [];
    return r.ok ? [[method, p]] : [];
  }

  return { requests, pendingExtra, filterNetworkEvent };
}
