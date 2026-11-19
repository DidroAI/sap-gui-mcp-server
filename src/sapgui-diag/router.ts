/**
 * A minimal SAProuter on localhost that keeps a copy of what passes through.
 *
 * SAP GUI connects through a router when its connection entry has a router
 * string. With `/H/127.0.0.1/S/3298` in front of the route, SAP GUI sends this
 * router an NI_ROUTE request naming the next hop; the router connects there
 * and answers NI_PONG, then relays bytes both ways. When the route goes on
 * through another router (a company SAProuter), the request is passed on with
 * its offset moved one hop and that router's answer is returned instead.
 *
 * NI framing: each message is a 4-byte big-endian length and the payload.
 *
 * The route request, as SAP GUI 8.00 sent it for the router string
 * /H/127.0.0.1/S/3298/H/<host>/S/3200, with a host name of 10 letters (the
 * bytes are in test/sapgui-diag/router.test.ts):
 *
 *   "NI_ROUTE\0"
 *   02 28 02 00 00 00 01      7 single bytes
 *   00 00 00 21               the length of the hop list (33 bytes)
 *   00 00 00 10               where the next hop starts in it (16)
 *   "127.0.0.1\0" "3298\0" "\0" "<host>\0" "3200\0" "\0"
 *
 * The hop list holds host, service and password of each hop of the router
 * string, NUL-ended. Byte 2 of the 7 is the number of hops (2) and byte 6
 * how many are left after the one being contacted (1); the next-hop
 * position, 16, is the size of the first hop's three strings. Bytes 0, 1
 * and 3 are passed on as they came; 4 and 5, 0 in the request, are sent
 * as 0.
 *
 * Nothing here decodes DIAG; `onConnection` gets the raw chunks.
 */
import { connect, createServer, type Server, type Socket } from "node:net";

export interface Hop {
  host: string;
  service: string;
  password: string;
}

export interface RouteRequest {
  version: number;
  niVersion: number;
  talkMode: number;
  hops: Hop[];
  /** Index of the hop to contact next. */
  next: number;
}

const ROUTE = Buffer.from("NI_ROUTE\0", "latin1");
const PONG = Buffer.from("NI_PONG\0", "latin1");
const HEAD = ROUTE.length + 15;

export function niFrame(payload: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  return Buffer.concat([len, payload]);
}

/** Parses an NI_ROUTE payload (without the NI length). */
export function parseRoute(p: Buffer): RouteRequest {
  if (p.length < HEAD || !p.subarray(0, ROUTE.length).equals(ROUTE)) throw new Error("not an NI_ROUTE request");
  let o = ROUTE.length;
  const version = p[o++] ?? 0;
  const niVersion = p[o++] ?? 0;
  o++; // number of hops, recomputed below
  const talkMode = p[o++] ?? 0;
  o += 2; // bytes 4 and 5
  o++; // hops left
  const length = p.readUInt32BE(o);
  const offset = p.readUInt32BE(o + 4);
  const raw = p.subarray(HEAD, HEAD + length);
  const parts = raw.toString("latin1").split("\0");
  const hops: Hop[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) hops.push({ host: parts[i] ?? "", service: parts[i + 1] ?? "", password: parts[i + 2] ?? "" });
  // the offset is a byte position in the hop list: count the hops before it
  let next = 0;
  for (let pos = 0; next < hops.length && pos < offset; next++) {
    const h = hops[next] as Hop;
    pos += Buffer.byteLength(h.host, "latin1") + Buffer.byteLength(h.service, "latin1") + Buffer.byteLength(h.password, "latin1") + 3;
  }
  return { version, niVersion, talkMode, hops, next };
}

/** Builds an NI_ROUTE payload; `next` is the hop the receiver should contact. */
export function buildRoute(r: RouteRequest): Buffer {
  const hops = Buffer.concat(r.hops.map((h) => Buffer.from(`${h.host}\0${h.service}\0${h.password}\0`, "latin1")));
  let offset = 0;
  for (let i = 0; i < r.next; i++) {
    const h = r.hops[i] as Hop;
    offset += Buffer.byteLength(`${h.host}\0${h.service}\0${h.password}\0`, "latin1");
  }
  const head = Buffer.alloc(15);
  head[0] = r.version;
  head[1] = r.niVersion;
  head[2] = r.hops.length;
  head[3] = r.talkMode;
  head[6] = Math.max(0, r.hops.length - r.next);
  head.writeUInt32BE(hops.length, 7);
  head.writeUInt32BE(offset, 11);
  return Buffer.concat([ROUTE, head, hops]);
}

