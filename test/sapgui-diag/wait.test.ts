/**
 * The waits of the DIAG method, end to end without SAP: the server's own
 * router, a fake application server that answers with synthetic screens
 * (in several messages, with pauses), a fake SAP GUI that sends a request
 * when the fake input host "presses" something, and the driver in between.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { Transport } from "../../src/sapgui/facts.js";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_WARNING, Capture, diagPort, sapguiDiagSurface } from "../../src/sapgui-diag/index.js";
import { buildRoute, niFrame } from "../../src/sapgui-diag/router.js";
import { Traffic } from "../../src/sapgui-diag/traffic.js";
import { END, idItem, message, rfcCall, rfcItem, screenHead, windowStart } from "../diag/build.js";

const open: (Server | Socket | { close(): void })[] = [];
afterEach(() => {
  for (const s of open.splice(0)) "destroy" in s ? s.destroy() : s.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A screen as SAP sends it: `info` 2 for a part with more to come, 1 for the last. */
const screenMsg = (title: string, info = 1, mode = 0) => message([...screenHead({ title }), END], { info, mode });
/** A request of SAP GUI (Enter): the session item and the ST_USER items it sends with every request. */
const request = (mode = 0) => message([windowStart(), idItem(0x04, 0x26, [0, 0, 0, 1]), idItem(0x04, 0x09, "100")], { info: 0, mode });
/** SAP GUI's answer to a control framework call: not a request. */
const rfcAnswer = (mode = 0) => message([idItem(0x04, 0x26, [0, 0, 0, 2]), rfcItem(0x01, Buffer.alloc(0))], { info: 0, mode });

interface Lab {
  /** Bytes from the fake SAP to SAP GUI. */
  sap: (b: Buffer) => void;
  /** Bytes from the fake SAP GUI to SAP. */
  gui: (b: Buffer) => void;
  host: Transport & { log: Record<string, unknown>[]; onAct?: (a: Record<string, unknown>) => void };
  surface: ReturnType<typeof sapguiDiagSurface>;
}

/** Router, fake SAP and fake SAP GUI, connected; the first screen shown. */
async function lab(title = "Synthetic Order: Overview", env: Record<string, string> = {}, routerLog: (m: string) => void = () => {}): Promise<Lab> {
  let sapSock: Socket | undefined;
  const sapReady = new Promise<void>((r) => {
    const srv = createServer((c) => {
      sapSock = c;
      open.push(c);
      r();
    });
    open.push(srv);
    srv.listen(0, "127.0.0.1");
  });
  const sapServer = open[open.length - 1] as Server;
  await new Promise((r) => (sapServer.listening ? r(undefined) : sapServer.once("listening", r)));
  const sapPort = (sapServer.address() as { port: number }).port;
  const log: Record<string, unknown>[] = [];
  const host: Lab["host"] = {
    log,
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      log.push({ op, ...params });
      if (op === "windows") return { windows: [{ hwnd: 1, kind: "session", title: currentTitle, foreground: true }] } as T;
      if (op === "area") return { windows: [{ hwnd: 1, kind: "session", title: currentTitle, area: [0, 100, 1264, 567], controls: [] }] } as T;
      if (op === "act") host.onAct?.(params.action as Record<string, unknown>);
      return {} as T;
    },
    close() {},
  };
  let currentTitle = title;
  const surface = sapguiDiagSurface({ ...env }, { port: 0, transport: host, log: routerLog });
  const router = await surface.router;
  open.push(router);
  const gui = await new Promise<Socket>((r) => {
    const s = connect({ host: "127.0.0.1", port: (router.address() as { port: number }).port }, () => r(s));
  });
  open.push(gui);
  gui.on("data", () => {});
  gui.write(niFrame(buildRoute({ version: 2, niVersion: 0x28, talkMode: 0, hops: [{ host: "127.0.0.1", service: "0", password: "" }, { host: "127.0.0.1", service: String(sapPort), password: "" }], next: 1 })));
  await sapReady;
  const l: Lab = {
    sap: (b) => {
      // the title SAP GUI's window shows follows the screen
      const at = b.indexOf("Synthetic");
      if (at >= 0) currentTitle = b.toString("latin1", at, b.indexOf(0x10, at) < 0 ? b.length : b.indexOf(0x10, at));
      sapSock?.write(b);
    },
    gui: (b) => gui.write(b),
    host,
    surface,
  };
  l.sap(screenMsg(title));
  for (let i = 0; i < 50 && !(await surface.discover()).length; i++) await sleep(10);
  return l;
}

async function driverOf(l: Lab) {
  const [info] = await l.surface.discover();
  if (!info) throw new Error("no session");
  return l.surface.open(info);
}

