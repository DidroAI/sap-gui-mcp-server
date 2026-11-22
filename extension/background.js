// sap-gui-mcp-server bridge: MV3 service worker.
//
// Connects to the sap-gui-mcp-server relay on 127.0.0.1 (see PROTOCOL.md),
// proves both sides hold the pairing code, then runs the relay's requests with
// chrome.debugger on allowed tabs only. Every frame after the handshake is
// encrypted and authenticated with keys derived from the code. Nothing here
// loads or evaluates remote code: the relay can only ask for the four request
// types below.

import { normalizeCode, CODE_LENGTH } from "./code.js";

const PORT_FIRST = 47823;
const PORT_LAST = 47830;
const EXT_VERSION = chrome.runtime.getManifest().version;

const OPEN_TIMEOUT_MS = 3000; // TCP + WebSocket upgrade
const HELLO_TIMEOUT_MS = 4000; // relay speaks first
const WELCOME_TIMEOUT_MS = 6000;
const PING_MS = 20000;
const SILENCE_LIMIT_MS = 65000; // three pings without any frame back: drop
// Looking for a server is cheap (refused connects to 127.0.0.1): every 3 s while the worker is awake, so a server
// that just started is found within seconds. A refusal (wrong code, busy) waits up to 30 s between tries.
const MAX_BACKOFF_MS = 3000;
const MAX_REFUSED_BACKOFF_MS = 30000;
const ALARM = "bridge-wake";
const TARGETS_CACHE_MS = 150; // how stale the tab URL checked before each cdp command may be
const MAX_REQUESTS_PER_TAB = 5000; // requestId -> url entries kept per tab
const MAX_PENDING_EXTRA_INFO = 500; // *ExtraInfo events held per tab until their request is known

// Never forwarded, whatever chrome.debugger itself would allow: the server
// must not open, close or reach beyond the user's tabs.
const DENIED_METHODS = new Set([
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
const DENIED_PREFIXES = ["Fetch.", "CacheStorage."];

// The Storage domain is mostly browser-wide (shared storage, interest groups,
// trust tokens, cookies): only these pass, and only for allowed origins.
const STORAGE_ALLOWED = new Set([
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
const BODY_READS = new Set(["Network.getResponseBody", "Network.getRequestPostData", "Network.searchInResponseBody", "Network.streamResourceContent"]);

// "https://host/" or "https://host/^0https://top/" (partitioned) -> "https://host/"
function storageKeyUrl(k) {
  return typeof k === "string" ? k.split("^")[0] : null;
}

// Commands that name other sites in their parameters: allowed only when
// every site they name is allowed. null = a required site is missing.
function siteUrls(method, params = {}) {
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

// ---------------------------------------------------------------- state

let ws = null; // the authenticated relay socket, or null
let chan = null; // its encrypted channel
let wsPort = null;
let connecting = null; // promise of a scan in progress
let failures = 0;
let retryTimer = null;
let nextScanAt = 0;
let pingTimer = null;
let lastHeard = 0;
let status = { state: "starting", port: null };

const attached = new Set(); // tabIds this extension attached
const attachedTargets = new Map(); // tabId -> CDP target id (= main frame id)
const attaching = new Map(); // tabId -> pending attach promise
let known = new Map(); // tabId -> Tab: allowed tabs the relay has been told about
let allowedCache = new Map(); // tabId -> Tab, refreshed by computeAllowed()
let scope = { patterns: [], granted: [], managed: [], wildcard: false, paused: false }; // last scope read
const recentlyClosed = new Set();

// Per attached tab:
const children = new Map(); // tabId -> Map<childSessionId, {targetId, type, url, parent?, clientPage}>
const rootClientPage = new Set(); // tabIds whose root session the client enabled Page on
const requests = new Map(); // tabId -> Map<"session|requestId", {url, ok}>
const pendingExtra = new Map(); // tabId -> Map<"session|requestId", [[method, params]...]>
const frameNav = new Map(); // tabId -> Map<frameId, url the frame last started navigating to or committed>
const MAX_FRAMES_PER_TAB = 1000;

// ---------------------------------------------------------------- helpers

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function hmacB64(code, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

function setStatus(state, port = null) {
  status = { state, port, at: Date.now() };
  chrome.storage.session.set({ status }).catch(() => {});
}

function send(msg) {
  if (!ws || !chan || ws.readyState !== WebSocket.OPEN) return false;
  return chan.send(msg);
}

function rpcError(message, code = -32000) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function getManaged() {
  try {
    return (await chrome.storage.managed.get(null)) || {};
  } catch {
    return {};
  }
}

// A pairing code counts only with exactly CODE_LENGTH characters after
// normalizing: a short code could be brute-forced from the MACs a fake relay
// collects (PROTOCOL.md, Pairing).
function validCode(raw) {
  const n = normalizeCode(raw);
  return n.length === CODE_LENGTH ? n : null;
}

async function getConfig() {
  const [local, managed] = await Promise.all([chrome.storage.local.get(null), getManaged()]);
  const managedSet = typeof managed.pairingCode === "string" && managed.pairingCode.trim() !== "";
  const managedCode = validCode(managed.pairingCode);
  const managedPort = Number.isInteger(managed.port) ? managed.port : null;
  const localPort = Number.isInteger(local.port) ? local.port : null;
  return {
    // An invalid managed code does not fall back to the user's: the policy means to replace it.
    code: managedSet ? managedCode : validCode(local.pairingCode),
    codeManaged: managedSet,
    codeManagedInvalid: managedSet && !managedCode,
    port: managedPort ?? localPort,
    portManaged: managedPort !== null,
    lastPort: local.lastPort,
    paused: !!local.paused,
    sites: Array.isArray(local.sites) ? local.sites.filter((x) => typeof x === "string") : [],
    managedOrigins: Array.isArray(managed.allowedOrigins) ? managed.allowedOrigins.filter((x) => typeof x === "string") : [],
  };
}

// ---------------------------------------------------------------- encrypted channel (PROTOCOL.md)

async function deriveKeys(code, nS, nE) {
  const enc = new TextEncoder();
  const hk = await crypto.subtle.importKey("raw", enc.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = async (label) => new Uint8Array(await crypto.subtle.sign("HMAC", hk, enc.encode(`${label}|${nS}|${nE}`)));
  const [s2e, e2s] = await Promise.all([raw("sap-gui-key-s2e"), raw("sap-gui-key-e2s")]);
  const [recv, sendKey] = await Promise.all([
    crypto.subtle.importKey("raw", s2e, { name: "AES-GCM" }, false, ["decrypt"]),
    crypto.subtle.importKey("raw", e2s, { name: "AES-GCM" }, false, ["encrypt"]),
  ]);
  return { recv, send: sendKey };
}

// IV = 4 zero bytes + 8-byte big-endian counter.
function ivFor(n) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(n));
  return iv;
}

// Frames are decrypted strictly in arrival order and sent strictly in call
// order, each direction with its own counter. A text frame or a frame that
// fails to decrypt closes the socket (4003) and nothing after it is obeyed.
function makeChannel(sock, keysP) {
  let recvCount = 0;
  let sendCount = 0;
  let recvChain = Promise.resolve();
  let sendChain = Promise.resolve();
  let dead = false;
  let onPlain = null;
  let onFail = null;
  const buffered = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const fail = (why) => {
    if (dead) return;
    dead = true;
    try {
      sock.close(4003, why);
    } catch {}
    if (onFail) onFail(why);
  };
  const deliver = (text) => {
    if (onPlain) onPlain(text);
    else buffered.push(text);
  };
  return {
    get dead() {
      return dead;
    },
    attach(plainHandler, failHandler) {
      onPlain = plainHandler;
      onFail = failHandler;
      if (dead) failHandler("closed");
      for (const t of buffered.splice(0)) plainHandler(t);
    },
    recv(data) {
      if (dead) return;
      if (typeof data === "string" || !(data instanceof ArrayBuffer)) {
        fail("text frame after welcome");
        return;
      }
      const n = recvCount++;
      recvChain = recvChain.then(async () => {
        if (dead) return;
        let text;
        try {
          const keys = await keysP;
          text = dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivFor(n) }, keys.recv, data));
        } catch {
          fail("decrypt");
          return;
        }
        if (!dead) deliver(text);
      });
    },
    send(msg) {
      if (dead) return false;
      const n = sendCount++;
      const bytes = enc.encode(JSON.stringify(msg));
      sendChain = sendChain
        .then(async () => {
          if (dead) return;
          const keys = await keysP;
          const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivFor(n) }, keys.send, bytes);
          if (!dead && sock.readyState === WebSocket.OPEN) sock.send(ct);
        })
        .catch(() => fail("encrypt"));
      return true;
    },
  };
}