/** A port: a number, or an SAP service name such as sapdp00 (32NN) or sapms<SID> (not resolved here). */
export function servicePort(service: string): number {
  if (/^\d+$/.test(service)) return Number(service);
  const dp = /^sapdp(\d\d)$/i.exec(service);
  if (dp) return 3200 + Number(dp[1]);
  const gw = /^sapgw(\d\d)$/i.exec(service);
  if (gw) return 3300 + Number(gw[1]);
  throw new Error(`Unknown SAP service "${service}": use a port number in the route`);
}

export interface Tap {
  /** 0 = SAP GUI to server, 1 = server to SAP GUI. */
  data(dir: 0 | 1, chunk: Buffer): void;
  close(): void;
}

export interface RouterOptions {
  port?: number;
  host?: string;
  /** Called for each routed connection, with where it goes; returns what receives the bytes. */
  onConnection?: (target: Hop, route: RouteRequest) => Tap | undefined;
  /** For tests: how to open the onward connection. */
  dial?: (host: string, port: number) => Socket;
  log?: (msg: string) => void;
}

/** Reads one NI message from the start of a socket's data, then hands back what came after it. */
function readFirst(sock: Socket, timeoutMs: number): Promise<{ payload: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error("no route request")), timeoutMs);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > 1 << 20) return done(new Error("route request too long"));
      if (buf.length < 4 + len) return;
      done(undefined, { payload: buf.subarray(4, 4 + len), rest: buf.subarray(4 + len) });
    };
    const onEnd = () => done(new Error("closed before the route request"));
    function done(err?: Error, v?: { payload: Buffer; rest: Buffer }) {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("end", onEnd);
      sock.off("error", onEnd);
      sock.pause();
      if (err) reject(err);
      else resolve(v as { payload: Buffer; rest: Buffer });
    }
    sock.on("data", onData);
    sock.on("end", onEnd);
    sock.on("error", onEnd);
  });
}

function relay(client: Socket, server: Socket, tap: Tap | undefined, first: Buffer[]): void {
  for (const c of first) if (c.length) tap?.data(0, c);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    client.destroy();
    server.destroy();
    tap?.close();
  };
  client.on("data", (c: Buffer) => {
    tap?.data(0, c);
    server.write(c);
  });
  server.on("data", (c: Buffer) => {
    tap?.data(1, c);
    client.write(c);
  });
  for (const s of [client, server]) {
    s.on("end", close);
    s.on("error", close);
    s.on("close", close);
  }
  client.resume();
  server.resume();
}

export function startRouter(opts: RouterOptions = {}): Promise<Server> {
  const log = opts.log ?? (() => {});
  const dial = opts.dial ?? ((host: string, port: number) => connect({ host, port }));
  const server = createServer({ pauseOnConnect: false }, async (client) => {
    try {
      const { payload, rest } = await readFirst(client, 10_000);
      const route = parseRoute(payload);
      const target = route.hops[route.next];
      if (!target) throw new Error("the route has no hop after this router");
      const onward = dial(target.host, servicePort(target.service));
      await new Promise<void>((res, rej) => {
        onward.once("connect", () => res());
        onward.once("error", rej);
      });
      const more = route.next + 1 < route.hops.length;
      const tap = opts.onConnection?.(more ? (route.hops[route.hops.length - 1] as Hop) : target, route);
      if (more) {
        // another router follows: pass the request on, one hop further
        onward.write(niFrame(buildRoute({ ...route, next: route.next + 1 })));
        if (rest.length) onward.write(rest);
        relay(client, onward, tap, []);
      } else {
        client.write(niFrame(PONG));
        if (rest.length) onward.write(rest);
        relay(client, onward, tap, [rest]);
      }
      log(`routed to ${target.host}:${target.service}`);
    } catch (e) {
      log(`route refused: ${(e as Error).message}`);
      client.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 3298, opts.host ?? "127.0.0.1", () => resolve(server));
  });
}