describe("Traffic: requests and answers", () => {
  test("a request is counted per mode; an RFC answer is not a request; a screen answers it", () => {
    const t = new Traffic();
    t.client(Buffer.concat([request(0), rfcAnswer(0), request(1)]));
    expect(t.pending(0)).toBe(true);
    expect(t.pending(1)).toBe(true);
    t.screen(0);
    expect(t.pending(0)).toBe(false);
    expect(t.pending(1)).toBe(true);
  });
  test("the cell size SAP GUI reports (ST_USER 0x04: height, width)", () => {
    const t = new Traffic();
    t.client(message([idItem(0x04, 0x04, [0, 30, 0, 9, 0, 20, 0, 9])], { info: 0 }));
    expect(t.font).toEqual({ cw: 9, ch: 30 });
  });
  test("the wait ends with the screen that answers, not before", async () => {
    let now = 0;
    const t = new Traffic(() => now);
    const mark = t.mark();
    t.client(request(0));
    const w = t.wait(0, mark, 0, { requestMs: 100, answerMs: 1000, quietMs: 0, maxSettleMs: 0 });
    now = 40;
    t.server();
    now = 90;
    t.screen(0);
    const r = await w;
    expect(r).toMatchObject({ requested: true, answered: true, requests: 1, sap: 90 });
  });
});

describe("an action waits for SAP's answer in the traffic", () => {
  test("a step in three messages, 150 ms apart: done after the last, with its timing", async () => {
    const l = await lab();
    const d = await driverOf(l);
    l.host.onAct = (a) => {
      if (a.do !== "key") return;
      l.gui(request());
      setTimeout(() => l.sap(screenMsg("Synthetic Order: Overview", 2)), 30);
      setTimeout(() => l.sap(screenMsg("Synthetic Order: Overview", 2)), 180);
      setTimeout(() => l.sap(screenMsg("Synthetic Order: Items")), 330);
    };
    const t0 = Date.now();
    const note = await d.act({ do: "key", key: 0 });
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(320);
    expect(ms).toBeLessThan(1500);
    expect(note).toBe("key 0");
    expect(await d.look({ compact: true })).toContain("Synthetic Order: Items");
    expect(d.timing?.()).toMatch(/^\d+ ms: input \d+, start \d+, sap \d+, settle \d+, other \d+; decoding \d+ \(1 request\)$/);
  });

  test("a call of SAP's control framework mid-step does not end the wait", async () => {
    const l = await lab();
    const d = await driverOf(l);
    l.host.onAct = () => {
      l.gui(request());
      // SAP calls SAP GUI (an RFC that wants an answer), SAP GUI answers, then SAP sends the screen
      setTimeout(() => l.sap(message([rfcItem(0x00, rfcCall("OLE_FLUSH_CALL"))], { info: 1 })), 20);
      setTimeout(() => l.gui(rfcAnswer()), 60);
      setTimeout(() => l.sap(screenMsg("Synthetic Order: Changed")), 200);
    };
    const t0 = Date.now();
    await d.act({ do: "key", key: 0 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(await d.look({ compact: true })).toContain("Synthetic Order: Changed");
  });

  test("SAP GUI sends nothing: the answer says the input may have missed", async () => {
    const l = await lab("Synthetic Order: Overview", { SAP_DIAG_REQUEST_MS: "300" });
    const d = await driverOf(l);
    const note = await d.act({ do: "key", key: 0 });
    expect(note).toContain("SAP GUI sent nothing to SAP within 0.3 s");
  });

  test("SAP does not answer in time: the answer says to look again later, and a look says SAP is still working", async () => {
    const l = await lab();
    const d = await driverOf(l);
    l.host.onAct = () => l.gui(request());
    const note = await d.act({ do: "key", key: 8, timeout: 0.4 });
    expect(note).toContain("SAP has not answered within 0.4 s");
    expect(await d.look({ compact: true })).toContain("NOTE SAP is still working on a step");
    // the answer comes; the next action runs
    l.sap(screenMsg("Synthetic Order: Report"));
    await sleep(50);
    l.host.onAct = (a) => {
      if (a.do !== "key") return;
      l.gui(request());
      setTimeout(() => l.sap(screenMsg("Synthetic Order: Overview")), 20);
    };
    expect(await d.act({ do: "key", key: 3 })).toBe("key 3");
  });

  test("an id that matches nothing is refused before any input", async () => {
    const l = await lab();
    const d = await driverOf(l);
    const t0 = Date.now();
    await expect(d.act({ do: "set", id: "NOPE", value: "x" })).rejects.toThrow('No control "NOPE" on this screen');
    expect(Date.now() - t0).toBeLessThan(200);
    expect(l.host.log.some((x) => x.op === "act")).toBe(false);
  });
});

describe("the capture is opt-in and never stops reading or the logon", () => {
  test("a capture folder that cannot be made: the logon goes on, the screens are read, doctor says why", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagcap-"));
    const blocker = join(dir, "file");
    await writeFile(blocker, "x");
    const logged: string[] = [];
    const l = await lab("Synthetic Order: Overview", { SAP_DIAG_CAPTURE: join(blocker, "sub") }, (m) => logged.push(m));
    expect((await l.surface.discover()).length).toBe(1);
    const checks = await l.surface.doctor?.();
    expect(checks?.find((c) => c.check === "DIAG router messages")?.detail).toContain("the capture (SAP_DIAG_CAPTURE) failed and was stopped");
    expect(logged.some((m) => m.includes("capture"))).toBe(true);
  });
  test("a write that fails stops the capture, not the decoding", () => {
    const dir = mkdtempSync(join(tmpdir(), "diagcap-"));
    const c = new Capture(dir, "x.bin");
    expect(c.on).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    expect(() => c.write(0, Buffer.from("abc"))).not.toThrow();
    expect(c.on).toBe(false);
    expect(c.failed).toContain("failed and was stopped");
  });
  test("a capture that is on is said, with what the file holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagcap-"));
    const logged: string[] = [];
    await lab("Synthetic Order: Overview", { SAP_DIAG_CAPTURE: dir }, (m) => logged.push(m));
    expect(logged).toContain(CAPTURE_WARNING);
    expect(CAPTURE_WARNING).toContain("logon");
  });
  test("a capture file that cannot be made private: a warning, and the capture goes on", () => {
    const dir = mkdtempSync(join(tmpdir(), "diagcap-"));
    const c = new Capture(dir, "x.bin", () => {
      throw new Error("icacls failed");
    });
    expect(c.on).toBe(true);
    expect(c.warning).toContain("icacls failed");
    expect(c.failed).toBeUndefined();
  });
  test("the file is restricted once, when it is made", () => {
    const dir = mkdtempSync(join(tmpdir(), "diagcap-"));
    const seen: string[] = [];
    const c = new Capture(dir, "x.bin", (f) => seen.push(f));
    c.write(0, Buffer.from("a"));
    expect(seen).toEqual([join(dir, "x.bin")]);
    expect(c.warning).toBeUndefined();
  });
  test.skipIf(process.platform === "win32")("the capture file is readable by its owner only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagcap-"));
    const c = new Capture(dir, "x.bin");
    c.write(1, Buffer.from("logon"));
    expect(statSync(join(dir, "x.bin")).mode & 0o777).toBe(0o600);
  });
});