// ---------------------------------------------------------------- scope

// Chrome match patterns: <scheme>://<host><path>, scheme * = http|https,
// host * or *.domain or exact, optional :port (none = any port).
function patternMatches(pattern, url) {
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

function isAllowedUrl(urlString, s = scope) {
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
function isAllowedResourceUrl(u) {
  if (typeof u !== "string") return false;
  if (u.startsWith("data:")) return true;
  if (u.startsWith("blob:")) return isAllowedUrl(u.slice(5));
  return isAllowedUrl(u);
}

// A child target (OOPIF, worker) of a shared tab: empty, about:blank and
// about:srcdoc frames, or a URL (blob: by its origin) of an allowed site.
function isAllowedChildUrl(u) {
  if (u === undefined || u === null || u === "" || u === "about:blank" || u === "about:srcdoc") return true;
  if (typeof u !== "string") return false;
  if (u.startsWith("blob:")) return isAllowedUrl(u.slice(5));
  return isAllowedUrl(u);
}

function webPattern(p) {
  return p === "<all_urls>" || /^(\*|https?):\/\//.test(p);
}

// "On all sites" in Chrome grants https://*/*, http://*/*, *://*/* or
// <all_urls>; IT could push the same. Such patterns never make every site
// shared: only sites added one by one count.
function isBareWildcard(p) {
  return p === "<all_urls>" || /^(\*|https?):\/\/\*(?::(\d+|\*))?\//.test(p);
}

async function readScope() {
  const [perms, cfg] = await Promise.all([chrome.permissions.getAll(), getConfig()]);
  const grantedAll = (perms.origins || []).filter(webPattern);
  const managedAll = cfg.managedOrigins.filter(webPattern);
  const specific = grantedAll.filter((p) => !isBareWildcard(p));
  // Sites added with "Allow this site" while Chrome already allows every
  // site (the permission request then adds no pattern of its own); they
  // still need Chrome's grant, so removing site access in Chrome revokes them.
  const added = [];
  for (const p of cfg.sites) {
    if (!webPattern(p) || isBareWildcard(p) || specific.includes(p)) continue;
    try {
      if (await chrome.permissions.contains({ origins: [p] })) added.push(p);
    } catch {}
  }
  const granted = [...new Set([...specific, ...added])];
  const managed = managedAll.filter((p) => !isBareWildcard(p));
  const wildcard = grantedAll.some(isBareWildcard) || managedAll.some(isBareWildcard);
  scope = { patterns: [...new Set([...granted, ...managed])], granted, managed, wildcard, paused: cfg.paused };
  return scope;
}

// chrome.debugger.getTargets(), cached briefly: checked before every cdp command.
let targetsCache = null;
let targetsAt = 0;
let targetsInFlight = null;
function noteTargets(t) {
  targetsCache = t;
  targetsAt = Date.now();
}
function invalidateTargets() {
  targetsCache = null;
}
async function currentTargets() {
  if (targetsCache && Date.now() - targetsAt <= TARGETS_CACHE_MS) return targetsCache;
  if (!targetsInFlight) {
    targetsInFlight = chrome.debugger
      .getTargets()
      .then((t) => (noteTargets(t), t))
      .finally(() => (targetsInFlight = null));
  }
  return targetsInFlight;
}

// All page targets with a tab, plus the allowed subset as Tab objects.
// chrome.debugger.getTargets() shows url and title of every tab without the
// "tabs" permission (tab.url from chrome.tabs is hidden for non-granted sites).
async function computeAllowed() {
  const s = await readScope();
  const targets = await chrome.debugger.getTargets();
  noteTargets(targets);
  const all = new Map();
  const allowed = new Map();
  for (const t of targets) {
    if (t.type !== "page" || typeof t.tabId !== "number" || all.has(t.tabId)) continue;
    all.set(t.tabId, t);
    if (isAllowedUrl(t.url, s)) allowed.set(t.tabId, { tabId: t.tabId, targetId: t.id, url: t.url, title: t.title });
  }
  await Promise.all(
    [...allowed.values()].map(async (tab) => {
      try {
        const ct = await chrome.tabs.get(tab.tabId);
        if (typeof ct.openerTabId === "number") tab.openerTabId = ct.openerTabId;
      } catch {}
    }),
  );
  allowedCache = allowed;
  return { allowed, all };
}

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

// Recompute the allowed set, detach what left it, tell the relay the diff.
// Serialized; bursts of tab events are coalesced.
let recomputeChain = Promise.resolve();
let recomputeQueued = false;
function scheduleRecompute() {
  if (recomputeQueued) return recomputeChain;
  recomputeQueued = true;
  recomputeChain = recomputeChain
    .then(() => {
      recomputeQueued = false;
      return recompute();
    })
    .catch((e) => console.warn("recompute", e));
  return recomputeChain;
}

async function recompute() {
  const { allowed, all } = await computeAllowed();
  const reasons = new Map();
  const reasonFor = (tabId, old) => {
    if (scope.paused) return "paused";
    if (recentlyClosed.has(tabId) || !all.has(tabId)) return "closed";
    const t = all.get(tabId);
    if (old && originOf(old.url) !== originOf(t.url)) return "left_origin";
    if (old && !isAllowedUrl(old.url)) return "origin_revoked";
    return "left_origin";
  };
  for (const tabId of [...attached]) {
    if (!allowed.has(tabId)) {
      reasons.set(tabId, reasonFor(tabId, known.get(tabId)));
      await detachTab(tabId);
    }
  }
  if (ws) {
    for (const [tabId, old] of known) {
      if (!allowed.has(tabId)) send({ type: "tabRemoved", tabId, reason: reasons.get(tabId) || reasonFor(tabId, old) });
    }
    for (const [tabId, tab] of allowed) if (!known.has(tabId)) send({ type: "tabAdded", tab });
  }
  known = new Map(allowed);
  recentlyClosed.clear();
}

// ---------------------------------------------------------------- debugger

function persistAttached() {
  chrome.storage.session.set({ attached: [...attached] }).catch(() => {});
}

function forgetTabState(tabId) {
  children.delete(tabId);
  rootClientPage.delete(tabId);
  requests.delete(tabId);
  pendingExtra.delete(tabId);
  frameNav.delete(tabId);
}

async function attachTab(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = chrome.debugger
    .attach({ tabId }, "1.3")
    .then(async () => {
      forgetTabState(tabId);
      attached.add(tabId);
      persistAttached();
      // Page events let the extension see every navigation start, whatever
      // the client enabled; the client gets them only after its own Page.enable.
      await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
    })
    .finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

async function detachTab(tabId) {
  const had = attached.delete(tabId);
  attachedTargets.delete(tabId);
  forgetTabState(tabId);
  if (had) persistAttached();
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  return had;
}

async function detachAll() {
  await Promise.all([...attached].map(detachTab));
}

// After a worker restart the old socket is gone, so the relay already dropped
// its CDP client: release anything a previous worker instance attached.
async function releaseLeftovers() {
  const { attached: stored = [] } = await chrome.storage.session.get("attached");
  const ids = new Set(stored);
  try {
    for (const t of await chrome.debugger.getTargets()) if (t.attached && typeof t.tabId === "number") ids.add(t.tabId);
  } catch {}
  const released = [];
  await Promise.all(
    [...ids].map((tabId) =>
      chrome.debugger.detach({ tabId }).then(
        () => released.push(tabId),
        () => {}, // not ours (DevTools, another extension): Chrome refuses, fine
      ),
    ),
  );
  attached.clear();
  persistAttached();
  return released;
}

function cdpError(e) {
  const text = (e && e.message) || String(e);
  try {
    const j = JSON.parse(text);
    if (j && typeof j.message === "string") return rpcError(j.message, typeof j.code === "number" ? j.code : -32000);
  } catch {}
  return rpcError(text);
}

function requireTabId(m) {
  if (!Number.isInteger(m.tabId)) throw rpcError("tabId missing");
  return m.tabId;
}

// ---------------------------------------------------------------- child sessions (OOPIF, workers)

function kidsOf(tabId) {
  let k = children.get(tabId);
  if (!k) children.set(tabId, (k = new Map()));
  return k;
}

function sessionTarget(tabId, sessionId) {
  return sessionId ? { tabId, sessionId } : { tabId };
}

// Detach a child the client must not use. A child paused by
// waitForDebuggerOnStart is resumed first (Chrome keeps it paused when the
// session that paused it just detaches); if the detach fails, resume, retry.
async function releaseChild(tabId, parentSessionId, childSessionId, waiting) {
  const parent = sessionTarget(tabId, parentSessionId);
  if (waiting) await chrome.debugger.sendCommand({ tabId, sessionId: childSessionId }, "Runtime.runIfWaitingForDebugger").catch(() => {});
  try {
    await chrome.debugger.sendCommand(parent, "Target.detachFromTarget", { sessionId: childSessionId });
  } catch {
    try {
      await chrome.debugger.sendCommand({ tabId, sessionId: childSessionId }, "Runtime.runIfWaitingForDebugger");
    } catch {}
    try {
      await chrome.debugger.sendCommand(parent, "Target.detachFromTarget", { sessionId: childSessionId });
    } catch {}
  }
}

// Untrack a child and its descendants. synthetic: tell the relay they are
// gone (Chrome's own detachedFromTarget events for them are dropped, since
// they are no longer tracked).
function dropChild(tabId, sessionId, synthetic) {
  const kids = children.get(tabId);
  if (!kids || !kids.has(sessionId)) return;
  for (const [sid, c] of [...kids]) if (c.parent === sessionId) dropChild(tabId, sid, true);
  const c = kids.get(sessionId);
  kids.delete(sessionId);
  const reqs = requests.get(tabId);
  if (reqs) for (const k of [...reqs.keys()]) if (k.startsWith(sessionId + "|")) reqs.delete(k);
  if (synthetic) {
    const msg = { type: "event", tabId, method: "Target.detachedFromTarget", params: { sessionId, targetId: c.targetId } };
    if (c.parent) msg.sessionId = c.parent;
    send(msg);
  }
}

// A tracked child moved to a site that is not shared.
function kickChild(tabId, sessionId) {
  const c = children.get(tabId)?.get(sessionId);
  if (!c) return;
  dropChild(tabId, sessionId, true);
  releaseChild(tabId, c.parent, sessionId);
}

function noteFrameNav(tabId, method, p) {
  let frameId;
  let url;
  if (method === "Page.frameStartedNavigating" || method === "Page.frameRequestedNavigation") {
    frameId = p.frameId;
    url = p.url;
  } else if (method === "Page.frameNavigated" && p.frame) {
    frameId = p.frame.id;
    url = p.frame.url;
  } else return;
  if (typeof frameId !== "string" || typeof url !== "string") return;
  let m = frameNav.get(tabId);
  if (!m) frameNav.set(tabId, (m = new Map()));
  m.delete(frameId);
  m.set(frameId, url);
  while (m.size > MAX_FRAMES_PER_TAB) m.delete(m.keys().next().value);
}

function onChildAttached(tabId, parentSessionId, params) {
  const sid = params.sessionId;
  const info = params.targetInfo || {};
  if (typeof sid !== "string") return false;
  let url = info.url;
  if (info.type === "iframe" && (!url || url === "about:blank")) {
    // An OOPIF exists because of a cross-site navigation. Attached while
    // waiting for the debugger, it has no URL yet: judge it by the navigation
    // its frame started (seen in the parent's Page events), refuse if unknown.
    url = frameNav.get(tabId)?.get(info.targetId);
    if (!url) {
      releaseChild(tabId, parentSessionId, sid, params.waitingForDebugger);
      return false;
    }
  }
  if (!isAllowedChildUrl(url)) {
    releaseChild(tabId, parentSessionId, sid, params.waitingForDebugger);
    return false;
  }
  kidsOf(tabId).set(sid, { targetId: info.targetId, type: info.type, url, parent: parentSessionId, clientPage: false });
  if (info.type === "iframe" || info.type === "page") {
    // As for the tab itself: see the child's navigations whatever the client enables.
    chrome.debugger.sendCommand({ tabId, sessionId: sid }, "Page.enable").catch(() => {});
  }
  return true;
}

// ---------------------------------------------------------------- network bookkeeping

function reqMap(tabId) {
  let m = requests.get(tabId);
  if (!m) requests.set(tabId, (m = new Map()));
  return m;
}

function rememberRequest(tabId, key, url) {
  const m = reqMap(tabId);
  const ok = isAllowedResourceUrl(url);
  m.delete(key); // re-insert: most recent last
  m.set(key, { url, ok });
  while (m.size > MAX_REQUESTS_PER_TAB) m.delete(m.keys().next().value);
  return ok;
}

function hostOfHeaders(headers) {
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
    return urls.every(isAllowedResourceUrl) ? [[method, p]] : [];
  }
  const key = (sid || "") + "|" + rid;
  const m = reqMap(tabId);
  if (method === "Network.requestWillBeSent" || method === "Network.webSocketCreated") {
    const url = method === "Network.webSocketCreated" ? p.url : p.request && p.request.url;
    const before = m.get(key);
    const ok = rememberRequest(tabId, key, url);
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

// ---------------------------------------------------------------- requests from the relay

async function checkCdp(m, tabId) {
  const method = m.method;
  const params = m.params || {};
  const sid = typeof m.sessionId === "string" ? m.sessionId : undefined;
  if (m.sessionId !== undefined && typeof m.sessionId !== "string") throw rpcError("bad sessionId");
  if (DENIED_METHODS.has(method) || DENIED_PREFIXES.some((p) => method.startsWith(p)) || (method.startsWith("Storage.") && !STORAGE_ALLOWED.has(method))) {
    throw rpcError(`${method} is not available through the extension`);
  }
  if (sid !== undefined && !children.get(tabId)?.has(sid)) throw rpcError(`session ${sid} is not a shared child of tab ${tabId}`);
  switch (method) {
    case "Page.disable":
    case "Network.disable":
      // The extension relies on these events to see a tab leave the shared sites.
      throw rpcError(`${method} is not available through the extension`);
    case "Target.setAutoAttach":
      if (params.flatten !== true) throw rpcError("Target.setAutoAttach needs flatten: true through the extension");
      break;
    case "Target.detachFromTarget":
      if (typeof params.sessionId !== "string" || !children.get(tabId)?.has(params.sessionId)) throw rpcError("Target.detachFromTarget: not a shared child session");
      break;
    case "Target.getTargetInfo": {
      const own = attachedTargets.get(tabId);
      const kids = [...(children.get(tabId)?.values() || [])].map((c) => c.targetId);
      if (params.targetId !== undefined && params.targetId !== own && !kids.includes(params.targetId)) throw rpcError("Target.getTargetInfo: not a shared target");
      break;
    }
    case "Page.navigateToHistoryEntry": {
      let entry;
      try {
        const h = await chrome.debugger.sendCommand(sessionTarget(tabId, sid), "Page.getNavigationHistory");
        entry = (h.entries || []).find((e) => e.id === params.entryId);
      } catch {}
      if (!entry || !isAllowedUrl(entry.url)) throw rpcError(`Page.navigateToHistoryEntry: ${entry ? entry.url : "that entry"} is not a shared site`);
      break;
    }
    default:
      if (BODY_READS.has(method)) {
        const r = typeof params.requestId === "string" ? requests.get(tabId)?.get((sid || "") + "|" + params.requestId) : null;
        if (!r || !r.ok) throw rpcError(`${method}: request ${params.requestId} is not a request to a shared site`);
      }
  }
  for (const u of siteUrls(method, params)) {
    if (u === null || !isAllowedUrl(u)) throw rpcError(`${method}: ${u === null ? "a site must be named and" : u} is not a shared site`);
  }
}

async function handleRequest(m) {
  switch (m.type) {
    case "tabs": {
      const { allowed } = await computeAllowed();
      return { tabs: [...allowed.values()] };
    }
    case "attach": {
      const tabId = requireTabId(m);
      const { allowed } = await computeAllowed();
      const tab = allowed.get(tabId);
      if (!tab) throw rpcError(`tab ${tabId} is not shared with sap-gui-mcp-server`);
      attachedTargets.set(tabId, tab.targetId);
      try {
        await attachTab(tabId);
      } catch (e) {
        if (!attached.has(tabId)) attachedTargets.delete(tabId);
        throw rpcError(`cannot attach to tab ${tabId}: ${e.message || e}`);
      }
      return { tab };
    }
    case "detach": {
      await detachTab(requireTabId(m));
      return {};
    }
    case "cdp": {
      const tabId = requireTabId(m);
      if (!allowedCache.has(tabId) || scope.paused) throw rpcError(`tab ${tabId} is not shared with sap-gui-mcp-server`);
      if (!attached.has(tabId)) throw rpcError(`tab ${tabId} is not attached`);
      if (typeof m.method !== "string") throw rpcError("method missing");
      await checkCdp(m, tabId);
      // The tab may have left the shared sites without an event the
      // extension saw (page JS, history): check its URL now.
      const t = (await currentTargets()).find((x) => x.tabId === tabId && x.type === "page");
      if (!t || !isAllowedUrl(t.url)) {
        if (attached.has(tabId)) leaveOrigin(tabId);
        throw rpcError(`tab ${tabId} is not shared with sap-gui-mcp-server (it left the shared sites)`);
      }
      if (!attached.has(tabId)) throw rpcError(`tab ${tabId} is not attached`);
      const target = sessionTarget(tabId, m.sessionId);
      try {
        const result = await chrome.debugger.sendCommand(target, m.method, m.params || {});
        if (m.method === "Page.enable") {
          if (m.sessionId) {
            const c = children.get(tabId)?.get(m.sessionId);
            if (c) c.clientPage = true;
          } else rootClientPage.add(tabId);
        }
        return { result: result || {} };
      } catch (e) {
        throw cdpError(e);
      }
    }
    default:
      throw rpcError(`unknown request type ${m.type}`, -32601);
  }
}

// ---------------------------------------------------------------- events

// The URL a main-frame event says the frame is going to, or null. The main
// frame's id is the target id (the tab's, or the child's for an OOPIF).
// Caught at the start of the navigation (before the request goes out) so
// nothing of a non-allowed page reaches the relay: not its URL, request
// headers or cookies, nor its content.
function mainFrameDestination(main, method, params, isChild) {
  if (!params) return null;
  switch (method) {
    case "Page.frameStartedNavigating":
    case "Page.frameRequestedNavigation":
      return params.frameId === main && (method !== "Page.frameRequestedNavigation" || params.disposition === "currentTab") ? params.url : null;
    case "Page.frameNavigated":
      // An OOPIF's root frame keeps its parentId in the child session: match it by id.
      if (!params.frame) return null;
      return (isChild ? params.frame.id === main : !params.frame.parentId) ? params.frame.url : null;
    case "Network.requestWillBeSent":
      return params.type === "Document" && params.frameId === main && params.request ? params.request.url : null;
    default:
      return null;
  }
}

// Detach now (events stop at once: `attached` is updated synchronously), tell
// the relay in order with the other tab messages, then recompute: if the
// navigation did not happen after all (a download, a 204), the tab comes back
// with tabAdded.
function leaveOrigin(tabId) {
  detachTab(tabId);
  recomputeChain = recomputeChain
    .then(() => {
      if (known.delete(tabId)) send({ type: "tabRemoved", tabId, reason: "left_origin" });
    })
    .catch(() => {});
  scheduleRecompute();
}

function leaves(dest, method, allowedFn) {
  // At the start of a navigation only http(s) destinations count (a
  // javascript: URL is not a navigation); once committed, anything that is
  // not allowed (about:blank, chrome-error://) is outside the scope.
  return dest !== null && dest !== undefined && !allowedFn(dest) && (method === "Page.frameNavigated" || /^https?:/i.test(dest));
}

function forward(tabId, sid, method, params) {
  const msg = { type: "event", tabId, method, params };
  if (sid) msg.sessionId = sid;
  send(msg);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!attached.has(tabId)) return;
  params = params || {};
  const sid = source.sessionId;
  const kids = kidsOf(tabId);
  const child = sid ? kids.get(sid) : null;
  if (sid && !child) return; // a child the client may not use, or already gone
  if (method.startsWith("Fetch.") || method === "Target.receivedMessageFromTarget") return;
  if (method.startsWith("Page.frame")) noteFrameNav(tabId, method, params);

  if (!sid) {
    const dest = mainFrameDestination(attachedTargets.get(tabId), method, params, false);
    if (leaves(dest, method, isAllowedUrl)) {
      leaveOrigin(tabId);
      return;
    }
  } else if (child.type === "iframe" || child.type === "page") {
    const dest = mainFrameDestination(child.targetId, method, params, true);
    if (leaves(dest, method, isAllowedChildUrl)) {
      kickChild(tabId, sid);
      return;
    }
    if (method === "Page.frameNavigated" && dest) child.url = dest;
  }

  switch (method) {
    case "Target.attachedToTarget":
      if (onChildAttached(tabId, sid, params)) forward(tabId, sid, method, params);
      return;
    case "Target.detachedFromTarget":
      if (!kids.has(params.sessionId)) return;
      dropChild(tabId, params.sessionId, false);
      forward(tabId, sid, method, params);
      return;
    case "Target.targetInfoChanged": {
      const info = params.targetInfo || {};
      const own = info.targetId === attachedTargets.get(tabId);
      const entry = [...kids].find(([, c]) => c.targetId === info.targetId);
      if (entry) {
        if (!isAllowedChildUrl(info.url)) {
          kickChild(tabId, entry[0]);
          return;
        }
        entry[1].url = info.url;
      } else if (!own) return;
      else if (!isAllowedUrl(info.url)) {
        leaveOrigin(tabId);
        return;
      }
      forward(tabId, sid, method, params);
      return;
    }
  }

  // Page events the extension enabled for itself reach the client only after its own Page.enable.
  if (method.startsWith("Page.") && !(sid ? child.clientPage : rootClientPage.has(tabId))) return;

  if (method.startsWith("Network.")) {
    for (const [mth, p] of filterNetworkEvent(tabId, sid, method, params)) forward(tabId, sid, mth, p);
    return;
  }
  forward(tabId, sid, method, params);
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  const tabId = source.tabId;
  if (!attached.delete(tabId)) return;
  forgetTabState(tabId);
  persistAttached();
  send({ type: "detached", tabId, reason });
  if (reason === "canceled_by_user") {
    // Cancel on Chrome's "started debugging this browser" bar: stop sharing
    // everywhere until the user clicks Resume in the popup.
    await chrome.storage.local.set({ paused: true });
  }
  if (reason === "target_closed") recentlyClosed.add(tabId);
  scheduleRecompute();
});

// ---------------------------------------------------------------- relay connection

// One port: open, hello, auth, verify welcome, import the frame keys.
// Resolves {ok:true, socket, chan} only after the relay proved it holds the code.
function tryPort(port, code) {
  return new Promise((resolve) => {
    let sock;
    let stage = "open";
    let nS;
    let nE;
    let done = false;
    const pending = []; // frames that arrive while the welcome mac is checked and the keys imported
    let timer = setTimeout(() => finish({ ok: false, reason: "not_found" }), OPEN_TIMEOUT_MS);
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (r.ok) {
        sock.onclose = sock.onerror = null;
        resolve({ ...r, socket: sock });
      } else {
        try {
          sock && sock.close();
        } catch {}
        resolve(r);
      }
    };
    const rearm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ ok: false, reason: "not_relay" }), ms);
    };
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}/extension`);
      sock.binaryType = "arraybuffer";
    } catch {
      finish({ ok: false, reason: "not_found" });
      return;
    }
    sock.onopen = () => {
      stage = "hello";
      rearm(HELLO_TIMEOUT_MS);
    };
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (ev.code === 4001) return finish({ ok: false, reason: "wrong_code" });
      if (ev.code === 4002) return finish({ ok: false, reason: "busy" });
      finish({ ok: false, reason: stage === "open" ? "not_found" : "not_relay" });
    };
    sock.onmessage = async (ev) => {
      if (stage === "verifying") {
        pending.push(ev.data);
        return;
      }
      if (typeof ev.data !== "string") return finish({ ok: false, reason: stage === "auth" ? "untrusted" : "not_relay" });
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return finish({ ok: false, reason: "not_relay" });
      }
      if (stage === "hello") {
        if (!m || m.type !== "hello" || m.v !== 1 || typeof m.nonce !== "string" || m.nonce.length < 16 || m.nonce.length > 64) {
          return finish({ ok: false, reason: "not_relay" });
        }
        stage = "auth";
        nS = m.nonce;
        nE = b64(crypto.getRandomValues(new Uint8Array(16)));
        const mac = await hmacB64(code, `sap-gui-ext|${nS}|${nE}`);
        if (done) return;
        sock.send(JSON.stringify({ type: "auth", nonce: nE, mac, extensionVersion: EXT_VERSION, userAgent: navigator.userAgent }));
        rearm(WELCOME_TIMEOUT_MS);
        return;
      }
      if (stage === "auth") {
        if (m && m.type === "refused") return finish({ ok: false, reason: m.reason === "busy" ? "busy" : "wrong_code" });
        // Anything but a welcome before the welcome (a request, say) means
        // this is not a relay we will obey.
        if (!m || m.type !== "welcome" || typeof m.mac !== "string") return finish({ ok: false, reason: "untrusted" });
        stage = "verifying";
        const want = await hmacB64(code, `sap-gui-srv|${nS}|${nE}`);
        if (!constantTimeEqual(want, m.mac)) return finish({ ok: false, reason: "untrusted" });
        let keys;
        try {
          keys = await deriveKeys(code, nS, nE);
        } catch {
          return finish({ ok: false, reason: "untrusted" });
        }
        if (done) return;
        // From here on every frame goes through the channel, in order.
        const c = makeChannel(sock, Promise.resolve(keys));
        sock.onmessage = (e) => c.recv(e.data);
        for (const d of pending.splice(0)) c.recv(d);
        finish({ ok: true, chan: c });
      }
    };
  });
}

const STATUS_RANK = { not_found: 0, not_relay: 0, busy: 1, untrusted: 2, wrong_code: 3, tampered: 4 };

async function scan() {
  const cfg = await getConfig();
  if (!cfg.code) {
    setStatus(cfg.codeManagedInvalid ? "bad_managed_code" : "no_code");
    return false;
  }
  setStatus("searching");
  let ports;
  if (cfg.port) ports = [cfg.port];
  else {
    ports = [];
    for (let p = PORT_FIRST; p <= PORT_LAST; p++) ports.push(p);
    if (ports.includes(cfg.lastPort)) ports = [cfg.lastPort, ...ports.filter((p) => p !== cfg.lastPort)];
  }
  let worst = { reason: "not_found", port: null };
  for (const port of ports) {
    const r = await tryPort(port, cfg.code);
    if (r.ok) {
      if (await adopt(r, port)) return true;
      // A frame right after the welcome failed to decrypt (or the socket died): not obeyed.
      if (r.chan.dead) worst = { reason: "tampered", port };
      continue;
    }
    if ((STATUS_RANK[r.reason] ?? 0) > (STATUS_RANK[worst.reason] ?? 0)) worst = { reason: r.reason, port };
  }
  setStatus(worst.reason === "not_relay" ? "not_found" : worst.reason, worst.port);
  return false;
}

async function adopt(r, port) {
  const sock = r.socket;
  if (sock.readyState !== WebSocket.OPEN || r.chan.dead) return false;
  ws = sock;
  chan = r.chan;
  wsPort = port;
  lastHeard = Date.now();
  ws.onclose = (ev) => {
    // The channel closes the socket itself when a frame fails to decrypt.
    if (r.chan.dead) return teardown(sock, "tampered", false);
    teardown(sock, ev.code === 4001 ? "wrong_code" : ev.code === 4002 ? "busy" : "disconnected", ev.code === 4001 || ev.code === 4002);
  };
  ws.onerror = () => {};
  setStatus("connected", port);
  chrome.storage.local.set({ lastPort: port }).catch(() => {});
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (!ws) return;
    if (Date.now() - lastHeard > SILENCE_LIMIT_MS) {
      ws.close(4004, "no pong");
      return;
    }
    send({ type: "ping" });
  }, PING_MS);
  // The relay asks for "tabs" itself; start the diff from the current set.
  try {
    known = new Map((await computeAllowed()).allowed);
  } catch {
    known = new Map();
  }
  // Frames decrypted so far (and from now on) are handled in order. A frame
  // that fails to decrypt: nothing after it is obeyed, everything is released.
  r.chan.attach(onRelayMessage, () => teardown(sock, "tampered", false));
  return true;
}

function onRelayMessage(data) {
  lastHeard = Date.now();
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  if (!m || m.type === "pong") return;
  if (!Number.isInteger(m.id)) return;
  handleRequest(m).then(
    (result) => send({ id: m.id, result }),
    (e) => send({ id: m.id, error: { message: (e && e.message) || String(e), code: typeof e?.code === "number" ? e.code : -32000 } }),
  );
}

async function teardown(sock, state, refused) {
  if (ws !== sock) return;
  ws = null;
  chan = null;
  wsPort = null;
  clearInterval(pingTimer);
  pingTimer = null;
  known = new Map();
  // The relay's CDP client went with the socket: release every tab.
  await detachAll();
  setStatus(state, state === "tampered" ? status.port : null);
  failures = 0;
  scheduleRetry(refused);
}

function scheduleRetry(refused = false) {
  failures++;
  const delay = refused ? MAX_REFUSED_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 5));
  nextScanAt = Date.now() + delay;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => ensureConnected(), delay);
}

// force: user action or settings change, skips the backoff.
function ensureConnected({ force = false } = {}) {
  if (ws) return Promise.resolve(true);
  if (connecting) return connecting;
  if (!force && Date.now() < nextScanAt) return Promise.resolve(false);
  clearTimeout(retryTimer);
  connecting = scan()
    .catch((e) => {
      console.warn("scan", e);
      return false;
    })
    .then((ok) => {
      connecting = null;
      if (ok) failures = 0;
      else scheduleRetry();
      return ok;
    });
  return connecting;
}

async function reconnect() {
  if (ws) {
    const s = ws;
    ws = null;
    chan = null;
    clearInterval(pingTimer);
    known = new Map();
    await detachAll();
    try {
      s.close(1000, "reconnect");
    } catch {}
  }
  failures = 0;
  nextScanAt = 0;
  if (connecting) await connecting;
  return ensureConnected({ force: true });
}

// ---------------------------------------------------------------- popup

async function popupState(tabId) {
  const cfg = await getConfig();
  const { allowed, all } = await computeAllowed();
  let currentTab = null;
  if (Number.isInteger(tabId) && all.has(tabId)) {
    const t = all.get(tabId);
    let origin = null;
    let web = false;
    try {
      const u = new URL(t.url);
      web = u.protocol === "http:" || u.protocol === "https:";
      origin = web ? u.origin : null;
    } catch {}
    currentTab = { tabId, url: t.url, title: t.title, web, origin, allowed: allowed.has(tabId), matches: web && isAllowedUrl(t.url, { ...scope, paused: false }) };
  }
  return {
    status: status.state,
    port: status.port,
    code: { set: !!cfg.code, managed: cfg.codeManaged, managedInvalid: cfg.codeManagedInvalid },
    portSetting: { value: cfg.port, managed: cfg.portManaged },
    paused: cfg.paused,
    origins: { granted: scope.granted, managed: scope.managed, wildcard: scope.wildcard },
    shared: [...attached].map((id) => allowed.get(id) || { tabId: id, url: "", title: "" }),
    currentTab,
    version: EXT_VERSION,
  };
}

async function handlePopup(msg) {
  switch (msg && msg.cmd) {
    case "wake":
      ensureConnected({ force: true }); // the popup opened: look for a server now, not at the next retry
      return { ok: true };
    case "state":
      return popupState(msg.tabId);
    case "setCode": {
      const code = normalizeCode(msg.code);
      if (!code) {
        await chrome.storage.local.remove("pairingCode");
        return { ok: true, code };
      }
      if (code.length !== CODE_LENGTH) throw new Error(`A pairing code has ${CODE_LENGTH} letters and digits; this one has ${code.length}.`);
      await chrome.storage.local.set({ pairingCode: code });
      return { ok: true, code };
    }
    case "addSite": {
      // After "Allow this site": Chrome granted the pattern (or already allows every site).
      const p = msg.pattern;
      if (typeof p !== "string" || !webPattern(p) || isBareWildcard(p)) throw new Error("invalid site pattern");
      if (!(await chrome.permissions.contains({ origins: [p] }))) throw new Error("Chrome did not grant access to this site");
      const { sites = [] } = await chrome.storage.local.get("sites");
      if (!sites.includes(p)) await chrome.storage.local.set({ sites: [...sites, p] });
      return { ok: true };
    }
    case "removeSite": {
      const p = msg.pattern;
      if (typeof p !== "string") throw new Error("invalid site pattern");
      const { sites = [] } = await chrome.storage.local.get("sites");
      if (sites.includes(p)) await chrome.storage.local.set({ sites: sites.filter((x) => x !== p) });
      await chrome.permissions.remove({ origins: [p] }).catch(() => {}); // a required or wildcard grant stays; the site still stops counting
      scheduleRecompute();
      return { ok: true };
    }
    case "setPort": {
      const p = msg.port === null || msg.port === "" ? null : Number(msg.port);
      if (p === null) await chrome.storage.local.remove("port");
      else if (Number.isInteger(p) && p > 0 && p < 65536) await chrome.storage.local.set({ port: p });
      else throw new Error("invalid port");
      return { ok: true };
    }
    case "pause":
      await chrome.storage.local.set({ paused: true });
      return { ok: true };
    case "resume":
      await chrome.storage.local.set({ paused: false });
      return { ok: true };
    case "reconnect":
      reconnect();
      return { ok: true };
    default:
      throw new Error("unknown command");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handlePopup(msg).then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
  return true;
});

// ---------------------------------------------------------------- wake-ups and scope changes

function onTabEvent() {
  invalidateTargets();
  scheduleRecompute();
  ensureConnected();
}

chrome.tabs.onCreated.addListener(onTabEvent);
chrome.tabs.onUpdated.addListener(onTabEvent);
chrome.tabs.onReplaced.addListener(onTabEvent);
chrome.tabs.onRemoved.addListener((tabId) => {
  recentlyClosed.add(tabId);
  onTabEvent();
});

chrome.permissions.onAdded.addListener(() => scheduleRecompute());
chrome.permissions.onRemoved.addListener(() => scheduleRecompute());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" || area === "managed") {
    if ("pairingCode" in changes || "port" in changes) reconnect();
    if ("paused" in changes || "allowedOrigins" in changes || "sites" in changes) scheduleRecompute();
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) ensureConnected();
});

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ensureConnected({ force: true });
});
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  ensureConnected({ force: true });
});

// Worker (re)start: no socket survives a restart, so release old attachments
// first, then connect.
const bootInfo = { at: Date.now(), released: [] };
const booted = (async () => {
  await ensureAlarm().catch(() => {});
  bootInfo.released = await releaseLeftovers().catch((e) => (console.warn("releaseLeftovers", e), []));
  await readScope().catch(() => {});
  await ensureConnected({ force: true });
})();

// For tests and for inspecting the worker from chrome://extensions.
globalThis.bridge = {
  booted,
  bootInfo,
  status: () => ({ ...status, attached: [...attached], known: [...known.keys()], children: Object.fromEntries([...children].map(([t, k]) => [t, [...k.keys()]])) }),
  reconnect,
  command: handlePopup,
  normalizeCode,
};
