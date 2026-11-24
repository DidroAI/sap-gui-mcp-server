/**
 * The relay between the sap-ui-automation extension and Playwright (see extension/PROTOCOL.md).
 *
 * `chrome.debugger` in an MV3 extension gives one CDP session per tab (plus
 * flat child sessions) and no browser target, while Playwright's
 * `connectOverCDP` wants a browser: `Browser.getVersion`, a root
 * `Target.setAutoAttach` answered by one `Target.attachedToTarget` per page,
 * browser sessions for `newCDPSession`. The relay is that browser. It answers
 * browser-level commands itself, forwards page commands to the tab they belong
 * to, and re-emits the tab's events under the session ids it gave out.
 *
 * Two WebSocket endpoints on 127.0.0.1 only:
 * - `/extension`: the extension, with a `chrome-extension://` Origin (a web
 *   page cannot connect) and the pairing handshake (pairing.ts). One at a time.
 * - `/cdp/<secret>`: Playwright, with no Origin header (no web page), at a
 *   path only this process knows. One at a time.
 */
import { randomBytes } from "node:crypto";
import { createServer, STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { FrameCipher, hmac, sameSecret, sessionKey } from "./pairing.js";
import { WebSocket, WebSocketServer } from "./ws.js";

/** The ports the extension scans, in order. */
export const EXTENSION_PORTS: readonly number[] = [47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830];
/** The one browser context the relay shows: the user's own tabs. */
export const BROWSER_CONTEXT_ID = "sap-extension";
const BROWSER_TARGET_ID = "sap-extension-browser";
/** The extension has this long to authenticate after connecting. */
const AUTH_TIMEOUT_MS = 10_000;
/** The extension pings every 20 s; a socket silent for longer than this is dead (a worker killed without a close). */
const SILENCE_MS = 65_000;
/** Before the handshake nothing bigger than an `auth` frame is read, and only this many such sockets are open at once. */
const PRE_AUTH_MAX_BYTES = 4096;
const MAX_UNAUTHENTICATED = 4;
/** A request the extension has not answered by then fails, so a stuck tab does not hold Playwright forever. */
const REQUEST_TIMEOUT_MS = 60_000;

/** A tab as the extension describes it. */
export interface ExtensionTab {
  tabId: number;
  targetId: string;
  url: string;
  title: string;
  openerTabId?: number;
}

/** A SAP system registered in the extension, as the server sees it (extension/background.js, systemsForServer). */
export interface ExtensionSystem {
  id: string;
  name: string;
  url: string;
  kind: "webgui" | "fiori" | "other";
  client: string;
  language: string;
  user: string;
  /** password: the extension logs on with a saved password; sso: SAP logs on by itself; manual: the user types it. */
  logon: "password" | "sso" | "manual";
  /** A tab shows it now. */
  open: boolean;
  /** What SAP answered to the last logon, while it stands: a refused password (until the user saves a new one), a lock. */
  issue?: { reason: string; at: string };
}

export interface LogonOptions {
  /** SAP asks whether to end the user's other logons, and the user said to keep them. */
  otherLogons?: "keep";
}

/** What the extension answers to "logon". */
export interface LogonResult {
  system: string;
  client: string;
  user: string;
  /** logged_on: it logged on now; already: a tab was logged on; sso: opened, SAP logged on by itself; needs_user: the logon page waits for the user. */
  state: "logged_on" | "already" | "sso" | "needs_user";
  /** needs_user: why (no_password, sso_logon_page, identity_provider). */
  reason?: string;
  tabId?: number;
  /** The tab's CDP target id: the server's session is "chrome:<targetId>". */
  targetId?: string;
  message?: string;
}

/** A logon waits for SAP's logon page, then for SAP's answer. */
const LOGON_TIMEOUT_MS = 150_000;

/** Why the last extension that tried was turned away: a wrong pairing code, or another extension already connected. */
export type Refusal = "code" | "busy";

export interface ExtensionInfo {
  connected: boolean;
  extensionVersion?: string;
  userAgent?: string;
  /** Tabs the extension reported as allowed (known to the relay). */
  tabs: number;
  /** Connections to /extension since the relay started, authenticated or not: 0 means no extension ever tried. */
  attempts: number;
  lastRefusal?: Refusal;
  /** Playwright is connected. */
  cdpClient: boolean;
}

export interface RelayOptions {
  /** The pairing code (normalized or not). */
  code: string;
  /** One port instead of the range (SAP_EXTENSION_PORT); 0 picks any free port (tests). */
  port?: number;
  /** The server version, sent in `hello`. */
  version?: string;
  authTimeoutMs?: number;
  requestTimeoutMs?: number;
}

type Params = Record<string, unknown>;

interface CdpMessage {
  id?: number | undefined;
  sessionId?: string | undefined;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: { message: string; code: number };
}

/** A CDP error to answer with. */
export class CdpError extends Error {
  constructor(
    message: string,
    readonly code = -32000,
    /** Why the extension refused (a logon's outcome: wrong_password, user_locked, multiple_logon...), when it says. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Extension {
  ws: WebSocket;
  /** Sends one message, encrypted (every frame after `welcome` is). */
  send(msg: Params): void;
  version: string;
  userAgent: string;
  pending: Map<number, Pending>;
  nextId: number;
  lastSeen: number;
}

interface TabState {
  tab: ExtensionTab;
  attached: boolean;
  /** Child session ids (OOPIFs, workers) learned from the tab's own Target.attachedToTarget events. */
  children: Set<string>;
}

interface Alias {
  tabId: number;
  /** The session that asked for it (a `browser-<n>` session), which is told when it goes. */
  parent: string;
}

function isObject(v: unknown): v is Params {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "Chrome/142.0.7444.59" → "142.0.7444.59". */
function chromeVersion(userAgent: string): string {
  return /(?:Chrome|Chromium)\/([\d.]+)/.exec(userAgent)?.[1] ?? "0.0.0.0";
}

/** Ends an upgrade request with a plain HTTP status. */
function refuse(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class ExtensionRelay {
  private readonly code: string;
  private readonly wantedPort: number | undefined;
  private readonly version: string;
  private readonly authTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  /** 32 random bytes, hex: the CDP path. Never written anywhere. */
  private readonly secret = randomBytes(32).toString("hex");
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private readonly sockets = new Set<WebSocket>();
  private unauthenticated = 0;
  private server: Server | undefined;
  private listeningPort = 0;
  private liveness: ReturnType<typeof setInterval> | undefined;

  private ext: Extension | undefined;
  private attempts = 0;
  private lastRefusal: Refusal | undefined;
  private waiters: (() => void)[] = [];

  private cdp: WebSocket | undefined;
  private autoAttach = false;
  private readonly tabs = new Map<number, TabState>();
  private readonly attaching = new Map<number, Promise<void>>();
  private readonly aliases = new Map<string, Alias>();
  private readonly browserSessions = new Set<string>();
  private nextSession = 0;

  constructor(options: RelayOptions) {
    this.code = options.code;
    this.wantedPort = options.port;
    this.version = options.version ?? "0.1.0";
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Listens on 127.0.0.1: the one port asked for, else the first free port of the range. */
  async start(): Promise<{ port: number }> {
    if (this.server) return { port: this.listeningPort };
    const ports = this.wantedPort !== undefined ? [this.wantedPort] : EXTENSION_PORTS;
    const busy: number[] = [];
    for (const port of ports) {
      const server = createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
      });
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head));
      const ok = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(false) : reject(e)));
        server.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (!ok) {
        busy.push(port);
        continue;
      }
      this.server = server;
      const address = server.address();
      this.listeningPort = typeof address === "object" && address ? address.port : port;
      this.liveness = setInterval(() => {
        if (this.ext && Date.now() - this.ext.lastSeen > SILENCE_MS) this.ext.ws.terminate();
      }, 20_000);
      this.liveness.unref();
      return { port: this.listeningPort };
    }
    throw new Error(`No free port for the extension relay: ${busy.join(", ")} are in use${this.wantedPort === undefined ? " (set SAP_EXTENSION_PORT to another port, and the same port in the extension's options)" : ""}.`);
  }

  get port(): number {
    return this.listeningPort;
  }

  /** The browser endpoint for Playwright's connectOverCDP. */
  get cdpUrl(): string {
    return `ws://127.0.0.1:${this.listeningPort}/cdp/${this.secret}`;
  }

  extensionInfo(): ExtensionInfo {
    const info: ExtensionInfo = { connected: !!this.ext, tabs: this.tabs.size, attempts: this.attempts, cdpClient: !!this.cdp };
    if (this.ext) {
      info.extensionVersion = this.ext.version;
      info.userAgent = this.ext.userAgent;
    }
    if (this.lastRefusal) info.lastRefusal = this.lastRefusal;
    return info;
  }

  /** True once an extension is authenticated, false after `ms` without one. */
  waitForExtension(ms: number): Promise<boolean> {
    if (this.ext) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      this.waiters.push(done);
    });
  }

  async close(): Promise<void> {
    if (this.liveness) clearInterval(this.liveness);
    for (const ws of this.sockets) ws.close(1001, "the server is stopping");
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // ─── Connections ─────────────────────────────────────────────────────

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => {});
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const origin = req.headers.origin;
    if (path === "/extension") {
      if (!origin?.startsWith("chrome-extension://")) return refuse(socket, 403);
      if (this.unauthenticated >= MAX_UNAUTHENTICATED) return refuse(socket, 503);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtensionSocket(ws));
      return;
    }
    if (path.startsWith("/cdp/") && sameSecret(path, `/cdp/${this.secret}`)) {
      if (origin !== undefined) return refuse(socket, 403);
      if (this.cdp) return refuse(socket, 409);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onCdpSocket(ws));
      return;
    }
    refuse(socket, 404);
  }

  private track(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("error", () => {});
  }

  private onExtensionSocket(ws: WebSocket): void {
    this.track(ws);
    this.attempts++;
    this.unauthenticated++;
    let counted = true;
    const uncount = () => {
      if (counted) this.unauthenticated--;
      counted = false;
    };
    const nS = randomBytes(16).toString("base64");
    let authed = false;
    let inbound: FrameCipher | undefined;
    const timer = setTimeout(() => {
      if (!authed) ws.close(4000, "no auth");
    }, this.authTimeoutMs);
    ws.send(JSON.stringify({ type: "hello", v: 1, nonce: nS, server: "sap-ui-automation", version: this.version }));
    ws.on("message", (bytes: Buffer, isBinary: boolean) => {
      if (authed) {
        // After `welcome` only encrypted binary frames: anything else is a process in the middle, or a bug.
        let text: string;
        try {
          if (!isBinary || !inbound) throw new Error("text frame");
          text = inbound.open(bytes);
        } catch {
          ws.close(4003, "frame does not decrypt");
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (isObject(msg)) this.onExtensionMessage(msg);
        return;
      }
      if (isBinary || bytes.length > PRE_AUTH_MAX_BYTES) {
        ws.close(1009, "expected auth");
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(bytes.toString("utf8"));
      } catch {
        ws.close(4000, "not JSON");
        return;
      }
      if (!isObject(msg)) return;
      clearTimeout(timer);
      const nE = msg.nonce;
      const mac = msg.mac;
      if (msg.type !== "auth" || typeof nE !== "string" || typeof mac !== "string" || !nE || nE.length > 64) {
        ws.close(4000, "expected auth");
        return;
      }
      if (!sameSecret(mac, hmac(this.code, "sap-gui-ext", nS, nE))) {
        this.lastRefusal = "code";
        ws.send(JSON.stringify({ type: "refused", reason: "code" }));
        ws.close(4001, "code");
        return;
      }
      if (this.ext) {
        this.lastRefusal = "busy";
        ws.send(JSON.stringify({ type: "refused", reason: "busy" }));
        ws.close(4002, "busy");
        return;
      }
      authed = true;
      uncount();
      this.lastRefusal = undefined;
      inbound = new FrameCipher(sessionKey(this.code, "sap-gui-key-e2s", nS, nE));
      const outbound = new FrameCipher(sessionKey(this.code, "sap-gui-key-s2e", nS, nE));
      // The last frame in clear; everything after it is sealed with the session keys.
      ws.send(JSON.stringify({ type: "welcome", mac: hmac(this.code, "sap-gui-srv", nS, nE) }));
      this.ext = {
        ws,
        send: (m) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(outbound.seal(JSON.stringify(m)), { binary: true });
        },
        version: typeof msg.extensionVersion === "string" ? msg.extensionVersion.slice(0, 40) : "",
        userAgent: typeof msg.userAgent === "string" ? msg.userAgent.slice(0, 400) : "",
        pending: new Map(),
        nextId: 0,
        lastSeen: Date.now(),
      };
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });
    ws.on("close", () => {
      clearTimeout(timer);
      uncount();
      if (this.ext?.ws === ws) this.extensionGone();
    });
  }

  private onCdpSocket(ws: WebSocket): void {
    this.track(ws);
    if (!this.ext) {
      ws.close(1011, "the sap-ui-automation extension is not connected");
      return;
    }
    this.cdp = ws;
    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (isObject(msg)) void this.onCdpCommand(msg as CdpMessage);
    });
    ws.on("close", () => {
      if (this.cdp === ws) this.cdpGone();
    });
  }

  /** The extension went away: Playwright must see a disconnect, not a browser that stopped answering. */
  private extensionGone(): void {
    const ext = this.ext;
    this.ext = undefined;
    if (ext) for (const p of ext.pending.values()) p.reject(new CdpError("The sap-ui-automation extension disconnected"));
    this.tabs.clear();
    this.aliases.clear();
    this.cdp?.close(1011, "the sap-ui-automation extension disconnected");
  }

  /** Playwright went away: detach every tab, so Chrome's "is debugging this browser" bar goes. */
  private cdpGone(): void {
    this.cdp = undefined;
    this.autoAttach = false;
    this.aliases.clear();
    this.browserSessions.clear();
    for (const [tabId, state] of this.tabs) {
      if (!state.attached) continue;
      state.attached = false;
      state.children.clear();
      this.request("detach", { tabId }).catch(() => {});
    }
  }

  // ─── Extension side ──────────────────────────────────────────────────

  /** The SAP systems the user registered in the extension: name, address, client, user; never a password. */
  async systems(): Promise<ExtensionSystem[]> {
    const r = await this.request("systems");
    return isObject(r) && Array.isArray(r.systems) ? (r.systems.filter(isObject) as unknown as ExtensionSystem[]) : [];
  }

  /**
   * Asks the extension to open a registered system and log on: it fills SAP's logon page itself, in a tab
   * withdrawn from this relay until the logon is over. The answer says who is logged on, or why not.
   */
  async logon(system: string, options: LogonOptions = {}): Promise<LogonResult> {
    return (await this.request("logon", { system, ...(options.otherLogons ? { otherLogons: options.otherLogons } : {}) }, Math.max(this.requestTimeoutMs, LOGON_TIMEOUT_MS))) as LogonResult;
  }

  /** Sends a request to the extension; resolves with its `result`. */
  private request(type: string, fields: Params = {}, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const ext = this.ext;
    if (!ext) return Promise.reject(new CdpError("The sap-ui-automation extension is not connected"));
    const id = ++ext.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (ext.pending.delete(id)) reject(new CdpError(`The sap-ui-automation extension did not answer "${type}" within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      const done = <T>(f: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        f(v);
      };
      ext.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      ext.send({ ...fields, id, type });
    });
  }

  private onExtensionMessage(msg: Params): void {
    const ext = this.ext;
    if (!ext) return;
    ext.lastSeen = Date.now();
    if (typeof msg.id === "number") {
      const p = ext.pending.get(msg.id);
      if (!p) return;
      ext.pending.delete(msg.id);
      if (isObject(msg.error)) p.reject(new CdpError(String(msg.error.message ?? "extension error"), typeof msg.error.code === "number" ? msg.error.code : -32000, typeof msg.error.reason === "string" ? msg.error.reason : undefined));
      else p.resolve(msg.result);
      return;
    }
    switch (msg.type) {
      case "ping":
        ext.send({ type: "pong" });
        return;
      case "event":
        if (typeof msg.tabId === "number" && typeof msg.method === "string") this.onTabEvent(msg.tabId, msg.method, isObject(msg.params) ? msg.params : {}, typeof msg.sessionId === "string" ? msg.sessionId : undefined);
        return;
      case "tabAdded":
        if (isObject(msg.tab) && typeof msg.tab.tabId === "number") {
          const state = this.remember(msg.tab as unknown as ExtensionTab);
          if (this.cdp && this.autoAttach) this.attachTab(state.tab.tabId).catch(() => {});
        }
        return;
      case "tabRemoved":
        if (typeof msg.tabId === "number") this.dropTab(msg.tabId, true);
        return;
      case "detached":
        if (typeof msg.tabId === "number") this.dropTab(msg.tabId, false);
        return;
    }
  }

  private remember(tab: ExtensionTab): TabState {
    const state = this.tabs.get(tab.tabId);
    if (state) {
      state.tab = tab;
      return state;
    }
    const fresh: TabState = { tab, attached: false, children: new Set() };
    this.tabs.set(tab.tabId, fresh);
    return fresh;
  }

  private onTabEvent(tabId: number, method: string, params: Params, sessionId: string | undefined): void {
    const state = this.tabs.get(tabId);
    if (!state?.attached) return;
    const child = params.sessionId;
    if (method === "Target.attachedToTarget" && typeof child === "string") state.children.add(child);
    else if (method === "Target.detachedFromTarget" && typeof child === "string") state.children.delete(child);
    if (!sessionId && method === "Page.frameNavigated" && isObject(params.frame) && !params.frame.parentId && typeof params.frame.url === "string") state.tab.url = params.frame.url;
    this.toCdp({ method, params, sessionId: sessionId ?? `tab-${tabId}` });
  }

  /** Attaches the debugger to a tab once; announces it to Playwright when root auto-attach is on. */
  private attachTab(tabId: number): Promise<void> {
    if (this.tabs.get(tabId)?.attached) return Promise.resolve();
    const running = this.attaching.get(tabId);
    if (running) return running;
    const cdp = this.cdp;
    const p = (async () => {
      const result = await this.request("attach", { tabId });
      const tab = isObject(result) && isObject(result.tab) ? (result.tab as unknown as ExtensionTab) : this.tabs.get(tabId)?.tab;
      if (!tab) throw new CdpError(`The extension did not describe tab ${tabId}`);
      if (this.cdp !== cdp || !this.cdp) {
        // Playwright left while the debugger attached: leave the tab as it was.
        this.request("detach", { tabId }).catch(() => {});
        return;
      }
      const state = this.remember(tab);
      state.attached = true;
      if (this.autoAttach) this.toCdp({ method: "Target.attachedToTarget", params: { sessionId: `tab-${tabId}`, targetInfo: this.targetInfo(state.tab), waitingForDebugger: false } });
    })().finally(() => this.attaching.delete(tabId));
    this.attaching.set(tabId, p);
    return p;
  }

  /** A tab left (closed, left the allowed origins, sharing paused) or Chrome detached it: its sessions end. */
  private dropTab(tabId: number, forget: boolean): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    if (forget) this.tabs.delete(tabId);
    const wasAttached = state.attached;
    state.attached = false;
    state.children.clear();
    for (const [alias, a] of this.aliases) {
      if (a.tabId !== tabId) continue;
      this.aliases.delete(alias);
      this.toCdp({ method: "Target.detachedFromTarget", params: { sessionId: alias, targetId: state.tab.targetId }, sessionId: a.parent });
    }
    if (wasAttached && this.autoAttach) this.toCdp({ method: "Target.detachedFromTarget", params: { sessionId: `tab-${tabId}`, targetId: state.tab.targetId } });
  }

  // ─── CDP side ────────────────────────────────────────────────────────

  private toCdp(msg: CdpMessage): void {
    if (!this.cdp || this.cdp.readyState !== WebSocket.OPEN) return;
    const out: CdpMessage = { ...msg };
    if (!out.sessionId) delete out.sessionId;
    this.cdp.send(JSON.stringify(out));
  }

  private async onCdpCommand(msg: CdpMessage): Promise<void> {
    const { id, sessionId } = msg;
    try {
      if (typeof msg.method !== "string") throw new CdpError("Message has no method", -32600);
      const result = await this.dispatch(msg.method, isObject(msg.params) ? msg.params : {}, sessionId || undefined);
      this.toCdp({ id, sessionId, result });
    } catch (e) {
      this.toCdp({ id, sessionId, error: { code: e instanceof CdpError ? e.code : -32000, message: (e as Error).message } });
    }
  }

  private dispatch(method: string, params: Params, sessionId: string | undefined): Promise<unknown> {
    if (!sessionId || this.browserSessions.has(sessionId)) return this.browserCommand(method, params, sessionId);
    const route = this.route(sessionId);
    if (!route) throw new CdpError(`No session with given id: ${sessionId}`);
    const fields: Params = { tabId: route.tabId, method };
    if (route.child) fields.sessionId = route.child;
    if (Object.keys(params).length) fields.params = params;
    return this.request("cdp", fields).then((r) => (isObject(r) && isObject(r.result) ? r.result : {}));
  }

  /** The tab, and the child session on it, a client session id stands for. */
  private route(sessionId: string): { tabId: number; child?: string } | undefined {
    const alias = this.aliases.get(sessionId);
    if (alias) return { tabId: alias.tabId };
    const root = /^tab-(\d+)$/.exec(sessionId);
    if (root) {
      const tabId = Number(root[1]);
      return this.tabs.get(tabId)?.attached ? { tabId } : undefined;
    }
    for (const [tabId, state] of this.tabs) if (state.attached && state.children.has(sessionId)) return { tabId, child: sessionId };
    return undefined;
  }

  private targetInfo(tab: ExtensionTab, attached = true): Params {
    const info: Params = { targetId: tab.targetId, type: "page", title: tab.title, url: tab.url, attached, canAccessOpener: false, browserContextId: BROWSER_CONTEXT_ID };
    const opener = tab.openerTabId !== undefined ? this.tabs.get(tab.openerTabId) : undefined;
    if (opener) info.openerId = opener.tab.targetId;
    return info;
  }

  private tabByTarget(targetId: unknown): TabState | undefined {
    for (const state of this.tabs.values()) if (state.tab.targetId === targetId) return state;
    return undefined;
  }

  /** Commands on the browser session (or a `browser-<n>` session): answered here, never sent to a tab. */
  private async browserCommand(method: string, params: Params, sessionId: string | undefined): Promise<unknown> {
    switch (method) {
      case "Browser.getVersion": {
        const userAgent = this.ext?.userAgent ?? "";
        return { protocolVersion: "1.3", product: `Chrome/${chromeVersion(userAgent)}`, revision: "", userAgent, jsVersion: "" };
      }
      // Playwright with noDefaults never asks; answered for other clients. Chrome downloads to the user's own folder.
      case "Browser.setDownloadBehavior":
        return {};
      case "Browser.close":
      case "Target.createTarget":
      case "Target.closeTarget":
      case "Target.createBrowserContext":
      case "Target.disposeBrowserContext":
        throw new CdpError(`${method} is refused: through the extension the server never opens or closes your tabs or browser`);
      case "Target.setAutoAttach": {
        // Only the root session announces tabs; a browser-<n> session asking the same would get duplicate pages.
        if (sessionId) return {};
        if (!params.autoAttach) {
          this.autoAttach = false;
          return {};
        }
        this.autoAttach = true;
        const listed = await this.request("tabs");
        const tabs = isObject(listed) && Array.isArray(listed.tabs) ? (listed.tabs as ExtensionTab[]) : [];
        for (const tab of tabs) this.remember(tab);
        for (const tab of tabs) await this.attachTab(tab.tabId).catch(() => {});
        return {};
      }
      case "Target.setDiscoverTargets":
        return {};
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.getTargets":
        return { targetInfos: [...this.tabs.values()].map((s) => this.targetInfo(s.tab, s.attached)) };
      case "Target.getTargetInfo": {
        if (params.targetId === undefined || params.targetId === BROWSER_TARGET_ID)
          return { targetInfo: { targetId: BROWSER_TARGET_ID, type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
        const state = this.tabByTarget(params.targetId);
        if (!state) throw new CdpError("No target with given id found");
        return { targetInfo: this.targetInfo(state.tab, state.attached) };
      }
      case "Target.attachToBrowserTarget": {
        const id = `browser-${++this.nextSession}`;
        this.browserSessions.add(id);
        return { sessionId: id };
      }
      case "Target.attachToTarget": {
        const state = this.tabByTarget(params.targetId);
        if (!state) throw new CdpError("No target with given id found");
        await this.attachTab(state.tab.tabId);
        const alias = `tab-${state.tab.tabId}-${++this.nextSession}`;
        this.aliases.set(alias, { tabId: state.tab.tabId, parent: sessionId ?? "" });
        return { sessionId: alias };
      }
      case "Target.detachFromTarget": {
        const target = params.sessionId;
        if (typeof target !== "string") throw new CdpError("Target.detachFromTarget needs a sessionId");
        const alias = this.aliases.get(target);
        if (alias) {
          this.aliases.delete(target);
          this.toCdp({ method: "Target.detachedFromTarget", params: { sessionId: target, targetId: this.tabs.get(alias.tabId)?.tab.targetId ?? "" }, sessionId: alias.parent });
          return {};
        }
        const root = /^tab-(\d+)$/.exec(target);
        const tabId = root ? Number(root[1]) : NaN;
        if (this.tabs.get(tabId)?.attached) {
          await this.request("detach", { tabId }).catch(() => {});
          this.dropTab(tabId, false);
          return {};
        }
        throw new CdpError(`No session with given id: ${target}`);
      }
      case "Target.activateTarget": {
        const state = this.tabByTarget(params.targetId);
        if (!state?.attached) throw new CdpError("No target with given id found");
        await this.request("cdp", { tabId: state.tab.tabId, method: "Page.bringToFront" });
        return {};
      }
    }
    throw new CdpError(`${method} is not available through the extension`);
  }
}
