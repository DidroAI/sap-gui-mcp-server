import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { Transport } from "../../src/sapgui/facts.js";
import { buildRoute, niFrame } from "../../src/sapgui-diag/router.js";
import { sapguiDiagSurface } from "../../src/sapgui-diag/index.js";
import { elem, elementList, END, idItem, keys, message, RESET, screenHead, sessionInfo, windowStart } from "../diag/build.js";

/**
 * A value typed with `set` reaches SAP, and so the reader, with the next
 * Enter: until then the view shows it as typed; after the step, a field that
 * does not show what was typed is reported. Through the real router and
 * decoder, with a fake application server and a fake input host.
 */

const open: (Server | Socket)[] = [];
afterEach(() => {
  for (const s of open.splice(0)) "destroy" in s ? s.destroy() : s.close();
});

const screen = (auart: string, kunnr: string, status?: string) =>
  message([
    ...screenHead({ tcode: "VA01", program: "SAPMV45A", dynpro: "0101", title: "Create Sales Order: Initial Screen" }),
    keys(4, [[3, "Back"]]),
    RESET,
    elementList(elem.label(2, 1, "Order Type"), elem.field(2, 20, auart, { width: 4 }), elem.name(2, 20, "VBAK-AUART"), elem.label(3, 1, "Sold-to"), elem.field(3, 20, kunnr, { width: 10 }), elem.name(3, 20, "KUAGV-KUNNR")),
    ...(status ? [sessionInfo(0x0b, status)] : []),
    END,
  ]);

/** A fake application server: the first screen at the first message of SAP GUI, then the screens given, one per message. */
function fakeSap(screens: Buffer[]): Promise<number> {
  const s = createServer((c) => {
    let i = 0;
    c.on("data", () => {
      const next = screens[Math.min(i++, screens.length - 1)];
      if (next) c.write(next);
    });
  });
  open.push(s);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
}

describe("a typed value before and after the step that sends it", () => {
  test("shown as typed, then compared with what SAP shows", async () => {
    const sap = await fakeSap([screen("", ""), screen("OR", "", "E: Fill in all required entry fields")]);
    let sock: Socket | undefined;
    const sent: Record<string, unknown>[] = [];
    const title = "Create Sales Order: Initial Screen";
    const host: Transport = {
      async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
        if (op === "windows") return { windows: [{ hwnd: 1, kind: "session", title, foreground: true }] } as T;
        if (op === "area") return { windows: [{ hwnd: 1, kind: "session", title, area: [0, 0, 800, 630] }] } as T;
        const a = params.action as Record<string, unknown>;
        sent.push(a);
        // Enter: SAP GUI sends the step (a request the waits see), the server answers with the next screen.
        if (a.do === "key") sock?.write(message([windowStart(), idItem(0x04, 0x09, "100")], { info: 0 }));
        return {} as T;
      },
      close() {},
    };
    const surface = sapguiDiagSurface({}, { port: 0, transport: host });
    const router = await surface.router;
    open.push(router);
    sock = connect({ host: "127.0.0.1", port: (router.address() as { port: number }).port });
    open.push(sock);
    await new Promise((r) => sock?.once("connect", r));
    sock.write(niFrame(buildRoute({ version: 2, niVersion: 0x28, talkMode: 0, hops: [{ host: "127.0.0.1", service: "0", password: "" }, { host: "127.0.0.1", service: String(sap), password: "" }], next: 1 })));
    await new Promise((r) => sock?.once("data", r)); // NI_PONG
    sock.write(niFrame(Buffer.alloc(8)));
    let sessions = await surface.discover();
    for (let i = 0; i < 50 && !sessions.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      sessions = await surface.discover();
    }
    const d = await surface.open(sessions[0] as never);

    const note = await d.act({ do: "set", id: "vbak-auart", value: "or" });
    expect(note).toStartWith('set VBAK-AUART = "or" (typed, sent with the next Enter)');
    await d.act({ do: "set", id: "KUAGV-KUNNR", value: "1000" });
    const before = await d.look({ compact: true });
    expect(before).toContain("r2  Order Type  VBAK-AUART@20=[or] (typed, sent with the next Enter)");
    expect(before).toContain("KUAGV-KUNNR@20=[1000] (typed, sent with the next Enter)");
    expect(sent.map((a) => a.do)).toEqual(["set", "set"]);

    const after = await d.act({ do: "key", key: 0 });
    // "or" is "OR" as SAP shows it; the customer number SAP did not keep is reported.
    expect(after.split("\n")).toEqual(["key 0", 'KUAGV-KUNNR shows "" after this step, not the typed "1000": SAP changed it or did not take it.']);
    const view = await d.look({ compact: true });
    expect(view).not.toContain("typed");
    expect(view.split("\n")[1]).toBe("sbar  status  E: Fill in all required entry fields");
  });
});