describe("the router's messages reach the server's log", () => {
  test("without a log given: stderr, and doctor lists them", async () => {
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      written.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const surface = sapguiDiagSurface({}, { port: 0, transport: { request: async () => ({}) as never, close() {} } });
      const router = await surface.router;
      open.push(router);
      const s = connect({ host: "127.0.0.1", port: (router.address() as { port: number }).port });
      open.push(s);
      await new Promise((r) => s.once("connect", r));
      s.write(niFrame(Buffer.from("NI_PING\0", "latin1")));
      await new Promise((r) => s.once("close", r));
      expect(written.join("")).toContain("route refused");
      const checks = await surface.doctor?.();
      expect(checks?.find((c) => c.check === "DIAG router messages")?.detail).toContain("route refused");
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe("SAP_DIAG_PORT", () => {
  test("a port number, or the default when unset", () => {
    expect(diagPort(undefined)).toBe(3298);
    expect(diagPort("")).toBe(3298);
    expect(diagPort(" 3299 ")).toBe(3299);
    for (const bad of ["abc", "32a", "0", "70000", "-1", "3.5"]) expect(() => diagPort(bad)).toThrow("SAP_DIAG_PORT");
  });
  test("doctor says a bad port as it is, not as a port taken", async () => {
    const surface = sapguiDiagSurface({ SAP_DIAG_PORT: "abc" }, { transport: { request: async () => ({}) as never, close() {} }, log: () => {} });
    const check = (await surface.doctor?.())?.find((c) => c.check === "DIAG router");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('SAP_DIAG_PORT is "abc"');
    expect(check?.fix).not.toContain("taken");
  });
  test("a port in use is said as taken", async () => {
    const busy = await new Promise<Server>((r) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => r(s));
    });
    open.push(busy);
    const port = (busy.address() as { port: number }).port;
    const surface = sapguiDiagSurface({ SAP_DIAG_PORT: String(port) }, { transport: { request: async () => ({}) as never, close() {} }, log: () => {} });
    const check = (await surface.doctor?.())?.find((c) => c.check === "DIAG router");
    expect(check?.fix).toContain(`Port ${port} is taken`);
  });
});

describe("closing the surface", () => {
  test("the router stops listening, and the input host is closed", async () => {
    let closed = 0;
    const surface = sapguiDiagSurface({}, { port: 0, transport: { request: async () => ({}) as never, close: () => void closed++ }, log: () => {} });
    const router = await surface.router;
    expect(router.listening).toBe(true);
    await surface.close?.();
    expect(router.listening).toBe(false);
    expect(closed).toBe(1);
  });
});
