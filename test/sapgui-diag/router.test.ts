import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, Socket } from "node:net";
import { buildRoute, niFrame, parseRoute, servicePort, startRouter } from "../../src/sapgui-diag/router.js";

// The request SAP GUI 8.00 sent for /H/127.0.0.1/S/3298/H/vhcalabaci/S/3200 (synthetic host names).
const REQUEST = Buffer.concat([
  Buffer.from("NI_ROUTE\0", "latin1"),
  Buffer.from([0x02, 0x28, 0x02, 0x00, 0x00, 0x00, 0x01, 0, 0, 0, 0x21, 0, 0, 0, 0x10]),
  Buffer.from("127.0.0.1\x003298\0\0vhcalabaci\x003200\0\0", "latin1"),
]);

describe("route requests", () => {
  test("parses the hops and the next one", () => {
    const r = parseRoute(REQUEST);
    expect(r.hops).toEqual([
      { host: "127.0.0.1", service: "3298", password: "" },
      { host: "vhcalabaci", service: "3200", password: "" },
    ]);
    expect(r.next).toBe(1);
    expect(r.niVersion).toBe(0x28);
  });
  test("builds the same bytes back", () => {
    expect(buildRoute(parseRoute(REQUEST)).equals(REQUEST)).toBe(true);
  });
  test("refuses anything else", () => {
    expect(() => parseRoute(Buffer.from("NI_PING\0", "latin1"))).toThrow();
  });
  test("service names", () => {
    expect(servicePort("3200")).toBe(3200);
    expect(servicePort("sapdp05")).toBe(3205);
    expect(() => servicePort("sapmsABC")).toThrow();
  });
});

const open: (Server | Socket)[] = [];
afterEach(() => {
  for (const s of open.splice(0)) "destroy" in s ? s.destroy() : s.close();
});

function listen(s: Server): Promise<number> {
  open.push(s);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
}

/** A fake application server: answers each chunk with "re:" + chunk. */
function fakeSap(): Promise<number> {
  return listen(createServer((c) => c.on("data", (d: Buffer) => c.write(Buffer.concat([Buffer.from("re:"), d])))));
}

function request(hops: [string, number][]): Buffer {
  return niFrame(buildRoute({ version: 2, niVersion: 0x28, talkMode: 0, hops: hops.map(([host, p]) => ({ host, service: String(p), password: "" })), next: 1 }));
}

function client(port: number): Promise<{ sock: Socket; read: (n: number) => Promise<Buffer> }> {
  return new Promise((res) => {
    const sock = connect({ host: "127.0.0.1", port }, () => {
      open.push(sock);
      let buf = Buffer.alloc(0);
      const waiters: (() => void)[] = [];
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (const w of waiters.splice(0)) w();
      });
      const read = async (n: number): Promise<Buffer> => {
        while (buf.length < n) await new Promise<void>((r) => waiters.push(r));
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return out;
      };
      res({ sock, read });
    });
  });
}

