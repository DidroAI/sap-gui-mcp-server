import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { chromium } from "playwright-core";
import { extensionDoctor, extensionEndpoint, extensionPairCommand, extensionRelay, stopExtensionRelay } from "../src/browser/extension/index.js";
import { CODE_LENGTH, FrameCipher, formatCode, generateCode, hmac, normalizeCode, pairingFile, readOrCreateCode, sameSecret, sessionKey } from "../src/browser/extension/pairing.js";
import { ExtensionRelay, type ExtensionTab } from "../src/browser/extension/relay.js";
import { WebSocket } from "../src/browser/extension/ws.js";
import { SERVER_VERSION } from "../src/server.js";

const CODE = "ABCDE-FGHJK-MNPQR-STVWX-YZ012-3";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36";
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

type Msg = Record<string, any>;

/** A WebSocket client that queues what it receives. */
class Client {
  private queue: Msg[] = [];
  private wake: (() => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  /** Set once paired: frames are then sealed and opened, as the extension does after `welcome`. */
  private inbound: FrameCipher | undefined;
  private outbound: FrameCipher | undefined;
  /** Encrypted frames that came before the keys were set (the relay may send right after `welcome`). */
  private backlog: Buffer[] = [];
  /** Called with every message, after the queue has it. */
  readonly listeners: ((m: Msg) => void)[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary && !this.inbound) this.backlog.push(data);
      else this.deliver(JSON.parse(isBinary && this.inbound ? this.inbound.open(data) : data.toString()));
    });
    this.closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }
  static connect(url: string, origin?: string): Promise<Client> {
    const ws = new WebSocket(url, origin ? { origin } : {});
    return new Promise((resolve, reject) => {
      const client = new Client(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
    });
  }
  private deliver(m: Msg): void {
    this.queue.push(m);
    for (const w of this.wake.splice(0)) w();
    for (const l of this.listeners) l(m);
  }
  paired(inbound: FrameCipher, outbound: FrameCipher): void {
    this.inbound = inbound;
    this.outbound = outbound;
    for (const frame of this.backlog.splice(0)) this.deliver(JSON.parse(inbound.open(frame)));
  }
  send(msg: Msg): void {
    if (this.outbound) this.ws.send(this.outbound.seal(JSON.stringify(msg)), { binary: true });
    else this.ws.send(JSON.stringify(msg));
  }
  /** The first queued message that matches, removed from the queue. */
  async next(pred: (m: Msg) => boolean = () => true, ms = 3000): Promise<Msg> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.queue.findIndex(pred);
      if (i >= 0) return this.queue.splice(i, 1)[0] as Msg;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching message; queued: ${JSON.stringify(this.queue)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.wake.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
  /** Drops queued messages that match. */
  drop(pred: (m: Msg) => boolean): void {
    this.queue = this.queue.filter((m) => !pred(m));
  }
  close(): void {
    this.ws.close();
  }
}

/** A CDP client, as Playwright would be. */
class Cdp {
  private id = 0;
  constructor(readonly client: Client) {}
  static async connect(url: string): Promise<Cdp> {
    return new Cdp(await Client.connect(url));
  }
  async call(method: string, params: Msg = {}, sessionId?: string): Promise<Msg> {
    const id = ++this.id;
    this.client.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return this.client.next((m) => m.id === id);
  }
  event(method: string, ms?: number): Promise<Msg> {
    return this.client.next((m) => m.method === method && m.id === undefined, ms);
  }
}

type CdpHandler = (req: Msg) => Msg | Promise<Msg>;

/** A fake extension: does the handshake, then answers the relay's requests. */
class FakeExtension {
  readonly requests: Msg[] = [];
  tabs: ExtensionTab[];
  onCdp: CdpHandler = () => ({});
  private constructor(
    readonly client: Client,
    tabs: ExtensionTab[],
  ) {
    this.tabs = tabs;
    client.listeners.push((m) => void this.answer(m));
  }
  static async connect(relay: ExtensionRelay, tabs: ExtensionTab[] = [], code = CODE): Promise<FakeExtension> {
    const client = await Client.connect(`ws://127.0.0.1:${relay.port}/extension`, EXT_ORIGIN);
    const hello = await client.next((m) => m.type === "hello");
    const nE = Buffer.from("extension-nonce!").toString("base64");
    client.send({ type: "auth", nonce: nE, mac: hmac(code, "sap-gui-ext", hello.nonce, nE), extensionVersion: "0.1.0", userAgent: UA });
    const answer = await client.next((m) => m.type === "welcome" || m.type === "refused");
    if (answer.type !== "welcome") throw Object.assign(new Error(`refused: ${answer.reason}`), { answer, client });
    if (answer.mac !== hmac(code, "sap-gui-srv", hello.nonce, nE)) throw new Error("server mac is wrong");
    const ext = new FakeExtension(client, tabs);
    client.paired(new FrameCipher(sessionKey(code, "sap-gui-key-s2e", hello.nonce, nE)), new FrameCipher(sessionKey(code, "sap-gui-key-e2s", hello.nonce, nE)));
    return ext;
  }
  private async answer(req: Msg): Promise<void> {
    if (typeof req.id !== "number") return;
    this.requests.push(req);
    try {
      let result: Msg;
      if (req.type === "tabs") result = { tabs: this.tabs };
      else if (req.type === "attach") {
        const tab = this.tabs.find((t) => t.tabId === req.tabId);
        if (!tab) throw new Error("tab not allowed");
        result = { tab };
      } else if (req.type === "detach") result = {};
      else if (req.type === "cdp") result = { result: await this.onCdp(req) };
      else throw new Error(`unknown ${req.type}`);
      this.client.send({ id: req.id, result });
    } catch (e) {
      this.client.send({ id: req.id, error: { message: (e as Error).message, code: (e as { code?: number }).code ?? -32000 } });
    }
  }
  send(msg: Msg): void {
    this.client.send(msg);
  }
  of(type: string): Msg[] {
    return this.requests.filter((r) => r.type === type);
  }
}

const TAB5: ExtensionTab = { tabId: 5, targetId: "T5", url: "https://sap.example/ui", title: "SAP Easy Access" };
const TAB7: ExtensionTab = { tabId: 7, targetId: "T7", url: "https://sap.example/fiori", title: "Home", openerTabId: 5 };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function startRelay(options: { authTimeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<ExtensionRelay> {
  const relay = new ExtensionRelay({ code: CODE, port: 0, ...options });
  await relay.start();
  cleanup.push(() => relay.close());
  return relay;
}

/** A relay, a paired extension with tabs 5 and 7, and a CDP client with root auto-attach on. */
async function attachedSetup(options: { requestTimeoutMs?: number } = {}): Promise<{ relay: ExtensionRelay; ext: FakeExtension; cdp: Cdp }> {
  const relay = await startRelay(options);
  const ext = await FakeExtension.connect(relay, [TAB5, TAB7]);
  const cdp = await Cdp.connect(relay.cdpUrl);
  await cdp.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await cdp.event("Target.attachedToTarget");
  await cdp.event("Target.attachedToTarget");
  return { relay, ext, cdp };
}

function refusedStatus(url: string, origin?: string): Promise<string> {
  return Client.connect(url, origin).then(
    (c) => {
      c.close();
      return "connected";
    },
    (e: Error) => e.message,
  );
}

describe("pairing code", () => {
  test("26 Crockford characters, grouped by five", () => {
    const code = generateCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(code.length).toBe(CODE_LENGTH);
    expect(generateCode()).not.toBe(code);
    expect(formatCode("ABCDEFGHJKMNPQRSTVWXYZ0123")).toBe("ABCDE-FGHJK-MNPQR-STVWX-YZ012-3");
  });
  test("normalized: uppercase, look-alikes mapped, the rest dropped", () => {
    expect(normalizeCode(" abcde-fghjk mnpqr_stvwx yz012 3\n")).toBe("ABCDEFGHJKMNPQRSTVWXYZ0123");
    expect(normalizeCode("iIlLoO")).toBe("111100");
  });
  test("HMAC-SHA256, keyed with the normalized code, over label|nS|nE", () => {
    const a = hmac(CODE, "sap-gui-ext", "bS", "bE");
    expect(Buffer.from(a, "base64").length).toBe(32);
    expect(hmac("abcde fghjk mnpqr stvwx yz012 3", "sap-gui-ext", "bS", "bE")).toBe(a);
    expect(hmac(CODE, "sap-gui-srv", "bS", "bE")).not.toBe(a);
    expect(hmac(CODE, "sap-gui-ext", "bE", "bS")).not.toBe(a);
    expect(sameSecret(a, a)).toBe(true);
    expect(sameSecret(a, hmac(CODE, "sap-gui-srv", "bS", "bE"))).toBe(false);
    expect(sameSecret(a, "short")).toBe(false);
  });
  test("file path per OS", () => {
    expect(pairingFile("linux", {}, "/home/u")).toBe("/home/u/.config/sap-ui-automation/extension-pairing");
    expect(pairingFile("linux", { XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/x/sap-ui-automation/extension-pairing");
    expect(pairingFile("darwin", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/sap-ui-automation/extension-pairing");
    expect(pairingFile("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\sap-ui-automation\\extension-pairing");
  });
  test("made once with mode 0600, then read back; SAP_EXTENSION_CODE wins", async () => {
    const home = await mkdtemp(join(tmpdir(), "sap-gui-pair-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const env = { XDG_CONFIG_HOME: join(home, "cfg") };
    const first = readOrCreateCode(env, "linux", home);
    // "linux" paths are joined with "/", whatever this machine is.
    expect(first.file).toBe(posix.join(join(home, "cfg"), "sap-ui-automation", "extension-pairing"));
    expect(first.code.length).toBe(26);
    // Windows has no POSIX modes.
    if (process.platform !== "win32") expect((await stat(first.file as string)).mode & 0o777).toBe(0o600);
    expect((await readFile(first.file as string, "utf8")).trim()).toBe(formatCode(first.code));
    expect(readOrCreateCode(env, "linux", home)).toEqual(first);
    expect(readOrCreateCode({ ...env, SAP_EXTENSION_CODE: CODE.toLowerCase() }, "linux", home)).toEqual({ code: normalizeCode(CODE), file: undefined });
    // A short code could be brute-forced offline from the MACs a fake relay collects.
    expect(() => readOrCreateCode({ ...env, SAP_EXTENSION_CODE: "abcde-fghjk" }, "linux", home)).toThrow("26 letters and digits");
    const lines = extensionPairCommand({ SAP_EXTENSION_CODE: CODE });
    expect(lines.join("\n")).toContain("ABCDE-FGHJK-MNPQR-STVWX-YZ012-3");
  });
  test.skipIf(process.platform === "win32")("a pairing file open to others is set back to 0600 when it is read", async () => {
    const home = await mkdtemp(join(tmpdir(), "sap-gui-pair-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const env = { XDG_CONFIG_HOME: join(home, "cfg") };
    const file = pairingFile("linux", env, home);
    await mkdir(dirname(file), { recursive: true });
    // Copied in, or made by hand: readable by everyone.
    await writeFile(file, `${CODE}\n`, { mode: 0o644 });
    await chmod(file, 0o644);
    expect(readOrCreateCode(env, "linux", home)).toEqual({ code: normalizeCode(CODE), file });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // A file whose content is no code is written anew, and also ends at 0600.
    await writeFile(file, "not a code\n");
    await chmod(file, 0o666);
    const made = readOrCreateCode(env, "linux", home);
    expect(made.code).not.toBe(normalizeCode(CODE));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("waiting for the extension (index.ts)", () => {
  test("a wrong code ends doctor's wait at once, not the server's; the right one gives the CDP endpoint", async () => {
    const free = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => free.once("listening", r));
    const port = (free.address() as { port: number }).port;
    await new Promise((r) => free.close(r));
    const env = { SAP_EXTENSION_CODE: CODE, SAP_EXTENSION_PORT: String(port) };
    try {
      const relay = await extensionRelay(env);
      // The relay's hello names this server's version, not a fixed one.
      const raw = await Client.connect(`ws://127.0.0.1:${port}/extension`, EXT_ORIGIN);
      expect((await raw.next((m) => m.type === "hello")).version).toBe(SERVER_VERSION);
      raw.ws.close();
      const t0 = Date.now();
      const doctor = extensionDoctor(env, 20_000);
      // Any local program can send a bad auth: the server's own wait goes on.
      const server = extensionEndpoint(env, 20_000);
      const refused = await FakeExtension.connect(relay, [], "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-Z").catch((e) => e.answer);
      expect(refused.reason).toBe("code");
      expect((await doctor)[0]?.detail).toContain("another pairing code");
      expect(Date.now() - t0).toBeLessThan(3000);
      const ext = await FakeExtension.connect(relay);
      const endpoint = await server;
      expect(endpoint.url).toBe(relay.cdpUrl);
      expect(endpoint.from).toContain(`port ${port}`);
      expect(endpoint.kind).toBe("extension");
      ext.client.close();
    } finally {
      await stopExtensionRelay();
    }
  });
});

describe("encrypted channel", () => {
  test("frames open only in order, with the right key", () => {
    const key = sessionKey(CODE, "sap-gui-key-s2e", "nS", "nE");
    const a = new FrameCipher(key);
    const b = new FrameCipher(key);
    const f1 = a.seal('{"n":1}');
    const f2 = a.seal('{"n":2}');
    expect(f1.toString("utf8")).not.toContain("n");
    expect(() => new FrameCipher(key).open(f2)).toThrow(); // out of order
    expect(b.open(f1)).toBe('{"n":1}');
    expect(b.open(f2)).toBe('{"n":2}');
    expect(() => new FrameCipher(sessionKey(CODE, "sap-gui-key-e2s", "nS", "nE")).open(a.seal("x"))).toThrow(); // other direction's key
    expect(sessionKey(CODE, "sap-gui-key-s2e", "nS", "nE").equals(sessionKey(CODE, "sap-gui-key-s2e", "nS", "nE2"))).toBe(false);
  });
  test("after welcome the relay sends only sealed binary frames", async () => {
    const relay = await startRelay();
    const ext = await FakeExtension.connect(relay);
    const raw: { binary: boolean }[] = [];
    ext.client.ws.on("message", (_d, isBinary) => raw.push({ binary: isBinary }));
    ext.send({ type: "ping" });
    await ext.client.next((m) => m.type === "pong");
    expect(raw).toEqual([{ binary: true }]);
  });
  test("a text frame after welcome closes the socket (4003)", async () => {
    const relay = await startRelay();
    const ext = await FakeExtension.connect(relay);
    ext.client.ws.send(JSON.stringify({ type: "ping" }));
    expect((await ext.client.closed).code).toBe(4003);
    expect(relay.extensionInfo().connected).toBe(false);
  });
  test("a tampered frame closes the socket (4003)", async () => {
    const relay = await startRelay();
    const ext = await FakeExtension.connect(relay);
    const forged = new FrameCipher(sessionKey(CODE, "sap-gui-key-e2s", "other", "nonces")).seal(JSON.stringify({ type: "ping" }));
    ext.client.ws.send(forged, { binary: true });
    expect((await ext.client.closed).code).toBe(4003);
  });
  test("a process in the middle that passes the handshake through cannot inject frames", async () => {
    // The middle sees hello, auth and welcome, but not the code: it cannot derive the session keys.
    const relay = await startRelay();
    const middle = await Client.connect(`ws://127.0.0.1:${relay.port}/extension`, EXT_ORIGIN);
    const hello = await middle.next((m) => m.type === "hello");
    const nE = Buffer.from("extension-nonce!").toString("base64");
    middle.send({ type: "auth", nonce: nE, mac: hmac(CODE, "sap-gui-ext", hello.nonce, nE) }); // the real extension's auth, passed through
    expect((await middle.next((m) => m.type === "welcome")).type).toBe("welcome");
    middle.ws.send(new FrameCipher(sessionKey("WRONG-WRONG-WRONG-WRONG-WRONG-W", "sap-gui-key-e2s", hello.nonce, nE)).seal(JSON.stringify({ id: 1, result: {} })), { binary: true });
    expect((await middle.closed).code).toBe(4003);
  });
});

describe("handshake", () => {
  test("an oversized frame before auth closes the socket (1009)", async () => {
    const relay = await startRelay();
    const c = await Client.connect(`ws://127.0.0.1:${relay.port}/extension`, EXT_ORIGIN);
    await c.next((m) => m.type === "hello");
    c.ws.send("x".repeat(5000));
    expect((await c.closed).code).toBe(1009);
  });
  test("a frame header past the pre-auth limit closes the socket before its body comes (review, 2026-11-24)", async () => {
    const relay = await startRelay();
    const sock = connect(relay.port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const got: Buffer[] = [];
    sock.on("data", (d: Buffer) => got.push(d));
    const ended = new Promise<void>((r) => sock.once("close", () => r()));
    sock.write(
      `GET /extension HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${EXT_ORIGIN}\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 100));
    // A masked text frame that says 10 MB follow; only its header is sent.
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(10 * 1024 * 1024, 6);
    sock.write(header);
    await Promise.race([ended, new Promise((_, no) => setTimeout(() => no(new Error("socket still open")), 2000))]);
    // The close frame carries 1009.
    const all = Buffer.concat(got);
    const close = all.indexOf(Buffer.from([0x88]), all.indexOf("\r\n\r\n") + 4);
    expect(close).toBeGreaterThan(0);
    expect(all.readUInt16BE(close + 2)).toBe(1009);
  });
  test("a paired extension may send frames past the pre-auth limit", async () => {
    const relay = await startRelay();
    const ext = await FakeExtension.connect(relay);
    ext.send({ type: "ping", pad: "x".repeat(200_000) });
    expect(await ext.client.next((m) => m.type === "pong")).toEqual({ type: "pong" });
  });
  test("a path the URL parser refuses is a 400, and the relay keeps running (review, 2026-11-24)", async () => {
    const relay = await startRelay();
    const answer = await new Promise<string>((resolve) => {
      const sock = connect(relay.port, "127.0.0.1", () =>
        sock.write(`GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`),
      );
      let text = "";
      sock.on("data", (d: Buffer) => (text += d.toString()));
      sock.on("close", () => resolve(text));
    });
    expect(answer).toStartWith("HTTP/1.1 400");
    const ext = await FakeExtension.connect(relay);
    ext.send({ type: "ping" });
    expect(await ext.client.next((m) => m.type === "pong")).toEqual({ type: "pong" });
  });
  test("at most 4 sockets wait for their auth at once", async () => {
    const relay = await startRelay();
    const open = await Promise.all([1, 2, 3, 4].map(() => Client.connect(`ws://127.0.0.1:${relay.port}/extension`, EXT_ORIGIN)));
    expect(await refusedStatus(`ws://127.0.0.1:${relay.port}/extension`, EXT_ORIGIN)).toContain("503");
    open[0]?.close();
    await open[0]?.closed;
    await new Promise((r) => setTimeout(r, 50));
    const fifth = await Client.connect(`ws://127.0.0.1:${relay.port}/extension`, EXT_ORIGIN);
    expect((await fifth.next()).type).toBe("hello");
    for (const c of [...open.slice(1), fifth]) c.close();
  });
  test("a paired extension is welcomed with the server's own mac, and pings are answered", async () => {
    const relay = await startRelay();
    expect(relay.extensionInfo()).toMatchObject({ connected: false, attempts: 0 });
    const waiting = relay.waitForExtension(3000);
    const ext = await FakeExtension.connect(relay);
    expect(await waiting).toBe(true);
    expect(relay.extensionInfo()).toMatchObject({ connected: true, extensionVersion: "0.1.0", userAgent: UA, attempts: 1 });
    ext.send({ type: "ping" });
    expect(await ext.client.next((m) => m.type === "pong")).toEqual({ type: "pong" });
  });
  test("a wrong code is refused (4001) and recorded", async () => {
    const relay = await startRelay();
    const err = await FakeExtension.connect(relay, [], "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-Z").catch((e) => e);
    expect(err.answer).toEqual({ type: "refused", reason: "code" });
    expect((await err.client.closed).code).toBe(4001);
    expect(relay.extensionInfo()).toMatchObject({ connected: false, lastRefusal: "code", attempts: 1 });
    expect(await relay.waitForExtension(50)).toBe(false);
  });
  test("no Origin, or a web page's Origin, is refused before any handshake", async () => {
    const relay = await startRelay();
    expect(await refusedStatus(`ws://127.0.0.1:${relay.port}/extension`)).toContain("403");
    expect(await refusedStatus(`ws://127.0.0.1:${relay.port}/extension`, "http://evil")).toContain("403");
    expect(relay.extensionInfo().attempts).toBe(0);
  });
  test("a second paired extension is refused as busy (4002)", async () => {
    const relay = await startRelay();
    await FakeExtension.connect(relay);
    const err = await FakeExtension.connect(relay).catch((e) => e);
    expect(err.answer).toEqual({ type: "refused", reason: "busy" });
    expect((await err.client.closed).code).toBe(4002);
    expect(relay.extensionInfo()).toMatchObject({ connected: true, lastRefusal: "busy" });
  });
  test("no auth within the timeout closes with 4000", async () => {
    const relay = await startRelay({ authTimeoutMs: 100 });
    const c = await Client.connect(`ws://127.0.0.1:${relay.port}/extension`, EXT_ORIGIN);
    expect((await c.next()).type).toBe("hello");
    expect((await c.closed).code).toBe(4000);
  });
  test("the CDP endpoint: wrong secret 404, Origin 403, other paths 404, plain HTTP 404", async () => {
    const relay = await startRelay();
    await FakeExtension.connect(relay);
    expect(await refusedStatus(`ws://127.0.0.1:${relay.port}/cdp/${"0".repeat(64)}`)).toContain("404");
    expect(await refusedStatus(relay.cdpUrl, "http://evil")).toContain("403");
    expect(await refusedStatus(relay.cdpUrl, EXT_ORIGIN)).toContain("403");
    expect(await refusedStatus(`ws://127.0.0.1:${relay.port}/json/version`)).toContain("404");
    expect((await fetch(`http://127.0.0.1:${relay.port}/json/version`)).status).toBe(404);
    expect(relay.cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\/[0-9a-f]{64}$/);
  });
  test("one CDP client at a time", async () => {
    const relay = await startRelay();
    await FakeExtension.connect(relay);
    await Cdp.connect(relay.cdpUrl);
    expect(await refusedStatus(relay.cdpUrl)).toContain("409");
  });
});

describe("CDP emulation", () => {
  test("Browser.getVersion names the extension's Chrome", async () => {
    const relay = await startRelay();
    await FakeExtension.connect(relay);
    const cdp = await Cdp.connect(relay.cdpUrl);
    const r = await cdp.call("Browser.getVersion");
    expect(r.result).toEqual({ protocolVersion: "1.3", product: "Chrome/142.0.7444.59", revision: "", userAgent: UA, jsVersion: "" });
  });
  test("root auto-attach attaches every tab and announces it before answering", async () => {
    const relay = await startRelay();
    const ext = await FakeExtension.connect(relay, [TAB5, TAB7]);
    const cdp = await Cdp.connect(relay.cdpUrl);
    cdp.client.send({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
    const first = await cdp.client.next();
    const second = await cdp.client.next();
    const answer = await cdp.client.next();
    expect(first).toEqual({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "tab-5",
        targetInfo: { targetId: "T5", type: "page", title: "SAP Easy Access", url: "https://sap.example/ui", attached: true, canAccessOpener: false, browserContextId: "sap-extension" },
        waitingForDebugger: false,
      },
    });
    expect(second.params.sessionId).toBe("tab-7");
    expect(second.params.targetInfo.openerId).toBe("T5");
    expect(answer).toEqual({ id: 1, result: {} });
    expect(ext.of("attach").map((r) => r.tabId)).toEqual([5, 7]);
  });
  test("browser-level questions are answered locally", async () => {
    const { cdp, ext } = await attachedSetup();
    expect((await cdp.call("Target.getBrowserContexts")).result).toEqual({ browserContextIds: [] });
    expect((await cdp.call("Target.setDiscoverTargets", { discover: true })).result).toEqual({});
    expect((await cdp.call("Target.getTargetInfo")).result.targetInfo.type).toBe("browser");
    expect((await cdp.call("Target.getTargetInfo", { targetId: "T7" })).result.targetInfo.url).toBe(TAB7.url);
    expect((await cdp.call("Target.getTargets")).result.targetInfos.map((t: Msg) => t.targetId)).toEqual(["T5", "T7"]);
    expect((await cdp.call("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/tmp/x", eventsEnabled: true })).result).toEqual({});
    expect((await cdp.call("Browser.getWindowForTarget")).error.message).toContain("not available through the extension");
    expect(ext.of("cdp")).toEqual([]);
  });
  test("a command on tab-5 goes to tab 5; the answer keeps id and sessionId", async () => {
    const { cdp, ext } = await attachedSetup();
    ext.onCdp = (req) => ({ echo: req.method, value: req.params?.expression });
    const r = await cdp.call("Runtime.evaluate", { expression: "1+1" }, "tab-5");
    expect(r).toEqual({ id: r.id, sessionId: "tab-5", result: { echo: "Runtime.evaluate", value: "1+1" } });
    const sent = ext.of("cdp")[0] as Msg;
    expect(sent).toMatchObject({ type: "cdp", tabId: 5, method: "Runtime.evaluate", params: { expression: "1+1" } });
    expect(sent.sessionId).toBeUndefined();
  });
  test("CDP errors from the tab come back as errors", async () => {
    const { cdp, ext } = await attachedSetup();
    ext.onCdp = () => {
      throw Object.assign(new Error("Cannot find context with specified id"), { code: -32602 });
    };
    const r = await cdp.call("Runtime.evaluate", { expression: "x", contextId: 99 }, "tab-7");
    expect(r.error).toEqual({ code: -32602, message: "Cannot find context with specified id" });
    expect(r.sessionId).toBe("tab-7");
  });
  test("a command the extension never answers fails after the timeout instead of hanging", async () => {
    const { cdp, ext } = await attachedSetup({ requestTimeoutMs: 200 });
    ext.onCdp = () => new Promise(() => {});
    const r = await cdp.call("Runtime.evaluate", { expression: "1" }, "tab-5");
    expect(r.error.message).toContain("did not answer");
  });
  test("a tab's events come out under its session; child sessions are learned and routed", async () => {
    const { cdp, ext } = await attachedSetup();
    ext.send({ type: "event", tabId: 5, method: "Page.loadEventFired", params: { timestamp: 1 } });
    expect(await cdp.event("Page.loadEventFired")).toEqual({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "tab-5" });
    ext.send({ type: "event", tabId: 5, method: "Target.attachedToTarget", params: { sessionId: "CHILD1", targetInfo: { targetId: "F1", type: "iframe" }, waitingForDebugger: true } });
    expect((await cdp.event("Target.attachedToTarget")).sessionId).toBe("tab-5");
    ext.onCdp = () => ({ ok: true });
    const r = await cdp.call("Runtime.runIfWaitingForDebugger", {}, "CHILD1");
    expect(r).toMatchObject({ sessionId: "CHILD1", result: { ok: true } });
    expect(ext.of("cdp").at(-1)).toMatchObject({ tabId: 5, sessionId: "CHILD1", method: "Runtime.runIfWaitingForDebugger" });
    ext.send({ type: "event", tabId: 5, sessionId: "CHILD1", method: "Runtime.executionContextCreated", params: { context: { id: 3 } } });
    expect((await cdp.event("Runtime.executionContextCreated")).sessionId).toBe("CHILD1");
    ext.send({ type: "event", tabId: 5, method: "Target.detachedFromTarget", params: { sessionId: "CHILD1" } });
    await cdp.event("Target.detachedFromTarget");
    expect((await cdp.call("Runtime.enable", {}, "CHILD1")).error.message).toContain("No session");
  });
  test("newCDPSession: a browser session, an alias on the tab, and its detach", async () => {
    const { cdp, ext } = await attachedSetup();
    const browserSession = (await cdp.call("Target.attachToBrowserTarget")).result.sessionId;
    expect(browserSession).toMatch(/^browser-\d+$/);
    expect((await cdp.call("Browser.getVersion", {}, browserSession)).result.product).toBe("Chrome/142.0.7444.59");
    const alias = (await cdp.call("Target.attachToTarget", { targetId: "T5", flatten: true }, browserSession)).result.sessionId;
    expect(alias).toMatch(/^tab-5-\d+$/);
    ext.onCdp = () => ({ targetInfo: { targetId: "T5" } });
    expect((await cdp.call("Target.getTargetInfo", {}, alias)).result).toEqual({ targetInfo: { targetId: "T5" } });
    expect(ext.of("cdp").at(-1)).toMatchObject({ tabId: 5, method: "Target.getTargetInfo" });
    expect(ext.of("cdp").at(-1)?.sessionId).toBeUndefined();
    expect((await cdp.call("Target.detachFromTarget", { sessionId: alias }, browserSession)).result).toEqual({});
    expect(await cdp.event("Target.detachedFromTarget")).toEqual({ method: "Target.detachedFromTarget", params: { sessionId: alias, targetId: "T5" }, sessionId: browserSession });
    expect((await cdp.call("Runtime.enable", {}, alias)).error.message).toContain("No session");
    expect(ext.of("detach")).toEqual([]);
  });
  test("tabAdded attaches and announces; tabRemoved and detached end the session", async () => {
    const { cdp, ext } = await attachedSetup();
    const tab9: ExtensionTab = { tabId: 9, targetId: "T9", url: "https://sap.example/new", title: "New" };
    ext.tabs.push(tab9);
    ext.send({ type: "tabAdded", tab: tab9 });
    const added = await cdp.event("Target.attachedToTarget");
    expect(added.params).toMatchObject({ sessionId: "tab-9", targetInfo: { targetId: "T9", url: tab9.url } });
    ext.send({ type: "tabRemoved", tabId: 9, reason: "left_origin" });
    expect((await cdp.event("Target.detachedFromTarget")).params).toEqual({ sessionId: "tab-9", targetId: "T9" });
    ext.send({ type: "detached", tabId: 7, reason: "target_closed" });
    expect((await cdp.event("Target.detachedFromTarget")).params).toEqual({ sessionId: "tab-7", targetId: "T7" });
    expect((await cdp.call("Page.enable", {}, "tab-7")).error.message).toContain("No session");
  });
  test("tabs, windows and contexts are never created or closed", async () => {
    const { cdp } = await attachedSetup();
    for (const method of ["Target.createTarget", "Target.closeTarget", "Target.createBrowserContext", "Browser.close"])
      expect((await cdp.call(method, { url: "about:blank", targetId: "T5" })).error.message).toContain("never opens or closes");
  });
  test("the extension leaving closes the CDP client", async () => {
    const { cdp, ext, relay } = await attachedSetup();
    ext.client.close();
    expect((await cdp.client.closed).code).toBe(1011);
    expect(relay.extensionInfo().connected).toBe(false);
  });
  test("the CDP client leaving detaches every tab", async () => {
    const { cdp, ext, relay } = await attachedSetup();
    cdp.client.close();
    await cdp.client.closed;
    const deadline = Date.now() + 2000;
    while (ext.of("detach").length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(ext.of("detach").map((r) => r.tabId).sort()).toEqual([5, 7]);
    expect(relay.extensionInfo().cdpClient).toBe(false);
    // A new client can come.
    const again = await Cdp.connect(relay.cdpUrl);
    expect((await again.call("Browser.getVersion")).result.product).toContain("Chrome/");
  });
  test("a CDP client without an extension is closed", async () => {
    const relay = await startRelay();
    const c = await Client.connect(relay.cdpUrl);
    expect((await c.closed).code).toBe(1011);
  });
});

/**
 * Playwright end to end through the relay. The fake extension stands on a real
 * Chromium as chrome.debugger would: one flat CDP session on the page, child
 * sessions passed through. Runs when SAP_TEST_CHROME names a Chromium binary.
 */
describe.skipIf(!process.env.SAP_TEST_CHROME)("Playwright through the relay", () => {
  test("connectOverCDP gets the page; evaluate, title, click, newCDPSession and keys work", async () => {
    const html = `<!doctype html><title>Relay test</title><button id="b" onclick="this.textContent='clicked'">press</button><input id="i" onkeydown="if(event.key==='Enter')this.value='entered'">`;
    const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html)).listen(0, "127.0.0.1");
    await new Promise((r) => site.once("listening", r));
    cleanup.push(() => new Promise<void>((r) => site.close(() => r())));
    const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

    const dataDir = await mkdtemp(join(tmpdir(), "sap-gui-relay-chrome-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const backing = await chromium.launchPersistentContext(dataDir, { executablePath: process.env.SAP_TEST_CHROME ?? "", headless: true, args: ["--remote-debugging-port=0"] });
    cleanup.push(() => backing.close());
    const realPage = backing.pages()[0] ?? (await backing.newPage());
    await realPage.goto(url);
    const [port, path] = (await readFile(join(dataDir, "DevToolsActivePort"), "utf8")).trim().split("\n");

    // The "chrome.debugger" of the fake extension: a raw flat session on the page.
    const raw = await Client.connect(`ws://127.0.0.1:${port}${path}`);
    cleanup.push(() => raw.close());
    let rawId = 0;
    const rawCall = async (method: string, params: Msg = {}, sessionId?: string): Promise<Msg> => {
      const id = ++rawId;
      raw.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      return raw.next((m) => m.id === id, 10_000);
    };
    const { targetInfos } = (await rawCall("Target.getTargets")).result;
    const target = targetInfos.find((t: Msg) => t.type === "page" && t.url === url);
    const tabSession: string = (await rawCall("Target.attachToTarget", { targetId: target.targetId, flatten: true })).result.sessionId;
    const tab: ExtensionTab = { tabId: 1, targetId: target.targetId, url, title: "Relay test" };

    const relay = await startRelay();
    const ext = await FakeExtension.connect(relay, [tab]);
    const children = new Set<string>();
    raw.ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.id !== undefined || !m.method) return;
      if (m.sessionId !== tabSession && !children.has(m.sessionId)) return;
      if (m.method === "Target.attachedToTarget") children.add(m.params.sessionId);
      if (m.method === "Target.detachedFromTarget") children.delete(m.params.sessionId);
      ext.send({ type: "event", tabId: 1, method: m.method, params: m.params, ...(m.sessionId !== tabSession ? { sessionId: m.sessionId } : {}) });
    });
    ext.onCdp = async (req) => {
      const r = await rawCall(req.method, req.params ?? {}, req.sessionId ?? tabSession);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    };
    // Keep the raw queue from growing: events are relayed by the listener above.
    const drain = setInterval(() => raw.drop((m) => m.id === undefined), 50);
    cleanup.push(() => clearInterval(drain));

    const browser = await chromium.connectOverCDP(relay.cdpUrl, { noDefaults: true, isLocal: true, timeout: 20_000 });
    try {
      expect(browser.version()).toMatch(/^\d+\./);
      const pages = browser.contexts().flatMap((c) => c.pages());
      expect(pages.map((p) => p.url())).toEqual([url]);
      const page = pages[0]!;
      expect(await page.title()).toBe("Relay test");
      expect(await page.evaluate(() => 6 * 7)).toBe(42);
      await page.click("#b");
      expect(await page.textContent("#b")).toBe("clicked");
      const session = await page.context().newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      expect(targetInfo.targetId).toBe(target.targetId);
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await session.detach();
      await page.focus("#i");
      await page.keyboard.press("Enter");
      expect(await page.inputValue("#i")).toBe("entered");
      expect(await realPage.inputValue("#i")).toBe("entered");
    } finally {
      await browser.close();
    }
    const deadline = Date.now() + 3000;
    while (!ext.of("detach").length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(ext.of("detach").map((r) => r.tabId)).toEqual([1]);
  }, 60_000);
});