describe("the router", () => {
  test("answers NI_PONG, relays both ways and taps every byte", async () => {
    const sap = await fakeSap();
    const seen: [number, string][] = [];
    const router = await startRouter({ port: 0, onConnection: () => ({ data: (d, c) => seen.push([d, c.toString()]), close() {} }) });
    open.push(router);
    const { sock, read } = await client((router.address() as { port: number }).port);
    sock.write(request([["127.0.0.1", 0], ["127.0.0.1", sap]]));
    expect((await read(12)).subarray(4).toString("latin1")).toBe("NI_PONG\0");
    sock.write("hello");
    expect((await read(8)).toString()).toBe("re:hello");
    expect(seen).toEqual([[0, "hello"], [1, "re:hello"]]);
  });

  test("passes the request on to a second router", async () => {
    const sap = await fakeSap();
    const second = await startRouter({ port: 0 });
    open.push(second);
    const first = await startRouter({ port: 0 });
    open.push(first);
    const { sock, read } = await client((first.address() as { port: number }).port);
    sock.write(request([["127.0.0.1", 0], ["127.0.0.1", (second.address() as { port: number }).port], ["127.0.0.1", sap]]));
    expect((await read(12)).subarray(4).toString("latin1")).toBe("NI_PONG\0");
    sock.write("x");
    expect((await read(4)).toString()).toBe("re:x");
  });

  test("two connections at once: each tap gets its own bytes, in order", async () => {
    const sap = await fakeSap();
    const taps: [number, string][][] = [];
    const router = await startRouter({
      port: 0,
      onConnection: () => {
        const seen: [number, string][] = [];
        taps.push(seen);
        return { data: (d, c) => seen.push([d, c.toString()]), close() {} };
      },
    });
    open.push(router);
    const port = (router.address() as { port: number }).port;
    const a = await client(port);
    const b = await client(port);
    for (const c of [a, b]) {
      c.sock.write(request([["127.0.0.1", 0], ["127.0.0.1", sap]]));
      await c.read(12);
    }
    for (let i = 0; i < 5; i++) {
      a.sock.write(`a${i}`);
      b.sock.write(`b${i}`);
      expect((await a.read(5)).toString()).toBe(`re:a${i}`);
      expect((await b.read(5)).toString()).toBe(`re:b${i}`);
    }
    const flat = (seen: [number, string][]) => seen.map(([d, c]) => `${d}:${c}`).join("|");
    expect(taps.length).toBe(2);
    expect(flat(taps[0] ?? [])).toBe([0, 1, 2, 3, 4].map((i) => `0:a${i}|1:re:a${i}`).join("|"));
    expect(flat(taps[1] ?? [])).toBe([0, 1, 2, 3, 4].map((i) => `0:b${i}|1:re:b${i}`).join("|"));
  });

  test("a tap that fails never breaks SAP GUI's connection", async () => {
    const sap = await fakeSap();
    const logged: string[] = [];
    const router = await startRouter({
      port: 0,
      log: (m) => logged.push(m),
      onConnection: () => ({
        data: () => {
          throw new Error("decoder bug");
        },
        close() {},
      }),
    });
    open.push(router);
    const { sock, read } = await client((router.address() as { port: number }).port);
    sock.write(request([["127.0.0.1", 0], ["127.0.0.1", sap]]));
    await read(12);
    sock.write("one");
    expect((await read(6)).toString()).toBe("re:one");
    sock.write("two");
    expect((await read(6)).toString()).toBe("re:two");
    expect(logged.filter((m) => m.includes("decoder bug")).length).toBe(1);
  });

  test("a tap that cannot start (a capture folder that cannot be made) never refuses the logon", async () => {
    const sap = await fakeSap();
    const logged: string[] = [];
    const router = await startRouter({
      port: 0,
      log: (m) => logged.push(m),
      onConnection: () => {
        throw new Error("EACCES: capture folder");
      },
    });
    open.push(router);
    const { sock, read } = await client((router.address() as { port: number }).port);
    sock.write(request([["127.0.0.1", 0], ["127.0.0.1", sap]]));
    expect((await read(12)).subarray(4).toString("latin1")).toBe("NI_PONG\0");
    sock.write("one");
    expect((await read(6)).toString()).toBe("re:one");
    expect(logged.some((m) => m.includes("could not start") && m.includes("EACCES"))).toBe(true);
  });

  test("a client that resets while the onward connection is dialled ends only that connection (review, 2026-11-24)", async () => {
    let onward: Socket | undefined;
    let dialled!: () => void;
    const dialling = new Promise<void>((r) => (dialled = r));
    // An onward connection that never comes up.
    const router = await startRouter({ port: 0, dial: () => ((onward = new Socket()), dialled(), onward) });
    open.push(router);
    let inside: Socket | undefined;
    router.on("connection", (c: Socket) => (inside = c));
    const { sock } = await client((router.address() as { port: number }).port);
    sock.write(request([["127.0.0.1", 3200], ["127.0.0.1", 3200]]));
    await dialling;
    // While it waits, an error on SAP GUI's side has a listener (Node ends the process on one without).
    expect(inside?.listenerCount("error")).toBeGreaterThan(0);
    sock.destroy();
    await new Promise((r) => inside?.once("close", r));
    expect(onward?.destroyed).toBe(true);
    // The router still takes connections.
    const c = await client((router.address() as { port: number }).port);
    expect(c.sock.destroyed).toBe(false);
  });
  test("an onward connection that never comes up times out and ends SAP GUI's connection", async () => {
    let onward: Socket | undefined;
    const logged: string[] = [];
    // A dial that never connects.
    const router = await startRouter({ port: 0, dialTimeoutMs: 50, log: (m) => logged.push(m), dial: () => (onward = new Socket()) });
    open.push(router);
    const { sock } = await client((router.address() as { port: number }).port);
    const closed = new Promise((r) => sock.on("close", r));
    sock.write(request([["127.0.0.1", 3200], ["127.0.0.1", 3200]]));
    await closed;
    expect(onward?.destroyed).toBe(true);
    expect(logged.some((m) => m.includes("did not answer"))).toBe(true);
  });

  test("drops a client that does not route", async () => {
    const router = await startRouter({ port: 0 });
    open.push(router);
    const { sock } = await client((router.address() as { port: number }).port);
    const closed = new Promise((r) => sock.on("close", r));
    sock.write(niFrame(Buffer.from("NI_PING\0", "latin1")));
    await closed;
  });
});
